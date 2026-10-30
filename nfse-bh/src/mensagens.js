// Modelos de mensagem com variáveis ({{cliente.nome}}, {{nota.valor}}…) para enviar a nota a cada cliente.
import { hojeBR, situacaoDaNota, valorEsperado } from './financeiro.js';

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const brl = (v) => (v == null || v === '' ? '' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
const dataBR = (d) => (d ? d.slice(0, 10).split('-').reverse().join('/') : '');
const fmtDoc = (d) => {
  d = String(d ?? '').replace(/\D/g, '');
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  return d;
};

// O rodapé (dados bancários) vai em toda nota; na mensagem os dados de pagamento já têm seção própria
const semRodape = (d, rodape) => {
  const r = (rodape ?? '').trim();
  return r && d.trim().endsWith(r) ? d.trim().slice(0, -r.length).trim() : d;
};

export const VARIAVEIS = [
  ['cliente.nome', 'Razão social / nome do cliente'],
  ['cliente.contato', 'Nome do contato (ou o nome do cliente)'],
  ['cliente.documento', 'CNPJ/CPF do cliente'],
  ['nota.numero', 'Número da NFS-e'],
  ['nota.valor', 'Valor do serviço'],
  ['nota.valorAPagar', 'Valor a depositar (líquido, se houver retenção)'],
  ['nota.descricao', 'Descrição do serviço'],
  ['nota.competencia', 'Competência (mês/ano)'],
  ['nota.dataEmissao', 'Data de emissão'],
  ['nota.vencimento', 'Data de vencimento'],
  ['nota.diasAtraso', 'Dias em atraso'],
  ['nota.chave', 'Chave de acesso'],
  ['nota.link', 'Link da consulta pública / DANFSe'],
  ['emitente.nome', 'Nome fantasia do emitente'],
  ['emitente.razao', 'Razão social do emitente'],
  ['emitente.cnpj', 'CNPJ do emitente'],
  ['emitente.email', 'E-mail do emitente'],
  ['emitente.fone', 'Telefone do emitente'],
  ['banco', 'Banco'],
  ['agencia', 'Agência'],
  ['conta', 'Conta'],
  ['pix', 'Chave PIX'],
  ['mes', 'Mês atual por extenso'],
  ['mesAnterior', 'Mês anterior por extenso'],
  ['ano', 'Ano atual'],
  ['hoje', 'Data de hoje'],
];

export const MODELOS_PADRAO = [
  {
    id: 'envio',
    nome: 'Envio da NFS-e',
    tipo: 'envio',
    assunto: 'NFS-e {{nota.numero}} – {{emitente.nome}} – {{nota.competencia}}',
    corpo: `Olá, {{cliente.contato}}!

Segue a Nota Fiscal de Serviço nº {{nota.numero}}, referente a:
{{nota.descricao}}

Valor: {{nota.valorAPagar}}
Vencimento: {{nota.vencimento}}

Consulta/DANFSe: {{nota.link}}

Dados para pagamento:
{{banco}}
Agência: {{agencia}}
Conta: {{conta}}
PIX: {{pix}}

Qualquer dúvida, estou à disposição.
Abraço,
{{emitente.nome}}`,
  },
  {
    id: 'lembrete',
    nome: 'Lembrete de vencimento',
    tipo: 'lembrete',
    assunto: 'Lembrete: NFS-e {{nota.numero}} vence em {{nota.vencimento}}',
    corpo: `Olá, {{cliente.contato}}, tudo bem?

Passando para lembrar que a NFS-e nº {{nota.numero}}, no valor de {{nota.valorAPagar}}, vence em {{nota.vencimento}}.

PIX: {{pix}}
{{banco}}
Agência: {{agencia}}
Conta: {{conta}}

Obrigado!
{{emitente.nome}}`,
  },
  {
    id: 'cobranca',
    nome: 'Cobrança em atraso',
    tipo: 'cobranca',
    assunto: 'Pendência: NFS-e {{nota.numero}} – vencida em {{nota.vencimento}}',
    corpo: `Olá, {{cliente.contato}}.

Identificamos que a NFS-e nº {{nota.numero}} ({{nota.valorAPagar}}), com vencimento em {{nota.vencimento}}, ainda está em aberto ({{nota.diasAtraso}} dias).

Se o pagamento já foi feito, por favor desconsidere e, se puder, nos envie o comprovante.

PIX: {{pix}}
{{banco}}
Agência: {{agencia}}
Conta: {{conta}}

Obrigado,
{{emitente.nome}}`,
  },
];

/** Valores das variáveis para um cliente (e opcionalmente uma nota). */
export function contexto({ config, cliente, nota, hoje = hojeBR() }) {
  const [a, m] = hoje.split('-').map(Number);
  const atraso = nota?.vencimento && situacaoDaNota(nota, hoje) === 'atrasada'
    ? Math.round((new Date(hoje) - new Date(nota.vencimento)) / 864e5)
    : 0;
  const p = config.prestador;
  const c = config.cobranca ?? {};
  return {
    'cliente.nome': cliente?.nome ?? nota?.tomador?.nome ?? '',
    'cliente.contato': cliente?.contatoNome || cliente?.nome || nota?.tomador?.nome || '',
    'cliente.documento': fmtDoc(cliente?.documento ?? nota?.tomador?.documento),
    'nota.numero': nota?.numero ?? '',
    'nota.valor': brl(nota?.valor),
    'nota.valorAPagar': nota ? brl(valorEsperado(nota)) : '',
    'nota.descricao': semRodape(nota?.descricao ?? '', config.servicoPadrao?.descricaoRodape),
    'nota.competencia': nota?.competencia ? `${nota.competencia.slice(5, 7)}/${nota.competencia.slice(0, 4)}` : '',
    'nota.dataEmissao': dataBR(nota?.dataEmissao),
    'nota.vencimento': dataBR(nota?.vencimento),
    'nota.diasAtraso': String(atraso),
    'nota.chave': nota?.chaveAcesso ?? '',
    'nota.link': nota?.chaveAcesso ? `https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave=${nota.chaveAcesso}` : '',
    'emitente.nome': p.nomeFantasia || p.razaoSocial,
    'emitente.razao': p.razaoSocial,
    'emitente.cnpj': fmtDoc(p.cnpj),
    'emitente.email': p.email ?? '',
    'emitente.fone': p.fone ?? '',
    banco: c.banco ?? '',
    agencia: c.agencia ?? '',
    conta: c.conta ?? '',
    pix: c.pix ?? '',
    mes: MESES[m - 1],
    mesAnterior: MESES[(m + 10) % 12],
    ano: String(a),
    hoje: dataBR(hoje),
  };
}

/**
 * Substitui {{variavel}}; variável desconhecida fica como está, para o usuário perceber.
 * Linha cujas variáveis ficaram todas vazias some (ex.: "PIX: {{pix}}" sem PIX cadastrado).
 */
export function renderizar(texto, ctx) {
  const re = /\{\{\s*([\w.]+)\s*\}\}/g;
  return String(texto ?? '')
    .split('\n')
    .filter((linha) => {
      const vars = [...linha.matchAll(re)].map((m) => m[1]);
      return !vars.length || vars.some((k) => !(k in ctx) || String(ctx[k]).trim() !== '');
    })
    .map((linha) => linha.replace(re, (m, k) => (k in ctx ? ctx[k] : m)))
    .join('\n');
}

/** Modelos do usuário, com os padrões quando ainda não há nenhum. */
export function listarModelos(store) {
  const salvos = store.modelos.listar();
  const ids = new Set(salvos.map((m) => m.id));
  return [...salvos, ...MODELOS_PADRAO.filter((m) => !ids.has(m.id))];
}

/** Mensagem pronta (assunto + corpo) para uma nota, com o modelo escolhido ou o do cliente. */
export function gerarMensagem({ store, config, nota, modeloId, hoje }) {
  const cliente = nota.clienteId ? store.clientes.obter(nota.clienteId) : null;
  const modelos = listarModelos(store);
  const situacao = situacaoDaNota(nota, hoje);
  const padraoSituacao = situacao === 'atrasada' ? 'cobranca' : nota.dataEnvio ? 'lembrete' : 'envio';
  const modelo =
    modelos.find((m) => m.id === modeloId) ??
    (padraoSituacao === 'envio' && cliente?.modeloId ? modelos.find((m) => m.id === cliente.modeloId) : null) ??
    modelos.find((m) => m.id === padraoSituacao) ??
    modelos[0];
  const ctx = contexto({ config, cliente, nota, hoje });
  const destinatarios = [cliente?.emailsCobranca, cliente?.email, nota.tomador?.email].filter(Boolean).join(', ');
  return {
    modeloId: modelo.id,
    assunto: renderizar(modelo.assunto, ctx),
    corpo: renderizar(modelo.corpo, ctx),
    para: [...new Set(destinatarios.split(/[,;\s]+/).filter(Boolean))].join(', '),
    whatsapp: String(cliente?.whatsapp ?? cliente?.fone ?? '').replace(/\D/g, ''),
  };
}
