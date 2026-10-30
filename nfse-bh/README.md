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
| `GET/POST/DELETE` | `/api/clientes` | cadastro de tomadores |

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
- **Cancelamento** e **substituição** ainda não implementados (fazer pelo portal).
- **IBS/CBS** (reforma tributária): grupo opcional da DPS ainda não preenchido.
