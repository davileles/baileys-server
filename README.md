# baileys-server

Servidor de mensageria das operações **Tica Promos (TSP)** e **Clube do Viajante (CDV)**: lê grupos e canais, monta ofertas e alertas e publica nos grupos de WhatsApp.

Uso interno. Este repositório não é um projeto para instalar do zero: não há passo a passo de instalação, e ele depende de serviços, variáveis de ambiente e dados que ficam fora daqui.

## O que tem aqui

| Parte | O que faz |
|---|---|
| `server.js` | Servidor principal (Node 20+, ESM, Express). Conexão WhatsApp (Baileys), filas de envio, rotas HTTP consumidas pelos painéis |
| `wa-envio/` | Motor de envio em grupo (Go + whatsmeow). Serviço separado; detalhes em [`wa-envio/README.md`](wa-envio/README.md) |
| `radar-*.js`, `awin-*.js`, `monitor-precos.js` | Radares de afiliados e série de preços |
| `bot-*.js`, `telegram-*.js` | Bots de revisão e leitura de canais no Telegram |
| `config-*.js`, `estados-cdv.js`, `tenants.js` | Configuração das operações, grupos por estado e operadores |
| `sync-github.js`, `feed-publico.js` | Sincronização de dados e publicação do feed dos sites |
| `apps-script/` | Script do Gmail que encaminha alertas por e-mail |
| `.github/` | Guardas de CI (sintaxe, superfície de rotas, regressão) |

## Documentação

- [`CLAUDE.md`](CLAUDE.md): arquitetura, módulos, rotas, variáveis de ambiente e regras de negócio. É a fonte da verdade e muda junto com o código.
- [`RUNBOOK.md`](RUNBOOK.md): operação e incidentes (como saber se está tudo bem, o que fazer quando o WhatsApp cai, como parear de novo).
- [`wa-envio/README.md`](wa-envio/README.md): o motor de envio em Go.

## Hospedagem

Railway, dois serviços a partir deste repositório: o servidor principal (raiz, com volume para a sessão) e o `wa-envio` (pasta `wa-envio/`, com volume próprio). Cada push na `main` publica em produção.

## Regras que não podem ser esquecidas

- Uma réplica só, sem sobreposição entre deploys e sem healthcheck (`railway.json`). Duas instâncias na mesma sessão derrubam uma à outra.
- Nunca apagar `creds.json`, `pre-key-*` nem `app-state-sync-*` da sessão.
- Mudança que reinicia o servidor fica para fora da janela de envio (8h–21h, horário de São Paulo).
- Nenhum token, senha, telefone ou identificador de grupo neste arquivo. Credenciais vivem só nas variáveis de ambiente do Railway.
- Renomeou ou removeu rota ou função listada em `.github/superficie.json`? Atualize o arquivo no mesmo commit.

## Validação antes de commitar

```bash
node --check server.js
node --check radar-ml.js   # e os demais .js alterados
```

O `node --check` não pega referência inexistente nem uso antes da declaração: conferir os nomes e a ordem das declarações.
