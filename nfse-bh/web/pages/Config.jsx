import React, { useEffect, useState } from 'react';
import { api, fmtData, fmtDoc, lerArquivoBase64, lerArquivoTexto, soDigitos } from '../lib.js';
import { Campo, Msg } from '../ui.jsx';

export default function Config({ status, recarregar, irPara }) {
  if (!status) return null;
  return (
    <section>
      <Importar status={status} recarregar={recarregar} irPara={irPara} />
      <Emitente status={status} recarregar={recarregar} />
      <Sistema status={status} recarregar={recarregar} />
    </section>
  );
}

function Importar({ status, recarregar, irPara }) {
  const [dias, setDias] = useState('45');
  const [ocupado, setOcupado] = useState('');
  const [r, setR] = useState(null);
  const [erro, setErro] = useState('');

  async function rodar(tipo, fn) {
    setOcupado(tipo);
    setErro('');
    setR(null);
    try {
      setR(await fn());
      recarregar();
    } catch (e) {
      setErro(e.message);
    } finally {
      setOcupado('');
    }
  }
  const opcoes = () => ({ pagasAteDias: dias === '' ? null : Number(dias) });

  async function arquivos(e) {
    const lista = [...e.target.files];
    e.target.value = '';
    if (!lista.length) return;
    await rodar('arquivos', async () => {
      const arqs = await Promise.all(lista.map(async (f) => (/\.xml$/i.test(f.name) ? { nome: f.name, conteudo: await lerArquivoTexto(f) } : { nome: f.name, base64: await lerArquivoBase64(f) })));
      return api('/api/importar/arquivos', { method: 'POST', body: { arquivos: arqs, opcoes: opcoes() } });
    });
  }

  return (
    <div className="card">
      <h2>Importar histórico de notas</h2>
      <p className="vazio">
        Traz as notas já emitidas, cadastra os clientes com as configurações usadas em cada um (código de serviço, ISS retido, descrição e valor
        habituais) e completa os dados da Conexão Ágil. Notas repetidas são ignoradas.
      </p>
      <Campo label="Notas emitidas há mais de N dias entram como pagas" dica="deixe vazio para importar todas como “aguardando pagamento” e baixar pelo extrato">
        <input value={dias} onChange={(e) => setDias(soDigitos(e.target.value))} inputMode="numeric" className="curto-input" />
      </Campo>
      <div className="acoes esq">
        <label className={`pri btn upload ${ocupado ? 'desab' : ''}`}>
          {ocupado === 'arquivos' ? 'Importando…' : 'Enviar notas (PDF, XML ou ZIP)'}
          <input type="file" accept=".xml,.zip,.pdf" multiple hidden onChange={arquivos} disabled={!!ocupado} />
        </label>
        <button className="sec" disabled={!!ocupado || !status.certificado.ok}
          onClick={() => rodar('adn', () => api('/api/importar/adn', { method: 'POST', body: { opcoes: opcoes() } }))}>
          {ocupado === 'adn' ? 'Sincronizando…' : 'Sincronizar com o portal (ADN)'}
        </button>
      </div>
      <p className="vazio">
        Aceita o PDF (DANFSe) ou o XML baixados do portal Emissor Nacional, soltos ou em ZIP. Ou use a sincronização, que baixa tudo direto do Ambiente
        Nacional com o seu certificado {status.ultimoNsuAdn ? `(último NSU ${status.ultimoNsuAdn})` : ''}.
      </p>
      <h3 className="secao">Pacote de dados e backup</h3>
      <p className="vazio">O pacote (.json) traz emitente, clientes, notas e agenda de uma vez — para restaurar um backup ou carregar dados preparados. Clientes são casados pelo CNPJ: nunca duplicam.</p>
      <div className="acoes esq">
        <label className={`sec btn upload ${ocupado ? 'desab' : ''}`}>
          {ocupado === 'pacote' ? 'Importando…' : 'Importar pacote (.json)'}
          <input type="file" accept=".json" hidden disabled={!!ocupado} onChange={async (e) => {
            const f = e.target.files[0];
            e.target.value = '';
            if (!f) return;
            await rodar('pacote', async () => {
              const p = await api('/api/importar/pacote', { method: 'POST', body: JSON.parse(await lerArquivoTexto(f)) });
              return { pacote: p };
            });
          }} />
        </label>
        <a className="sec btn" href="/api/backup">Baixar backup</a>
      </div>
      <Msg tipo="erro">{erro}</Msg>
      {r?.pacote && (
        <div className="caixa">
          <strong>Pacote importado: {r.pacote.clientesNovos} cliente(s) novo(s), {r.pacote.clientesAtualizados} atualizado(s), {r.pacote.notasNovas} nota(s), {r.pacote.agendas} agendamento(s)</strong>
          <small className="vazio">{r.pacote.notasExistentes} nota(s) já existiam{r.pacote.emitente ? ' · dados do emitente atualizados' : ''}</small>
          {r.pacote.avisos?.map((a, i) => <Msg key={i} tipo="alerta">{a}</Msg>)}
          <div className="acoes esq">
            <button className="sec" onClick={() => irPara('clientes')}>Ver clientes</button>
            <button className="sec" onClick={() => irPara('agenda')}>Ver agenda</button>
          </div>
        </div>
      )}
      {r && !r.pacote && (
        <div className="caixa">
          <strong>{r.notasNovas} nota(s) importada(s) · {r.clientes} cliente(s) cadastrado(s)/atualizado(s)</strong>
          <small className="vazio">
            {r.notasExistentes} já existiam · {r.eventos} cancelamento(s)/substituição(ões) aplicados · {r.ignorados} documento(s) ignorado(s) (notas recebidas ou de outro emitente)
          </small>
          {r.erros?.map((e, i) => <Msg key={i} tipo="erro">{e}</Msg>)}
          {r.sugestoesAgenda?.length > 0 && <Msg tipo="alerta">{r.sugestoesAgenda.length} cliente(s) com faturamento mensal recorrente — veja as sugestões na Agenda.</Msg>}
          <div className="acoes esq">
            <button className="sec" onClick={() => irPara('clientes')}>Ver clientes</button>
            <button className="sec" onClick={() => irPara('notas')}>Ver notas</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Emitente({ status, recarregar }) {
  const [p, setP] = useState(status.prestador);
  const [sp, setSp] = useState(status.servicoPadrao);
  const [cb, setCb] = useState(status.cobranca);
  const [serie, setSerie] = useState(status.serie);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    setP(status.prestador);
    setSp(status.servicoPadrao);
    setCb(status.cobranca);
  }, [status]);
  const setPr = (k) => (e) => setP({ ...p, [k]: e.target.value });
  const setEnd = (k) => (e) => setP({ ...p, endereco: { ...p.endereco, [k]: e.target.value } });
  const setS = (k) => (e) => setSp({ ...sp, [k]: e.target.value });
  const setC = (k) => (e) => setCb({ ...cb, [k]: e.target.value });

  async function salvar(e) {
    e.preventDefault();
    try {
      await api('/api/emitente', { method: 'PUT', body: { prestador: p, servicoPadrao: sp, cobranca: { ...cb, prazoDias: Number(cb.prazoDias) || 10 }, serie } });
      setMsg('Dados do emitente salvos.');
      recarregar();
    } catch (e) {
      setMsg(e.message);
    }
  }
  const e = p.endereco ?? {};
  return (
    <form className="card" onSubmit={salvar}>
      <h2>Emitente (prestador)</h2>
      <p className="vazio">Padrão de todas as notas. Contato e endereço podem vir automaticamente da importação do histórico.</p>
      <div className="grade2">
        <Campo label="Nome fantasia"><input value={p.nomeFantasia ?? ''} onChange={setPr('nomeFantasia')} /></Campo>
        <Campo label="Razão social"><input value={p.razaoSocial ?? ''} onChange={setPr('razaoSocial')} /></Campo>
        <Campo label="CNPJ" dica={fmtDoc(p.cnpj)}><input value={p.cnpj ?? ''} onChange={setPr('cnpj')} inputMode="numeric" /></Campo>
        <Campo label="Inscrição municipal (BH)"><input value={p.im ?? ''} onChange={setPr('im')} inputMode="numeric" /></Campo>
        <Campo label="E-mail"><input type="email" value={p.email ?? ''} onChange={setPr('email')} /></Campo>
        <Campo label="Telefone"><input value={p.fone ?? ''} onChange={setPr('fone')} inputMode="tel" /></Campo>
        <Campo label="Site"><input value={p.site ?? ''} onChange={setPr('site')} /></Campo>
        <Campo label="Regime">
          <select value={p.opSimpNac} onChange={setPr('opSimpNac')}>
            <option value="3">Simples Nacional — ME/EPP</option>
            <option value="2">Simples Nacional — MEI</option>
            <option value="1">Não optante</option>
          </select>
        </Campo>
        <Campo label="CEP"><input value={e.cep ?? ''} onChange={setEnd('cep')} inputMode="numeric" /></Campo>
        <Campo label="Logradouro"><input value={e.logradouro ?? ''} onChange={setEnd('logradouro')} /></Campo>
        <Campo label="Número"><input value={e.numero ?? ''} onChange={setEnd('numero')} /></Campo>
        <Campo label="Bairro"><input value={e.bairro ?? ''} onChange={setEnd('bairro')} /></Campo>
        <Campo label="Município"><input value={`${e.municipio ?? 'Belo Horizonte'} - ${e.uf ?? 'MG'}`} readOnly /></Campo>
      </div>

      <h3 className="secao">Serviço padrão</h3>
      <div className="grade3">
        <Campo label="Cód. tributação nacional" dica="08.02.01 Instrução e treinamento"><input value={sp.cTribNac} onChange={setS('cTribNac')} /></Campo>
        <Campo label="Cód. tributação municipal"><input value={sp.cTribMun} onChange={setS('cTribMun')} /></Campo>
        <Campo label="Código NBS (opcional)"><input value={sp.cNBS ?? ''} onChange={setS('cNBS')} /></Campo>
        <Campo label="Alíquota ISS (%)" dica="usada quando o cliente retém"><input value={sp.aliquotaIss ?? ''} onChange={setS('aliquotaIss')} /></Campo>
        <Campo label="% tributos aprox. (Simples)" dica="Lei 12.741 — alíquota efetiva da sua faixa"><input value={sp.pTotTribSN ?? ''} onChange={setS('pTotTribSN')} /></Campo>
        <Campo label="Série da DPS"><input value={serie} onChange={(ev) => setSerie(soDigitos(ev.target.value))} /></Campo>
      </div>
      <Campo label="Rodapé acrescentado a toda descrição">
        <textarea rows={2} value={sp.descricaoRodape ?? ''} onChange={setS('descricaoRodape')} />
      </Campo>

      <h3 className="secao">Dados para pagamento (usados nas mensagens)</h3>
      <div className="grade3">
        <Campo label="Banco"><input value={cb.banco ?? ''} onChange={setC('banco')} /></Campo>
        <Campo label="Agência"><input value={cb.agencia ?? ''} onChange={setC('agencia')} /></Campo>
        <Campo label="Conta"><input value={cb.conta ?? ''} onChange={setC('conta')} /></Campo>
        <Campo label="Chave PIX"><input value={cb.pix ?? ''} onChange={setC('pix')} /></Campo>
        <Campo label="Prazo padrão (dias)"><input value={cb.prazoDias ?? ''} onChange={setC('prazoDias')} inputMode="numeric" /></Campo>
      </div>
      <Msg tipo="ok">{msg}</Msg>
      <button className="pri curto" type="submit">Salvar emitente</button>
    </form>
  );
}

function Sistema({ status, recarregar }) {
  const [prox, setProx] = useState('');
  const c = status.certificado;
  async function salvarProx() {
    await api('/api/dps/proximo', { method: 'PUT', body: { proximo: Number(prox) } });
    setProx('');
    recarregar();
  }
  return (
    <div className="card">
      <h2>Sistema</h2>
      <dl className="resumo">
        <dt>Ambiente</dt><dd><span className={`badge ${status.ambiente === 'producao' ? 'erro' : 'alerta'}`}>{status.ambiente}</span></dd>
        <dt>Sefin</dt><dd className="mono">{status.sefinUrl}</dd>
        <dt>Certificado</dt>
        <dd>{c.ok ? <>{c.titular}<br /><small>válido até {fmtData(c.validoAte)}</small></> : <span className="txt-erro">{c.erro}</span>}</dd>
        <dt>Próxima DPS</dt><dd>nº {status.proximoNDPS} · série {status.serie}</dd>
      </dl>
      <Campo label="Ajustar próximo número da DPS" dica="Continue a numeração já usada no portal para não repetir número">
        <div className="linha">
          <input inputMode="numeric" value={prox} onChange={(e) => setProx(soDigitos(e.target.value))} />
          <button className="sec" onClick={salvarProx} disabled={!prox}>Salvar</button>
        </div>
      </Campo>
      <p className="vazio">Ambiente e certificado ficam no arquivo <code>.env</code> (reinicie após alterar).</p>
    </div>
  );
}
