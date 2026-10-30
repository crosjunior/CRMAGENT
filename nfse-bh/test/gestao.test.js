import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { criarStore } from '../src/store.js';
import { carregarConfig } from '../src/config.js';
import { montarDps } from '../src/dps.js';
import { lerDocumentoFiscal, importarDocumentos, extrairXmls } from '../src/importacao.js';
import { lerExtrato, conciliar, processarExtrato, semelhancaNome, numeroBR } from '../src/conciliacao.js';
import { calcularVencimento, situacaoDaNota, camposDaBaixa } from '../src/financeiro.js';
import { avancar, ocorrencias, competenciaPara, emitirDaAgenda, executarVencidas } from '../src/agenda.js';
import { gerarMensagem, renderizar, contexto } from '../src/mensagens.js';
import { servicoDoCliente } from '../src/emissor.js';

const novoStore = () => criarStore(fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-g-')));
const config = () => {
  const c = carregarConfig();
  c.cobranca = { ...c.cobranca, pix: '29.978.652/0001-87', prazoDias: 10 };
  return c;
};

// NFS-e no leiaute nacional, embrulhando uma DPS real montada pela aplicação
function nfseXml({ numero, data, tomador, valor, descricao, retido = false, chave }) {
  const cfg = config();
  const dps = montarDps({
    config: cfg,
    tomador,
    servico: { descricao, valor, competencia: data, issRetido: retido },
    nDPS: Number(numero),
    agora: new Date(`${data}T15:00:00Z`),
  }).xml.replace(/^<\?xml[^>]*>/, '');
  const vLiq = retido ? (Number(valor) * 0.97).toFixed(2) : Number(valor).toFixed(2);
  return `<?xml version="1.0" encoding="UTF-8"?><NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${chave}">
<xLocEmi>Belo Horizonte</xLocEmi><xLocPrestacao>Belo Horizonte</xLocPrestacao><nNFSe>${numero}</nNFSe><xTribNac>Instrução</xTribNac>
<verAplic>SefinNac</verAplic><ambGer>2</ambGer><tpEmis>1</tpEmis><cStat>100</cStat><dhProc>${data}T10:00:00-03:00</dhProc><nDFSe>1</nDFSe>
<emit><CNPJ>29978652000187</CNPJ><IM>10733590010</IM><xNome>CARLOS ROBERTO OLIVEIRA DA SILVA JUNIOR</xNome><xFant>CONEXAO AGIL</xFant>
<enderNac><xLgr>Rua Exemplo</xLgr><nro>10</nro><xBairro>Savassi</xBairro><cMun>3106200</cMun><UF>MG</UF><CEP>30140000</CEP></enderNac>
<fone>31900000000</fone><email>contato@conexaoagil.com.br</email></emit>
<valores><vLiq>${vLiq}</vLiq></valores>${dps}</infNFSe></NFSe>`;
}

const ACME = { documento: '11444777000161', nome: 'ACME TREINAMENTOS LTDA', email: 'fin@acme.com.br', endereco: { cep: '30130010', cMun: '3106200', logradouro: 'Av. Afonso Pena', numero: '1000', bairro: 'Centro' } };
const BETA = { documento: '11222333000181', nome: 'BETA CONSULTORIA S/A', email: 'contas@beta.com' };
const chave = (n) => `310620022${'29978652000187'}${String(n).padStart(13, '0')}2610123456789`;

test('lê NFS-e e evento de cancelamento', () => {
  const n = lerDocumentoFiscal(nfseXml({ numero: 12, data: '2026-08-05', tomador: ACME, valor: '1860', descricao: 'Mentoria', chave: chave(12) }));
  assert.equal(n.tipo, 'nfse');
  assert.equal(n.numero, '12');
  assert.equal(n.chaveAcesso, chave(12));
  assert.equal(n.tomador.documento, ACME.documento);
  assert.equal(n.tomador.endereco.cMun, '3106200');
  assert.equal(n.prestador.nomeFantasia, 'CONEXAO AGIL');
  assert.equal(n.valor, '1860.00');
  assert.equal(n.cTribNac, '080201');
  const ev = lerDocumentoFiscal(`<evento xmlns="http://www.sped.fazenda.gov.br/nfse"><infEvento><pedRegEvento><infPedReg><chNFSe>${chave(12)}</chNFSe><e101101><xDesc>Cancelamento</xDesc></e101101></infPedReg></pedRegEvento></infEvento></evento>`);
  assert.deepEqual([ev.tipo, ev.efeito, ev.chaveAcesso], ['evento', 'cancelada', chave(12)]);
});

test('importa histórico: clientes com configurações próprias, notas sem duplicar, ZIP e evento', () => {
  const store = novoStore();
  const cfg = config();
  const xmls = [
    nfseXml({ numero: 1, data: '2026-01-10', tomador: ACME, valor: '1500', descricao: 'Mentoria jan', chave: chave(1) }),
    nfseXml({ numero: 2, data: '2026-02-10', tomador: ACME, valor: '1860', descricao: 'Mentoria fev', chave: chave(2) }),
    nfseXml({ numero: 3, data: '2026-10-01', tomador: BETA, valor: '5000', descricao: 'Workshop OKR', retido: true, chave: chave(3) }),
  ];
  const zip = new AdmZip();
  xmls.slice(0, 2).forEach((x, i) => zip.addFile(`notas/n${i}.xml`, Buffer.from(x)));
  const docs = extrairXmls([
    { nome: 'portal.zip', base64: zip.toBuffer().toString('base64') },
    { nome: 'beta.xml', conteudo: xmls[2] },
  ]);
  assert.equal(docs.length, 3);

  const r = importarDocumentos({ store, config: cfg, documentos: docs, opcoes: { pagasAteDias: 60 } });
  assert.equal(r.notasNovas, 3);
  assert.equal(r.clientes, 2);
  assert.equal(r.emitente.email, 'contato@conexaoagil.com.br');

  const acme = store.clientes.porDocumento(ACME.documento);
  assert.equal(acme.descricaoPadrao, 'Mentoria fev'); // a nota mais recente define o padrão
  assert.equal(acme.valorPadrao, '1860.00');
  assert.equal(acme.endereco.cMun, '3106200');
  const beta = store.clientes.porDocumento(BETA.documento);
  assert.equal(beta.issRetido, true);
  assert.equal(beta.aliquotaIss, '3.00');

  const notaBeta = store.notas.porChave(chave(3));
  assert.equal(notaBeta.situacao, 'aguardando'); // recente: em aberto
  assert.equal(notaBeta.valorLiquido, '4850.00');
  assert.equal(store.notas.porChave(chave(1)).situacao, 'pago'); // antiga: histórico pago

  // Reimportar não duplica; evento cancela
  const ev = `<evento xmlns="http://www.sped.fazenda.gov.br/nfse"><infEvento><pedRegEvento><infPedReg><chNFSe>${chave(3)}</chNFSe><e101101/></infPedReg></pedRegEvento></infEvento></evento>`;
  const r2 = importarDocumentos({ store, config: cfg, documentos: [...docs, { nome: 'ev.xml', xml: ev }] });
  assert.equal(r2.notasNovas, 0);
  assert.equal(r2.notasExistentes, 3);
  assert.equal(r2.eventos, 1);
  assert.equal(store.notas.porChave(chave(3)).situacao, 'cancelada');
});

test('cliente com ISS retido gera DPS com retenção e alíquota', () => {
  const cfg = config();
  const s = servicoDoCliente({ issRetido: true, aliquotaIss: '3.00', cTribNac: '010101' }, { descricao: 'x', valor: '100' });
  const dps = montarDps({ config: cfg, tomador: BETA, servico: s, nDPS: 1 });
  assert.match(dps.xml, /<tpRetISSQN>2<\/tpRetISSQN><pAliq>3.00<\/pAliq>/);
  assert.match(dps.xml, /<cTribNac>010101<\/cTribNac>/);
});

test('vencimento, atraso e baixa', () => {
  assert.equal(calcularVencimento('2026-10-30', {}, { cobranca: { prazoDias: 10 } }), '2026-11-09');
  assert.equal(calcularVencimento('2026-10-05', { diaVencimento: 10 }, {}), '2026-10-10');
  assert.equal(calcularVencimento('2026-10-15', { diaVencimento: 10 }, {}), '2026-11-10');
  assert.equal(calcularVencimento('2026-01-31', { diaVencimento: 30 }, {}), '2026-02-28');
  const n = { status: 'autorizada', situacao: 'aguardando', vencimento: '2026-10-10', valor: '100.00' };
  assert.equal(situacaoDaNota(n, '2026-10-10'), 'aguardando');
  assert.equal(situacaoDaNota(n, '2026-10-11'), 'atrasada');
  assert.equal(situacaoDaNota({ ...n, status: 'rejeitada' }), null);
  const b = camposDaBaixa(n, { tipo: 'pago', dataPagamento: '2026-10-12' });
  assert.deepEqual([b.situacao, b.dataPagamento, b.valorPago], ['pago', '2026-10-12', '100.00']);
  assert.equal(camposDaBaixa(n, { tipo: 'aguardando' }).situacao, 'aguardando');
  assert.throws(() => camposDaBaixa(n, { tipo: 'xyz' }));
});

test('extrato: OFX, CSV (Inter/Itaú) e TXT', () => {
  const ofx = `OFXHEADER:100\n<OFX><BANKTRANLIST>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261015120000[-3:BRT]<TRNAMT>1860.00<FITID>abc1<MEMO>PIX RECEBIDO - ACME TREINAMENTOS LTDA</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261016<TRNAMT>-50.00<FITID>abc2<MEMO>TARIFA</STMTTRN></BANKTRANLIST></OFX>`;
  const o = lerExtrato(ofx, 'extrato.ofx');
  assert.deepEqual(o.map((l) => [l.data, l.valor, l.idBanco]), [['2026-10-15', 1860, 'abc1'], ['2026-10-16', -50, 'abc2']]);

  const inter = `Extrato Conta Corrente\nConta;123\n\nData Lançamento;Histórico;Descrição;Valor;Saldo\n15/10/2026;Pix recebido;"BETA CONSULTORIA S/A";4.850,00;10.000,00\n16/10/2026;Pix enviado;Fulano;-200,00;9.800,00`;
  const c = lerExtrato(inter, 'Extrato.csv');
  assert.deepEqual(c.map((l) => [l.data, l.valor]), [['2026-10-15', 4850], ['2026-10-16', -200]]);
  assert.match(c[0].descricao, /BETA CONSULTORIA/);

  const cd = lerExtrato('data,descricao,credito,debito\n2026-10-15,TED ACME,1860.00,\n2026-10-16,Aluguel,,900.00', 'x.csv');
  assert.deepEqual(cd.map((l) => l.valor), [1860, -900]);

  const txt = lerExtrato('15/10/2026  PIX RECEBIDO ACME TREINAMENTOS   1.860,00   5.000,00\n16/10/2026 TARIFA  -12,90  4.987,10', 'extrato.txt');
  assert.deepEqual(txt.map((l) => [l.data, l.valor]), [['2026-10-15', 1860], ['2026-10-16', -12.9]]);

  assert.equal(numeroBR('R$ 1.860,00 D'), -1860);
  assert.equal(numeroBR('(200,50)'), -200.5);
});

test('conciliação: nome/documento + valor dão baixa automática; ambíguo vira sugestão', () => {
  const clientes = [
    { id: 'a', nome: 'ACME TREINAMENTOS LTDA', documento: ACME.documento },
    { id: 'b', nome: 'BETA CONSULTORIA S/A', documento: BETA.documento },
    { id: 'c', nome: 'GAMA EDUCACAO', documento: '45723174000110' },
  ];
  const base = { status: 'autorizada', situacao: 'aguardando', dataEmissao: '2026-10-01', vencimento: '2026-10-11' };
  const notas = [
    { ...base, id: 'n1', clienteId: 'a', valor: '1860.00', tomador: { nome: clientes[0].nome } },
    { ...base, id: 'n2', clienteId: 'b', valor: '5000.00', valorLiquido: '4850.00', tomador: { nome: clientes[1].nome } },
    { ...base, id: 'n3', clienteId: 'c', valor: '700.00', tomador: { nome: 'GAMA EDUCACAO' } },
    { ...base, id: 'n4', clienteId: 'a', valor: '700.00', tomador: { nome: clientes[0].nome } },
  ];
  assert.ok(semelhancaNome('PIX RECEBIDO - Acme Treinamentos', clientes[0]) >= 0.5);
  assert.equal(semelhancaNome('PIX 11444777000161', clientes[0]), 1);
  assert.equal(semelhancaNome('PIX RECEBIDO FULANO', clientes[0]), 0);

  const r = conciliar({
    clientes,
    notas,
    lancamentos: [
      { data: '2026-10-15', valor: 1860, descricao: 'PIX RECEBIDO - ACME TREINAMENTOS LTDA' },
      { data: '2026-10-15', valor: 4850, descricao: 'TED 11222333000181 BETA' }, // líquido (ISS retido)
      { data: '2026-10-16', valor: 700, descricao: 'PIX RECEBIDO FULANO DE TAL' }, // dois candidatos, nome não bate
      { data: '2026-10-16', valor: 999, descricao: 'PIX ACME' },
      { data: '2026-09-01', valor: 1860, descricao: 'ACME' }, // antes da emissão: não casa
    ],
  });
  const porValor = Object.fromEntries(r.map((x) => [`${x.lancamento.valor}|${x.lancamento.data}`, x]));
  assert.equal(porValor['1860|2026-10-15'].tipo, 'automatico');
  assert.equal(porValor['1860|2026-10-15'].nota.id, 'n1');
  assert.equal(porValor['4850|2026-10-15'].nota.id, 'n2');
  assert.equal(porValor['700|2026-10-16'].tipo, 'sugestao');
  assert.equal(porValor['700|2026-10-16'].candidatos.length, 2);
  assert.equal(porValor['999|2026-10-16'].tipo, 'sem_nota');
  assert.equal(porValor['1860|2026-09-01'].tipo, 'sem_nota');
});

test('processar extrato baixa a nota e reimportar o mesmo arquivo não repete', () => {
  const store = novoStore();
  const cli = store.clientes.salvar({ ...ACME });
  const nota = store.notas.salvar({ status: 'autorizada', situacao: 'aguardando', clienteId: cli.id, valor: '1860.00', dataEmissao: '2026-10-01', vencimento: '2026-10-11', criadaEm: '2026-10-01', tomador: { nome: cli.nome, documento: cli.documento } });
  const ofx = '<OFX><STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261020<TRNAMT>1860.00<FITID>x1<MEMO>PIX ACME TREINAMENTOS</STMTTRN></OFX>';
  const r = processarExtrato({ store, texto: ofx, nome: 'a.ofx' });
  assert.equal(r.baixadas.length, 1);
  const paga = store.notas.obter(nota.id);
  assert.deepEqual([paga.situacao, paga.dataPagamento, paga.baixa.origem], ['pago', '2026-10-20', 'extrato']);
  const r2 = processarExtrato({ store, texto: ofx, nome: 'a.ofx' });
  assert.equal(r2.jaImportados, 1);
  assert.equal(r2.baixadas.length, 0);
});

test('agenda: datas, competência e emissão automática', async () => {
  assert.equal(avancar('2026-01-31', 'mensal', 31), '2026-02-28');
  assert.equal(avancar('2026-02-28', 'mensal', 31), '2026-03-31');
  assert.equal(avancar('2026-10-30', 'quinzenal'), '2026-11-13');
  assert.equal(avancar('2026-10-30', 'trimestral', 30), '2027-01-30');
  assert.equal(avancar('2026-10-30', 'unica'), null);
  assert.deepEqual(ocorrencias({ proximaData: '2026-11-05', frequencia: 'mensal', diaMes: 5 }, '2026-10-01', '2027-01-31'), ['2026-11-05', '2026-12-05', '2027-01-05']);
  assert.equal(competenciaPara('mes_anterior', '2026-11-05'), '2026-10-31');
  assert.equal(competenciaPara('emissao', '2026-11-05'), '2026-11-05');

  const store = novoStore();
  const cfg = config();
  const cli = store.clientes.salvar({ ...ACME });
  const pedidos = [];
  const emissor = {
    emitir: async (p) => {
      pedidos.push(p);
      return store.notas.salvar({ status: 'autorizada', ...p, criadaEm: 'x', dataEmissao: '2026-11-05' });
    },
  };
  store.agendas.salvar({ id: 'ag1', clienteId: cli.id, descricao: 'Mentoria – {{mesAnterior}}/{{ano}}', valor: '1860,00', frequencia: 'mensal', diaMes: 5, proximaData: '2026-11-05', competencia: 'mes_anterior', modo: 'automatico', ativo: true });
  store.agendas.salvar({ id: 'ag2', clienteId: cli.id, descricao: 'Lembrete', valor: '10', frequencia: 'mensal', proximaData: '2026-11-01', modo: 'lembrete', ativo: true });

  const r = await executarVencidas({ config: cfg, store, emissor, hoje: '2026-11-05', log: {} });
  assert.equal(r.emitidas.length, 1);
  assert.equal(r.lembretes.length, 1);
  assert.equal(pedidos[0].servico.descricao, 'Mentoria – outubro/2026');
  assert.equal(pedidos[0].servico.competencia, '2026-10-31');
  assert.equal(pedidos[0].confirmado, true);
  assert.equal(store.agendas.obter('ag1').proximaData, '2026-12-05');

  // Rejeição pausa a agenda e não avança a data
  const rejeitando = { emitir: async () => ({ id: 'z', status: 'rejeitada', mensagem: 'E0312' }) };
  await emitirDaAgenda({ agenda: store.agendas.obter('ag1'), config: cfg, store, emissor: rejeitando, hoje: '2026-12-05' });
  const ag = store.agendas.obter('ag1');
  assert.deepEqual([ag.proximaData, ag.pausadaPorErro, ag.erro], ['2026-12-05', true, 'E0312']);
});

test('mensagens: variáveis e escolha do modelo pela situação', () => {
  const store = novoStore();
  const cfg = config();
  const cli = store.clientes.salvar({ ...ACME, contatoNome: 'Marina', emailsCobranca: 'contas@acme.com.br' });
  const nota = { status: 'autorizada', situacao: 'aguardando', clienteId: cli.id, numero: '45', valor: '1860.00', dataEmissao: '2026-10-01', vencimento: '2026-10-11', competencia: '2026-10-01', chaveAcesso: 'X'.repeat(50), descricao: 'Mentoria', tomador: { nome: cli.nome } };
  const m = gerarMensagem({ store, config: cfg, nota, hoje: '2026-10-05' });
  assert.equal(m.modeloId, 'envio');
  assert.match(m.assunto, /NFS-e 45 – Conexão Ágil – 10\/2026/);
  assert.match(m.corpo, /Olá, Marina!/);
  assert.match(m.corpo, /R\$\s?1\.860,00/);
  assert.match(m.corpo, /PIX: 29\.978\.652\/0001-87/);
  assert.equal(m.para, 'contas@acme.com.br, fin@acme.com.br');
  const atrasada = gerarMensagem({ store, config: cfg, nota: { ...nota, dataEnvio: '2026-10-01' }, hoje: '2026-10-20' });
  assert.equal(atrasada.modeloId, 'cobranca');
  assert.match(atrasada.corpo, /\(9 dias\)/);
  assert.equal(renderizar('{{x}} {{cliente.nome}}', contexto({ config: cfg, cliente: cli })), '{{x}} ACME TREINAMENTOS LTDA');
  assert.doesNotMatch(m.corpo, /Agência:/);
  const comRodape = gerarMensagem({ store, config: cfg, nota: { ...nota, descricao: `Mentoria\n${cfg.servicoPadrao.descricaoRodape}` }, hoje: '2026-10-05' });
  assert.match(comRodape.corpo, /referente a:\nMentoria\n\nValor/); // agência não cadastrada: linha omitida
  assert.equal(renderizar('A\nConta: {{conta}}\nB', { conta: '' }), 'A\nB');
});
