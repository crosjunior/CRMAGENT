// Orquestra a emissão: monta a DPS, assina, envia à Sefin, guarda o resultado e controla a numeração.
import crypto from 'node:crypto';
import { montarDps } from './dps.js';
import { assinarDps } from './assinatura.js';
import { carregarCertificado } from './certificado.js';
import { criarClienteSefin, resumirNfse, ErroSefin } from './sefin.js';

export function criarEmissor({ config, store, sefinFactory = criarClienteSefin }) {
  let cert = null;
  let sefin = null;
  let fila = Promise.resolve(); // serializa emissões: duas notas nunca disputam o mesmo nDPS

  function certificado() {
    if (!cert) {
      cert = carregarCertificado(config.certificado.pfxPath, config.certificado.senha);
      if (cert.cnpj && config.prestador.cnpj && cert.cnpj.slice(0, 8) !== config.prestador.cnpj.slice(0, 8))
        throw new Error(`O certificado é do CNPJ ${cert.cnpj}, diferente do prestador ${config.prestador.cnpj}`);
    }
    return cert;
  }
  const cliente = () => (sefin ??= sefinFactory({ baseUrl: config.sefinUrl, cert: certificado() }));

  function resolverTomador({ clienteId, tomador }) {
    if (clienteId) {
      const c = store.clientes.obter(clienteId);
      if (!c) throw new Error('Cliente não encontrado');
      return c;
    }
    if (!tomador) throw new Error('Informe o cliente (clienteId) ou os dados do tomador');
    return tomador;
  }

  function pendenteAberta() {
    return store.notas.listar().find((n) => n.status === 'pendente' && n.serie === config.serie);
  }

  /** Monta a DPS sem enviar: usado para conferência antes da emissão. */
  function preparar(pedido) {
    const tomador = resolverTomador(pedido);
    const nDPS = store.dps.proximo(config.serie);
    const dps = montarDps({ config, tomador, servico: pedido.servico, nDPS });
    return {
      nDPS,
      idDps: dps.id,
      xml: dps.xml,
      resumo: {
        ambiente: config.ambiente,
        prestador: config.prestador.cnpj,
        tomador: { documento: tomador.documento, nome: tomador.nome },
        descricao: pedido.servico.descricao,
        valor: dps.valor,
        competencia: dps.dCompet,
      },
    };
  }

  async function emitirAgora(pedido) {
    if (!pedido.confirmado) throw new Error('Emissão exige confirmação explícita (confirmado: true): a NFS-e é irreversível');
    const pendente = pendenteAberta();
    if (pendente)
      throw new Error(`Há uma DPS com resultado incerto (nº ${pendente.nDPS}). Verifique-a antes de emitir outra nota.`);

    const tomador = resolverTomador(pedido);
    const nDPS = store.dps.proximo(config.serie);
    const dps = montarDps({ config, tomador, servico: pedido.servico, nDPS });
    const assinada = assinarDps(dps.xml, dps.id, certificado());

    const nota = {
      id: crypto.randomUUID(),
      criadaEm: new Date().toISOString(),
      ambiente: config.ambiente,
      serie: config.serie,
      nDPS,
      idDps: dps.id,
      competencia: dps.dCompet,
      valor: dps.valor,
      descricao: pedido.servico.descricao,
      tomador: { documento: tomador.documento, nome: tomador.nome, email: tomador.email ?? '' },
      clienteId: pedido.clienteId ?? null,
    };
    store.xml.salvar(`${dps.id}-dps.xml`, assinada);

    if (pedido.simular) {
      return store.notas.salvar({ ...nota, status: 'simulada', dpsXml: `${dps.id}-dps.xml` });
    }

    // Grava "pendente" antes de enviar: se o processo cair no meio, a nota não se perde
    store.notas.salvar({ ...nota, status: 'pendente', dpsXml: `${dps.id}-dps.xml` });
    try {
      const r = await cliente().emitir(assinada);
      return registrarAutorizada(nota, r.chaveAcesso, r.nfseXml, r.alertas);
    } catch (e) {
      if (e instanceof ErroSefin && !e.incerto) {
        return store.notas.salvar({ ...nota, status: 'rejeitada', erros: e.erros, mensagem: e.message });
      }
      // Resultado incerto: fica pendente até a consulta da DPS dizer se virou nota
      return store.notas.salvar({ ...nota, status: 'pendente', mensagem: e.message });
    }
  }

  function registrarAutorizada(nota, chaveAcesso, nfseXml, alertas = []) {
    store.dps.confirmar(nota.serie, nota.nDPS);
    if (nfseXml) store.xml.salvar(`${chaveAcesso}-nfse.xml`, nfseXml);
    return store.notas.salvar({
      ...nota,
      status: 'autorizada',
      chaveAcesso,
      nfseXml: nfseXml ? `${chaveAcesso}-nfse.xml` : null,
      ...(nfseXml ? resumirNfse(nfseXml) : {}),
      alertas,
      mensagem: null,
    });
  }

  /** Resolve uma nota pendente consultando a DPS na Sefin. */
  async function verificar(notaId) {
    const nota = store.notas.obter(notaId);
    if (!nota) throw new Error('Nota não encontrada');
    if (nota.status !== 'pendente') return nota;
    const chave = await cliente().consultarDps(nota.idDps);
    if (!chave) {
      // A DPS não chegou a virar nota: o número pode ser reutilizado
      return store.notas.salvar({ ...nota, status: 'nao_processada', mensagem: 'A Sefin não recebeu esta DPS; pode emitir novamente.' });
    }
    let xml = null;
    try {
      xml = await cliente().consultarNfse(chave);
    } catch {
      /* a chave basta; o XML pode ser baixado depois */
    }
    return registrarAutorizada(nota, chave, xml);
  }

  return {
    preparar,
    emitir: (pedido) => (fila = fila.then(() => emitirAgora(pedido), () => emitirAgora(pedido))),
    verificar,
    statusCertificado() {
      try {
        const c = certificado();
        return { ok: true, titular: c.titular, cnpj: c.cnpj, validoAte: c.validoAte };
      } catch (e) {
        return { ok: false, erro: e.message };
      }
    },
  };
}
