import React, { useMemo, useState } from 'react';
import { api, baixarCsv, fmtBRL, fmtData, fmtDoc, hoje } from '../lib.js';
import { Badge, Campo, Kpi, Msg } from '../ui.jsx';

const SITUACAO_R = {
  a_pagar: ['A pagar', 'alerta'],
  vencida: ['Vencida', 'erro'],
  pago: ['Pago', 'ok'],
  cancelada: ['Cancelada', 'neutro'],
};
const FILTROS = [['abertas', 'A pagar'], ['vencida', 'Vencidas'], ['pago', 'Pagas'], ['cancelada', 'Canceladas'], ['todas', 'Todas']];

/** Notas emitidas por fornecedores contra a empresa: controle de contas a pagar. */
export default function Recebidas({ recebidas, status, recarregar, irPara }) {
  const [filtro, setFiltro] = useState('todas');
  const [mes, setMes] = useState('');
  const [busca, setBusca] = useState('');
  const [aberta, setAberta] = useState(null);

  const kpis = useMemo(() => {
    const ano = hoje().slice(0, 4);
    const mesAtual = hoje().slice(0, 7);
    const soma = (l, f = (r) => Number(r.valorAPagar)) => l.reduce((s, r) => s + f(r), 0);
    const abertas = recebidas.filter((r) => ['a_pagar', 'vencida'].includes(r.situacaoAtual));
    const vencidas = abertas.filter((r) => r.situacaoAtual === 'vencida');
    return {
      aPagar: soma(abertas), qAPagar: abertas.length,
      vencidas: soma(vencidas), qVencidas: vencidas.length,
      pagoMes: soma(recebidas.filter((r) => r.situacaoAtual === 'pago' && (r.dataPagamento ?? '').startsWith(mesAtual)), (r) => Number(r.valorPago ?? r.valorAPagar)),
      ano: soma(recebidas.filter((r) => r.dataEmissao?.startsWith(ano) && r.situacaoAtual !== 'cancelada'), (r) => Number(r.valor)),
    };
  }, [recebidas]);

  const lista = recebidas.filter((r) => {
    const s = r.situacaoAtual;
    if (filtro === 'abertas' && !['a_pagar', 'vencida'].includes(s)) return false;
    if (!['abertas', 'todas'].includes(filtro) && s !== filtro) return false;
    if (mes && !r.dataEmissao?.startsWith(mes)) return false;
    if (busca && !`${r.fornecedor?.nome} ${r.numero} ${r.descricao}`.toLowerCase().includes(busca.toLowerCase())) return false;
    return true;
  });

  function exportar() {
    const br = (v) => (v == null ? '' : Number(v).toFixed(2).replace('.', ','));
    baixarCsv(`notas-recebidas-${hoje()}.csv`, [
      ['Número', 'Fornecedor', 'CNPJ/CPF', 'Emissão', 'Competência', 'Vencimento', 'Pagamento', 'Valor', 'Valor a pagar', 'ISS retido', 'Situação', 'Chave', 'Descrição', 'Observações'],
      ...lista.map((r) => [r.numero, r.fornecedor?.nome, fmtDoc(r.fornecedor?.documento), fmtData(r.dataEmissao), fmtData(r.competencia), fmtData(r.vencimento), fmtData(r.dataPagamento),
        br(r.valor), br(r.valorAPagar), r.issRetido ? 'Sim' : 'Não', SITUACAO_R[r.situacaoAtual]?.[0], r.chaveAcesso, r.descricao, r.observacoes]),
    ]);
  }

  return (
    <section>
      <div className="kpis">
        <Kpi titulo="A pagar" valor={fmtBRL(kpis.aPagar)} sub={`${kpis.qAPagar} nota(s)`} tom="alerta" />
        <Kpi titulo="Vencidas" valor={fmtBRL(kpis.vencidas)} sub={`${kpis.qVencidas} nota(s)`} tom="erro" />
        <Kpi titulo="Pago no mês" valor={fmtBRL(kpis.pagoMes)} tom="ok" />
        <Kpi titulo="Recebidas no ano" valor={fmtBRL(kpis.ano)} />
      </div>

      <p className="vazio aviso-busca">
        As notas de fornecedores chegam pela busca automática no portal, a cada 15 dias
        {status?.ultimaBuscaPortal?.em ? ` (última: ${fmtData(status.ultimaBuscaPortal.em)}, próxima: ${fmtData(status.proximaBuscaPortal)})` : ''}.{' '}
        <button className="link" onClick={() => irPara('config')}>Buscar agora em Config</button>
      </p>

      <div className="card">
        <h2>Notas recebidas de fornecedores</h2>
        <div className="filtros">
          {FILTROS.map(([k, t]) => <button key={k} className={`chip ${filtro === k ? 'ativo' : ''}`} onClick={() => setFiltro(k)}>{t}</button>)}
        </div>
        <div className="grade2">
          <Campo label="Mês de emissão"><input type="month" value={mes} onChange={(e) => setMes(e.target.value)} /></Campo>
          <Campo label="Buscar"><input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="fornecedor, nº, descrição…" /></Campo>
        </div>
        <div className="linha-info">
          <span className="vazio">{lista.length} nota(s) · {fmtBRL(lista.reduce((s, r) => s + Number(r.valor), 0))}</span>
          <button className="sec" onClick={exportar} disabled={!lista.length}>Exportar CSV</button>
        </div>
        {recebidas.length === 0 && (
          <p className="vazio">Nenhuma nota recebida ainda. A busca no portal roda a cada 15 dias (ou em Config → Buscar notas), ou envie os PDFs/XMLs em Config → Importar histórico: notas em que a empresa é tomadora entram aqui automaticamente.</p>
        )}
        <div className="tabela">
          {lista.length > 0 && (
            <div className="tr th"><span>Fornecedor</span><span>Nº</span><span>Emissão</span><span>Vencimento</span><span>Pagamento</span><span className="num">Valor</span><span>Situação</span></div>
          )}
          {lista.map((r) => (
            <React.Fragment key={r.id}>
              <button className={`tr ${aberta === r.id ? 'sel' : ''}`} onClick={() => setAberta(aberta === r.id ? null : r.id)}>
                <span className="cel-cliente"><strong>{r.fornecedor?.nome}</strong><small>{fmtDoc(r.fornecedor?.documento)}{r.fornecedor?.municipio ? ` · ${r.fornecedor.municipio}/${r.fornecedor.uf}` : ''}</small></span>
                <span data-l="Nº">{r.numero ?? '—'}</span>
                <span data-l="Emissão">{fmtData(r.dataEmissao)}</span>
                <span data-l="Vence">{fmtData(r.vencimento)}</span>
                <span data-l="Pago em">{fmtData(r.dataPagamento)}</span>
                <span className="num"><strong>{fmtBRL(r.valor)}</strong></span>
                <span><Badge mapa={SITUACAO_R} valor={r.situacaoAtual} /></span>
              </button>
              {aberta === r.id && <Detalhe r={r} recarregar={recarregar} />}
            </React.Fragment>
          ))}
        </div>
      </div>
    </section>
  );
}

function Detalhe({ r, recarregar }) {
  const [obs, setObs] = useState(r.observacoes ?? '');
  const [venc, setVenc] = useState(r.vencimento ?? '');
  const [pag, setPag] = useState(null);
  const [msg, setMsg] = useState('');
  const [erro, setErro] = useState('');
  async function salvar(campos, aviso = 'Salvo.') {
    setErro('');
    try {
      await api(`/api/recebidas/${r.id}`, { method: 'PATCH', body: campos });
      setMsg(aviso);
      setPag(null);
      recarregar();
    } catch (e) {
      setErro(e.message);
    }
  }
  return (
    <div className="detalhe">
      <dl className="resumo">
        <dt>Fornecedor</dt><dd>{r.fornecedor?.nome} · {fmtDoc(r.fornecedor?.documento)}{r.fornecedor?.email ? ` · ${r.fornecedor.email}` : ''}</dd>
        <dt>Serviço</dt><dd className="pre">{r.descricao}</dd>
        <dt>Valor</dt><dd>{fmtBRL(r.valor)}{r.issRetido ? ` · pagar ${fmtBRL(r.valorAPagar)} ao fornecedor (ISS retido: recolher ${fmtBRL(r.valorIss ?? Number(r.valor) - Number(r.valorAPagar))})` : ''}</dd>
        <dt>Competência</dt><dd>{fmtData(r.competencia)}</dd>
        <dt>Chave</dt><dd className="mono">{r.chaveAcesso}</dd>
        {r.valorPago && <><dt>Pago</dt><dd>{fmtBRL(r.valorPago)} em {fmtData(r.dataPagamento)}{r.baixa?.origem === 'extrato' ? ' (pelo extrato)' : ''}</dd></>}
      </dl>
      {r.issRetido && <Msg tipo="alerta">ISS retido: a Conexão Ágil, como tomadora, deve recolher o ISS desta nota (guia do município).</Msg>}
      <div className="acoes esq">
        {r.situacaoAtual !== 'pago' && <button className="ok-btn" onClick={() => setPag({ dataPagamento: hoje(), valorPago: r.valorAPagar })}>✓ Marcar como paga</button>}
        {r.situacaoAtual !== 'cancelada' && <button className="sec" onClick={() => salvar({ baixa: { tipo: 'cancelada' } }, 'Marcada como cancelada.')}>Cancelada</button>}
        {['pago', 'cancelada'].includes(r.situacaoAtual) && <button className="sec" onClick={() => salvar({ baixa: { tipo: 'a_pagar' } }, 'Voltou para a pagar.')}>Desfazer</button>}
        {r.danfsePdf && <a className="sec btn" href={`/api/recebidas/${r.id}/arquivo/pdf`}>PDF</a>}
        {r.nfseXml && <a className="sec btn" href={`/api/recebidas/${r.id}/arquivo/xml`}>XML</a>}
        <a className="sec btn" target="_blank" rel="noreferrer" href={`https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave=${r.chaveAcesso}`}>DANFSe</a>
      </div>
      {pag && (
        <div className="caixa">
          <div className="grade2">
            <Campo label="Data do pagamento"><input type="date" value={pag.dataPagamento} onChange={(e) => setPag({ ...pag, dataPagamento: e.target.value })} /></Campo>
            <Campo label="Valor pago"><input inputMode="decimal" value={pag.valorPago} onChange={(e) => setPag({ ...pag, valorPago: e.target.value.replace(',', '.') })} /></Campo>
          </div>
          <div className="acoes esq">
            <button className="pri curto" onClick={() => salvar({ baixa: { tipo: 'pago', ...pag } }, 'Pagamento registrado.')}>Confirmar</button>
            <button className="sec" onClick={() => setPag(null)}>Cancelar</button>
          </div>
        </div>
      )}
      <div className="grade2">
        <Campo label="Vencimento">
          <div className="linha">
            <input type="date" value={venc} onChange={(e) => setVenc(e.target.value)} />
            <button className="sec" onClick={() => salvar({ vencimento: venc })}>Salvar</button>
          </div>
        </Campo>
        <Campo label="Observações">
          <div className="linha">
            <input value={obs} onChange={(e) => setObs(e.target.value)} placeholder="Ex.: boleto vence dia 10" />
            <button className="sec" onClick={() => salvar({ observacoes: obs })} disabled={obs === (r.observacoes ?? '')}>Salvar</button>
          </div>
        </Campo>
      </div>
      <Msg tipo="ok">{msg}</Msg>
      <Msg tipo="erro">{erro}</Msg>
    </div>
  );
}
