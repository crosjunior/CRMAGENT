// Distribuição de documentos do ADN (Ambiente de Dados Nacional): baixa, com o certificado da empresa,
// todas as NFS-e e eventos em que ela é parte, por NSU. É assim que o histórico do portal entra na aplicação.
import https from 'node:https';
import { gunzipB64 } from './sefin.js';

export function criarClienteAdn({ baseUrl, cert, timeoutMs = 60_000 }) {
  const agent = new https.Agent({ pfx: cert.pfx, passphrase: cert.senha, keepAlive: true });

  function get(caminho) {
    return new Promise((resolve, reject) => {
      const req = https.request(new URL(baseUrl.replace(/\/$/, '') + caminho), { agent, headers: { Accept: 'application/json' }, timeout: timeoutMs }, (res) => {
        const partes = [];
        res.on('data', (c) => partes.push(c));
        res.on('end', () => {
          const t = Buffer.concat(partes).toString('utf8');
          try {
            resolve({ status: res.statusCode, json: JSON.parse(t) });
          } catch {
            resolve({ status: res.statusCode, json: null, texto: t });
          }
        });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (e) => reject(new Error(`Falha de comunicação com o ADN: ${e.message}`)));
      req.end();
    });
  }

  return {
    /** Lote de documentos após o NSU informado. 400/404 com StatusProcessamento significam "nada novo". */
    async lote(ultimoNsu, cnpj) {
      const r = await get(`/DFe/${ultimoNsu}?lote=true${cnpj ? `&cnpjConsulta=${cnpj}` : ''}`);
      if (!r.json || typeof r.json.StatusProcessamento !== 'string') {
        throw new Error(`Resposta inesperada do ADN (HTTP ${r.status})`);
      }
      const erros = (r.json.Erros ?? []).map((e) => `${e.Codigo} ${e.Descricao}`);
      const docs = (r.json.LoteDFe ?? []).map((d) => ({
        nsu: Number(d.NSU),
        chaveAcesso: d.ChaveAcesso,
        tipo: d.TipoDocumento,
        xml: d.ArquivoXml ? gunzipB64(d.ArquivoXml) : null,
      }));
      return { docs, erros, status: r.json.StatusProcessamento };
    },
  };
}

/** Busca tudo desde o último NSU guardado, até esgotar (com limite de lotes por chamada). */
export async function sincronizarAdn({ adn, store, cnpj, maxLotes = 40 }) {
  let nsu = store.estado.obter('adn_ultimo_nsu', 0);
  const documentos = [];
  for (let i = 0; i < maxLotes; i++) {
    const { docs, erros } = await adn.lote(nsu, cnpj);
    if (!docs.length) {
      if (erros.length && !documentos.length && nsu === 0) throw new Error(`ADN: ${erros.join(' | ')}`);
      break;
    }
    for (const d of docs) if (d.xml && (d.tipo === 'NFSE' || d.tipo === 'EVENTO')) documentos.push({ nome: `NSU ${d.nsu}`, xml: d.xml });
    nsu = Math.max(nsu, ...docs.map((d) => d.nsu));
  }
  return { documentos, ultimoNsu: nsu };
}
