import React, { useState } from 'react';
import { api, lerArquivoBase64, lerArquivoTexto } from '../lib.js';
import { Msg } from '../ui.jsx';

/**
 * Carga dos dados (pacote .json e notas em ZIP/PDF/XML) num só passo. Aparece enquanto não há clientes:
 * sem ela, a aplicação abre vazia e não fica claro que os dados ainda precisam entrar.
 */
// O resultado fica no App: com os clientes carregados este quadro só continua visível para mostrá-lo
export default function Carregar({ recarregar, resultado: r, setResultado: setR }) {
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState('');

  async function enviar(e) {
    const lista = [...e.target.files];
    e.target.value = '';
    if (!lista.length) return;
    setOcupado(true);
    setErro('');
    const res = { clientes: 0, notas: 0, agendas: 0, avisos: [] };
    try {
      // Pacote primeiro: traz emitente, clientes e agenda; as notas depois completam e anexam os PDFs
      for (const f of lista.filter((f) => /\.json$/i.test(f.name))) {
        const p = await api('/api/importar/pacote', { method: 'POST', body: JSON.parse((await lerArquivoTexto(f)).replace(/^﻿/, '')) });
        res.clientes += p.clientesNovos;
        res.notas += p.notasNovas;
        res.agendas += p.agendas;
        res.avisos.push(...(p.avisos ?? []));
      }
      const notas = lista.filter((f) => /\.(zip|pdf|xml)$/i.test(f.name));
      if (notas.length) {
        const arquivos = await Promise.all(notas.map(async (f) => ({ nome: f.name, base64: await lerArquivoBase64(f) })));
        const n = await api('/api/importar/arquivos', { method: 'POST', body: { arquivos, opcoes: { pagasAteDias: 45 } } });
        res.notas += n.notasNovas;
        res.clientes = Math.max(res.clientes, n.clientes);
        res.avisos.push(...(n.erros ?? []));
      }
      setR(res);
      recarregar();
    } catch (e) {
      setErro(e.message);
    } finally {
      setOcupado(false);
    }
  }

  async function pasta() {
    setOcupado(true);
    setErro('');
    try {
      const p = await api('/api/importar/pasta', { method: 'POST' });
      if (!p.arquivos?.length) setErro('Nenhum arquivo na pasta nfse-bh\\importar.');
      else {
        setR({
          clientes: (p.pacotes ?? []).reduce((s, x) => s + x.clientesNovos, 0) || p.notas?.clientes || 0,
          notas: (p.pacotes ?? []).reduce((s, x) => s + x.notasNovas, 0) + (p.notas?.notasNovas ?? 0),
          agendas: (p.pacotes ?? []).reduce((s, x) => s + x.agendas, 0),
          avisos: p.erros ?? [],
        });
        recarregar();
      }
    } catch (e) {
      setErro(e.message);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div className="card destaque">
      <h2>Carregar meus dados</h2>
      {r ? (
        <>
          <Msg tipo="ok">
            Carregado: {r.clientes} cliente(s), {r.notas} nota(s), {r.agendas} agendamento(s).
          </Msg>
          {r.avisos?.map((a, i) => <Msg key={i} tipo="alerta">{a}</Msg>)}
          <button className="sec" onClick={() => setR(null)}>Fechar</button>
        </>
      ) : (
        <>
      <p>
        Ainda não há clientes nem notas nesta instalação. Selecione <strong>de uma vez</strong> o pacote{' '}
        <code>conexao-agil-pacote.json</code> e o <code>NOTAS.zip</code> (ou os PDFs/XMLs das notas).
      </p>
      <div className="acoes esq">
        <label className={`pri btn upload ${ocupado ? 'desab' : ''}`}>
          {ocupado ? 'Carregando…' : 'Selecionar arquivos'}
          <input type="file" accept=".json,.zip,.pdf,.xml" multiple hidden onChange={enviar} disabled={ocupado} />
        </label>
        <button className="sec" onClick={pasta} disabled={ocupado}>Ler pasta “importar”</button>
      </div>
      <p className="vazio">
        Alternativa: copie os arquivos para a pasta <code>nfse-bh\importar</code> — eles são carregados sozinhos ao iniciar a
        aplicação (<code>npm start</code>) e depois movidos para <code>importar\processados</code>.
      </p>
      <Msg tipo="erro">{erro}</Msg>
        </>
      )}
    </div>
  );
}
