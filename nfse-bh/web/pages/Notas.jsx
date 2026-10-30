import React, { useEffect, useMemo, useState } from 'react';
import { api, baixarCsv, fmtBRL, fmtData, fmtDoc, hoje, SITUACAO } from '../lib.js';
import { Badge, Campo, Kpi, Modal, Msg, Situacao } from '../ui.jsx';

const FILTROS = [
  ['abertas', 'Em aberto'],
  ['atrasada', 'Em atraso'],
  ['aguardando', 'Aguardando'],
  ['pago', 'Pagas'],
  ['cancelada', 'Canceladas'],
  ['substituida', 'Substituídas'],
  ['todas', 'Todas'],
  ['outras', 'Rejeitadas/simuladas'],
];

export default function Notas({ notas, clientes, recarregar, notaInicial }) {
  const [filtro, setFiltro] = useState('todas');
  const [clienteId, setClienteId] = useState('');
  const [mes, setMes] = useState('');
  const [busca, setBusca] = useState('');
  const [aberta, setAberta] = useState(notaInicial ?? null);
  const [mensagem, setMensagem] = useState(null);
  useEffect(() => {
    if (notaInicial) setAberta(notaInicial);
  }, [notaInicial]);

  const fiscais = notas.filter((n) => n.situacaoAtual);
  const kpis = useMemo(() => {
    const ano = hoje().slice(0, 4);
    const mesAtual = hoje().slice(0, 7);
    const abertas = fiscais.filter((n) => ['aguardando', 'atrasada'].includes(n.situacaoAtual));
    const atrasadas = abertas.filter((n) => n.situacaoAtual === 'atrasada');
    const soma = (l, f = (n) => Number(n.valorAPagar)) => l.reduce((s, n) => s + f(n), 0);
    return {
      aberto: soma(abertas), qAberto: abertas.length,
      atraso: soma(atrasadas), qAtraso: atrasadas.length,
      pagoMes: soma(fiscais.filter((n) => n.situacaoAtual === 'pago' && (n.dataPagamento ?? '').startsWith(mesAtual)), (n) => Number(n.valorPago ?? n.valorAPagar)),
      faturadoAno: soma(fiscais.filter((n) => (n.dataEmissao ?? '').startsWith(ano) && !['cancelada', 'substituida'].includes(n.situacaoAtual)), (n) => Number(n.valor)),
    };
  }, [notas]);

  const lista = notas.filter((n) => {
    const s = n.situacaoAtual;
    if (filtro === 'abertas' && !['aguardando', 'atrasada'].includes(s)) return false;
    if (filtro === 'outras' && s) return false;
    if (filtro === 'todas' && !s) return false; // simuladas/rejeitadas têm filtro próprio
    if (!['abertas', 'outras', 'todas'].includes(filtro) && s !== filtro) return false;
    if (clienteId && n.clienteId !== clienteId) return false;
    if (mes && !(n.dataEmissao ?? n.criadaEm).startsWith(mes)) return false;
    if (busca) {
      const t = `${n.tomador?.nome} ${n.numero} ${n.descricao} ${n.observacoes}`.toLowerCase();
      if (!t.includes(busca.toLowerCase())) return false;
    }
    return true;
  });

  function exportar() {
    baixarCsv(`notas-${hoje()}.csv`, [
      ['Número', 'Cliente', 'CNPJ/CPF', 'Emissão', 'Competência', 'Envio', 'Vencimento', 'Pagamento', 'Valor', 'Valor a receber', 'Valor pago', 'Situação', 'Chave', 'Observações'],
      ...lista.map((n) => [n.numero, n.tomador?.nome, fmtDoc(n.tomador?.documento), fmtData(n.dataEmissao), fmtData(n.competencia), fmtData(n.dataEnvio), fmtData(n.vencimento), fmtData(n.dataPagamento),
        Number(n.valor).toFixed(2).replace('.', ','), Number(n.valorAPagar).toFixed(2).replace('.', ','), n.valorPago ? Number(n.valorPago).toFixed(2).replace('.', ',') : '',
        SITUACAO[n.situacaoAtual]?.[0] ?? n.status, n.chaveAcesso, n.observacoes]),
    ]);
  }

  return (
    <section>
      <div className="kpis">
        <Kpi titulo="Em aberto" valor={fmtBRL(kpis.aberto)} sub={`${kpis.qAberto} nota(s)`} tom="alerta" />
        <Kpi titulo="Em atraso" valor={fmtBRL(kpis.atraso)} sub={`${kpis.qAtraso} nota(s)`} tom="erro" />
        <Kpi titulo="Recebido no mês" valor={fmtBRL(kpis.pagoMes)} tom="ok" />
        <Kpi titulo="Faturado no ano" valor={fmtBRL(kpis.faturadoAno)} />
      </div>

      <div className="card">
        <div className="filtros">
          {FILTROS.map(([k, t]) => (
            <button key={k} className={`chip ${filtro === k ? 'ativo' : ''}`} onClick={() => setFiltro(k)}>{t}</button>
          ))}
        </div>
        <div className="grade3">
          <Campo label="Cliente">
            <select value={clienteId} onChange={(e) => setClienteId(e.target.value)}>
              <option value="">Todos</option>
              {clientes.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
            </select>
          </Campo>
          <Campo label="Mês de emissão"><input type="month" value={mes} onChange={(e) => setMes(e.target.value)} /></Campo>
          <Campo label="Buscar"><input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="nº, cliente, descrição…" /></Campo>
        </div>
        <div className="linha-info">
          <span className="vazio">{lista.length} nota(s) · {fmtBRL(lista.reduce((s, n) => s + Number(n.valor), 0))}</span>
          <button className="sec" onClick={exportar} disabled={!lista.length}>Exportar CSV</button>
        </div>

        {lista.length === 0 && <p className="vazio">Nenhuma nota neste filtro.</p>}
        <div className="tabela">
          <div className="tr th">
            <span>Cliente</span><span>Nº</span><span>Envio</span><span>Vencimento</span><span>Pagamento</span><span className="num">Valor</span><span>Situação</span>
          </div>
          {lista.map((n) => (
            <React.Fragment key={n.id}>
              <button className={`tr ${aberta === n.id ? 'sel' : ''}`} onClick={() => setAberta(aberta === n.id ? null : n.id)}>
                <span className="cel-cliente"><strong>{n.tomador?.nome}</strong><small>emitida {fmtData(n.dataEmissao ?? n.criadaEm)}</small></span>
                <span data-l="Nº">{n.numero ?? `DPS ${n.nDPS ?? '—'}`}</span>
                <span data-l="Envio">{fmtData(n.dataEnvio)}</span>
                <span data-l="Vence">{fmtData(n.vencimento)}</span>
                <span data-l="Pago em">{fmtData(n.dataPagamento)}</span>
                <span className="num"><strong>{fmtBRL(n.valor)}</strong></span>
                <span>{n.situacaoAtual ? <Situacao valor={n.situacaoAtual} /> : <Badge valor={n.status} />}</span>
              </button>
              {aberta === n.id && <Detalhe nota={n} recarregar={recarregar} abrirMensagem={() => setMensagem(n)} />}
            </React.Fragment>
          ))}
        </div>
      </div>
      {mensagem && <Mensagem nota={mensagem} aoFechar={() => setMensagem(null)} recarregar={recarregar} />}
    </section>
  );
}

function Detalhe({ nota, recarregar, abrirMensagem }) {
  const [obs, setObs] = useState(nota.observacoes ?? '');
  const [dataEnvio, setDataEnvio] = useState(nota.dataEnvio ?? '');
  const [vencimento, setVencimento] = useState(nota.vencimento ?? '');
  const [baixa, setBaixa] = useState(null); // { tipo, dataPagamento, valorPago, chaveSubstituta }
  const [msg, setMsg] = useState('');
  const [erro, setErro] = useState('');

  async function salvar(campos, aviso = 'Salvo.') {
    setErro('');
    try {
      await api(`/api/notas/${nota.id}`, { method: 'PATCH', body: campos });
      setMsg(aviso);
      setBaixa(null);
      recarregar();
    } catch (e) {
      setErro(e.message);
    }
  }
  async function verificar() {
    try {
      await api(`/api/notas/${nota.id}/verificar`, { method: 'POST' });
      recarregar();
    } catch (e) {
      setErro(e.message);
    }
  }

  const fiscal = !!nota.situacaoAtual;
  return (
    <div className="detalhe">
      <dl className="resumo">
        <dt>Cliente</dt><dd>{nota.tomador?.nome} · {fmtDoc(nota.tomador?.documento)}</dd>
        <dt>Serviço</dt><dd className="pre">{nota.descricao}</dd>
        <dt>Valor</dt><dd>{fmtBRL(nota.valor)}{nota.issRetido ? ` · a receber ${fmtBRL(nota.valorAPagar)} (ISS retido)` : ''}</dd>
        <dt>Competência</dt><dd>{fmtData(nota.competencia)}</dd>
        {nota.chaveAcesso && <><dt>Chave</dt><dd className="mono">{nota.chaveAcesso}</dd></>}
        {nota.valorPago && <><dt>Valor pago</dt><dd>{fmtBRL(nota.valorPago)} {nota.baixa?.origem === 'extrato' ? '(baixa pelo extrato)' : ''}</dd></>}
        {nota.chaveSubstituta && <><dt>Substituta</dt><dd className="mono">{nota.chaveSubstituta}</dd></>}
        <dt>Origem</dt><dd>{{ importacao: 'Importada do histórico', agenda: 'Agenda', app: 'Emitida no app' }[nota.origem] ?? nota.origem ?? '—'}</dd>
      </dl>
      {(nota.erros ?? []).map((e, i) => <Msg key={i} tipo="erro"><strong>{e.codigo}</strong> {e.descricao}</Msg>)}
      {nota.status === 'pendente' && <button className="pri" onClick={verificar}>Verificar na Sefin</button>}

      {fiscal && (
        <>
          <div className="acoes esq">
            {nota.situacaoAtual !== 'pago' && <button className="ok-btn" onClick={() => setBaixa({ tipo: 'pago', dataPagamento: hoje(), valorPago: nota.valorAPagar })}>✓ Marcar como paga</button>}
            {nota.situacaoAtual !== 'cancelada' && <button className="sec" onClick={() => setBaixa({ tipo: 'cancelada' })}>Cancelada</button>}
            {nota.situacaoAtual !== 'substituida' && <button className="sec" onClick={() => setBaixa({ tipo: 'substituida', chaveSubstituta: '' })}>Substituída</button>}
            {!['aguardando', 'atrasada'].includes(nota.situacaoAtual) && <button className="sec" onClick={() => salvar({ baixa: { tipo: 'aguardando' } }, 'Baixa desfeita.')}>Desfazer baixa</button>}
            <button className="sec" onClick={abrirMensagem}>✉ Mensagem</button>
          </div>

          {baixa && (
            <div className="caixa">
              {baixa.tipo === 'pago' && (
                <div className="grade2">
                  <Campo label="Data do pagamento"><input type="date" value={baixa.dataPagamento} onChange={(e) => setBaixa({ ...baixa, dataPagamento: e.target.value })} /></Campo>
                  <Campo label="Valor recebido"><input inputMode="decimal" value={baixa.valorPago} onChange={(e) => setBaixa({ ...baixa, valorPago: e.target.value.replace(',', '.') })} /></Campo>
                </div>
              )}
              {baixa.tipo === 'cancelada' && <Msg tipo="alerta">Marca a nota como cancelada no controle. O cancelamento fiscal é feito no portal Emissor Nacional (ou importe o evento pelo ADN).</Msg>}
              {baixa.tipo === 'substituida' && (
                <Campo label="Chave da nota substituta (opcional)"><input value={baixa.chaveSubstituta} onChange={(e) => setBaixa({ ...baixa, chaveSubstituta: e.target.value.trim() })} /></Campo>
              )}
              <div className="acoes esq">
                <button className="pri" onClick={() => salvar({ baixa }, 'Baixa registrada.')}>Confirmar</button>
                <button className="sec" onClick={() => setBaixa(null)}>Cancelar</button>
              </div>
            </div>
          )}

          <div className="grade2">
            <Campo label="Data de envio ao cliente">
              <div className="linha">
                <input type="date" value={dataEnvio} onChange={(e) => setDataEnvio(e.target.value)} />
                <button className="sec" onClick={() => salvar({ dataEnvio })}>Salvar</button>
              </div>
            </Campo>
            <Campo label="Vencimento">
              <div className="linha">
                <input type="date" value={vencimento} onChange={(e) => setVencimento(e.target.value)} />
                <button className="sec" onClick={() => salvar({ vencimento })}>Salvar</button>
              </div>
            </Campo>
          </div>
        </>
      )}
      <Campo label="Observações">
        <textarea rows={2} value={obs} onChange={(e) => setObs(e.target.value)} placeholder="Ex.: cliente pediu nova data; pagamento parcial…" />
      </Campo>
      <div className="acoes esq">
        <button className="sec" onClick={() => salvar({ observacoes: obs })} disabled={obs === (nota.observacoes ?? '')}>Salvar observação</button>
        {nota.dpsXml && <a className="sec btn" href={`/api/notas/${nota.id}/xml/dps`}>XML DPS</a>}
        {nota.nfseXml && <a className="sec btn" href={`/api/notas/${nota.id}/xml/nfse`}>XML NFS-e</a>}
        {nota.chaveAcesso && <a className="sec btn" target="_blank" rel="noreferrer" href={`https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave=${nota.chaveAcesso}`}>DANFSe</a>}
      </div>
      <Msg tipo="ok">{msg}</Msg>
      <Msg tipo="erro">{erro}</Msg>
    </div>
  );
}

function Mensagem({ nota, aoFechar, recarregar }) {
  const [modelos, setModelos] = useState([]);
  const [modeloId, setModeloId] = useState('');
  const [m, setM] = useState(null);
  const [copiado, setCopiado] = useState('');

  useEffect(() => {
    api('/api/modelos').then((r) => setModelos(r.modelos));
  }, []);
  useEffect(() => {
    api(`/api/notas/${nota.id}/mensagem${modeloId ? `?modelo=${modeloId}` : ''}`).then((r) => {
      setM(r);
      if (!modeloId) setModeloId(r.modeloId);
    });
  }, [modeloId]);

  async function copiar(txt, o) {
    try {
      await navigator.clipboard.writeText(txt);
      setCopiado(o);
    } catch {
      setCopiado('erro');
    }
  }
  async function marcarEnviada() {
    await api(`/api/notas/${nota.id}`, { method: 'PATCH', body: { dataEnvio: hoje() } });
    recarregar();
    aoFechar();
  }

  if (!m) return null;
  const mailto = `mailto:${encodeURIComponent(m.para)}?subject=${encodeURIComponent(m.assunto)}&body=${encodeURIComponent(m.corpo)}`;
  const wa = m.whatsapp ? `https://wa.me/55${m.whatsapp.replace(/^55/, '')}?text=${encodeURIComponent(m.corpo)}` : null;
  return (
    <Modal titulo={`Mensagem · ${nota.tomador?.nome}`} aoFechar={aoFechar}>
      <Campo label="Modelo">
        <select value={modeloId} onChange={(e) => setModeloId(e.target.value)}>
          {modelos.map((x) => <option key={x.id} value={x.id}>{x.nome}</option>)}
        </select>
      </Campo>
      <Campo label="Para"><input value={m.para} onChange={(e) => setM({ ...m, para: e.target.value })} /></Campo>
      <Campo label="Assunto"><input value={m.assunto} onChange={(e) => setM({ ...m, assunto: e.target.value })} /></Campo>
      <Campo label="Texto"><textarea rows={12} value={m.corpo} onChange={(e) => setM({ ...m, corpo: e.target.value })} /></Campo>
      {nota.nfseXml && <p className="vazio">Anexe o XML/DANFSe ao e-mail: <a href={`/api/notas/${nota.id}/xml/nfse`}>baixar XML</a></p>}
      <div className="acoes esq">
        <a className="pri btn" href={mailto}>Abrir no e-mail</a>
        {wa && <a className="sec btn" href={wa} target="_blank" rel="noreferrer">WhatsApp</a>}
        <button className="sec" onClick={() => copiar(m.corpo, 'texto')}>{copiado === 'texto' ? 'Copiado ✓' : 'Copiar texto'}</button>
        <button className="sec" onClick={marcarEnviada}>Marcar como enviada hoje</button>
      </div>
    </Modal>
  );
}
