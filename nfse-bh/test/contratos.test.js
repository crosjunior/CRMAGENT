import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { criarStore } from '../src/store.js';
import { carregarConfig } from '../src/config.js';
import { classificar, resumoFornecedores, enriquecerFornecedores } from '../src/fornecedores.js';
import { analisarPorRegras, analisarComIA, normalizarContrato, situacaoDoContrato, agendarParcelas, extrairTextos, ESQUEMA_CONTRATO, valorNumero, MODELO_IA } from '../src/contratos.js';
import { proximaBuscaPortal } from '../src/server.js';

const novoStore = () => criarStore(fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-c-')));
const EMPRESA = { nome: 'CONEXAO AGIL SOLUCOES EMPRESARIAIS LTDA', cnpj: '29978652000187' };
const recebida = (doc, nome, data, valor, descricao, cTribNac = '', extra = {}) => ({
  chaveAcesso: `${doc}${data}${valor}`, numero: '1', dataEmissao: data, valor: Number(valor).toFixed(2), valorLiquido: Number(valor).toFixed(2),
  fornecedor: { documento: doc, nome }, descricao, cTribNac, situacao: 'a_pagar', ...extra,
});

test('classificação de fornecedores por código de serviço, CNAE, descrição e nome', () => {
  assert.equal(classificar({ nome: 'CONTABIL EXEMPLO SERVICOS CONTABEIS LTDA', notas: [{ descricao: 'Honorários contábeis outubro', cTribNac: '171901' }] }).categoria, 'contabilidade');
  assert.equal(classificar({ nome: 'NUVEM EXEMPLO SERVICOS DE HOSPEDAGEM LTDA', notas: [{ descricao: 'Hospedagem cloud e servidores', cTribNac: '' }] }).categoria, 'nuvem');
  assert.equal(classificar({ nome: 'SOFTWARE EXEMPLO SISTEMAS LTDA', cnae: '6201501', cnaeDescricao: 'Desenvolvimento de programas de computador sob encomenda', notas: [{ descricao: 'Licença do sistema' }] }).categoria, 'tecnologia');
  const maria = classificar({ nome: 'MARIA EXEMPLO DA SILVA', cnae: '7319002', cnaeDescricao: 'Promoção de vendas', notas: [{ descricao: 'Gestão de redes sociais e criação de conteúdo' }] });
  assert.equal(maria.categoria, 'marketing');
  assert.match(maria.motivo, /CNAE 7319002/);
  assert.equal(classificar({ nome: 'FULANO DE TAL', notas: [{ descricao: 'serviço prestado' }] }).categoria, 'outros');
  // "ti" só conta como palavra inteira
  assert.notEqual(classificar({ nome: 'TIPOGRAFIA X', notas: [{ descricao: 'tipografia' }] }).categoria, 'tecnologia');
});

test('fornecedores: totais por mês, ano e categoria; categoria manual; CNAE pela Receita', async () => {
  const store = novoStore();
  store.recebidas.salvarVarios([
    recebida('12345678000195', 'CONTABIL EXEMPLO SERVICOS CONTABEIS LTDA', '2026-09-30', 606, 'Honorários contábeis setembro', '171901'),
    recebida('12345678000195', 'CONTABIL EXEMPLO SERVICOS CONTABEIS LTDA', '2026-10-28', 909, 'Honorários contábeis outubro', '171901'),
    recebida('12345678000195', 'CONTABIL EXEMPLO SERVICOS CONTABEIS LTDA', '2025-12-20', 500, 'Honorários dezembro', '171901'),
    recebida('98765432000198', 'JOAO EXEMPLO DE SOUZA', '2026-10-20', 160, 'Serviço prestado', ''),
    recebida('98765432000198', 'JOAO EXEMPLO DE SOUZA', '2026-10-27', 160, 'Serviço prestado', ''),
    recebida('13579246000101', 'NUVEM EXEMPLO SERVICOS DE HOSPEDAGEM LTDA', '2026-10-01', 0.01, 'AWS', '', { situacao: 'cancelada' }),
  ]);
  const consultas = [];
  const r0 = await enriquecerFornecedores({ store, pausaMs: 0, consultar: async (doc) => (consultas.push(doc), doc === '98765432000198' ? { cnae: '8599604', cnaeDescricao: 'Treinamento em desenvolvimento profissional e gerencial', nomeFantasia: 'JE TREINAMENTOS', endereco: { municipio: 'Belo Horizonte', uf: 'MG' } } : null) });
  assert.equal(consultas.length, 3);
  assert.equal(r0.consultados, 3);
  // segunda chamada não repete as já consultadas (o CNPJ sem retorno espera 7 dias)
  await enriquecerFornecedores({ store, pausaMs: 0, consultar: async (d) => (consultas.push(d), null) });
  assert.equal(consultas.length, 3);

  const r = resumoFornecedores({ store, ano: '2026' });
  assert.deepEqual(r.anos, ['2026', '2025']);
  const contab = r.fornecedores.find((f) => f.documento === '12345678000195');
  assert.deepEqual([contab.totalAno, contab.notasAno, contab.totalGeral, contab.categoria], [1515, 2, 2015, 'contabilidade']);
  assert.equal(contab.porMes[8], 606);
  assert.equal(contab.porMes[9], 909);
  assert.deepEqual(contab.porAno, { 2026: 1515, 2025: 500 });
  const joao = r.fornecedores.find((f) => f.documento === '98765432000198');
  assert.deepEqual([joao.categoria, joao.cnae, joao.nomeFantasia, joao.totalAno], ['educacao', '8599604', 'JE TREINAMENTOS', 320]);
  assert.equal(r.fornecedores.some((f) => f.documento === '13579246000101'), false); // só nota cancelada
  assert.equal(r.totais.ano, 1835);
  assert.equal(r.totais.porMes[9], 1229);
  assert.deepEqual(r.totais.porCategoria, { contabilidade: 1515, educacao: 320 });

  store.fornecedores.salvar({ id: '98765432000198', categoriaManual: 'administrativo' });
  const r2 = resumoFornecedores({ store, ano: '2026' });
  const a2 = r2.fornecedores.find((f) => f.documento === '98765432000198');
  assert.deepEqual([a2.categoria, a2.categoriaManual, a2.sugestao.categoria], ['administrativo', true, 'educacao']);
});

test('busca automática no portal a cada 15 dias', () => {
  const store = novoStore();
  assert.ok(new Date(proximaBuscaPortal(store)) <= new Date()); // nunca rodou: já
  store.estado.definir('adn_ultima_busca', { em: '2026-10-01T10:00:00.000Z' });
  assert.equal(proximaBuscaPortal(store), '2026-10-16T10:00:00.000Z');
});

const CONTRATO = `CONTRATO DE PRESTAÇÃO DE SERVIÇOS
CONTRATANTE: ALFA CONSULTORIA EXEMPLO LTDA, inscrita no CNPJ 24.681.357/0001-40.
CONTRATADA: CONEXAO AGIL SOLUCOES EMPRESARIAIS LTDA, CNPJ 29.978.652/0001-87.
CLÁUSULA 1 – OBJETO: Acompanhamento do Planejamento Estratégico 2027 com OKRs
CLÁUSULA 4 – PREÇO: O valor total é de R$ 51.000,00, pago em 6 parcelas mensais de R$ 8.500,00, a partir de janeiro de 2027.
Reajuste anual pelo IPCA. Multa de 2% por atraso.`;

test('contrato: leitura por regras extrai cliente, total, parcelas e datas', () => {
  const r = analisarPorRegras({ texto: CONTRATO, empresa: EMPRESA, hoje: '2026-10-31' });
  assert.equal(r.cliente.documento, '24681357000140');
  assert.match(r.cliente.nome, /ALFA CONSULTORIA EXEMPLO/);
  assert.equal(r.valorTotal, 51000);
  assert.equal(r.parcelas.length, 6);
  assert.deepEqual(r.parcelas.map((p) => p.valor), [8500, 8500, 8500, 8500, 8500, 8500]);
  assert.deepEqual([r.parcelas[0].emissao, r.parcelas[5].emissao], ['2027-01-10', '2027-06-10']);
  assert.equal(r.parcelas[0].vencimento, null); // o contrato de teste não fala em prazo
  const comPrazo = analisarPorRegras({ texto: CONTRATO.replace('janeiro de 2027.', 'janeiro de 2027, com vencimento 30 dias após a emissão.'), empresa: EMPRESA, hoje: '2026-10-31' });
  assert.equal(comPrazo.parcelas[0].vencimento, '2027-02-09');
  assert.match(r.objeto, /Planejamento Estratégico 2027/);
  assert.match(r.reajuste, /IPCA/);
  assert.equal(r.confianca, 'baixa');
});

test('contrato: leitura com IA monta a requisição certa e usa a resposta estruturada', async () => {
  const pdf = Buffer.from('%PDF-1.4 falso');
  let pedido;
  const resposta = {
    tipo: 'contrato', titulo: 'PE 2027', cliente: { documento: '24681357000140', nome: 'ALFA' }, objeto: 'Acompanhamento do PE 2027',
    dataAssinatura: '2026-12-15', dataInicio: '2027-01-01', dataFim: '2027-06-30', valorTotal: 51000, formaPagamento: '6x mensais',
    parcelas: [{ numero: 1, descricao: 'Parcela 1/6', valor: 8500, emissao: '2027-01-05', vencimento: '2027-01-15', regra: null }],
    recorrencia: null, reajuste: 'IPCA', multaAtraso: '2%', observacoes: null, confianca: 'alta', pendencias: [],
  };
  const cliente = { beta: { messages: { create: async (p) => ((pedido = p), { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(resposta) }] }) } } };
  const r = await analisarComIA({ documentos: [{ nome: 'c.pdf', tipo: 'pdf', buffer: pdf, texto: '' }, { nome: 'p.docx', tipo: 'docx', texto: 'Proposta' }], textoLivre: 'pagamento todo dia 15', empresa: EMPRESA, hoje: '2026-10-31', cliente });
  assert.deepEqual(r, resposta);
  assert.equal(pedido.model, MODELO_IA);
  assert.equal(pedido.model, 'claude-opus-5-5');
  assert.deepEqual([pedido.fallbacks, pedido.betas], ['default', ['server-side-fallback-2026-07-01']]);
  assert.equal(pedido.output_config.format.type, 'json_schema');
  assert.equal(pedido.messages[0].content[0].type, 'document');
  assert.equal(pedido.messages[0].content[0].source.data, pdf.toString('base64'));
  assert.match(pedido.messages[0].content[1].text, /Documento: p\.docx/);
  assert.match(pedido.messages[0].content[2].text, /todo dia 15/);
  assert.match(pedido.system, /Hoje é 2026-10-31/);

  const recusa = { beta: { messages: { create: async () => ({ stop_reason: 'refusal', content: [] }) } } };
  await assert.rejects(analisarComIA({ documentos: [], textoLivre: 'x', empresa: EMPRESA, cliente: recusa }), /não processou/);
});

test('esquema da IA é estrito (todo objeto fecha propriedades e exige todas)', () => {
  const verificar = (s, caminho) => {
    const tipos = [].concat(s.type);
    if (tipos.includes('object')) {
      assert.equal(s.additionalProperties, false, caminho);
      assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort(), caminho);
      for (const [k, v] of Object.entries(s.properties)) verificar(v, `${caminho}.${k}`);
    }
    if (s.items) verificar(s.items, `${caminho}[]`);
  };
  verificar(ESQUEMA_CONTRATO, 'contrato');
});

test('contrato: normalização, agendamento das parcelas e acompanhamento', () => {
  const store = novoStore();
  const config = carregarConfig();
  const cli = store.clientes.salvar({ documento: '24681357000140', nome: 'ALFA CONSULTORIA EXEMPLO LTDA' });
  assert.deepEqual([valorNumero('8.500,00'), valorNumero(8500.5), valorNumero('8500.50'), valorNumero('')], [8500, 8500.5, 8500.5, null]);
  const c = normalizarContrato({
    cliente: { documento: '24.681.357/0001-40', nome: 'ALFA' }, objeto: 'Acompanhamento do PE', valorTotal: '25.500,00',
    parcelas: [
      { numero: 2, valor: '8.500,00', emissao: '2026-11-05' },
      { numero: 1, valor: 8500, emissao: '2026-10-05', vencimento: '2026-10-20' },
      { numero: 3, valor: '8500', vencimento: '2026-12-20' },
    ],
  }, { cobranca: { prazoDias: 10 } });
  assert.equal(c.valorTotal, 25500);
  assert.deepEqual(c.parcelas.map((p) => [p.numero, p.emissao, p.vencimento]), [[1, '2026-10-05', '2026-10-20'], [2, '2026-11-05', '2026-11-15'], [3, '2026-12-10', '2026-12-20']]);
  const salvo = store.contratos.salvar({ ...c, clienteId: cli.id });

  const r = agendarParcelas({ store, contrato: salvo, hoje: '2026-10-31' });
  assert.equal(r.criadas, 3);
  const agendas = store.agendas.listar();
  assert.equal(agendas[0].proximaData, '2026-10-31'); // parcela de outubro atrasada: emitir já
  assert.deepEqual([agendas[1].proximaData, agendas[1].modo, agendas[1].frequencia, agendas[1].vencimentoPrevisto], ['2026-11-05', 'lembrete', 'unica', '2026-11-15']);
  assert.match(agendas[1].descricao, /Acompanhamento do PE – Parcela 2\/3 – R\$ \{\{valor\}\}/);
  assert.equal(agendarParcelas({ store, contrato: store.contratos.obter(salvo.id), hoje: '2026-10-31' }).criadas, 0); // não duplica

  // Parcela 1 faturada e paga; parcela 2 faturada; 3 agendada
  const contrato = store.contratos.obter(salvo.id);
  const notas = [
    { id: 'n1', agendaId: contrato.parcelas[0].agendaId, status: 'autorizada', situacao: 'pago', numero: '150' },
    { id: 'n2', agendaId: contrato.parcelas[1].agendaId, status: 'autorizada', situacao: 'aguardando', vencimento: '2026-11-15', numero: '151' },
  ];
  const s = situacaoDoContrato(contrato, { notas, agendas: store.agendas.listar(), hoje: '2026-11-10' });
  assert.deepEqual(s.parcelas.map((p) => p.situacao), ['paga', 'faturada', 'agendada']);
  assert.deepEqual([s.resumo.recebido, s.resumo.faturado, s.resumo.aFaturar], [8500, 17000, 8500]);
  assert.equal(s.parcelas[0].notaNumero, '150');
});

test('contrato: texto de DOCX e TXT', async () => {
  const zip = new AdmZip();
  zip.addFile('word/document.xml', Buffer.from('<w:document><w:body><w:p><w:r><w:t>CONTRATANTE: ACME</w:t></w:r></w:p><w:p><w:r><w:t>Valor R$ 1.000,00 &amp; condições</w:t></w:r></w:p></w:body></w:document>'));
  const docs = await extrairTextos([
    { nome: 'c.docx', base64: zip.toBuffer().toString('base64') },
    { nome: 'n.txt', base64: Buffer.from('6 parcelas').toString('base64') },
  ]);
  assert.equal(docs[0].texto, 'CONTRATANTE: ACME\nValor R$ 1.000,00 & condições');
  assert.equal(docs[1].texto, '6 parcelas');
  await assert.rejects(extrairTextos([{ nome: 'x.exe', base64: '' }]), /não suportado/);
});
