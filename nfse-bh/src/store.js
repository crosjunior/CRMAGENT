// Persistência simples em JSON: clientes (tomadores), notas emitidas e o contador de DPS.
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

  return {
    clientes: {
      listar: () => ler('clientes', []),
      obter: (id) => ler('clientes', []).find((c) => c.id === id) ?? null,
      salvar(cliente) {
        const lista = ler('clientes', []);
        const doc = soDigitos(cliente.documento);
        const existente = lista.find((c) => c.id === cliente.id) ?? lista.find((c) => soDigitos(c.documento) === doc);
        const registro = { ...existente, ...cliente, documento: doc, id: existente?.id ?? crypto.randomUUID() };
        gravar('clientes', existente ? lista.map((c) => (c.id === registro.id ? registro : c)) : [...lista, registro]);
        return registro;
      },
      remover(id) {
        gravar('clientes', ler('clientes', []).filter((c) => c.id !== id));
      },
    },

    notas: {
      listar: () => ler('notas', []).sort((a, b) => b.criadaEm.localeCompare(a.criadaEm)),
      obter: (id) => ler('notas', []).find((n) => n.id === id) ?? null,
      salvar(nota) {
        const lista = ler('notas', []);
        const i = lista.findIndex((n) => n.id === nota.id);
        if (i >= 0) lista[i] = { ...lista[i], ...nota };
        else lista.push(nota);
        gravar('notas', lista);
        return nota;
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
