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
    prestador: {
      cnpj: digitos(env('PRESTADOR_CNPJ', '')),
      im: digitos(env('PRESTADOR_IM', '')),
      razaoSocial: env('PRESTADOR_RAZAO', ''),
      fone: digitos(env('PRESTADOR_FONE', '')),
      email: env('PRESTADOR_EMAIL', ''),
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
      cTribNac: digitos(env('SERVICO_TRIB_NAC', '080201')),
      cTribMun: digitos(env('SERVICO_TRIB_MUN', '001')),
      cNBS: digitos(env('SERVICO_NBS', '')),
      cLocPrestacao: env('SERVICO_LOCAL_PRESTACAO', '3106200'),
      // Alíquota só vai na DPS quando a regra do município exige; parametrizada, a Sefin calcula (E0617)
      pAliq: env('SERVICO_ALIQUOTA', ''),
      // Total aproximado de tributos do Simples (Lei 12.741/2012); obrigatório para ME/EPP
      pTotTribSN: env('SERVICO_PTOTTRIB_SN', '6.00'),
      descricaoRodape: env('SERVICO_RODAPE', '').replace(/\\n/g, '\n'),
    },
    serie: env('NFSE_SERIE', '1'),
    verAplic: 'nfse-bh 1.0',
  };
}
