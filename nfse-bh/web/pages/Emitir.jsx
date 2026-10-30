import React, { useEffect, useState } from 'react';
import { api, fmtBRL, fmtData, fmtDoc, hoje } from '../lib.js';
import { Badge, Campo, Modal, Msg } from '../ui.jsx';

export default function Emitir({ status, clientes, clienteInicial, aoEmitir, irPara }) {
  const [clienteId, setClienteId] = useState(clienteInicial ?? '');
  const [descricao, setDescricao] = useState('');
  const [valor, setValor] = useState('');
  const [competencia, setCompetencia] = useState(hoje());
  const [vencimento, setVencimento] = useState('');
  const [previa, setPrevia] = useState(null);
  const [verXml, setVerXml] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState('');
  const [resultado, setResultado] = useState(null);

  const cliente = clientes.find((c) => c.id === clienteId);
  // Ao escolher o cliente, traz a descrição e o valor que ele costuma receber
  useEffect(() => {
    if (!cliente) return;
    setDescricao(cliente.descricaoPadrao ?? '');
    setValor(cliente.valorPadrao ? Number(cliente.valorPadrao).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : '');
    setVencimento('');
  }, [clienteId]);
  useEffect(() => {
    if (clienteInicial) setClienteId(clienteInicial);
  }, [clienteInicial]);

  const pedido = () => ({ clienteId, vencimento: vencimento || undefined, servico: { descricao, valor, competencia } });

  async function conferir(e) {
    e.preventDefault();
    setErro('');
    setResultado(null);
    try {
      const p = await api('/api/notas/preparar', { method: 'POST', body: pedido() });
      setPrevia(p);
      if (!vencimento) setVencimento(p.resumo.vencimento);
    } catch (e) {
      setErro(e.message);
    }
  }

  async function enviar(simular) {
    setOcupado(true);
    try {
      const nota = await api('/api/notas', { method: 'POST', body: { ...pedido(), confirmado: true, simular } });
      setResultado(nota);
      setPrevia(null);
      aoEmitir();
    } catch (e) {
      setErro(e.message);
      setPrevia(null);
    } finally {
      setOcupado(false);
    }
  }

  const producao = status?.ambiente === 'producao';
  const sp = status?.servicoPadrao;
  return (
    <section>
      <form className="card" onSubmit={conferir}>
        <h2>Nova NFS-e</h2>
        <p className="vazio">Emitente: <strong>{status?.prestador.nomeFantasia}</strong> · {fmtDoc(status?.prestador.cnpj)}</p>
        <Campo label="Cliente (tomador)">
          <div className="linha">
            <select value={clienteId} onChange={(e) => setClienteId(e.target.value)} required>
              <option value="">Selecione…</option>
              {clientes.map((c) => (
                <option key={c.id} value={c.id}>{c.nome} — {fmtDoc(c.documento)}</option>
              ))}
            </select>
            <button type="button" className="sec" onClick={() => irPara('clientes')}>+ Novo</button>
          </div>
        </Campo>
        {cliente && (
          <p className="vazio">
            Código {cliente.cTribNac || sp?.cTribNac} / {cliente.cTribMun || sp?.cTribMun}
            {cliente.issRetido ? ` · ISS retido pelo cliente (${cliente.aliquotaIss || sp?.aliquotaIss}%)` : ' · ISS não retido'}
            {cliente.diaVencimento ? ` · vence todo dia ${cliente.diaVencimento}` : ` · prazo ${cliente.prazoDias || status?.cobranca.prazoDias} dias`}
          </p>
        )}
        <Campo label="Descrição do serviço" dica={sp?.descricaoRodape ? `O rodapé padrão é acrescentado: “${sp.descricaoRodape.replace(/\n/g, ' · ')}”` : null}>
          <textarea rows={5} value={descricao} onChange={(e) => setDescricao(e.target.value)} maxLength={1800} required
            placeholder={'Mentoria executiva\nPacote 4 sessões – outubro/2026'} />
        </Campo>
        <div className="grade3">
          <Campo label="Valor (R$)">
            <input inputMode="decimal" value={valor} onChange={(e) => setValor(e.target.value)} placeholder="1.860,00" required />
          </Campo>
          <Campo label="Competência">
            <input type="date" value={competencia} max={hoje()} onChange={(e) => setCompetencia(e.target.value)} required />
          </Campo>
          <Campo label="Vencimento" dica="vazio = regra do cliente">
            <input type="date" value={vencimento} onChange={(e) => setVencimento(e.target.value)} />
          </Campo>
        </div>
        <Msg tipo="erro">{erro}</Msg>
        <button className="pri" type="submit">Conferir nota</button>
      </form>

      {resultado && (
        <div className="card">
          <h3>Resultado <Badge valor={resultado.status} /></h3>
          {resultado.chaveAcesso && (
            <dl className="resumo">
              <dt>Número</dt><dd>{resultado.numero ?? '—'}</dd>
              <dt>Chave</dt><dd className="mono">{resultado.chaveAcesso}</dd>
              <dt>Vencimento</dt><dd>{fmtData(resultado.vencimento)}</dd>
            </dl>
          )}
          <Msg>{resultado.mensagem}</Msg>
          {(resultado.erros ?? []).map((e, i) => (
            <Msg key={i} tipo="erro"><strong>{e.codigo}</strong> {e.descricao} {e.complemento}</Msg>
          ))}
          <div className="acoes esq">
            <button className="sec" onClick={() => irPara('notas', resultado.id)}>Abrir no controle de notas</button>
          </div>
        </div>
      )}

      {previa && (
        <Modal titulo="Confirme a emissão" aoFechar={() => !ocupado && setPrevia(null)}>
          <Msg tipo={producao ? 'erro' : 'alerta'}>
            {producao
              ? 'PRODUÇÃO: a NFS-e terá valor fiscal e não pode ser desfeita (só cancelada).'
              : 'Homologação (produção restrita): nota de teste, sem valor fiscal.'}
          </Msg>
          <dl className="resumo">
            <dt>Emitente</dt><dd>{status.prestador.nomeFantasia} · {fmtDoc(status.prestador.cnpj)}</dd>
            <dt>Tomador</dt><dd>{fmtDoc(previa.resumo.tomador.documento)} — {previa.resumo.tomador.nome}</dd>
            <dt>Serviço</dt><dd className="pre">{previa.resumo.descricao}</dd>
            <dt>Valor</dt><dd><strong>{fmtBRL(previa.resumo.valor)}</strong></dd>
            <dt>ISS</dt><dd>{previa.resumo.issRetido ? `Retido pelo tomador (${previa.resumo.aliquota}%)` : 'Não retido'}</dd>
            <dt>Competência</dt><dd>{fmtData(previa.resumo.competencia)}</dd>
            <dt>Vencimento</dt><dd>{fmtData(vencimento || previa.resumo.vencimento)}</dd>
            <dt>DPS</dt><dd>nº {previa.nDPS} · série {status.serie}</dd>
          </dl>
          <button className="link" onClick={() => setVerXml(!verXml)}>{verXml ? 'Ocultar' : 'Ver'} XML da DPS</button>
          {verXml && <pre className="xml">{previa.xml.replace(/></g, '>\n<')}</pre>}
          <div className="acoes">
            <button className="sec" onClick={() => setPrevia(null)} disabled={ocupado}>Voltar</button>
            <button className="sec" onClick={() => enviar(true)} disabled={ocupado}>Simular</button>
            <button className={producao ? 'perigo' : 'pri'} onClick={() => enviar(false)} disabled={ocupado}>
              {ocupado ? 'Enviando…' : 'Emitir NFS-e'}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
