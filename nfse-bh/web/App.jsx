import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

const api = async (url, opts = {}) => {
  const r = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.erro || `Erro HTTP ${r.status}`);
  return j;
};

const soDigitos = (s) => String(s ?? '').replace(/\D/g, '');
const fmtDoc = (d) => {
  d = soDigitos(d);
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  return d;
};
const fmtBRL = (v) => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const hoje = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);

const STATUS = {
  autorizada: ['Autorizada', 'ok'],
  rejeitada: ['Rejeitada', 'erro'],
  pendente: ['Pendente', 'alerta'],
  simulada: ['Simulada', 'neutro'],
  nao_processada: ['Não processada', 'neutro'],
};

function Badge({ status }) {
  const [txt, cls] = STATUS[status] ?? [status, 'neutro'];
  return <span className={`badge ${cls}`}>{txt}</span>;
}

function Campo({ label, children, dica }) {
  return (
    <label className="campo">
      <span>{label}</span>
      {children}
      {dica && <small>{dica}</small>}
    </label>
  );
}

// ---------- Emitir ----------
function Emitir({ status, clientes, aoEmitir, irParaClientes }) {
  const [clienteId, setClienteId] = useState('');
  const [descricao, setDescricao] = useState('');
  const [valor, setValor] = useState('');
  const [competencia, setCompetencia] = useState(hoje());
  const [previa, setPrevia] = useState(null);
  const [verXml, setVerXml] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState('');
  const [resultado, setResultado] = useState(null);

  const pedido = () => ({ clienteId, servico: { descricao, valor, competencia } });

  async function conferir(e) {
    e.preventDefault();
    setErro('');
    setResultado(null);
    try {
      setPrevia(await api('/api/notas/preparar', { method: 'POST', body: pedido() }));
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
      if (nota.status === 'autorizada') {
        setDescricao('');
        setValor('');
      }
      aoEmitir();
    } catch (e) {
      setErro(e.message);
      setPrevia(null);
    } finally {
      setOcupado(false);
    }
  }

  const producao = status?.ambiente === 'producao';
  return (
    <section>
      <form className="card" onSubmit={conferir}>
        <h2>Nova NFS-e</h2>
        <Campo label="Cliente (tomador)">
          <div className="linha">
            <select value={clienteId} onChange={(e) => setClienteId(e.target.value)} required>
              <option value="">Selecione…</option>
              {clientes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nome} — {fmtDoc(c.documento)}
                </option>
              ))}
            </select>
            <button type="button" className="sec" onClick={irParaClientes}>+ Novo</button>
          </div>
        </Campo>
        <Campo label="Descrição do serviço" dica={`Código ${status?.servicoPadrao.cTribNac} / municipal ${status?.servicoPadrao.cTribMun}`}>
          <textarea rows={5} value={descricao} onChange={(e) => setDescricao(e.target.value)} maxLength={1800} required
            placeholder={'Mentoria executiva\nPacote 4 sessões – outubro/2026'} />
        </Campo>
        <div className="grade2">
          <Campo label="Valor (R$)">
            <input inputMode="decimal" value={valor} onChange={(e) => setValor(e.target.value)} placeholder="1.860,00" required />
          </Campo>
          <Campo label="Competência">
            <input type="date" value={competencia} max={hoje()} onChange={(e) => setCompetencia(e.target.value)} required />
          </Campo>
        </div>
        {erro && <p className="msg erro">{erro}</p>}
        <button className="pri" type="submit">Conferir nota</button>
      </form>

      {resultado && <Resultado nota={resultado} />}

      {previa && (
        <div className="modal" role="dialog" aria-modal="true">
          <div className="card">
            <h2>Confirme a emissão</h2>
            <p className={`msg ${producao ? 'erro' : 'alerta'}`}>
              {producao
                ? 'PRODUÇÃO: a NFS-e terá valor fiscal e não pode ser desfeita (só cancelada).'
                : 'Homologação (produção restrita): nota de teste, sem valor fiscal.'}
            </p>
            <dl className="resumo">
              <dt>Tomador</dt><dd>{fmtDoc(previa.resumo.tomador.documento)} — {previa.resumo.tomador.nome}</dd>
              <dt>Serviço</dt><dd className="pre">{previa.resumo.descricao}</dd>
              <dt>Valor</dt><dd><strong>{fmtBRL(previa.resumo.valor)}</strong></dd>
              <dt>Competência</dt><dd>{previa.resumo.competencia.split('-').reverse().join('/')}</dd>
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
          </div>
        </div>
      )}
    </section>
  );
}

function Resultado({ nota }) {
  return (
    <div className="card">
      <h3>Resultado <Badge status={nota.status} /></h3>
      {nota.chaveAcesso && (
        <dl className="resumo">
          <dt>Número</dt><dd>{nota.numero ?? '—'}</dd>
          <dt>Chave</dt><dd className="mono">{nota.chaveAcesso}</dd>
        </dl>
      )}
      {nota.mensagem && <p className="msg">{nota.mensagem}</p>}
      {(nota.erros ?? []).map((e, i) => (
        <p key={i} className="msg erro"><strong>{e.codigo}</strong> {e.descricao} {e.complemento}</p>
      ))}
      <Downloads nota={nota} />
    </div>
  );
}

function Downloads({ nota }) {
  return (
    <div className="acoes esq">
      {nota.dpsXml && <a className="sec btn" href={`/api/notas/${nota.id}/xml/dps`}>XML DPS</a>}
      {nota.nfseXml && <a className="sec btn" href={`/api/notas/${nota.id}/xml/nfse`}>XML NFS-e</a>}
      {nota.chaveAcesso && (
        <a className="sec btn" target="_blank" rel="noreferrer"
          href={`https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave=${nota.chaveAcesso}`}>Consulta pública / DANFSe</a>
      )}
    </div>
  );
}

// ---------- Clientes ----------
const VAZIO = { documento: '', nome: '', email: '', fone: '', endereco: { cep: '', logradouro: '', numero: '', complemento: '', bairro: '', municipio: '', uf: '', cMun: '' } };

function Clientes({ clientes, recarregar }) {
  const [form, setForm] = useState(VAZIO);
  const [msg, setMsg] = useState('');
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const setEnd = (k) => (e) => setForm({ ...form, endereco: { ...form.endereco, [k]: e.target.value } });

  async function buscarCnpj() {
    const doc = soDigitos(form.documento);
    if (doc.length !== 14) return;
    setMsg('Consultando CNPJ…');
    try {
      const r = await api(`/api/consulta/cnpj/${doc}`);
      if (r.nome) {
        setForm({ ...form, ...r, id: form.id, email: form.email || r.email, endereco: { ...form.endereco, ...r.endereco } });
        setMsg('Dados preenchidos pela Receita (BrasilAPI). Confira antes de salvar.');
      } else setMsg('CNPJ não encontrado; preencha manualmente.');
    } catch {
      setMsg('Consulta de CNPJ indisponível; preencha manualmente.');
    }
  }

  async function buscarCep() {
    const cep = soDigitos(form.endereco.cep);
    if (cep.length !== 8) return;
    try {
      const r = await api(`/api/consulta/cep/${cep}`);
      if (r.cMun) setForm({ ...form, endereco: { ...form.endereco, ...r, numero: form.endereco.numero, complemento: form.endereco.complemento || r.complemento } });
    } catch { /* segue manual */ }
  }

  async function salvar(e) {
    e.preventDefault();
    try {
      await api('/api/clientes', { method: 'POST', body: form });
      setForm(VAZIO);
      setMsg('Cliente salvo.');
      recarregar();
    } catch (e) {
      setMsg(e.message);
    }
  }

  async function remover(c) {
    if (!confirm(`Remover ${c.nome}?`)) return;
    await api(`/api/clientes/${c.id}`, { method: 'DELETE' });
    recarregar();
  }

  const e = form.endereco;
  return (
    <section>
      <form className="card" onSubmit={salvar}>
        <h2>{form.id ? 'Editar cliente' : 'Novo cliente'}</h2>
        <div className="grade2">
          <Campo label="CNPJ / CPF" dica="O CNPJ preenche nome e endereço automaticamente">
            <input value={form.documento} onChange={set('documento')} onBlur={buscarCnpj} inputMode="numeric" required />
          </Campo>
          <Campo label="Razão social / Nome"><input value={form.nome} onChange={set('nome')} required /></Campo>
          <Campo label="E-mail"><input type="email" value={form.email} onChange={set('email')} /></Campo>
          <Campo label="Telefone"><input value={form.fone} onChange={set('fone')} inputMode="tel" /></Campo>
          <Campo label="CEP"><input value={e.cep} onChange={setEnd('cep')} onBlur={buscarCep} inputMode="numeric" /></Campo>
          <Campo label="Logradouro"><input value={e.logradouro} onChange={setEnd('logradouro')} /></Campo>
          <Campo label="Número"><input value={e.numero} onChange={setEnd('numero')} /></Campo>
          <Campo label="Complemento"><input value={e.complemento} onChange={setEnd('complemento')} /></Campo>
          <Campo label="Bairro"><input value={e.bairro} onChange={setEnd('bairro')} /></Campo>
          <Campo label="Município (código IBGE)" dica={e.municipio ? `${e.municipio} - ${e.uf}` : 'preenchido pelo CEP · BH = 3106200'}>
            <input value={e.cMun} onChange={setEnd('cMun')} inputMode="numeric" maxLength={7} />
          </Campo>
        </div>
        {msg && <p className="msg">{msg}</p>}
        <div className="acoes esq">
          <button className="pri" type="submit">Salvar</button>
          {form.id && <button type="button" className="sec" onClick={() => setForm(VAZIO)}>Cancelar</button>}
        </div>
      </form>

      <div className="card">
        <h2>Clientes ({clientes.length})</h2>
        {clientes.length === 0 && <p className="vazio">Nenhum cliente cadastrado.</p>}
        <ul className="lista">
          {clientes.map((c) => (
            <li key={c.id}>
              <div>
                <strong>{c.nome}</strong>
                <small>{fmtDoc(c.documento)} · {c.endereco?.municipio || 'sem endereço'}</small>
              </div>
              <div className="acoes">
                <button className="sec" onClick={() => setForm({ ...VAZIO, ...c, endereco: { ...VAZIO.endereco, ...c.endereco } })}>Editar</button>
                <button className="sec" onClick={() => remover(c)}>Remover</button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

// ---------- Notas ----------
function Notas({ notas, recarregar }) {
  const [aberta, setAberta] = useState(null);
  const [erro, setErro] = useState('');
  async function verificar(n) {
    setErro('');
    try {
      await api(`/api/notas/${n.id}/verificar`, { method: 'POST' });
      recarregar();
    } catch (e) {
      setErro(e.message);
    }
  }
  const total = notas.filter((n) => n.status === 'autorizada').reduce((s, n) => s + Number(n.valor), 0);
  return (
    <section className="card">
      <h2>Notas emitidas</h2>
      <p className="vazio">Total autorizado: <strong>{fmtBRL(total)}</strong></p>
      {erro && <p className="msg erro">{erro}</p>}
      {notas.length === 0 && <p className="vazio">Nenhuma nota ainda.</p>}
      <ul className="lista">
        {notas.map((n) => (
          <li key={n.id} className="col">
            <button className="item" onClick={() => setAberta(aberta === n.id ? null : n.id)}>
              <div>
                <strong>{n.tomador.nome}</strong>
                <small>
                  {new Date(n.criadaEm).toLocaleDateString('pt-BR')} · DPS {n.nDPS}{n.numero ? ` · NFS-e ${n.numero}` : ''} · {n.ambiente}
                </small>
              </div>
              <div className="dir">
                <strong>{fmtBRL(n.valor)}</strong>
                <Badge status={n.status} />
              </div>
            </button>
            {aberta === n.id && (
              <div className="detalhe">
                <p className="pre">{n.descricao}</p>
                {n.chaveAcesso && <p className="mono">{n.chaveAcesso}</p>}
                {n.mensagem && <p className="msg">{n.mensagem}</p>}
                {(n.erros ?? []).map((e, i) => <p key={i} className="msg erro"><strong>{e.codigo}</strong> {e.descricao}</p>)}
                {n.status === 'pendente' && <button className="pri" onClick={() => verificar(n)}>Verificar na Sefin</button>}
                <Downloads nota={n} />
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------- Configuração ----------
function Config({ status, recarregar }) {
  const [prox, setProx] = useState('');
  if (!status) return null;
  const c = status.certificado;
  async function salvarProx() {
    await api('/api/dps/proximo', { method: 'PUT', body: { proximo: Number(prox) } });
    setProx('');
    recarregar();
  }
  return (
    <section className="card">
      <h2>Configuração</h2>
      <dl className="resumo">
        <dt>Ambiente</dt><dd><span className={`badge ${status.ambiente === 'producao' ? 'erro' : 'alerta'}`}>{status.ambiente}</span></dd>
        <dt>Sefin</dt><dd className="mono">{status.sefinUrl}</dd>
        <dt>Prestador</dt><dd>{fmtDoc(status.prestador.cnpj)} · IM {status.prestador.im || '—'}</dd>
        <dt>Simples</dt><dd>{{ 1: 'Não optante', 2: 'MEI', 3: 'ME/EPP' }[status.prestador.opSimpNac]}</dd>
        <dt>Serviço</dt><dd>{status.servicoPadrao.cTribNac} / {status.servicoPadrao.cTribMun} · local IBGE {status.servicoPadrao.cLocPrestacao}</dd>
        <dt>Certificado</dt>
        <dd>{c.ok ? <>{c.titular}<br /><small>válido até {new Date(c.validoAte).toLocaleDateString('pt-BR')}</small></> : <span className="msg erro">{c.erro}</span>}</dd>
        <dt>Próxima DPS</dt><dd>nº {status.proximoNDPS} · série {status.serie}</dd>
      </dl>
      <Campo label="Ajustar próximo número da DPS" dica="Use para continuar a numeração já usada no portal Emissor Nacional">
        <div className="linha">
          <input inputMode="numeric" value={prox} onChange={(e) => setProx(soDigitos(e.target.value))} />
          <button className="sec" onClick={salvarProx} disabled={!prox}>Salvar</button>
        </div>
      </Campo>
      <p className="vazio">Os dados do emitente ficam no arquivo <code>.env</code>.</p>
    </section>
  );
}

function App() {
  const [aba, setAba] = useState('emitir');
  const [status, setStatus] = useState(null);
  const [clientes, setClientes] = useState([]);
  const [notas, setNotas] = useState([]);
  const [tema, setTema] = useState(() => {
    try { return localStorage.getItem('tema') || ''; } catch { return ''; }
  });

  const recarregar = () => {
    api('/api/status').then(setStatus).catch(() => {});
    api('/api/clientes').then(setClientes).catch(() => {});
    api('/api/notas').then(setNotas).catch(() => {});
  };
  useEffect(recarregar, []);
  useEffect(() => {
    if (tema) document.documentElement.dataset.theme = tema;
    else delete document.documentElement.dataset.theme;
    try { localStorage.setItem('tema', tema); } catch { /* sem storage */ }
  }, [tema]);

  const abas = [['emitir', 'Emitir'], ['clientes', 'Clientes'], ['notas', 'Notas'], ['config', 'Config']];
  return (
    <>
      <header>
        <div>
          <h1>NFS-e BH</h1>
          <small>Emissor Nacional · {status?.ambiente ?? '…'}</small>
        </div>
        <button className="sec" onClick={() => setTema(tema === 'dark' ? 'light' : 'dark')} aria-label="Alternar tema">◐</button>
      </header>
      <nav>
        {abas.map(([k, t]) => (
          <button key={k} className={aba === k ? 'ativo' : ''} onClick={() => setAba(k)}>{t}</button>
        ))}
      </nav>
      <main>
        {aba === 'emitir' && <Emitir status={status} clientes={clientes} aoEmitir={recarregar} irParaClientes={() => setAba('clientes')} />}
        {aba === 'clientes' && <Clientes clientes={clientes} recarregar={recarregar} />}
        {aba === 'notas' && <Notas notas={notas} recarregar={recarregar} />}
        {aba === 'config' && <Config status={status} recarregar={recarregar} />}
      </main>
    </>
  );
}

createRoot(document.getElementById('root')).render(<App />);
