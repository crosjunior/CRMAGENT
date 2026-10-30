// API HTTP + interface web. Roda localmente: o certificado A1 nunca sai da máquina.
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { carregarConfig } from './config.js';
import { criarStore } from './store.js';
import { criarEmissor } from './emissor.js';
import { consultarCep, consultarCnpj } from './consultas.js';

export function criarApp({ config = carregarConfig(), store, emissor } = {}) {
  store ??= criarStore(config.dataDir);
  emissor ??= criarEmissor({ config, store });
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(config.root, 'public')));

  const rota = (fn) => async (req, res) => {
    try {
      res.json(await fn(req, res));
    } catch (e) {
      res.status(e.erros || e.statusHttp === 400 ? 400 : 500).json({ erro: e.message, erros: e.erros ?? [] });
    }
  };

  app.get('/api/status', rota(() => ({
    ambiente: config.ambiente,
    sefinUrl: config.sefinUrl,
    prestador: config.prestador,
    servicoPadrao: config.servicoPadrao,
    serie: config.serie,
    proximoNDPS: store.dps.proximo(config.serie),
    certificado: emissor.statusCertificado(),
  })));

  app.get('/api/clientes', rota(() => store.clientes.listar()));
  app.post('/api/clientes', rota((req) => store.clientes.salvar(req.body)));
  app.delete('/api/clientes/:id', rota((req) => (store.clientes.remover(req.params.id), { ok: true })));

  app.get('/api/consulta/cnpj/:cnpj', rota(async (req) => (await consultarCnpj(req.params.cnpj)) ?? {}));
  app.get('/api/consulta/cep/:cep', rota(async (req) => (await consultarCep(req.params.cep)) ?? {}));

  // Conferência: monta a DPS e devolve o XML e o resumo, sem enviar
  app.post('/api/notas/preparar', rota((req) => emissor.preparar(req.body)));
  // Emissão real (exige confirmado: true) ou simulada (simular: true)
  app.post('/api/notas', rota((req) => emissor.emitir(req.body)));
  app.get('/api/notas', rota(() => store.notas.listar()));
  app.post('/api/notas/:id/verificar', rota((req) => emissor.verificar(req.params.id)));

  app.get('/api/notas/:id/xml/:tipo', (req, res) => {
    const nota = store.notas.obter(req.params.id);
    const nome = req.params.tipo === 'nfse' ? nota?.nfseXml : nota?.dpsXml;
    if (!nome || !fs.existsSync(store.xml.caminho(nome))) return res.status(404).json({ erro: 'XML não disponível' });
    res.download(store.xml.caminho(nome), nome);
  });

  // Ajuste manual do contador (ex.: continuar a numeração já usada no portal)
  app.put('/api/dps/proximo', rota((req) => {
    const n = Number(req.body.proximo);
    if (!Number.isInteger(n) || n < 1) throw Object.assign(new Error('Número inválido'), { statusHttp: 400 });
    store.dps.definir(config.serie, n);
    return { proximo: n };
  }));

  return app;
}

// pathToFileURL: no Windows o argv vem como C:\... e a URL do módulo como file:///C:/...
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = carregarConfig();
  criarApp({ config }).listen(config.porta, '127.0.0.1', () => {
    console.log(`NFS-e BH rodando em http://localhost:${config.porta}  (ambiente: ${config.ambiente})`);
  });
}
