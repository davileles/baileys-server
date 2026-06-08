import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
} from '@whiskeysockets/baileys';
import express from 'express';
import cors from 'cors';
import pino from 'pino';
import multer from 'multer';
import { Boom } from '@hapi/boom';
import { readFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import QRCode from 'qrcode';

// ── GRUPOS DE DESTINO ─────────────────────────────────────────────────────────
const GRUPOS = {
  tsp:         '120363424721106736@g.us',
  cdv_ofertas: '120363423014138662@g.us',
  cdv_emissao: '120363172490263905@g.us',
};

// ── GRUPOS MONITORADOS ────────────────────────────────────────────────────────
// IDs dos grupos de onde capturar ofertas de passagens
const GRUPOS_MONITORADOS = [
  '120363337360235613@g.us',
];

// ── DESTINO DAS OFERTAS CAPTURADAS ────────────────────────────────────────────
const GRUPO_DESTINO_PASSAGENS = 'cdv_emissao';

// ── CONFIGURAÇÃO ──────────────────────────────────────────────────────────────
const PORT            = process.env.PORT || 3001;
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY;
const SESSAO_DIR      = './sessao';
const UPLOAD_DIR      = './tmp-uploads';

[SESSAO_DIR, UPLOAD_DIR].forEach(d => { if (!existsSync(d)) mkdirSync(d, { recursive: true }); });

const app    = express();
const upload = multer({ dest: UPLOAD_DIR });

app.use(cors());
app.use(express.json({ limit: '20mb' }));

// ── ESTADO ────────────────────────────────────────────────────────────────────
let sock      = null;
let conectado = false;
let qrAtual   = null;

// Fila de ofertas pendentes de revisão
// { id, timestamp, grupoOrigem, tipoConteudo, conteudoOriginal, imagemBase64, mensagemFormatada, status }
const filaPendentes = [];
let contadorId = 1;

// ── HELPERS ───────────────────────────────────────────────────────────────────
function resolverGrupo(chave) {
  return GRUPOS[chave] ?? (chave?.includes('@g.us') ? chave : null);
}

function gerarId() {
  return contadorId++;
}

// ── IA: INTERPRETAR OFERTA ────────────────────────────────────────────────────
async function interpretarOferta(texto, imagemBase64 = null) {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY não configurada.');

  const systemPrompt = `Você é um assistente especialista em ofertas de passagens aéreas com milhas/pontos para o mercado brasileiro.

Sua tarefa é interpretar uma oferta de passagem recebida e formatar no padrão do Clube do Viajante para WhatsApp.

O formato de saída deve ser EXATAMENTE este (responda apenas o JSON, sem markdown):
{
  "valido": true,
  "origem": "GRU",
  "destino": "MIA",
  "companhia": "LATAM",
  "programa": "LATAM Pass",
  "milhas": "25.000",
  "cabine": "Econômica",
  "trecho": "ida",
  "validade": "até 30/06",
  "taxas": "R$ 350",
  "mensagem": "✈️ *GRU → MIA* — LATAM\n\n💺 Econômica | Ida\n🏆 *LATAM Pass* — 25.000 milhas\n💰 Taxas: R$ 350\n\n📅 Válido até 30/06\n\n🔗 Resgate pelo app ou site da LATAM"
}

Se o conteúdo NÃO for uma oferta de passagem com milhas/pontos, retorne:
{ "valido": false }

Regras para a mensagem formatada:
- Use emojis relevantes
- Negrite informações importantes com *asteriscos*
- Seja direto e objetivo
- Se não souber algum campo, omita-o
- A mensagem deve estar em português brasileiro`;

  const content = [];

  if (imagemBase64) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: imagemBase64 }
    });
  }

  content.push({
    type: 'text',
    text: texto || 'Interprete a imagem acima como uma oferta de passagem aérea.'
  });

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content }],
    }),
  });

  const data = await response.json();
  const raw  = data.content?.[0]?.text || '{}';

  try {
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch {
    return { valido: false };
  }
}

// ── LISTENER DE MENSAGENS ─────────────────────────────────────────────────────
async function processarMensagem(msg) {
  try {
    const jid     = msg.key.remoteJid;
    const fromMe  = msg.key.fromMe;

    // Só monitora grupos configurados, ignora mensagens próprias
    if (fromMe) return;
    if (!GRUPOS_MONITORADOS.includes(jid)) return;

    const m       = msg.message;
    const tipo    = Object.keys(m || {})[0];
    let texto     = '';
    let imagemB64 = null;

    if (tipo === 'conversation') {
      texto = m.conversation;
    } else if (tipo === 'extendedTextMessage') {
      texto = m.extendedTextMessage.text;
    } else if (tipo === 'imageMessage') {
      texto = m.imageMessage.caption || '';
      try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
        imagemB64 = buffer.toString('base64');
      } catch (e) {
        console.error('Erro ao baixar imagem:', e.message);
      }
    } else {
      // Tipo não suportado (sticker, audio, etc.)
      return;
    }

    if (!texto && !imagemB64) return;

    console.log(`📨 Mensagem capturada do grupo ${jid} — interpretando...`);

    const resultado = await interpretarOferta(texto, imagemB64);

    if (!resultado.valido) {
      console.log('⏭️  Não é uma oferta de passagem, ignorando.');
      return;
    }

    const oferta = {
      id:               gerarId(),
      timestamp:        new Date().toISOString(),
      grupoOrigem:      jid,
      tipoConteudo:     imagemB64 ? 'imagem' : 'texto',
      conteudoOriginal: texto,
      imagemBase64:     imagemB64,
      mensagemFormatada: resultado.mensagem,
      dadosExtraidos:   resultado,
      status:           'pendente',
    };

    filaPendentes.unshift(oferta);
    console.log(`✅ Oferta #${oferta.id} adicionada ao painel de revisão.`);

    // Limita fila a 50 itens
    if (filaPendentes.length > 50) filaPendentes.splice(50);

  } catch (err) {
    console.error('Erro ao processar mensagem:', err.message);
  }
}

// ── WHATSAPP ──────────────────────────────────────────────────────────────────
async function conectar() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSAO_DIR);
  const { version }          = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: true,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrAtual = await QRCode.toDataURL(qr);
      console.log('📱 QR Code gerado — acesse /qr no navegador para escanear.');
    }

    if (connection === 'open') {
      conectado = true;
      qrAtual   = null;
      console.log('✅ WhatsApp conectado!');
      console.log(`👁️  Monitorando ${GRUPOS_MONITORADOS.length} grupo(s).`);
    }

    if (connection === 'close') {
      conectado = false;
      const codigo     = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const reconectar = codigo !== DisconnectReason.loggedOut;
      console.log(`⚠️  Conexão encerrada (código ${codigo}). Reconectar: ${reconectar}`);
      if (reconectar) setTimeout(conectar, 5000);
      else { console.log('🔴 Sessão expirada. Acesse /qr para reconectar.'); qrAtual = null; }
    }
  });

  // Escuta mensagens
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) await processarMensagem(msg);
  });
}

// ── CSS DO PAINEL ─────────────────────────────────────────────────────────────
const PAINEL_CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, sans-serif; background: #0d0d0d; color: #f0f0f0; min-height: 100vh; }
  header { background: #111; border-bottom: 1px solid #222; padding: 16px 24px; display: flex; align-items: center; justify-content: space-between; }
  header h1 { font-size: 18px; color: #ffa500; }
  header .nav a { color: #aaa; text-decoration: none; margin-left: 16px; font-size: 14px; }
  header .nav a:hover { color: #ffa500; }
  .container { max-width: 900px; margin: 0 auto; padding: 24px 16px; }
  .badge { background: #ffa500; color: #000; font-size: 11px; font-weight: 700; padding: 2px 7px; border-radius: 10px; margin-left: 6px; }
  .empty { text-align: center; color: #555; padding: 60px 0; font-size: 15px; }
  .card { background: #161616; border: 1px solid #222; border-radius: 12px; margin-bottom: 16px; overflow: hidden; }
  .card-header { padding: 12px 16px; background: #1a1a1a; border-bottom: 1px solid #222; display: flex; align-items: center; gap: 10px; font-size: 13px; color: #aaa; }
  .card-header .id { color: #ffa500; font-weight: 700; }
  .card-header .tipo { background: #252525; padding: 2px 8px; border-radius: 6px; font-size: 11px; }
  .card-body { display: grid; grid-template-columns: 1fr 1fr; gap: 0; }
  .col { padding: 16px; }
  .col + .col { border-left: 1px solid #222; }
  .col-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: #555; margin-bottom: 10px; }
  .original { font-size: 13px; color: #aaa; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
  .original img { max-width: 100%; border-radius: 8px; margin-top: 8px; }
  .formatada { font-size: 13px; color: #f0f0f0; line-height: 1.6; white-space: pre-wrap; word-break: break-word; background: #0d0d0d; padding: 12px; border-radius: 8px; }
  .card-footer { padding: 12px 16px; border-top: 1px solid #222; display: flex; gap: 10px; align-items: center; }
  .btn { padding: 8px 20px; border-radius: 8px; border: none; font-size: 13px; font-weight: 600; cursor: pointer; transition: opacity .15s; }
  .btn:hover { opacity: .8; }
  .btn-aprovar { background: #22c55e; color: #000; }
  .btn-rejeitar { background: #ef4444; color: #fff; }
  .btn-editar { background: #3b82f6; color: #fff; }
  .status-aprovado { color: #22c55e; font-size: 13px; font-weight: 600; }
  .status-rejeitado { color: #ef4444; font-size: 13px; font-weight: 600; }
  .edit-area { width: 100%; background: #0d0d0d; color: #f0f0f0; border: 1px solid #333; border-radius: 8px; padding: 10px; font-size: 13px; font-family: inherit; line-height: 1.6; resize: vertical; min-height: 120px; }
  @media(max-width:600px){ .card-body { grid-template-columns: 1fr; } .col+.col { border-left: none; border-top: 1px solid #222; } }
`;

// ── ROTAS ─────────────────────────────────────────────────────────────────────

// Página inicial
app.get('/', (req, res) => {
  const pendentes = filaPendentes.filter(o => o.status === 'pendente').length;
  const status    = conectado ? '🟢 Conectado' : qrAtual ? '🟡 Aguardando QR' : '🔴 Desconectado';
  res.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>CDV Server</title>
  <style>body{font-family:sans-serif;background:#0d0d0d;color:#f0f0f0;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;gap:20px;margin:0}
  h1{color:#ffa500}.status{font-size:1.3rem}a{color:#ffa500;text-decoration:none;border:1px solid #ffa500;padding:10px 24px;border-radius:8px;margin:4px}a:hover{background:#ffa500;color:#000}.links{display:flex;flex-wrap:wrap;justify-content:center;gap:8px}</style></head>
  <body><h1>🤖 CDV Baileys Server</h1><p class="status">${status}</p>
  <div class="links">
    ${!conectado ? '<a href="/qr">📷 Escanear QR</a>' : ''}
    <a href="/painel">📋 Painel de Revisão${pendentes > 0 ? ` (${pendentes})` : ''}</a>
    <a href="/status">📊 Status JSON</a>
    <a href="/grupos">👥 Listar Grupos</a>
  </div></body></html>`);
});

// QR Code
app.get('/qr', (req, res) => {
  if (conectado) return res.send(`<html><body style="background:#0d0d0d;color:#ffa500;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column"><h2>✅ Já conectado!</h2><a href="/" style="color:#ffa500;margin-top:16px">← Voltar</a></body></html>`);
  if (!qrAtual)  return res.send(`<html><head><meta http-equiv="refresh" content="3"></head><body style="background:#0d0d0d;color:#f0f0f0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column"><h2>⏳ Gerando QR...</h2><p>Atualizando em 3s...</p></body></html>`);
  res.send(`<html><head><title>QR</title><meta http-equiv="refresh" content="30"><style>body{background:#0d0d0d;color:#f0f0f0;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;gap:16px;margin:0}h2{color:#ffa500}img{border:4px solid #ffa500;border-radius:12px;width:260px;height:260px}p{color:#aaa;font-size:.9rem}</style></head>
  <body><h2>📱 Escanear QR Code</h2><img src="${qrAtual}" alt="QR"/><p>WhatsApp → Dispositivos conectados → Conectar dispositivo</p><p>Atualiza a cada 30s</p></body></html>`);
});

// Status JSON
app.get('/status', (req, res) => {
  res.json({
    conectado,
    qrDisponivel: !!qrAtual,
    grupos: Object.keys(GRUPOS),
    gruposMonitorados: GRUPOS_MONITORADOS,
    filaPendentes: filaPendentes.filter(o => o.status === 'pendente').length,
    filaTotal: filaPendentes.length,
  });
});

// ── PAINEL DE REVISÃO ─────────────────────────────────────────────────────────
app.get('/painel', (req, res) => {
  const pendentes  = filaPendentes.filter(o => o.status === 'pendente');
  const processados = filaPendentes.filter(o => o.status !== 'pendente');

  const renderCard = (o) => {
    const data = new Date(o.timestamp).toLocaleString('pt-BR');
    const imgTag = o.imagemBase64
      ? `<img src="data:image/jpeg;base64,${o.imagemBase64}" alt="imagem"/>`
      : '';
    const originalHtml = o.tipoConteudo === 'imagem'
      ? `${imgTag}${o.conteudoOriginal ? `<div style="margin-top:8px">${o.conteudoOriginal}</div>` : ''}`
      : (o.conteudoOriginal || '<em style="color:#555">sem texto</em>');

    if (o.status === 'aprovado') {
      return `<div class="card"><div class="card-header"><span class="id">#${o.id}</span><span class="tipo">${o.tipoConteudo}</span><span style="margin-left:auto">${data}</span></div>
        <div style="padding:12px 16px"><span class="status-aprovado">✅ Aprovado e enviado</span></div></div>`;
    }
    if (o.status === 'rejeitado') {
      return `<div class="card"><div class="card-header"><span class="id">#${o.id}</span><span class="tipo">${o.tipoConteudo}</span><span style="margin-left:auto">${data}</span></div>
        <div style="padding:12px 16px"><span class="status-rejeitado">❌ Rejeitado</span></div></div>`;
    }

    return `
    <div class="card" id="card-${o.id}">
      <div class="card-header">
        <span class="id">#${o.id}</span>
        <span class="tipo">${o.tipoConteudo}</span>
        <span style="margin-left:auto;font-size:12px">${data}</span>
      </div>
      <div class="card-body">
        <div class="col">
          <div class="col-title">Original</div>
          <div class="original">${originalHtml}</div>
        </div>
        <div class="col">
          <div class="col-title">Mensagem formatada</div>
          <textarea class="edit-area" id="msg-${o.id}">${o.mensagemFormatada}</textarea>
        </div>
      </div>
      <div class="card-footer">
        <button class="btn btn-aprovar" onclick="aprovar(${o.id})">✅ Aprovar e enviar</button>
        <button class="btn btn-rejeitar" onclick="rejeitar(${o.id})">❌ Rejeitar</button>
        <span id="feedback-${o.id}" style="font-size:13px;color:#aaa;margin-left:auto"></span>
      </div>
    </div>`;
  };

  res.send(`<!DOCTYPE html><html lang="pt-BR"><head>
    <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Painel de Revisão — CDV</title>
    <style>${PAINEL_CSS}</style>
  </head><body>
    <header>
      <h1>📋 Painel de Revisão <span class="badge">${pendentes.length}</span></h1>
      <nav class="nav"><a href="/">← Início</a><a href="/painel" onclick="location.reload()">↻ Atualizar</a></nav>
    </header>
    <div class="container">
      ${pendentes.length === 0
        ? '<div class="empty">Nenhuma oferta pendente.<br>As ofertas capturadas dos grupos monitorados aparecerão aqui.</div>'
        : pendentes.map(renderCard).join('')}
      ${processados.length > 0 ? `
        <h3 style="color:#444;font-size:13px;margin:32px 0 12px;text-transform:uppercase;letter-spacing:1px">Processados recentemente</h3>
        ${processados.slice(0, 10).map(renderCard).join('')}
      ` : ''}
    </div>
    <script>
      async function aprovar(id) {
        const msg = document.getElementById('msg-' + id).value;
        const fb  = document.getElementById('feedback-' + id);
        fb.textContent = 'Enviando...';
        const r = await fetch('/painel/aprovar/' + id, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mensagem: msg })
        });
        const d = await r.json();
        if (d.ok) {
          fb.style.color = '#22c55e';
          fb.textContent = '✅ Enviado!';
          setTimeout(() => { const c = document.getElementById('card-' + id); if (c) c.style.opacity = '.4'; }, 1000);
        } else {
          fb.style.color = '#ef4444';
          fb.textContent = '❌ Erro: ' + d.erro;
        }
      }
      async function rejeitar(id) {
        const fb = document.getElementById('feedback-' + id);
        fb.textContent = 'Rejeitando...';
        const r = await fetch('/painel/rejeitar/' + id, { method: 'POST' });
        const d = await r.json();
        if (d.ok) {
          fb.style.color = '#ef4444';
          fb.textContent = '❌ Rejeitado';
          setTimeout(() => { const c = document.getElementById('card-' + id); if (c) c.style.opacity = '.4'; }, 500);
        }
      }
      // Auto-refresh a cada 30s se houver pendentes
      ${pendentes.length > 0 ? '' : 'setTimeout(() => location.reload(), 30000);'}
    </script>
  </body></html>`);
});

// Aprovar oferta
app.post('/painel/aprovar/:id', async (req, res) => {
  const id     = parseInt(req.params.id);
  const oferta = filaPendentes.find(o => o.id === id);

  if (!oferta) return res.status(404).json({ ok: false, erro: 'Oferta não encontrada.' });
  if (!conectado || !sock) return res.status(503).json({ ok: false, erro: 'WhatsApp não conectado.' });

  const mensagem  = req.body.mensagem || oferta.mensagemFormatada;
  const grupoId   = GRUPOS[GRUPO_DESTINO_PASSAGENS];

  try {
    await sock.sendMessage(grupoId, { text: mensagem });
    oferta.status = 'aprovado';
    oferta.mensagemEnviada = mensagem;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Rejeitar oferta
app.post('/painel/rejeitar/:id', (req, res) => {
  const id     = parseInt(req.params.id);
  const oferta = filaPendentes.find(o => o.id === id);
  if (!oferta) return res.status(404).json({ ok: false, erro: 'Oferta não encontrada.' });
  oferta.status = 'rejeitado';
  res.json({ ok: true });
});

// Enviar mensagem de texto
app.post('/enviar', async (req, res) => {
  const { grupo, mensagem } = req.body;
  if (!conectado || !sock) return res.status(503).json({ ok: false, erro: 'WhatsApp não conectado.' });
  const grupoId = resolverGrupo(grupo);
  if (!grupoId)  return res.status(400).json({ ok: false, erro: `Grupo inválido: "${grupo}"` });
  if (!mensagem?.trim()) return res.status(400).json({ ok: false, erro: 'Mensagem vazia.' });
  try {
    await sock.sendMessage(grupoId, { text: mensagem });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Enviar imagem com legenda
app.post('/enviar-imagem', upload.single('imagem'), async (req, res) => {
  const { grupo, legenda } = req.body;
  const file = req.file;
  if (!conectado || !sock) { if (file) unlinkSync(file.path); return res.status(503).json({ ok: false, erro: 'WhatsApp não conectado.' }); }
  const grupoId = resolverGrupo(grupo);
  if (!grupoId)  { if (file) unlinkSync(file.path); return res.status(400).json({ ok: false, erro: `Grupo inválido: "${grupo}"` }); }
  if (!file) return res.status(400).json({ ok: false, erro: 'Imagem obrigatória.' });
  try {
    const buffer = readFileSync(file.path);
    await sock.sendMessage(grupoId, { image: buffer, caption: legenda || '' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  } finally {
    if (existsSync(file.path)) unlinkSync(file.path);
  }
});

// Listar grupos
app.get('/grupos', async (req, res) => {
  if (!conectado || !sock) return res.status(503).json({ ok: false, erro: 'WhatsApp não conectado.' });
  try {
    const chats  = await sock.groupFetchAllParticipating();
    const grupos = Object.values(chats)
      .map(g => ({ id: g.id, nome: g.subject || '(sem nome)' }))
      .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
    res.json({ ok: true, total: grupos.length, grupos });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`👁️  Grupos monitorados: ${GRUPOS_MONITORADOS.join(', ')}`);
});

conectar();
