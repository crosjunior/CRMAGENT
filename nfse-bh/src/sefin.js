// Cliente REST da Sefin Nacional (API do Emissor Nacional), com autenticação mTLS pelo certificado A1.
// POST /nfse  { dpsXmlGZipB64 }  →  { chaveAcesso, nfseXmlGZipB64, idDps, alertas } | { erros: [...] }
import https from 'node:https';
import zlib from 'node:zlib';

export const gzipB64 = (xml) => zlib.gzipSync(Buffer.from(xml, 'utf8')).toString('base64');
export const gunzipB64 = (b64) => zlib.gunzipSync(Buffer.from(b64, 'base64')).toString('utf8');

export class ErroSefin extends Error {
  constructor(mensagem, { status, erros = [], corpo, incerto = false } = {}) {
    super(mensagem);
    this.status = status;
    this.erros = erros;
    this.corpo = corpo;
    // incerto: a requisição pode ter chegado à Sefin (timeout/queda); conferir pela consulta da DPS antes de reenviar
    this.incerto = incerto;
  }
}

// A Sefin varia a caixa dos campos (Codigo/codigo, Descricao/descricao)
function normalizarErros(json) {
  const lista = json?.erros ?? json?.Erros ?? json?.erro ?? [];
  return (Array.isArray(lista) ? lista : [lista]).map((e) => ({
    codigo: e.Codigo ?? e.codigo ?? '',
    descricao: e.Descricao ?? e.descricao ?? e.mensagem ?? '',
    complemento: e.Complemento ?? e.complemento ?? '',
  }));
}

export function criarClienteSefin({ baseUrl, cert, timeoutMs = 60_000, ca }) {
  const agent = new https.Agent({ pfx: cert.pfx, passphrase: cert.senha, keepAlive: true, ...(ca ? { ca } : {}) });

  function requisitar(metodo, caminho, corpo) {
    const url = new URL(baseUrl.replace(/\/$/, '') + caminho);
    const payload = corpo === undefined ? undefined : JSON.stringify(corpo);
    return new Promise((resolve, reject) => {
      const req = https.request(
        url,
        {
          method: metodo,
          agent,
          headers: {
            Accept: 'application/json',
            ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          },
          timeout: timeoutMs,
        },
        (res) => {
          const partes = [];
          res.on('data', (c) => partes.push(c));
          res.on('end', () => {
            const texto = Buffer.concat(partes).toString('utf8');
            let json = null;
            try {
              json = texto ? JSON.parse(texto) : null;
            } catch {
              /* corpo não-JSON (página de erro do IIS, por exemplo) */
            }
            resolve({ status: res.statusCode, json, texto });
          });
        },
      );
      req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
      req.on('error', (e) => {
        // Antes de conectar não há dúvida; depois de enviar o corpo, a DPS pode ter sido processada
        const antesDeEnviar = ['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'ERR_TLS_CERT_ALTNAME_INVALID'].includes(e.code);
        reject(new ErroSefin(`Falha de comunicação com a Sefin: ${e.message}`, { incerto: metodo === 'POST' && !antesDeEnviar }));
      });
      if (payload) req.write(payload);
      req.end();
    });
  }

  return {
    /** Envia a DPS assinada e devolve a NFS-e gerada. */
    async emitir(dpsAssinada) {
      const r = await requisitar('POST', '/nfse', { dpsXmlGZipB64: gzipB64(dpsAssinada) });
      if ((r.status === 200 || r.status === 201) && r.json?.chaveAcesso) {
        return {
          chaveAcesso: r.json.chaveAcesso,
          idDps: r.json.idDps,
          dataHoraProcessamento: r.json.dataHoraProcessamento,
          alertas: normalizarErros({ erros: r.json.alertas ?? [] }),
          nfseXml: r.json.nfseXmlGZipB64 ? gunzipB64(r.json.nfseXmlGZipB64) : null,
        };
      }
      const erros = normalizarErros(r.json);
      const resumo = erros.length ? erros.map((e) => `${e.codigo} ${e.descricao}`.trim()).join(' | ') : r.texto.slice(0, 300);
      throw new ErroSefin(`NFS-e rejeitada (HTTP ${r.status}): ${resumo}`, {
        status: r.status,
        erros,
        corpo: r.json ?? r.texto,
        incerto: r.status >= 500,
      });
    },

    /** Chave de acesso da NFS-e gerada a partir de uma DPS (null se a DPS não virou nota). */
    async consultarDps(idDps) {
      const r = await requisitar('GET', `/dps/${idDps}`);
      if (r.status === 404) return null;
      if (r.status === 200) return r.json?.chaveAcesso ?? null;
      throw new ErroSefin(`Consulta da DPS falhou (HTTP ${r.status})`, { status: r.status, erros: normalizarErros(r.json) });
    },

    /** XML da NFS-e pela chave de acesso. */
    async consultarNfse(chave) {
      const r = await requisitar('GET', `/nfse/${chave}`);
      if (r.status === 200 && r.json?.nfseXmlGZipB64) return gunzipB64(r.json.nfseXmlGZipB64);
      throw new ErroSefin(`Consulta da NFS-e falhou (HTTP ${r.status})`, { status: r.status, erros: normalizarErros(r.json) });
    },

  };
}

/** Lê os campos principais do XML da NFS-e autorizada. */
export function resumirNfse(xml) {
  const pega = (t) => (xml.match(new RegExp(`<${t}>([^<]*)</${t}>`)) ?? [])[1] ?? null;
  return {
    numero: pega('nNFSe'),
    codigoVerificacao: pega('cVerif') ?? pega('cVerifNFSe'),
    dataEmissao: pega('dhProc') ?? pega('dhEmi'),
    valorLiquido: pega('vLiq'),
    valorIss: pega('vISSQN'),
  };
}
