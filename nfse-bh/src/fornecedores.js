// Fornecedores: quem emitiu NFS-e para a empresa. Totais por mês/ano e classificação do serviço prestado
// a partir do código de tributação das notas, do CNAE (Receita, via BrasilAPI), das descrições e do nome.
import { situacaoDaRecebida } from './financeiro.js';

export const CATEGORIAS = {
  contabilidade: 'Contabilidade',
  tecnologia: 'Tecnologia e software',
  nuvem: 'Nuvem e hospedagem',
  consultoria: 'Consultoria e assessoria',
  educacao: 'Educação e treinamento',
  marketing: 'Marketing, design e conteúdo',
  juridico: 'Jurídico',
  administrativo: 'Apoio administrativo',
  eventos: 'Eventos',
  espaco: 'Espaço e coworking',
  telecom: 'Telecomunicações',
  transporte: 'Transporte e viagens',
  saude: 'Saúde',
  outros: 'Outros serviços',
};

// cnae: prefixos do código CNAE (7 dígitos); trib: prefixos do código de tributação nacional (6 dígitos, LC 116)
const REGRAS = [
  { cat: 'contabilidade', cnae: ['6920'], trib: ['1719'], palavras: ['contab', 'escritura', 'folha de pagamento', 'dctf', 'sped', 'balancete', 'honorarios contabeis', 'imposto de renda'] },
  { cat: 'nuvem', cnae: ['6311', '6319'], trib: ['0103', '0104'], palavras: ['aws', 'amazon web services', 'cloud', 'nuvem', 'hospedagem', 'servidor', 'azure', 'google cloud', 'datacenter', 'dominio'] },
  { cat: 'tecnologia', cnae: ['62'], trib: ['0101', '0102', '0105', '0106', '0107', '0108', '0109'], palavras: ['software', 'sistema', 'licenca', 'desenvolvimento', 'saas', 'suporte tecnico', 'fluig', 'plataforma', 'aplicativo', 'programacao', 'ti ', 'informatica', 'tecnologia'] },
  { cat: 'consultoria', cnae: ['7020', '7490'], trib: ['1701', '1720'], palavras: ['consultoria', 'assessoria', 'mentoria', 'gestao', 'planejamento estrategico', 'diagnostico'] },
  { cat: 'educacao', cnae: ['85'], trib: ['0801', '0802'], palavras: ['treinamento', 'curso', 'capacitacao', 'palestra', 'workshop', 'aula', 'formacao', 'instrutor', 'facilitacao'] },
  { cat: 'marketing', cnae: ['7311', '7312', '7319', '7410', '5911', '5912', '7420', '1813'], trib: ['1706', '2301', '1325', '1303'], palavras: ['marketing', 'design', 'publicidade', 'social media', 'trafego', 'conteudo', 'video', 'fotograf', 'identidade visual', 'campanha', 'edicao', 'grafica', 'copywriting'] },
  { cat: 'juridico', cnae: ['6911', '6912'], trib: ['1714'], palavras: ['advocac', 'juridic', 'advogad', 'honorarios advocaticios', 'parecer'] },
  { cat: 'administrativo', cnae: ['8211', '8219', '8220', '8291'], trib: ['1702', '1703'], palavras: ['administrativ', 'secretari', 'bpo', 'atendimento', 'cobranca', 'digitacao', 'assistente'] },
  { cat: 'eventos', cnae: ['8230', '5620'], trib: ['1209', '1210', '1211', '1711'], palavras: ['evento', 'buffet', 'coffee break', 'sonorizacao', 'cerimonial'] },
  { cat: 'espaco', cnae: ['6810', '6821', '6822', '7739'], trib: ['0301', '0302', '0303'], palavras: ['coworking', 'locacao de sala', 'aluguel', 'sala de reuniao', 'escritorio virtual', 'endereco fiscal'] },
  { cat: 'telecom', cnae: ['61'], trib: ['0101'], palavras: ['telefonia', 'internet', 'link dedicado', 'telecom', 'celular'] },
  { cat: 'transporte', cnae: ['49', '50', '51', '7911', '7912'], trib: ['1601', '1602', '0904'], palavras: ['transporte', 'frete', 'viagem', 'passagem', 'hospedagem em hotel', 'motorista', 'uber'] },
  { cat: 'saude', cnae: ['86', '87'], trib: ['04'], palavras: ['saude', 'medic', 'clinica', 'exame', 'psicolog', 'terapia'] },
];

// Palavra curta (ex.: "ti") só conta inteira; as demais valem como prefixo ("contab" pega contábil, contabilidade)
const tem = (texto, p) => {
  const k = normalizar(p).trim();
  return k.length <= 3 ? texto.includes(` ${k} `) : texto.includes(` ${k}`);
};

const normalizar = (s) =>
  ` ${String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')} `;

/**
 * Classifica o fornecedor. Pesos: código de tributação das notas (3 por nota, normalizado), CNAE principal (4),
 * CNAEs secundários (1), descrição do CNAE e das notas (palavras-chave) e nome. Devolve categoria e motivo.
 */
export function classificar({ nome, cnae, cnaeDescricao, cnaesSecundarios = [], notas = [] }) {
  const pontos = Object.fromEntries(Object.keys(CATEGORIAS).map((k) => [k, 0]));
  const motivos = Object.fromEntries(Object.keys(CATEGORIAS).map((k) => [k, []]));
  const textoNotas = normalizar(notas.map((n) => n.descricao).join(' '));
  const textoCnae = normalizar(`${cnaeDescricao ?? ''} ${cnaesSecundarios.map((c) => c.descricao).join(' ')}`);
  const textoNome = normalizar(nome);
  const n = Math.max(notas.length, 1);

  for (const r of REGRAS) {
    const porTrib = notas.filter((x) => x.cTribNac && r.trib.some((p) => x.cTribNac.startsWith(p))).length;
    if (porTrib) {
      pontos[r.cat] += (3 * porTrib) / n;
      motivos[r.cat].push(`código de serviço ${notas.find((x) => r.trib.some((p) => x.cTribNac?.startsWith(p))).cTribNac}`);
    }
    if (cnae && r.cnae.some((p) => String(cnae).startsWith(p))) {
      pontos[r.cat] += 4;
      motivos[r.cat].push(`CNAE ${cnae}`);
    }
    if (cnaesSecundarios.some((c) => r.cnae.some((p) => c.codigo.startsWith(p)))) pontos[r.cat] += 1;
    const achadasNotas = r.palavras.filter((p) => tem(textoNotas, p));
    if (achadasNotas.length) {
      pontos[r.cat] += Math.min(3, achadasNotas.length * 1.5);
      motivos[r.cat].push(`descrição: ${achadasNotas.slice(0, 2).join(', ')}`);
    }
    if (r.palavras.some((p) => tem(textoCnae, p))) pontos[r.cat] += 1.5;
    const achadasNome = r.palavras.filter((p) => tem(textoNome, p));
    if (achadasNome.length) {
      pontos[r.cat] += 1;
      motivos[r.cat].push(`nome: ${achadasNome[0]}`);
    }
  }
  const [melhor, valor] = Object.entries(pontos).sort((a, b) => b[1] - a[1])[0];
  if (valor < 1) return { categoria: 'outros', confianca: 'baixa', motivo: cnaeDescricao ? `CNAE: ${cnaeDescricao}` : 'sem indícios suficientes' };
  return { categoria: melhor, confianca: valor >= 4 ? 'alta' : valor >= 2 ? 'media' : 'baixa', motivo: motivos[melhor].join(' · ') };
}

/** Consulta CNAE/porte dos fornecedores ainda sem dados (BrasilAPI), um por vez. */
export async function enriquecerFornecedores({ store, consultar, limite = 30, pausaMs = 400 }) {
  const cadastrados = new Map(store.fornecedores.listar().map((f) => [f.id, f]));
  const docs = [...new Set(store.recebidas.listar().map((r) => r.fornecedor?.documento).filter((d) => d?.length === 14))];
  const semanaAtras = new Date(Date.now() - 7 * 864e5).toISOString();
  const pendentes = docs.filter((d) => {
    const f = cadastrados.get(d);
    return !f?.consultadoEm || (f.erroConsulta && f.consultadoEm < semanaAtras);
  });
  let feitos = 0;
  for (const doc of pendentes.slice(0, limite)) {
    try {
      const j = await consultar(doc);
      store.fornecedores.salvar({
        id: doc,
        documento: doc,
        ...(j ? { nomeFantasia: j.nomeFantasia, cnae: j.cnae, cnaeDescricao: j.cnaeDescricao, cnaesSecundarios: j.cnaesSecundarios, porte: j.porte, mei: j.mei, simples: j.simples, municipio: j.endereco?.municipio, uf: j.endereco?.uf } : {}),
        consultadoEm: new Date().toISOString(),
        erroConsulta: j ? null : 'CNPJ não encontrado',
      });
      feitos++;
    } catch (e) {
      store.fornecedores.salvar({ id: doc, documento: doc, consultadoEm: new Date().toISOString(), erroConsulta: e.message });
    }
    if (pausaMs) await new Promise((r) => setTimeout(r, pausaMs));
  }
  return { consultados: feitos, pendentes: Math.max(0, pendentes.length - limite) };
}

/** Fornecedores com totais (ano escolhido, por mês e por ano) e a classificação. */
export function resumoFornecedores({ store, ano }) {
  const extras = new Map(store.fornecedores.listar().map((f) => [f.id, f]));
  const validas = store.recebidas.listar().filter((r) => situacaoDaRecebida(r) !== 'cancelada');
  const anos = [...new Set(validas.map((r) => r.dataEmissao?.slice(0, 4)).filter(Boolean))].sort().reverse();
  const anoSel = String(ano || anos[0] || new Date().getFullYear());
  const grupos = new Map();
  for (const r of validas) {
    const doc = r.fornecedor?.documento || r.fornecedor?.nome || '?';
    if (!grupos.has(doc)) grupos.set(doc, []);
    grupos.get(doc).push(r);
  }

  const fornecedores = [...grupos.entries()].map(([doc, notas]) => {
    const extra = extras.get(doc) ?? {};
    const ultima = [...notas].sort((a, b) => b.dataEmissao.localeCompare(a.dataEmissao))[0];
    const auto = classificar({ nome: ultima.fornecedor?.nome, cnae: extra.cnae, cnaeDescricao: extra.cnaeDescricao, cnaesSecundarios: extra.cnaesSecundarios, notas });
    const doAno = notas.filter((r) => r.dataEmissao?.startsWith(anoSel));
    const porMes = Array(12).fill(0);
    for (const r of doAno) porMes[Number(r.dataEmissao.slice(5, 7)) - 1] += Number(r.valor);
    const porAno = {};
    for (const r of notas) porAno[r.dataEmissao.slice(0, 4)] = (porAno[r.dataEmissao.slice(0, 4)] ?? 0) + Number(r.valor);
    return {
      documento: doc,
      nome: ultima.fornecedor?.nome,
      nomeFantasia: extra.nomeFantasia || ultima.fornecedor?.nomeFantasia || '',
      municipio: extra.municipio || ultima.fornecedor?.municipio || '',
      uf: extra.uf || ultima.fornecedor?.uf || '',
      email: ultima.fornecedor?.email || '',
      cnae: extra.cnae || '',
      cnaeDescricao: extra.cnaeDescricao || '',
      mei: extra.mei ?? null,
      consultado: !!extra.consultadoEm && !extra.erroConsulta,
      categoria: extra.categoriaManual || auto.categoria,
      categoriaManual: !!extra.categoriaManual,
      sugestao: auto,
      totalAno: doAno.reduce((s, r) => s + Number(r.valor), 0),
      notasAno: doAno.length,
      totalGeral: notas.reduce((s, r) => s + Number(r.valor), 0),
      notasGeral: notas.length,
      aPagar: notas.filter((r) => ['a_pagar', 'vencida'].includes(situacaoDaRecebida(r))).reduce((s, r) => s + Number(r.valorLiquido ?? r.valor), 0),
      porMes,
      porAno,
      ultimaNota: ultima.dataEmissao,
      mediaMensal: doAno.length ? doAno.reduce((s, r) => s + Number(r.valor), 0) / new Set(doAno.map((r) => r.dataEmissao.slice(0, 7))).size : 0,
    };
  });
  fornecedores.sort((a, b) => b.totalAno - a.totalAno || b.totalGeral - a.totalGeral);

  const porMes = Array(12).fill(0);
  const porCategoria = {};
  for (const f of fornecedores) {
    f.porMes.forEach((v, i) => (porMes[i] += v));
    if (f.totalAno) porCategoria[f.categoria] = (porCategoria[f.categoria] ?? 0) + f.totalAno;
  }
  const porAno = {};
  for (const r of validas) porAno[r.dataEmissao.slice(0, 4)] = (porAno[r.dataEmissao.slice(0, 4)] ?? 0) + Number(r.valor);
  return {
    ano: anoSel,
    anos: anos.length ? anos : [anoSel],
    categorias: CATEGORIAS,
    fornecedores,
    totais: { ano: porMes.reduce((s, v) => s + v, 0), porMes, porCategoria, porAno, fornecedoresAtivos: fornecedores.filter((f) => f.totalAno > 0).length },
  };
}
