// API HTTP + interface web. Roda localmente: o certificado A1 nunca sai da máquina.
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { carregarConfig, aplicarEmitente, CAMPOS_EMITENTE } from './config.js';
import { criarStore } from './store.js';
import { criarEmissor } from './emissor.js';
import { consultarCep, consultarCnpj } from './consultas.js';
import { camposDaBaixa, situacaoDaNota, hojeBR, valorEsperado } from './financeiro.js';
import { extrairArquivos, lerArquivos, resolverLocais, importarDocumentos, sugerirAgendas } from './importacao.js';
import { importarPacote, exportarPacote } from './pacote.js';
import { cnpjValido, cpfValido } from './dps.js';
import { criarClienteAdn, sincronizarAdn } from './adn.js';
import { processarExtrato, confirmarLancamento } from './conciliacao.js';
import { listarModelos, gerarMensagem, VARIAVEIS, MODELOS_PADRAO } from './mensagens.js';
import { FREQUENCIAS, ocorrencias, emitirDaAgenda, executarVencidas } from './agenda.js';

const erro400 = (msg) => Object.assign(new Error(msg), { statusHttp: 400 });

export function criarApp({ config = carregarConfig(), store, emissor } = {}) {
  store ??= criarStore(config.dataDir);
  aplicarEmitente(config, store.emitente.obter());
  emissor ??= criarEmissor({ config, store });
  const app = express();
  app.use(express.json({ limit: '60mb' }));
  app.use(express.static(path.join(config.root, 'public')));

  const rota = (fn) => async (req, res) => {
    try {
      res.json(await fn(req, res));
    } catch (e) {
      res.status(e.erros || e.statusHttp === 400 ? 400 : 500).json({ erro: e.message, erros: e.erros ?? [] });
    }
  };
  // Nota com a situação financeira calculada (atraso depende do dia)
  const comSituacao = (n) => ({ ...n, situacaoAtual: situacaoDaNota(n), valorAPagar: valorEsperado(n).toFixed(2) });

  // ---------- Status e emitente ----------
  app.get('/api/status', rota(() => ({
    ambiente: config.ambiente,
    sefinUrl: config.sefinUrl,
    prestador: config.prestador,
    servicoPadrao: config.servicoPadrao,
    cobranca: config.cobranca,
    serie: config.serie,
    proximoNDPS: store.dps.proximo(config.serie),
    certificado: emissor.statusCertificado(),
    ultimoNsuAdn: store.estado.obter('adn_ultimo_nsu', 0),
  })));

  app.put('/api/emitente', rota((req) => {
    const atual = store.emitente.obter();
    const novo = { ...atual };
    for (const k of CAMPOS_EMITENTE) if (req.body[k] !== undefined) novo[k] = typeof req.body[k] === 'object' ? { ...atual[k], ...req.body[k] } : req.body[k];
    store.emitente.salvar(novo);
    aplicarEmitente(config, novo);
    return { ok: true };
  }));

  // ---------- Clientes ----------
  app.get('/api/clientes', rota(() => {
    const notas = store.notas.listar();
    return store.clientes.listar().map((c) => {
      const minhas = notas.filter((n) => n.clienteId === c.id && n.status === 'autorizada');
      const abertas = minhas.filter((n) => ['aguardando', 'atrasada'].includes(situacaoDaNota(n)));
      return {
        ...c,
        resumo: {
          notas: minhas.length,
          faturado: minhas.filter((n) => !['cancelada', 'substituida'].includes(n.situacao)).reduce((s, n) => s + Number(n.valor), 0),
          emAberto: abertas.reduce((s, n) => s + valorEsperado(n), 0),
          atrasadas: abertas.filter((n) => situacaoDaNota(n) === 'atrasada').length,
          ultimaNota: minhas[0]?.dataEmissao ?? null,
        },
      };
    });
  }));
  // O CPF/CNPJ é a chave do cliente: nunca dois cadastros para o mesmo documento
  app.post('/api/clientes', rota((req) => {
    const { resumo, ...cliente } = req.body;
    const doc = String(cliente.documento ?? '').replace(/\D/g, '');
    if (!(doc.length === 14 ? cnpjValido(doc) : doc.length === 11 && cpfValido(doc))) throw erro400('CPF/CNPJ inválido');
    const existente = store.clientes.porDocumento(doc);
    if (existente && existente.id !== cliente.id) throw erro400(`Já existe um cliente com este CPF/CNPJ: ${existente.nome}`);
    return store.clientes.salvar(cliente);
  }));
  app.delete('/api/clientes/:id', rota((req) => (store.clientes.remover(req.params.id), { ok: true })));

  app.get('/api/consulta/cnpj/:cnpj', rota(async (req) => (await consultarCnpj(req.params.cnpj)) ?? {}));
  app.get('/api/consulta/cep/:cep', rota(async (req) => (await consultarCep(req.params.cep)) ?? {}));

  // ---------- Emissão ----------
  // Conferência: monta a DPS e devolve o XML e o resumo, sem enviar
  app.post('/api/notas/preparar', rota((req) => emissor.preparar(req.body)));
  // Emissão real (exige confirmado: true) ou simulada (simular: true)
  app.post('/api/notas', rota(async (req) => comSituacao(await emissor.emitir(req.body))));
  app.post('/api/notas/:id/verificar', rota(async (req) => comSituacao(await emissor.verificar(req.params.id))));

  // ---------- Controle de notas ----------
  app.get('/api/notas', rota(() => store.notas.listar().map(comSituacao)));

  // Baixa (pago, cancelada, substituída, ou "aguardando" para desfazer) e campos de controle
  app.patch('/api/notas/:id', rota((req) => {
    const nota = store.notas.obter(req.params.id);
    if (!nota) throw erro400('Nota não encontrada');
    const { baixa, observacoes, dataEnvio, vencimento } = req.body;
    const campos = {};
    if (baixa) Object.assign(campos, camposDaBaixa(nota, baixa));
    if (observacoes !== undefined) campos.observacoes = String(observacoes);
    if (dataEnvio !== undefined) campos.dataEnvio = dataEnvio || null;
    if (vencimento !== undefined) campos.vencimento = vencimento || null;
    return comSituacao(store.notas.salvar({ id: nota.id, ...campos }));
  }));

  app.get('/api/notas/:id/mensagem', rota((req) => {
    const nota = store.notas.obter(req.params.id);
    if (!nota) throw erro400('Nota não encontrada');
    return gerarMensagem({ store, config, nota, modeloId: req.query.modelo });
  }));

  app.get('/api/notas/:id/xml/:tipo', (req, res) => {
    const nota = store.notas.obter(req.params.id);
    const nome = { nfse: nota?.nfseXml, dps: nota?.dpsXml, pdf: nota?.danfsePdf }[req.params.tipo];
    if (!nome || !fs.existsSync(store.xml.caminho(nome))) return res.status(404).json({ erro: 'XML não disponível' });
    res.download(store.xml.caminho(nome), nome);
  });

  // ---------- Importação do histórico ----------
  app.post('/api/importar/arquivos', rota(async (req) => {
    const arquivos = extrairArquivos(req.body.arquivos ?? []);
    if (!arquivos.length) throw erro400('Nenhuma NFS-e encontrada nos arquivos (envie .xml, .pdf do DANFSe ou .zip)');
    const { lidos, erros } = await lerArquivos(arquivos);
    await resolverLocais(lidos);
    return importar({ lidos, erros }, req.body.opcoes);
  }));

  // Pacote JSON com emitente, clientes, notas e agenda (backup ou carga inicial preparada)
  app.post('/api/importar/pacote', rota((req) => {
    const r = importarPacote({ store, config, pacote: req.body });
    aplicarEmitente(config, store.emitente.obter());
    return r;
  }));
  app.get('/api/backup', (req, res) => {
    res.setHeader('Content-Disposition', `attachment; filename="nfse-backup-${hojeBR()}.json"`);
    res.json(exportarPacote({ store }));
  });

  app.post('/api/importar/adn', rota(async (req) => {
    const adn = criarClienteAdn({ baseUrl: config.adnUrl, cert: emissor.certificado() });
    const { documentos, ultimoNsu } = await sincronizarAdn({ adn, store, cnpj: config.prestador.cnpj });
    const r = importar({ documentos }, req.body?.opcoes);
    store.estado.definir('adn_ultimo_nsu', ultimoNsu);
    return { ...r, documentos: documentos.length, ultimoNsu };
  }));

  function importar(entrada, opcoes) {
    const r = importarDocumentos({ store, config, ...entrada, opcoes });
    // Completa o emitente com o que veio da nota (só os campos ainda vazios)
    if (r.emitente) {
      const e = r.emitente;
      const atual = store.emitente.obter();
      const p = { ...(atual.prestador ?? {}) };
      if (!config.prestador.email && e.email) p.email = e.email;
      if (!config.prestador.fone && e.fone) p.fone = e.fone;
      if (e.nomeFantasia && !config.prestador.nomeFantasia) p.nomeFantasia = e.nomeFantasia;
      // A razão social da nota é a oficial (cadastro na Receita)
      if (e.nome && e.nome !== config.prestador.razaoSocial) p.razaoSocial = e.nome;
      if (!config.prestador.endereco?.cep && e.endereco?.cep) p.endereco = { ...config.prestador.endereco, ...e.endereco };
      store.emitente.salvar({ ...atual, prestador: p });
      aplicarEmitente(config, { prestador: p });
    }
    return r;
  }

  // ---------- Conciliação bancária ----------
  app.post('/api/extrato', rota((req) => {
    const { nome, conteudo } = req.body;
    if (!conteudo) throw erro400('Arquivo vazio');
    return processarExtrato({ store, texto: conteudo, nome });
  }));
  app.get('/api/extrato', rota(() => store.lancamentos.listar().sort((a, b) => b.data.localeCompare(a.data))));
  app.post('/api/extrato/:id/conciliar', rota((req) => confirmarLancamento({ store, lancamentoId: req.params.id, notaId: req.body.notaId })));
  app.post('/api/extrato/:id/ignorar', rota((req) => store.lancamentos.salvar({ id: req.params.id, status: 'ignorado' })));

  // ---------- Modelos de mensagem ----------
  app.get('/api/modelos', rota(() => ({ modelos: listarModelos(store), variaveis: VARIAVEIS })));
  app.post('/api/modelos', rota((req) => {
    const { id, nome, tipo, assunto, corpo } = req.body;
    if (!nome?.trim() || !corpo?.trim()) throw erro400('Nome e texto do modelo são obrigatórios');
    return store.modelos.salvar({ id: id || undefined, nome, tipo: tipo || 'outro', assunto: assunto ?? '', corpo });
  }));
  app.delete('/api/modelos/:id', rota((req) => {
    store.modelos.remover(req.params.id);
    return { ok: true, restauradoPadrao: MODELOS_PADRAO.some((m) => m.id === req.params.id) };
  }));
  // Pré-visualização de um texto com os dados de uma nota (ou do cliente, sem nota)
  app.post('/api/modelos/previa', rota((req) => {
    const nota = req.body.notaId ? store.notas.obter(req.body.notaId) : null;
    const base = nota ?? {
      tomador: {},
      clienteId: req.body.clienteId,
      valor: '0',
    };
    const temp = { id: '__previa__', nome: 'prévia', assunto: req.body.assunto ?? '', corpo: req.body.corpo ?? '' };
    const r = gerarMensagem({ store: { ...store, modelos: { listar: () => [temp] } }, config, nota: base, modeloId: '__previa__' });
    return { assunto: r.assunto, corpo: r.corpo };
  }));

  // ---------- Planejamento ----------
  app.get('/api/agendas', rota((req) => {
    const hoje = hojeBR();
    const ate = req.query.ate || new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10);
    return {
      ambiente: config.ambiente,
      frequencias: Object.fromEntries(Object.entries(FREQUENCIAS).map(([k, v]) => [k, v.nome])),
      agendas: store.agendas.listar().map((a) => ({
        ...a,
        cliente: store.clientes.obter(a.clienteId)?.nome ?? '(cliente removido)',
        proximas: a.ativo ? ocorrencias(a, '0000-01-01', ate) : [],
        // Vencida e esperando o usuário (lembrete, ou automática fora de produção)
        vencida: a.ativo && a.proximaData && a.proximaData <= hoje && (a.modo !== 'automatico' || config.ambiente !== 'producao'),
      })),
      sugestoes: sugerirAgendas(store),
    };
  }));
  app.post('/api/agendas', rota((req) => {
    const a = req.body;
    if (!a.clienteId || !store.clientes.obter(a.clienteId)) throw erro400('Escolha o cliente');
    if (!FREQUENCIAS[a.frequencia]) throw erro400('Frequência inválida');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(a.proximaData ?? '')) throw erro400('Informe a data da próxima emissão');
    if (!(Number(String(a.valor).replace(/\./g, '').replace(',', '.')) > 0)) throw erro400('Informe o valor');
    if (!a.descricao?.trim()) throw erro400('Informe a descrição');
    return store.agendas.salvar({
      id: a.id || undefined,
      clienteId: a.clienteId,
      descricao: a.descricao,
      valor: a.valor,
      frequencia: a.frequencia,
      proximaData: a.proximaData,
      diaMes: a.diaMes || Number(a.proximaData.slice(8, 10)),
      fim: a.fim || null,
      competencia: a.competencia || 'emissao',
      modo: a.modo === 'automatico' ? 'automatico' : 'lembrete',
      ativo: a.ativo !== false,
      pausadaPorErro: false,
      erro: null,
    });
  }));
  app.delete('/api/agendas/:id', rota((req) => (store.agendas.remover(req.params.id), { ok: true })));
  // Emitir agora a ocorrência pendente (o clique do usuário é a confirmação)
  app.post('/api/agendas/:id/emitir', rota(async (req) => {
    const agenda = store.agendas.obter(req.params.id);
    if (!agenda) throw erro400('Agenda não encontrada');
    const { simular, descricao, valor } = req.body ?? {};
    return comSituacao(await emitirDaAgenda({ agenda, config, store, emissor, simular: !!simular, ajustes: { descricao, valor } }));
  }));

  // Ajuste manual do contador (ex.: continuar a numeração já usada no portal)
  app.put('/api/dps/proximo', rota((req) => {
    const n = Number(req.body.proximo);
    if (!Number.isInteger(n) || n < 1) throw erro400('Número inválido');
    store.dps.definir(config.serie, n);
    return { proximo: n };
  }));

  app.locals.ctx = { config, store, emissor };
  return app;
}

/** Verifica a agenda a cada 15 minutos e emite as notas automáticas vencidas. */
export function iniciarAgendador({ config, store, emissor }, intervaloMs = 15 * 60_000) {
  let rodando = false;
  const tick = async () => {
    if (rodando) return;
    rodando = true;
    try {
      await executarVencidas({ config, store, emissor });
    } finally {
      rodando = false;
    }
  };
  setTimeout(tick, 5_000);
  return setInterval(tick, intervaloMs);
}

// pathToFileURL: no Windows o argv vem como C:\... e a URL do módulo como file:///C:/...
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = carregarConfig();
  const app = criarApp({ config });
  iniciarAgendador(app.locals.ctx);
  app.listen(config.porta, '127.0.0.1', () => {
    console.log(`NFS-e BH rodando em http://localhost:${config.porta}  (ambiente: ${config.ambiente})`);
  });
}
