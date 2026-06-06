# TSP Baileys Server 🤖

Servidor Node.js com Baileys para envio de mensagens no WhatsApp via HTTP.  
Feito para rodar no **Railway** e ser acessado de qualquer dispositivo.

---

## Rotas disponíveis

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/` | Página de status |
| GET | `/qr` | Exibe o QR Code para conectar |
| GET | `/status` | Retorna JSON com status da conexão |
| POST | `/enviar` | Envia mensagem de texto |
| POST | `/enviar-imagem` | Envia imagem com legenda |
| GET | `/grupos` | Lista grupos do WhatsApp conectado |

---

## Deploy no Railway — passo a passo

### 1. Criar repositório no GitHub

1. Acesse [github.com](https://github.com) e crie um repositório novo  
   (pode ser privado) — ex: `baileys-server`
2. Faça upload dos arquivos desta pasta:  
   - `server.js`
   - `package.json`
   - `.gitignore`

> **Não suba** a pasta `sessao/` nem `node_modules/`

---

### 2. Criar projeto no Railway

1. Acesse [railway.app](https://railway.app) e faça login com sua conta GitHub
2. Clique em **"New Project"** → **"Deploy from GitHub repo"**
3. Selecione o repositório `baileys-server`
4. O Railway vai detectar o `package.json` e fazer o deploy automaticamente

---

### 3. Adicionar volume persistente (IMPORTANTE)

Sem isso, a sessão do WhatsApp se perde toda vez que o servidor reiniciar.

1. No painel do projeto no Railway, clique no serviço
2. Vá em **"Volumes"** → **"Add Volume"**
3. Configure:
   - **Mount path:** `/app/sessao`
4. Salve — o Railway vai reiniciar o serviço automaticamente

---

### 4. Conectar o WhatsApp

1. Após o deploy, vá em **"Settings"** → **"Domains"** e copie a URL pública  
   (ex: `https://baileys-server-production.up.railway.app`)
2. Acesse essa URL no navegador
3. Clique em **"Escanear QR Code"**
4. No WhatsApp do celular: **Dispositivos conectados → Conectar dispositivo**
5. Escaneie o QR — pronto! ✅

---

### 5. Atualizar a URL nos HTMLs

No seu arquivo HTML do gerador, atualize a variável do servidor:

```javascript
// Troque localhost pela URL do Railway:
const SERVIDOR = 'https://baileys-server-production.up.railway.app';
```

---

## Adicionar novos grupos

Edite o objeto `GRUPOS` no topo do `server.js`:

```javascript
const GRUPOS = {
  tsp:         '120363424721106736@g.us',
  cdv_ofertas: '120363423014138662@g.us',
  cdv_emissao: '120363172490263905@g.us',
  novo_grupo:  'ID_DO_GRUPO@g.us',   // ← adicione aqui
};
```

Para descobrir o ID de um grupo, acesse `/grupos` após conectar o WhatsApp.

---

## Uso das rotas

### POST /enviar
```json
{
  "grupo": "tsp",
  "mensagem": "🔥 Cupom SAVE10 — 10% off na Amazon!"
}
```

### POST /enviar-imagem
```
Content-Type: multipart/form-data
grupo: tsp
legenda: Confira essa oferta!
imagem: [arquivo]
```

---

## Solução de problemas

| Problema | Solução |
|----------|---------|
| QR não aparece | Aguarde ~10s e recarregue `/qr` |
| Sessão expirou | Acesse `/qr` e escaneie novamente |
| Grupo não encontrado | Acesse `/grupos` para ver os IDs corretos |
| Servidor não responde | Verifique os logs no painel do Railway |
