// Montagem da DPS (Declaração de Prestação de Serviço), leiaute nacional 1.01.
// A ordem dos elementos segue o XSD oficial (tiposComplexos_v1.01.xsd); a Sefin recusa fora de ordem.

export const NFSE_NS = 'http://www.sped.fazenda.gov.br/nfse';
export const VERSAO_LEIAUTE = '1.01';
// A Sefin Nacional recusa a DPS sem a declaração XML (E1229)
export const DECLARACAO_XML = '<?xml version="1.0" encoding="UTF-8"?>';

const digitos = (s) => String(s ?? '').replace(/\D/g, '');

export function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Elemento opcional: some quando o valor é vazio
const tag = (nome, valor) => (valor === undefined || valor === null || valor === '' ? '' : `<${nome}>${esc(valor)}</${nome}>`);
const grupo = (nome, conteudo) => (conteudo ? `<${nome}>${conteudo}</${nome}>` : '');

/** "1.860,00", "1860.5", 1860 → "1860.00" (formato TSDec15V2). */
export function formatarValor(v) {
  let s = String(v).trim().replace(/^R\$\s*/i, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) throw new Error(`valor inválido: ${v}`);
  return n.toFixed(2);
}

export function cnpjValido(c) {
  c = digitos(c);
  if (c.length !== 14 || /^(\d)\1+$/.test(c)) return false;
  const dv = (base) => {
    let soma = 0;
    let peso = base.length - 7;
    for (const d of base) {
      soma += Number(d) * peso--;
      if (peso < 2) peso = 9;
    }
    const r = soma % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return dv(c.slice(0, 12)) === Number(c[12]) && dv(c.slice(0, 13)) === Number(c[13]);
}

export function cpfValido(c) {
  c = digitos(c);
  if (c.length !== 11 || /^(\d)\1+$/.test(c)) return false;
  const dv = (n) => {
    let soma = 0;
    for (let i = 0; i < n; i++) soma += Number(c[i]) * (n + 1 - i);
    const r = (soma * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(9) === Number(c[9]) && dv(10) === Number(c[10]);
}

/** Id do infDPS: DPS + município(7) + tipo inscrição(1) + inscrição(14) + série(5) + número(15). */
export function idDps({ cLocEmi, cnpj, cpf, serie, nDPS }) {
  const [tp, insc] = cnpj ? ['2', digitos(cnpj)] : ['1', digitos(cpf).padStart(14, '0')];
  return `DPS${cLocEmi}${tp}${insc}${String(serie).padStart(5, '0')}${String(nDPS).padStart(15, '0')}`;
}

/** Data e hora no fuso de Brasília, sem milissegundos (padrão TSDateTimeUTC). */
export function dataHoraBrasilia(d = new Date()) {
  const local = new Date(d.getTime() - 3 * 3600 * 1000);
  return local.toISOString().slice(0, 19) + '-03:00';
}

function documento(doc) {
  const d = digitos(doc);
  if (d.length === 14) return `<CNPJ>${d}</CNPJ>`;
  if (d.length === 11) return `<CPF>${d}</CPF>`;
  throw new Error(`CPF/CNPJ inválido: ${doc}`);
}

function endereco(e) {
  if (!e || !e.cep || !e.cMun) return '';
  return (
    '<end>' +
    `<endNac><cMun>${digitos(e.cMun)}</cMun><CEP>${digitos(e.cep)}</CEP></endNac>` +
    tag('xLgr', e.logradouro) +
    tag('nro', e.numero || 'S/N') +
    tag('xCpl', e.complemento) +
    tag('xBairro', e.bairro) +
    '</end>'
  );
}

/** Valida a entrada e devolve a lista de problemas (vazia quando está tudo certo). */
export function validarEntrada({ config, tomador, servico, nDPS }) {
  const erros = [];
  const p = config.prestador;
  if (!cnpjValido(p.cnpj)) erros.push('CNPJ do prestador inválido (PRESTADOR_CNPJ)');
  const doc = digitos(tomador?.documento);
  if (doc.length === 14 ? !cnpjValido(doc) : doc.length === 11 ? !cpfValido(doc) : true)
    erros.push('CPF/CNPJ do tomador inválido');
  if (!tomador?.nome?.trim()) erros.push('Nome/Razão social do tomador é obrigatório');
  if (tomador?.endereco?.cep && !tomador.endereco.cMun) erros.push('Endereço do tomador sem código IBGE do município');
  if (tomador?.endereco?.cep && (!tomador.endereco.logradouro || !tomador.endereco.bairro))
    erros.push('Endereço do tomador incompleto (logradouro e bairro)');
  if (!servico?.descricao?.trim()) erros.push('Descrição do serviço é obrigatória');
  if (servico?.descricao?.length > 2000) erros.push('Descrição do serviço passa de 2000 caracteres');
  try {
    if (Number(formatarValor(servico?.valor)) <= 0) erros.push('Valor do serviço deve ser maior que zero');
  } catch {
    erros.push('Valor do serviço inválido');
  }
  if (servico?.competencia && !/^\d{4}-\d{2}-\d{2}$/.test(servico.competencia))
    erros.push('Competência deve estar no formato AAAA-MM-DD');
  if (!/^[1-9]\d{0,14}$/.test(String(nDPS))) erros.push('Número da DPS inválido');
  if (!/^\d{6}$/.test(servico?.cTribNac ?? config.servicoPadrao.cTribNac)) erros.push('Código de tributação nacional deve ter 6 dígitos');
  return erros;
}

/**
 * Monta o XML da DPS, sem assinatura.
 * tomador: { documento, nome, email?, fone?, im?, endereco?: { cep, cMun, logradouro, numero, complemento, bairro } }
 * servico: { descricao, valor, competencia?, cTribNac?, cTribMun?, cNBS?, cLocPrestacao?, pAliq?, pTotTribSN? }
 */
export function montarDps({ config, tomador, servico, nDPS, agora = new Date() }) {
  const erros = validarEntrada({ config, tomador, servico, nDPS });
  if (erros.length) {
    const e = new Error(erros.join('; '));
    e.erros = erros;
    throw e;
  }
  const p = config.prestador;
  const sp = config.servicoPadrao;
  const s = { ...sp, ...Object.fromEntries(Object.entries(servico).filter(([, v]) => v !== undefined && v !== '')) };

  // dhEmi um minuto no passado: a Sefin recusa emissão "no futuro" por diferença de relógio
  const dhEmi = dataHoraBrasilia(new Date(agora.getTime() - 60_000));
  const dCompet = s.competencia || dhEmi.slice(0, 10);
  if (dCompet > dhEmi.slice(0, 10)) throw new Error('A competência não pode ser posterior à data de emissão (E0015)');

  const id = idDps({ cLocEmi: config.cLocEmi, cnpj: p.cnpj, serie: config.serie, nDPS });

  let descricao = s.descricao.trim();
  if (sp.descricaoRodape) descricao += '\n' + sp.descricaoRodape;

  // Prestador emitente: nome e endereço vêm do cadastro nacional e não devem ir na DPS
  const prest =
    '<prest>' +
    `<CNPJ>${digitos(p.cnpj)}</CNPJ>` +
    tag('IM', p.im) +
    tag('fone', p.fone) +
    tag('email', p.email) +
    '<regTrib>' +
    `<opSimpNac>${p.opSimpNac}</opSimpNac>` +
    (p.opSimpNac === '3' ? `<regApTribSN>${p.regApTribSN}</regApTribSN>` : '') +
    `<regEspTrib>${p.regEspTrib}</regEspTrib>` +
    '</regTrib>' +
    '</prest>';

  const toma =
    '<toma>' +
    documento(tomador.documento) +
    tag('IM', digitos(tomador.im)) +
    `<xNome>${esc(tomador.nome.trim())}</xNome>` +
    endereco(tomador.endereco) +
    tag('fone', digitos(tomador.fone)) +
    tag('email', tomador.email) +
    '</toma>';

  const serv =
    '<serv>' +
    `<locPrest><cLocPrestacao>${s.cLocPrestacao}</cLocPrestacao></locPrest>` +
    '<cServ>' +
    `<cTribNac>${digitos(s.cTribNac)}</cTribNac>` +
    tag('cTribMun', digitos(s.cTribMun)) +
    `<xDescServ>${esc(descricao)}</xDescServ>` +
    tag('cNBS', digitos(s.cNBS)) +
    '</cServ>' +
    '</serv>';

  // Total aproximado de tributos: ME/EPP usa pTotTribSN; MEI só aceita indTotTrib (E0710/E0712)
  let totTrib;
  if (p.opSimpNac === '2') totTrib = '<indTotTrib>0</indTotTrib>';
  else if (p.opSimpNac === '3') totTrib = `<pTotTribSN>${formatarValor(s.pTotTribSN)}</pTotTribSN>`;
  else totTrib = `<pTotTrib><pTotTribFed>0.00</pTotTribFed><pTotTribEst>0.00</pTotTribEst><pTotTribMun>0.00</pTotTribMun></pTotTrib>`;

  const valores =
    '<valores>' +
    `<vServPrest><vServ>${formatarValor(s.valor)}</vServ></vServPrest>` +
    '<trib>' +
    '<tribMun>' +
    '<tribISSQN>1</tribISSQN>' + // operação tributável
    '<tpRetISSQN>1</tpRetISSQN>' + // não retido
    (s.pAliq ? `<pAliq>${formatarValor(s.pAliq)}</pAliq>` : '') +
    '</tribMun>' +
    grupo('totTrib', totTrib) +
    '</trib>' +
    '</valores>';

  const xml =
    DECLARACAO_XML +
    `<DPS xmlns="${NFSE_NS}" versao="${VERSAO_LEIAUTE}">` +
    `<infDPS Id="${id}">` +
    `<tpAmb>${config.tpAmb}</tpAmb>` +
    `<dhEmi>${dhEmi}</dhEmi>` +
    `<verAplic>${esc(config.verAplic)}</verAplic>` +
    `<serie>${config.serie}</serie>` +
    `<nDPS>${nDPS}</nDPS>` +
    `<dCompet>${dCompet}</dCompet>` +
    '<tpEmit>1</tpEmit>' +
    `<cLocEmi>${config.cLocEmi}</cLocEmi>` +
    prest +
    toma +
    serv +
    valores +
    '</infDPS>' +
    '</DPS>';

  return { xml, id, dhEmi, dCompet, valor: formatarValor(s.valor) };
}
