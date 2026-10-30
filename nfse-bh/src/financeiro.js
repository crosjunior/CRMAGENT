// Situação financeira das notas: vencimento, atraso e baixa (paga, cancelada, substituída).

/** Data de hoje (AAAA-MM-DD) no fuso de Brasília. */
export const hojeBR = (d = new Date()) => new Date(d.getTime() - 3 * 3600e3).toISOString().slice(0, 10);

const somarDias = (data, dias) => {
  const d = new Date(`${data}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
};

/** Vencimento: dia fixo do mês do cliente (próxima ocorrência após a emissão) ou emissão + prazo em dias. */
export function calcularVencimento(dataEmissao, cliente, config) {
  const dia = Number(cliente?.diaVencimento);
  if (dia >= 1 && dia <= 31) {
    let [a, m] = dataEmissao.split('-').map(Number);
    for (let i = 0; i < 3; i++) {
      const ultimo = new Date(Date.UTC(a, m, 0)).getUTCDate();
      const cand = `${a}-${String(m).padStart(2, '0')}-${String(Math.min(dia, ultimo)).padStart(2, '0')}`;
      if (cand > dataEmissao) return cand;
      m++;
      if (m > 12) [a, m] = [a + 1, 1];
    }
  }
  const prazo = Number(cliente?.prazoDias ?? config?.cobranca?.prazoDias ?? 10);
  return somarDias(dataEmissao, Number.isFinite(prazo) ? prazo : 10);
}

/** Notas que entram no controle financeiro (geradas na Sefin ou importadas). */
export const notaFiscalValida = (n) => n.status === 'autorizada';

/** Situação para exibição: aguardando | atrasada | pago | cancelada | substituida (null quando não se aplica). */
export function situacaoDaNota(nota, hoje = hojeBR()) {
  if (!notaFiscalValida(nota)) return null;
  const s = nota.situacao ?? 'aguardando';
  if (s === 'aguardando' && nota.vencimento && nota.vencimento < hoje) return 'atrasada';
  return s;
}

/** Valor que o cliente deve depositar: o líquido quando há retenção (ISS retido pelo tomador). */
export const valorEsperado = (n) => Number(n.valorLiquido ?? n.valor);

const TIPOS_BAIXA = ['aguardando', 'pago', 'cancelada', 'substituida'];

/** Aplica a baixa (ou desfaz, com tipo "aguardando") e devolve os campos alterados. */
export function camposDaBaixa(nota, { tipo, dataPagamento, valorPago, chaveSubstituta, origem = 'manual', lancamentoId }) {
  if (!TIPOS_BAIXA.includes(tipo)) throw Object.assign(new Error(`Tipo de baixa inválido: ${tipo}`), { statusHttp: 400 });
  if (tipo === 'aguardando') {
    return { situacao: 'aguardando', dataPagamento: null, valorPago: null, baixa: null };
  }
  const data = dataPagamento || hojeBR();
  return {
    situacao: tipo,
    dataPagamento: tipo === 'pago' ? data : nota.dataPagamento ?? null,
    valorPago: tipo === 'pago' ? Number(valorPago ?? valorEsperado(nota)).toFixed(2) : null,
    chaveSubstituta: tipo === 'substituida' ? chaveSubstituta ?? nota.chaveSubstituta ?? null : nota.chaveSubstituta ?? null,
    baixa: { tipo, data, origem, lancamentoId: lancamentoId ?? null, em: new Date().toISOString() },
  };
}
