// Preenchimento automático do tomador: razão social e endereço pelo CNPJ (BrasilAPI) e endereço pelo CEP (ViaCEP).
// Ambos devolvem o código IBGE do município, exigido no endereço da DPS.
const soDigitos = (s) => String(s ?? '').replace(/\D/g, '');

async function getJson(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) return null;
  return r.json();
}

export async function consultarCep(cep) {
  const j = await getJson(`https://viacep.com.br/ws/${soDigitos(cep)}/json/`);
  if (!j || j.erro) return null;
  return {
    cep: soDigitos(j.cep),
    logradouro: j.logradouro,
    bairro: j.bairro,
    complemento: j.complemento,
    municipio: j.localidade,
    uf: j.uf,
    cMun: j.ibge,
  };
}

export async function consultarCnpj(cnpj) {
  const j = await getJson(`https://brasilapi.com.br/api/cnpj/v1/${soDigitos(cnpj)}`);
  if (!j) return null;
  return {
    documento: soDigitos(j.cnpj),
    nome: j.razao_social,
    email: j.email ?? '',
    fone: soDigitos(j.ddd_telefone_1),
    nomeFantasia: j.nome_fantasia ?? '',
    cnae: j.cnae_fiscal ? String(j.cnae_fiscal) : '',
    cnaeDescricao: j.cnae_fiscal_descricao ?? '',
    cnaesSecundarios: (j.cnaes_secundarios ?? []).filter((c) => c.codigo).map((c) => ({ codigo: String(c.codigo), descricao: c.descricao })),
    porte: j.porte ?? '',
    simples: j.opcao_pelo_simples ?? null,
    mei: j.opcao_pelo_mei ?? null,
    endereco: {
      cep: soDigitos(j.cep),
      logradouro: [j.descricao_tipo_de_logradouro, j.logradouro].filter(Boolean).join(' '),
      numero: j.numero,
      complemento: j.complemento,
      bairro: j.bairro,
      municipio: j.municipio,
      uf: j.uf,
      cMun: j.codigo_municipio_ibge ? String(j.codigo_municipio_ibge) : '',
    },
  };
}
