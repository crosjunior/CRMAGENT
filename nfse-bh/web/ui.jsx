import React from 'react';
import { SITUACAO, STATUS } from './lib.js';

export function Badge({ mapa = STATUS, valor }) {
  const [txt, cls] = mapa[valor] ?? [valor ?? '—', 'neutro'];
  return <span className={`badge ${cls}`}>{txt}</span>;
}
export const Situacao = ({ valor }) => (valor ? <Badge mapa={SITUACAO} valor={valor} /> : null);

export function Campo({ label, children, dica, largo }) {
  return (
    <label className={`campo${largo ? ' largo' : ''}`}>
      <span>{label}</span>
      {children}
      {dica && <small>{dica}</small>}
    </label>
  );
}

export function Modal({ titulo, children, aoFechar }) {
  return (
    <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.target === e.currentTarget && aoFechar?.()}>
      <div className="card">
        <div className="modal-topo">
          <h2>{titulo}</h2>
          {aoFechar && <button className="link" onClick={aoFechar} aria-label="Fechar">✕</button>}
        </div>
        {children}
      </div>
    </div>
  );
}

export function Msg({ tipo = '', children }) {
  return children ? <p className={`msg ${tipo}`}>{children}</p> : null;
}

export function Kpi({ titulo, valor, sub, tom }) {
  return (
    <div className={`kpi ${tom ?? ''}`}>
      <small>{titulo}</small>
      <strong>{valor}</strong>
      {sub && <small>{sub}</small>}
    </div>
  );
}
