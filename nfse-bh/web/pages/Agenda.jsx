import React, { useEffect, useState } from 'react';
import { api, fmtBRL, fmtData, hoje } from '../lib.js';
import { Campo, Modal, Msg } from '../ui.jsx';

const NOVA = { clienteId: '', descricao: '', valor: '', frequencia: 'mensal', proximaData: '', fim: '', competencia: 'emissao', modo: 'lembrete', ativo: true };
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

export default function Agenda({ clientes, recarregarTudo }) {
  const [dados, setDados] = useState({ agendas: [], frequencias: {}, sugestoes: [] });
  const [form, setForm] = useState(null);
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState('');
  const [emitindo, setEmitindo] = useState(null);

  const carregar = () => api('/api/agendas').then(setDados).catch((e) => setErro(e.message));
  useEffect(() => { carregar(); }, []);

  async function salvar(a) {
    setErro('');
    try {
      await api('/api/agendas', { method: 'POST', body: a });
      setForm(null);
      carregar();
    } catch (e) {
      setErro(e.message);
    }
  }
  async function remover(a) {
    if (!confirm('Remover este planejamento?')) return;
    await api(`/api/agendas/${a.id}`, { method: 'DELETE' });
    carregar();
  }
  async function emitir(a, simular) {
    setErro('');
    try {
      const n = await api(`/api/agendas/${a.id}/emitir`, { method: 'POST', body: { simular, descricao: a.descricaoAjustada, valor: a.valorAjustado } });
      setAviso(`${a.cliente}: nota ${n.status}${n.numero ? ` nº ${n.numero}` : ''}.`);
      setEmitindo(null);
      carregar();
      recarregarTudo();
    } catch (e) {
      setErro(e.message);
      setEmitindo(null);
    }
  }

  // Calendário: próximas emissões nos próximos 90 dias, por mês
  const eventos = dados.agendas
    .flatMap((a) => a.proximas.map((d) => ({ data: d, agenda: a })))
    .sort((x, y) => x.data.localeCompare(y.data));
  const porMes = eventos.reduce((m, e) => ((m[e.data.slice(0, 7)] ??= []).push(e), m), {});
  const vencidas = dados.agendas.filter((a) => a.vencida);

  return (
    <section>
      {vencidas.length > 0 && (
        <div className="card destaque">
          <h2>Para emitir hoje ({vencidas.length})</h2>
          <ul className="lista">
            {vencidas.map((a) => (
              <li key={a.id}>
                <div><strong>{a.cliente}</strong><small>{fmtData(a.proximaData)} · {fmtBRL(String(a.valor).replace(/\./g, '').replace(',', '.'))}</small></div>
                <button className="pri curto" onClick={() => setEmitindo(a)}>Emitir</button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <Msg tipo="ok">{aviso}</Msg>
      <Msg tipo="erro">{erro}</Msg>

      {form ? (
        <FormAgenda inicial={form} clientes={clientes} frequencias={dados.frequencias} aoSalvar={salvar} aoCancelar={() => setForm(null)} />
      ) : (
        <div className="card">
          <div className="linha-info">
            <h2>Planejamento de emissões</h2>
            <button className="pri curto" onClick={() => setForm({ ...NOVA, proximaData: hoje() })}>+ Planejar</button>
          </div>
          <p className="vazio">
            <strong>Lembrete</strong>: a nota aparece em “Para emitir hoje” e você emite com um clique.{' '}
            <strong>Automático</strong>: a aplicação emite sozinha na data (com ela aberta), sem confirmação — só em produção;
            {dados.ambiente !== 'producao' ? ' agora, em homologação, as automáticas aparecem como lembrete.' : ''}
          </p>
          {dados.agendas.length === 0 && <p className="vazio">Nenhuma emissão planejada.</p>}
          <ul className="lista">
            {dados.agendas.map((a) => (
              <li key={a.id}>
                <div>
                  <strong>{a.cliente}</strong>
                  <small>
                    {dados.frequencias[a.frequencia]} · {fmtBRL(String(a.valor).replace(/\./g, '').replace(',', '.'))} · {a.modo === 'automatico' ? 'automático' : 'lembrete'}
                    {a.ativo ? ` · próxima ${fmtData(a.proximaData)}` : ' · pausada'}
                  </small>
                  {a.erro && <small className="txt-erro">Última tentativa: {a.erro}{a.pausadaPorErro ? ' (pausada — corrija e salve de novo)' : ''}</small>}
                </div>
                <div className="acoes">
                  {a.ativo && a.proximaData && <button className="sec" onClick={() => setEmitindo(a)}>Emitir agora</button>}
                  <button className="sec" onClick={() => salvar({ ...a, ativo: !a.ativo })}>{a.ativo ? 'Pausar' : 'Ativar'}</button>
                  <button className="sec" onClick={() => setForm(a)}>Editar</button>
                  <button className="sec" onClick={() => remover(a)}>✕</button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {dados.sugestoes.length > 0 && !form && (
        <div className="card">
          <h2>Sugestões a partir do histórico</h2>
          <p className="vazio">Clientes com notas nos últimos 3 meses seguidos:</p>
          <ul className="lista">
            {dados.sugestoes.map((s) => (
              <li key={s.clienteId}>
                <div><strong>{s.cliente}</strong><small>mensal · dia {s.dia} · {fmtBRL(s.valor)}</small></div>
                <button className="sec" onClick={() => setForm({ ...NOVA, clienteId: s.clienteId, descricao: s.descricao, valor: Number(s.valor).toLocaleString('pt-BR', { minimumFractionDigits: 2 }), proximaData: proximoDia(s.dia), diaMes: s.dia })}>Planejar</button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="card">
        <h2>Calendário (90 dias)</h2>
        {eventos.length === 0 && <p className="vazio">Nada programado.</p>}
        {Object.entries(porMes).map(([mes, evs]) => (
          <div key={mes} className="mes">
            <h3>{MESES[Number(mes.slice(5, 7)) - 1]}/{mes.slice(0, 4)} <small>· {fmtBRL(evs.reduce((s, e) => s + Number(String(e.agenda.valor).replace(/\./g, '').replace(',', '.')), 0))}</small></h3>
            <ul className="lista compacta">
              {evs.map((e, i) => (
                <li key={i}>
                  <span className="dia">{e.data.slice(8, 10)}</span>
                  <span className="flex1">{e.agenda.cliente}</span>
                  <span>{fmtBRL(String(e.agenda.valor).replace(/\./g, '').replace(',', '.'))}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {emitindo && (
        <Modal titulo="Emitir nota planejada" aoFechar={() => setEmitindo(null)}>
          <dl className="resumo">
            <dt>Cliente</dt><dd>{emitindo.cliente}</dd>
            <dt>Competência</dt><dd>{emitindo.competencia === 'mes_anterior' ? 'último dia do mês anterior' : 'data de hoje'}</dd>
          </dl>
          <Campo label="Descrição desta nota" dica="Ajuste o que muda no mês (ex.: nº do pedido). Variáveis como {{valor}} e {{MesAnterior}} são substituídas na emissão.">
            <textarea rows={4} value={emitindo.descricaoAjustada ?? emitindo.descricao} onChange={(e) => setEmitindo({ ...emitindo, descricaoAjustada: e.target.value })} />
          </Campo>
          <Campo label="Valor (R$)">
            <input inputMode="decimal" value={emitindo.valorAjustado ?? emitindo.valor} onChange={(e) => setEmitindo({ ...emitindo, valorAjustado: e.target.value })} />
          </Campo>
          {/\[informar\]/i.test(emitindo.descricaoAjustada ?? emitindo.descricao) && <Msg tipo="alerta">Substitua os trechos “[informar]” antes de emitir.</Msg>}
          <div className="acoes">
            <button className="sec" onClick={() => setEmitindo(null)}>Voltar</button>
            <button className="sec" onClick={() => emitir(emitindo, true)}>Simular</button>
            <button className="pri curto" onClick={() => emitir(emitindo, false)}>Emitir NFS-e</button>
          </div>
        </Modal>
      )}
    </section>
  );
}

function proximoDia(dia) {
  const h = hoje();
  let [a, m] = h.split('-').map(Number);
  const cand = (aa, mm) => `${aa}-${String(mm).padStart(2, '0')}-${String(Math.min(dia, new Date(Date.UTC(aa, mm, 0)).getUTCDate())).padStart(2, '0')}`;
  if (cand(a, m) >= h) return cand(a, m);
  m++;
  if (m > 12) [a, m] = [a + 1, 1];
  return cand(a, m);
}

function FormAgenda({ inicial, clientes, frequencias, aoSalvar, aoCancelar }) {
  const [f, setF] = useState(inicial);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const cliente = clientes.find((c) => c.id === f.clienteId);
  function escolherCliente(e) {
    const c = clientes.find((x) => x.id === e.target.value);
    setF({
      ...f,
      clienteId: e.target.value,
      descricao: f.descricao || c?.descricaoPadrao || '',
      valor: f.valor || (c?.valorPadrao ? Number(c.valorPadrao).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : ''),
    });
  }
  return (
    <form className="card" onSubmit={(e) => { e.preventDefault(); aoSalvar({ ...f, diaMes: f.diaMes && f.proximaData?.slice(8, 10) === String(f.diaMes).padStart(2, '0') ? f.diaMes : Number(f.proximaData?.slice(8, 10)) }); }}>
      <h2>{f.id ? 'Editar planejamento' : 'Planejar emissão'}</h2>
      <Campo label="Cliente">
        <select value={f.clienteId} onChange={escolherCliente} required>
          <option value="">Selecione…</option>
          {clientes.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
        </select>
      </Campo>
      <Campo label="Descrição" dica="Aceita {{mes}}, {{mesAnterior}}, {{ano}} — ex.: “Mentoria – {{mesAnterior}}/{{ano}}”">
        <textarea rows={3} value={f.descricao} onChange={set('descricao')} required />
      </Campo>
      <div className="grade3">
        <Campo label="Valor (R$)"><input value={f.valor} onChange={set('valor')} inputMode="decimal" required /></Campo>
        <Campo label="Frequência">
          <select value={f.frequencia} onChange={set('frequencia')}>
            {Object.entries(frequencias).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Campo>
        <Campo label={f.frequencia === 'unica' ? 'Data' : 'Próxima emissão'}><input type="date" value={f.proximaData} onChange={set('proximaData')} required /></Campo>
        {f.frequencia !== 'unica' && <Campo label="Até (opcional)"><input type="date" value={f.fim ?? ''} onChange={set('fim')} /></Campo>}
        <Campo label="Competência">
          <select value={f.competencia} onChange={set('competencia')}>
            <option value="emissao">Data da emissão</option>
            <option value="mes_anterior">Mês anterior (serviço já prestado)</option>
          </select>
        </Campo>
        <Campo label="Modo">
          <select value={f.modo} onChange={set('modo')}>
            <option value="lembrete">Lembrete (eu confirmo)</option>
            <option value="automatico">Automático (emite sozinho)</option>
          </select>
        </Campo>
      </div>
      {f.modo === 'automatico' && <Msg tipo="alerta">No modo automático a nota é emitida na data sem pedir confirmação. Use primeiro em homologação.</Msg>}
      {cliente?.issRetido && <p className="vazio">Este cliente retém ISS: a nota sai com retenção.</p>}
      <div className="acoes esq">
        <button className="pri curto" type="submit">Salvar</button>
        <button type="button" className="sec" onClick={aoCancelar}>Cancelar</button>
      </div>
    </form>
  );
}
