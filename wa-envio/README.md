# wa-envio

Motor de **envio para grupos** do WhatsApp com [whatsmeow](https://github.com/tulir/whatsmeow).
Existe para eliminar o "Aguardando mensagem" dos membros: o whatsmeow redistribui a
sender key a todos os aparelhos em toda mensagem de grupo, sem depender do
`sender-key-memory` que dessincroniza no Baileys.

Só transporte. Leitura, radar e toda regra de negócio ficam no `server.js` da raiz,
que chama este serviço pela rede interna do Railway quando a conta está em `WA_ENVIO_CONTAS`.

## Railway

- Serviço novo neste repositório, **Root Directory** `wa-envio`, config file `/wa-envio/railway.json`.
- **Volume** montado em `/data` (sessões `<conta>.db` + `metricas.json`).
- Variáveis: `WA_ENVIO_TOKEN` (obrigatória), `WA_LOG_NIVEL` (padrão `WARN`).
- `overlapSeconds: 0`: duas instâncias na mesma sessão derrubam uma à outra.

## Rotas

| Método | Rota | Auth | |
|---|---|---|---|
| GET | `/health` | não | estado das contas, sem número |
| GET | `/pair` | não | tela para parear por código |
| GET | `/contas/{id}` | sim | estado com número |
| POST | `/contas/{id}/conectar` | sim | sobe o socket (abre QR se não pareada) |
| GET | `/contas/{id}/qr` | sim | QR bruto |
| POST | `/contas/{id}/pair` | sim | `{numero}` → código de 8 dígitos |
| POST | `/contas/{id}/logout` | sim | desloga e apaga a sessão |
| POST | `/contas/{id}/enviar` | sim | `{jid, texto, linkPreview?, imagem?}` |
| GET | `/contas/{id}/grupos` | sim | grupos, participantes, só-admins, sou admin |
| GET | `/metricas` | sim | envios e retries por conta/grupo/dia (30 dias) |

Erro de envio devolve `fase`: `validacao`, `conexao`, `preparo`, `upload` (nada saiu, pode
tentar por outro caminho) ou `envio` (ambíguo: não reenviar por outro número).

Pareamento: cada número vira um **dispositivo vinculado novo** ("Tica Envio"). A sessão do
Baileys não é convertível. Limite do WhatsApp: 4 dispositivos por número.
