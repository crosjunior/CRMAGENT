import React, { useEffect, useRef, useState } from 'react';
import { api, fmtBRL } from '../lib.js';
import { Campo, Msg } from '../ui.jsx';

const TIPOS = { envio: 'Envio da nota', lembrete: 'Lembrete', cobranca: 'Cobrança', outro: 'Outro' };

export default function Mensagens({ notas }) {
  const [modelos, setModelos] = useState([]);
  const [variaveis, setVariaveis] = useState([]);
  const [sel, setSel] = useState(null);
  const [notaId, setNotaId] = useState('');
  const [previa, setPrevia] = useState(null);
  const [msg, setMsg] = useState('');
  const corpoRef = useRef(null);
  const [campoAtivo, setCampoAtivo] = useState('corpo');

  const carregar = (manter) =>
    api('/api/modelos').then((r) => {
      setModelos(r.modelos);
      setVariaveis(r.variaveis);
      if (!manter) setSel(r.modelos[0] ?? null);
    });
  useEffect(() => { carregar(); }, []);
  const exemplos = notas.filter((n) => n.situacaoAtual).slice(0, 30);
  useEffect(() => { if (!notaId && exemplos[0]) setNotaId(exemplos[0].id); }, [notas]);

  // Prévia ao vivo com os dados da nota escolhida
  useEffect(() => {
    if (!sel) return;
    const t = setTimeout(() => {
      api('/api/modelos/previa', { method: 'POST', body: { assunto: sel.assunto, corpo: sel.corpo, notaId } }).then(setPrevia).catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [sel?.assunto, sel?.corpo, notaId]);

  function inserir(v) {
    const token = `{{${v}}}`;
    if (campoAtivo === 'assunto') return setSel({ ...sel, assunto: (sel.assunto ?? '') + token });
    const el = corpoRef.current;
    const ini = el?.selectionStart ?? sel.corpo.length;
    const fim = el?.selectionEnd ?? ini;
    setSel({ ...sel, corpo: sel.corpo.slice(0, ini) + token + sel.corpo.slice(fim) });
    setTimeout(() => el?.focus(), 0);
  }
  async function salvar() {
    try {
      const salvo = await api('/api/modelos', { method: 'POST', body: sel });
      setSel(salvo);
      setMsg('Modelo salvo.');
      carregar(true);
    } catch (e) {
      setMsg(e.message);
    }
  }
  async function remover() {
    const r = await api(`/api/modelos/${sel.id}`, { method: 'DELETE' });
    setMsg(r.restauradoPadrao ? 'Modelo padrão restaurado.' : 'Modelo removido.');
    carregar();
  }

  return (
    <section>
      <div className="card">
        <div className="linha-info">
          <h2>Modelos de mensagem</h2>
          <button className="pri curto" onClick={() => setSel({ nome: 'Novo modelo', tipo: 'outro', assunto: '', corpo: '' })}>+ Novo</button>
        </div>
        <div className="filtros">
          {modelos.map((m) => (
            <button key={m.id} className={`chip ${sel?.id === m.id ? 'ativo' : ''}`} onClick={() => { setSel(m); setMsg(''); }}>{m.nome}</button>
          ))}
        </div>
        <p className="vazio">O modelo de envio de cada cliente é escolhido no cadastro dele. Em atraso, o sistema sugere o modelo de cobrança.</p>
      </div>

      {sel && (
        <div className="duas-colunas">
          <div className="card">
            <div className="grade2">
              <Campo label="Nome"><input value={sel.nome} onChange={(e) => setSel({ ...sel, nome: e.target.value })} /></Campo>
              <Campo label="Tipo">
                <select value={sel.tipo} onChange={(e) => setSel({ ...sel, tipo: e.target.value })}>
                  {Object.entries(TIPOS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </Campo>
            </div>
            <Campo label="Assunto (e-mail)"><input value={sel.assunto} onFocus={() => setCampoAtivo('assunto')} onChange={(e) => setSel({ ...sel, assunto: e.target.value })} /></Campo>
            <Campo label="Texto"><textarea ref={corpoRef} rows={14} value={sel.corpo} onFocus={() => setCampoAtivo('corpo')} onChange={(e) => setSel({ ...sel, corpo: e.target.value })} /></Campo>
            <p className="vazio">Clique para inserir no {campoAtivo === 'assunto' ? 'assunto' : 'texto'}:</p>
            <div className="filtros vars">
              {variaveis.map(([v, d]) => <button key={v} className="chip" title={d} onClick={() => inserir(v)}>{`{{${v}}}`}</button>)}
            </div>
            <Msg>{msg}</Msg>
            <div className="acoes esq">
              <button className="pri curto" onClick={salvar}>Salvar modelo</button>
              {sel.id && <button className="sec" onClick={remover}>{['envio', 'lembrete', 'cobranca'].includes(sel.id) ? 'Restaurar padrão' : 'Remover'}</button>}
            </div>
          </div>
          <div className="card">
            <h3>Prévia</h3>
            <Campo label="Com os dados da nota">
              <select value={notaId} onChange={(e) => setNotaId(e.target.value)}>
                {!exemplos.length && <option value="">(sem notas — prévia com dados do emitente)</option>}
                {exemplos.map((n) => <option key={n.id} value={n.id}>{n.tomador?.nome} · {n.numero ?? 'DPS'} · {fmtBRL(n.valor)}</option>)}
              </select>
            </Campo>
            {previa && (
              <div className="previa">
                <strong>{previa.assunto}</strong>
                <p className="pre">{previa.corpo}</p>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
