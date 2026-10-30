// Utilitários do front: chamadas à API e formatação.

export async function api(url, opts = {}) {
  const r = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.erro || `Erro HTTP ${r.status}`);
  return j;
}

export const soDigitos = (s) => String(s ?? '').replace(/\D/g, '');
export const fmtDoc = (d) => {
  d = soDigitos(d);
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  return d;
};
export const fmtBRL = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
export const fmtData = (d) => (d ? d.slice(0, 10).split('-').reverse().join('/') : '—');
export const hoje = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
export const fmtFone = (f) => {
  f = soDigitos(f);
  if (f.length === 11) return f.replace(/(\d{2})(\d{5})(\d{4})/, '($1) $2-$3');
  if (f.length === 10) return f.replace(/(\d{2})(\d{4})(\d{4})/, '($1) $2-$3');
  return f;
};

// Situação financeira (controle) e status fiscal (Sefin)
export const SITUACAO = {
  aguardando: ['Aguardando pagamento', 'alerta'],
  atrasada: ['Em atraso', 'erro'],
  pago: ['Pago', 'ok'],
  cancelada: ['Cancelada', 'neutro'],
  substituida: ['Substituída', 'neutro'],
};
export const STATUS = {
  autorizada: ['Autorizada', 'ok'],
  rejeitada: ['Rejeitada', 'erro'],
  pendente: ['Pendente', 'alerta'],
  simulada: ['Simulada', 'neutro'],
  nao_processada: ['Não processada', 'neutro'],
};

/** Lê um arquivo do usuário como texto, caindo para Latin-1 (comum em OFX/CSV de banco) se não for UTF-8. */
export async function lerArquivoTexto(file) {
  const buf = await file.arrayBuffer();
  const utf8 = new TextDecoder('utf-8').decode(buf);
  return utf8.includes('�') ? new TextDecoder('iso-8859-1').decode(buf) : utf8;
}

export async function lerArquivoBase64(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Baixa um CSV gerado no navegador (separador ; e BOM para abrir certo no Excel). */
export function baixarCsv(nome, linhas) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = '﻿' + linhas.map((l) => l.map(esc).join(';')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = nome;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
