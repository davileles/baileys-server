# RUNBOOK — baileys-server (WhatsApp + Telegram, TSP/CDV)

Guia de **operação e incidente**. O `README.md` é o setup inicial; este arquivo é
"o WhatsApp parou — o que eu faço". Escrito para ser lido no celular, com o
servidor já degradado.

- Servidor: `https://baileys-server-production-ebfe.up.railway.app`
- Deploy: **automático** a cada commit no GitHub (nunca pedir redeploy manual).
- Sessão do WhatsApp: volume Railway em `/app/sessao` (sobrevive a restart).

---

## 1. Como saber se está tudo bem (em 10 segundos)

| Onde | O que olhar |
|---|---|
| `GET /health` | **200** = saudável. **503** = degradado; o corpo diz o `motivo`. É o endpoint para monitor externo (UptimeRobot/BetterStack). |
| `GET /status` | Retrato completo em JSON (`conectado`, `surdezEstado`, `ultimoUpsertEm`, `publicacoesHoje`, fila…). Sempre 200. |
| Bot Telegram `/status` | O mesmo retrato, pelo celular. |
| `GET /grupos/membros/trafego?dias=30` | Custo por entrada: gasto da planilha de tráfego (via proxy) ÷ entradas novas (CAC), ÷ entradas **confirmadas** (clique no convite `/g/<slug>` casado com o ADD do mesmo grupo em até `TRAFEGO_CONFIRMA_MIN` min, padrão 10) e ÷ saldo (custo por membro que fica). Por campanha (`?o=` da landing): cliques, confirmadas e taxa clique→entrada. |
| `GET /shield` · `POST /shield/config` · `POST /shield/grupo/:jid {modo}` · `POST /shield/falso-positivo/:id` | Proteção contra golpe nos grupos de destino. Mensagem de **não-admin que entrou há menos de `janelaNovoMin` min** (padrão 15, pelo ledger) com link externo ou isca de pix/prêmio. **OBSERVE** só registra e avisa; **PROTECT** apaga, remove e bloqueia pela conta executora (`executores`, padrão tico-02/03; principal só com `permitirPrincipal`). Falha fechado: sem texto legível, admin, reação ou mensagem de sistema nunca é golpe. Começar em observe, ligar protect grupo a grupo, marcar falsos positivos. Estado em `sessao/shield.json`. |
| `GET /links/repasse?dias=7` | Grupo com mais cliques únicos do que membros num disparo = mensagem circulando fora do grupo (a marca d'água viaja junto). Ranking por grupo e sinais por disparo; serve para não superestimar o grupo ao decidir reenvio. |
| `POST /monitor-precos/fila/:asin/recusar {motivo, aprender, termo}` · `GET/DELETE /monitor-precos/curadoria` | Curadoria que aprende: recusa com motivo; `aprender` = `produto`, `termo` (no nome) ou `loja` vira regra em `curadoria.*Evitados` da config do monitor, e `avaliar()` reprova com `evitado: …` antes de gastar leitura. Regra nova limpa a fila na hora. |
| `GET /reenvio/candidatos?dias=7&loja=&minHoras=6` | O que vale mandar de novo, por cliques **únicos por grupo** (contagem limpa do encurtador). Um item por produto (o último disparo). Excluídos com motivo: enviado há menos de `minHoras`, cupom não vigente, preço atual acima do anunciado. `cupomDoDia` à parte. Nada dispara: o painel leva o produto para uma lista de envio. |
| `GET /monitor-precos/dinheiro-na-mesa?horas=6` | Candidato que passou na regra do monitor e está na fila há mais de N horas sem ninguém publicar, com `precoAgora` e `aindaVale`. Também entra no resumo da manhã. |
| `GET /monitor-precos/vereditos?dias=7` | Modo sombra: a regra do monitor de preços julga **cada disparo real** (fila, auto-envio, lista) com o que sabia na hora — passou / sem série / série curta / sem queda / só com cupom / outra loja mais barata — e quantos minutos antes o produto já estava na fila. Traz também `passariamPorDia` (30 dias). Nada é bloqueado. |
| `GET /financeiro/mensal?mes=2026-09` | Resumo do mês: receita por plataforma (comissão revisada quando houver), receita por clique, gasto de anúncio com imposto + estrategista (planilha), resultado e margem, base média de membros e receita por membro, mês anterior nos **mesmos dias**, série diária. |
| `GET /grupos/membros/ltv?dias=60` | Coortes por **dia** de entrada: retenção em 1/3/7/15/30 dias (só quando a coorte inteira passou da idade; nada projetado), média das coortes anteriores do mesmo dia da semana, custo da entrada, quanto já devolveu e LTV ÷ CAC. LTV = comissão por membro-dia (`/afiliados/comissoes` do proxy ÷ censo) × vida média da base (base ÷ saídas por dia). |
| `GET /grupos/membros/hoje` | Entradas e saídas de hoje **contra o mesmo horário de ontem**, saldo, migrações (troca entre grupos nossos em 15 min: não conta como entrada nem saída), desistências (entrou e saiu no mesmo dia) e vagas por grupo (teto `MEMBROS_TETO`, padrão 1.010). Ledger alimentado pela principal, pelas contas extras e pelo wa-envio, com dedup entre fontes. |
| `travas` em `/status` ou `GET /alertas/travas` | Condições abertas que **só saem da lista quando a correção está no ar** (remetente deslogado, wa-envio fora, Telegram sem sessão, disjuntor da inserção ML). Marcar como lido não resolve; quando a condição some, chega um "OK — trava resolvida". |
| `remetentes` em `/status` | Um retrato por número (principal, tico-02, tico-03…): `conectado`, `conectadoHaS` (heartbeat), `disparoHabilitado`, `quarentena`/`quarentenaAte` e `ultimoErro`. `saidasEmVoo` e `reconexaoAdiada` mostram se há disparo em andamento segurando uma reconexão. |
| `publicacoesHoje` | **O número que importa.** Se está em 0 num dia útil depois das 10h, algo está errado mesmo que `conectado` seja `true`. Conta **entregas** (1 por grupo que recebeu), não ofertas: uma oferta em 30 grupos soma 30. `despachosHoje` é o par: 1 por oferta/cupom distinto. |

Sinais de **degradação** em `/status` ou `/health`:

- `conectado: false` → WhatsApp caído (seção 3).
- `logout: true` / `motivo: "logout"` → sessão invalidada, precisa **parear de novo** (seção 4).
- `surdezEstado != "ok"` → socket "conectado" mas sem receber nada (seção 3).
- `ultimoUpsertEm` parado há mais de 30 min em horário de movimento → surdez.

---

## 2. O que o servidor faz sozinho (antes de você agir)

O servidor tem várias defesas automáticas em camadas. **Dê a elas alguns minutos
antes de intervir** — intervir no meio de uma cura automática atrapalha.

| Defesa | Quando age | O que faz | Log |
|---|---|---|---|
| Keepalive do Baileys | socket morto sem `close` | emite `close` em ~35 s | — |
| Handler de `close` | queda normal | reconecta com backoff | `[WA]` |
| **Supervisor de WS** | `conectado=true` mas websocket **CLOSED** por 60 s (zumbi: o `close` foi ignorado) | força reconexão | `[SUPERVISOR-WS]` |
| **Escada de surdez** | sem upsert por 20 / 40 / 60 min | degrau 1 reconecta · degrau 2 reconecta + avisa · degrau 3 **sai com código 1** (Railway sobe container novo) | `[WATCHDOG]` |
| Auto-reset de Bad MAC | 8 mensagens indecifráveis seguidas → limpa sender-keys; 20 → reseta sessão (preserva pareamento) | cura desync de criptografia | `[BAD-MAC]` |
| Teto de envio | `sendMessage` preso > 60 s | rejeita e cai no retry | `[FILA]` / `[MKT]` |
| **Outbox** | destino falhou num despacho de vários grupos | guarda em disco e retenta com backoff (1→30 min) quando o socket volta; TTL 6 h; desiste após 12 e avisa | `[OUTBOX]` |
| **Quarentena de pareamento** | número pareado há menos de `QUARENTENA_H` horas (padrão 24, no wa-envio) | recusa disparo em **grupo** com `fase: quarentena`; o servidor trata a conta como indisponível e a escala escolhe outra | `[ENVIO:<conta>]` |
| **Travas** | condição persistente (remetente deslogado, conta fora há 10 min, wa-envio fora há 5 min, Telegram desconectado, disjuntor ML) | avisa uma vez ao abrir e uma vez ao fechar ("OK —"); nunca reavisa por leitura; recalculada a cada minuto pelo estado real | `[ALERTA] ... trava:` |
| **Reconexão adiada** | `/reconectar` ou supervisor de zumbi com envio em andamento | espera a saída esvaziar (teto 2 min) antes de derrubar o socket; nunca reinicia com disparo na fila | `[RECONEXAO]` |
| Logout | WhatsApp respondeu 401 | **avisa imediatamente** (Telegram + grupo operador + e-mail) e reavisa a cada hora; **não** tenta reconectar em loop | `[WA]` |
| Crash-only | `uncaughtException` | loga, salva e sai com 1 → Railway reinicia | `[FATAL]` |

Alertas chegam por **três canais**: bot Telegram (precisa de `TELEGRAM_BOT_TOKEN` +
`TELEGRAM_BOT_ADMINS`), grupo operador do WhatsApp e e-mail nos casos críticos
(`RESEND_API_KEY` + `ALERTA_EMAIL`). **Se você não recebe alertas, confira essas
variáveis antes de qualquer outra coisa** — sem elas o aviso volta `false` em silêncio.

---

## 3. WhatsApp caiu ou está surdo (`conectado:false` ou `surdezEstado != ok`)

1. **Espere 3 minutos.** Keepalive + handler + supervisor resolvem a maioria dos casos sem você.
2. Ainda caído? `/reconectar` no bot Telegram (pede confirmação) — ou `POST /reconectar`. Se a resposta vier `adiada: true`, há envio em andamento: a reconexão acontece sozinha assim que a saída esvaziar (teto 2 min).
3. Ainda caído depois de mais 2 min? Olhe `/status`:
   - `logout: true` → vá para a **seção 4**. Reconectar não resolve logout.
   - `errosDecodificacao` alto / logs cheios de `[BAD-MAC]` → `POST /reset-sessao` (limpa sessões e sender-keys, **preserva** o pareamento; reconecta sozinho).
   - `qrDisponivel: true` → a sessão pede pareamento; **seção 4**.
4. Nada funcionou → `POST /reset-sessao-completo` e pareie de novo (**seção 4**). Último recurso: apaga o pareamento.

**Nunca** apague arquivos `pre-key-*` à mão nem mexa no volume durante uma reconexão.

---

## 4. Parear de novo (logout, sessão apagada, número novo)

Prefira o **código de 8 dígitos** — não precisa de câmera nem de tela:

1. Abra `GET /pair` no navegador (tela guiada) ou `POST /pair` com `{ "numero": "55DDDNNNNNNNN" }` (só dígitos, com DDI).
2. O servidor reseta a sessão e devolve o código.
3. No celular: **WhatsApp → Dispositivos conectados → Conectar dispositivo → Conectar com número de telefone** → digite o código.
4. Acompanhe em `GET /pair/status` até `conectado: true`.

Alternativa por QR: `GET /qr`. Se vier vazio, rode `POST /reset-sessao-completo` antes.

O código vale poucos minutos. Se expirar, repita o passo 1 — cada `POST /pair` gera um código novo.

---

## 5. "Conectado, mas nada sai"

Primeiro: **`publicacoesHoje` em `/status`**. Se está crescendo, o problema é de um
produtor específico, não do servidor.

| Sintoma | Onde olhar | Ação |
|---|---|---|
| Ofertas aprovadas não saem | `GET /fila-envio` (`dentroJanela`, `previsaoHorario`, `workerAtivo`, `total`) | fora da janela **8h–21h SP** é normal esperar: a oferta fica em `aprovado` na fila até o worker publicar. Presas em `aprovado` após restart: `POST /fila-envio/reenfileirar` — `reenfileiradas:0` com a oferta em `aprovadasNaFila` é normal; o campo `resumo` já diz se há algo a fazer. |
| Grupo recebeu, outro não | logs `[OUTBOX]` | a outbox retenta sozinha por até 6 h. Se desistiu (aviso "desisti de entregar"), o bot provavelmente foi **removido do grupo**: ajuste os destinos na aba Grupos. |
| Radar CDV não envia | `GET /radar/fila` | fila persistida em `/sessao/fila_radar.json`; retenta com backoff, desiste após 12 com aviso. |
| Nenhum cupom do Telegram | `telegramConectado` em `/status` | `false` → `GET /tg-auth` para refazer o login do GramJS. |
| Mensagem chega mas não é capturada | `GET /debug-upserts` | confirma se o upsert está chegando; se chega e não classifica, o problema é no pipeline de IA (`ANTHROPIC_API_KEY`). |

---

## 6. Depois de qualquer deploy

`overlapSeconds: 0` no `railway.json`: o container antigo **sai antes** do novo subir
(evita duas instâncias na mesma sessão → loops 440). Isso gera ~30–60 s sem servidor a
cada deploy; as mensagens desse intervalo chegam em rajada na reconexão (`type: append`).

Checklist pós-deploy (1 min):

1. `GET /health` → 200.
2. `uptimeSeg` pequeno confirma que o novo container subiu.
3. `conectado: true` em até ~30 s. Se pedir QR/pair após deploy, a sessão não estava no volume — confira o mount `/app/sessao`.

Não configure **healthcheck** no Railway apontando para `/`, `/status` ou `/health`:
reiniciar não cura logout, e um healthcheck que depende do WhatsApp vira loop de restart.
Quem reinicia é o crash-only e o degrau 3 da escada.

---

## 7. Onde procurar nos logs do Railway

| Prefixo | Assunto |
|---|---|
| `[WA]` | conexão, `close` com código, logout |
| `[SUPERVISOR-WS]` | socket-zumbi detectado / reconexão forçada |
| `[WATCHDOG]` | escada de surdez (degraus 1–3), watchdog de saída, heartbeat |
| `[BAD-MAC]` | criptografia: limpeza de sender-keys, reset de sessão |
| `[FILA]` | worker de ofertas CDV (janela, intervalo, tentativas) |
| `[MKT]` / `[CUPONS]` | despacho TSP para vários grupos; falhas por destino |
| `[OUTBOX]` | entrega guardada / recuperada / desistida / expirada |
| `[RADAR]` | fila do Radar CDV |
| `[RESUMO]` | resumo diário ao operador |
| `[FATAL]` | exceção não tratada → restart |

Para um RCA, exporte os logs desde o **último `ultimoUpsertEm` normal** e procure,
nesta ordem: `close` + código → `Evento de fechamento de sock antigo ignorado` →
`[BAD-MAC]` → `[SUPERVISOR-WS]` → `[WATCHDOG]`.

---

## 8. Arquivos de estado (`/app/sessao`)

Todos gravados com **escrita atômica** (tmp + rename): um restart no meio da gravação
nunca deixa JSON truncado. `.tmp` órfãos são varridos pela faxina periódica.

| Arquivo | O que é | Pode apagar? |
|---|---|---|
| `creds.json`, `pre-key-*`, `session-*`, `sender-key-*`, `app-state-*` | sessão do WhatsApp | **Não à mão.** Use `/reset-sessao` ou `/reset-sessao-completo`. |
| `health.json` | escada de surdez, marcos diários (publicações, outbox, resumo) | sim, se quiser zerar a escada; o servidor recria |
| `fila_pendentes.json` | ofertas capturadas e seus status | não (é a fila de aprovação) |
| `outbox_falhas.json` | entregas por grupo aguardando retry | sim, se quiser descartar os retries pendentes |
| `fila_radar.json` | fila do Radar CDV | sim, se quiser descartar |
| `tg_ultimos_ids.json` | último id lido por canal do Telegram | não (evita reprocessar cupons antigos) |

---

## 9. Variáveis de ambiente que afetam a operação

| Variável | Efeito |
|---|---|
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_ADMINS` | alertas e comandos `/status` `/reconectar` no bot. **Sem elas, alerta nenhum chega pelo Telegram.** |
| `RESEND_API_KEY`, `ALERTA_EMAIL` | e-mail nos alertas críticos (logout, degrau 3) |
| `OUTBOX_TTL_H` | validade das entregas na outbox (padrão 6 h) |
| `RESUMO_DIARIO_HORA` | hora SP do resumo diário (padrão 21) |
| `TRAFEGO_CONFIRMA_MIN`, `TRAFEGO_IMPOSTO_PCT` | janela clique→ADD (padrão 10 min) e imposto somado ao gasto de anúncio (padrão 0) em `/grupos/membros/trafego` |
| `RODIZIO_VAGAS_MIN` | abaixo disso, a porta do rodízio vira trava de atenção (padrão 100); porta sem grupo elegível vira trava crítica |
| `MEMBROS_TETO` | teto de membros por grupo para o cálculo de vagas em `/grupos/membros/hoje` (padrão 1010) |
| `RESUMO_MANHA_HM` | hora SP do resumo da manhã, `HH:MM` (padrão `07:55`): remetentes, travas abertas, outbox, fila e inserção ML, antes das primeiras ofertas |
| `QUARENTENA_H` (no serviço **wa-envio**) | horas sem disparo em grupo após um pareamento novo (padrão 24; `0` desliga) |
| `ANTHROPIC_API_KEY` | classificação/extração por IA |
| `GITHUB_TOKEN`, `GITHUB_REPO` | sync de dados para `davileles/dados` |

---

## 10. O que NÃO fazer

- Não pedir redeploy manual — o deploy é automático por commit.
- Não rodar `/reset-sessao-completo` como primeira reação: perde o pareamento; tente `/reconectar` e `/reset-sessao` antes.
- Não configurar healthcheck do Railway dependente do WhatsApp (seção 6).
- Não intervir nos 3 primeiros minutos de uma queda: as defesas automáticas estão agindo.
- Não apagar `pre-key-*` ou `creds.json` à mão.
- Não subir mais de 1 réplica (`numReplicas: 1`): duas instâncias disputam a mesma sessão.
