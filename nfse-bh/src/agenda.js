// Planejamento de emissões: notas programadas por data ou frequência, emitidas automaticamente
// (modo "automatico") ou listadas para emissão com um clique (modo "lembrete").
import { hojeBR } from './financeiro.js';
import { contexto, renderizar } from './mensagens.js';

export const FREQUENCIAS = {
  unica: { nome: 'Única', meses: 0, dias: 0 },
  semanal: { nome: 'Semanal', dias: 7 },
  quinzenal: { nome: 'Quinzenal', dias: 14 },
  mensal: { nome: 'Mensal', meses: 1 },
  bimestral: { nome: 'Bimestral', meses: 2 },
  trimestral: { nome: 'Trimestral', meses: 3 },
  quadrimestral: { nome: 'Quadrimestral', meses: 4 },
  semestral: { nome: 'Semestral', meses: 6 },
  anual: { nome: 'Anual', meses: 12 },
};

const iso = (d) => d.toISOString().slice(0, 10);

/** Próxima data após `data` na frequência; meses respeitam o dia fixo (31 vira o último dia do mês). */
export function avancar(data, frequencia, diaMes) {
  const f = FREQUENCIAS[frequencia];
  if (!f || frequencia === 'unica') return null;
  const d = new Date(`${data}T12:00:00Z`);
  if (f.dias) {
    d.setUTCDate(d.getUTCDate() + f.dias);
    return iso(d);
  }
  const dia = Number(diaMes) || d.getUTCDate();
  const alvo = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + f.meses, 1, 12));
  const ultimo = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  alvo.setUTCDate(Math.min(dia, ultimo));
  return iso(alvo);
}

/** Ocorrências da agenda de `de` até `ate` (inclusive), para o calendário. */
export function ocorrencias(agenda, de, ate, limite = 60) {
  const out = [];
  let d = agenda.proximaData;
  while (d && d <= ate && out.length < limite) {
    if (agenda.fim && d > agenda.fim) break;
    if (d >= de) out.push(d);
    d = avancar(d, agenda.frequencia, agenda.diaMes);
  }
  return out;
}

/** Competência da nota programada: data da emissão ou último dia do mês anterior. */
export function competenciaPara(regra, dataEmissao) {
  if (regra !== 'mes_anterior') return dataEmissao;
  const [a, m] = dataEmissao.split('-').map(Number);
  return iso(new Date(Date.UTC(a, m - 1, 0, 12)));
}

/** Pedido de emissão a partir da agenda (descrição aceita {{mes}}, {{mesAnterior}}, {{ano}}…). */
export function pedidoDaAgenda({ agenda, config, store, hoje }) {
  const cliente = store.clientes.obter(agenda.clienteId);
  if (!cliente) throw new Error('Cliente da agenda não existe mais');
  const ctx = contexto({ config, cliente, hoje });
  return {
    clienteId: cliente.id,
    origem: 'agenda',
    agendaId: agenda.id,
    // Parcela de contrato: o vencimento combinado com o cliente prevalece sobre a regra de prazo
    ...(agenda.vencimentoPrevisto && agenda.vencimentoPrevisto >= hoje ? { vencimento: agenda.vencimentoPrevisto } : {}),
    servico: {
      descricao: renderizar(agenda.descricao, ctx),
      valor: agenda.valor,
      competencia: competenciaPara(agenda.competencia, hoje),
    },
  };
}

/** Emite uma ocorrência da agenda e avança a próxima data (só se a nota foi gerada). */
export async function emitirDaAgenda({ agenda, config, store, emissor, hoje = hojeBR(), simular = false, ajustes = {} }) {
  const pedido = pedidoDaAgenda({ agenda, config, store, hoje });
  // Ajustes desta emissão (ex.: número do pedido de compra do mês), sem mudar a agenda
  if (ajustes.descricao) pedido.servico.descricao = ajustes.descricao;
  if (ajustes.valor) pedido.servico.valor = ajustes.valor;
  const nota = await emissor.emitir({ ...pedido, confirmado: true, simular });
  const ok = nota.status === 'autorizada' || nota.status === 'simulada';
  const prox = ok ? avancar(agenda.proximaData, agenda.frequencia, agenda.diaMes) : agenda.proximaData;
  const terminou = ok && (!prox || (agenda.fim && prox > agenda.fim));
  store.agendas.salvar({
    id: agenda.id,
    proximaData: terminou ? null : prox,
    ativo: terminou ? false : agenda.ativo,
    ultimaExecucao: new Date().toISOString(),
    // Rejeição pausa a agenda: sem isso, cada verificação tentaria de novo a mesma nota inválida
    erro: ok ? null : nota.mensagem || `Nota ${nota.status}`,
    pausadaPorErro: !ok && nota.status === 'rejeitada',
    historico: [...(agenda.historico ?? []), { data: hoje, notaId: nota.id, status: nota.status }].slice(-24),
  });
  return nota;
}

/** Agendas com data vencida: as automáticas são emitidas; as de lembrete ficam para o usuário. */
export async function executarVencidas({ config, store, emissor, hoje = hojeBR(), log = console }) {
  const vencidas = store.agendas.listar().filter((a) => a.ativo && !a.pausadaPorErro && a.proximaData && a.proximaData <= hoje);
  const emitidas = [];
  // Em homologação nada sai sozinho: a ocorrência consumida por uma nota de teste faria falta em produção
  const automaticas = config.ambiente === 'producao' ? vencidas.filter((x) => x.modo === 'automatico') : [];
  for (const a of automaticas) {
    try {
      const nota = await emitirDaAgenda({ agenda: a, config, store, emissor, hoje });
      emitidas.push(nota);
      log.info?.(`[agenda] ${a.id}: nota ${nota.status}`);
    } catch (e) {
      store.agendas.salvar({ id: a.id, erro: e.message, ultimaExecucao: new Date().toISOString() });
      log.error?.(`[agenda] ${a.id}: ${e.message}`);
    }
  }
  return { emitidas, lembretes: vencidas.filter((x) => !automaticas.includes(x)) };
}
