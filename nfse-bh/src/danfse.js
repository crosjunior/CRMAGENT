// Leitura do DANFSe v2.0 (PDF do Emissor Nacional) quando não há o XML: cada rótulo do documento tem o
// valor logo abaixo, na mesma coluna. O resultado tem o mesmo formato de lerDocumentoFiscal (XML).
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const soDigitos = (s) => String(s ?? '').replace(/\D/g, '');
const vazio = (s) => (s === '-' || s === undefined ? '' : s.trim());
const dataIso = (s) => {
  const m = String(s ?? '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
};
const valorBR = (s) => {
  const m = String(s ?? '').match(/[\d.]+,\d{2}/);
  return m ? Number(m[0].replace(/\./g, '').replace(',', '.')).toFixed(2) : null;
};

/** Itens de texto da 1ª página com posição (y cresce para cima, como no PDF). */
async function itensDoPdf(buffer) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, isEvalSupported: false }).promise;
  const page = await doc.getPage(1);
  const { items } = await page.getTextContent();
  await doc.destroy();
  return items.filter((i) => i.str.trim()).map((i) => ({ x: i.transform[4], y: i.transform[5], t: i.str.trim() }));
}

/** Lê o DANFSe e devolve { tipo: 'nfse', ... } ou { tipo: 'ignorado' } se o PDF não for um DANFSe. */
export async function lerDanfsePdf(buffer) {
  const itens = await itensDoPdf(buffer);
  const acha = (texto, abaixoDe = Infinity, acimaDe = -Infinity) =>
    itens.filter((i) => i.t === texto && i.y < abaixoDe && i.y > acimaDe).sort((a, b) => b.y - a.y)[0];
  if (!itens.some((i) => /DANFSe/i.test(i.t)) || !acha('CHAVE DE ACESSO DA NFS-e')) return { tipo: 'ignorado' };

  // Valor = item logo abaixo do rótulo, na mesma coluna (até 14pt abaixo)
  const abaixo = (rotulo) => {
    if (!rotulo) return '';
    const v = itens
      .filter((i) => Math.abs(i.x - rotulo.x) < 4 && i.y < rotulo.y - 2 && i.y > rotulo.y - 14)
      .sort((a, b) => b.y - a.y)[0];
    return vazio(v?.t);
  };
  const secao = (titulo) => acha(titulo)?.y ?? Infinity;
  const campo = (texto, inicioSecao = Infinity) => abaixo(acha(texto, inicioSecao + 2));

  const pessoa = (titulo) => {
    const y = secao(titulo);
    const [mun, uf] = campo('Município / Sigla UF', y).split('/').map((s) => s.trim());
    const [ibge, cep] = campo('Código IBGE / CEP', y).split('/').map((s) => s.trim());
    const partes = campo('Endereço', y).split(',').map((s) => s.trim()).filter(Boolean);
    return {
      documento: soDigitos(campo('CNPJ / CPF / NIF', y)),
      im: soDigitos(campo('Indicador Municipal (Inscrição)', y)),
      nome: campo('Nome / Nome Empresarial', y),
      nomeFantasia: '',
      fone: soDigitos(campo('Telefone', y)),
      email: campo('E-mail', y).toLowerCase(),
      endereco: cep
        ? {
            cep: soDigitos(cep),
            cMun: soDigitos(ibge),
            municipio: mun ?? '',
            uf: uf ?? '',
            logradouro: partes[0] ?? '',
            numero: partes[1] ?? 'S/N',
            complemento: partes.slice(2, -1).join(', '),
            bairro: partes.length > 2 ? partes[partes.length - 1] : '',
          }
        : null,
    };
  };

  // Descrição: linhas entre o rótulo e a seção de tributação municipal, em ordem de leitura
  const rotDesc = acha('Descrição do Serviço');
  const fimDesc = acha('TRIBUTAÇÃO MUNICIPAL (ISSQN)')?.y ?? -Infinity;
  const linhas = itens
    .filter((i) => rotDesc && i.y < rotDesc.y - 2 && i.y > fimDesc + 2)
    .sort((a, b) => b.y - a.y || a.x - b.x)
    .reduce((acc, i) => {
      const ult = acc[acc.length - 1];
      if (ult && Math.abs(ult.y - i.y) < 2) ult.t += ' ' + i.t;
      else acc.push({ y: i.y, t: i.t });
      return acc;
    }, [])
    .map((l) => l.t);

  const ySrv = secao('SERVIÇO PRESTADO');
  const [cTribNac, cTribMun] = campo('Código de Tributação Nacional/Municipal', ySrv).split('/').map((s) => soDigitos(s));
  const [locNome, locUf, locPais] = campo('Local da Prestação / Sigla UF / País', ySrv).split('/').map((s) => s.trim());
  const yIss = secao('TRIBUTAÇÃO MUNICIPAL (ISSQN)');
  const situacao = campo('SITUAÇÃO DA NFS-e');
  const ambiente = itens.find((i) => /^Tipo de Ambiente:/.test(i.t))?.t.endsWith('1') ? 'producao' : 'homologacao';

  return {
    tipo: 'nfse',
    origemArquivo: 'pdf',
    cancelada: /cancel/i.test(situacao),
    substituida: /substitu/i.test(situacao),
    chaveAcesso: soDigitos(campo('CHAVE DE ACESSO DA NFS-e')),
    numero: campo('NÚMERO DA NFS-e'),
    dataEmissao: dataIso(campo('DATA E HORA DA EMISSÃO DA NFS-e')),
    competencia: dataIso(campo('COMPETÊNCIA DA NFS-e')),
    serie: campo('SÉRIE DA DPS'),
    nDPS: Number(campo('NÚMERO DA DPS')) || null,
    ambiente,
    prestador: pessoa('PRESTADOR / FORNECEDOR'),
    tomador: pessoa('TOMADOR / ADQUIRENTE'),
    descricao: linhas.join('\n'),
    cTribNac: cTribNac ?? '',
    cTribMun: cTribMun ?? '',
    cNBS: soDigitos(campo('Código da NBS', ySrv)),
    localPrestacao: locNome ? { municipio: locNome, uf: locUf, pais: vazio(locPais) } : null,
    valor: valorBR(campo('VALOR DA OPERAÇÃO / SERVIÇO')) ?? '0.00',
    valorLiquido: valorBR(campo('VALOR LÍQUIDO DA NFS-e')),
    valorIss: valorBR(campo('ISSQN Apurado', yIss)),
    issRetido: /^retido/i.test(campo('Retenção do ISSQN', yIss)),
    aliquotaIss: (campo('Alíquota Aplicada', yIss).match(/[\d,]+/)?.[0] ?? '').replace(',', '.') || null,
  };
}
