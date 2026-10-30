// Emissão pela linha de comando, para automação (cron, integração com CRM/planilha).
// Uso: npm run emitir -- --doc 12345678000199 --valor 1860,00 --descricao "Mentoria..." [--competencia 2026-10-01] [--simular] [--sim]
import readline from 'node:readline/promises';
import { carregarConfig } from './config.js';
import { criarStore } from './store.js';
import { criarEmissor } from './emissor.js';
import { consultarCnpj } from './consultas.js';

const args = process.argv.slice(2);
const opt = (k) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (k) => args.includes(`--${k}`);

const config = carregarConfig();
const store = criarStore(config.dataDir);
const emissor = criarEmissor({ config, store });

const doc = String(opt('doc') ?? '').replace(/\D/g, '');
if (!doc || !opt('valor') || !opt('descricao')) {
  console.error('Uso: npm run emitir -- --doc <CNPJ/CPF> --valor <valor> --descricao <texto> [--competencia AAAA-MM-DD] [--simular] [--sim]');
  process.exit(1);
}

// Tomador: primeiro o cadastro local, depois a BrasilAPI
let tomador = store.clientes.listar().find((c) => c.documento === doc);
if (!tomador && doc.length === 14) {
  tomador = await consultarCnpj(doc);
  if (tomador) tomador = store.clientes.salvar(tomador);
}
if (!tomador) {
  console.error('Tomador não encontrado no cadastro nem na BrasilAPI. Cadastre-o pela interface web.');
  process.exit(1);
}

const pedido = {
  clienteId: tomador.id,
  servico: { descricao: opt('descricao').replace(/\\n/g, '\n'), valor: opt('valor'), competencia: opt('competencia') },
};
const prev = emissor.preparar(pedido);
console.log(`
Vou ${flag('simular') ? 'SIMULAR' : 'EMITIR'} a NFS-e (${config.ambiente}):
- Tomador:     ${prev.resumo.tomador.documento} — ${prev.resumo.tomador.nome}
- Serviço:     ${prev.resumo.descricao}
- Valor:       R$ ${prev.resumo.valor}
- Competência: ${prev.resumo.competencia}
- DPS nº:      ${prev.nDPS} (série ${config.serie})`);

if (!flag('sim') && !flag('simular')) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const r = await rl.question('Confirma a emissão? (s/N) ');
  rl.close();
  if (!/^s/i.test(r.trim())) {
    console.log('Cancelado.');
    process.exit(0);
  }
}

const nota = await emissor.emitir({ ...pedido, confirmado: true, simular: flag('simular') });
console.log(`\nStatus: ${nota.status}`);
if (nota.chaveAcesso) console.log(`Número: ${nota.numero ?? '-'}\nChave de acesso: ${nota.chaveAcesso}`);
if (nota.mensagem) console.log(nota.mensagem);
for (const e of nota.erros ?? []) console.log(`  ${e.codigo} ${e.descricao} ${e.complemento}`);
process.exit(nota.status === 'autorizada' || nota.status === 'simulada' ? 0 : 2);
