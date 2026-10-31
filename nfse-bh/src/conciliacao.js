// Conciliação bancária: lê o extrato (OFX, CSV ou TXT), encontra os créditos que pagam notas em aberto
// (valor + nome/documento do cliente) e dá baixa automática quando o casamento é inequívoco.
import crypto from 'node:crypto';
import { camposDaBaixa, situacaoDaNota, situacaoDaRecebida, valorEsperado } from './financeiro.js';

const soDigitos = (s) => String(s ?? '').replace(/\D/g, '');

// ---------- Leitura do extrato ----------

/** Linhas de saldo ("SALDO TOTAL DISPONÍVEL DIA", "SALDO ANTERIOR"…) não são lançamentos. */
export const ehSaldo = (descricao) => /^\s*saldo\b|\bsaldo (total|anterior|disponivel|do dia|final|inicial|bloqueado|em conta)\b/.test(normalizar(descricao));

/** "1.860,00" | "1860.00" | "-1.860,00" | "R$ 1.860,00 C" → número */
export function numeroBR(s) {
  let t = String(s ?? '').trim().replace(/R\$\s*/i, '').replace(/\s/g, '');
  let sinal = 1;
  if (/^\(.*\)$/.test(t)) [t, sinal] = [t.slice(1, -1), -1];
  if (/[dD]$/.test(t)) [t, sinal] = [t.slice(0, -1), -1];
  t = t.replace(/[cC]$/, '');
  if (t.includes(',') && t.lastIndexOf(',') > t.lastIndexOf('.')) t = t.replace(/\./g, '').replace(',', '.');
  else t = t.replace(/,/g, '');
  const n = Number(t);
  return Number.isFinite(n) ? n * sinal : NaN;
}

/** "15/10/2026" | "2026-10-15" | "20261015..." | "15/10/26" → "2026-10-15" */
export function dataBR(s) {
  const t = String(s ?? '').trim();
  let m;
  if ((m = t.match(/^(\d{4})-(\d{2})-(\d{2})/))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = t.match(/^(\d{4})(\d{2})(\d{2})/))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/))) {
    const ano = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${ano}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return null;
}

function lerOfx(texto) {
  const lancs = [];
  const blocos = texto.split(/<STMTTRN>/i).slice(1);
  for (const b of blocos) {
    const campo = (nome) => (b.match(new RegExp(`<${nome}>([^<\\r\\n]*)`, 'i')) ?? [])[1]?.trim() ?? '';
    lancs.push({
      data: dataBR(campo('DTPOSTED')),
      valor: numeroBR(campo('TRNAMT').replace(',', '.')),
      descricao: [campo('NAME'), campo('MEMO')].filter(Boolean).join(' - '),
      idBanco: campo('FITID') || null,
    });
  }
  return lancs;
}

function dividirLinhaCsv(linha, sep) {
  const out = [];
  let atual = '';
  let aspas = false;
  for (let i = 0; i < linha.length; i++) {
    const c = linha[i];
    if (c === '"') {
      if (aspas && linha[i + 1] === '"') {
        atual += '"';
        i++;
      } else aspas = !aspas;
    } else if (c === sep && !aspas) {
      out.push(atual.trim());
      atual = '';
    } else atual += c;
  }
  out.push(atual.trim());
  return out;
}

const normalizar = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

function lerCsv(texto) {
  const linhas = texto.split(/\r?\n/).filter((l) => l.trim());
  if (!linhas.length) return [];
  const sep = [';', '\t', ','].sort((a, b) => linhas[0].split(b).length - linhas[0].split(a).length)[0];
  // Cabeçalho: a primeira linha (até a 10ª) que tenha "data" e "valor"/"credito"
  let ih = linhas.slice(0, 10).findIndex((l) => /data/i.test(normalizar(l)) && /(valor|credito|entrada)/i.test(normalizar(l)));
  let cols;
  if (ih >= 0) {
    const cab = dividirLinhaCsv(linhas[ih], sep).map(normalizar);
    // Expressões em ordem de preferência: a primeira que achar coluna vence
    const acha = (...re) => {
      for (const r of re) {
        const i = cab.findIndex((c) => r.test(c));
        if (i >= 0) return i;
      }
      return -1;
    };
    cols = {
      data: acha(/^data/, /dt/),
      valor: acha(/^valor$/, /valor \(r\$\)/, /^valor/, /montante/),
      credito: acha(/credito/, /entrada/),
      debito: acha(/debito/, /saida/),
      desc: [acha(/historico/), acha(/descricao/, /detalhe/, /memo/, /^lancamento/), acha(/nome/, /favorecido/, /pagador/, /origem/)].filter((i, k, a) => i >= 0 && a.indexOf(i) === k),
      doc: acha(/cpf|cnpj|documento/),
    };
  } else {
    ih = -1;
    cols = null;
  }
  const lancs = [];
  for (const linha of linhas.slice(ih + 1)) {
    const c = dividirLinhaCsv(linha, sep);
    if (cols) {
      const data = dataBR(c[cols.data]);
      let valor = cols.valor >= 0 ? numeroBR(c[cols.valor]) : NaN;
      if (!Number.isFinite(valor) && cols.credito >= 0) valor = numeroBR(c[cols.credito]) || -Math.abs(numeroBR(c[cols.debito]) || 0);
      const descricao = cols.desc.map((i) => c[i]).filter(Boolean).join(' - ') + (cols.doc >= 0 && c[cols.doc] ? ` ${c[cols.doc]}` : '');
      if (data && Number.isFinite(valor)) lancs.push({ data, valor, descricao, idBanco: null });
    } else {
      lancs.push(...lerTxtLinha(linha));
    }
  }
  return lancs;
}

// Linha livre: "15/10/2026  PIX RECEBIDO CLIENTE X   1.860,00"
function lerTxtLinha(linha) {
  const d = linha.match(/(\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2})/);
  const valores = [...linha.matchAll(/-?\(?(?:R\$\s*)?\d{1,3}(?:\.\d{3})*,\d{2}\)?\s*[CD]?|-?\d+\.\d{2}(?!\d)/g)].map((m) => m[0]);
  if (!d || !valores.length) return [];
  // Último número costuma ser o saldo quando há dois; o lançamento é o penúltimo
  const bruto = valores.length >= 2 ? valores[valores.length - 2] : valores[0];
  const descricao = linha.replace(d[0], '').replace(bruto, '').replace(valores[valores.length - 1], '').replace(/\s{2,}/g, ' ').trim();
  return [{ data: dataBR(d[0]), valor: numeroBR(bruto), descricao, idBanco: null }];
}

/** Lê o extrato em qualquer dos formatos suportados; devolve só os lançamentos válidos. */
export function lerExtrato(texto, nome = '') {
  let lancs;
  if (/<OFX>|<STMTTRN>/i.test(texto) || /\.ofx$/i.test(nome)) lancs = lerOfx(texto);
  else if (/\.csv$/i.test(nome) || /[;\t]/.test(texto.split(/\r?\n/)[0] ?? '')) lancs = lerCsv(texto);
  else lancs = texto.split(/\r?\n/).flatMap(lerTxtLinha);
  return lancs
    .filter((l) => l.data && Number.isFinite(l.valor) && l.valor !== 0 && !ehSaldo(l.descricao))
    .map((l) => ({
      ...l,
      valor: Number(l.valor.toFixed(2)),
      // Identificador estável para não processar o mesmo lançamento duas vezes ao reimportar
      hash: l.idBanco || crypto.createHash('sha1').update(`${l.data}|${l.valor.toFixed(2)}|${normalizar(l.descricao)}`).digest('hex').slice(0, 16),
    }));
}

// ---------- Casamento com as notas ----------

const STOP = new Set(['ltda', 'me', 'epp', 'eireli', 'sa', 's/a', 'da', 'de', 'do', 'das', 'dos', 'e', 'cia', 'pix', 'ted', 'doc', 'transf', 'transferencia', 'recebido', 'recebida', 'credito', 'pagamento', 'servicos', 'servico', 'brasil', 'ss', 'mei', 'em', 'para', 'por', 'com']);
const tokens = (s) =>
  normalizar(s)
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t));

/** 0 a 1: quanto do nome do cliente aparece na descrição do lançamento (documento conta como 1). */
export function semelhancaNome(descricao, cliente) {
  const doc = soDigitos(cliente.documento);
  const digitosDesc = soDigitos(descricao);
  if (doc && digitosDesc.includes(doc)) return 1;
  if (doc.length === 14 && digitosDesc.includes(doc.slice(0, 8))) return 0.95; // raiz do CNPJ
  const desc = new Set(tokens(descricao));
  let melhor = 0;
  for (const nome of [cliente.nome, cliente.nomeFantasia, ...(cliente.apelidos ?? [])].filter(Boolean)) {
    const t = tokens(nome);
    if (!t.length) continue;
    const achados = t.filter((x) => desc.has(x) || [...desc].some((d) => d.length >= 4 && (d.startsWith(x) || x.startsWith(d))));
    melhor = Math.max(melhor, achados.length / t.length);
  }
  return melhor;
}

function somarDias(data, dias) {
  const d = new Date(`${data}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}
const diasEntre = (de, ate) => Math.round((Date.parse(`${ate}T12:00:00Z`) - Date.parse(`${de}T12:00:00Z`)) / 864e5);

// ---------- Aprendizado com as escolhas do usuário ----------
// Cada "ligar à nota" ensina: descrição deste tipo → este CNPJ. Cada "Não é nota" ensina: descrição igual → ignorar.
// As regras ficam em data/estado.json (aprendizado_extrato) e valem para os próximos extratos e reprocessamentos.

/** Assinatura da descrição: palavras significativas, sem números, datas ou ordem. */
export const assinatura = (descricao) => [...new Set(tokens(descricao))].sort().join(' ');

export function lerAprendizado(store) {
  const a = store?.estado?.obter('aprendizado_extrato', null) ?? {};
  return { vinculos: a.vinculos ?? [], ignorar: a.ignorar ?? [] };
}
const gravarAprendizado = (store, a) => store.estado.definir('aprendizado_extrato', a);

/** Registra (ou reforça) uma regra. tipo: "vinculo" (precisa de documento) ou "ignorar". */
export function aprender(store, tipo, { descricao, documento, nome }) {
  const chave = assinatura(descricao);
  if (!chave) return;
  const a = lerAprendizado(store);
  const lista = tipo === 'ignorar' ? a.ignorar : a.vinculos;
  const r = lista.find((x) => x.assinatura === chave && (tipo === 'ignorar' || x.documento === documento));
  if (r) Object.assign(r, { vezes: r.vezes + 1, em: new Date().toISOString() });
  else lista.push({ assinatura: chave, exemplo: descricao, ...(tipo === 'vinculo' ? { documento, nome } : {}), vezes: 1, em: new Date().toISOString() });
  gravarAprendizado(store, a);
}

/** Desfaz uma regra (o usuário corrigiu uma escolha). */
export function esquecer(store, tipo, { descricao, documento }) {
  const chave = assinatura(descricao);
  const a = lerAprendizado(store);
  if (tipo === 'ignorar') a.ignorar = a.ignorar.filter((x) => x.assinatura !== chave);
  else a.vinculos = a.vinculos.filter((x) => !(x.assinatura === chave && (!documento || x.documento === documento)));
  gravarAprendizado(store, a);
}

/** Remove uma regra pela lista em tela. */
export function removerRegra(store, tipo, indice) {
  const a = lerAprendizado(store);
  (tipo === 'ignorar' ? a.ignorar : a.vinculos).splice(Number(indice), 1);
  gravarAprendizado(store, a);
  return a;
}

/** Documentos que o usuário já ligou a descrições como esta (todas as palavras da regra presentes). */
function documentosAprendidos(descricao, aprendizado) {
  const desc = new Set(tokens(descricao));
  return new Set(aprendizado.vinculos.filter((r) => r.assinatura.split(' ').every((t) => desc.has(t))).map((r) => r.documento));
}

/** Motivo para ignorar o lançamento sem perguntar, ou null. */
export function motivoParaIgnorar(descricao, aprendizado) {
  if (ehSaldo(descricao)) return 'saldo';
  const chave = assinatura(descricao);
  return chave && aprendizado.ignorar.some((r) => r.assinatura === chave) ? 'aprendido' : null;
}

// ---------- Pontuação ----------

/** Nota que ainda pode receber o crédito: em aberto, ou marcada como paga na importação do histórico sem data de pagamento. */
export const presumidaPaga = (n) => n.situacao === 'pago' && !n.baixa && !n.dataPagamento;
export const elegivel = (n) => ['aguardando', 'atrasada'].includes(situacaoDaNota(n)) || presumidaPaga(n);

/**
 * Quanto um lançamento combina com uma nota. motivos: documento (CNPJ/CPF na descrição), aprendido (você já ligou
 * descrição igual a este cliente), nome (fração do nome), valor (exato | retencao), periodo (emitida até 75 dias antes).
 */
export function avaliar(l, nota, contraparte, docsAprendidos = new Set()) {
  const valor = Math.abs(l.valor);
  const motivos = {};
  const doc = soDigitos(contraparte.documento);
  const dig = soDigitos(l.descricao);
  if (doc && (dig.includes(doc) || (doc.length === 14 && dig.includes(doc.slice(0, 8))))) motivos.documento = true;
  else if (doc && docsAprendidos.has(doc)) motivos.aprendido = true;
  const nome = semelhancaNome(l.descricao, { ...contraparte, documento: '' });
  if (nome >= 0.5) motivos.nome = Number(nome.toFixed(2));
  const bruto = Number(nota.valor);
  const esperado = Number(nota.valorLiquido ?? nota.valorAPagar ?? nota.valor);
  if (Math.abs(esperado - valor) < 0.01 || Math.abs(bruto - valor) < 0.01) motivos.valor = 'exato';
  else if (valor < bruto && valor >= bruto * 0.85) motivos.valor = 'retencao'; // IR/PIS/COFINS/CSLL/ISS retidos pelo cliente
  const dias = nota.dataEmissao ? diasEntre(nota.dataEmissao, l.data) : 0;
  if (dias >= -5 && dias <= 75) motivos.periodo = true;
  const identidade = motivos.documento || motivos.aprendido ? 1 : motivos.nome ?? 0;
  const pontos = identidade * 5 + (motivos.valor === 'exato' ? 4 : motivos.valor === 'retencao' ? 1.5 : 0) + (motivos.periodo ? 1 : 0);
  return { identidade, pontos: Number(pontos.toFixed(2)), motivos };
}

/** Escolhe o casamento automático ou devolve as candidatas ordenadas. */
function decidir(l, candidatos, chaveCliente) {
  const ordenados = candidatos.sort((a, b) => b.pontos - a.pontos || a.presumida - b.presumida || (a.data ?? '').localeCompare(b.data ?? ''));
  if (!ordenados.length) return { tipo: 'sem_nota', candidatos: [] };
  // 1) identidade (CNPJ, nome ou regra aprendida) + valor exato; havendo outra igual, paga a mais antiga
  const fortes = ordenados.filter((c) => c.identidade >= 0.5 && c.motivos.valor === 'exato' && c.motivos.periodo);
  if (fortes.length) {
    const topo = Math.max(...fortes.map((c) => c.identidade));
    const melhores = fortes.filter((c) => c.identidade === topo);
    const abertas = melhores.filter((c) => !c.presumida);
    const escolha = (abertas.length ? abertas : melhores).sort((a, b) => (a.data ?? '').localeCompare(b.data ?? ''))[0];
    return { tipo: 'automatico', escolha, candidatos: ordenados };
  }
  // 2) CNPJ/regra aprendida + valor com retenção + única nota em aberto desse cliente no período
  const comRetencao = ordenados.filter((c) => c.identidade === 1 && c.motivos.valor === 'retencao' && c.motivos.periodo && !c.presumida);
  if (comRetencao.length === 1 && ordenados.filter((c) => chaveCliente(c) === chaveCliente(comRetencao[0]) && c.motivos.periodo && !c.presumida).length === 1) {
    return { tipo: 'automatico', escolha: comRetencao[0], candidatos: ordenados };
  }
  return { tipo: 'sugestao', candidatos: ordenados };
}

/**
 * Propõe o casamento de cada crédito com as notas emitidas.
 * automatico: nome/CNPJ confere e valor exato (ou CNPJ + valor líquido de retenções, única nota do cliente).
 * sugestao: há notas relacionadas por nome, CNPJ ou valor — o usuário escolhe. sem_nota: nada relacionado.
 */
export function conciliar({ lancamentos, notas, clientes, aprendizado = { vinculos: [], ignorar: [] } }) {
  const porId = new Map(clientes.map((c) => [c.id, c]));
  const candidatas = notas.filter((n) => n.status !== 'cancelada' && elegivel(n));
  const usadas = new Set();
  const resultado = [];
  for (const l of [...lancamentos].filter((x) => x.valor > 0).sort((a, b) => a.data.localeCompare(b.data))) {
    const docs = documentosAprendidos(l.descricao, aprendizado);
    const candidatos = candidatas
      .filter((n) => !usadas.has(n.id))
      .filter((n) => !n.dataEmissao || l.data >= somarDias(n.dataEmissao, -5)) // pagamento não antecede a emissão
      .map((n) => {
        const cliente = porId.get(n.clienteId) ?? { nome: n.tomador?.nome, documento: n.tomador?.documento };
        return { nota: n, data: n.dataEmissao, presumida: presumidaPaga(n) ? 1 : 0, ...avaliar(l, n, cliente, docs) };
      })
      .filter((c) => c.identidade >= 0.5 || c.motivos.valor);
    const d = decidir(l, candidatos, (c) => c.nota.clienteId ?? soDigitos(c.nota.tomador?.documento));
    if (d.tipo === 'automatico') {
      usadas.add(d.escolha.nota.id);
      resultado.push({ lancamento: l, tipo: 'automatico', nota: d.escolha.nota, score: d.escolha.identidade, candidatos: d.candidatos });
    } else resultado.push({ lancamento: l, ...d });
  }
  return resultado;
}

/**
 * Débitos que pagam notas recebidas (fornecedores): mesmo critério dos créditos.
 * Débito sem nota relacionada não é guardado (tarifas, compras etc.).
 */
export function conciliarPagamentos({ lancamentos, recebidas, aprendizado = { vinculos: [], ignorar: [] } }) {
  const abertas = recebidas.filter((r) => ['a_pagar', 'vencida'].includes(situacaoDaRecebida(r)));
  const usadas = new Set();
  const resultado = [];
  for (const l of [...lancamentos].filter((x) => x.valor < 0).sort((a, b) => a.data.localeCompare(b.data))) {
    const docs = documentosAprendidos(l.descricao, aprendizado);
    const candidatos = abertas
      .filter((r) => !usadas.has(r.id))
      .filter((r) => !r.dataEmissao || l.data >= somarDias(r.dataEmissao, -5))
      .map((r) => ({ recebida: r, data: r.dataEmissao, presumida: 0, ...avaliar(l, r, r.fornecedor ?? {}, docs) }))
      .filter((c) => c.identidade >= 0.5 || c.motivos.valor === 'exato');
    if (!candidatos.length) continue;
    const d = decidir(l, candidatos, (c) => soDigitos(c.recebida.fornecedor?.documento));
    if (d.tipo === 'automatico') {
      usadas.add(d.escolha.recebida.id);
      resultado.push({ lancamento: l, tipo: 'automatico', recebida: d.escolha.recebida, candidatos: d.candidatos });
    } else resultado.push({ lancamento: l, ...d });
  }
  return resultado;
}

// ---------- Gravação ----------

const resumoSugestoes = (candidatos, campo) =>
  candidatos.slice(0, 8).map((c) => ({ [campo]: (c.nota ?? c.recebida).id, score: Number(c.identidade.toFixed(2)), pontos: c.pontos, motivos: c.motivos }));

function baixarNota(store, nota, l, lancamentoId) {
  store.notas.salvar({ id: nota.id, ...camposDaBaixa(nota, { tipo: 'pago', dataPagamento: l.data, valorPago: l.valor, origem: 'extrato', lancamentoId }) });
}
function pagarRecebida(store, r, l, lancamentoId) {
  store.recebidas.salvar({ id: r.id, situacao: 'pago', dataPagamento: l.data, valorPago: Math.abs(l.valor).toFixed(2), baixa: { origem: 'extrato', lancamentoId } });
}

/** Processa um extrato: registra os lançamentos novos e dá baixa nas notas casadas automaticamente. */
export function processarExtrato({ store, texto, nome }) {
  const lidos = lerExtrato(texto, nome);
  const saldos = texto.split(/\r?\n|<STMTTRN>/i).filter((linha) => ehSaldo(linha.replace(/^[\d/.\-\s]+/, ''))).length;
  const conhecidos = new Set(store.lancamentos.listar().map((l) => l.hash));
  const novos = lidos.filter((l) => !conhecidos.has(l.hash));
  const aprendizado = lerAprendizado(store);
  const agora = new Date().toISOString();

  const registros = [];
  const baixadas = [];
  const pagas = [];
  // Regras aprendidas de "Não é nota": entram direto como ignorados
  const ignorados = [];
  const aConciliar = [];
  for (const l of novos) {
    const motivo = motivoParaIgnorar(l.descricao, aprendizado);
    if (motivo) ignorados.push({ ...l, id: crypto.randomUUID(), arquivo: nome, importadoEm: agora, status: 'ignorado', motivoIgnorado: motivo });
    else aConciliar.push(l);
  }
  registros.push(...ignorados.filter((l) => l.valor > 0));

  for (const c of conciliar({ lancamentos: aConciliar, notas: store.notas.listar(), clientes: store.clientes.listar(), aprendizado })) {
    const id = crypto.randomUUID();
    registros.push({
      ...c.lancamento, id, arquivo: nome, importadoEm: agora,
      notaId: c.tipo === 'automatico' ? c.nota.id : null,
      status: c.tipo === 'automatico' ? 'conciliado' : c.tipo === 'sugestao' ? 'pendente' : 'sem_nota',
      sugestoes: c.tipo === 'automatico' ? [] : resumoSugestoes(c.candidatos, 'notaId'),
    });
    if (c.tipo === 'automatico') {
      baixarNota(store, c.nota, c.lancamento, id);
      baixadas.push({ notaId: c.nota.id, cliente: c.nota.tomador?.nome, numero: c.nota.numero, valor: c.lancamento.valor, data: c.lancamento.data });
    }
  }
  for (const c of conciliarPagamentos({ lancamentos: aConciliar, recebidas: store.recebidas.listar(), aprendizado })) {
    const id = crypto.randomUUID();
    registros.push({
      ...c.lancamento, id, arquivo: nome, importadoEm: agora, alvo: 'recebida',
      recebidaId: c.tipo === 'automatico' ? c.recebida.id : null,
      status: c.tipo === 'automatico' ? 'conciliado' : 'pendente',
      sugestoes: c.tipo === 'automatico' ? [] : resumoSugestoes(c.candidatos, 'recebidaId'),
    });
    if (c.tipo === 'automatico') {
      pagarRecebida(store, c.recebida, c.lancamento, id);
      pagas.push({ recebidaId: c.recebida.id, fornecedor: c.recebida.fornecedor?.nome, numero: c.recebida.numero, valor: -c.lancamento.valor, data: c.lancamento.data });
    }
  }
  if (registros.length) store.lancamentos.salvarVarios(registros);
  return {
    lidos: lidos.length,
    creditos: lidos.filter((l) => l.valor > 0).length,
    jaImportados: lidos.length - novos.length,
    baixadas,
    pagas,
    ignorados: ignorados.length + saldos,
    sugestoes: registros.filter((r) => r.status === 'pendente').length,
    semNota: registros.filter((r) => r.status === 'sem_nota').length,
  };
}

/**
 * Reavalia os lançamentos que ainda estão "a conferir": roda depois de importar notas (portal, PDF, XML) e depois de
 * cada escolha do usuário, para que uma nota nova ou uma regra aprendida resolva os pendentes sozinha.
 */
export function reprocessarPendentes({ store }) {
  const aprendizado = lerAprendizado(store);
  const pendentes = store.lancamentos.listar().filter((l) => ['pendente', 'sem_nota'].includes(l.status));
  const r = { conciliados: [], ignorados: 0 };
  const restantes = [];
  for (const l of pendentes) {
    const motivo = motivoParaIgnorar(l.descricao, aprendizado);
    if (motivo) {
      store.lancamentos.salvar({ id: l.id, status: 'ignorado', motivoIgnorado: motivo });
      r.ignorados++;
    } else restantes.push(l);
  }
  for (const c of conciliar({ lancamentos: restantes.filter((l) => l.alvo !== 'recebida'), notas: store.notas.listar(), clientes: store.clientes.listar(), aprendizado })) {
    // Lançamento reaberto pelo usuário: nunca volta a casar sozinho
    if (c.tipo === 'automatico' && !c.lancamento.semAuto) {
      baixarNota(store, c.nota, c.lancamento, c.lancamento.id);
      store.lancamentos.salvar({ id: c.lancamento.id, notaId: c.nota.id, status: 'conciliado', sugestoes: [] });
      r.conciliados.push({ lancamentoId: c.lancamento.id, notaId: c.nota.id, cliente: c.nota.tomador?.nome, numero: c.nota.numero, valor: c.lancamento.valor });
    } else {
      store.lancamentos.salvar({ id: c.lancamento.id, status: c.candidatos.length ? 'pendente' : 'sem_nota', sugestoes: resumoSugestoes(c.candidatos, 'notaId') });
    }
  }
  for (const c of conciliarPagamentos({ lancamentos: restantes.filter((l) => l.alvo === 'recebida'), recebidas: store.recebidas.listar(), aprendizado })) {
    if (c.tipo === 'automatico' && !c.lancamento.semAuto) {
      pagarRecebida(store, c.recebida, c.lancamento, c.lancamento.id);
      store.lancamentos.salvar({ id: c.lancamento.id, recebidaId: c.recebida.id, status: 'conciliado', sugestoes: [] });
      r.conciliados.push({ lancamentoId: c.lancamento.id, recebidaId: c.recebida.id, fornecedor: c.recebida.fornecedor?.nome, numero: c.recebida.numero, valor: c.lancamento.valor });
    } else store.lancamentos.salvar({ id: c.lancamento.id, sugestoes: resumoSugestoes(c.candidatos, 'recebidaId') });
  }
  return r;
}

/**
 * Pesquisa manual de notas para um lançamento (outro mês, outro cliente). Traz também as já pagas, com aviso,
 * porque a nota pode ter sido baixada por engano ou presumida paga na importação.
 */
export function pesquisarNotas({ store, lancamentoId, mes, q = '' }) {
  const l = store.lancamentos.obter(lancamentoId);
  if (!l) throw Object.assign(new Error('Lançamento não encontrado'), { statusHttp: 400 });
  const aprendizado = lerAprendizado(store);
  const docs = documentosAprendidos(l.descricao, aprendizado);
  const termo = normalizar(q).trim();
  const casaTermo = (...campos) => !termo || normalizar(campos.join(' ')).includes(termo) || (soDigitos(termo) && soDigitos(campos.join(' ')).includes(soDigitos(termo)));
  if (l.alvo === 'recebida') {
    return store.recebidas.listar()
      .filter((r) => situacaoDaRecebida(r) !== 'cancelada' && (!mes || r.dataEmissao?.startsWith(mes)) && casaTermo(r.fornecedor?.nome, r.fornecedor?.documento, r.numero))
      .map((r) => ({ recebidaId: r.id, nome: r.fornecedor?.nome, numero: r.numero, dataEmissao: r.dataEmissao, valor: r.valor, situacao: situacaoDaRecebida(r), ...avaliar(l, r, r.fornecedor ?? {}, docs) }))
      .sort((a, b) => b.pontos - a.pontos || b.dataEmissao.localeCompare(a.dataEmissao))
      .slice(0, 50);
  }
  const porId = new Map(store.clientes.listar().map((c) => [c.id, c]));
  return store.notas.listar()
    .filter((n) => n.status !== 'cancelada' && !['cancelada', 'substituida'].includes(situacaoDaNota(n)))
    .filter((n) => (!mes || n.dataEmissao?.startsWith(mes)) && casaTermo(n.tomador?.nome, n.tomador?.documento, n.numero))
    .map((n) => {
      const cli = porId.get(n.clienteId) ?? { nome: n.tomador?.nome, documento: n.tomador?.documento };
      const sit = situacaoDaNota(n);
      return { notaId: n.id, nome: n.tomador?.nome, numero: n.numero, dataEmissao: n.dataEmissao, valor: n.valor, valorAPagar: valorEsperado(n).toFixed(2), situacao: sit, presumida: presumidaPaga(n), jaConciliada: sit === 'pago' && !presumidaPaga(n), ...avaliar(l, n, cli, docs) };
    })
    .sort((a, b) => a.jaConciliada - b.jaConciliada || b.pontos - a.pontos || (b.dataEmissao ?? '').localeCompare(a.dataEmissao ?? ''))
    .slice(0, 50);
}

/** Confirma manualmente o casamento de um lançamento com uma nota — e aprende a descrição → cliente. */
export function confirmarLancamento({ store, lancamentoId, notaId, recebidaId }) {
  const l = store.lancamentos.obter(lancamentoId);
  if (recebidaId) {
    const r = store.recebidas.obter(recebidaId);
    if (!l || !r) throw Object.assign(new Error('Lançamento ou nota recebida não encontrado'), { statusHttp: 400 });
    pagarRecebida(store, r, l, l.id);
    if (r.fornecedor?.documento) aprender(store, 'vinculo', { descricao: l.descricao, documento: soDigitos(r.fornecedor.documento), nome: r.fornecedor.nome });
    const salvo = store.lancamentos.salvar({ id: l.id, recebidaId: r.id, status: 'conciliado' });
    return { lancamento: salvo, reprocessados: reprocessarPendentes({ store }) };
  }
  const n = store.notas.obter(notaId);
  if (!l || !n) throw Object.assign(new Error('Lançamento ou nota não encontrado'), { statusHttp: 400 });
  // Se a nota já tinha baixa por outro lançamento, esse lançamento volta para conferência
  if (n.baixa?.lancamentoId && n.baixa.lancamentoId !== l.id) {
    const anterior = store.lancamentos.obter(n.baixa.lancamentoId);
    if (anterior) store.lancamentos.salvar({ id: anterior.id, status: 'pendente', notaId: null });
  }
  baixarNota(store, n, l, l.id);
  const doc = soDigitos(n.tomador?.documento ?? store.clientes.obter(n.clienteId)?.documento);
  if (doc) aprender(store, 'vinculo', { descricao: l.descricao, documento: doc, nome: n.tomador?.nome });
  const salvo = store.lancamentos.salvar({ id: l.id, notaId: n.id, status: 'conciliado' });
  return { lancamento: salvo, reprocessados: reprocessarPendentes({ store }) };
}

/** "Não é nota": ignora e aprende — próximos lançamentos com a mesma descrição são ignorados sozinhos. */
export function ignorarLancamento({ store, lancamentoId, aprenderRegra = true }) {
  const l = store.lancamentos.obter(lancamentoId);
  if (!l) throw Object.assign(new Error('Lançamento não encontrado'), { statusHttp: 400 });
  if (aprenderRegra) aprender(store, 'ignorar', { descricao: l.descricao });
  store.lancamentos.salvar({ id: l.id, status: 'ignorado', motivoIgnorado: 'voce' });
  return { reprocessados: reprocessarPendentes({ store }) };
}

/** Desfaz: conciliado ou ignorado volta para "a conferir", a baixa da nota é revertida e a regra aprendida, esquecida. */
export function reabrirLancamento({ store, lancamentoId }) {
  const l = store.lancamentos.obter(lancamentoId);
  if (!l) throw Object.assign(new Error('Lançamento não encontrado'), { statusHttp: 400 });
  if (l.status === 'ignorado') esquecer(store, 'ignorar', { descricao: l.descricao });
  if (l.notaId) {
    const n = store.notas.obter(l.notaId);
    if (n?.baixa?.lancamentoId === l.id) store.notas.salvar({ id: n.id, ...camposDaBaixa(n, { tipo: 'aguardando' }) });
    if (n) esquecer(store, 'vinculo', { descricao: l.descricao, documento: soDigitos(n.tomador?.documento) });
  }
  if (l.recebidaId) {
    const r = store.recebidas.obter(l.recebidaId);
    if (r?.baixa?.lancamentoId === l.id) store.recebidas.salvar({ id: r.id, situacao: 'a_pagar', dataPagamento: null, valorPago: null, baixa: null });
    if (r) esquecer(store, 'vinculo', { descricao: l.descricao, documento: soDigitos(r.fornecedor?.documento) });
  }
  store.lancamentos.salvar({ id: l.id, status: 'pendente', notaId: null, recebidaId: null, motivoIgnorado: null, semAuto: true });
  reprocessarPendentes({ store });
  return store.lancamentos.obter(l.id);
}
