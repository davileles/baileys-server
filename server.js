import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import express from 'express';
import cors from 'cors';
import pino from 'pino';
import multer from 'multer';
import { Boom } from '@hapi/boom';
import { readFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import QRCode from 'qrcode';

// ── GRUPOS ────────────────────────────────────────────────────────────────────
// Adicione ou edite os grupos aqui. Use o nome como chave e o ID como valor.
const GRUPOS = {
  tsp:         '120363424721106736@g.us',
  cdv_ofertas: '120363423014138662@g.us',
  cdv_emissao: '120363172490263905@g.us',
};

// ── CONFIGURAÇÃO ──────────────────────────────────────────────────────────────
const PORT        = process.env.PORT || 3001;
const SESSAO_DIR  = './sessao';
const UPLOAD_DIR  = './tmp-uploads';

[SESSAO_DIR, UPLOAD_DIR].forEach(d => { if (!existsSync(d)) mkdirSync(d, { recursive: true }); });

const app    = express();
const upload = multer({ dest: UPLOAD_DIR });

app.use(cors());
app.use(express.json());

// ── ESTADO ────────────────────────────────────────────────────────────────────
let sock       = null;
let conectado  = false;
let qrAtual    = null;   // QR em base64 para exibir no browser

// ── HELPERS ───────────────────────────────────────────────────────────────────
function resolverGrupo(chave) {
  // Aceita nome (ex: "tsp") ou ID direto (ex: "120363...@g.us")
  return GRUPOS[chave] ?? (chave?.includes('@g.us') ? chave : null);
}

// ── WHATSAPP ──────────────────────────────────────────────────────────────────
async function conectar() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSAO_DIR);
  const { version }          = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: true,   // aparece no log do Railway também
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // Gera QR como imagem base64 para exibir via /qr
      qrAtual = await QRCode.toDataURL(qr);
      console.log('📱 QR Code gerado — acesse /qr no navegador para escanear.');
    }

    if (connection === 'open') {
      conectado = true;
      qrAtual   = null;
      console.log('✅ WhatsApp conectado!');
    }

    if (connection === 'close') {
      conectado = false;
      const codigo     = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const reconectar = codigo !== DisconnectReason.loggedOut;
      console.log(`⚠️  Conexão encerrada (código ${codigo}). Reconectar: ${reconectar}`);
      if (reconectar) {
        setTimeout(conectar, 5000);
      } else {
        console.log('🔴 Sessão expirada. Acesse /qr para conectar novamente.');
        qrAtual = null;
      }
    }
  });
}

// ── ROTAS ─────────────────────────────────────────────────────────────────────

// Página inicial com status e link para QR
app.get('/', (req, res) => {
  const status = conectado ? '🟢 Conectado' : qrAtual ? '🟡 Aguardando QR' : '🔴 Desconectado';
  res.send(`
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
      <meta charset="UTF-8">
      <title>TSP Baileys Server</title>
      <style>
        body { font-family: sans-serif; background: #0d0d0d; color: #f0f0f0;
               display: flex; flex-direction: column; align-items: center;
               justify-content: center; min-height: 100vh; gap: 20px; margin: 0; }
        h1 { color: #ffa500; }
        .status { font-size: 1.4rem; }
        a { color: #ffa500; text-decoration: none; border: 1px solid #ffa500;
            padding: 10px 24px; border-radius: 8px; }
        a:hover { background: #ffa500; color: #000; }
      </style>
    </head>
    <body>
      <h1>🤖 TSP Baileys Server</h1>
      <p class="status">${status}</p>
      ${!conectado ? '<a href="/qr">📷 Escanear QR Code</a>' : '<p>Servidor pronto para enviar mensagens.</p>'}
    </body>
    </html>
  `);
});

// Exibe o QR Code para escanear
app.get('/qr', (req, res) => {
  if (conectado) {
    return res.send(`
      <html><body style="background:#0d0d0d;color:#ffa500;font-family:sans-serif;
        display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column">
        <h2>✅ WhatsApp já está conectado!</h2>
        <a href="/" style="color:#ffa500">← Voltar</a>
      </body></html>
    `);
  }
  if (!qrAtual) {
    return res.send(`
      <html><head><meta http-equiv="refresh" content="3"></head>
      <body style="background:#0d0d0d;color:#f0f0f0;font-family:sans-serif;
        display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column">
        <h2>⏳ Gerando QR Code...</h2>
        <p>A página vai atualizar automaticamente.</p>
      </body></html>
    `);
  }
  res.send(`
    <html>
    <head>
      <title>Escanear QR</title>
      <meta http-equiv="refresh" content="30">
      <style>
        body { background:#0d0d0d; color:#f0f0f0; font-family:sans-serif;
               display:flex; flex-direction:column; align-items:center;
               justify-content:center; min-height:100vh; gap:16px; margin:0; }
        h2 { color:#ffa500; }
        img { border:4px solid #ffa500; border-radius:12px; width:260px; height:260px; }
        p { color:#aaa; font-size:0.9rem; }
      </style>
    </head>
    <body>
      <h2>📱 Escanear QR Code</h2>
      <img src="${qrAtual}" alt="QR Code"/>
      <p>Abra o WhatsApp → Dispositivos conectados → Conectar dispositivo</p>
      <p>A página atualiza a cada 30 segundos. Se o QR expirar, recarregue.</p>
    </body>
    </html>
  `);
});

// Status da conexão (usado pelo HTML para checar)
app.get('/status', (req, res) => {
  res.json({
    conectado,
    grupos: Object.keys(GRUPOS),
    qrDisponivel: !!qrAtual,
  });
});

// Enviar mensagem de texto
app.post('/enviar', async (req, res) => {
  const { grupo, mensagem } = req.body;

  if (!conectado || !sock)
    return res.status(503).json({ ok: false, erro: 'WhatsApp não conectado. Acesse /qr para conectar.' });

  const grupoId = resolverGrupo(grupo);
  if (!grupoId)
    return res.status(400).json({ ok: false, erro: `Grupo inválido: "${grupo}"` });

  if (!mensagem?.trim())
    return res.status(400).json({ ok: false, erro: 'Mensagem não pode estar vazia.' });

  try {
    await sock.sendMessage(grupoId, { text: mensagem });
    res.json({ ok: true });
  } catch (err) {
    console.error('Erro ao enviar mensagem:', err);
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Enviar imagem com legenda
app.post('/enviar-imagem', upload.single('imagem'), async (req, res) => {
  const { grupo, legenda } = req.body;
  const file = req.file;

  if (!conectado || !sock) {
    if (file) unlinkSync(file.path);
    return res.status(503).json({ ok: false, erro: 'WhatsApp não conectado. Acesse /qr para conectar.' });
  }

  const grupoId = resolverGrupo(grupo);
  if (!grupoId) {
    if (file) unlinkSync(file.path);
    return res.status(400).json({ ok: false, erro: `Grupo inválido: "${grupo}"` });
  }

  if (!file)
    return res.status(400).json({ ok: false, erro: 'Imagem obrigatória.' });

  try {
    const buffer = readFileSync(file.path);
    await sock.sendMessage(grupoId, {
      image: buffer,
      caption: legenda || '',
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('Erro ao enviar imagem:', err);
    res.status(500).json({ ok: false, erro: err.message });
  } finally {
    if (existsSync(file.path)) unlinkSync(file.path);
  }
});

// ── BUSCAR PRODUTO COM CLAUDE API ────────────────────────────────────────────
// Rota: recebe texto já extraído do browser + url, manda para Claude API
app.post('/buscar-produto', async (req, res) => {
  const { texto, url } = req.body;
  if (!texto) return res.status(400).json({ ok: false, erro: 'Campo "texto" obrigatório.' });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ ok: false, erro: 'ANTHROPIC_API_KEY não configurada no servidor.' });

  try {
    const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: `Extraia APENAS o nome do produto e o preço do texto abaixo, que veio de uma página de e-commerce (URL: ${url || 'desconhecida'}).
Responda SOMENTE em JSON válido, sem markdown, sem explicação, no formato:
{"nome": "Nome completo do produto", "preco": "299.90"}

Regras:
- preco: apenas números e ponto decimal (ex: 199.90). Se houver preço com e sem desconto, use o MENOR (preço final).
- Se não encontrar um dos campos, use null.
- Nome deve ser o título do produto, sem o nome da loja.

Texto da página:
${texto.substring(0, 8000)}`
        }]
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!claudeResp.ok) {
      const errText = await claudeResp.text();
      console.error('Erro Claude API:', errText);
      return res.status(502).json({ ok: false, erro: 'Erro ao consultar Claude API.' });
    }

    const claudeData = await claudeResp.json();
    const textoResposta = claudeData.content?.[0]?.text?.trim();
    if (!textoResposta) return res.json({ ok: false, erro: 'Claude não retornou resposta.' });

    let resultado;
    try {
      resultado = JSON.parse(textoResposta);
    } catch {
      const match = textoResposta.match(/\{[\s\S]*\}/);
      if (match) resultado = JSON.parse(match[0]);
      else return res.json({ ok: false, erro: 'Não foi possível interpretar a resposta.' });
    }

    const { nome, preco } = resultado;
    if (!nome && !preco) return res.json({ ok: false, erro: 'Produto não encontrado na página.' });

    res.json({ ok: true, nome: nome || null, preco: preco || null });

  } catch (err) {
    console.error('Erro buscar-produto:', err.message);
    res.status(500).json({ ok: false, erro: err.message });
  }
});
// Listar grupos do WhatsApp (útil para pegar IDs)
app.get('/grupos', async (req, res) => {
  if (!conectado || !sock)
    return res.status(503).json({ ok: false, erro: 'WhatsApp não conectado.' });

  try {
    const chats  = await sock.groupFetchAllParticipating();
    const grupos = Object.values(chats)
      .map(g => ({ id: g.id, nome: g.subject }))
      .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
    res.json({ ok: true, grupos });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`🔗 Acesse /qr para conectar o WhatsApp`);
});

conectar();
