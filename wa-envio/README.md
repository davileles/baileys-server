# wa-envio

Motor de **envio para grupos** do WhatsApp com [whatsmeow](https://github.com/tulir/whatsmeow).
Existe para eliminar o "Aguardando mensagem" dos membros: o whatsmeow redistribui a
sender key a todos os aparelhos em toda mensagem de grupo, sem depender do
`sender-key-memory` que dessincroniza no Baileys.

Só transporte. Leitura, radar e toda regra de negócio ficam no `server.js` da raiz,
que chama este serviço pela rede interna do Railway quando a conta está em `WA_ENVIO_CONTAS`.

## Railway

Serviço `wa-envio` neste repositório, configurado **pelo painel** (Config as Code não vale para serviços novos):

- **Root Directory** `wa-envio` — o `Dockerfile` é detectado sozinho.
- **Watch Paths** `/wa-envio/**`.
- **Volume** montado em `/data` (sessões `<conta>.db` + `metricas.json`).
- **Variáveis**:
  - `WA_ENVIO_TOKEN` (obrigatória), `PORT=8080`, `WA_LOG_NIVEL` (padrão `WARN`)
  - `RAILWAY_DEPLOYMENT_OVERLAP_SECONDS=0` — duas instâncias na mesma sessão derrubam uma à outra
  - `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=15`

No `baileys-server`: `WA_ENVIO_URL=http://wa-envio.railway.internal:8080`, `WA_ENVIO_TOKEN=${{wa-envio.WA_ENVIO_TOKEN}}`,
`WA_ENVIO_CONTAS` (liga o motor por conta) e `WA_ENVIO_GRUPOS` (opcional, restringe a grupos).

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
| GET | `/leitura` | sim | estado do repasse de leitura (fila, entregues, falhas, imagens) |
| GET | `/metricas` | sim | envios, retries por hora/grupo/dia, tentativas e eventos de conexão (30 dias) |

Erro de envio devolve `fase`: `validacao`, `conexao`, `preparo`, `upload` (nada saiu, pode
tentar por outro caminho) ou `envio` (ambíguo: não reenviar por outro número).

Pareamento: cada número vira um **dispositivo vinculado novo** ("Tica Envio"). A sessão do
Baileys não é convertível. Limite do WhatsApp: 4 dispositivos por número. O código deve ser
pedido com o número **como aparece no celular**; celular brasileiro sem o nono dígito
(`553190110150`) é corrigido sozinho para `5531990110150`.

## Leitura (modo sombra)

Com `LEITURA_URL` (base do baileys-server) e `LEITURA_CONTAS` (padrão `principal`), as mensagens
recebidas nos grupos que o servidor lê — fontes do radar TSP e monitorados do CDV, lista em
`GET /interno/wa-leitura/grupos` — são repassadas para `POST /interno/wa-leitura/mensagens`, em
protojson, com a imagem já baixada. Nesta fase o servidor só compara com o Baileys
(`GET /interno/wa-leitura/comparacao`); nada entra no pipeline.

O whatsmeow emite um evento por parte decifrada de cada mensagem de grupo (primeiro a parte 1:1
com a sender key, depois o conteudo), com o mesmo id. A parte que so distribui a chave nao e
repassada: o Baileys entrega as duas juntas, e o dedup por id do servidor descartaria o conteudo.

## Aparelhos instáveis

Cada pedido de reenvio traz o *registration id* do aparelho, que só muda quando o WhatsApp dele é
ativado de novo. Aparelho reativado mais de uma vez no dia (3+ registration ids ou 2+ trocas de
identidade) fica marcado como **instável**: não consegue decifrar o que chega entre uma ativação e
outra, por melhor que seja o envio. Em `GET /metricas`, cada conta ganha `resumoAparelhos`
(aparelhos com pedido, instáveis, `ocorrenciasSemInstaveis`, lista dos instáveis e dos aparelhos
com mais pedidos) e cada grupo ganha `aparelhos` e `ocorrenciasInstaveis`. O detalhe cru por
aparelho vem com `?aparelhos=1` (guardado por 7 dias).
