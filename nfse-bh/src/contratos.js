// Contratos e propostas: lê o documento (PDF, DOCX, TXT ou texto colado), extrai cliente, valores e condições
// de pagamento e planeja as parcelas que o cliente deve pagar — com agendamento da emissão de cada nota.
// Leitura com IA (Claude) quando há ANTHROPIC_API_KEY; sem ela, por regras, com o resultado sempre revisável.
import crypto from 'node:crypto';
import AdmZip from 'adm-zip';
import Anthropic from '@anthropic-ai/sdk';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { avancar, FREQUENCIAS } from './agenda.js';
import { situacaoDaNota, hojeBR } from './financeiro.js';
import { cnpjValido, cpfValido } from './dps.js';

export const MODELO_IA = 'claude-opus-5-5';
const soDigitos = (s) => String(s ?? '').replace(/\D/g, '');

/** IA disponível quando o .env traz a chave da API da Anthropic. */
export const iaDisponivel = () => !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

// ---------- Texto dos documentos ----------

async function textoDoPdf(buffer) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, isEvalSupported: false }).promise;
  const paginas = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const { items } = await (await doc.getPage(i)).getTextContent();
    // Junta por linha (mesma altura) para manter tabelas e cláusulas legíveis
    const linhas = [];
    for (const it of items.filter((x) => x.str.trim())) {
      const y = Math.round(it.transform[5]);
      const l = linhas.find((x) => Math.abs(x.y - y) < 3);
      if (l) l.t.push([it.transform[4], it.str]);
      else linhas.push({ y, t: [[it.transform[4], it.str]] });
    }
    paginas.push(linhas.sort((a, b) => b.y - a.y).map((l) => l.t.sort((a, b) => a[0] - b[0]).map((x) => x[1]).join(' ')).join('\n'));
  }
  await doc.destroy();
  return paginas.join('\n\n');
}

function textoDoDocx(buffer) {
  const xml = new AdmZip(buffer).getEntry('word/document.xml')?.getData().toString('utf8') ?? '';
  return xml
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Texto de cada arquivo { nome, base64 }; PDF também é enviado inteiro à IA (lê tabelas e layout). */
export async function extrairTextos(arquivos = []) {
  const saida = [];
  for (const a of arquivos) {
    const buf = Buffer.from(a.base64 ?? '', 'base64');
    if (buf.length > 25 * 1024 * 1024) throw Object.assign(new Error(`${a.nome}: arquivo acima de 25 MB`), { statusHttp: 400 });
    if (/\.pdf$/i.test(a.nome)) saida.push({ nome: a.nome, tipo: 'pdf', buffer: buf, texto: await textoDoPdf(buf) });
    else if (/\.docx$/i.test(a.nome)) saida.push({ nome: a.nome, tipo: 'docx', texto: textoDoDocx(buf) });
    else if (/\.(txt|md|csv|eml)$/i.test(a.nome)) saida.push({ nome: a.nome, tipo: 'texto', texto: buf.toString('utf8') });
    else throw Object.assign(new Error(`${a.nome}: formato não suportado (use PDF, DOCX ou TXT)`), { statusHttp: 400 });
  }
  return saida;
}

// ---------- Leitura com IA ----------

const STR_NULL = { type: ['string', 'null'] };
const NUM_NULL = { type: ['number', 'null'] };
export const ESQUEMA_CONTRATO = {
  type: 'object',
  additionalProperties: false,
  required: ['tipo', 'titulo', 'cliente', 'objeto', 'dataAssinatura', 'dataInicio', 'dataFim', 'valorTotal', 'formaPagamento', 'parcelas', 'recorrencia', 'reajuste', 'multaAtraso', 'observacoes', 'confianca', 'pendencias'],
  properties: {
    tipo: { type: 'string', enum: ['contrato', 'proposta', 'aditivo', 'outro'] },
    titulo: { type: 'string', description: 'Nome curto do contrato/projeto' },
    cliente: {
      type: 'object',
      additionalProperties: false,
      required: ['documento', 'nome'],
      properties: { documento: { ...STR_NULL, description: 'CNPJ ou CPF do CONTRATANTE (quem paga), só dígitos' }, nome: STR_NULL },
    },
    objeto: { type: 'string', description: 'Serviço contratado, em uma ou duas frases — vira a descrição da nota fiscal' },
    dataAssinatura: { ...STR_NULL, description: 'AAAA-MM-DD' },
    dataInicio: { ...STR_NULL, description: 'AAAA-MM-DD' },
    dataFim: { ...STR_NULL, description: 'AAAA-MM-DD' },
    valorTotal: { ...NUM_NULL, description: 'Valor total em reais (número, sem símbolo)' },
    formaPagamento: { type: 'string', description: 'Resumo das condições de pagamento como escritas no documento' },
    parcelas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['numero', 'descricao', 'valor', 'emissao', 'vencimento', 'regra'],
        properties: {
          numero: { type: 'integer' },
          descricao: { type: 'string', description: 'Ex.: "Parcela 2/6 – módulo 2" ou "Entrada (30%)"' },
          valor: NUM_NULL,
          emissao: { ...STR_NULL, description: 'Data prevista para emitir a nota fiscal, AAAA-MM-DD' },
          vencimento: { ...STR_NULL, description: 'Data em que o cliente deve pagar, AAAA-MM-DD' },
          regra: { ...STR_NULL, description: 'Condição quando não há data fixa, ex.: "30 dias após a entrega do relatório"' },
        },
      },
    },
    recorrencia: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['frequencia', 'valor', 'diaVencimento', 'quantidade'],
      properties: {
        frequencia: { type: 'string', enum: Object.keys(FREQUENCIAS) },
        valor: NUM_NULL,
        diaVencimento: { type: ['integer', 'null'] },
        quantidade: { type: ['integer', 'null'], description: 'Número de pagamentos; null se indeterminado' },
      },
    },
    reajuste: STR_NULL,
    multaAtraso: STR_NULL,
    observacoes: STR_NULL,
    confianca: { type: 'string', enum: ['alta', 'media', 'baixa'] },
    pendencias: { type: 'array', items: { type: 'string' }, description: 'O que ficou ambíguo ou precisa de confirmação humana' },
  },
};

function instrucoes({ hoje, empresa }) {
  return `Você lê contratos e propostas comerciais de prestação de serviços da empresa ${empresa.nome} (CNPJ ${empresa.cnpj}), que é a CONTRATADA. Extraia os dados para planejar as notas fiscais e os recebimentos.

Regras:
- O cliente é o CONTRATANTE (quem paga), nunca a ${empresa.nome}.
- Valores em reais como número (12500.5). Datas no formato AAAA-MM-DD. Hoje é ${hoje}.
- Liste TODAS as parcelas explicitamente. Se o documento diz "6 parcelas mensais de R$ 2.000 a partir de março/2026", gere as 6, com datas.
- "emissao" é quando a nota deve ser emitida; "vencimento" é quando o cliente paga. Se o documento só disser um prazo (ex.: "pagamento 30 dias após a emissão"), calcule a data quando houver base; senão deixe null e explique em "regra".
- Pagamentos recorrentes sem fim definido (mensalidade, fee, retainer): preencha "recorrencia" e gere as parcelas dos próximos 12 meses.
- Proposta sem aceite: tipo "proposta". Não invente dados: o que não estiver no documento fica null e entra em "pendencias".
- "objeto" deve servir de descrição da nota fiscal: claro, sem cláusulas.`;
}

/**
 * Lê os documentos com o Claude e devolve o rascunho do contrato no ESQUEMA_CONTRATO.
 * `cliente` (SDK) pode ser injetado nos testes.
 */
export async function analisarComIA({ documentos, textoLivre, empresa, hoje = hojeBR(), cliente = new Anthropic() }) {
  const conteudo = [];
  for (const d of documentos) {
    if (d.tipo === 'pdf') {
      conteudo.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: d.buffer.toString('base64') }, title: d.nome });
    } else {
      conteudo.push({ type: 'text', text: `--- Documento: ${d.nome} ---\n${d.texto}` });
    }
  }
  if (textoLivre?.trim()) conteudo.push({ type: 'text', text: `--- Informações enviadas pelo usuário ---\n${textoLivre.trim()}` });
  conteudo.push({ type: 'text', text: 'Extraia os dados do contrato/proposta acima.' });

  const resposta = await cliente.beta.messages.create({
    model: MODELO_IA,
    max_tokens: 16000,
    // Se o modelo recusar por segurança, a API refaz a leitura no modelo de reserva recomendado
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: instrucoes({ hoje, empresa }),
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: ESQUEMA_CONTRATO } },
    messages: [{ role: 'user', content: conteudo }],
  });
  if (resposta.stop_reason === 'refusal') throw new Error('A IA não processou este documento. Preencha os dados manualmente.');
  if (resposta.stop_reason === 'max_tokens') throw new Error('Documento longo demais para a leitura automática; envie só as cláusulas de valor e pagamento.');
  const texto = resposta.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    return JSON.parse(texto);
  } catch {
    throw new Error('A resposta da IA não veio no formato esperado. Tente de novo ou preencha manualmente.');
  }
}

// ---------- Leitura por regras (sem IA) ----------

const numeroBR = (s) => Number(String(s).replace(/\./g, '').replace(',', '.'));
const dataIso = (d, m, a) => `${a.length === 2 ? `20${a}` : a}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
const MESES = ['janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

/** Extração simples: CNPJ do contratante, valores, nº de parcelas, periodicidade e datas. Sempre "baixa" confiança. */
export function analisarPorRegras({ texto, empresa, hoje = hojeBR() }) {
  const t = String(texto ?? '');
  const sem = t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const pendencias = [];

  const docs = [...t.matchAll(/\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}/g)].map((m) => soDigitos(m[0])).filter((d) => cnpjValido(d) && d !== empresa.cnpj);
  const cpfs = [...t.matchAll(/\d{3}\.\d{3}\.\d{3}-\d{2}/g)].map((m) => soDigitos(m[0])).filter(cpfValido);
  const documento = docs[0] ?? cpfs[0] ?? null;
  if (!documento) pendencias.push('CNPJ/CPF do contratante não encontrado.');
  // Nome: linha com "CONTRATANTE" antes do documento
  const nome = (t.match(/contratante[:\s,]*([A-ZÀ-Ú0-9][^\n,]{3,80}?)(?:,|\s+inscrit|\s+CNPJ|\n)/i)?.[1] ?? '').trim() || null;

  const valores = [...t.matchAll(/R\$\s*([\d.]+,\d{2})/g)].map((m) => numeroBR(m[1]));
  const qtd = Number(sem.match(/(\d{1,2})\s*(?:\(\w+\)\s*)?(?:parcelas|prestacoes|pagamentos|mensalidades)/)?.[1] ?? sem.match(/em\s+(\d{1,2})\s*x/)?.[1] ?? 0);
  const frequencia = /mensa(l|is|lidade)/.test(sem) ? 'mensal' : /trimestra/.test(sem) ? 'trimestral' : /semestra/.test(sem) ? 'semestral' : /anua/.test(sem) ? 'anual' : qtd > 1 ? 'mensal' : null;
  const datas = [...t.matchAll(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/g)].map((m) => dataIso(m[1], m[2], m[3])).filter((d) => !Number.isNaN(Date.parse(d)));
  const mesAno = sem.match(new RegExp(`a partir de (${MESES.join('|')})(?:\\s+de|\\/)\\s*(\\d{4})`));
  const primeira = mesAno ? `${mesAno[2]}-${String(MESES.indexOf(mesAno[1]) + 1).padStart(2, '0')}-10` : datas.find((d) => d >= hoje) ?? null;

  let valorParcela = null;
  let valorTotal = valores.length ? Math.max(...valores) : null;
  if (qtd > 1 && valores.length) {
    // "6 parcelas de R$ 2.000,00": a parcela é o valor que, multiplicado, não passa do maior valor citado
    const candidata = valores.find((v) => Math.abs(v * qtd - valorTotal) < 0.05) ?? (valores.includes(valorTotal / qtd) ? valorTotal / qtd : null);
    valorParcela = candidata ?? valores.find((v) => v < valorTotal) ?? valorTotal / qtd;
    if (!valores.some((v) => Math.abs(v - valorParcela * qtd) < 0.05) && valores.length === 1) valorTotal = valorParcela * qtd;
  }
  if (!valorTotal) pendencias.push('Valor do contrato não encontrado.');
  if (!primeira) pendencias.push('Data da primeira parcela não encontrada: informe as datas.');

  // "vencimento 30 dias após a emissão" / "pagamento em 15 dias"
  const diasPrazo = Number(sem.match(/(\d{1,3})\s*(?:\(\w+\)\s*)?dias\s+(?:apos|depois|da|a partir|contados)/)?.[1] ?? 0) || null;
  const somarDias = (d, n) => {
    const x = new Date(`${d}T12:00:00Z`);
    x.setUTCDate(x.getUTCDate() + n);
    return x.toISOString().slice(0, 10);
  };
  const parcelas = [];
  const n = qtd || (valorTotal ? 1 : 0);
  let data = primeira;
  for (let i = 1; i <= n; i++) {
    parcelas.push({ numero: i, descricao: n > 1 ? `Parcela ${i}/${n}` : 'Parcela única', valor: n > 1 ? Number((valorParcela ?? valorTotal / n).toFixed(2)) : valorTotal, emissao: data, vencimento: data && diasPrazo ? somarDias(data, diasPrazo) : null, regra: data ? null : 'definir data' });
    data = data && frequencia ? avancar(data, frequencia) : null;
  }
  const linhaObjeto = t.split('\n').find((l) => /objeto/i.test(l) && l.length > 15);
  return {
    tipo: /proposta/i.test(t) ? 'proposta' : 'contrato',
    titulo: (linhaObjeto?.replace(/.*objeto[^:]*:?\s*/i, '') || 'Contrato').slice(0, 80),
    cliente: { documento, nome },
    objeto: (linhaObjeto?.replace(/.*objeto[^:]*:?\s*/i, '') || '').slice(0, 300),
    dataAssinatura: null,
    dataInicio: primeira,
    dataFim: null,
    valorTotal,
    formaPagamento: qtd > 1 ? `${qtd} parcelas ${frequencia ?? ''}`.trim() : '',
    parcelas,
    recorrencia: null,
    reajuste: /ipca|igp-?m|reajust/i.test(t) ? (t.match(/[^.\n]*reajust[^.\n]*/i)?.[0] ?? null) : null,
    multaAtraso: t.match(/[^.\n]*multa[^.\n]*/i)?.[0] ?? null,
    observacoes: null,
    confianca: 'baixa',
    pendencias,
  };
}

// ---------- Planejamento e acompanhamento ----------

/** 2000.5 (número) | "2.000,50" | "2000.50" → 2000.5; vazio → null */
export function valorNumero(v) {
  if (v === '' || v == null) return null;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/R\$\s*/i, '').trim();
  return Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s);
}

/** Normaliza o rascunho editado pelo usuário: parcelas com id, valores numéricos e datas ordenadas. */
export function normalizarContrato(c, config) {
  const prazo = Number(config?.cobranca?.prazoDias ?? 10);
  const somar = (d, dias) => {
    const x = new Date(`${d}T12:00:00Z`);
    x.setUTCDate(x.getUTCDate() + dias);
    return x.toISOString().slice(0, 10);
  };
  const parcelas = (c.parcelas ?? [])
    .map((p, i) => {
      const valor = valorNumero(p.valor);
      // Só uma das datas informada: a outra sai do prazo padrão de pagamento
      const emissao = p.emissao || (p.vencimento ? somar(p.vencimento, -prazo) : null);
      const vencimento = p.vencimento || (p.emissao ? somar(p.emissao, prazo) : null);
      return { ...p, id: p.id || crypto.randomUUID(), numero: Number(p.numero) || i + 1, valor: Number.isFinite(valor) ? Number(valor.toFixed(2)) : null, emissao, vencimento };
    })
    .sort((a, b) => (a.emissao ?? '9999').localeCompare(b.emissao ?? '9999') || a.numero - b.numero);
  const soma = parcelas.reduce((s, p) => s + (p.valor ?? 0), 0);
  return { ...c, cliente: { documento: soDigitos(c.cliente?.documento), nome: c.cliente?.nome ?? '' }, parcelas, valorTotal: valorNumero(c.valorTotal) || soma || null, somaParcelas: Number(soma.toFixed(2)) };
}

/** Situação de cada parcela pelas notas emitidas (via agendamento) e pagamentos. */
export function situacaoDoContrato(contrato, { notas, agendas, hoje = hojeBR() }) {
  const parcelas = contrato.parcelas.map((p) => {
    const nota = notas.find((n) => (p.notaId && n.id === p.notaId) || (p.agendaId && n.agendaId === p.agendaId && n.status === 'autorizada'));
    const agenda = p.agendaId ? agendas.find((a) => a.id === p.agendaId) : null;
    let situacao = 'prevista';
    if (agenda) situacao = 'agendada';
    if (nota) {
      const s = situacaoDaNota(nota, hoje);
      situacao = s === 'pago' ? 'paga' : s === 'cancelada' || s === 'substituida' ? 'cancelada' : s === 'atrasada' ? 'atrasada' : 'faturada';
    } else if (p.vencimento && p.vencimento < hoje) situacao = 'atrasada';
    else if (p.emissao && p.emissao < hoje && situacao !== 'agendada') situacao = 'a_faturar';
    return { ...p, situacao, notaNumero: nota?.numero ?? null, notaId: nota?.id ?? p.notaId ?? null };
  });
  const soma = (f) => parcelas.filter(f).reduce((s, p) => s + (p.valor ?? 0), 0);
  return {
    ...contrato,
    parcelas,
    resumo: {
      total: contrato.valorTotal ?? soma(() => true),
      faturado: soma((p) => ['faturada', 'paga', 'atrasada'].includes(p.situacao) && p.notaId),
      recebido: soma((p) => p.situacao === 'paga'),
      aFaturar: soma((p) => ['prevista', 'agendada', 'a_faturar'].includes(p.situacao)),
      emAtraso: soma((p) => p.situacao === 'atrasada'),
      proxima: parcelas.find((p) => ['prevista', 'agendada', 'a_faturar'].includes(p.situacao)) ?? null,
    },
  };
}

/** Cria um agendamento (modo lembrete) por parcela com data, para a nota ser emitida na data prevista. */
export function agendarParcelas({ store, contrato, hoje = hojeBR() }) {
  const cliente = store.clientes.porDocumento(contrato.cliente.documento);
  if (!cliente) throw Object.assign(new Error('Cadastre o cliente do contrato antes de agendar'), { statusHttp: 400 });
  let criadas = 0;
  const parcelas = contrato.parcelas.map((p) => {
    if (p.agendaId || p.notaId || !p.emissao || !p.valor) return p;
    const total = contrato.parcelas.length;
    const agenda = store.agendas.salvar({
      clienteId: cliente.id,
      descricao: [contrato.objeto || contrato.titulo, total > 1 ? `Parcela ${p.numero}/${total}` : null, p.descricao && !/^parcela/i.test(p.descricao) ? p.descricao : null, 'R$ {{valor}}'].filter(Boolean).join(' – '),
      valor: Number(p.valor).toFixed(2).replace('.', ','),
      frequencia: 'unica',
      // Parcela atrasada no planejamento entra para emitir já
      proximaData: p.emissao < hoje ? hoje : p.emissao,
      diaMes: Number(p.emissao.slice(8, 10)),
      competencia: 'emissao',
      modo: 'lembrete',
      ativo: true,
      contratoId: contrato.id,
      parcelaId: p.id,
      vencimentoPrevisto: p.vencimento,
    });
    criadas++;
    return { ...p, agendaId: agenda.id };
  });
  store.contratos.salvar({ id: contrato.id, parcelas });
  return { criadas };
}
