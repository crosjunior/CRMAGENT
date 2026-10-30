import React, { useEffect, useState } from 'react';
import { api, fmtBRL, fmtData, fmtDoc, soDigitos } from '../lib.js';
import { Campo, Msg } from '../ui.jsx';

const VAZIO = {
  documento: '', nome: '', nomeFantasia: '', email: '', fone: '', im: '',
  endereco: { cep: '', logradouro: '', numero: '', complemento: '', bairro: '', municipio: '', uf: '', cMun: '' },
  contatoNome: '', emailsCobranca: '', whatsapp: '', prazoDias: '', diaVencimento: '', modeloId: '',
  cTribNac: '', cTribMun: '', cNBS: '', cLocPrestacao: '', localPrestacao: '', issRetido: false, aliquotaIss: '',
  descricaoPadrao: '', valorPadrao: '', apelidos: [], observacoes: '',
};

export default function Clientes({ clientes, status, recarregar, emitirPara }) {
  const [form, setForm] = useState(null);
  const [busca, setBusca] = useState('');
  const [modelos, setModelos] = useState([]);
  useEffect(() => {
    api('/api/modelos').then((r) => setModelos(r.modelos)).catch(() => {});
  }, []);

  const lista = clientes.filter((c) => `${c.nome} ${c.nomeFantasia ?? ''} ${c.documento}`.toLowerCase().includes(busca.toLowerCase()));
  return (
    <section>
      {form ? (
        <FormCliente inicial={form} status={status} modelos={modelos} aoSalvar={() => { setForm(null); recarregar(); }} aoCancelar={() => setForm(null)} />
      ) : (
        <div className="card">
          <div className="linha-info">
            <h2>Clientes ({clientes.length})</h2>
            <button className="pri curto" onClick={() => setForm(VAZIO)}>+ Novo cliente</button>
          </div>
          <Campo label="Buscar"><input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="nome ou CNPJ" /></Campo>
          {clientes.length === 0 && <p className="vazio">Nenhum cliente. Cadastre um, ou importe suas notas antigas em Config → Importar histórico: os clientes são criados automaticamente.</p>}
          <ul className="lista">
            {lista.map((c) => (
              <li key={c.id}>
                <div>
                  <strong>{c.nome}</strong>
                  <small>
                    {fmtDoc(c.documento)} · {c.resumo?.notas ?? 0} nota(s) · faturado {fmtBRL(c.resumo?.faturado)}
                    {c.resumo?.ultimaNota ? ` · última ${fmtData(c.resumo.ultimaNota)}` : ''}
                  </small>
                  <small>
                    {c.issRetido ? 'ISS retido · ' : ''}{c.cTribNac ? `cód. ${c.cTribNac} · ` : ''}{c.localPrestacao ? `prestação em ${c.localPrestacao} · ` : ''}
                    {c.valorPadrao ? `padrão ${fmtBRL(c.valorPadrao)}` : ''}
                    {c.resumo?.emAberto ? <span className={c.resumo.atrasadas ? 'txt-erro' : 'txt-alerta'}> · em aberto {fmtBRL(c.resumo.emAberto)}{c.resumo.atrasadas ? ` (${c.resumo.atrasadas} em atraso)` : ''}</span> : ''}
                  </small>
                </div>
                <div className="acoes">
                  <button className="sec" onClick={() => emitirPara(c.id)}>Emitir</button>
                  <button className="sec" onClick={() => setForm({ ...VAZIO, ...c, endereco: { ...VAZIO.endereco, ...c.endereco } })}>Editar</button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function FormCliente({ inicial, status, modelos, aoSalvar, aoCancelar }) {
  const [form, setForm] = useState(inicial);
  const [msg, setMsg] = useState('');
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const setEnd = (k) => (e) => setForm({ ...form, endereco: { ...form.endereco, [k]: e.target.value } });
  const sp = status?.servicoPadrao ?? {};

  async function buscarCnpj() {
    const doc = soDigitos(form.documento);
    if (doc.length !== 14 || form.nome) return;
    setMsg('Consultando CNPJ…');
    try {
      const r = await api(`/api/consulta/cnpj/${doc}`);
      if (r.nome) {
        setForm((f) => ({ ...f, nome: r.nome, email: f.email || r.email, fone: f.fone || r.fone, endereco: { ...f.endereco, ...r.endereco } }));
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
      if (r.cMun) setForm((f) => ({ ...f, endereco: { ...f.endereco, ...r, numero: f.endereco.numero, complemento: f.endereco.complemento || r.complemento } }));
    } catch { /* segue manual */ }
  }
  async function salvar(e) {
    e.preventDefault();
    try {
      const apelidos = Array.isArray(form.apelidos) ? form.apelidos : String(form.apelidos ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      await api('/api/clientes', { method: 'POST', body: { ...form, apelidos } });
      aoSalvar();
    } catch (e) {
      setMsg(e.message);
    }
  }
  async function remover() {
    if (!confirm(`Remover ${form.nome}? As notas continuam no histórico.`)) return;
    await api(`/api/clientes/${form.id}`, { method: 'DELETE' });
    aoSalvar();
  }

  const e = form.endereco ?? {};
  return (
    <form className="card" onSubmit={salvar}>
      <h2>{form.id ? 'Editar cliente' : 'Novo cliente'}</h2>
      <h3 className="secao">Dados</h3>
      <div className="grade2">
        <Campo label="CNPJ / CPF" dica="O CNPJ preenche nome e endereço automaticamente">
          <input value={form.documento} onChange={set('documento')} onBlur={buscarCnpj} inputMode="numeric" required />
        </Campo>
        <Campo label="Razão social / Nome"><input value={form.nome} onChange={set('nome')} required /></Campo>
        <Campo label="Nome fantasia"><input value={form.nomeFantasia ?? ''} onChange={set('nomeFantasia')} /></Campo>
        <Campo label="Inscrição municipal"><input value={form.im ?? ''} onChange={set('im')} inputMode="numeric" /></Campo>
        <Campo label="E-mail (vai na nota)"><input type="email" value={form.email ?? ''} onChange={set('email')} /></Campo>
        <Campo label="Telefone"><input value={form.fone ?? ''} onChange={set('fone')} inputMode="tel" /></Campo>
      </div>

      <h3 className="secao">Endereço</h3>
      <div className="grade2">
        <Campo label="CEP"><input value={e.cep ?? ''} onChange={setEnd('cep')} onBlur={buscarCep} inputMode="numeric" /></Campo>
        <Campo label="Logradouro"><input value={e.logradouro ?? ''} onChange={setEnd('logradouro')} /></Campo>
        <Campo label="Número"><input value={e.numero ?? ''} onChange={setEnd('numero')} /></Campo>
        <Campo label="Complemento"><input value={e.complemento ?? ''} onChange={setEnd('complemento')} /></Campo>
        <Campo label="Bairro"><input value={e.bairro ?? ''} onChange={setEnd('bairro')} /></Campo>
        <Campo label="Município (código IBGE)" dica={e.municipio ? `${e.municipio} - ${e.uf}` : 'preenchido pelo CEP · BH = 3106200'}>
          <input value={e.cMun ?? ''} onChange={setEnd('cMun')} inputMode="numeric" maxLength={7} />
        </Campo>
      </div>

      <h3 className="secao">Configuração da nota</h3>
      <div className="grade2">
        <Campo label="Descrição padrão do serviço" largo>
          <textarea rows={3} value={form.descricaoPadrao ?? ''} onChange={set('descricaoPadrao')} placeholder="Preenche a descrição ao emitir para este cliente" />
          <small>Aceita {'{{valor}}'}, {'{{mes}}'}, {'{{MesAnterior}}'}, {'{{ano}}'}, {'{{anoMesAnterior}}'} — substituídos na emissão</small>
        </Campo>
        <Campo label="Valor padrão (R$)"><input value={form.valorPadrao ?? ''} onChange={set('valorPadrao')} inputMode="decimal" /></Campo>
        <Campo label="Cód. tributação nacional" dica={`vazio = padrão ${sp.cTribNac}`}><input value={form.cTribNac ?? ''} onChange={set('cTribNac')} inputMode="numeric" maxLength={8} /></Campo>
        <Campo label="Cód. tributação municipal" dica={`vazio = padrão ${sp.cTribMun}`}><input value={form.cTribMun ?? ''} onChange={set('cTribMun')} inputMode="numeric" maxLength={3} /></Campo>
        <Campo label="Código NBS" dica="ex.: 122051900 (1.2205.19.00)"><input value={form.cNBS ?? ''} onChange={set('cNBS')} inputMode="numeric" /></Campo>
        <Campo label="Local da prestação (código IBGE)" dica={form.localPrestacao ? `${form.localPrestacao}` : `vazio = Belo Horizonte (${sp.cLocPrestacao})`}>
          <input value={form.cLocPrestacao ?? ''} onChange={set('cLocPrestacao')} inputMode="numeric" maxLength={7} />
        </Campo>
        <label className="check">
          <input type="checkbox" checked={!!form.issRetido} onChange={set('issRetido')} />
          <span>Cliente retém o ISS (substituto tributário)</span>
        </label>
        {form.issRetido && (
          <Campo label="Alíquota do ISS retido (%)" dica={`vazio = ${sp.aliquotaIss}%`}><input value={form.aliquotaIss ?? ''} onChange={set('aliquotaIss')} inputMode="decimal" /></Campo>
        )}
      </div>

      <h3 className="secao">Cobrança e envio</h3>
      <div className="grade2">
        <Campo label="Nome do contato" dica="usado em {{cliente.contato}}"><input value={form.contatoNome ?? ''} onChange={set('contatoNome')} /></Campo>
        <Campo label="E-mails de cobrança" dica="separe por vírgula"><input value={form.emailsCobranca ?? ''} onChange={set('emailsCobranca')} /></Campo>
        <Campo label="WhatsApp"><input value={form.whatsapp ?? ''} onChange={set('whatsapp')} inputMode="tel" placeholder="31999999999" /></Campo>
        <Campo label="Modelo de mensagem de envio">
          <select value={form.modeloId ?? ''} onChange={set('modeloId')}>
            <option value="">Padrão</option>
            {modelos.map((m) => <option key={m.id} value={m.id}>{m.nome}</option>)}
          </select>
        </Campo>
        <Campo label="Prazo de pagamento (dias)" dica={`vazio = ${status?.cobranca?.prazoDias} dias`}><input value={form.prazoDias ?? ''} onChange={set('prazoDias')} inputMode="numeric" /></Campo>
        <Campo label="Ou dia fixo de vencimento" dica="tem prioridade sobre o prazo"><input value={form.diaVencimento ?? ''} onChange={set('diaVencimento')} inputMode="numeric" maxLength={2} /></Campo>
        <Campo label="Outros nomes no extrato" dica="ex.: nome do sócio que paga via PIX — separe por vírgula" largo>
          <input value={Array.isArray(form.apelidos) ? form.apelidos.join(', ') : form.apelidos ?? ''} onChange={set('apelidos')} />
        </Campo>
        <Campo label="Observações" largo><textarea rows={2} value={form.observacoes ?? ''} onChange={set('observacoes')} /></Campo>
      </div>

      <Msg>{msg}</Msg>
      <div className="acoes esq">
        <button className="pri curto" type="submit">Salvar</button>
        <button type="button" className="sec" onClick={aoCancelar}>Cancelar</button>
        {form.id && <button type="button" className="sec" onClick={remover}>Remover</button>}
      </div>
    </form>
  );
}
