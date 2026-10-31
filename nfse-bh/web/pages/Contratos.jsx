import React, { useEffect, useState } from 'react';
import { api, fmtBRL, fmtData, fmtDoc, hoje, lerArquivoBase64 } from '../lib.js';
import { Badge, Campo, Kpi, Msg } from '../ui.jsx';

const SIT_PARCELA = {
  prevista: ['Prevista', 'neutro'],
  agendada: ['Agendada', 'neutro'],
  a_faturar: ['A faturar', 'alerta'],
  faturada: ['Faturada', 'alerta'],
  paga: ['Paga', 'ok'],
  atrasada: ['Em atraso', 'erro'],
  cancelada: ['Cancelada', 'neutro'],
};
const FREQ = { mensal: 1, bimestral: 2, trimestral: 3, quadrimestral: 4, semestral: 6, anual: 12 };
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const num = (v) => (typeof v === 'number' ? v : Number(String(v ?? '').replace(/\./g, '').replace(',', '.')) || 0);
const somarMeses = (d, m) => {
  const x = new Date(`${d}T12:00:00Z`);
  const dia = x.getUTCDate();
  x.setUTCDate(1);
  x.setUTCMonth(x.getUTCMonth() + m);
  x.setUTCDate(Math.min(dia, new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate()));
  return x.toISOString().slice(0, 10);
};

export default function Contratos({ status, recarregarTudo }) {
  const [contratos, setContratos] = useState([]);
  const [rascunho, setRascunho] = useState(null);
  const [aberto, setAberto] = useState(null);
  const [erro, setErro] = useState('');
  const carregar = () => api('/api/contratos').then(setContratos).catch((e) => setErro(e.message));
  useEffect(() => { carregar(); }, []);

  const ativos = contratos.filter((c) => c.resumo.aFaturar > 0 || c.resumo.faturado > c.resumo.recebido);
  const soma = (f) => contratos.reduce((s, c) => s + f(c), 0);
  // Previsão de recebimento: parcelas ainda não pagas, pelo vencimento, nos próximos 6 meses
  const previsao = {};
  for (const c of contratos)
    for (const p of c.parcelas)
      if (!['paga', 'cancelada'].includes(p.situacao) && p.vencimento && p.valor) {
        const m = p.vencimento < hoje() ? 'atrasado' : p.vencimento.slice(0, 7);
        previsao[m] = (previsao[m] ?? 0) + p.valor;
      }
  const meses = Object.keys(previsao).filter((m) => m !== 'atrasado').sort().slice(0, 6);

  async function excluir(c) {
    if (!confirm(`Excluir o contrato "${c.titulo}"? Os agendamentos ainda não emitidos dele também saem.`)) return;
    await api(`/api/contratos/${c.id}`, { method: 'DELETE' });
    carregar();
    recarregarTudo();
  }
  async function agendar(c) {
    const r = await api(`/api/contratos/${c.id}/agendar`, { method: 'POST' });
    setErro('');
    alert(`${r.criadas} parcela(s) agendada(s) para emissão (aba Agenda).`);
    carregar();
    recarregarTudo();
  }

  return (
    <section>
      <div className="kpis">
        <Kpi titulo="Contratado" valor={fmtBRL(soma((c) => c.resumo.total ?? 0))} sub={`${ativos.length} contrato(s) ativo(s)`} />
        <Kpi titulo="Recebido" valor={fmtBRL(soma((c) => c.resumo.recebido))} tom="ok" />
        <Kpi titulo="A faturar" valor={fmtBRL(soma((c) => c.resumo.aFaturar))} tom="alerta" />
        <Kpi titulo="Em atraso" valor={fmtBRL(soma((c) => c.resumo.emAtraso))} tom="erro" />
      </div>

      {rascunho ? (
        <Editor inicial={rascunho} status={status} aoSalvar={() => { setRascunho(null); carregar(); recarregarTudo(); }} aoCancelar={() => setRascunho(null)} />
      ) : (
        <NovoContrato status={status} aoLer={setRascunho} />
      )}

      {(meses.length > 0 || previsao.atrasado) && (
        <div className="card">
          <h2>Previsão de recebimentos</h2>
          <ul className="lista compacta">
            {previsao.atrasado && <li><span className="flex1 txt-erro">Vencidas e não pagas</span><strong>{fmtBRL(previsao.atrasado)}</strong></li>}
            {meses.map((m) => <li key={m}><span className="flex1">{MESES[Number(m.slice(5)) - 1]}/{m.slice(0, 4)}</span><strong>{fmtBRL(previsao[m])}</strong></li>)}
          </ul>
        </div>
      )}

      <div className="card">
        <h2>Contratos ({contratos.length})</h2>
        <Msg tipo="erro">{erro}</Msg>
        {contratos.length === 0 && <p className="vazio">Nenhum contrato. Envie um contrato ou proposta acima para planejar os pagamentos do cliente.</p>}
        <ul className="lista">
          {contratos.map((c) => {
            const r = c.resumo;
            const pct = (v) => (r.total ? Math.min(100, (v / r.total) * 100) : 0);
            const semAgenda = c.parcelas.filter((p) => !p.agendaId && !p.notaId && p.emissao && p.valor && ['prevista', 'a_faturar', 'atrasada'].includes(p.situacao)).length;
            return (
              <li key={c.id} className="col">
                <button className="item" onClick={() => setAberto(aberto === c.id ? null : c.id)}>
                  <div>
                    <strong>{c.titulo || c.objeto}</strong>
                    <small>{c.cliente?.nome} · {fmtDoc(c.cliente?.documento)} · {c.tipo}{c.dataInicio ? ` · desde ${fmtData(c.dataInicio)}` : ''}</small>
                    <div className="progresso" title={`Recebido ${fmtBRL(r.recebido)} · faturado ${fmtBRL(r.faturado)} de ${fmtBRL(r.total)}`}>
                      <span className="p-recebido" style={{ width: `${pct(r.recebido)}%` }} />
                      <span className="p-faturado" style={{ width: `${pct(r.faturado - r.recebido)}%` }} />
                    </div>
                    <small>Recebido {fmtBRL(r.recebido)} · faturado {fmtBRL(r.faturado)} · total {fmtBRL(r.total)}{r.proxima ? ` · próxima: ${fmtBRL(r.proxima.valor)} em ${fmtData(r.proxima.emissao)}` : ''}</small>
                  </div>
                  <div className="dir">{r.emAtraso > 0 && <Badge mapa={SIT_PARCELA} valor="atrasada" />}</div>
                </button>
                {aberto === c.id && (
                  <div className="detalhe">
                    <dl className="resumo">
                      <dt>Objeto</dt><dd className="pre">{c.objeto}</dd>
                      <dt>Pagamento</dt><dd>{c.formaPagamento || '—'}</dd>
                      {c.reajuste && <><dt>Reajuste</dt><dd>{c.reajuste}</dd></>}
                      {c.multaAtraso && <><dt>Multa</dt><dd>{c.multaAtraso}</dd></>}
                      {c.arquivos?.length > 0 && <><dt>Arquivos</dt><dd>{c.arquivos.map((a) => <a key={a} className="link-arq" href={`/api/contratos/${c.id}/arquivo/${encodeURIComponent(a)}`}>{a}</a>)}</dd></>}
                    </dl>
                    <table className="mini parcelas">
                      <thead><tr><th>Nº</th><th>Descrição</th><th>Emitir em</th><th>Vence</th><th className="num">Valor</th><th>Situação</th></tr></thead>
                      <tbody>
                        {c.parcelas.map((p) => (
                          <tr key={p.id}>
                            <td>{p.numero}</td>
                            <td>{p.descricao}{p.regra ? <small> · {p.regra}</small> : null}</td>
                            <td>{fmtData(p.emissao)}</td>
                            <td>{fmtData(p.vencimento)}</td>
                            <td className="num">{p.valor != null ? fmtBRL(p.valor) : '—'}</td>
                            <td><Badge mapa={SIT_PARCELA} valor={p.situacao} />{p.notaNumero ? <small> NFS-e {p.notaNumero}</small> : null}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="acoes esq">
                      {semAgenda > 0 && <button className="pri curto" onClick={() => agendar(c)}>Agendar {semAgenda} parcela(s)</button>}
                      <button className="sec" onClick={() => setRascunho(c)}>Editar</button>
                      <button className="sec" onClick={() => excluir(c)}>Excluir</button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

function NovoContrato({ status, aoLer }) {
  const [arquivos, setArquivos] = useState([]);
  const [texto, setTexto] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState('');

  async function ler() {
    setOcupado(true);
    setErro('');
    try {
      const arqs = await Promise.all(arquivos.map(async (f) => ({ nome: f.name, base64: await lerArquivoBase64(f) })));
      const r = await api('/api/contratos/analisar', { method: 'POST', body: { arquivos: arqs, texto } });
      aoLer({ ...r.rascunho, _metodo: r.metodo, _aviso: r.aviso, _clienteExistente: r.clienteExistente, _arquivos: arqs });
    } catch (e) {
      setErro(e.message);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div className="card">
      <h2>Novo contrato ou proposta</h2>
      <p className="vazio">
        Envie o contrato/proposta (PDF, DOCX ou TXT) e/ou descreva as condições. A aplicação identifica cliente, valores e parcelas, e você revisa antes de salvar.
        {status?.leituraContratosIA
          ? ' Leitura com IA (Claude) ativa.'
          : ' Leitura por regras — para leitura com IA, coloque ANTHROPIC_API_KEY no arquivo .env.'}
      </p>
      <div className="acoes esq">
        <label className="sec btn upload">
          {arquivos.length ? `${arquivos.length} arquivo(s)` : 'Escolher arquivos'}
          <input type="file" accept=".pdf,.docx,.txt,.md" multiple hidden onChange={(e) => setArquivos([...e.target.files])} />
        </label>
        {arquivos.map((f) => <small key={f.name} className="vazio">{f.name}</small>)}
      </div>
      <Campo label="Ou cole/descreva as informações" dica='Ex.: "Proposta aceita pelo cliente, CNPJ 00.000.000/0001-00: 3 eventos de R$ 5.000,00 em jan, mai e set/2027, pagamento 30 dias após a nota"'>
        <textarea rows={4} value={texto} onChange={(e) => setTexto(e.target.value)} />
      </Campo>
      <Msg tipo="erro">{erro}</Msg>
      <div className="acoes esq">
        <button className="pri curto" onClick={ler} disabled={ocupado || (!arquivos.length && !texto.trim())}>{ocupado ? 'Lendo o documento…' : 'Ler e planejar pagamentos'}</button>
        <button className="sec" onClick={() => aoLer({ cliente: { documento: '', nome: '' }, tipo: 'contrato', titulo: '', objeto: '', parcelas: [], pendencias: [] })}>Preencher manualmente</button>
      </div>
    </div>
  );
}

function Editor({ inicial, status, aoSalvar, aoCancelar }) {
  const [c, setC] = useState({ ...inicial, parcelas: (inicial.parcelas ?? []).map((p) => ({ ...p })) });
  const [agendar, setAgendar] = useState(!inicial.id);
  const [gerador, setGerador] = useState({ qtd: '', valor: '', freq: 'mensal', inicio: hoje() });
  const [erro, setErro] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const set = (k) => (e) => setC({ ...c, [k]: e.target.value });
  const setParc = (i, k) => (e) => setC({ ...c, parcelas: c.parcelas.map((p, j) => (j === i ? { ...p, [k]: e.target.value } : p)) });
  const somaParcelas = c.parcelas.reduce((s, p) => s + num(p.valor), 0);
  const prazo = Number(status?.cobranca?.prazoDias ?? 10);

  function gerar() {
    const n = Number(gerador.qtd);
    if (!n || !gerador.inicio) return;
    const valor = num(gerador.valor) || (num(c.valorTotal) ? num(c.valorTotal) / n : 0);
    const parcelas = Array.from({ length: n }, (_, i) => {
      const emissao = somarMeses(gerador.inicio, i * FREQ[gerador.freq]);
      return { numero: i + 1, descricao: `Parcela ${i + 1}/${n}`, valor: Number(valor.toFixed(2)), emissao, vencimento: '', regra: '' };
    });
    setC({ ...c, parcelas });
  }
  async function salvar() {
    setOcupado(true);
    setErro('');
    try {
      const { _metodo, _aviso, _clienteExistente, _arquivos, resumo, ...dados } = c;
      await api('/api/contratos', { method: 'POST', body: { ...dados, arquivos: _arquivos ?? [], agendar } });
      aoSalvar();
    } catch (e) {
      setErro(e.message);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div className="card destaque">
      <h2>{c.id ? 'Editar contrato' : 'Revise o contrato'}</h2>
      {c._metodo && (
        <Msg tipo={c._metodo === 'ia' ? 'ok' : 'alerta'}>
          {c._metodo === 'ia' ? `Lido com IA · confiança ${c.confianca === 'media' ? 'média' : c.confianca}.` : 'Lido por regras: confira tudo.'} {c._aviso}
        </Msg>
      )}
      {(c.pendencias ?? []).map((p, i) => <Msg key={i} tipo="alerta">{p}</Msg>)}
      <div className="grade3">
        <Campo label="CNPJ/CPF do cliente" dica={c._clienteExistente ? `Cliente cadastrado: ${c._clienteExistente.nome}` : 'cliente novo é cadastrado ao salvar'}>
          <input value={c.cliente?.documento ?? ''} onChange={(e) => setC({ ...c, cliente: { ...c.cliente, documento: e.target.value } })} inputMode="numeric" />
        </Campo>
        <Campo label="Nome do cliente"><input value={c.cliente?.nome ?? ''} onChange={(e) => setC({ ...c, cliente: { ...c.cliente, nome: e.target.value } })} /></Campo>
        <Campo label="Tipo">
          <select value={c.tipo ?? 'contrato'} onChange={set('tipo')}>
            <option value="contrato">Contrato</option><option value="proposta">Proposta</option><option value="aditivo">Aditivo</option><option value="outro">Outro</option>
          </select>
        </Campo>
        <Campo label="Título"><input value={c.titulo ?? ''} onChange={set('titulo')} /></Campo>
        <Campo label="Início"><input type="date" value={c.dataInicio ?? ''} onChange={set('dataInicio')} /></Campo>
        <Campo label="Fim"><input type="date" value={c.dataFim ?? ''} onChange={set('dataFim')} /></Campo>
        <Campo label="Valor total (R$)" dica={somaParcelas ? `soma das parcelas: ${fmtBRL(somaParcelas)}` : null}><input value={c.valorTotal ?? ''} onChange={set('valorTotal')} inputMode="decimal" /></Campo>
        <Campo label="Reajuste"><input value={c.reajuste ?? ''} onChange={set('reajuste')} /></Campo>
        <Campo label="Multa por atraso"><input value={c.multaAtraso ?? ''} onChange={set('multaAtraso')} /></Campo>
      </div>
      <Campo label="Objeto (vai na descrição das notas)"><textarea rows={2} value={c.objeto ?? ''} onChange={set('objeto')} /></Campo>
      <Campo label="Condições de pagamento"><input value={c.formaPagamento ?? ''} onChange={set('formaPagamento')} /></Campo>
      {num(c.valorTotal) > 0 && somaParcelas > 0 && Math.abs(num(c.valorTotal) - somaParcelas) > 0.05 && (
        <Msg tipo="alerta">A soma das parcelas ({fmtBRL(somaParcelas)}) difere do valor total ({fmtBRL(num(c.valorTotal))}).</Msg>
      )}

      <h3 className="secao">Parcelas</h3>
      <div className="caixa gerador">
        <span>Gerar</span>
        <input className="curto-input" placeholder="nº" value={gerador.qtd} onChange={(e) => setGerador({ ...gerador, qtd: e.target.value })} inputMode="numeric" />
        <span>parcelas de</span>
        <input className="curto-input" placeholder="R$ (ou total ÷ nº)" value={gerador.valor} onChange={(e) => setGerador({ ...gerador, valor: e.target.value })} inputMode="decimal" />
        <select className="sel-curto" value={gerador.freq} onChange={(e) => setGerador({ ...gerador, freq: e.target.value })}>{Object.keys(FREQ).map((f) => <option key={f} value={f}>{f}</option>)}</select>
        <span>a partir de</span>
        <input type="date" className="sel-curto" value={gerador.inicio} onChange={(e) => setGerador({ ...gerador, inicio: e.target.value })} />
        <button className="sec" onClick={gerar}>Gerar</button>
      </div>
      <div className="tabela-parcelas">
        {c.parcelas.map((p, i) => (
          <div key={p.id ?? i} className="linha-parcela">
            <input className="pn" value={p.numero ?? i + 1} onChange={setParc(i, 'numero')} aria-label="Número" />
            <input className="pd" value={p.descricao ?? ''} onChange={setParc(i, 'descricao')} placeholder="Descrição" aria-label="Descrição" />
            <label><small>Emitir</small><input type="date" value={p.emissao ?? ''} onChange={setParc(i, 'emissao')} /></label>
            <label><small>Vence</small><input type="date" value={p.vencimento ?? ''} onChange={setParc(i, 'vencimento')} /></label>
            <input className="pv" value={p.valor ?? ''} onChange={setParc(i, 'valor')} placeholder="Valor" inputMode="decimal" aria-label="Valor" />
            <input className="pr" value={p.regra ?? ''} onChange={setParc(i, 'regra')} placeholder="Condição (se sem data)" aria-label="Condição" />
            <button className="link" onClick={() => setC({ ...c, parcelas: c.parcelas.filter((_, j) => j !== i) })} aria-label="Remover">✕</button>
          </div>
        ))}
      </div>
      <p className="vazio">Só uma das datas? A outra é calculada pelo prazo de pagamento padrão ({prazo} dias).</p>
      <button className="sec" onClick={() => setC({ ...c, parcelas: [...c.parcelas, { numero: c.parcelas.length + 1, descricao: `Parcela ${c.parcelas.length + 1}`, valor: '', emissao: '', vencimento: '', regra: '' }] })}>+ Parcela</button>

      <label className="check" style={{ marginTop: 14 }}>
        <input type="checkbox" checked={agendar} onChange={(e) => setAgendar(e.target.checked)} />
        <span>Agendar a emissão de cada nota na data prevista (aparece em Agenda → “Para emitir hoje”)</span>
      </label>
      <Msg tipo="erro">{erro}</Msg>
      <div className="acoes esq">
        <button className="pri curto" onClick={salvar} disabled={ocupado}>{ocupado ? 'Salvando…' : 'Salvar contrato'}</button>
        <button className="sec" onClick={aoCancelar}>Cancelar</button>
      </div>
    </div>
  );
}
