// Configuração do emitente e do ambiente, lida do .env.
// Os dados fixos do prestador ficam aqui; a cada nota só mudam tomador, descrição e valor.
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const env = (k, padrao) => {
  const v = process.env[k];
  return v === undefined || v === '' ? padrao : v;
};
const digitos = (s) => String(s ?? '').replace(/\D/g, '');

export const AMBIENTES = {
  // tpAmb 2: produção restrita (homologação), nota sem valor fiscal
  homologacao: { tpAmb: '2', sefin: 'https://sefin.producaorestrita.nfse.gov.br/SefinNacional' },
  // tpAmb 1: produção, nota com valor fiscal
  producao: { tpAmb: '1', sefin: 'https://sefin.nfse.gov.br/SefinNacional' },
};

export function carregarConfig() {
  const ambiente = env('NFSE_AMBIENTE', 'homologacao');
  if (!AMBIENTES[ambiente]) throw new Error(`NFSE_AMBIENTE inválido: ${ambiente} (use homologacao ou producao)`);
  return {
    root: ROOT,
    dataDir: path.resolve(ROOT, env('NFSE_DATA_DIR', 'data')),
    porta: Number(env('PORT', 3333)),
    ambiente,
    tpAmb: AMBIENTES[ambiente].tpAmb,
    sefinUrl: env('NFSE_SEFIN_URL', AMBIENTES[ambiente].sefin),
    certificado: {
      pfxPath: env('NFSE_PFX_PATH') && path.resolve(ROOT, env('NFSE_PFX_PATH')),
      senha: env('NFSE_PFX_SENHA', ''),
    },
    // Padrão: Conexão Ágil (dados cadastrais públicos). Contato, endereço e dados bancários
    // são preenchidos na tela Config ou importados das notas antigas, e ficam em data/emitente.json.
    prestador: {
      cnpj: digitos(env('PRESTADOR_CNPJ', '29978652000187')),
      im: digitos(env('PRESTADOR_IM', '10733590010')),
      razaoSocial: env('PRESTADOR_RAZAO', 'CONEXAO AGIL SOLUCOES EMPRESARIAIS LTDA'),
      nomeFantasia: env('PRESTADOR_FANTASIA', 'Conexão Ágil'),
      fone: digitos(env('PRESTADOR_FONE', '')),
      email: env('PRESTADOR_EMAIL', ''),
      site: env('PRESTADOR_SITE', 'https://www.conexaoagil.com.br'),
      endereco: { cep: '', logradouro: '', numero: '', complemento: '', bairro: '', municipio: 'Belo Horizonte', uf: 'MG', cMun: '3106200' },
      // 1 não optante, 2 MEI, 3 ME/EPP
      opSimpNac: env('PRESTADOR_OP_SIMPLES', '3'),
      // 1 tributos federais e municipal pelo SN (padrão ME/EPP)
      regApTribSN: env('PRESTADOR_REG_AP_SN', '1'),
      // 0 nenhum regime especial
      regEspTrib: env('PRESTADOR_REG_ESP', '0'),
    },
    // Belo Horizonte - MG (IBGE 3106200)
    cLocEmi: env('NFSE_MUNICIPIO_EMISSOR', '3106200'),
    servicoPadrao: {
      // 08.02.01 Instrução, treinamento, orientação pedagógica e educacional / 001 municipal BH
      cTribNac: digitos(env('SERVICO_TRIB_NAC', '080201')),
      cTribMun: digitos(env('SERVICO_TRIB_MUN', '001')),
      cNBS: digitos(env('SERVICO_NBS', '')),
      cLocPrestacao: env('SERVICO_LOCAL_PRESTACAO', '3106200'),
      // Alíquota só vai na DPS quando a regra do município exige (ISS retido); parametrizada, a Sefin calcula (E0617)
      pAliq: env('SERVICO_ALIQUOTA', ''),
      // Alíquota do ISS no Simples, usada quando o cliente retém o ISS
      aliquotaIss: env('SERVICO_ALIQUOTA_ISS', '3.00'),
      // Total aproximado de tributos do Simples (Lei 12.741/2012); obrigatório para ME/EPP
      pTotTribSN: env('SERVICO_PTOTTRIB_SN', '6.00'),
      descricaoRodape: env('SERVICO_RODAPE', '').replace(/\\n/g, '\n'),
    },
    cobranca: {
      prazoDias: Number(env('COBRANCA_PRAZO_DIAS', 10)),
      banco: env('COBRANCA_BANCO', ''),
      agencia: env('COBRANCA_AGENCIA', ''),
      conta: env('COBRANCA_CONTA', ''),
      pix: env('COBRANCA_PIX', ''),
    },
    // A busca no ADN só lê documentos: usa a produção (onde estão as notas reais) mesmo em homologação
    adnUrl: env('NFSE_ADN_URL', 'https://adn.nfse.gov.br/contribuintes'),
    serie: env('NFSE_SERIE', '1'),
    verAplic: 'nfse-bh 2.0',
  };
}

// Campos do emitente editáveis pela tela (persistidos em data/emitente.json)
export const CAMPOS_EMITENTE = ['prestador', 'servicoPadrao', 'cobranca', 'serie'];

/** Aplica as alterações do emitente sobre a config em memória (mutação: o emissor lê a config a cada nota). */
export function aplicarEmitente(config, dados = {}) {
  for (const k of CAMPOS_EMITENTE) {
    if (dados[k] === undefined) continue;
    if (typeof dados[k] === 'object' && dados[k] !== null) {
      config[k] = { ...config[k], ...dados[k] };
      if (k === 'prestador' && dados.prestador.endereco) config.prestador.endereco = { ...config.prestador.endereco, ...dados.prestador.endereco };
    } else config[k] = String(dados[k]);
  }
  config.prestador.cnpj = digitos(config.prestador.cnpj);
  config.prestador.im = digitos(config.prestador.im);
  config.prestador.fone = digitos(config.prestador.fone);
  return config;
}
