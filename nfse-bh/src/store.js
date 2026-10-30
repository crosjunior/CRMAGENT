// Persistência simples em JSON (pasta data/, fora do git): clientes, notas, agenda, modelos de mensagem,
// lançamentos de extrato, dados do emitente e o contador de DPS.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function criarStore(dataDir) {
  fs.mkdirSync(path.join(dataDir, 'xml'), { recursive: true });
  const arq = (nome) => path.join(dataDir, `${nome}.json`);
  const ler = (nome, padrao) => {
    try {
      return JSON.parse(fs.readFileSync(arq(nome), 'utf8'));
    } catch {
      return padrao;
    }
  };
  // Grava em arquivo temporário e renomeia: um crash no meio não corrompe o JSON
  const gravar = (nome, dados) => {
    const tmp = arq(nome) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(dados, null, 2));
    fs.renameSync(tmp, arq(nome));
  };
  const soDigitos = (s) => String(s ?? '').replace(/\D/g, '');

  /** Coleção de registros com id: listar, obter, salvar (insere ou mescla), remover. */
  function colecao(nome) {
    return {
      listar: () => ler(nome, []),
      obter: (id) => ler(nome, []).find((r) => r.id === id) ?? null,
      salvar(registro) {
        const lista = ler(nome, []);
        const i = registro.id ? lista.findIndex((r) => r.id === registro.id) : -1;
        const novo = i >= 0 ? { ...lista[i], ...registro } : { ...registro, id: registro.id ?? crypto.randomUUID() };
        if (i >= 0) lista[i] = novo;
        else lista.push(novo);
        gravar(nome, lista);
        return novo;
      },
      salvarVarios(registros) {
        const lista = ler(nome, []);
        const porId = new Map(lista.map((r, i) => [r.id, i]));
        const saida = registros.map((r) => {
          const i = r.id ? porId.get(r.id) : undefined;
          const novo = i !== undefined ? { ...lista[i], ...r } : { ...r, id: r.id ?? crypto.randomUUID() };
          if (i !== undefined) lista[i] = novo;
          else porId.set(novo.id, lista.push(novo) - 1);
          return novo;
        });
        gravar(nome, lista);
        return saida;
      },
      remover(id) {
        gravar(nome, ler(nome, []).filter((r) => r.id !== id));
      },
    };
  }

  const clientesBase = colecao('clientes');
  const notasBase = colecao('notas');

  return {
    clientes: {
      ...clientesBase,
      listar: () => clientesBase.listar().sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR')),
      porDocumento: (doc) => clientesBase.listar().find((c) => c.documento === soDigitos(doc)) ?? null,
      // Mesmo CPF/CNPJ = mesmo cliente: atualiza em vez de duplicar
      salvar(cliente) {
        const doc = soDigitos(cliente.documento);
        const existente = (cliente.id && clientesBase.obter(cliente.id)) || clientesBase.listar().find((c) => c.documento === doc);
        return clientesBase.salvar({ ...cliente, documento: doc, id: existente?.id ?? cliente.id });
      },
    },

    notas: {
      ...notasBase,
      listar: () => notasBase.listar().sort((a, b) => (b.dataEmissao ?? b.criadaEm).localeCompare(a.dataEmissao ?? a.criadaEm)),
      porChave: (chave) => notasBase.listar().find((n) => n.chaveAcesso === chave) ?? null,
    },

    agendas: colecao('agendas'),
    modelos: colecao('modelos'),
    lancamentos: colecao('lancamentos'),

    emitente: {
      obter: () => ler('emitente', {}),
      salvar: (dados) => gravar('emitente', dados),
    },

    estado: {
      obter: (k, padrao) => ler('estado', {})[k] ?? padrao,
      definir(k, v) {
        const e = ler('estado', {});
        e[k] = v;
        gravar('estado', e);
      },
    },

    xml: {
      salvar: (nome, conteudo) => fs.writeFileSync(path.join(dataDir, 'xml', nome), conteudo),
      caminho: (nome) => path.join(dataDir, 'xml', nome),
    },

    /** Número da DPS: só avança quando a nota é gerada (DPS rejeitada não consome número). */
    dps: {
      proximo: (serie) => ler('estado', {})[`serie_${serie}`] ?? 1,
      confirmar(serie, n) {
        const estado = ler('estado', {});
        estado[`serie_${serie}`] = Math.max(estado[`serie_${serie}`] ?? 1, Number(n) + 1);
        gravar('estado', estado);
      },
      definir(serie, n) {
        const estado = ler('estado', {});
        estado[`serie_${serie}`] = Number(n);
        gravar('estado', estado);
      },
    },
  };
}
