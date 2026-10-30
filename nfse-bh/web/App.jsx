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
          <small>Emissor NFS-e · {status?.ambiente ?? '…'}</small>
        </div>
        <button className="sec" onClick={() => setTema(tema === 'dark' ? 'light' : 'dark')} aria-label="Alternar tema">◐</button>
      </header>
      <nav>
        {ABAS.map(([k, t]) => (
          <button key={k} className={aba === k ? 'ativo' : ''} onClick={() => irPara(k)}>
            {t}{k === 'notas' && atrasadas > 0 && <span className="ponto">{atrasadas}</span>}
          </button>
        ))}
      </nav>
      <main>
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

createRoot(document.getElementById('root')).render(<App />);
