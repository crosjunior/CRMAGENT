# NFS-e BH — emissor automático (Padrão Nacional)

Aplicação local que emite NFS-e para prestadores de **Belo Horizonte/MG** pelo **Sistema Nacional NFS-e**
(o mesmo backend do portal `nfse.gov.br/EmissorNacional`). Você informa **cliente, descrição e valor**; a
aplicação monta a DPS, assina com o certificado A1 da empresa, envia à Sefin Nacional e guarda a NFS-e gerada.

## Por que API e não robô no portal

O portal web é só uma interface sobre a **API oficial da Sefin Nacional**. Automatizar cliques (Playwright)
quebraria a cada mudança de tela e esbarra em captcha/seleção de certificado. A API é o canal oficial
para sistemas: autenticação por mTLS com o e-CNPJ, DPS em XML (leiaute **1.01**) assinada, resposta síncrona
com a chave de acesso. A nota emitida aparece normalmente no portal.

```
Cliente + descrição + valor
   → DPS XML (leiaute 1.01, validada no XSD oficial)
   → assinatura XMLDSig RSA-SHA256 (certificado A1)
   → gzip + base64 → POST /SefinNacional/nfse (mTLS)
   → NFS-e (chave de acesso + XML) salva em data/
```

## Módulos

| Aba | O que faz |
|---|---|
| **Emitir** | Escolhe o cliente (descrição, valor, código de serviço e ISS retido vêm do cadastro dele), confere e emite |
| **Notas** | Controle financeiro: aguardando pagamento, em atraso, pago, cancelada, substituída; datas de envio, vencimento e pagamento; baixa manual; observações por nota; mensagem pronta; exportação CSV |
| **Clientes** | Cadastro com configurações por cliente: código de serviço, ISS retido e alíquota, descrição/valor padrão, prazo ou dia fixo de vencimento, contato, e-mails de cobrança, WhatsApp, modelo de mensagem, nomes alternativos no extrato |
| **Recebidas** | Notas emitidas por fornecedores contra a empresa (contas a pagar): a pagar, vencida, paga, cancelada; ISS retido a recolher; baixa manual ou pelo extrato |
| **Fornecedores** | Quem emitiu notas para a empresa: totais por mês, por ano e por tipo de serviço; classificação automática (código de serviço, CNAE da Receita, descrições e nome), ajustável |
| **Contratos** | Lê contratos/propostas (PDF, DOCX, TXT ou texto colado), extrai cliente, valores e parcelas, agenda a emissão de cada nota e acompanha faturado × recebido |
| **Agenda** | Emissões planejadas por data ou frequência (semanal a anual), em modo *lembrete* (um clique) ou *automático*; calendário de 90 dias; sugestões a partir do histórico |
| **Mensagens** | Modelos de texto com variáveis (`{{cliente.contato}}`, `{{nota.valorAPagar}}`, `{{nota.vencimento}}`, `{{pix}}`…) e prévia com dados reais; envio por e-mail, WhatsApp ou cópia |
| **Extrato** | Importa OFX, CSV ou TXT do banco e dá baixa automática casando valor (bruto ou líquido) com nome/CNPJ do cliente; casos ambíguos ficam para confirmar |
| **Config** | Importação do histórico (XML/ZIP do portal ou sincronização pelo ADN), dados do emitente, serviço padrão, dados bancários, numeração |

### Buscar todas as notas no portal (emitidas e recebidas)

A busca roda **sozinha a cada 15 dias** enquanto a aplicação está aberta (a primeira vez, ao iniciar). Para buscar na hora: **Config → Buscar notas de 2026**. com o certificado A1, a aplicação lê no Ambiente de Dados
Nacional (ADN) todos os documentos em que a empresa aparece e separa:
- notas em que a Conexão Ágil é **prestadora** → **Notas** (e o cliente é cadastrado/atualizado);
- notas em que é **tomadora** (fornecedores) → **Recebidas**;
- cancelamentos → aplicados nas duas listas.

A busca de um ano relê o histórico desde o primeiro documento e guarda só o ano escolhido; notas já existentes
(mesma chave, ou mesmo número + cliente + data) não são duplicadas. A consulta é só leitura e usa o ADN de
produção mesmo com `NFSE_AMBIENTE=homologacao`. Notas de municípios que não compartilham com o ADN não aparecem —
envie o PDF/XML delas manualmente.

### Contratos e propostas

Em **Contratos**, envie o documento e/ou descreva as condições. A leitura extrai contratante, objeto, valor, parcelas
(datas de emissão e vencimento), reajuste e multa; você revisa, ajusta e salva. Ao salvar, cada parcela vira um
agendamento de emissão (modo lembrete) e o contrato mostra parcelas previstas, faturadas, pagas e em atraso.

- **Com IA**: coloque `ANTHROPIC_API_KEY=` no `.env` (chave da API da Anthropic). O documento é lido pelo Claude
  (`claude-opus-5-5`, saída em JSON com esquema fixo); PDFs vão inteiros, com tabelas.
- **Sem IA**: leitura por regras (CNPJ, valores, nº de parcelas, periodicidade, prazo em dias) — sempre revise.

### Primeira carga dos dados

Clientes, notas e agenda ficam em `data/` (fora do git). Para carregá-los numa instalação nova:
- copie o pacote `.json` e o ZIP/PDFs/XMLs das notas para a pasta **`nfse-bh/importar/`** e rode `npm start`:
  tudo é importado ao iniciar e os arquivos vão para `importar/processados/`; ou
- com a aplicação aberta e sem clientes, use o quadro **Carregar meus dados** (selecione todos os arquivos de uma vez).

Dados do emitente já preenchidos na tela prevalecem sobre os do pacote.

### Importar as notas já emitidas

Em **Config → Importar histórico**:
- **Enviar notas (PDF, XML ou ZIP)**: o DANFSe em PDF ou o XML baixados do portal Emissor Nacional. Do PDF a
  aplicação lê chave, número, datas, tomador (com endereço e IBGE), códigos de serviço, NBS, local da
  prestação, valores e retenção; o código IBGE do local da prestação é consultado na API do IBGE.
- **Importar pacote (.json)**: emitente, clientes, notas e agenda de uma vez (backup ou carga preparada).
  **Baixar backup** gera o mesmo formato.
- **Sincronizar com o portal (ADN)**: baixa direto do Ambiente de Dados Nacional, com o certificado, todas as NFS-e
  e eventos da empresa (incluindo cancelamentos). Pode ser repetido; só traz o que é novo.

O **CPF/CNPJ é a chave do cliente**: importações atualizam o cadastro existente e o formulário recusa
um segundo cliente com o mesmo documento. Cada cliente é cadastrado com as configurações da nota mais recente dele
(código de serviço, NBS, local da prestação, ISS retido); a descrição padrão sai sem os dados bancários
(que vêm do rodapé) e com o valor trocado por `{{valor}}`. Notas antigas (mais de N dias,
configurável) entram como pagas; as recentes, como "aguardando pagamento", para baixar pelo extrato.

### Baixa automática pelo extrato

Cada crédito é comparado com as notas em aberto (e com as que a importação do histórico marcou como pagas sem
data de pagamento) por **CNPJ** (com ou sem pontuação, ou só a raiz), **nome** (razão social, fantasia, apelidos),
**valor** (bruto, líquido de ISS retido, ou líquido de retenções até 15%) e **data** (emitida até 75 dias antes).

- Cliente (CNPJ/nome/regra aprendida) + valor exato → baixa automática (havendo duas iguais, paga a mais antiga).
- CNPJ + valor com retenção, e é a única nota em aberto do cliente no período → baixa automática.
- Caso contrário fica em "A conferir" com as **notas relacionadas** e os motivos (CNPJ, nome, valor, período).
  Dá para pesquisar notas de outros meses (mês anterior, meses antes, todos) ou **importar o PDF/XML** da nota
  que faltava — ao importar, os pendentes são reavaliados e a baixa sai sozinha se casar.
- Linhas de saldo ("SALDO TOTAL DISPONÍVEL", "SALDO ANTERIOR"…) são ignoradas sempre.

**Aprendizado:** ao ligar um lançamento a uma nota, a descrição passa a identificar aquele cliente; ao marcar
"Não é nota", lançamentos com a mesma descrição passam a ser ignorados. As regras valem para os próximos
extratos e para os pendentes atuais, ficam em `data/estado.json` e podem ser vistas/esquecidas na própria tela.
"Desfazer" reverte a baixa e esquece a regra. Reimportar o mesmo extrato não duplica baixas.

### Descrição com variáveis

Descrições (do cliente, da agenda ou digitadas) aceitam `{{valor}}`, `{{mes}}`/`{{Mes}}`,
`{{mesAnterior}}`/`{{MesAnterior}}`, `{{ano}}`, `{{anoMesAnterior}}` e `{{hoje}}`, substituídas na emissão.
Ex.: `Profissional Fluig - {{MesAnterior}}/{{anoMesAnterior}} R$ {{valor}}`.

### Agenda automática

No modo automático a nota é emitida na data **somente com `NFSE_AMBIENTE=producao`**; em homologação ela
aparece como lembrete (para a data não ser consumida por uma nota de teste). Ao emitir um lembrete, a descrição
e o valor podem ser ajustados só para aquela nota (ex.: número do pedido de compra do mês).

## Requisitos

- Node.js 20+
- Certificado digital **A1** (e-CNPJ, `.pfx`/`.p12`) da empresa prestadora
- Empresa habilitada no Emissor Nacional (primeiro acesso feito no portal)

## Instalação

```bash
cd nfse-bh
npm install
cp .env.example .env    # Windows (cmd/PowerShell): copy .env.example .env
mkdir certificado        # coloque o .pfx aqui (ignorado pelo git)
npm start                # http://localhost:3333
```

Preencha no `.env` o CNPJ, a IM, o caminho e a senha do `.pfx`. No Windows, use barras normais no caminho
(`NFSE_PFX_PATH=certificado/empresa.pfx`) e não coloque aspas na senha.

Comece em `NFSE_AMBIENTE=homologacao` (produção restrita, sem valor fiscal). Quando as notas de teste
saírem sem erro, troque para `producao`.

## Uso

**Interface web** (mobile-first, tema claro/escuro):

1. **Clientes** — cadastre o tomador. Pelo CNPJ, razão social e endereço vêm da Receita (BrasilAPI); pelo CEP,
   o endereço e o código IBGE vêm do ViaCEP.
2. **Emitir** — escolha o cliente, descreva o serviço, informe valor e competência → **Conferir nota**.
3. Na tela de confirmação, confira o resumo (e o XML, se quiser) → **Emitir NFS-e** ou **Simular**
   (assina e guarda o XML sem enviar).
4. **Notas** — histórico com status, chave de acesso, download dos XML e link para a consulta pública/DANFSe.

**Linha de comando** (para rotinas e integrações):

```bash
npm run emitir -- --doc 11444777000161 --valor 1860,00 --descricao "Mentoria executiva\nPacote 4 sessões"
```

Pede confirmação antes de enviar; `--sim` confirma direto (uso em scripts), `--simular` não envia.

**API HTTP** (para o CRM chamar):

| Método | Rota | Uso |
|---|---|---|
| `POST` | `/api/notas/preparar` | monta a DPS e devolve resumo + XML (sem enviar) |
| `POST` | `/api/notas` | emite; exige `"confirmado": true` (ou `"simular": true`) |
| `GET` | `/api/notas` | histórico |
| `POST` | `/api/notas/:id/verificar` | resolve nota pendente consultando a DPS na Sefin |
| `PATCH` | `/api/notas/:id` | baixa (`{"baixa":{"tipo":"pago","dataPagamento":"2026-10-20"}}`), observações, envio, vencimento |
| `GET/POST/DELETE` | `/api/clientes` | cadastro de tomadores |
| `POST` | `/api/importar/arquivos` · `/api/importar/adn` | importação do histórico |
| `POST` | `/api/extrato` | conciliação bancária (`{ nome, conteudo }`) |
| `GET` | `/api/extrato/:id/notas?mes=&q=` | pesquisa notas para um lançamento (outros meses, cliente, nº) |
| `POST` | `/api/extrato/:id/conciliar` · `/ignorar` · `/reabrir` | ligar (aprende), "não é nota" (aprende), desfazer |
| `GET`/`DELETE` | `/api/extrato/regras` | regras aprendidas |
| `GET/POST` | `/api/agendas` · `/api/modelos` | planejamento e modelos de mensagem |

```json
POST /api/notas
{ "clienteId": "…", "confirmado": true,
  "servico": { "descricao": "Treinamento OKR Essencial", "valor": "4.500,00", "competencia": "2026-10-01" } }
```

## Configuração fiscal (`.env`)

| Variável | Padrão | Observação |
|---|---|---|
| `SERVICO_TRIB_NAC` | `080201` | 08.02.01 Instrução, treinamento, orientação pedagógica |
| `SERVICO_TRIB_MUN` | `001` | desdobro municipal de BH |
| `PRESTADOR_OP_SIMPLES` | `3` | ME/EPP. MEI = `2`, não optante = `1` |
| `SERVICO_PTOTTRIB_SN` | `6.00` | % aproximado de tributos (Lei 12.741). **Obrigatório para ME/EPP**; use a alíquota efetiva da sua faixa |
| `SERVICO_ALIQUOTA` | vazio | deixe vazio: BH parametriza a alíquota e a Sefin calcula (informar sem necessidade gera E0617) |
| `SERVICO_RODAPE` | — | texto anexado a toda descrição (ex.: dados bancários) |

ISSQN vai como *operação tributável, não retido*, local da prestação BH.

## Segurança da emissão

- **Nunca emite sem confirmação explícita** (`confirmado: true` na API, pergunta no CLI, diálogo na UI).
- **Numeração**: o nº da DPS só avança quando a nota é gerada; DPS rejeitada não consome número.
- **Falha de rede no envio**: a nota fica `pendente` e bloqueia novas emissões até ser verificada
  (`GET /dps/{id}` na Sefin). Isso evita nota em duplicidade.
- Emissões são serializadas: duas requisições simultâneas nunca usam o mesmo número.
- Servidor escuta só em `127.0.0.1`; certificado, `.env` e `data/` estão no `.gitignore`.
- Se já emitiu notas pelo portal, ajuste o próximo nº da DPS em **Config** para não colidir com a série usada lá.

## Privacidade

Clientes, notas, extratos e dados do emitente ficam somente em `data/` na sua máquina (fora do git). O
repositório é público: não coloque dados de clientes no código.

## Testes

```bash
npm test
```

Cobrem: DPS válida no **XSD oficial 1.01** (com e sem assinatura), assinatura verificável, regras do Simples
(ME/EPP × MEI), validação de entrada, numeração em rejeição/sucesso, recuperação de resultado incerto e o
cliente HTTP com mTLS contra um servidor local. Os XSD oficiais estão em `schemas/`.

## Limitações conhecidas

- **Não testado contra a Sefin real** neste desenvolvimento (sem acesso de rede ao nfse.gov.br nem certificado).
  Faça as primeiras emissões em homologação.
- **DANFSe (PDF)**: a API nacional de DANFSe foi desativada em 08/2026; a app oferece o XML e o link da consulta
  pública, onde o PDF pode ser baixado.
- **Cancelamento** e **substituição** fiscais são feitos no portal; aqui a nota é marcada no controle (ou o
  evento é importado pela sincronização com o ADN).
- **Modo automático da agenda** só emite com a aplicação rodando (o agendador verifica a cada 15 minutos).
- **E-mail**: a mensagem abre no seu cliente de e-mail (ou WhatsApp); a aplicação não envia e-mail sozinha.
- **IBS/CBS** (reforma tributária): grupo opcional da DPS ainda não preenchido.
