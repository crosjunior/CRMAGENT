import React, { useEffect, useState } from 'react';
import { api, baixarCsv, fmtBRL, fmtData, fmtDoc } from '../lib.js';
import { Campo, Kpi, Msg } from '../ui.jsx';

const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const CONFIANCA = { alta: 'alta', media: 'média', baixa: 'baixa' };

/** Barras verticais de uma série (total por mês), com dica ao passar o mouse. */
function BarrasMes({ valores, titulo }) {
  const [foco, setFoco] = useState(null);
  const max = Math.max(...valores, 1);
  return (
    <figure className="grafico">
      <figcaption>{titulo}</figcaption>
      <div className="barras" role="img" aria-label={`${titulo}: ${valores.map((v, i) => `${MESES[i]} ${fmtBRL(v)}`).join(', ')}`}>
        {valores.map((v, i) => (
          <div key={i} className="coluna" onMouseEnter={() => setFoco(i)} onMouseLeave={() => setFoco(null)} onFocus={() => setFoco(i)} onBlur={() => setFoco(null)} tabIndex={0}>
            {foco === i && <span className="dica">{MESES[i]} · {fmtBRL(v)}</span>}
            <div className="barra" style={{ height: `${(v / max) * 100}%` }} />
            <span className="rotulo-x">{MESES[i]}</span>
          </div>
        ))}
      </div>
    </figure>
  );
}

/** Barras horizontais ordenadas (total por categoria), com o valor escrito ao lado. */
function BarrasCategoria({ itens }) {
  const max = Math.max(...itens.map((i) => i.valor), 1);
  return (
    <figure className="grafico">
      <figcaption>Gasto por tipo de serviço</figcaption>
      {itens.length === 0 && <p className="vazio">Sem notas no ano.</p>}
      <ul className="hbarras">
        {itens.map((i) => (
          <li key={i.nome} title={`${i.nome}: ${fmtBRL(i.valor)}`}>
            <span className="hrotulo">{i.nome}</span>
            <span className="htrilho"><span className="hbarra" style={{ width: `${(i.valor / max) * 100}%` }} /></span>
            <span className="hvalor">{fmtBRL(i.valor)}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

export default function Fornecedores() {
  const [dados, setDados] = useState(null);
  const [ano, setAno] = useState('');
  const [categoria, setCategoria] = useState('');
  const [busca, setBusca] = useState('');
  const [aberto, setAberto] = useState(null);
  const [msg, setMsg] = useState('');
  const [ocupado, setOcupado] = useState(false);

  const carregar = (a = ano) => api(`/api/fornecedores${a ? `?ano=${a}` : ''}`).then((d) => { setDados(d); setAno(d.ano); });
  useEffect(() => { carregar(); }, []);

  async function enriquecer() {
    setOcupado(true);
    try {
      const r = await api('/api/fornecedores/enriquecer', { method: 'POST' });
      setMsg(`${r.consultados} fornecedor(es) consultado(s) na Receita${r.pendentes ? ` · ${r.pendentes} na próxima rodada` : ''}.`);
      carregar();
    } catch (e) {
      setMsg(e.message);
    } finally {
      setOcupado(false);
    }
  }
  async function mudarCategoria(f, cat) {
    await api(`/api/fornecedores/${f.documento}`, { method: 'PATCH', body: { categoria: cat } });
    carregar();
  }

  if (!dados) return <section className="card"><p className="vazio">Carregando…</p></section>;
  const { fornecedores, totais, categorias } = dados;
  const lista = fornecedores.filter((f) => (!categoria || f.categoria === categoria) && `${f.nome} ${f.nomeFantasia} ${f.documento}`.toLowerCase().includes(busca.toLowerCase()));
  const porCat = Object.entries(totais.porCategoria).map(([k, v]) => ({ nome: categorias[k], valor: v })).sort((a, b) => b.valor - a.valor);
  const semCnae = fornecedores.filter((f) => !f.consultado && f.documento.length === 14).length;
  const anos = Object.keys(totais.porAno).sort();

  function exportar() {
    const br = (v) => Number(v).toFixed(2).replace('.', ',');
    baixarCsv(`fornecedores-${ano}.csv`, [
      ['Fornecedor', 'CNPJ/CPF', 'Categoria', 'CNAE', 'Descrição CNAE', 'Município', `Total ${ano}`, `Notas ${ano}`, ...MESES.map((m) => `${m}/${ano}`), 'Total geral', 'A pagar'],
      ...lista.map((f) => [f.nome, fmtDoc(f.documento), categorias[f.categoria], f.cnae, f.cnaeDescricao, f.municipio && `${f.municipio}/${f.uf}`, br(f.totalAno), f.notasAno, ...f.porMes.map(br), br(f.totalGeral), br(f.aPagar)]),
    ]);
  }

  return (
    <section>
      <div className="kpis">
        <Kpi titulo={`Total em ${ano}`} valor={fmtBRL(totais.ano)} sub={`${totais.fornecedoresAtivos} fornecedor(es)`} />
        <Kpi titulo="Média mensal" valor={fmtBRL(totais.ano / Math.max(1, totais.porMes.filter((v) => v > 0).length))} sub="meses com notas" />
        <Kpi titulo="Maior categoria" valor={porCat[0]?.nome ?? '—'} sub={porCat[0] ? fmtBRL(porCat[0].valor) : ''} />
        <Kpi titulo="Todos os anos" valor={fmtBRL(anos.reduce((s, a) => s + totais.porAno[a], 0))} sub={anos.map((a) => `${a}: ${fmtBRL(totais.porAno[a])}`).join(' · ')} />
      </div>

      <div className="card">
        <div className="linha-info">
          <h2>Fornecedores</h2>
          <div className="linha">
            <select className="sel-curto" value={ano} onChange={(e) => carregar(e.target.value)} aria-label="Ano">
              {dados.anos.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
            <button className="sec" onClick={exportar} disabled={!lista.length}>Exportar CSV</button>
          </div>
        </div>
        <div className="duas-colunas">
          <BarrasMes valores={totais.porMes} titulo={`Total por mês · ${ano}`} />
          <BarrasCategoria itens={porCat} />
        </div>
        {semCnae > 0 && (
          <div className="linha-info caixa">
            <span className="vazio">{semCnae} fornecedor(es) sem CNAE consultado — a classificação usa só as descrições das notas.</span>
            <button className="sec" onClick={enriquecer} disabled={ocupado}>{ocupado ? 'Consultando…' : 'Consultar CNAE na Receita'}</button>
          </div>
        )}
        <Msg tipo="ok">{msg}</Msg>
      </div>

      <div className="card">
        <div className="grade2">
          <Campo label="Categoria">
            <select value={categoria} onChange={(e) => setCategoria(e.target.value)}>
              <option value="">Todas</option>
              {Object.entries(categorias).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Campo>
          <Campo label="Buscar"><input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="nome ou CNPJ" /></Campo>
        </div>
        {fornecedores.length === 0 && <p className="vazio">Nenhum fornecedor ainda. As notas recebidas (aba Recebidas) formam esta lista; a busca no portal roda a cada 15 dias, ou manualmente em Config.</p>}
        <div className="tabela tab-forn">
          {lista.length > 0 && <div className="tr th"><span>Fornecedor</span><span>Serviço</span><span className="num">{ano}</span><span className="num">Notas</span><span className="num">Total geral</span><span className="num">A pagar</span></div>}
          {lista.map((f) => (
            <React.Fragment key={f.documento}>
              <button className={`tr ${aberto === f.documento ? 'sel' : ''}`} onClick={() => setAberto(aberto === f.documento ? null : f.documento)}>
                <span className="cel-cliente"><strong>{f.nome}</strong><small>{fmtDoc(f.documento)}{f.municipio ? ` · ${f.municipio}/${f.uf}` : ''}{f.mei ? ' · MEI' : ''}</small></span>
                <span data-l="Serviço"><span className="badge neutro">{categorias[f.categoria]}</span></span>
                <span className="num" data-l={ano}><strong>{fmtBRL(f.totalAno)}</strong></span>
                <span className="num" data-l="Notas">{f.notasAno}</span>
                <span className="num" data-l="Geral">{fmtBRL(f.totalGeral)}</span>
                <span className="num" data-l="A pagar">{f.aPagar ? fmtBRL(f.aPagar) : '—'}</span>
              </button>
              {aberto === f.documento && (
                <div className="detalhe">
                  <dl className="resumo">
                    <dt>CNAE</dt><dd>{f.cnae ? `${f.cnae} – ${f.cnaeDescricao}` : 'não consultado'}</dd>
                    <dt>Classificação</dt>
                    <dd>
                      {f.categoriaManual ? 'definida por você' : `automática (confiança ${CONFIANCA[f.sugestao.confianca]})`}
                      {f.sugestao.motivo && <small>{f.sugestao.motivo}</small>}
                    </dd>
                    <dt>Última nota</dt><dd>{fmtData(f.ultimaNota)}</dd>
                    <dt>Média mensal</dt><dd>{fmtBRL(f.mediaMensal)} em {ano}</dd>
                    <dt>Por ano</dt><dd>{Object.entries(f.porAno).sort().map(([a, v]) => `${a}: ${fmtBRL(v)}`).join(' · ')}</dd>
                  </dl>
                  <Campo label="Tipo de serviço">
                    <select value={f.categoriaManual ? f.categoria : ''} onChange={(e) => mudarCategoria(f, e.target.value)}>
                      <option value="">Automático ({categorias[f.sugestao.categoria]})</option>
                      {Object.entries(categorias).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </Campo>
                  <table className="mini">
                    <thead><tr>{MESES.map((m) => <th key={m}>{m}</th>)}</tr></thead>
                    <tbody><tr>{f.porMes.map((v, i) => <td key={i}>{v ? v.toLocaleString('pt-BR', { maximumFractionDigits: 0 }) : '·'}</td>)}</tr></tbody>
                  </table>
                </div>
              )}
            </React.Fragment>
          ))}
        </div>
      </div>
    </section>
  );
}
