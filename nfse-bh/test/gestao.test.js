import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { criarStore } from '../src/store.js';
import { carregarConfig } from '../src/config.js';
import { montarDps } from '../src/dps.js';
import { lerDocumentoFiscal, importarDocumentos, extrairArquivos, lerArquivos, resolverLocais, limparDescricao } from '../src/importacao.js';
import { lerDanfsePdf } from '../src/danfse.js';
import { importarPacote, exportarPacote } from '../src/pacote.js';
import { criarEmissor } from '../src/emissor.js';
import { lerExtrato, conciliar, processarExtrato, semelhancaNome, numeroBR } from '../src/conciliacao.js';
import { calcularVencimento, situacaoDaNota, camposDaBaixa } from '../src/financeiro.js';
import { avancar, ocorrencias, competenciaPara, emitirDaAgenda, executarVencidas } from '../src/agenda.js';
import { gerarMensagem, renderizar, contexto } from '../src/mensagens.js';
import { servicoDoCliente } from '../src/emissor.js';

const novoStore = () => criarStore(fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-g-')));
const config = () => {
  const c = carregarConfig();
  c.cobranca = { ...c.cobranca, pix: '29.978.652/0001-87', prazoDias: 10 };
  c.servicoPadrao = { ...c.servicoPadrao, descricaoRodape: 'Dados Bancários: ITAÚ | Ag: 0001 | CC: 12345-6' };
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
  const docs = extrairArquivos([
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

  // Em homologação, automáticas não saem sozinhas
  const h = await executarVencidas({ config: { ...cfg, ambiente: 'homologacao' }, store, emissor, hoje: '2026-11-05', log: {} });
  assert.deepEqual([h.emitidas.length, h.lembretes.length, pedidos.length], [0, 2, 0]);
  const r = await executarVencidas({ config: { ...cfg, ambiente: 'producao' }, store, emissor, hoje: '2026-11-05', log: {} });
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

// PDF mínimo com texto posicionado como no DANFSe v2.0 (rótulo e, 8pt abaixo, o valor)
function pdfDanfse(blocos) {
  const esc = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const ops = blocos.map(([x, y, s]) => `BT /F1 6 Tf ${x} ${y} Td (${esc(s)}) Tj ET`).join('\n');
  const stream = Buffer.from(ops, 'latin1');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  const partes = [Buffer.from('%PDF-1.4\n')];
  const offs = [];
  let pos = partes[0].length;
  objs.forEach((o, i) => {
    const corpo = o === null ? Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`), stream, Buffer.from('\nendstream')]) : Buffer.from(o, 'latin1');
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), corpo, Buffer.from('\nendobj\n')]);
    offs.push(pos);
    pos += b.length;
    partes.push(b);
  });
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF`;
  return Buffer.concat([...partes, Buffer.from(xref, 'latin1')]);
}

const CHAVE_PDF = '31062002229978652000187000000000013726101471865419';
const DANFSE = pdfDanfse([
  [270, 821, 'DANFSe v2.0'], [446, 809, 'Tipo de Ambiente: 1'],
  [12, 791, 'CHAVE DE ACESSO DA NFS-e'], [12, 783, CHAVE_PDF],
  [12, 771, 'NÚMERO DA NFS-e'], [12, 763, '137'], [156, 771, 'COMPETÊNCIA DA NFS-e'], [156, 763, '02/10/2026'],
  [301, 771, 'DATA E HORA DA EMISSÃO DA NFS-e'], [301, 763, '02/10/2026 11:31:15'],
  [12, 751, 'NÚMERO DA DPS'], [12, 743, '91'], [156, 751, 'SÉRIE DA DPS'], [156, 743, '70000'],
  [156, 730, 'SITUAÇÃO DA NFS-e'], [156, 722, 'NFS-e Gerada'],
  [12, 710, 'PRESTADOR / FORNECEDOR'], [156, 711, 'CNPJ / CPF / NIF'], [156, 703, '29.978.652/0001-87'],
  [301, 711, 'Indicador Municipal (Inscrição)'], [301, 703, '10733590010'], [446, 711, 'Telefone'], [446, 703, '(31) 90000-0000'],
  [12, 694, 'Nome / Nome Empresarial'], [12, 686, 'CONEXAO AGIL SOLUCOES EMPRESARIAIS LTDA'],
  [301, 694, 'Município / Sigla UF'], [301, 686, 'Belo Horizonte / MG'], [446, 694, 'Código IBGE / CEP'], [446, 686, '31.06200 / 30.140-000'],
  [12, 677, 'Endereço'], [12, 669, 'RUA EXEMPLO, 10, CENTRO'], [301, 677, 'E-mail'], [301, 669, 'contato@exemplo.com.br'],
  [12, 650, 'TOMADOR / ADQUIRENTE'], [156, 651, 'CNPJ / CPF / NIF'], [156, 643, '11.444.777/0001-61'],
  [301, 651, 'Indicador Municipal (Inscrição)'], [301, 643, '-'], [446, 651, 'Telefone'], [446, 643, '-'],
  [12, 634, 'Nome / Nome Empresarial'], [12, 626, 'ACME TREINAMENTOS LTDA'],
  [301, 634, 'Município / Sigla UF'], [301, 626, 'Belo Jardim / PE'], [446, 634, 'Código IBGE / CEP'], [446, 626, '26.01706 / 55.150-615'],
  [12, 617, 'Endereço'], [12, 609, 'RUA DIARIO, 195, SALA 2, CENTRO'], [301, 617, 'E-mail'], [301, 609, 'fin@acme.com.br'],
  [12, 580, 'SERVIÇO PRESTADO'], [156, 580, 'Código de Tributação Nacional/Municipal'], [156, 572, '08.02.01 / 001'],
  [301, 580, 'Código da NBS'], [301, 572, '1.2205.19.00'], [446, 580, 'Local da Prestação / Sigla UF / País'], [446, 572, 'Recife / PE / -'],
  [12, 555, 'Descrição do Serviço'], [12, 547, 'Planejamento Estratégico GPD | R$ 5.000,00 Dados Bancários: ITAÚ | PIX/CNPJ: 29978652000187 | Ag: 0637 | CC:'],
  [12, 540, '98352-9'],
  [12, 530, 'TRIBUTAÇÃO MUNICIPAL (ISSQN)'], [156, 512, 'Alíquota Aplicada'], [156, 504, '-'], [301, 512, 'Retenção do ISSQN'], [301, 504, 'Não Retido'],
  [156, 450, 'VALOR DA OPERAÇÃO / SERVIÇO'], [156, 442, 'R$ 5.000,00'], [156, 432, 'VALOR LÍQUIDO DA NFS-e'], [156, 424, 'R$ 5.000,00'],
]);

test('lê o DANFSe em PDF e importa com local da prestação, NBS e descrição limpa', async () => {
  const n = await lerDanfsePdf(DANFSE);
  assert.equal(n.tipo, 'nfse');
  assert.equal(n.chaveAcesso, CHAVE_PDF);
  assert.deepEqual([n.numero, n.dataEmissao, n.competencia, n.serie, n.ambiente], ['137', '2026-10-02', '2026-10-02', '70000', 'producao']);
  assert.equal(n.prestador.nome, 'CONEXAO AGIL SOLUCOES EMPRESARIAIS LTDA');
  assert.deepEqual([n.tomador.documento, n.tomador.nome, n.tomador.email], ['11444777000161', 'ACME TREINAMENTOS LTDA', 'fin@acme.com.br']);
  assert.deepEqual(n.tomador.endereco, { cep: '55150615', cMun: '2601706', municipio: 'Belo Jardim', uf: 'PE', logradouro: 'RUA DIARIO', numero: '195', complemento: 'SALA 2', bairro: 'CENTRO' });
  assert.deepEqual([n.cTribNac, n.cTribMun, n.cNBS, n.valor, n.issRetido], ['080201', '001', '122051900', '5000.00', false]);
  assert.match(n.descricao, /^Planejamento Estratégico GPD/);

  const arquivos = extrairArquivos([{ nome: 'nota.pdf', base64: DANFSE.toString('base64') }]);
  const { lidos } = await lerArquivos(arquivos);
  await resolverLocais(lidos, async (uf) => (uf === 'PE' ? [{ id: '2611606', nome: 'Recife' }] : []));
  assert.equal(lidos[0].cLocPrestacao, '2611606');

  const store = novoStore();
  const r = importarDocumentos({ store, config: config(), lidos });
  assert.equal(r.notasNovas, 1);
  const cli = store.clientes.porDocumento('11444777000161');
  assert.deepEqual([cli.cLocPrestacao, cli.cNBS, cli.localPrestacao], ['2611606', '122051900', 'Recife/PE']);
  assert.equal(cli.descricaoPadrao, 'Planejamento Estratégico GPD | R$ {{valor}}');
  assert.equal(store.notas.porChave(CHAVE_PDF).danfsePdf, `${CHAVE_PDF}-danfse.pdf`);
});

test('descrição: tira dados bancários e troca o valor por {{valor}}', () => {
  assert.equal(limparDescricao('Suporte OIA e IA Dados Bancários: ITAÚ | PIX/CNPJ: 29978652000187 | Ag: 0637 | CC: 98352-9 Valor: R$ 1.800,00'), 'Suporte OIA e IA Valor: R$ {{valor}}');
  assert.equal(limparDescricao('Acompanhamento 2026 R$ 8.500,00 Dados Bancários PIX/CNPJ: 29978652000187 Banco Itaú - 341| Agência: 0637 | Conta: 98352-9'), 'Acompanhamento 2026 R$ {{valor}}');
  assert.equal(limparDescricao('Workshop OKR'), 'Workshop OKR');
});

test('emissão: descrição com {{valor}}, {{MesAnterior}} e local da prestação do cliente', () => {
  const store = novoStore();
  const cfg = config();
  cfg.certificado = { pfxPath: fileURLToPath(new URL('./fixtures/teste.pfx', import.meta.url)), senha: '1234' };
  const cli = store.clientes.salvar({ ...ACME, cLocPrestacao: '2611606', cNBS: '122051900', descricaoPadrao: 'Mentoria {{MesAnterior}}/{{anoMesAnterior}} – R$ {{valor}}' });
  const emissor = criarEmissor({ config: cfg, store });
  const p = emissor.preparar({ clienteId: cli.id, servico: { descricao: cli.descricaoPadrao, valor: '1860' } });
  assert.match(p.resumo.descricao, /^Mentoria [A-Z][a-zç]+\/\d{4} – R\$ 1\.860,00$/);
  assert.match(p.xml, /<cLocPrestacao>2611606<\/cLocPrestacao>/);
  assert.match(p.xml, /<cNBS>122051900<\/cNBS>/);
});

test('pacote: clientes pelo CNPJ (sem duplicar), notas sem chave e agenda; reimportar não duplica', () => {
  const store = novoStore();
  const cfg = config();
  store.clientes.salvar({ ...ACME, email: 'antigo@acme.com.br' });
  const pacote = {
    emitente: { prestador: { razaoSocial: 'CONEXAO AGIL SOLUCOES EMPRESARIAIS LTDA', endereco: { cep: '30140000' } }, cobranca: { prazoDias: 30 } },
    clientes: [{ ...ACME, documento: '11.444.777/0001-61', email: 'novo@acme.com.br' }, { ...BETA }, { nome: 'Sem doc' }],
    notas: [
      { clienteDocumento: ACME.documento, dataEmissao: '2026-10-02', valor: '26900', descricao: 'x' },
      { clienteDocumento: BETA.documento, chaveAcesso: chave(9), numero: '9', dataEmissao: '2026-10-03', valor: '100' },
    ],
    agendas: [{ id: 'ag-acme', clienteDocumento: ACME.documento, descricao: 'Mensal', valor: '1.860,00', frequencia: 'mensal', proximaData: '2026-11-02', diaMes: 2, modo: 'automatico' }],
  };
  const r = importarPacote({ store, config: cfg, pacote });
  assert.deepEqual([r.clientesNovos, r.clientesAtualizados, r.notasNovas, r.agendas], [1, 1, 2, 1]);
  assert.equal(r.avisos.length, 1);
  assert.equal(store.clientes.listar().length, 2);
  assert.equal(store.clientes.porDocumento(ACME.documento).email, 'novo@acme.com.br');
  assert.equal(store.emitente.obter().cobranca.prazoDias, 30);

  const r2 = importarPacote({ store, config: cfg, pacote });
  assert.deepEqual([r2.clientesNovos, r2.notasNovas, r2.notasExistentes], [0, 0, 2]);
  assert.equal(store.agendas.listar().length, 1);
  assert.equal(store.clientes.listar().length, 2);

  // A nota sem chave é completada quando a NFS-e real é importada depois
  const xml = nfseXml({ numero: 140, data: '2026-10-02', tomador: ACME, valor: '26900', descricao: 'Formação', chave: chave(140) });
  const ri = importarDocumentos({ store, config: cfg, documentos: [{ nome: 'n.xml', xml }] });
  assert.equal(ri.notasNovas, 0);
  const completa = store.notas.listar().filter((n) => n.tomador.documento === ACME.documento);
  assert.equal(completa.length, 1);
  assert.equal(completa[0].numero, '140');

  // A mesma NFS-e vinda de outra fonte com chave diferente não duplica (número + cliente + data)
  const copia = nfseXml({ numero: 140, data: '2026-10-02', tomador: ACME, valor: '26900', descricao: 'Formação', chave: chave(941) });
  assert.equal(importarDocumentos({ store, config: cfg, documentos: [{ nome: 'c.xml', xml: copia }] }).notasNovas, 0);

  const backup = exportarPacote({ store });
  assert.equal(backup.agendas[0].clienteDocumento, ACME.documento);
  assert.equal(backup.notas.length, 2);
});

// NFS-e emitida por um fornecedor para a Conexão Ágil (tomadora)
function nfseRecebidaXml({ numero, data, fornecedor, valor, descricao, chave, retido = false }) {
  const vLiq = (Number(valor) * (retido ? 0.95 : 1)).toFixed(2);
  return `<?xml version="1.0" encoding="UTF-8"?><NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${chave}">
<nNFSe>${numero}</nNFSe><dhProc>${data}T09:00:00-03:00</dhProc>
<emit><CNPJ>${fornecedor.documento}</CNPJ><xNome>${fornecedor.nome}</xNome><enderNac><xLgr>Rua A</xLgr><nro>1</nro><xBairro>Centro</xBairro><cMun>3550308</cMun><UF>SP</UF><CEP>01001000</CEP></enderNac><email>nf@fornecedor.com</email></emit>
<valores><vLiq>${vLiq}</vLiq></valores>
<DPS versao="1.01"><infDPS Id="DPS1"><tpAmb>1</tpAmb><dhEmi>${data}T09:00:00-03:00</dhEmi><serie>1</serie><nDPS>${numero}</nDPS><dCompet>${data}</dCompet>
<prest><CNPJ>${fornecedor.documento}</CNPJ></prest><toma><CNPJ>29978652000187</CNPJ><xNome>CONEXAO AGIL SOLUCOES EMPRESARIAIS LTDA</xNome></toma>
<serv><cServ><cTribNac>010701</cTribNac><xDescServ>${descricao}</xDescServ></cServ></serv>
<valores><vServPrest><vServ>${valor}</vServ></vServPrest><trib><tribMun><tribISSQN>1</tribISSQN><tpRetISSQN>${retido ? 2 : 1}</tpRetISSQN></tribMun></trib></valores></infDPS></DPS></infNFSe></NFSe>`;
}
const FORNECEDOR = { documento: '45723174000110', nome: 'NUVEM SOFTWARE LTDA' };
const chaveF = (n) => `355030822${'45723174000110'}${String(n).padStart(13, '0')}2601123456789`;

test('notas recebidas (empresa tomadora) entram em contas a pagar; filtro por ano', () => {
  const store = novoStore();
  const cfg = config();
  const docs = [
    { nome: 'r1', xml: nfseRecebidaXml({ numero: 1, data: '2026-03-10', fornecedor: FORNECEDOR, valor: '350', descricao: 'Licença SaaS', chave: chaveF(1) }) },
    { nome: 'r2', xml: nfseRecebidaXml({ numero: 2, data: '2026-10-10', fornecedor: FORNECEDOR, valor: '1000', descricao: 'Consultoria', chave: chaveF(2), retido: true }) },
    { nome: 'r0', xml: nfseRecebidaXml({ numero: 9, data: '2025-12-20', fornecedor: FORNECEDOR, valor: '99', descricao: 'Ano passado', chave: chaveF(9) }) },
    { nome: 'e1', xml: nfseXml({ numero: 50, data: '2026-10-01', tomador: ACME, valor: '1860', descricao: 'Mentoria', chave: chave(50) }) },
  ];
  const r = importarDocumentos({ store, config: cfg, documentos: docs, opcoes: { ano: 2026 } });
  assert.deepEqual([r.notasNovas, r.recebidasNovas, r.foraDoPeriodo, r.ignorados], [1, 2, 1, 0]);
  assert.equal(store.clientes.listar().length, 1); // fornecedor não vira cliente
  const r2 = store.recebidas.porChave(chaveF(2));
  assert.deepEqual([r2.fornecedor.nome, r2.valor, r2.valorLiquido, r2.issRetido, r2.situacao], ['NUVEM SOFTWARE LTDA', '1000.00', '950.00', true, 'a_pagar']);

  // Reimportar não duplica; cancelamento do fornecedor é aplicado
  const ev = `<evento xmlns="http://www.sped.fazenda.gov.br/nfse"><infEvento><pedRegEvento><infPedReg><chNFSe>${chaveF(1)}</chNFSe><e101101/></infPedReg></pedRegEvento></infEvento></evento>`;
  const again = importarDocumentos({ store, config: cfg, documentos: [...docs, { nome: 'ev', xml: ev }], opcoes: { ano: 2026 } });
  assert.deepEqual([again.recebidasNovas, again.recebidasExistentes, again.eventos], [0, 2, 1]);
  assert.equal(store.recebidas.porChave(chaveF(1)).situacao, 'cancelada');
});

test('ADN: busca completa (reiniciar) traz emitidas e recebidas por NSU', async () => {
  const store = novoStore();
  store.estado.definir('adn_ultimo_nsu', 500);
  const lotes = {
    0: [{ nsu: 1, tipo: 'NFSE', xml: nfseXml({ numero: 60, data: '2026-02-01', tomador: ACME, valor: '100', descricao: 'x', chave: chave(60) }) },
        { nsu: 2, tipo: 'NFSE', xml: nfseRecebidaXml({ numero: 3, data: '2026-02-05', fornecedor: FORNECEDOR, valor: '200', descricao: 'y', chave: chaveF(3) }) }],
    2: [{ nsu: 3, tipo: 'DPS', xml: '<DPS/>' }],
    3: [],
  };
  const pedidos = [];
  const adn = { lote: async (nsu) => (pedidos.push(nsu), { docs: lotes[nsu] ?? [], erros: [] }) };
  const { sincronizarAdn } = await import('../src/adn.js');
  const s = await sincronizarAdn({ adn, store, cnpj: '29978652000187', reiniciar: true });
  assert.deepEqual(pedidos, [0, 2, 3]);
  assert.equal(s.ultimoNsu, 3);
  assert.equal(s.documentos.length, 2); // DPS é ignorada
  const r = importarDocumentos({ store, config: config(), documentos: s.documentos, opcoes: { ano: '2026' } });
  assert.deepEqual([r.notasNovas, r.recebidasNovas], [1, 1]);
});

test('extrato: débito com nome do fornecedor dá baixa na nota recebida', () => {
  const store = novoStore();
  importarDocumentos({ store, config: config(), documentos: [{ nome: 'r', xml: nfseRecebidaXml({ numero: 2, data: '2026-10-10', fornecedor: FORNECEDOR, valor: '1000', descricao: 'Consultoria', chave: chaveF(2), retido: true }) }] });
  const ofx = '<OFX><STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261020<TRNAMT>-950.00<FITID>d1<MEMO>PIX ENVIADO NUVEM SOFTWARE</STMTTRN><STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261021<TRNAMT>-12.90<FITID>d2<MEMO>TARIFA</STMTTRN></OFX>';
  const r = processarExtrato({ store, texto: ofx, nome: 'x.ofx' });
  assert.equal(r.pagas.length, 1);
  const paga = store.recebidas.porChave(chaveF(2));
  assert.deepEqual([paga.situacao, paga.dataPagamento, paga.valorPago], ['pago', '2026-10-20', '950.00']);
  assert.equal(store.lancamentos.listar().length, 1); // a tarifa não é guardada
});
