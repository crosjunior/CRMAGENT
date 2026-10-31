// Conciliação: notas relacionadas, retenções, notas presumidas pagas, pesquisa por mês e aprendizado. Dados fictícios.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { criarStore } from '../src/store.js';
import {
  lerExtrato, ehSaldo, processarExtrato, confirmarLancamento, ignorarLancamento, reabrirLancamento,
  reprocessarPendentes, pesquisarNotas, lerAprendizado, assinatura,
} from '../src/conciliacao.js';

const novoStore = () => criarStore(fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-c-')));
const ALFA = { documento: '11444777000161', nome: 'ALFA TECNOLOGIA LTDA' };
const BETA = { documento: '11222333000181', nome: 'BETA PARTICIPACOES S.A.' };

function cenario() {
  const store = novoStore();
  const alfa = store.clientes.salvar({ ...ALFA });
  const beta = store.clientes.salvar({ ...BETA });
  const nota = (cli, extra) => store.notas.salvar({ status: 'autorizada', situacao: 'aguardando', clienteId: cli.id, tomador: { nome: cli.nome, documento: cli.documento }, criadaEm: '2026-08-01', ...extra });
  return { store, alfa, beta, nota };
}
const ofx = (...t) => `<OFX>${t.map(([data, valor, memo], i) => `<STMTTRN><DTPOSTED>${data}<TRNAMT>${valor}<FITID>f${i}${data}<MEMO>${memo}</STMTTRN>`).join('')}</OFX>`;

test('linhas de saldo são ignoradas sempre', () => {
  assert.ok(ehSaldo('SALDO TOTAL DISPONÍVEL DIA'));
  assert.ok(ehSaldo('Saldo anterior'));
  assert.ok(!ehSaldo('PIX RECEBIDO SALDANHA CONSULTORIA'));
  const csv = 'Data;Descrição;Valor\n17/09/2026;SALDO TOTAL DISPONÍVEL DIA;27.199,01\n18/09/2026;PIX ALFA;100,00';
  assert.deepEqual(lerExtrato(csv, 'x.csv').map((l) => l.descricao), ['PIX ALFA']);
});

test('CNPJ formatado na descrição + valor exato: baixa automática, mesmo de nota do mês anterior', () => {
  const { store, alfa, nota } = cenario();
  const n = nota(alfa, { numero: '140', valor: '1800.00', dataEmissao: '2026-08-20' });
  const r = processarExtrato({ store, texto: ofx(['20260922', '1800.00', 'RECEBIMENTOS ALFA TECNOLOGIA LTDA 11.444.777/0001-61']), nome: 'a.ofx' });
  assert.equal(r.baixadas.length, 1);
  assert.equal(store.notas.obter(n.id).dataPagamento, '2026-09-22');
});

test('CNPJ + valor líquido de retenções: automático quando é a única nota em aberto do cliente', () => {
  const { store, alfa, nota } = cenario();
  const n = nota(alfa, { numero: '141', valor: '10000.00', dataEmissao: '2026-09-01' });
  const r = processarExtrato({ store, texto: ofx(['20260915', '9385.00', 'TED 11444777000161 ALFA']), nome: 'b.ofx' });
  assert.equal(r.baixadas.length, 1);
  assert.equal(store.notas.obter(n.id).valorPago, '9385.00');
});

test('nota marcada paga na importação (sem data de pagamento) ainda recebe o crédito', () => {
  const { store, alfa, nota } = cenario();
  const n = nota(alfa, { numero: '120', valor: '500.00', dataEmissao: '2026-07-01', situacao: 'pago' });
  processarExtrato({ store, texto: ofx(['20260710', '500.00', 'PIX ALFA TECNOLOGIA']), nome: 'c.ofx' });
  const paga = store.notas.obter(n.id);
  assert.deepEqual([paga.dataPagamento, paga.baixa.origem], ['2026-07-10', 'extrato']);
});

test('sem valor igual: notas do cliente aparecem como relacionadas, com os motivos', () => {
  const { store, alfa, beta, nota } = cenario();
  nota(alfa, { numero: '150', valor: '2500.00', dataEmissao: '2026-09-05' });
  nota(beta, { numero: '151', valor: '6101.00', dataEmissao: '2026-09-05' });
  processarExtrato({ store, texto: ofx(['20260921', '2000.00', 'RECEBIMENTOS ALFA TECNOLOGIA LTDA 11.444.777/0001-61']), nome: 'd.ofx' });
  const [l] = store.lancamentos.listar();
  assert.equal(l.status, 'pendente');
  assert.equal(l.sugestoes.length, 1);
  assert.ok(l.sugestoes[0].motivos.documento);
});

test('pesquisa por mês traz notas de outros meses, inclusive já pagas (marcadas)', () => {
  const { store, alfa, beta, nota } = cenario();
  nota(alfa, { numero: '130', valor: '700.00', dataEmissao: '2026-08-28' });
  nota(beta, { numero: '131', valor: '900.00', dataEmissao: '2026-08-10', situacao: 'pago', dataPagamento: '2026-08-20', baixa: { tipo: 'pago', origem: 'manual' } });
  nota(beta, { numero: '132', valor: '900.00', dataEmissao: '2026-09-02' });
  processarExtrato({ store, texto: ofx(['20260915', '640.00', 'PIX DESCONHECIDO']), nome: 'e.ofx' });
  const [l] = store.lancamentos.listar();
  const agosto = pesquisarNotas({ store, lancamentoId: l.id, mes: '2026-08' });
  assert.deepEqual(agosto.map((x) => x.numero), ['130', '131']); // aberta primeiro, paga por último
  assert.ok(agosto[1].jaConciliada);
  assert.deepEqual(pesquisarNotas({ store, lancamentoId: l.id, mes: '', q: 'beta' }).map((x) => x.numero).sort(), ['131', '132']);
});

test('aprende: ligar uma descrição a um cliente resolve sozinho os próximos', () => {
  const { store, alfa, nota } = cenario();
  const n1 = nota(alfa, { numero: '160', valor: '300.00', dataEmissao: '2026-09-01' });
  const n2 = nota(alfa, { numero: '161', valor: '300.00', dataEmissao: '2026-10-01' });
  // Descrição sem nome nem CNPJ do cliente: a primeira vez vira sugestão (só o valor bate)
  processarExtrato({ store, texto: ofx(['20260910', '300.00', 'PIX RECEBIDO JOAO DA SILVA SOCIO']), nome: 'f.ofx' });
  const [l1] = store.lancamentos.listar();
  assert.equal(l1.status, 'pendente');
  confirmarLancamento({ store, lancamentoId: l1.id, notaId: n1.id });
  assert.equal(lerAprendizado(store).vinculos[0].documento, ALFA.documento);
  // Mês seguinte, mesma descrição: automático
  const r = processarExtrato({ store, texto: ofx(['20261010', '300.00', 'PIX RECEBIDO JOAO DA SILVA SOCIO']), nome: 'g.ofx' });
  assert.equal(r.baixadas[0].notaId, n2.id);
});

test('aprende: "Não é nota" ignora os próximos com a mesma descrição; desfazer esquece', () => {
  const { store } = cenario();
  processarExtrato({ store, texto: ofx(['20260901', '50.00', 'RESGATE APLICACAO AUTOMATICA']), nome: 'h.ofx' });
  const [l] = store.lancamentos.listar();
  ignorarLancamento({ store, lancamentoId: l.id });
  const r = processarExtrato({ store, texto: ofx(['20261001', '80.00', 'RESGATE APLICACAO AUTOMATICA']), nome: 'i.ofx' });
  assert.equal(r.ignorados, 1);
  assert.equal(lerAprendizado(store).ignorar[0].assinatura, assinatura('RESGATE APLICACAO AUTOMATICA'));
  reabrirLancamento({ store, lancamentoId: l.id });
  assert.equal(lerAprendizado(store).ignorar.length, 0);
  assert.equal(store.lancamentos.obter(l.id).status, 'sem_nota');
});

test('nota importada depois resolve o pendente; desfazer reverte a baixa e não casa de novo sozinho', () => {
  const { store, beta, nota } = cenario();
  processarExtrato({ store, texto: ofx(['20260921', '8520.00', 'RECEBIMENTOS BETA PARTICIPACOES 11.222.333/0001-81']), nome: 'j.ofx' });
  const [l] = store.lancamentos.listar();
  assert.equal(l.status, 'sem_nota');
  const n = nota(beta, { numero: '170', valor: '8520.00', dataEmissao: '2026-08-30' });
  const rp = reprocessarPendentes({ store });
  assert.equal(rp.conciliados[0].notaId, n.id);
  assert.equal(store.notas.obter(n.id).situacao, 'pago');
  reabrirLancamento({ store, lancamentoId: l.id });
  assert.equal(store.notas.obter(n.id).situacao, 'aguardando');
  assert.equal(store.lancamentos.obter(l.id).status, 'pendente');
});
