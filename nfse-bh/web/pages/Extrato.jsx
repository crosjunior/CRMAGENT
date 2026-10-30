import React, { useEffect, useState } from 'react';
import { api, fmtBRL, fmtData, lerArquivoTexto } from '../lib.js';
import { Msg } from '../ui.jsx';

export default function Extrato({ notas, recarregarTudo }) {
  const [lancamentos, setLancamentos] = useState([]);
  const [resultado, setResultado] = useState(null);
  const [erro, setErro] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [aba, setAba] = useState('pendente');

  const carregar = () => api('/api/extrato').then(setLancamentos).catch((e) => setErro(e.message));
  useEffect(() => { carregar(); }, []);

  async function importar(e) {
    const arquivos = [...e.target.files];
    e.target.value = '';
    if (!arquivos.length) return;
    setOcupado(true);
    setErro('');
    const total = { lidos: 0, creditos: 0, jaImportados: 0, baixadas: [], sugestoes: 0, semNota: 0 };
    try {
      for (const f of arquivos) {
        const r = await api('/api/extrato', { method: 'POST', body: { nome: f.name, conteudo: await lerArquivoTexto(f) } });
        for (const k of ['lidos', 'creditos', 'jaImportados', 'sugestoes', 'semNota']) total[k] += r[k];
        total.baixadas.push(...r.baixadas);
      }
      setResultado(total);
      setAba(total.sugestoes ? 'pendente' : 'conciliado');
      carregar();
      recarregarTudo();
    } catch (e) {
      setErro(e.message);
    } finally {
      setOcupado(false);
    }
  }

  async function conciliar(l, notaId) {
    await api(`/api/extrato/${l.id}/conciliar`, { method: 'POST', body: { notaId } });
    carregar();
    recarregarTudo();
  }
  async function ignorar(l) {
    await api(`/api/extrato/${l.id}/ignorar`, { method: 'POST' });
    carregar();
  }

  const porId = Object.fromEntries(notas.map((n) => [n.id, n]));
  const abertas = notas.filter((n) => ['aguardando', 'atrasada'].includes(n.situacaoAtual));
  const filtrados = lancamentos.filter((l) => (aba === 'pendente' ? ['pendente', 'sem_nota'].includes(l.status) : l.status === aba));
  const cont = (s) => lancamentos.filter((l) => (s === 'pendente' ? ['pendente', 'sem_nota'].includes(l.status) : l.status === s)).length;

  return (
    <section>
      <div className="card">
        <h2>Conciliação bancária</h2>
        <p className="vazio">
          Importe o extrato (OFX, CSV ou TXT). Cada crédito é comparado com as notas em aberto pelo <strong>valor</strong> (bruto ou líquido, se houver
          ISS retido) e pelo <strong>nome ou CNPJ</strong> do cliente. Casamentos certos já dão baixa; os demais ficam para você confirmar.
        </p>
        <label className={`pri btn upload ${ocupado ? 'desab' : ''}`}>
          {ocupado ? 'Processando…' : 'Importar extrato'}
          <input type="file" accept=".ofx,.csv,.txt,.OFX,.CSV,.TXT" multiple onChange={importar} disabled={ocupado} hidden />
        </label>
        <Msg tipo="erro">{erro}</Msg>
        {resultado && (
          <div className="caixa">
            <strong>{resultado.baixadas.length} nota(s) baixada(s) automaticamente</strong>
            <small className="vazio">
              {resultado.lidos} lançamentos lidos · {resultado.creditos} créditos · {resultado.jaImportados} já importados antes · {resultado.sugestoes} para confirmar · {resultado.semNota} sem nota correspondente
            </small>
            <ul className="lista compacta">
              {resultado.baixadas.map((b) => (
                <li key={b.notaId}><span className="flex1">{b.cliente} {b.numero ? `· NFS-e ${b.numero}` : ''}</span><span>{fmtData(b.data)}</span><strong>{fmtBRL(b.valor)}</strong></li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="card">
        <div className="filtros">
          {[['pendente', 'A conferir'], ['conciliado', 'Conciliados'], ['ignorado', 'Ignorados']].map(([k, t]) => (
            <button key={k} className={`chip ${aba === k ? 'ativo' : ''}`} onClick={() => setAba(k)}>{t} ({cont(k)})</button>
          ))}
        </div>
        {filtrados.length === 0 && <p className="vazio">Nada aqui.</p>}
        <ul className="lista">
          {filtrados.map((l) => (
            <li key={l.id} className="col">
              <div className="linha-info">
                <div>
                  <strong>{fmtBRL(l.valor)}</strong> · {fmtData(l.data)}
                  <small>{l.descricao}</small>
                </div>
                {l.status === 'conciliado' && porId[l.notaId] && <small>→ {porId[l.notaId].tomador?.nome} {porId[l.notaId].numero ? `· NFS-e ${porId[l.notaId].numero}` : ''}</small>}
              </div>
              {['pendente', 'sem_nota'].includes(l.status) && (
                <div className="acoes esq">
                  {(l.sugestoes ?? []).map((s) => porId[s.notaId] && ['aguardando', 'atrasada'].includes(porId[s.notaId].situacaoAtual) && (
                    <button key={s.notaId} className="sec" onClick={() => conciliar(l, s.notaId)}>
                      ✓ {porId[s.notaId].tomador?.nome} · {porId[s.notaId].numero ?? 'DPS'} {s.score > 0 ? '' : '(nome não confere)'}
                    </button>
                  ))}
                  <select defaultValue="" onChange={(e) => e.target.value && conciliar(l, e.target.value)} className="sel-curto">
                    <option value="">Escolher outra nota…</option>
                    {abertas.map((n) => <option key={n.id} value={n.id}>{n.tomador?.nome} · {n.numero ?? 'DPS'} · {fmtBRL(n.valorAPagar)}</option>)}
                  </select>
                  <button className="sec" onClick={() => ignorar(l)}>Não é nota</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
