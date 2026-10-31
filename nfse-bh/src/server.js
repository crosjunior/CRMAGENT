// API HTTP + interface web. Roda localmente: o certificado A1 nunca sai da máquina.
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { carregarConfig, aplicarEmitente, CAMPOS_EMITENTE } from './config.js';
import { criarStore } from './store.js';
import { criarEmissor } from './emissor.js';
import { consultarCep, consultarCnpj } from './consultas.js';
import { camposDaBaixa, situacaoDaNota, situacaoDaRecebida, hojeBR, valorEsperado } from './financeiro.js';
import { extrairArquivos, lerArquivos, resolverLocais, importarDocumentos, sugerirAgendas } from './importacao.js';
import { importarPacote, exportarPacote } from './pacote.js';
import { cnpjValido, cpfValido } from './dps.js';
import { criarClienteAdn, sincronizarAdn } from './adn.js';
import { processarExtrato, confirmarLancamento } from './conciliacao.js';
import { listarModelos, gerarMensagem, VARIAVEIS, MODELOS_PADRAO } from './mensagens.js';
import { FREQUENCIAS, ocorrencias, emitirDaAgenda, executarVencidas } from './agenda.js';
import { enriquecerFornecedores, resumoFornecedores, CATEGORIAS } from './fornecedores.js';
import { iaDisponivel, extrairTextos, analisarComIA, analisarPorRegras, normalizarContrato, situacaoDoContrato, agendarParcelas } from './contratos.js';

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
    ultimaBuscaPortal: store.estado.obter('adn_ultima_busca', null),
    proximaBuscaPortal: proximaBuscaPortal(store),
    leituraContratosIA: iaDisponivel(),
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

  /** Busca no portal (ADN): emitidas e recebidas. Usada pelo botão em Config e pela rotina de 15 dias. */
  async function buscarNoPortal({ ano, reiniciar, opcoes = {}, origem = 'manual' }) {
    const adn = criarClienteAdn({ baseUrl: config.adnUrl, cert: emissor.certificado() });
    const { documentos, ultimoNsu } = await sincronizarAdn({ adn, store, cnpj: config.prestador.cnpj, reiniciar: !!reiniciar });
    const r = importar({ documentos }, { ...opcoes, ...(ano ? { ano } : {}) });
    store.estado.definir('adn_ultimo_nsu', ultimoNsu);
    const resultado = { ...r, documentos: documentos.length, ultimoNsu };
    store.estado.definir('adn_ultima_busca', { em: new Date().toISOString(), origem, notasNovas: r.notasNovas, recebidasNovas: r.recebidasNovas, erros: r.erros.length });
    // Fornecedores novos ganham CNAE/classificação em segundo plano
    enriquecerFornecedores({ store, consultar: consultarCnpj }).catch(() => {});
    return resultado;
  }
  app.post('/api/importar/adn', rota(async (req) => {
    const { ano, reiniciar, opcoes } = req.body ?? {};
    return buscarNoPortal({ ano, reiniciar, opcoes });
  }));

  /**
   * Carga pela pasta importar/: pacotes .json e notas (.zip, .pdf, .xml) deixados lá são importados
   * e movidos para importar/processados/. Roda ao iniciar e pelo botão da tela.
   */
  async function importarPasta(pasta = path.join(config.root, 'importar')) {
    if (!fs.existsSync(pasta)) return null;
    const nomes = fs.readdirSync(pasta, { withFileTypes: true }).filter((d) => d.isFile() && /\.(json|zip|pdf|xml)$/i.test(d.name)).map((d) => d.name);
    if (!nomes.length) return null;
    const r = { arquivos: nomes, pacotes: [], notas: null, erros: [] };
    // Pacote primeiro (emitente, clientes, agenda); as notas em PDF/XML completam e anexam os arquivos
    for (const nome of nomes.filter((n) => /\.json$/i.test(n))) {
      try {
        r.pacotes.push(importarPacote({ store, config, pacote: JSON.parse(fs.readFileSync(path.join(pasta, nome), 'utf8').replace(/^\uFEFF/, '')) }));
      } catch (e) {
        r.erros.push(`${nome}: ${e.message}`);
      }
    }
    aplicarEmitente(config, store.emitente.obter());
    const notas = nomes.filter((n) => !/\.json$/i.test(n)).map((nome) => ({ nome, base64: fs.readFileSync(path.join(pasta, nome)).toString('base64') }));
    if (notas.length) {
      try {
        const { lidos, erros } = await lerArquivos(extrairArquivos(notas));
        await resolverLocais(lidos);
        r.notas = importar({ lidos, erros }, { pagasAteDias: 45 });
      } catch (e) {
        r.erros.push(e.message);
      }
    }
    const destino = path.join(pasta, 'processados');
    fs.mkdirSync(destino, { recursive: true });
    const carimbo = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    for (const nome of nomes) fs.renameSync(path.join(pasta, nome), path.join(destino, `${carimbo}_${nome}`));
    return r;
  }
  app.post('/api/importar/pasta', rota(async () => (await importarPasta()) ?? { arquivos: [] }));

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
  app.post('/api/extrato/:id/conciliar', rota((req) => confirmarLancamento({ store, lancamentoId: req.params.id, notaId: req.body.notaId, recebidaId: req.body.recebidaId })));

  // ---------- Contratos ----------
  const comSituacaoContrato = (c) => situacaoDoContrato(c, { notas: store.notas.listar(), agendas: store.agendas.listar() });
  app.get('/api/contratos', rota(() => store.contratos.listar().sort((a, b) => (b.criadoEm ?? '').localeCompare(a.criadoEm ?? '')).map(comSituacaoContrato)));

  // Lê os documentos e devolve o rascunho para revisão (não grava nada)
  app.post('/api/contratos/analisar', rota(async (req) => {
    const { arquivos = [], texto = '' } = req.body;
    if (!arquivos.length && !texto.trim()) throw erro400('Envie o contrato/proposta ou cole as informações');
    const documentos = await extrairTextos(arquivos);
    const empresa = { nome: config.prestador.razaoSocial, cnpj: config.prestador.cnpj };
    const textoTotal = [...documentos.map((d) => d.texto), texto].join('\n\n');
    let rascunho;
    let metodo = 'regras';
    let aviso = null;
    if (iaDisponivel()) {
      try {
        rascunho = await analisarComIA({ documentos, textoLivre: texto, empresa });
        metodo = 'ia';
      } catch (e) {
        aviso = `Leitura com IA indisponível (${e.message}); usada a leitura por regras.`;
      }
    }
    rascunho ??= analisarPorRegras({ texto: textoTotal, empresa });
    const cliente = rascunho.cliente?.documento ? store.clientes.porDocumento(rascunho.cliente.documento) : null;
    return {
      rascunho: normalizarContrato(rascunho, config),
      metodo,
      aviso,
      clienteExistente: cliente ? { id: cliente.id, nome: cliente.nome } : null,
      arquivos: documentos.map((d) => ({ nome: d.nome, caracteres: d.texto.length })),
    };
  }));

  // Grava (novo ou edição). Cliente novo é cadastrado pelo CNPJ (dados da Receita quando disponíveis)
  app.post('/api/contratos', rota(async (req) => {
    const { arquivos = [], agendar = false, ...dados } = req.body;
    const c = normalizarContrato(dados, config);
    const doc = c.cliente.documento;
    if (!(doc.length === 14 ? cnpjValido(doc) : doc.length === 11 && cpfValido(doc))) throw erro400('Informe o CNPJ/CPF do cliente (contratante)');
    if (!c.parcelas.length) throw erro400('Informe ao menos uma parcela');
    let cliente = store.clientes.porDocumento(doc);
    if (!cliente) {
      const receita = doc.length === 14 ? await consultarCnpj(doc).catch(() => null) : null;
      cliente = store.clientes.salvar({ documento: doc, nome: c.cliente.nome || receita?.nome || 'Cliente', ...(receita ? { email: receita.email, fone: receita.fone, endereco: receita.endereco, nomeFantasia: receita.nomeFantasia } : {}), origem: 'contrato' });
    }
    const salvo = store.contratos.salvar({ ...c, id: c.id || undefined, clienteId: cliente.id, cliente: { documento: doc, nome: cliente.nome }, criadoEm: c.criadoEm ?? new Date().toISOString(), atualizadoEm: new Date().toISOString() });
    // Arquivos originais ficam junto do contrato (data/contratos/<id>/)
    for (const a of arquivos) {
      const dir = path.join(config.dataDir, 'contratos', salvo.id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, path.basename(a.nome)), Buffer.from(a.base64, 'base64'));
    }
    if (arquivos.length) store.contratos.salvar({ id: salvo.id, arquivos: [...new Set([...(salvo.arquivos ?? []), ...arquivos.map((a) => path.basename(a.nome))])] });
    if (agendar) agendarParcelas({ store, contrato: store.contratos.obter(salvo.id) });
    return comSituacaoContrato(store.contratos.obter(salvo.id));
  }));
  app.post('/api/contratos/:id/agendar', rota((req) => {
    const c = store.contratos.obter(req.params.id);
    if (!c) throw erro400('Contrato não encontrado');
    return agendarParcelas({ store, contrato: c });
  }));
  app.delete('/api/contratos/:id', rota((req) => {
    const c = store.contratos.obter(req.params.id);
    if (!c) throw erro400('Contrato não encontrado');
    // Agendamentos ainda não emitidos do contrato saem junto
    for (const a of store.agendas.listar().filter((a) => a.contratoId === c.id && a.ativo)) store.agendas.remover(a.id);
    store.contratos.remover(c.id);
    return { ok: true };
  }));
  app.get('/api/contratos/:id/arquivo/:nome', (req, res) => {
    const f = path.join(config.dataDir, 'contratos', req.params.id, path.basename(req.params.nome));
    if (!fs.existsSync(f)) return res.status(404).json({ erro: 'Arquivo não encontrado' });
    res.download(f);
  });

  // ---------- Fornecedores ----------
  app.get('/api/fornecedores', rota((req) => resumoFornecedores({ store, ano: req.query.ano })));
  app.patch('/api/fornecedores/:doc', rota((req) => {
    const { categoria } = req.body;
    if (categoria && !CATEGORIAS[categoria]) throw erro400('Categoria inválida');
    // categoria vazia volta para a classificação automática
    return store.fornecedores.salvar({ id: req.params.doc, documento: req.params.doc, categoriaManual: categoria || null });
  }));
  app.post('/api/fornecedores/enriquecer', rota(() => enriquecerFornecedores({ store, consultar: consultarCnpj })));

  // ---------- Notas recebidas (contas a pagar) ----------
  const recebidaComSituacao = (r) => ({ ...r, situacaoAtual: situacaoDaRecebida(r), valorAPagar: Number(r.valorLiquido ?? r.valor).toFixed(2) });
  app.get('/api/recebidas', rota(() => store.recebidas.listar().sort((a, b) => b.dataEmissao.localeCompare(a.dataEmissao)).map(recebidaComSituacao)));
  app.patch('/api/recebidas/:id', rota((req) => {
    const r = store.recebidas.obter(req.params.id);
    if (!r) throw erro400('Nota recebida não encontrada');
    const { baixa, observacoes, vencimento } = req.body;
    const campos = {};
    if (baixa) {
      if (!['a_pagar', 'pago', 'cancelada'].includes(baixa.tipo)) throw erro400('Tipo de baixa inválido');
      Object.assign(campos, {
        situacao: baixa.tipo,
        dataPagamento: baixa.tipo === 'pago' ? baixa.dataPagamento || hojeBR() : null,
        valorPago: baixa.tipo === 'pago' ? Number(baixa.valorPago ?? r.valorLiquido ?? r.valor).toFixed(2) : null,
        baixa: baixa.tipo === 'a_pagar' ? null : { origem: 'manual', em: new Date().toISOString() },
      });
    }
    if (observacoes !== undefined) campos.observacoes = String(observacoes);
    if (vencimento !== undefined) campos.vencimento = vencimento || null;
    return recebidaComSituacao(store.recebidas.salvar({ id: r.id, ...campos }));
  }));
  app.get('/api/recebidas/:id/arquivo/:tipo', (req, res) => {
    const r = store.recebidas.obter(req.params.id);
    const nome = { xml: r?.nfseXml, pdf: r?.danfsePdf }[req.params.tipo];
    if (!nome || !fs.existsSync(store.xml.caminho(nome))) return res.status(404).json({ erro: 'Arquivo não disponível' });
    res.download(store.xml.caminho(nome), nome);
  });
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

  app.locals.ctx = { config, store, emissor, importarPasta, buscarNoPortal };
  return app;
}

/** Verifica a agenda a cada 15 minutos e emite as notas automáticas vencidas. */
export const INTERVALO_BUSCA_PORTAL_DIAS = 15;

/** Data (ISO) em que a busca automática no portal volta a rodar. */
export function proximaBuscaPortal(store) {
  const ultima = store.estado.obter('adn_ultima_busca', null)?.em;
  if (!ultima) return new Date().toISOString();
  return new Date(new Date(ultima).getTime() + INTERVALO_BUSCA_PORTAL_DIAS * 864e5).toISOString();
}

export function iniciarAgendador({ config, store, emissor, buscarNoPortal }, intervaloMs = 15 * 60_000) {
  let rodando = false;
  const tick = async () => {
    if (rodando) return;
    rodando = true;
    try {
      await executarVencidas({ config, store, emissor });
      // Busca automática no portal a cada 15 dias (só com certificado configurado)
      if (buscarNoPortal && emissor.statusCertificado().ok && new Date(proximaBuscaPortal(store)) <= new Date()) {
        const primeira = !store.estado.obter('adn_ultimo_nsu', 0);
        try {
          const r = await buscarNoPortal({
            // Primeira vez: o ano corrente inteiro; depois, só o que entrou no portal desde a última leitura
            ...(primeira ? { ano: String(new Date().getFullYear()), reiniciar: true } : {}),
            opcoes: { pagasAteDias: 45 },
            origem: 'automatica',
          });
          console.log(`[portal] busca automática: ${r.notasNovas} emitida(s) e ${r.recebidasNovas} recebida(s) nova(s)`);
        } catch (e) {
          // Registra a tentativa para não repetir a cada 15 minutos; tenta de novo no próximo ciclo
          store.estado.definir('adn_ultima_busca', { em: new Date().toISOString(), origem: 'automatica', erro: e.message });
          console.error(`[portal] busca automática falhou: ${e.message}`);
        }
      }
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
  const carga = await app.locals.ctx.importarPasta().catch((e) => ({ erros: [e.message] }));
  if (carga) {
    const p = (carga.pacotes ?? []).reduce((s, x) => ({ c: s.c + x.clientesNovos, n: s.n + x.notasNovas, a: s.a + x.agendas }), { c: 0, n: 0, a: 0 });
    console.log(`Pasta importar/: ${carga.arquivos?.length ?? 0} arquivo(s) — ${p.c} cliente(s) novo(s), ${p.n + (carga.notas?.notasNovas ?? 0)} nota(s), ${p.a} agendamento(s)`);
    for (const e of carga.erros ?? []) console.log(`  erro: ${e}`);
  }
  iniciarAgendador(app.locals.ctx);
  app.listen(config.porta, '127.0.0.1', () => {
    console.log(`NFS-e BH rodando em http://localhost:${config.porta}  (ambiente: ${config.ambiente})`);
  });
}
