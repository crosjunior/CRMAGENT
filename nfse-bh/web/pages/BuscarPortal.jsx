import React, { useState } from 'react';
import { api } from '../lib.js';
import { Msg } from '../ui.jsx';

/**
 * Busca no Ambiente de Dados Nacional (ADN), com o certificado, todas as NFS-e em que a empresa aparece:
 * as que emitiu (prestadora) e as que recebeu (tomadora), filtrando pelo ano escolhido.
 */
export default function BuscarPortal({ status, recarregar, compacto }) {
  const anoAtual = new Date().getFullYear();
  const [ano, setAno] = useState(String(anoAtual));
  const [ocupado, setOcupado] = useState(false);
  const [r, setR] = useState(null);
  const [erro, setErro] = useState('');

  async function buscar() {
    setOcupado(true);
    setErro('');
    setR(null);
    try {
      // Ano inteiro exige reler desde o primeiro documento; notas repetidas são ignoradas
      setR(await api('/api/importar/adn', { method: 'POST', body: { ano: ano || undefined, reiniciar: true, opcoes: { pagasAteDias: 45 } } }));
      recarregar();
    } catch (e) {
      setErro(e.message);
    } finally {
      setOcupado(false);
    }
  }

  const semCert = !status?.certificado?.ok;
  return (
    <div className={compacto ? 'caixa' : 'card'}>
      {!compacto && <h2>Buscar notas no portal</h2>}
      <p className="vazio">
        Traz do Ambiente Nacional da NFS-e, com o certificado da empresa, <strong>as notas emitidas</strong> (vão para Notas) e{' '}
        <strong>as notas recebidas de fornecedores</strong> (vão para Recebidas). Repetidas são ignoradas.
      </p>
      <div className="linha-info">
        <div className="linha">
          <select value={ano} onChange={(e) => setAno(e.target.value)} className="sel-curto" aria-label="Ano">
            {[anoAtual, anoAtual - 1, anoAtual - 2].map((a) => <option key={a} value={String(a)}>{a}</option>)}
            <option value="">Todos os anos</option>
          </select>
          <button className="pri curto" onClick={buscar} disabled={ocupado || semCert}>
            {ocupado ? 'Buscando… (pode levar alguns minutos)' : `Buscar notas ${ano ? `de ${ano}` : 'de todos os anos'}`}
          </button>
        </div>
      </div>
      {semCert && <Msg tipo="alerta">Configure o certificado A1 no arquivo .env (NFSE_PFX_PATH e NFSE_PFX_SENHA) para buscar no portal.</Msg>}
      <Msg tipo="erro">{erro}</Msg>
      {r && (
        <Msg tipo="ok">
          {r.documentos} documento(s) lidos · <strong>{r.notasNovas}</strong> nota(s) emitida(s) nova(s) ({r.notasExistentes} já existiam) ·{' '}
          <strong>{r.recebidasNovas}</strong> recebida(s) nova(s) ({r.recebidasExistentes} já existiam) · {r.eventos} cancelamento(s)
          {r.foraDoPeriodo ? ` · ${r.foraDoPeriodo} de outros anos ignorada(s)` : ''}
        </Msg>
      )}
      {r?.erros?.length > 0 && (
        <Msg tipo="alerta">
          {r.erros.length} documento(s) não puderam ser importados (os demais entraram normalmente):
          <ul className="lista-erros">{r.erros.slice(0, 10).map((e, i) => <li key={i}>{e}</li>)}</ul>
          {r.erros.length > 10 && `… e mais ${r.erros.length - 10}.`} O XML deles fica em data\xml (arquivos erro-*.xml).
        </Msg>
      )}
      <p className="vazio">
        Busca automática a cada 15 dias com a aplicação aberta
        {status?.ultimaBuscaPortal?.em
          ? ` · última em ${new Date(status.ultimaBuscaPortal.em).toLocaleString('pt-BR')} (${status.ultimaBuscaPortal.origem === 'automatica' ? 'automática' : 'manual'}${status.ultimaBuscaPortal.erro ? `, falhou: ${status.ultimaBuscaPortal.erro}` : ''})`
          : ' · ainda não executada'}
        {status?.proximaBuscaPortal ? ` · próxima: ${new Date(status.proximaBuscaPortal).toLocaleDateString('pt-BR')}` : ''}.
      </p>
    </div>
  );
}

