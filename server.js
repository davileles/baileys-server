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

const GRUPOS_MONITORADOS        = [
  '120363427512561555@g.us',
  '120363409136599326@g.us',
];
const GRUPO_DESTINO_PASSAGENS   = 'cdv_emissao';
const JANELA_AGRUPAMENTO_MS     = 3 * 60 * 1000; // 3 minutos

const PORT          = process.env.PORT || 3001;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const SESSAO_DIR    = './sessao';
const UPLOAD_DIR    = './tmp-uploads';

[SESSAO_DIR, UPLOAD_DIR].forEach(d => { if (!existsSync(d)) mkdirSync(d, { recursive: true }); });

const app    = express();
const upload = multer({ dest: UPLOAD_DIR });
app.use(cors());
app.use(express.json({ limit: '50mb' }));

let sock      = null;
let conectado = false;
let qrAtual   = null;

const filaPendentes     = [];
let contadorId          = 1;
const bufferAgrupamento = new Map();

function resolverGrupo(chave) {
  return GRUPOS[chave] ?? (chave?.includes('@g.us') ? chave : null);
}
function gerarId() { return contadorId++; }

// ── CHAMADA À API ANTHROPIC ───────────────────────────────────────────────────
async function chamarClaude(system, userContent, maxTokens = 2048) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: userContent }],
    }),
  });
  const data = await response.json();
  console.log(`🤖 API response status: ${response.status} | content blocks: ${data.content?.length}`);
  if (data.error) console.log(`❌ API erro: ${JSON.stringify(data.error)}`);
  const raw  = data.content?.[0]?.text || '{}';
  console.log(`📝 Raw resposta IA: ${raw.slice(0, 300)}`);
  try {
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch {
    console.log(`❌ JSON parse falhou para: ${raw.slice(0, 100)}`);
    return null;
  }
}

// ── CONSTANTES CDV ───────────────────────────────────────────────────────────
const PROGRAMAS_CPM = {
  'Smiles': 18, 'Azul Fidelidade': 15, 'Azul pelo Mundo': 15,
  'LATAM Pass': 26, 'Iberia Plus': 58, 'Privilege Club': 58,
  'Executive Club': 58, 'TAP': 43, 'AAdvantage': 100, 'SUMA': 80,
  'Flying Club': 50, 'Finnair Plus': 58, 'Aeroplan': 50
};
const PROGRAMAS_LINK = {
  'Smiles': 'https://www.smiles.com.br/home',
  'Azul Fidelidade': 'https://www.voeazul.com.br/br/pt/home',
  'Azul pelo Mundo': 'https://azulpelomundo.voeazul.com.br',
  'LATAM Pass': 'https://www.latamairlines.com/br/pt',
  'Iberia Plus': 'https://www.iberia.com/',
  'Privilege Club': 'https://www.qatarairways.com/',
  'Executive Club': 'https://www.britishairways.com/',
  'TAP': 'https://www.flytap.com/',
  'AAdvantage': 'https://www.aa.com.br/',
  'SUMA': 'https://www.aireuropa.com/en/flights/home',
  'Flying Club': 'https://www.virginatlantic.com/',
  'Finnair Plus': 'https://www.finnair.com/br/gb/finnair-plus',
  'Aeroplan': 'https://www.aircanada.com/home/ca/en/aco/flights'
};
const RODAPE_MILHAS = '`Dica de emissão encontrada por @davileles - Clube do Viajante`';
const BALCAO_LINK   = '`Faça parte do Balcão clicando aqui: https://pay.hub.la/TkIbYhix67evTSu1be7c`';

function formatarMensagemCDV(dados) {
  const { origem, destino, pontos, programa, cia, cabine, tipoVoo, datasIda, datasVolta } = dados;
  const cpm        = PROGRAMAS_CPM[programa] || 0;
  const milhasNum  = parseInt(String(pontos || '0').replace(/\D/g, '')) || 0;
  const valorReais = cpm > 0 ? Math.round((milhasNum / 1000) * cpm) : 0;
  const valorStr   = valorReais > 0 ? 'R$ ' + valorReais.toLocaleString('pt-BR') : '—';
  const linkProg   = PROGRAMAS_LINK[programa] || '';
  const trechoInfo = tipoVoo === 'internacional' ? ` o trecho em ${cabine || 'Econômica'}` : '';
  const pontosFormatado = milhasNum > 0 ? milhasNum.toLocaleString('pt-BR') : (pontos || '—');

  let msg = '';
  msg += `*${origem} - ${destino} por ${pontosFormatado} pontos OU ${valorStr}${trechoInfo}*

`;
  msg += RODAPE_MILHAS + '

';
  msg += `Você pode comprar essa passagem no Balcão de Milhas CDV por aproximadamente ${valorStr} o trecho + taxa de embarque.

`;
  msg += BALCAO_LINK + '

';
  msg += `🛫 *DATAS DE IDA*
${datasIda || '—'}

`;
  msg += `🛬 *DATAS DE VOLTA*
${datasVolta || '—'}

`;
  msg += `🎟️ *PROGRAMA* ${programa}

`;
  msg += `✈️ *CIA AÉREA* ${cia}

`;
  msg += `🔗 *LINK* ${linkProg}

`;
  msg += RODAPE_MILHAS;
  return msg;
}

// ── PASSO 1: CLASSIFICAR CADA ITEM INDIVIDUALMENTE ───────────────────────────
async function classificarItens(itens) {
  const system = `Você é um especialista em passagens aéreas com milhas/pontos para o mercado brasileiro.
Seja GENEROSO na classificação — qualquer menção a rota aérea, milhas/pontos, programa de fidelidade ou companhia aérea deve ser classificada como válida.
Responda APENAS com JSON válido, sem markdown.`;

  const resultados = [];
  for (let i = 0; i < itens.length; i++) {
    const item = itens[i];
    const content = [];
    if (item.imagemBase64) {
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: item.imagemBase64 } });
    }
    content.push({
      type: 'text',
      text: `Analise este item e extraia informações de passagem aérea.
${item.texto ? `Texto: ${item.texto}` : ''}

Responda com este JSON:
{
  "valido": true,
  "indice": ${i},
  "origem": "Rio de Janeiro",
  "destino": "Buenos Aires",
  "origemCodigo": "GIG",
  "destinoCodigo": "AEP",
  "cia": "GOL",
  "programa": "Smiles",
  "pontos": "21000",
  "cabine": "Econômica",
  "tipoVoo": "internacional",
  "direcao": "ida_volta",
  "datasIda": "Jul/26: 01, 28\nAgo/26: 06, 07",
  "datasVolta": "Jun/26: 09, 10, 15\nJul/26: 01, 03"
}

O campo "programa" deve ser um destes: Smiles, Azul Fidelidade, Azul pelo Mundo, LATAM Pass, Iberia Plus, Privilege Club, Executive Club, TAP, AAdvantage, SUMA, Flying Club, Finnair Plus, Aeroplan.
O campo "direcao" pode ser: "ida", "volta" ou "ida_volta".
Se NÃO houver NENHUMA informação de passagem aérea, retorne: { "valido": false, "indice": ${i} }`
    });
    const resultado = await chamarClaude(system, content, 768);
    resultados.push(resultado || { valido: false, indice: i });
    console.log(`   Item ${i}: ${resultado?.valido ? 'válido — ' + resultado?.origemCodigo + '→' + resultado?.destinoCodigo : 'inválido'}`);
  }
  return resultados;
}

// ── PASSO 2: AGRUPAR E FORMATAR ───────────────────────────────────────────────
async function agruparEFormatar(classificacoes) {
  const validas = classificacoes.filter(c => c?.valido);
  if (validas.length === 0) return [];

  // Se só 1 item, formata direto sem chamar IA
  if (validas.length === 1) {
    const v = validas[0];
    const dados = {
      origem: v.origem || v.origemCodigo,
      destino: v.destino || v.destinoCodigo,
      pontos: v.pontos,
      programa: v.programa,
      cia: v.cia,
      cabine: v.cabine || 'Econômica',
      tipoVoo: v.tipoVoo || 'internacional',
      datasIda: v.datasIda || '',
      datasVolta: v.datasVolta || '',
    };
    return [{ indices: [v.indice], tipo: v.direcao || 'ida', ...dados, mensagem: formatarMensagemCDV(dados) }];
  }

  // Múltiplos itens: IA decide agrupamento
  const system = `Você é um especialista em passagens aéreas com milhas para o mercado brasileiro.
Agrupe trechos que compõem a mesma emissão. Responda APENAS com JSON válido, sem markdown.`;

  const prompt = `Agrupe estas ${validas.length} ofertas que pertencem à mesma emissão.

Critérios para agrupar:
- Mesmo programa de fidelidade
- Mesma quantidade de milhas (ou muito próxima)
- Mesma companhia aérea
- Rotas complementares (ex: GIG→AEP é ida, AEP→GIG é volta)

Ofertas:
${JSON.stringify(validas, null, 2)}

Responda com este JSON:
{
  "emissoes": [
    {
      "indices": [0, 1],
      "tipo": "ida_volta",
      "origem": "Rio de Janeiro",
      "destino": "Buenos Aires",
      "origemCodigo": "GIG",
      "destinoCodigo": "AEP",
      "cia": "GOL",
      "programa": "Smiles",
      "pontos": "21000",
      "cabine": "Econômica",
      "tipoVoo": "internacional",
      "datasIda": "Jul/26: 01, 28",
      "datasVolta": "Jun/26: 09, 10"
    }
  ]
}`;

  const resultado = await chamarClaude(system, [{ type: 'text', text: prompt }], 2048);
  const emissoes  = resultado?.emissoes || [];

  // Formata cada emissão no padrão CDV
  return emissoes.map(e => ({
    ...e,
    mensagem: formatarMensagemCDV({
      origem:     e.origem || e.origemCodigo,
      destino:    e.destino || e.destinoCodigo,
      pontos:     e.pontos,
      programa:   e.programa,
      cia:        e.cia,
      cabine:     e.cabine || 'Econômica',
      tipoVoo:    e.tipoVoo || 'internacional',
      datasIda:   e.datasIda || '',
      datasVolta: e.datasVolta || '',
    })
  }));
}

// ── PROCESSAR BUFFER APÓS JANELA ──────────────────────────────────────────────
async function processarBuffer(grupoId) {
  const entrada = bufferAgrupamento.get(grupoId);
  if (!entrada) return;
  bufferAgrupamento.delete(grupoId);

  const { itens } = entrada;
  console.log(`⏱️  Janela encerrada — ${itens.length} item(ns) para processar`);

  try {
    // Passo 1: classificar individualmente
    console.log('🔍 Passo 1: classificando itens...');
    const classificacoes = await classificarItens(itens);
    const validas = classificacoes.filter(c => c?.valido);
    console.log(`   ${validas.length}/${itens.length} itens válidos`);

    if (validas.length === 0) {
      console.log('⏭️  Nenhuma oferta de passagem encontrada.');
      return;
    }

    // Passo 2: agrupar e formatar
    console.log('🔗 Passo 2: agrupando e formatando...');
    const emissoes = await agruparEFormatar(classificacoes);
    console.log(`   ${emissoes.length} emissão(ões) identificada(s)`);

    // Criar uma oferta no painel para cada emissão
    for (const emissao of emissoes) {
      const indices  = emissao.indices || [];
      const imagens  = indices
        .map(i => itens[i]?.imagemBase64)
        .filter(Boolean);
      const textos   = indices
        .map(i => itens[i]?.texto)
        .filter(Boolean)
        .join('\n');

      const oferta = {
        id:               gerarId(),
        timestamp:        new Date().toISOString(),
        grupoOrigem:      grupoId,
        tipoConteudo:     imagens.length > 1 ? `${imagens.length} imagens` : imagens.length === 1 ? 'imagem' : 'texto',
        conteudoOriginal: textos,
        imagens,
        mensagemFormatada: emissao.mensagem,
        dadosExtraidos:   emissao,
        status:           'pendente',
      };

      filaPendentes.unshift(oferta);
      if (filaPendentes.length > 100) filaPendentes.splice(100);
      console.log(`✅ Oferta #${oferta.id} — ${emissao.tipo} ${emissao.origem}→${emissao.destino} (${emissao.programa})`);
    }

  } catch (err) {
    console.error('Erro ao processar buffer:', err.message);
  }
}

// ── LISTENER DE MENSAGENS ─────────────────────────────────────────────────────
async function processarMensagem(msg) {
  try {
    const jid    = msg.key.remoteJid;
    const fromMe = msg.key.fromMe;
    console.log(`🔍 JID recebido: ${jid} | fromMe: ${fromMe} | monitorado: ${GRUPOS_MONITORADOS.includes(jid)}`);
    if (fromMe) return;
    if (!GRUPOS_MONITORADOS.includes(jid)) return;

    const m    = msg.message;
    const tipo = Object.keys(m || {})[0];
    console.log(`🧩 Tipo de mensagem: ${tipo} | keys: ${JSON.stringify(Object.keys(m || {}))}`);
    let texto     = '';
    let imagemB64 = null;

    if (tipo === 'conversation') {
      texto = m.conversation;
    } else if (tipo === 'extendedTextMessage') {
      texto = m.extendedTextMessage.text;
    } else if (tipo === 'imageMessage') {
      texto = m.imageMessage.caption || '';
      try {
        const buffer = await downloadMediaMessage(
          msg, 'buffer', {},
          { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
        );
        imagemB64 = buffer.toString('base64');
      } catch (e) {
        console.error('Erro ao baixar imagem:', e.message);
      }
    } else {
      return;
    }

    if (!texto && !imagemB64) return;

    // Adiciona ao buffer
    if (!bufferAgrupamento.has(jid)) {
      const timer = setTimeout(() => processarBuffer(jid), JANELA_AGRUPAMENTO_MS);
      bufferAgrupamento.set(jid, { itens: [], timer });
      console.log(`⏳ Janela de ${JANELA_AGRUPAMENTO_MS / 60000} min iniciada`);
    }

    const entrada = bufferAgrupamento.get(jid);
    entrada.itens.push({ texto, imagemBase64: imagemB64, timestamp: Date.now() });
    console.log(`📦 Buffer: ${entrada.itens.length} item(ns)`);

  } catch (err) {
    console.error('Erro ao processar mensagem:', err.message);
  }
}

// ── WHATSAPP ──────────────────────────────────────────────────────────────────
async function conectar() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSAO_DIR);
  const { version }          = await fetchLatestBaileysVersion();

  sock = makeWASocket({ version, auth: state, logger: pino({ level: 'silent' }), printQRInTerminal: true });
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) { qrAtual = await QRCode.toDataURL(qr); console.log('📱 QR gerado — acesse /qr'); }
    if (connection === 'open') {
      conectado = true; qrAtual = null;
      console.log('✅ WhatsApp conectado!');
      console.log(`👁️  Monitorando: ${GRUPOS_MONITORADOS.join(', ')}`);
    }
    if (connection === 'close') {
      conectado = false;
      const codigo = new Boom(lastDisconnect?.error)?.output?.statusCode;
      if (codigo !== DisconnectReason.loggedOut) setTimeout(conectar, 5000);
      else qrAtual = null;
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    console.log(`📩 messages.upsert disparado — type: ${type}, qtd: ${messages.length}`);
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
  .container { max-width: 960px; margin: 0 auto; padding: 24px 16px; }
  .badge { background: #ffa500; color: #000; font-size: 11px; font-weight: 700; padding: 2px 7px; border-radius: 10px; margin-left: 6px; }
  .empty { text-align: center; color: #555; padding: 60px 0; font-size: 15px; }
  .card { background: #161616; border: 1px solid #222; border-radius: 12px; margin-bottom: 16px; overflow: hidden; }
  .card-header { padding: 12px 16px; background: #1a1a1a; border-bottom: 1px solid #222; display: flex; align-items: center; gap: 8px; font-size: 13px; color: #aaa; flex-wrap: wrap; }
  .card-header .id { color: #ffa500; font-weight: 700; font-size: 14px; }
  .tag { background: #252525; padding: 2px 8px; border-radius: 6px; font-size: 11px; }
  .tag-ida-volta { background: #1a2e1a; color: #22c55e; }
  .tag-ida { background: #1a1f2e; color: #60a5fa; }
  .card-body { display: grid; grid-template-columns: 1fr 1fr; }
  .col { padding: 16px; }
  .col + .col { border-left: 1px solid #222; }
  .col-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: #444; margin-bottom: 10px; }
  .imgs-grid { display: flex; flex-wrap: wrap; gap: 8px; }
  .imgs-grid img { width: calc(50% - 4px); min-width: 120px; border-radius: 8px; object-fit: cover; }
  .imgs-grid img:only-child { width: 100%; }
  .texto-original { font-size: 13px; color: #888; white-space: pre-wrap; word-break: break-word; margin-top: 8px; }
  .edit-area { width: 100%; background: #0d0d0d; color: #f0f0f0; border: 1px solid #2a2a2a; border-radius: 8px; padding: 12px; font-size: 13px; font-family: inherit; line-height: 1.7; resize: vertical; min-height: 160px; }
  .edit-area:focus { outline: none; border-color: #444; }
  .card-footer { padding: 12px 16px; border-top: 1px solid #1a1a1a; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .btn { padding: 8px 20px; border-radius: 8px; border: none; font-size: 13px; font-weight: 600; cursor: pointer; transition: opacity .15s; }
  .btn:hover { opacity: .8; }
  .btn-aprovar { background: #22c55e; color: #000; }
  .btn-rejeitar { background: #333; color: #aaa; }
  .status-aprovado { color: #22c55e; font-size: 13px; font-weight: 600; }
  .status-rejeitado { color: #555; font-size: 13px; }
  .buffer-bar { background: #1a1400; border: 1px solid #3a2e00; border-radius: 8px; padding: 10px 16px; font-size: 13px; color: #ffa500; margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
  .sep { color: #222; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; margin: 28px 0 12px; }
  @media(max-width:600px){
    .card-body { grid-template-columns: 1fr; }
    .col + .col { border-left: none; border-top: 1px solid #1a1a1a; }
    .imgs-grid img { width: 100%; }
  }
`;

// ── ROTAS ─────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const pendentes = filaPendentes.filter(o => o.status === 'pendente').length;
  const emBuffer  = [...bufferAgrupamento.values()].reduce((s, e) => s + e.itens.length, 0);
  const status    = conectado ? '🟢 Conectado' : qrAtual ? '🟡 Aguardando QR' : '🔴 Desconectado';
  res.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>CDV Server</title>
  <style>body{font-family:sans-serif;background:#0d0d0d;color:#f0f0f0;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;gap:16px;margin:0}
  h1{color:#ffa500}p{color:#aaa;font-size:14px}.links{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;margin-top:8px}
  a{color:#ffa500;text-decoration:none;border:1px solid #333;padding:9px 20px;border-radius:8px;font-size:14px}a:hover{border-color:#ffa500}</style></head>
  <body><h1>🤖 CDV Baileys Server</h1><p>${status}</p>
  ${emBuffer > 0 ? `<p>⏳ ${emBuffer} item(ns) na janela de agrupamento</p>` : ''}
  <div class="links">
    ${!conectado ? '<a href="/qr">📷 Escanear QR</a>' : ''}
    <a href="/painel">📋 Painel${pendentes > 0 ? ` (${pendentes})` : ''}</a>
    <a href="/status">📊 Status</a><a href="/grupos">👥 Grupos</a>
  </div></body></html>`);
});

app.get('/qr', (req, res) => {
  if (conectado) return res.send(`<html><body style="background:#0d0d0d;color:#ffa500;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:16px"><h2>✅ Já conectado!</h2><a href="/" style="color:#ffa500">← Voltar</a></body></html>`);
  if (!qrAtual)  return res.send(`<html><head><meta http-equiv="refresh" content="3"></head><body style="background:#0d0d0d;color:#f0f0f0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column"><h2>⏳ Gerando QR...</h2></body></html>`);
  res.send(`<html><head><title>QR</title><meta http-equiv="refresh" content="30"><style>body{background:#0d0d0d;color:#f0f0f0;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;gap:16px;margin:0}h2{color:#ffa500}img{border:4px solid #ffa500;border-radius:12px;width:260px}p{color:#aaa;font-size:.9rem;text-align:center}</style></head>
  <body><h2>📱 Escanear QR Code</h2><img src="${qrAtual}" alt="QR"/><p>WhatsApp → Dispositivos conectados → Conectar dispositivo</p></body></html>`);
});

app.get('/status', (req, res) => {
  const emBuffer = [...bufferAgrupamento.values()].reduce((s, e) => s + e.itens.length, 0);
  res.json({ conectado, qrDisponivel: !!qrAtual, grupos: Object.keys(GRUPOS), gruposMonitorados: GRUPOS_MONITORADOS, janelaMin: JANELA_AGRUPAMENTO_MS / 60000, bufferAtivo: emBuffer, filaPendentes: filaPendentes.filter(o => o.status === 'pendente').length, filaTotal: filaPendentes.length });
});

app.get('/painel', (req, res) => {
  const pendentes   = filaPendentes.filter(o => o.status === 'pendente');
  const processados = filaPendentes.filter(o => o.status !== 'pendente');
  const emBuffer    = [...bufferAgrupamento.values()].reduce((s, e) => s + e.itens.length, 0);

  const renderCard = (o) => {
    const data   = new Date(o.timestamp).toLocaleString('pt-BR');
    const d      = o.dadosExtraidos || {};
    const tipoTag = d.tipo === 'ida_volta'
      ? '<span class="tag tag-ida-volta">⇄ Ida e volta</span>'
      : d.tipo === 'ida' ? '<span class="tag tag-ida">→ Somente ida</span>' : '';
    const rota   = d.origem && d.destino ? `<span style="color:#f0f0f0;font-weight:600">${d.origem} → ${d.destino}</span>` : '';
    const prog   = d.programa ? `<span class="tag">${d.programa}</span>` : '';
    const imgsHtml = (o.imagens || []).length > 0
      ? `<div class="imgs-grid">${o.imagens.map(b => `<img src="data:image/jpeg;base64,${b}" />`).join('')}</div>`
      : '';
    const textoHtml = o.conteudoOriginal
      ? `<div class="texto-original">${o.conteudoOriginal}</div>` : '';

    if (o.status === 'aprovado') return `<div class="card"><div class="card-header"><span class="id">#${o.id}</span>${rota}${tipoTag}<span style="margin-left:auto">${data}</span></div><div style="padding:12px 16px"><span class="status-aprovado">✅ Aprovado e enviado</span></div></div>`;
    if (o.status === 'rejeitado') return `<div class="card"><div class="card-header"><span class="id">#${o.id}</span>${rota}${tipoTag}<span style="margin-left:auto">${data}</span></div><div style="padding:12px 16px"><span class="status-rejeitado">❌ Rejeitado</span></div></div>`;

    return `
    <div class="card" id="card-${o.id}">
      <div class="card-header">
        <span class="id">#${o.id}</span>${rota}${tipoTag}${prog}
        <span style="margin-left:auto;font-size:12px;color:#555">${data}</span>
      </div>
      <div class="card-body">
        <div class="col">
          <div class="col-title">Original (${o.tipoConteudo})</div>
          ${imgsHtml}${textoHtml}
        </div>
        <div class="col">
          <div class="col-title">Mensagem formatada — edite se necessário</div>
          <textarea class="edit-area" id="msg-${o.id}">${o.mensagemFormatada}</textarea>
        </div>
      </div>
      <div class="card-footer">
        <button class="btn btn-aprovar" onclick="aprovar(${o.id})">✅ Aprovar e enviar</button>
        <button class="btn btn-rejeitar" onclick="rejeitar(${o.id})">Rejeitar</button>
        <span id="feedback-${o.id}" style="font-size:13px;margin-left:auto"></span>
      </div>
    </div>`;
  };

  res.send(`<!DOCTYPE html><html lang="pt-BR"><head>
    <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Painel — CDV</title><style>${PAINEL_CSS}</style>
  </head><body>
    <header>
      <h1>📋 Painel${pendentes.length > 0 ? ` <span class="badge">${pendentes.length}</span>` : ''}</h1>
      <nav class="nav"><a href="/">← Início</a><a href="/painel">↻ Atualizar</a></nav>
    </header>
    <div class="container">
      ${emBuffer > 0 ? `<div class="buffer-bar">⏳ <strong>${emBuffer}</strong> item(ns) aguardando janela de ${JANELA_AGRUPAMENTO_MS / 60000} min — a página atualiza automaticamente</div>` : ''}
      ${pendentes.length === 0 && emBuffer === 0
        ? '<div class="empty">Nenhuma oferta pendente.<br><span style="font-size:13px;color:#333;margin-top:8px;display:block">As ofertas dos grupos monitorados aparecerão aqui.</span></div>'
        : pendentes.map(renderCard).join('')}
      ${processados.length > 0 ? `
        <div class="sep">Processados recentemente</div>
        ${processados.slice(0, 10).map(renderCard).join('')}
      ` : ''}
    </div>
    <script>
      async function aprovar(id) {
        const msg = document.getElementById('msg-' + id).value;
        const fb  = document.getElementById('feedback-' + id);
        fb.textContent = 'Enviando...'; fb.style.color = '#aaa';
        const r = await fetch('/painel/aprovar/' + id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mensagem: msg }) });
        const d = await r.json();
        if (d.ok) {
          fb.style.color = '#22c55e'; fb.textContent = '✅ Enviado!';
          setTimeout(() => { const c = document.getElementById('card-' + id); if (c) c.style.opacity = '.35'; }, 800);
        } else { fb.style.color = '#ef4444'; fb.textContent = '❌ ' + d.erro; }
      }
      async function rejeitar(id) {
        const fb = document.getElementById('feedback-' + id);
        const r  = await fetch('/painel/rejeitar/' + id, { method: 'POST' });
        const d  = await r.json();
        if (d.ok) {
          fb.style.color = '#555'; fb.textContent = 'Rejeitado';
          setTimeout(() => { const c = document.getElementById('card-' + id); if (c) c.style.opacity = '.35'; }, 400);
        }
      }
      ${emBuffer > 0 ? 'setTimeout(() => location.reload(), 30000);' : ''}
    </script>
  </body></html>`);
});

app.post('/painel/aprovar/:id', async (req, res) => {
  const id     = parseInt(req.params.id);
  const oferta = filaPendentes.find(o => o.id === id);
  if (!oferta)             return res.status(404).json({ ok: false, erro: 'Oferta não encontrada.' });
  if (!conectado || !sock) return res.status(503).json({ ok: false, erro: 'WhatsApp não conectado.' });
  const mensagem = req.body.mensagem || oferta.mensagemFormatada;
  try {
    await sock.sendMessage(GRUPOS[GRUPO_DESTINO_PASSAGENS], { text: mensagem });
    oferta.status = 'aprovado';
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

app.post('/painel/rejeitar/:id', (req, res) => {
  const id     = parseInt(req.params.id);
  const oferta = filaPendentes.find(o => o.id === id);
  if (!oferta) return res.status(404).json({ ok: false, erro: 'Oferta não encontrada.' });
  oferta.status = 'rejeitado';
  res.json({ ok: true });
});

app.post('/enviar', async (req, res) => {
  const { grupo, mensagem } = req.body;
  if (!conectado || !sock) return res.status(503).json({ ok: false, erro: 'WhatsApp não conectado.' });
  const grupoId = resolverGrupo(grupo);
  if (!grupoId) return res.status(400).json({ ok: false, erro: `Grupo inválido: "${grupo}"` });
  if (!mensagem?.trim()) return res.status(400).json({ ok: false, erro: 'Mensagem vazia.' });
  try { await sock.sendMessage(grupoId, { text: mensagem }); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ ok: false, erro: err.message }); }
});

app.post('/enviar-imagem', upload.single('imagem'), async (req, res) => {
  const { grupo, legenda } = req.body;
  const file = req.file;
  if (!conectado || !sock) { if (file) unlinkSync(file.path); return res.status(503).json({ ok: false, erro: 'WhatsApp não conectado.' }); }
  const grupoId = resolverGrupo(grupo);
  if (!grupoId) { if (file) unlinkSync(file.path); return res.status(400).json({ ok: false, erro: `Grupo inválido: "${grupo}"` }); }
  if (!file) return res.status(400).json({ ok: false, erro: 'Imagem obrigatória.' });
  try {
    const buffer = readFileSync(file.path);
    await sock.sendMessage(grupoId, { image: buffer, caption: legenda || '' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, erro: err.message }); }
  finally { if (existsSync(file.path)) unlinkSync(file.path); }
});

app.get('/grupos', async (req, res) => {
  if (!conectado || !sock) return res.status(503).json({ ok: false, erro: 'WhatsApp não conectado.' });
  try {
    const chats  = await sock.groupFetchAllParticipating();
    const grupos = Object.values(chats)
      .map(g => ({ id: g.id, nome: g.subject || '(sem nome)' }))
      .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
    res.json({ ok: true, total: grupos.length, grupos });
  } catch (err) { res.status(500).json({ ok: false, erro: err.message }); }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor na porta ${PORT}`);
  console.log(`👁️  Monitorando: ${GRUPOS_MONITORADOS.join(', ')}`);
  console.log(`⏱️  Janela de agrupamento: ${JANELA_AGRUPAMENTO_MS / 60000} min`);
});

conectar();
