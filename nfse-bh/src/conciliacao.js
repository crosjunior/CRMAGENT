// Conciliação bancária: lê o extrato (OFX, CSV ou TXT), encontra os créditos que pagam notas em aberto
// (valor + nome/documento do cliente) e dá baixa automática quando o casamento é inequívoco.
import crypto from 'node:crypto';
import { camposDaBaixa, situacaoDaNota, situacaoDaRecebida, valorEsperado } from './financeiro.js';

const soDigitos = (s) => String(s ?? '').replace(/\D/g, '');

// ---------- Leitura do extrato ----------

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
    .filter((l) => l.data && Number.isFinite(l.valor) && l.valor !== 0)
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

/**
 * Propõe o casamento de cada crédito com as notas em aberto.
 * automatico: valor exato + (nome/documento ≥ 0,5) e um único candidato — dá baixa sem perguntar.
 * sugestao: valor bate mas o nome não confirma, ou há mais de um candidato — o usuário escolhe.
 */
export function conciliar({ lancamentos, notas, clientes }) {
  const porId = new Map(clientes.map((c) => [c.id, c]));
  const abertas = notas.filter((n) => ['aguardando', 'atrasada'].includes(situacaoDaNota(n)));
  const usadas = new Set();
  const resultado = [];

  // Créditos mais antigos primeiro: pagam as notas mais antigas
  for (const l of [...lancamentos].filter((x) => x.valor > 0).sort((a, b) => a.data.localeCompare(b.data))) {
    const candidatos = abertas
      .filter((n) => !usadas.has(n.id))
      .filter((n) => Math.abs(valorEsperado(n) - l.valor) < 0.01 || Math.abs(Number(n.valor) - l.valor) < 0.01)
      // pagamento não antecede a emissão (folga de 5 dias para notas emitidas após o depósito)
      .filter((n) => !n.dataEmissao || l.data >= somarDias(n.dataEmissao, -5))
      .map((n) => {
        const cliente = porId.get(n.clienteId) ?? { nome: n.tomador.nome, documento: n.tomador.documento };
        return { nota: n, score: semelhancaNome(l.descricao, cliente) };
      })
      .sort((a, b) => b.score - a.score || a.nota.dataEmissao.localeCompare(b.nota.dataEmissao));

    if (!candidatos.length) {
      resultado.push({ lancamento: l, tipo: 'sem_nota', candidatos: [] });
      continue;
    }
    const [melhor, segundo] = candidatos;
    const confiavel = melhor.score >= 0.5 && (!segundo || segundo.score < melhor.score || segundo.nota.dataEmissao > melhor.nota.dataEmissao);
    if (confiavel) {
      usadas.add(melhor.nota.id);
      resultado.push({ lancamento: l, tipo: 'automatico', nota: melhor.nota, score: melhor.score, candidatos });
    } else {
      resultado.push({ lancamento: l, tipo: 'sugestao', candidatos });
    }
  }
  return resultado;
}

function somarDias(data, dias) {
  const d = new Date(`${data}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

/**
 * Débitos que pagam notas recebidas (fornecedores): mesmo critério dos créditos — valor (líquido ou bruto)
 * e nome/CNPJ do fornecedor na descrição. Débito sem nota candidata não é guardado (tarifas, compras etc.).
 */
export function conciliarPagamentos({ lancamentos, recebidas }) {
  const abertas = recebidas.filter((r) => ['a_pagar', 'vencida'].includes(situacaoDaRecebida(r)));
  const usadas = new Set();
  const resultado = [];
  for (const l of [...lancamentos].filter((x) => x.valor < 0).sort((a, b) => a.data.localeCompare(b.data))) {
    const valor = -l.valor;
    const candidatos = abertas
      .filter((r) => !usadas.has(r.id))
      .filter((r) => Math.abs(Number(r.valorLiquido ?? r.valor) - valor) < 0.01 || Math.abs(Number(r.valor) - valor) < 0.01)
      .filter((r) => !r.dataEmissao || l.data >= somarDias(r.dataEmissao, -5))
      .map((r) => ({ recebida: r, score: semelhancaNome(l.descricao, r.fornecedor ?? {}) }))
      .sort((a, b) => b.score - a.score || a.recebida.dataEmissao.localeCompare(b.recebida.dataEmissao));
    if (!candidatos.length) continue;
    const [melhor, segundo] = candidatos;
    if (melhor.score >= 0.5 && (!segundo || segundo.score < melhor.score || segundo.recebida.dataEmissao > melhor.recebida.dataEmissao)) {
      usadas.add(melhor.recebida.id);
      resultado.push({ lancamento: l, tipo: 'automatico', recebida: melhor.recebida, candidatos });
    } else resultado.push({ lancamento: l, tipo: 'sugestao', candidatos });
  }
  return resultado;
}

/** Processa um extrato: registra os lançamentos novos e dá baixa nas notas casadas automaticamente. */
export function processarExtrato({ store, texto, nome }) {
  const lidos = lerExtrato(texto, nome);
  const conhecidos = new Set(store.lancamentos.listar().map((l) => l.hash));
  const novos = lidos.filter((l) => !conhecidos.has(l.hash));
  const casamentos = conciliar({ lancamentos: novos, notas: store.notas.listar(), clientes: store.clientes.listar() });

  const registros = [];
  const baixadas = [];
  for (const c of casamentos) {
    const id = crypto.randomUUID();
    const reg = {
      ...c.lancamento,
      id,
      arquivo: nome,
      importadoEm: new Date().toISOString(),
      notaId: c.tipo === 'automatico' ? c.nota.id : null,
      status: c.tipo === 'automatico' ? 'conciliado' : c.tipo === 'sugestao' ? 'pendente' : 'sem_nota',
      sugestoes: c.tipo === 'sugestao' ? c.candidatos.slice(0, 5).map((x) => ({ notaId: x.nota.id, score: Number(x.score.toFixed(2)) })) : [],
    };
    registros.push(reg);
    if (c.tipo === 'automatico') {
      store.notas.salvar({
        id: c.nota.id,
        ...camposDaBaixa(c.nota, { tipo: 'pago', dataPagamento: c.lancamento.data, valorPago: c.lancamento.valor, origem: 'extrato', lancamentoId: id }),
      });
      baixadas.push({ notaId: c.nota.id, cliente: c.nota.tomador.nome, numero: c.nota.numero, valor: c.lancamento.valor, data: c.lancamento.data });
    }
  }
  // Pagamentos a fornecedores (débitos) contra as notas recebidas
  const pagas = [];
  for (const c of conciliarPagamentos({ lancamentos: novos, recebidas: store.recebidas.listar() })) {
    const id = crypto.randomUUID();
    registros.push({
      ...c.lancamento,
      id,
      arquivo: nome,
      importadoEm: new Date().toISOString(),
      alvo: 'recebida',
      recebidaId: c.tipo === 'automatico' ? c.recebida.id : null,
      status: c.tipo === 'automatico' ? 'conciliado' : 'pendente',
      sugestoes: c.tipo === 'sugestao' ? c.candidatos.slice(0, 5).map((x) => ({ recebidaId: x.recebida.id, score: Number(x.score.toFixed(2)) })) : [],
    });
    if (c.tipo === 'automatico') {
      store.recebidas.salvar({ id: c.recebida.id, situacao: 'pago', dataPagamento: c.lancamento.data, valorPago: (-c.lancamento.valor).toFixed(2), baixa: { origem: 'extrato', lancamentoId: id } });
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
    sugestoes: registros.filter((r) => r.status === 'pendente').length,
    semNota: registros.filter((r) => r.status === 'sem_nota').length,
  };
}

/** Confirma manualmente o casamento de um lançamento com uma nota. */
export function confirmarLancamento({ store, lancamentoId, notaId, recebidaId }) {
  const l = store.lancamentos.obter(lancamentoId);
  if (recebidaId) {
    const r = store.recebidas.obter(recebidaId);
    if (!l || !r) throw Object.assign(new Error('Lançamento ou nota recebida não encontrado'), { statusHttp: 400 });
    store.recebidas.salvar({ id: r.id, situacao: 'pago', dataPagamento: l.data, valorPago: Math.abs(l.valor).toFixed(2), baixa: { origem: 'extrato', lancamentoId: l.id } });
    return store.lancamentos.salvar({ id: l.id, recebidaId: r.id, status: 'conciliado' });
  }
  const n = store.notas.obter(notaId);
  if (!l || !n) throw Object.assign(new Error('Lançamento ou nota não encontrado'), { statusHttp: 400 });
  store.notas.salvar({ id: n.id, ...camposDaBaixa(n, { tipo: 'pago', dataPagamento: l.data, valorPago: l.valor, origem: 'extrato', lancamentoId: l.id }) });
  return store.lancamentos.salvar({ id: l.id, notaId: n.id, status: 'conciliado' });
}
