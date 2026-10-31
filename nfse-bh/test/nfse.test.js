import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import tlsNode from 'node:tls';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { montarDps, idDps, formatarValor, cnpjValido, cpfValido, dataHoraBrasilia } from '../src/dps.js';
import { assinarDps, verificarAssinatura } from '../src/assinatura.js';
import { carregarCertificado } from '../src/certificado.js';
import { criarClienteSefin, ErroSefin } from '../src/sefin.js';
import { criarStore } from '../src/store.js';
import { criarEmissor } from '../src/emissor.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PFX = path.join(DIR, 'fixtures', 'teste.pfx');
// O XSD oficial escreve a série como '^0{0,4}\d{1,5}$'; em XSD '^' e '$' são literais, e o libxml recusaria
// qualquer série. A cópia usada no teste tira as âncoras, que é como a Sefin interpreta o padrão.
const XSD = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xsd-'));
  for (const f of fs.readdirSync(path.join(DIR, '..', 'schemas'))) {
    const t = fs.readFileSync(path.join(DIR, '..', 'schemas', f), 'utf8');
    fs.writeFileSync(path.join(dir, f), t.replace('pattern value="^0{0,4}\\d{1,5}$"', 'pattern value="0{0,4}\\d{1,5}"'));
  }
  return path.join(dir, 'DPS_v1.01.xsd');
})();

const config = (over = {}) => ({
  root: path.join(DIR, '..'),
  ambiente: 'homologacao',
  tpAmb: '2',
  sefinUrl: 'https://localhost',
  certificado: { pfxPath: PFX, senha: '1234' },
  prestador: { cnpj: '11222333000181', im: '10733590010', fone: '', email: '', opSimpNac: '3', regApTribSN: '1', regEspTrib: '0' },
  cLocEmi: '3106200',
  servicoPadrao: { cTribNac: '080201', cTribMun: '001', cNBS: '', cLocPrestacao: '3106200', pAliq: '', pTotTribSN: '6.00', descricaoRodape: '' },
  serie: '1',
  verAplic: 'nfse-bh 1.0',
  ...over,
});

const tomador = {
  documento: '11.444.777/0001-61',
  nome: 'Cliente & Filhos Ltda',
  email: 'financeiro@cliente.com.br',
  endereco: { cep: '30130-010', cMun: '3106200', logradouro: 'Av. Afonso Pena', numero: '1000', bairro: 'Centro' },
};
const servico = { descricao: 'Mentoria executiva\nPacote 4 sessões', valor: '1.860,00', competencia: '2026-10-01' };

function validarXsd(xml) {
  const tmp = path.join(os.tmpdir(), `dps-${process.pid}-${Math.random()}.xml`);
  fs.writeFileSync(tmp, xml);
  try {
    execFileSync('xmllint', ['--noout', '--schema', XSD, tmp], { stdio: 'pipe' });
  } catch (e) {
    throw new Error(String(e.stderr));
  } finally {
    fs.rmSync(tmp);
  }
}

test('utilitários de formato', () => {
  assert.equal(formatarValor('1.860,00'), '1860.00');
  assert.equal(formatarValor('R$ 2.500,5'), '2500.50');
  assert.equal(formatarValor(150), '150.00');
  assert.ok(cnpjValido('11.222.333/0001-81'));
  assert.ok(!cnpjValido('11.222.333/0001-82'));
  assert.ok(cpfValido('529.982.247-25'));
  assert.ok(!cpfValido('111.111.111-11'));
  assert.equal(dataHoraBrasilia(new Date('2026-10-30T15:04:05.123Z')), '2026-10-30T12:04:05-03:00');
  const id = idDps({ cLocEmi: '3106200', cnpj: '11222333000181', serie: '1', nDPS: 42 });
  assert.equal(id, 'DPS3106200211222333000181000010000000000000' + '42');
  assert.equal(id.length, 45);
});

test('DPS válida no XSD oficial 1.01 (sem e com assinatura)', () => {
  const dps = montarDps({ config: config(), tomador, servico, nDPS: 7 });
  assert.match(dps.xml, /^<\?xml version="1.0" encoding="UTF-8"\?><DPS xmlns/);
  assert.match(dps.xml, /<xNome>Cliente &amp; Filhos Ltda<\/xNome>/);
  assert.match(dps.xml, /<vServ>1860.00<\/vServ>/);
  assert.match(dps.xml, /<pTotTribSN>6.00<\/pTotTribSN>/);
  assert.doesNotMatch(dps.xml, /<prest>.*<xNome>.*<\/prest>/); // prestador emitente não leva nome
  validarXsd(dps.xml);

  const cert = carregarCertificado(PFX, '1234');
  assert.equal(cert.cnpj, '11222333000181');
  const assinada = assinarDps(dps.xml, dps.id, cert);
  assert.match(assinada, /<\/infDPS><Signature xmlns="http:\/\/www.w3.org\/2000\/09\/xmldsig#">/);
  validarXsd(assinada);
  assert.ok(verificarAssinatura(assinada, cert.certPem));
  assert.ok(!verificarAssinatura(assinada.replace('1860.00', '9860.00'), cert.certPem));
});

test('MEI usa indTotTrib e tomador sem endereço também valida', () => {
  const c = config({ prestador: { ...config().prestador, opSimpNac: '2' } });
  const dps = montarDps({ config: c, tomador: { documento: '52998224725', nome: 'Pessoa Física' }, servico, nDPS: 1 });
  assert.match(dps.xml, /<indTotTrib>0<\/indTotTrib>/);
  assert.doesNotMatch(dps.xml, /regApTribSN/);
  validarXsd(dps.xml);
});

test('entrada inválida é recusada com a lista de problemas', () => {
  assert.throws(
    () => montarDps({ config: config(), tomador: { documento: '123', nome: '' }, servico: { descricao: '', valor: '0' }, nDPS: 1 }),
    (e) => e.erros.length >= 3,
  );
  assert.throws(() => montarDps({ config: config(), tomador, servico: { ...servico, competencia: '2099-01-01' }, nDPS: 1 }), /E0015/);
});

function sefinFalsa(respostas) {
  const enviados = [];
  return {
    enviados,
    factory: () => ({
      async emitir(xml) {
        enviados.push(xml);
        const r = respostas.shift();
        if (r instanceof Error) throw r;
        return r;
      },
      consultarDps: async () => respostas.shift(),
      consultarNfse: async () => '<NFSe><nNFSe>99</nNFSe></NFSe>',
    }),
  };
}

test('emissão: autorizada avança a numeração; rejeitada não consome número', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-'));
  const store = criarStore(dir);
  const cli = store.clientes.salvar(tomador);
  const fake = sefinFalsa([
    new ErroSefin('rejeitada', { status: 400, erros: [{ codigo: 'E0312', descricao: 'Tomador inválido' }] }),
    { chaveAcesso: '31062002211222333000181000000000000126101234567890', nfseXml: '<NFSe><nNFSe>1</nNFSe><cVerif>ABC</cVerif></NFSe>' },
  ]);
  const emissor = criarEmissor({ config: config(), store, sefinFactory: fake.factory });

  await assert.rejects(emissor.emitir({ clienteId: cli.id, servico }), /confirmação/);

  const rej = await emissor.emitir({ clienteId: cli.id, servico, confirmado: true });
  assert.equal(rej.status, 'rejeitada');
  assert.equal(rej.erros[0].codigo, 'E0312');
  assert.equal(store.dps.proximo('1'), 1);

  const ok = await emissor.emitir({ clienteId: cli.id, servico, confirmado: true });
  assert.equal(ok.status, 'autorizada');
  assert.equal(ok.numero, '1');
  assert.equal(ok.nDPS, 1);
  assert.equal(store.dps.proximo('1'), 2);
  assert.ok(fs.existsSync(store.xml.caminho(ok.nfseXml)));
  assert.equal(fake.enviados.length, 2);
});

test('emissão: resultado incerto fica pendente, bloqueia a próxima e é resolvido pela consulta da DPS', async () => {
  const store = criarStore(fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-')));
  const fake = sefinFalsa([
    new ErroSefin('timeout', { incerto: true }),
    '31062002211222333000181000000000000126101234567890', // consultarDps encontra a nota
  ]);
  const emissor = criarEmissor({ config: config(), store, sefinFactory: fake.factory });
  const pend = await emissor.emitir({ tomador, servico, confirmado: true });
  assert.equal(pend.status, 'pendente');
  await assert.rejects(emissor.emitir({ tomador, servico, confirmado: true }), /resultado incerto/);
  const resolvida = await emissor.verificar(pend.id);
  assert.equal(resolvida.status, 'autorizada');
  assert.equal(resolvida.numero, '99');
  assert.equal(store.dps.proximo('1'), 2);
});

test('cliente Sefin: POST /nfse com mTLS, gzip+base64 e leitura de erros', async () => {
  const cert = carregarCertificado(PFX, '1234');
  let recebido;
  const tls = { key: fs.readFileSync(path.join(DIR, 'fixtures', 'servidor-key.pem')), cert: fs.readFileSync(path.join(DIR, 'fixtures', 'servidor-cert.pem')) };
  const server = https.createServer({ ...tls, requestCert: true, rejectUnauthorized: false }, (req, res) => {
    const partes = [];
    req.on('data', (c) => partes.push(c));
    req.on('end', () => {
      recebido = { url: req.url, clientCert: req.socket.getPeerCertificate()?.subject?.CN, body: JSON.parse(Buffer.concat(partes)) };
      const xml = zlib.gunzipSync(Buffer.from(recebido.body.dpsXmlGZipB64, 'base64')).toString();
      res.setHeader('Content-Type', 'application/json');
      if (xml.includes('<vServ>1.00</vServ>')) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ erros: [{ Codigo: 'E0001', Descricao: 'Valor baixo' }] }));
      }
      res.statusCode = 201;
      res.end(JSON.stringify({ chaveAcesso: 'X'.repeat(50), nfseXmlGZipB64: zlib.gzipSync('<NFSe/>').toString('base64') }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `https://localhost:${server.address().port}/SefinNacional`;
  const sefin = criarClienteSefin({ baseUrl, cert, ca: tls.cert });
  try {
    const r = await sefin.emitir('<?xml version="1.0"?><DPS><vServ>10.00</vServ></DPS>');
    assert.equal(r.chaveAcesso.length, 50);
    assert.equal(r.nfseXml, '<NFSe/>');
    assert.equal(recebido.url, '/SefinNacional/nfse');
    assert.equal(recebido.clientCert, 'EMPRESA TESTE LTDA:11222333000181');
    await assert.rejects(sefin.emitir('<DPS><vServ>1.00</vServ></DPS>'), (e) => e.erros[0].codigo === 'E0001' && !e.incerto);
  } finally {
    server.close();
  }
});

test('certificado A1 legado (RC2-40/3DES, comum na ICP-Brasil) funciona no mTLS da Sefin e do ADN', async () => {
  const LEGADO = path.join(DIR, 'fixtures', 'legado.pfx');
  // O TLS do Node (OpenSSL 3) recusa este .pfx direto; a aplicação usa a chave e o certificado em PEM
  assert.throws(() => tlsNode.createSecureContext({ pfx: fs.readFileSync(LEGADO), passphrase: '1234' }), /Unsupported PKCS12/);
  const cert = carregarCertificado(LEGADO, '1234');
  assert.equal(cert.cnpj, '11222333000181');

  const tls = { key: fs.readFileSync(path.join(DIR, 'fixtures', 'servidor-key.pem')), cert: fs.readFileSync(path.join(DIR, 'fixtures', 'servidor-cert.pem')) };
  const vistos = [];
  const server = https.createServer({ ...tls, requestCert: true, rejectUnauthorized: false }, (req, res) => {
    vistos.push([req.url, req.socket.getPeerCertificate()?.subject?.CN]);
    res.setHeader('Content-Type', 'application/json');
    if (req.url.includes('/DFe/')) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ StatusProcessamento: 'NENHUM_DOCUMENTO_LOCALIZADO', LoteDFe: [] }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `https://localhost:${server.address().port}`;
  try {
    const { criarClienteAdn } = await import('../src/adn.js');
    // O ADN usa o agente com a CA padrão; aqui confiamos no certificado do servidor de teste
    const adn = criarClienteAdn({ baseUrl: base, cert: { ...cert, tls: { ...cert.tls, ca: tls.cert } } });
    const r = await adn.lote(0, '11222333000181');
    assert.equal(r.docs.length, 0);
    const sefin = criarClienteSefin({ baseUrl: base, cert, ca: tls.cert });
    assert.equal(await sefin.consultarDps('DPS1'), null);
    assert.deepEqual(vistos.map((v) => v[1]), ['EMPRESA LEGADO LTDA:11222333000181', 'EMPRESA LEGADO LTDA:11222333000181']);
  } finally {
    server.close();
  }
});
