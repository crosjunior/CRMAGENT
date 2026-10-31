// Pacote de dados (JSON): backup completo ou carga inicial preparada. Clientes são casados pelo CPF/CNPJ,
// notas pela chave de acesso (ou cliente + data + valor, quando ainda não há chave) e agendas pelo id.
import crypto from 'node:crypto';
import { calcularVencimento } from './financeiro.js';

const soDigitos = (s) => String(s ?? '').replace(/\D/g, '');
const preenchidos = (o) => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== ''));

export function importarPacote({ store, config, pacote }) {
  if (!pacote || typeof pacote !== 'object') throw Object.assign(new Error('Pacote inválido'), { statusHttp: 400 });
  const r = { emitente: false, clientesNovos: 0, clientesAtualizados: 0, notasNovas: 0, notasExistentes: 0, agendas: 0, modelos: 0, avisos: [] };

  if (pacote.emitente) {
    const atual = store.emitente.obter();
    const novo = { ...atual };
    for (const k of ['prestador', 'servicoPadrao', 'cobranca']) {
      // O que o usuário já preencheu na tela prevalece; o pacote completa o que está vazio
      if (pacote.emitente[k]) novo[k] = { ...preenchidos(pacote.emitente[k]), ...preenchidos(atual[k]) };
    }
    if (pacote.emitente.prestador?.endereco) novo.prestador.endereco = { ...preenchidos(pacote.emitente.prestador.endereco), ...preenchidos(atual.prestador?.endereco) };
    store.emitente.salvar(novo);
    r.emitente = true;
  }

  for (const c of pacote.clientes ?? []) {
    const doc = soDigitos(c.documento);
    if (doc.length !== 11 && doc.length !== 14) {
      r.avisos.push(`Cliente sem CPF/CNPJ válido ignorado: ${c.nome}`);
      continue;
    }
    const existente = store.clientes.porDocumento(doc);
    const { id, resumo, ...dados } = c;
    store.clientes.salvar({ ...(existente ?? {}), ...preenchidos(dados), documento: doc, id: existente?.id });
    existente ? r.clientesAtualizados++ : r.clientesNovos++;
  }

  const notas = store.notas.listar();
  const novas = [];
  for (const n of pacote.notas ?? []) {
    const doc = soDigitos(n.clienteDocumento ?? n.tomador?.documento);
    const cliente = store.clientes.porDocumento(doc);
    if (!cliente) {
      r.avisos.push(`Nota de cliente não cadastrado ignorada: ${doc}`);
      continue;
    }
    const mesma = (x) =>
      (n.chaveAcesso && x.chaveAcesso === n.chaveAcesso) ||
      (x.tomador?.documento === doc && x.dataEmissao === n.dataEmissao && Number(x.valor) === Number(n.valor) && (!n.chaveAcesso || !x.chaveAcesso));
    if ([...notas, ...novas].some(mesma)) {
      r.notasExistentes++;
      continue;
    }
    const { clienteDocumento, ...dados } = n;
    novas.push({
      id: crypto.randomUUID(),
      criadaEm: new Date().toISOString(),
      origem: 'pacote',
      status: 'autorizada',
      situacao: 'aguardando',
      valorLiquido: n.valor,
      vencimento: n.vencimento ?? calcularVencimento(n.dataEmissao, cliente, config),
      dataEnvio: n.dataEmissao,
      observacoes: '',
      ...dados,
      valor: Number(n.valor).toFixed(2),
      clienteId: cliente.id,
      tomador: { documento: doc, nome: cliente.nome, email: cliente.email ?? '' },
    });
    r.notasNovas++;
  }
  if (novas.length) store.notas.salvarVarios(novas);

  for (const a of pacote.agendas ?? []) {
    const cliente = store.clientes.porDocumento(soDigitos(a.clienteDocumento));
    if (!cliente) {
      r.avisos.push(`Agenda de cliente não cadastrado ignorada: ${a.clienteDocumento}`);
      continue;
    }
    const { clienteDocumento, ...dados } = a;
    const existente = store.agendas.listar().find((x) => (a.id && x.id === a.id) || (x.clienteId === cliente.id && x.descricao === a.descricao && x.frequencia === a.frequencia));
    store.agendas.salvar({ ativo: true, competencia: 'emissao', modo: 'lembrete', ...existente, ...dados, id: existente?.id ?? a.id, clienteId: cliente.id });
    r.agendas++;
  }

  for (const n of pacote.recebidas ?? []) {
    if (n.chaveAcesso && !store.recebidas.porChave(n.chaveAcesso)) {
      store.recebidas.salvar({ ...n, id: undefined });
      r.recebidas = (r.recebidas ?? 0) + 1;
    }
  }

  for (const c of pacote.contratos ?? []) if (c.id && !store.contratos.obter(c.id)) store.contratos.salvar(c);
  for (const f of pacote.fornecedores ?? []) if (f.id) store.fornecedores.salvar(f);

  for (const m of pacote.modelos ?? []) {
    if (m.nome && m.corpo) {
      store.modelos.salvar(m);
      r.modelos++;
    }
  }
  return r;
}

/** Backup completo, com o CPF/CNPJ do cliente em cada nota e agenda (independe dos ids internos). */
export function exportarPacote({ store }) {
  const docPorId = new Map(store.clientes.listar().map((c) => [c.id, c.documento]));
  return {
    versao: 1,
    geradoEm: new Date().toISOString(),
    emitente: store.emitente.obter(),
    clientes: store.clientes.listar(),
    notas: store.notas.listar().map((n) => ({ ...n, clienteDocumento: docPorId.get(n.clienteId) ?? n.tomador?.documento })),
    agendas: store.agendas.listar().map((a) => ({ ...a, clienteDocumento: docPorId.get(a.clienteId) })),
    modelos: store.modelos.listar(),
    recebidas: store.recebidas.listar(),
    contratos: store.contratos.listar(),
    fornecedores: store.fornecedores.listar(),
  };
}
