import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api } from './lib.js';
import Emitir from './pages/Emitir.jsx';
import Notas from './pages/Notas.jsx';
import Clientes from './pages/Clientes.jsx';
import Agenda from './pages/Agenda.jsx';
import Mensagens from './pages/Mensagens.jsx';
import Extrato from './pages/Extrato.jsx';
import Config from './pages/Config.jsx';
import Carregar from './pages/Carregar.jsx';
import { fmtDoc, fmtFone } from './lib.js';

const ABAS = [
  ['emitir', 'Emitir'],
  ['notas', 'Notas'],
  ['clientes', 'Clientes'],
  ['agenda', 'Agenda'],
  ['mensagens', 'Mensagens'],
  ['extrato', 'Extrato'],
  ['config', 'Config'],
];

function App() {
  const [aba, setAba] = useState(() => location.hash.slice(1) || 'emitir');
  const [alvo, setAlvo] = useState(null); // id de cliente/nota a abrir na aba destino
  const [carga, setCarga] = useState(null); // resumo da última carga de dados
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

  function irPara(destino, id = null) {
    setAlvo(id);
    setAba(destino);
    history.replaceState(null, '', `#${destino}`);
    window.scrollTo(0, 0);
  }

  const atrasadas = notas.filter((n) => n.situacaoAtual === 'atrasada').length;
  return (
    <>
      <header>
        <div>
          <h1>{status?.prestador.nomeFantasia || 'NFS-e BH'}</h1>
          <small>Emissor NFS-e · <span className={`badge ${status?.ambiente === 'producao' ? 'erro' : 'alerta'}`}>{status?.ambiente ?? '…'}</span></small>
        </div>
        <button className="sec" onClick={() => setTema(tema === 'dark' ? 'light' : 'dark')} aria-label="Alternar tema">◐</button>
      </header>
      {status && <Emitente status={status} irPara={irPara} />}
      <nav>
        {ABAS.map(([k, t]) => (
          <button key={k} className={aba === k ? 'ativo' : ''} onClick={() => irPara(k)}>
            {t}{k === 'notas' && atrasadas > 0 && <span className="ponto">{atrasadas}</span>}
          </button>
        ))}
      </nav>
      <main>
        {status && (clientes.length === 0 || carga) && ['emitir', 'notas', 'clientes', 'agenda'].includes(aba) && (
          <Carregar recarregar={recarregar} resultado={carga} setResultado={setCarga} />
        )}
        {aba === 'emitir' && <Emitir status={status} clientes={clientes} clienteInicial={alvo} aoEmitir={recarregar} irPara={irPara} />}
        {aba === 'notas' && <Notas notas={notas} clientes={clientes} recarregar={recarregar} notaInicial={alvo} />}
        {aba === 'clientes' && <Clientes clientes={clientes} status={status} recarregar={recarregar} emitirPara={(id) => irPara('emitir', id)} />}
        {aba === 'agenda' && <Agenda clientes={clientes} recarregarTudo={recarregar} />}
        {aba === 'mensagens' && <Mensagens notas={notas} />}
        {aba === 'extrato' && <Extrato notas={notas} recarregarTudo={recarregar} />}
        {aba === 'config' && <Config status={status} recarregar={recarregar} irPara={irPara} />}
      </main>
    </>
  );
}

const REGIME = { 1: 'Não optante pelo Simples', 2: 'Simples Nacional — MEI', 3: 'Simples Nacional — ME/EPP' };

/** Dados completos do emitente, sempre visíveis no topo (recolhíveis no celular). */
function Emitente({ status, irPara }) {
  const p = status.prestador;
  const e = p.endereco ?? {};
  const c = status.cobranca ?? {};
  const endereco = [[e.logradouro, e.numero].filter(Boolean).join(', '), e.complemento, e.bairro, e.municipio && `${e.municipio}/${e.uf}`, e.cep && `CEP ${e.cep.replace(/(\d{5})(\d{3})/, '$1-$2')}`]
    .filter(Boolean)
    .join(' · ');
  const banco = [c.banco, c.agencia && `Ag. ${c.agencia}`, c.conta && `C/C ${c.conta}`, c.pix && `PIX ${c.pix}`].filter(Boolean).join(' · ');
  return (
    <details className="emitente" open={window.matchMedia?.('(min-width: 760px)').matches}>
      <summary>
        <strong>{p.razaoSocial}</strong> · CNPJ {fmtDoc(p.cnpj)}
      </summary>
      <div className="emitente-grade">
        <span><small>Inscrição municipal</small>{p.im || '—'}</span>
        <span><small>Regime</small>{REGIME[p.opSimpNac] ?? '—'}</span>
        <span><small>Endereço</small>{endereco || <button className="link" onClick={() => irPara('config')}>completar</button>}</span>
        <span><small>Contato</small>{[fmtFone(p.fone), p.email].filter(Boolean).join(' · ') || <button className="link" onClick={() => irPara('config')}>completar</button>}</span>
        <span><small>Serviço padrão</small>{status.servicoPadrao.cTribNac.replace(/(\d{2})(\d{2})(\d{2})/, '$1.$2.$3')} / {status.servicoPadrao.cTribMun} · Belo Horizonte/MG</span>
        <span><small>Dados bancários</small>{banco || <button className="link" onClick={() => irPara('config')}>completar</button>}</span>
      </div>
    </details>
  );
}

createRoot(document.getElementById('root')).render(<App />);
