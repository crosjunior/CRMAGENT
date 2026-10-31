import React, { useEffect, useState } from 'react';
import { api, fmtBRL, fmtData, lerArquivoBase64, lerArquivoTexto } from '../lib.js';
import { Msg } from '../ui.jsx';

const MOTIVO_IGNORADO = { saldo: 'linha de saldo', aprendido: 'regra aprendida', voce: 'marcado por você' };
const SIT = { aguardando: 'em aberto', atrasada: 'em atraso', pago: 'paga', a_pagar: 'a pagar', vencida: 'vencida' };
const mesDe = (data, menos = 0) => {
  const d = new Date(`${data.slice(0, 7)}-15T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - menos);
  return d.toISOString().slice(0, 7);
};
const NOME_MES = (m) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString('pt-BR', { month: 'short', year: 'numeric', timeZone: 'UTC' });

/** Chips com os motivos do casamento: o que bateu entre o lançamento e a nota. */
function Motivos({ m = {}, presumida, jaConciliada, situacao }) {
  return (
    <span className="motivos">
      {m.documento && <span className="badge ok">CNPJ</span>}
      {m.aprendido && <span className="badge ok">aprendido</span>}
      {m.nome && !m.documento && <span className="badge ok">nome</span>}
      {m.valor === 'exato' && <span className="badge ok">valor exato</span>}
      {m.valor === 'retencao' && <span className="badge alerta">valor c/ retenção</span>}
      {m.periodo && <span className="badge neutro">período</span>}
      {presumida && <span className="badge alerta">marcada paga na importação</span>}
      {jaConciliada && <span className="badge erro">já conciliada</span>}
      {!presumida && !jaConciliada && situacao && SIT[situacao] && <span className="badge neutro">{SIT[situacao]}</span>}
    </span>
  );
}

function LinhaNota({ n, onLigar, rotulo = 'Ligar' }) {
  return (
    <li className="cand">
      <span className="flex1">
        <strong>{n.nome ?? '—'}</strong>
        <small>NFS-e {n.numero ?? 's/nº'} · emitida {fmtData(n.dataEmissao)} · {fmtBRL(n.valorAPagar ?? n.valor)}</small>
        <Motivos m={n.motivos} presumida={n.presumida} jaConciliada={n.jaConciliada} situacao={n.situacao} />
      </span>
      <button className="sec" onClick={onLigar}>{rotulo}</button>
    </li>
  );
}

/** Um lançamento a conferir: notas relacionadas, pesquisa por mês e importação da nota que faltava. */
function Pendente({ l, notas, recebidas, conciliar, ignorar, recarregar }) {
  const [busca, setBusca] = useState(null); // { mes, q, itens }
  const [msg, setMsg] = useState('');
  const [erro, setErro] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const fornecedor = l.alvo === 'recebida';
  const porId = fornecedor ? Object.fromEntries(recebidas.map((r) => [r.id, r])) : Object.fromEntries(notas.map((n) => [n.id, n]));

  const relacionadas = (l.sugestoes ?? [])
    .map((s) => {
      const x = porId[s.notaId ?? s.recebidaId];
      if (!x) return null;
      return {
        id: x.id, nome: fornecedor ? x.fornecedor?.nome : x.tomador?.nome, numero: x.numero, dataEmissao: x.dataEmissao, valor: x.valor, valorAPagar: x.valorAPagar,
        situacao: x.situacaoAtual, presumida: !fornecedor && x.situacao === 'pago' && !x.baixa, motivos: s.motivos ?? (s.score >= 0.5 ? { nome: s.score } : {}),
      };
    })
    .filter((x) => x && (fornecedor ? ['a_pagar', 'vencida'].includes(x.situacao) : ['aguardando', 'atrasada'].includes(x.situacao) || x.presumida));

  async function pesquisar(mes, q = busca?.q ?? '') {
    setBusca({ mes, q, itens: null });
    const itens = await api(`/api/extrato/${l.id}/notas?mes=${mes}&q=${encodeURIComponent(q)}`);
    setBusca({ mes, q, itens });
  }

  async function importarNota(e) {
    const arquivos = [...e.target.files];
    e.target.value = '';
    if (!arquivos.length) return;
    setOcupado(true);
    setErro('');
    setMsg('');
    try {
      const body = await Promise.all(arquivos.map(async (f) => (/\.xml$/i.test(f.name) ? { nome: f.name, conteudo: await lerArquivoTexto(f) } : { nome: f.name, base64: await lerArquivoBase64(f) })));
      const r = await api('/api/importar/arquivos', { method: 'POST', body: { arquivos: body } });
      const resolvido = (r.conciliacao?.conciliados ?? []).find((c) => c.lancamentoId === l.id);
      if (resolvido) {
        setMsg(`Nota importada e conciliada: ${resolvido.cliente ?? resolvido.fornecedor} · NFS-e ${resolvido.numero ?? ''}`);
      } else {
        setMsg(r.notasNovas + r.recebidasNovas ? 'Nota importada. Ela aparece em “Notas relacionadas” ou na pesquisa abaixo.' : 'A nota já estava cadastrada — use a pesquisa abaixo.');
        if (r.erros?.length) setErro(r.erros.join(' · '));
        pesquisar(mesDe(l.data, 1), '');
      }
      recarregar();
    } catch (e2) {
      setErro(e2.message);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div className="conferir">
      {relacionadas.length > 0 ? (
        <>
          <small className="vazio">Notas relacionadas (por CNPJ, nome, valor e data):</small>
          <ul className="lista compacta cands">
            {relacionadas.map((n) => <LinhaNota key={n.id} n={n} onLigar={() => conciliar(l, n.id)} />)}
          </ul>
        </>
      ) : (
        <small className="vazio">Nenhuma nota em aberto com este CNPJ, nome ou valor. Pesquise em outro mês ou importe a nota.</small>
      )}
      <div className="acoes esq">
        <button className="sec" onClick={() => (busca ? setBusca(null) : pesquisar(mesDe(l.data, 1)))}>{busca ? 'Fechar pesquisa' : 'Pesquisar notas de outros meses'}</button>
        <label className={`sec btn upload ${ocupado ? 'desab' : ''}`}>
          {ocupado ? 'Importando…' : 'Importar nota (PDF/XML)'}
          <input type="file" accept=".pdf,.xml,.zip,.PDF,.XML,.ZIP" multiple onChange={importarNota} disabled={ocupado} hidden />
        </label>
        <button className="sec" onClick={() => ignorar(l)} title="Lançamentos com a mesma descrição serão ignorados automaticamente">Não é nota</button>
      </div>
      <Msg tipo="ok">{msg}</Msg>
      <Msg tipo="erro">{erro}</Msg>
      {busca && (
        <div className="caixa">
          <div className="filtros">
            {[0, 1, 2, 3].map((k) => {
              const m = mesDe(l.data, k);
              return <button key={m} className={`chip ${busca.mes === m ? 'ativo' : ''}`} onClick={() => pesquisar(m)}>{k === 0 ? 'Mês do crédito' : k === 1 ? 'Mês anterior' : NOME_MES(m)}</button>;
            })}
            <button className={`chip ${busca.mes === '' ? 'ativo' : ''}`} onClick={() => pesquisar('')}>Todos os meses</button>
          </div>
          <div className="linha">
            <input type="month" value={busca.mes} onChange={(e) => pesquisar(e.target.value)} aria-label="Mês de emissão" />
            <input value={busca.q} onChange={(e) => setBusca({ ...busca, q: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && pesquisar(busca.mes, busca.q)} placeholder="cliente, CNPJ ou nº da nota" />
            <button className="sec" onClick={() => pesquisar(busca.mes, busca.q)}>Buscar</button>
          </div>
          {!busca.itens && <p className="vazio">Buscando…</p>}
          {busca.itens?.length === 0 && <p className="vazio">Nenhuma nota {busca.mes ? `emitida em ${NOME_MES(busca.mes)}` : ''}{busca.q ? ` com “${busca.q}”` : ''}. Se ela não foi importada, use “Importar nota”.</p>}
          <ul className="lista compacta cands">
            {busca.itens?.map((n) => (
              <LinhaNota key={n.notaId ?? n.recebidaId} n={n} rotulo={n.jaConciliada ? 'Trocar para este' : 'Ligar'}
                onLigar={() => (!n.jaConciliada || confirm('Esta nota já está conciliada com outro lançamento. Ligar a este? O outro volta para conferência.')) && conciliar(l, n.notaId ?? n.recebidaId)} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Regras que a aplicação aprendeu com as suas escolhas. */
function Regras({ versao }) {
  const [regras, setRegras] = useState(null);
  const [aberto, setAberto] = useState(false);
  const carregar = () => api('/api/extrato/regras').then(setRegras);
  useEffect(() => { carregar(); }, [versao]);
  if (!regras) return null;
  const total = regras.vinculos.length + regras.ignorar.length;
  async function remover(tipo, i) {
    setRegras(await api(`/api/extrato/regras/${tipo}/${i}`, { method: 'DELETE' }));
  }
  return (
    <div className="card">
      <div className="linha-info">
        <div>
          <h2>O que a aplicação aprendeu</h2>
          <small className="vazio">{total ? `${regras.vinculos.length} descrição(ões) ligada(s) a clientes/fornecedores · ${regras.ignorar.length} descrição(ões) ignorada(s)` : 'Cada nota que você liga e cada “Não é nota” vira uma regra para os próximos extratos.'}</small>
        </div>
        {total > 0 && <button className="sec" onClick={() => setAberto(!aberto)}>{aberto ? 'Ocultar' : 'Ver regras'}</button>}
      </div>
      {aberto && (
        <ul className="lista compacta">
          {regras.vinculos.map((r, i) => (
            <li key={`v${i}`} className="regra"><span className="flex1"><small>“{r.exemplo}”</small> → <strong>{r.nome ?? r.documento}</strong> <small>({r.vezes}×)</small></span><button className="sec" onClick={() => remover('vinculo', i)}>Esquecer</button></li>
          ))}
          {regras.ignorar.map((r, i) => (
            <li key={`i${i}`} className="regra"><span className="flex1"><small>“{r.exemplo}”</small> → <strong>ignorar</strong> <small>({r.vezes}×)</small></span><button className="sec" onClick={() => remover('ignorar', i)}>Esquecer</button></li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function Extrato({ notas, recebidas = [], recarregarTudo }) {
  const [lancamentos, setLancamentos] = useState([]);
  const [resultado, setResultado] = useState(null);
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [aba, setAba] = useState('pendente');
  const [versao, setVersao] = useState(0);

  const carregar = () => api('/api/extrato').then(setLancamentos).catch((e) => setErro(e.message));
  useEffect(() => { carregar(); }, []);
  const atualizar = () => {
    carregar();
    recarregarTudo();
    setVersao((v) => v + 1);
  };

  async function importar(e) {
    const arquivos = [...e.target.files];
    e.target.value = '';
    if (!arquivos.length) return;
    setOcupado(true);
    setErro('');
    const total = { lidos: 0, creditos: 0, jaImportados: 0, baixadas: [], pagas: [], sugestoes: 0, semNota: 0, ignorados: 0 };
    try {
      for (const f of arquivos) {
        const r = await api('/api/extrato', { method: 'POST', body: { nome: f.name, conteudo: await lerArquivoTexto(f) } });
        for (const k of ['lidos', 'creditos', 'jaImportados', 'sugestoes', 'semNota', 'ignorados']) total[k] += r[k] ?? 0;
        total.baixadas.push(...r.baixadas);
        total.pagas.push(...(r.pagas ?? []));
      }
      setResultado(total);
      setAba(total.sugestoes + total.semNota ? 'pendente' : 'conciliado');
      atualizar();
    } catch (e2) {
      setErro(e2.message);
    } finally {
      setOcupado(false);
    }
  }

  // Cada escolha pode resolver outros pendentes (mesma descrição): avisa quantos
  const relatar = (r) => {
    const n = r?.reprocessados?.conciliados?.length ?? 0;
    const i = r?.reprocessados?.ignorados ?? 0;
    setAviso(n || i ? `Aprendido. ${n ? `${n} outro(s) lançamento(s) conciliado(s)` : ''}${n && i ? ' e ' : ''}${i ? `${i} ignorado(s)` : ''} pela mesma regra.` : '');
  };
  async function conciliar(l, id) {
    const body = l.alvo === 'recebida' ? { recebidaId: id } : { notaId: id };
    relatar(await api(`/api/extrato/${l.id}/conciliar`, { method: 'POST', body }));
    atualizar();
  }
  async function ignorar(l) {
    relatar(await api(`/api/extrato/${l.id}/ignorar`, { method: 'POST', body: {} }));
    atualizar();
  }
  async function reabrir(l) {
    await api(`/api/extrato/${l.id}/reabrir`, { method: 'POST' });
    setAviso('Voltou para “A conferir” e a regra correspondente foi esquecida.');
    atualizar();
  }

  const porId = Object.fromEntries(notas.map((n) => [n.id, n]));
  const recPorId = Object.fromEntries(recebidas.map((r) => [r.id, r]));
  const pend = (l) => ['pendente', 'sem_nota'].includes(l.status);
  const filtrados = lancamentos.filter((l) => (aba === 'pendente' ? pend(l) : l.status === aba));
  const cont = (s) => lancamentos.filter((l) => (s === 'pendente' ? pend(l) : l.status === s)).length;

  return (
    <section>
      <div className="card">
        <h2>Conciliação bancária</h2>
        <p className="vazio">
          Importe o extrato (OFX, CSV ou TXT). Cada crédito é comparado com as notas pelo <strong>CNPJ</strong>, <strong>nome</strong>, <strong>valor</strong> (bruto ou líquido de retenções) e <strong>data</strong>.
          Quando cliente e valor batem, a baixa é automática. Linhas de saldo são ignoradas, e cada escolha sua ensina a aplicação para os próximos extratos.
        </p>
        <label className={`pri btn upload ${ocupado ? 'desab' : ''}`}>
          {ocupado ? 'Processando…' : 'Importar extrato'}
          <input type="file" accept=".ofx,.csv,.txt,.OFX,.CSV,.TXT" multiple onChange={importar} disabled={ocupado} hidden />
        </label>
        <Msg tipo="erro">{erro}</Msg>
        {resultado && (
          <div className="caixa">
            <strong>{resultado.baixadas.length} nota(s) emitida(s) recebida(s) e {resultado.pagas.length} nota(s) de fornecedor paga(s) — baixa automática</strong>
            <small className="vazio">
              {resultado.lidos} lançamentos lidos · {resultado.creditos} créditos · {resultado.jaImportados} já importados antes · {resultado.ignorados} ignorado(s) (saldo/regras) · {resultado.sugestoes} para confirmar · {resultado.semNota} sem nota relacionada
            </small>
            <ul className="lista compacta">
              {resultado.baixadas.map((b) => (
                <li key={b.notaId}><span className="flex1">{b.cliente} {b.numero ? `· NFS-e ${b.numero}` : ''}</span><span>{fmtData(b.data)}</span><strong>{fmtBRL(b.valor)}</strong></li>
              ))}
              {resultado.pagas.map((b) => (
                <li key={b.recebidaId}><span className="flex1">Pago a {b.fornecedor} {b.numero ? `· NFS-e ${b.numero}` : ''}</span><span>{fmtData(b.data)}</span><strong>−{fmtBRL(b.valor)}</strong></li>
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
        <Msg tipo="ok">{aviso}</Msg>
        {filtrados.length === 0 && <p className="vazio">Nada aqui.</p>}
        <ul className="lista">
          {filtrados.map((l) => (
            <li key={l.id} className="col">
              <div className="linha-info">
                <div>
                  <strong>{fmtBRL(l.valor)}</strong> · {fmtData(l.data)}
                  <small>{l.descricao}</small>
                  {l.status === 'conciliado' && porId[l.notaId] && <small>→ {porId[l.notaId].tomador?.nome} {porId[l.notaId].numero ? `· NFS-e ${porId[l.notaId].numero}` : ''} · emitida {fmtData(porId[l.notaId].dataEmissao)}</small>}
                  {l.status === 'conciliado' && recPorId[l.recebidaId] && <small>→ pagamento a {recPorId[l.recebidaId].fornecedor?.nome} {recPorId[l.recebidaId].numero ? `· NFS-e ${recPorId[l.recebidaId].numero}` : ''}</small>}
                  {l.status === 'ignorado' && <small>ignorado · {MOTIVO_IGNORADO[l.motivoIgnorado] ?? 'marcado por você'}</small>}
                </div>
                {!pend(l) && <button className="sec" onClick={() => reabrir(l)}>{l.status === 'conciliado' ? 'Desfazer' : 'Voltar para conferir'}</button>}
              </div>
              {pend(l) && <Pendente l={l} notas={notas} recebidas={recebidas} conciliar={conciliar} ignorar={ignorar} recarregar={atualizar} />}
            </li>
          ))}
        </ul>
      </div>

      <Regras versao={versao} />
    </section>
  );
}
