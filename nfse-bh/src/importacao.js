// Importação das notas já emitidas (XML da NFS-e, avulso, em ZIP ou vindo do ADN): cria o histórico,
// cadastra os clientes com as configurações usadas em cada um e aplica cancelamentos/substituições.
import crypto from 'node:crypto';
import AdmZip from 'adm-zip';
import { DOMParser } from '@xmldom/xmldom';
import { calcularVencimento, hojeBR } from './financeiro.js';

const soDigitos = (s) => String(s ?? '').replace(/\D/g, '');

// Busca por nome local, ignorando namespace e prefixo
function filho(no, nome) {
  if (!no) return null;
  for (let c = no.firstChild; c; c = c.nextSibling) if (c.nodeType === 1 && c.localName === nome) return c;
  return null;
}
function caminho(no, ...nomes) {
  for (const n of nomes) no = filho(no, n);
  return no;
}
function descendente(no, nome) {
  if (!no) return null;
  const lista = no.getElementsByTagNameNS('*', nome);
  return lista.length ? lista[0] : null;
}
const texto = (no) => (no ? no.textContent.trim() : '');

function pessoa(no) {
  if (!no) return null;
  const end = filho(no, 'end') ?? filho(no, 'enderNac');
  const endNac = filho(end, 'endNac');
  return {
    documento: soDigitos(texto(filho(no, 'CNPJ')) || texto(filho(no, 'CPF'))),
    nome: texto(filho(no, 'xNome')),
    nomeFantasia: texto(filho(no, 'xFant')),
    im: texto(filho(no, 'IM')),
    email: texto(filho(no, 'email')),
    fone: soDigitos(texto(filho(no, 'fone'))),
    endereco: end
      ? {
          cep: soDigitos(texto(filho(endNac, 'CEP')) || texto(filho(end, 'CEP'))),
          cMun: texto(filho(endNac, 'cMun')) || texto(filho(end, 'cMun')),
          uf: texto(filho(end, 'UF')),
          logradouro: texto(filho(end, 'xLgr')),
          numero: texto(filho(end, 'nro')),
          complemento: texto(filho(end, 'xCpl')),
          bairro: texto(filho(end, 'xBairro')),
        }
      : null,
  };
}

/** Lê o XML de uma NFS-e (ou de um evento de cancelamento) e devolve os dados relevantes. */
export function lerDocumentoFiscal(xml) {
  const doc = new DOMParser({ onError: () => {} }).parseFromString(xml, 'text/xml');
  const raiz = doc.documentElement;
  if (!raiz) throw new Error('XML inválido');

  // Evento (cancelamento ou cancelamento por substituição)
  if (raiz.localName === 'evento' || raiz.localName === 'pedRegEvento') {
    const ch = texto(descendente(raiz, 'chNFSe'));
    const tipo = descendente(raiz, 'e101101') || descendente(raiz, 'e105102') ? (descendente(raiz, 'e105102') ? 'substituida' : 'cancelada') : null;
    if (!ch || !tipo) return { tipo: 'ignorado' };
    return { tipo: 'evento', chaveAcesso: ch, efeito: tipo, chaveSubstituta: texto(descendente(raiz, 'chSubstituta')) || null };
  }

  const inf = raiz.localName === 'infNFSe' ? raiz : descendente(raiz, 'infNFSe');
  if (!inf) return { tipo: 'ignorado' };
  const infDps = descendente(inf, 'infDPS');
  const cServ = caminho(infDps, 'serv', 'cServ');
  const tribMun = caminho(infDps, 'valores', 'trib', 'tribMun');
  const dhProc = texto(filho(inf, 'dhProc'));
  const chave = (inf.getAttribute('Id') || '').replace(/^NFS/, '');
  const prestador = pessoa(filho(inf, 'emit'));
  const tomador = pessoa(filho(infDps, 'toma'));

  return {
    tipo: 'nfse',
    chaveAcesso: chave,
    numero: texto(filho(inf, 'nNFSe')),
    dataEmissao: dhProc.slice(0, 10) || texto(filho(infDps, 'dhEmi')).slice(0, 10),
    competencia: texto(filho(infDps, 'dCompet')),
    serie: texto(filho(infDps, 'serie')),
    nDPS: Number(texto(filho(infDps, 'nDPS'))) || null,
    ambiente: texto(filho(infDps, 'tpAmb')) === '1' ? 'producao' : 'homologacao',
    prestador,
    tomador,
    descricao: texto(filho(cServ, 'xDescServ')),
    cTribNac: texto(filho(cServ, 'cTribNac')),
    cTribMun: texto(filho(cServ, 'cTribMun')),
    cNBS: texto(filho(cServ, 'cNBS')),
    valor: Number(texto(caminho(infDps, 'valores', 'vServPrest', 'vServ')) || 0).toFixed(2),
    valorLiquido: texto(caminho(inf, 'valores', 'vLiq')) || null,
    valorIss: texto(caminho(inf, 'valores', 'vISSQN')) || null,
    issRetido: texto(filho(tribMun, 'tpRetISSQN')) === '2',
    aliquotaIss: texto(filho(tribMun, 'pAliq')) || texto(caminho(inf, 'valores', 'pAliqAplic')) || null,
  };
}

/** Extrai os XML de uma lista de arquivos { nome, conteudo (texto) | base64 }. ZIP é aberto recursivamente. */
export function extrairXmls(arquivos) {
  const saida = [];
  for (const a of arquivos) {
    const nome = a.nome ?? '';
    if (/\.zip$/i.test(nome)) {
      const zip = new AdmZip(Buffer.from(a.base64, 'base64'));
      for (const e of zip.getEntries()) {
        if (e.isDirectory) continue;
        if (/\.xml$/i.test(e.entryName)) saida.push({ nome: e.entryName, xml: e.getData().toString('utf8') });
        else if (/\.zip$/i.test(e.entryName)) saida.push(...extrairXmls([{ nome: e.entryName, base64: e.getData().toString('base64') }]));
      }
    } else if (/\.xml$/i.test(nome)) {
      saida.push({ nome, xml: a.conteudo ?? Buffer.from(a.base64, 'base64').toString('utf8') });
    }
  }
  return saida;
}

/**
 * Importa NFS-e: cria as notas (sem duplicar pela chave), cadastra/atualiza clientes com as configurações
 * da nota mais recente e aplica eventos. Só entram notas emitidas pelo prestador configurado.
 * opcoes.pagasAteDias: notas emitidas há mais de N dias entram como pagas (histórico antigo).
 */
export function importarDocumentos({ store, config, documentos, opcoes = {} }) {
  const resumo = { notasNovas: 0, notasExistentes: 0, eventos: 0, ignorados: 0, erros: [], clientes: new Set(), emitente: null };
  const lidos = [];
  for (const d of documentos) {
    try {
      lidos.push({ ...lerDocumentoFiscal(d.xml), xml: d.xml, nome: d.nome });
    } catch (e) {
      resumo.erros.push(`${d.nome ?? 'arquivo'}: ${e.message}`);
    }
  }

  const hoje = hojeBR();
  const limitePago = opcoes.pagasAteDias != null ? new Date(Date.now() - Number(opcoes.pagasAteDias) * 864e5).toISOString().slice(0, 10) : null;
  const nfses = lidos.filter((l) => l.tipo === 'nfse').sort((a, b) => a.dataEmissao.localeCompare(b.dataEmissao));
  const novasNotas = [];

  // O rodapé padrão (dados bancários) é anexado a toda nota emitida; no cadastro do cliente guardamos só o serviço
  const rodape = (config.servicoPadrao.descricaoRodape ?? '').trim();
  const semRodape = (d) => (rodape && d.trim().endsWith(rodape) ? d.trim().slice(0, -rodape.length).trim() : d);

  for (const n of nfses) {
    if (n.prestador?.documento !== config.prestador.cnpj) {
      resumo.ignorados++; // nota recebida (sou tomador) ou de outro prestador
      continue;
    }
    resumo.emitente ??= n.prestador;
    // Cliente: a nota mais recente define as configurações (as notas estão em ordem cronológica)
    const existente = store.clientes.porDocumento(n.tomador.documento);
    const enderecoValido = n.tomador.endereco?.cep ? n.tomador.endereco : existente?.endereco;
    const cliente = store.clientes.salvar({
      ...(existente ?? {}),
      documento: n.tomador.documento,
      nome: n.tomador.nome || existente?.nome,
      email: existente?.email || n.tomador.email,
      fone: existente?.fone || n.tomador.fone,
      im: existente?.im || n.tomador.im,
      endereco: enderecoValido ?? null,
      cTribNac: n.cTribNac !== config.servicoPadrao.cTribNac ? n.cTribNac : existente?.cTribNac ?? '',
      cTribMun: n.cTribMun && n.cTribMun !== config.servicoPadrao.cTribMun ? n.cTribMun : existente?.cTribMun ?? '',
      issRetido: n.issRetido,
      aliquotaIss: n.issRetido ? n.aliquotaIss : existente?.aliquotaIss ?? '',
      descricaoPadrao: semRodape(n.descricao),
      valorPadrao: n.valor,
      origem: existente?.origem ?? 'importacao',
    });
    resumo.clientes.add(cliente.id);

    const chaveExistente = store.notas.porChave(n.chaveAcesso);
    if (chaveExistente) {
      resumo.notasExistentes++;
      continue;
    }
    store.xml.salvar(`${n.chaveAcesso}-nfse.xml`, n.xml);
    const antiga = limitePago && n.dataEmissao <= limitePago;
    novasNotas.push({
      id: crypto.randomUUID(),
      criadaEm: new Date().toISOString(),
      origem: 'importacao',
      status: 'autorizada',
      ambiente: n.ambiente,
      serie: n.serie,
      nDPS: n.nDPS,
      chaveAcesso: n.chaveAcesso,
      numero: n.numero,
      dataEmissao: n.dataEmissao,
      competencia: n.competencia,
      valor: n.valor,
      valorLiquido: n.valorLiquido ?? n.valor,
      valorIss: n.valorIss,
      issRetido: n.issRetido,
      descricao: n.descricao,
      tomador: { documento: cliente.documento, nome: cliente.nome, email: cliente.email ?? '' },
      clienteId: cliente.id,
      nfseXml: `${n.chaveAcesso}-nfse.xml`,
      vencimento: calcularVencimento(n.dataEmissao, cliente, config),
      situacao: antiga ? 'pago' : 'aguardando',
      dataPagamento: null,
      baixa: antiga ? { tipo: 'pago', data: null, origem: 'importacao', em: new Date().toISOString() } : null,
      dataEnvio: n.dataEmissao,
      observacoes: antiga ? 'Importada como paga (histórico anterior ao sistema).' : '',
    });
    resumo.notasNovas++;
  }
  if (novasNotas.length) store.notas.salvarVarios(novasNotas);

  // Eventos depois das notas: o cancelamento pode vir no mesmo lote
  for (const ev of lidos.filter((l) => l.tipo === 'evento')) {
    const nota = store.notas.porChave(ev.chaveAcesso);
    if (!nota) continue;
    store.notas.salvar({
      id: nota.id,
      situacao: ev.efeito,
      chaveSubstituta: ev.chaveSubstituta,
      baixa: { tipo: ev.efeito, data: hoje, origem: 'evento', em: new Date().toISOString() },
    });
    resumo.eventos++;
  }
  resumo.ignorados += lidos.filter((l) => l.tipo === 'ignorado').length;
  return { ...resumo, clientes: resumo.clientes.size, sugestoesAgenda: sugerirAgendas(store) };
}

/** Clientes com 3+ meses seguidos de notas no mesmo valor: candidatos a agendamento mensal. */
export function sugerirAgendas(store) {
  const agendados = new Set(store.agendas.listar().map((a) => a.clienteId));
  const porCliente = new Map();
  for (const n of store.notas.listar()) {
    if (n.status !== 'autorizada' || !n.clienteId || agendados.has(n.clienteId)) continue;
    (porCliente.get(n.clienteId) ?? porCliente.set(n.clienteId, []).get(n.clienteId)).push(n);
  }
  const sugestoes = [];
  for (const [clienteId, notas] of porCliente) {
    const meses = [...new Set(notas.map((n) => n.dataEmissao.slice(0, 7)))].sort();
    if (meses.length < 3) continue;
    const ultimos = meses.slice(-3);
    const seguidos = ultimos.every((m, i) => i === 0 || mesSeguinte(ultimos[i - 1]) === m);
    const ultima = notas.sort((a, b) => b.dataEmissao.localeCompare(a.dataEmissao))[0];
    if (!seguidos) continue;
    sugestoes.push({
      clienteId,
      cliente: ultima.tomador.nome,
      valor: ultima.valor,
      dia: Number(ultima.dataEmissao.slice(8, 10)),
      descricao: store.clientes.obter(clienteId)?.descricaoPadrao ?? ultima.descricao,
    });
  }
  return sugestoes;
}

function mesSeguinte(am) {
  let [a, m] = am.split('-').map(Number);
  m++;
  if (m > 12) [a, m] = [a + 1, 1];
  return `${a}-${String(m).padStart(2, '0')}`;
}
