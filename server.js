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
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { readdir, unlink } from 'fs/promises';
import QRCode from 'qrcode';

// ── LOGGER CUSTOMIZADO (suprimir ruído do Baileys) ───────────────────────────
const baileysLogger = pino({ level: 'silent' });

// ── HANDLERS DE ERRO GLOBAIS ──────────────────────────────────────────────────
process.on('uncaughtException',  (err) => console.error('[FATAL] uncaughtException:', err.message, err.stack));
process.on('unhandledRejection', (err) => console.error('[FATAL] unhandledRejection:', err?.message || err));

// ── GRUPOS DE DESTINO ─────────────────────────────────────────────────────────
const GRUPOS = {
  tsp:         '120363424721106736@g.us',
  cdv_ofertas: '120363423014138662@g.us',
  cdv_emissao: '120363172490263905@g.us',
};
const GRUPOS_MONITORADOS      = ['120363427512561555@g.us','120363409136599326@g.us','120363410708080270@g.us'];
const GRUPO_DESTINO_PASSAGENS = 'cdv_emissao';
const JANELA_AGRUPAMENTO_MS   = 3 * 60 * 1000;

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
const FILA_PATH = SESSAO_DIR + '/fila_pendentes.json';

// Carregar fila persistida ao iniciar
function carregarFila() {
  try {
    if (existsSync(FILA_PATH)) {
      const dados = JSON.parse(readFileSync(FILA_PATH, 'utf-8'));
      filaPendentes.push(...dados);
      console.log('[FILA] Carregadas ' + dados.length + ' ofertas do disco.');
    }
  } catch(e) { console.log('[FILA] Erro ao carregar fila:', e.message); }
}

function salvarFila() {
  try {
    writeFileSync(FILA_PATH, JSON.stringify(filaPendentes.slice(0, 100)), 'utf-8');
  } catch(e) { console.log('[FILA] Erro ao salvar fila:', e.message); }
}

const filaPendentes = [];
carregarFila();
let contadorId          = 1;
const bufferAgrupamento = new Map();

function resolverGrupo(chave) {
  return GRUPOS[chave] ?? (chave?.includes('@g.us') ? chave : null);
}
function gerarId() { return contadorId++; }

// ── TABELA IATA → CIDADE ──────────────────────────────────────────────────────
const IATA_CIDADES = {
  'GRU':'São Paulo','CGH':'São Paulo','VCP':'Campinas',
  'GIG':'Rio de Janeiro','SDU':'Rio de Janeiro',
  'BSB':'Brasília','CNF':'Belo Horizonte','SSA':'Salvador',
  'REC':'Recife','FOR':'Fortaleza','MAO':'Manaus','BEL':'Belém',
  'CWB':'Curitiba','POA':'Porto Alegre','FLN':'Florianópolis',
  'NAT':'Natal','MCZ':'Maceió','AJU':'Aracaju','THE':'Teresina',
  'SLZ':'São Luís','JPA':'João Pessoa','PMW':'Palmas',
  'MIA':'Miami','JFK':'Nova York','EWR':'Nova York','LGA':'Nova York',
  'MCO':'Orlando','LAX':'Los Angeles','ORD':'Chicago','ATL':'Atlanta',
  'IAH':'Houston','DFW':'Dallas','SFO':'São Francisco','BOS':'Boston',
  'LIS':'Lisboa','MAD':'Madrid','CDG':'Paris','LHR':'Londres',
  'FCO':'Roma','MXP':'Milão','AMS':'Amsterdã','FRA':'Frankfurt',
  'BCN':'Barcelona','VIE':'Viena','ZRH':'Zurique','MUC':'Munique',
  'CPH':'Copenhague','ARN':'Estocolmo','HEL':'Helsinki','OSL':'Oslo',
  'EZE':'Buenos Aires','AEP':'Buenos Aires','SCL':'Santiago',
  'BOG':'Bogotá','LIM':'Lima','MVD':'Montevidéu','ASU':'Assunção',
  'CUN':'Cancún','MEX':'Cidade do México','PTY':'Cidade do Panamá',
  'MBJ':'Montego Bay','HAV':'Havana','SDQ':'Santo Domingo',
  'DXB':'Dubai','DOH':'Doha','AUH':'Abu Dhabi','RUH':'Riade',
  'NRT':'Tóquio','HND':'Tóquio','ICN':'Seul','PEK':'Pequim',
  'PVG':'Xangai','HKG':'Hong Kong','SIN':'Singapura',
  'BKK':'Bangcoc','KUL':'Kuala Lumpur','CGK':'Jacarta',
  'SYD':'Sydney','MEL':'Melbourne','AKL':'Auckland',
  'JNB':'Joanesburgo','CPT':'Cidade do Cabo','CAI':'Cairo',
  'CMN':'Casablanca','NBO':'Nairóbi',
};

function resolverCidade(codigo, nomeIA) {
  if (codigo && IATA_CIDADES[codigo.toUpperCase()]) return IATA_CIDADES[codigo.toUpperCase()];
  return nomeIA || codigo || '-';
}

// ── CONSTANTES CDV ────────────────────────────────────────────────────────────
const PROGRAMAS_CPM = {
  'Smiles':18,'Azul Fidelidade':15,'Azul pelo Mundo':15,
  'LATAM Pass':26,'Iberia Plus':58,'Privilege Club':58,
  'Executive Club':58,'TAP':43,'AAdvantage':100,'SUMA':80,
  'Flying Club':50,'Finnair Plus':58,'Aeroplan':50
};
const PROGRAMAS_LINK = {
  'Smiles':'https://www.smiles.com.br/home',
  'Azul Fidelidade':'https://www.voeazul.com.br/br/pt/home',
  'Azul pelo Mundo':'https://azulpelomundo.voeazul.com.br',
  'LATAM Pass':'https://www.latamairlines.com/br/pt',
  'Iberia Plus':'https://www.iberia.com/',
  'Privilege Club':'https://www.qatarairways.com/',
  'Executive Club':'https://www.britishairways.com/',
  'TAP':'https://www.flytap.com/',
  'AAdvantage':'https://www.aa.com.br/',
  'SUMA':'https://www.aireuropa.com/en/flights/home',
  'Flying Club':'https://www.virginatlantic.com/',
  'Finnair Plus':'https://www.finnair.com/br/gb/finnair-plus',
  'Aeroplan':'https://www.aircanada.com/home/ca/en/aco/flights'
};

// ── FORMATAR DATAS (quebra de linha por mês) ─────────────────────────────────
function formatarDatas(str) {
  if (!str || str === '-') return '-';
  // Já vem formatado como "Mês/Ano: dias\nMês/Ano: dias" ou tudo numa linha
  // Garante quebra antes de cada entrada de mês (ex: "Jun/26: 1, 2 Jul/26: 3")
  var resultado = str
    .replace(/([A-Za-záàãâéêíóôõúüç]+\/\d{2}:)/g, '\n$1')
    .replace(/^\n/, '')
    .trim();
  return resultado;
}

function formatarMensagemCDV(d) {
  var n = '\n';
  var rodape = '`Dica de emiss\u00e3o encontrada por @davileles - Clube do Viajante`';
  var balcao = '`Fa\u00e7a parte do Balc\u00e3o clicando aqui: https://pay.hub.la/TkIbYhix67evTSu1be7c`';
  var cpm = PROGRAMAS_CPM[d.programa] || 0;
  var num = parseInt(String(d.pontos||'0').replace(/[^0-9]/g,'')) || 0;
  var valR = cpm > 0 ? Math.round((num/1000)*cpm) : 0;
  var valStr = valR > 0 ? 'R$ '+valR.toLocaleString('pt-BR') : '-';
  var link = PROGRAMAS_LINK[d.programa] || '';
  var trecho = d.tipoVoo === 'internacional' ? ' o trecho em '+(d.cabine||'Econ\u00f4mica') : '';
  var pts = num > 0 ? num.toLocaleString('pt-BR') : (d.pontos||'-');
  var msg = '';
  msg += '*'+d.origem+' - '+d.destino+' por '+pts+' pontos OU '+valStr+trecho+'*'+n+n;
  msg += rodape+n+n;
  msg += 'Voc\u00ea pode comprar essa passagem no Balc\u00e3o de Milhas CDV por aproximadamente '+valStr+' o trecho + taxa de embarque.'+n+n;
  msg += balcao+n+n;
  msg += '\uD83D\uDEEB *DATAS DE IDA*'+n+formatarDatas(d.datasIda)+n+n;
  msg += '\uD83D\uDEEC *DATAS DE VOLTA*'+n+formatarDatas(d.datasVolta)+n+n;
  msg += '\uD83C\uDF9F\uFE0F *PROGRAMA* '+d.programa+n+n;
  msg += '\u2708\uFE0F *CIA A\u00c9REA* '+d.cia+n+n;
  msg += '\uD83D\uDD17 *LINK* '+link+n+n;
  msg += rodape;
  return msg;
}

// ── CHAMADA ANTHROPIC ─────────────────────────────────────────────────────────
async function chamarClaude(system, userContent, maxTokens) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: maxTokens || 1024,
      system,
      messages: [{ role: 'user', content: userContent }],
    }),
  });
  const data = await response.json();
  if (data.error) { console.log('API erro:', JSON.stringify(data.error)); return null; }
  const raw = data.content?.[0]?.text || '{}';
  try { return JSON.parse(raw.replace(/```json|```/g,'').trim()); }
  catch(e) {
    console.log('JSON parse falhou ('+e.message+'). Tamanho raw: '+raw.length+' chars. Trecho final: '+raw.slice(-80));
    return null;
  }
}

// ── PASSO 1: CLASSIFICAR ──────────────────────────────────────────────────────
async function classificarItens(itens) {
  const system = 'Voce e especialista em passagens aereas com milhas para o mercado brasileiro. Seja GENEROSO: qualquer mencao a rota aerea, milhas/pontos, programa de fidelidade ou companhia aerea deve ser valido. Responda APENAS JSON sem markdown.';
  const resultados = [];
  for (let i = 0; i < itens.length; i++) {
    const item = itens[i];
    const content = [];
    if (item.imagemBase64) content.push({ type:'image', source:{ type:'base64', media_type:'image/jpeg', data:item.imagemBase64 } });
    content.push({ type:'text', text:
      'Extraia TODAS as ofertas de passagem aerea presentes neste conteudo. Pode haver UMA ou MAIS emissoes separadas - identifique cada uma individualmente.\n'
      +(item.texto ? 'Texto: '+item.texto+'\n' : '')
      +'\nSe houver multiplas emissoes (ex: separadas por "Oportunidade de resgate" ou rotas diferentes), retorne UMA entrada por emissao no array.\n'
      +'\nIMPORTANTE sobre datas: Leia as datas diretamente da IMAGEM se estiverem visíveis nela. Normalize para o formato "Mês/Ano: dias". Ex: "Jun/26: 16, 19, 22". Inclua TODAS as datas listadas, tanto de ida quanto de volta. Nao deixe datasIda ou datasVolta vazios se as datas estiverem visiveis.\n'
      +'\nIMPORTANTE sobre cidades: use o nome completo da cidade, nao o codigo IATA. Ex: GRU/REC = Recife, GRU = São Paulo, GIG = Rio de Janeiro, CUN = Cancún, SCL = Santiago, LIM = Lima, CNF = Belo Horizonte, MAD = Madrid, FOR = Fortaleza, SLZ = São Luís.\n'
      +'\nResponda com este JSON (uma entrada por emissao encontrada):\n'
      +'{"resultados":[{"valido":true,"indice":'+i+',"origem":"São Paulo","destino":"Cancún","origemCodigo":"GRU","destinoCodigo":"CUN","cia":"LATAM","programa":"LATAM Pass","pontos":"31494","cabine":"Economica","tipoVoo":"internacional","direcao":"ida_volta","datasIda":"Jun/26: 16, 19, 22","datasVolta":"Jun/26: 22, 23"}]}\n'
      +'Programa deve ser um destes: Smiles, Azul Fidelidade, Azul pelo Mundo, LATAM Pass, Iberia Plus, Privilege Club, Executive Club, TAP, AAdvantage, SUMA, Flying Club, Finnair Plus, Aeroplan.\n'
      +'Cabine deve ser exatamente "Economica" ou "Executiva".\n'
      +'Se NAO houver nenhuma passagem aerea retorne: {"resultados":[{"valido":false,"indice":'+i+'}]}'
    });
    const resultado = await chamarClaude(system, content, 4096);
    const lista = resultado?.resultados || (resultado?.valido !== undefined ? [resultado] : [{ valido:false, indice:i }]);
    for (const r of lista) {
      if (r?.valido) {
        // resolver cidade via tabela local, sobrepondo o que a IA retornou
        r.origem  = resolverCidade(r.origemCodigo,  r.origem);
        r.destino = resolverCidade(r.destinoCodigo, r.destino);
      }
      resultados.push(r || { valido:false, indice:i });
      console.log('   Item '+i+': '+(r?.valido ? 'valido '+r?.origemCodigo+'->'+r?.destinoCodigo+' ('+r?.cabine+')' : 'invalido'));
    }
  }
  return resultados;
}

// ── PASSO 2: AGRUPAR E FORMATAR ───────────────────────────────────────────────
async function agruparEFormatar(classificacoes) {
  const validas = classificacoes.filter(c => c?.valido);
  if (validas.length === 0) return [];

  if (validas.length === 1) {
    const v = validas[0];
    const dados = { origem:v.origem, destino:v.destino, pontos:v.pontos, programa:v.programa, cia:v.cia, cabine:v.cabine||'Economica', tipoVoo:v.tipoVoo||'internacional', datasIda:v.datasIda||'', datasVolta:v.datasVolta||'' };
    return [{ indices:[v.indice], tipo:v.direcao||'ida', ...dados, mensagem:formatarMensagemCDV(dados) }];
  }

  const system = 'Voce e especialista em passagens aereas. Agrupe trechos da mesma emissao. Responda APENAS JSON sem markdown.';
  const prompt = 'Agrupe estas '+validas.length+' ofertas que pertencem a mesma emissao.\n\n'
    +'Criterios para pertencer ao MESMO grupo: mesmo programa, mesmas milhas, mesma companhia, mesma cabine, rotas complementares (ex: ida e volta da mesma viagem).\n\n'
    +'IMPORTANTE: cabine Economica e cabine Executiva sao emissoes DIFERENTES e devem ser grupos SEPARADOS, mesmo que todos os outros dados sejam iguais.\n\n'
    +'Ofertas:\n'+JSON.stringify(validas,null,2)+'\n\n'
    +'Responda:\n{"emissoes":[{"indices":[0,1],"tipo":"ida_volta","origem":"São Paulo","destino":"Cancún","origemCodigo":"GRU","destinoCodigo":"CUN","cia":"LATAM","programa":"LATAM Pass","pontos":"31494","cabine":"Economica","tipoVoo":"internacional","datasIda":"Jun/26: 16, 19, 22","datasVolta":"Jun/26: 22, 23"}]}';

  const resultado = await chamarClaude(system, [{ type:'text', text:prompt }], 4096);
  const emissoes  = resultado?.emissoes || [];

  // Fallback: se a IA retornou 0 emissoes mas havia itens validos,
  // criar uma emissao individual para cada item (rotas diferentes na mesma janela)
  if (emissoes.length === 0) {
    console.log('   Fallback: criando emissao individual para cada item valido');
    return validas.map(v => {
      const dados = { origem:v.origem, destino:v.destino, pontos:v.pontos, programa:v.programa, cia:v.cia, cabine:v.cabine||'Economica', tipoVoo:v.tipoVoo||'internacional', datasIda:v.datasIda||'', datasVolta:v.datasVolta||'' };
      return { indices:[v.indice], tipo:v.direcao||'ida', ...dados, mensagem:formatarMensagemCDV(dados) };
    });
  }

  return emissoes.map(e => {
    const origem  = resolverCidade(e.origemCodigo,  e.origem);
    const destino = resolverCidade(e.destinoCodigo, e.destino);
    const dados   = { origem, destino, pontos:e.pontos, programa:e.programa, cia:e.cia, cabine:e.cabine||'Economica', tipoVoo:e.tipoVoo||'internacional', datasIda:e.datasIda||'', datasVolta:e.datasVolta||'' };
    return { ...e, ...dados, mensagem:formatarMensagemCDV(dados) };
  });
}

// ── PROCESSAR BUFFER ──────────────────────────────────────────────────────────
async function processarBuffer(grupoId) {
  const entrada = bufferAgrupamento.get(grupoId);
  if (!entrada) return;
  bufferAgrupamento.delete(grupoId);
  const { itens } = entrada;
  console.log('Janela encerrada - '+itens.length+' item(ns)');
  try {
    console.log('Passo 1: classificando...');
    const classificacoes = await classificarItens(itens);
    const validas = classificacoes.filter(c => c?.valido);
    console.log('   '+validas.length+'/'+itens.length+' validos');
    if (validas.length === 0) { console.log('Nenhuma oferta encontrada.'); return; }
    console.log('Passo 2: agrupando...');
    const emissoes = await agruparEFormatar(classificacoes);
    console.log('   '+emissoes.length+' emissao(oes)');
    for (const emissao of emissoes) {
      const indices = emissao.indices || [];
      const imagens = indices.map(i => itens[i]?.imagemBase64).filter(Boolean);
      const textos  = indices.map(i => itens[i]?.texto).filter(Boolean).join('\n');
      const oferta  = { id:gerarId(), timestamp:new Date().toISOString(), grupoOrigem:grupoId, tipoConteudo:imagens.length>1?imagens.length+' imagens':imagens.length===1?'imagem':'texto', conteudoOriginal:textos, imagens, mensagemFormatada:emissao.mensagem, dadosExtraidos:emissao, status:'pendente' };
      filaPendentes.unshift(oferta);
      if (filaPendentes.length > 100) filaPendentes.splice(100);
      salvarFila();
      console.log('Oferta #'+oferta.id+' - '+emissao.tipo+' '+emissao.origem+'->'+emissao.destino+' ('+emissao.cabine+')');
    }
  } catch (err) { console.error('Erro ao processar buffer:', err.message); }
}

// ── LISTENER DE MENSAGENS ─────────────────────────────────────────────────────
async function processarMensagem(msg) {
  try {
    const jid    = msg.key.remoteJid;
    const fromMe = msg.key.fromMe;
    if (fromMe) return;
    if (!GRUPOS_MONITORADOS.includes(jid)) return;
    const m    = msg.message;
    const tipo = Object.keys(m || {})[0];
    let texto = '', imagemB64 = null;
    if (tipo === 'conversation') { texto = m.conversation; }
    else if (tipo === 'extendedTextMessage') { texto = m.extendedTextMessage.text; }
    else if (tipo === 'imageMessage') {
      texto = m.imageMessage.caption || '';
      try {
        const buffer = await downloadMediaMessage(msg,'buffer',{},{ logger:pino({level:'silent'}), reuploadRequest:sock.updateMediaMessage });
        imagemB64 = buffer.toString('base64');
        console.log('[IMG] Baixada: '+(imagemB64.length/1024).toFixed(0)+'KB, caption="'+texto+'"');
      } catch(e) {
        console.error('[IMG] Erro ao baixar imagem:', e.message);
        // Se download falhou mas n\u00e3o h\u00e1 caption, usa placeholder para n\u00e3o descartar
        if (!texto) texto = '[imagem sem legenda]';
      }
    } else { return; }
    // Descarta apenas se n\u00e3o houver nenhum conte\u00fado
    if (!texto && !imagemB64) return;

    // ignorar mensagens que já são alertas CDV formatados
    if (texto && (
      texto.includes('Dica de emissao encontrada por @davileles') ||
      texto.includes('Dica de emissão encontrada por @davileles') ||
      texto.includes('Faca parte do Balcao clicando aqui') ||
      texto.includes('Faça parte do Balcão clicando aqui')
    )) {
      console.log('Mensagem CDV ignorada (ja formatada)');
      return;
    }

    console.log('Mensagem capturada de '+jid+' ('+tipo+')');
    if (!bufferAgrupamento.has(jid)) {
      const timer = setTimeout(() => processarBuffer(jid), JANELA_AGRUPAMENTO_MS);
      bufferAgrupamento.set(jid, { itens:[], timer });
      console.log('Janela de '+JANELA_AGRUPAMENTO_MS/60000+' min iniciada');
    }
    const entrada = bufferAgrupamento.get(jid);
    entrada.itens.push({ texto, imagemBase64:imagemB64, timestamp:Date.now() });
    console.log('Buffer: '+entrada.itens.length+' item(ns)');
  } catch(err) { console.error('Erro ao processar mensagem:', err.message); }
}

// ── WHATSAPP ──────────────────────────────────────────────────────────────────

// Health check: se ficar X minutos sem nenhum evento, força reconexão
var HEALTH_CHECK_MS  = 8 * 60 * 1000; // 8 minutos sem nenhum upsert = suspeito
var ultimoUpsert     = Date.now();
var healthTimer      = null;

function resetarHealthTimer() {
  ultimoUpsert = Date.now();
  if (healthTimer) clearTimeout(healthTimer);
  healthTimer = setTimeout(() => {
    var silencioMin = Math.round((Date.now() - ultimoUpsert) / 60000);
    console.log('[HEALTH] '+silencioMin+' min sem eventos. Forçando reconexão...');
    if (sock) {
      try { sock.end(new Error('health-check-timeout')); } catch(e) {}
      sock = null;
    }
    conectar();
  }, HEALTH_CHECK_MS);
}

// Contador de erros de descriptografia (closed: -1 / bad_mac)
var errosDescripto   = 0;
var ERROS_DESCR_MAX  = 15; // após 15 erros, limpa sessão e reconecta

async function limparSessaoEReconectar() {
  console.log('[HEALTH] Muitos erros de descriptografia. Limpando sessão e reconectando...');
  conectado = false;
  if (sock) { try { sock.end(new Error('bad-session')); } catch(e) {} sock = null; }
  // Remove apenas os arquivos de chave de sessão, mantendo as credenciais
  try {
    const arquivos = await readdir(SESSAO_DIR);
    for (const arq of arquivos) {
      if (arq.startsWith('session-') || arq.includes('pre-key') || arq.includes('sender-key')) {
        await unlink(SESSAO_DIR + '/' + arq).catch(() => {});
      }
    }
    console.log('[HEALTH] Arquivos de sessão limpos.');
  } catch(e) { console.log('[HEALTH] Erro ao limpar sessão:', e.message); }
  errosDescripto = 0;
  setTimeout(conectar, 3000);
}

async function conectar() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSAO_DIR);
  const { version }          = await fetchLatestBaileysVersion();
  sock = makeWASocket({
    version,
    auth: state,
    logger: baileysLogger,
    printQRInTerminal: false,
    syncFullHistory: false,
    markOnlineOnConnect: true,
    getMessage: async () => undefined,
  });
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) { qrAtual = await QRCode.toDataURL(qr); console.log('QR gerado - acesse /qr'); }
    if (connection === 'open') {
      conectado = true;
      qrAtual   = null;
      errosDescripto = 0;
      resetarHealthTimer();
      console.log('WhatsApp conectado!');
      console.log('Monitorando: '+GRUPOS_MONITORADOS.join(', '));
    }
    if (connection === 'close') {
      conectado = false;
      if (healthTimer) { clearTimeout(healthTimer); healthTimer = null; }
      const codigo = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const motivo = lastDisconnect?.error?.message || '';
      console.log('Conexão encerrada, codigo: '+codigo+' ('+motivo+'). Reconectando em 5s...');
      if (codigo !== DisconnectReason.loggedOut) {
        sock = null;
        setTimeout(conectar, 5000);
      } else {
        qrAtual = null;
        console.log('Sessão expirada. Acesse /qr para reconectar.');
      }
    }
  });

  // Captura erros de descriptografia (closed: -1 / bad_mac)
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // Resetar health timer a cada evento recebido
    if (conectado) resetarHealthTimer();

    console.log('upsert: type='+type+' qtd='+messages.length+' jids='+messages.map(m=>m.key.remoteJid).join(','));
    if (type !== 'notify') return;
    for (const msg of messages) {
      // Detectar mensagens que falharam na descriptografia
      if (msg.messageStubType === 2 || (msg.message === null && !msg.key.fromMe)) {
        errosDescripto++;
        console.log('[HEALTH] Erro de descriptografia #'+errosDescripto+'/'+ERROS_DESCR_MAX);
        if (errosDescripto >= ERROS_DESCR_MAX) {
          await limparSessaoEReconectar();
          return;
        }
        continue;
      }
      await processarMensagem(msg);
    }
  });

  // Iniciar health check
  resetarHealthTimer();
}

// ── CSS DO PAINEL ─────────────────────────────────────────────────────────────
const PAINEL_CSS = `*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#0d0d0d;color:#f0f0f0;min-height:100vh}header{background:#111;border-bottom:1px solid #222;padding:16px 24px;display:flex;align-items:center;justify-content:space-between}header h1{font-size:18px;color:#ffa500}header .nav a{color:#aaa;text-decoration:none;margin-left:16px;font-size:14px}header .nav a:hover{color:#ffa500}.container{max-width:960px;margin:0 auto;padding:24px 16px}.badge{background:#ffa500;color:#000;font-size:11px;font-weight:700;padding:2px 7px;border-radius:10px;margin-left:6px}.empty{text-align:center;color:#555;padding:60px 0;font-size:15px}.card{background:#161616;border:1px solid #222;border-radius:12px;margin-bottom:16px;overflow:hidden}.card-header{padding:12px 16px;background:#1a1a1a;border-bottom:1px solid #222;display:flex;align-items:center;gap:8px;font-size:13px;color:#aaa;flex-wrap:wrap}.card-header .id{color:#ffa500;font-weight:700;font-size:14px}.tag{background:#252525;padding:2px 8px;border-radius:6px;font-size:11px}.tag-iv{background:#1a2e1a;color:#22c55e}.tag-ida{background:#1a1f2e;color:#60a5fa}.tag-exec{background:#2e1a2e;color:#c084fc}.tag-eco{background:#1a2020;color:#67e8f9}.card-body{display:grid;grid-template-columns:1fr 1fr}.col{padding:16px}.col+.col{border-left:1px solid #222}.col-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#444;margin-bottom:10px}.imgs-grid{display:flex;flex-wrap:wrap;gap:8px}.imgs-grid img{width:calc(50% - 4px);min-width:120px;border-radius:8px;object-fit:cover}.imgs-grid img:only-child{width:100%}.texto-orig{font-size:13px;color:#888;white-space:pre-wrap;word-break:break-word;margin-top:8px}.edit-area{width:100%;background:#0d0d0d;color:#f0f0f0;border:1px solid #2a2a2a;border-radius:8px;padding:12px;font-size:13px;font-family:inherit;line-height:1.7;resize:vertical;min-height:200px}.edit-area:focus{outline:none;border-color:#444}.card-footer{padding:12px 16px;border-top:1px solid #1a1a1a;display:flex;gap:10px;align-items:center;flex-wrap:wrap}.btn{padding:8px 20px;border-radius:8px;border:none;font-size:13px;font-weight:600;cursor:pointer;transition:opacity .15s}.btn:hover{opacity:.8}.btn-ap{background:#22c55e;color:#000}.btn-rej{background:#333;color:#aaa}.ok-ap{color:#22c55e;font-size:13px}.ok-rej{color:#555;font-size:13px}.buffer-bar{background:#1a1400;border:1px solid #3a2e00;border-radius:8px;padding:10px 16px;font-size:13px;color:#ffa500;margin-bottom:16px}.sep{color:#333;font-size:12px;text-transform:uppercase;letter-spacing:1px;margin:28px 0 12px}@media(max-width:600px){.card-body{grid-template-columns:1fr}.col+.col{border-left:none;border-top:1px solid #1a1a1a}.imgs-grid img{width:100%}}`;

// ── ROTAS ─────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const pendentes = filaPendentes.filter(o => o.status==='pendente').length;
  const emBuffer  = [...bufferAgrupamento.values()].reduce((s,e) => s+e.itens.length, 0);
  const status    = conectado ? 'Conectado' : qrAtual ? 'Aguardando QR' : 'Desconectado';
  res.send('<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>CDV Server</title><style>body{font-family:sans-serif;background:#0d0d0d;color:#f0f0f0;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;gap:16px;margin:0}h1{color:#ffa500}p{color:#aaa;font-size:14px}.links{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;margin-top:8px}a{color:#ffa500;text-decoration:none;border:1px solid #333;padding:9px 20px;border-radius:8px;font-size:14px}a:hover{border-color:#ffa500}</style></head><body><h1>CDV Baileys Server</h1><p>'+status+'</p>'+(emBuffer>0?'<p>'+emBuffer+' item(ns) na janela de agrupamento</p>':'')+'<div class="links">'+(!conectado?'<a href="/qr">Escanear QR</a>':'')+'<a href="/painel">Painel'+(pendentes>0?' ('+pendentes+')':'')+'</a><a href="/status">Status</a><a href="/grupos">Grupos</a></div></body></html>');
});

app.get('/qr', (req, res) => {
  if (conectado) return res.send('<html><body style="background:#0d0d0d;color:#ffa500;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:16px"><h2>WhatsApp ja conectado!</h2><a href="/" style="color:#ffa500">Voltar</a></body></html>');
  if (!qrAtual)  return res.send('<html><head><meta http-equiv="refresh" content="3"></head><body style="background:#0d0d0d;color:#f0f0f0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh"><h2>Gerando QR...</h2></body></html>');
  res.send('<html><head><title>QR</title><meta http-equiv="refresh" content="30"><style>body{background:#0d0d0d;color:#f0f0f0;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;gap:16px;margin:0}h2{color:#ffa500}img{border:4px solid #ffa500;border-radius:12px;width:260px}p{color:#aaa;font-size:.9rem;text-align:center}</style></head><body><h2>Escanear QR Code</h2><img src="'+qrAtual+'" alt="QR"/><p>WhatsApp - Dispositivos conectados - Conectar dispositivo</p></body></html>');
});

app.get('/status', (req, res) => {
  const emBuffer = [...bufferAgrupamento.values()].reduce((s,e) => s+e.itens.length, 0);
  res.json({ conectado, qrDisponivel:!!qrAtual, grupos:Object.keys(GRUPOS), gruposMonitorados:GRUPOS_MONITORADOS, janelaMin:JANELA_AGRUPAMENTO_MS/60000, bufferAtivo:emBuffer, filaPendentes:filaPendentes.filter(o=>o.status==='pendente').length, filaTotal:filaPendentes.length });
});

app.get('/painel', (req, res) => {
  const pendentes   = filaPendentes.filter(o => o.status==='pendente');
  const processados = filaPendentes.filter(o => o.status!=='pendente');
  const emBuffer    = [...bufferAgrupamento.values()].reduce((s,e) => s+e.itens.length, 0);
  const renderCard = (o) => {
    const data = new Date(o.timestamp).toLocaleString('pt-BR');
    const d    = o.dadosExtraidos || {};
    const tipoTag   = d.tipo==='ida_volta'?'<span class="tag tag-iv">Ida e volta</span>':d.tipo==='ida'?'<span class="tag tag-ida">Somente ida</span>':'';
    const cabineTag = d.cabine==='Executiva'?'<span class="tag tag-exec">Executiva</span>':'<span class="tag tag-eco">Economica</span>';
    const rota = d.origem&&d.destino?'<span style="color:#f0f0f0;font-weight:600">'+d.origem+' - '+d.destino+'</span>':'';
    const prog = d.programa?'<span class="tag">'+d.programa+'</span>':'';
    const imgsHtml = (o.imagens||[]).length>0?'<div class="imgs-grid">'+(o.imagens.map(b=>'<img src="data:image/jpeg;base64,'+b+'" />')).join('')+'</div>':'';
    const textoHtml = o.conteudoOriginal?'<div class="texto-orig">'+o.conteudoOriginal+'</div>':'';
    if (o.status==='aprovado')  return '<div class="card"><div class="card-header"><span class="id">#'+o.id+'</span>'+rota+tipoTag+cabineTag+'<span style="margin-left:auto">'+data+'</span></div><div style="padding:12px 16px"><span class="ok-ap">Aprovado e enviado</span></div></div>';
    if (o.status==='rejeitado') return '<div class="card"><div class="card-header"><span class="id">#'+o.id+'</span>'+rota+tipoTag+cabineTag+'<span style="margin-left:auto">'+data+'</span></div><div style="padding:12px 16px"><span class="ok-rej">Rejeitado</span></div></div>';
    return '<div class="card" id="card-'+o.id+'"><div class="card-header"><span class="id">#'+o.id+'</span>'+rota+tipoTag+cabineTag+prog+'<span style="margin-left:auto;font-size:12px;color:#555">'+data+'</span></div><div class="card-body"><div class="col"><div class="col-title">Original ('+o.tipoConteudo+')</div>'+imgsHtml+textoHtml+'</div><div class="col"><div class="col-title">Mensagem formatada</div><textarea class="edit-area" id="msg-'+o.id+'">'+o.mensagemFormatada+'</textarea></div></div><div class="card-footer"><button class="btn btn-ap" onclick="aprovar('+o.id+')">Aprovar e enviar</button><button class="btn btn-rej" onclick="rejeitar('+o.id+')">Rejeitar</button><span id="fb-'+o.id+'" style="font-size:13px;margin-left:auto"></span></div></div>';
  };
  res.send('<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Painel CDV</title><style>'+PAINEL_CSS+'</style></head><body><header><h1>Painel'+(pendentes.length>0?' <span class="badge">'+pendentes.length+'</span>':'')+'</h1><nav class="nav"><a href="/">Inicio</a><a href="/painel">Atualizar</a></nav></header><div class="container">'+(emBuffer>0?'<div class="buffer-bar">'+emBuffer+' item(ns) aguardando janela de '+JANELA_AGRUPAMENTO_MS/60000+' min...</div>':'')+(pendentes.length===0&&emBuffer===0?'<div class="empty">Nenhuma oferta pendente.</div>':pendentes.map(renderCard).join(''))+(processados.length>0?'<div class="sep">Processados recentemente</div>'+processados.slice(0,10).map(renderCard).join(''):'')+'</div><script>async function aprovar(id){const msg=document.getElementById("msg-"+id).value;const fb=document.getElementById("fb-"+id);fb.textContent="Enviando...";fb.style.color="#aaa";const r=await fetch("/painel/aprovar/"+id,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({mensagem:msg})});const d=await r.json();if(d.ok){fb.style.color="#22c55e";fb.textContent="Enviado!";setTimeout(()=>{const c=document.getElementById("card-"+id);if(c)c.style.opacity=".35"},800)}else{fb.style.color="#ef4444";fb.textContent="Erro: "+d.erro}}async function rejeitar(id){const fb=document.getElementById("fb-"+id);const r=await fetch("/painel/rejeitar/"+id,{method:"POST"});const d=await r.json();if(d.ok){fb.style.color="#555";fb.textContent="Rejeitado";setTimeout(()=>{const c=document.getElementById("card-"+id);if(c)c.style.opacity=".35"},400)}}'+(emBuffer>0?'setTimeout(()=>location.reload(),30000);':'')+'</script></body></html>');
});

app.post('/api/claude', async (req, res) => {
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req.body),
    });
    const data = await resp.json();
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: { message: e.message } });
  }
});

app.get('/painel-json', (req, res) => {
  const emBuffer = [...bufferAgrupamento.values()].reduce((s,e) => s+e.itens.length, 0);
  res.json({ ok:true, bufferAtivo:emBuffer, ofertas:filaPendentes.slice(0,50) });
});

app.post('/painel/aprovar/:id', async (req, res) => {
  const id     = parseInt(req.params.id);
  const oferta = filaPendentes.find(o => o.id===id);
  if (!oferta)             return res.status(404).json({ ok:false, erro:'Oferta nao encontrada.' });
  if (!conectado || !sock) return res.status(503).json({ ok:false, erro:'WhatsApp nao conectado.' });
  const mensagem = req.body.mensagem || oferta.mensagemFormatada;
  try {
    await sock.sendMessage(GRUPOS[GRUPO_DESTINO_PASSAGENS], { text:mensagem });
    oferta.status = 'aprovado';
    salvarFila();
    res.json({ ok:true });
  } catch(err) { res.status(500).json({ ok:false, erro:err.message }); }
});

app.post('/painel/rejeitar/:id', (req, res) => {
  const id     = parseInt(req.params.id);
  const oferta = filaPendentes.find(o => o.id===id);
  if (!oferta) return res.status(404).json({ ok:false, erro:'Oferta nao encontrada.' });
  oferta.status = 'rejeitado';
  salvarFila();
  res.json({ ok:true });
});

// Reprocessar oferta existente com o pipeline atualizado
app.post('/painel/reprocessar/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const oferta = filaPendentes.find(o => o.id === id && o.status === 'pendente');
  if (!oferta) return res.status(404).json({ ok:false, erro:'Oferta não encontrada.' });

  try {
    // Reconstruir itens como se tivessem acabado de chegar
    const itens = [];
    // Adicionar imagens como itens separados
    for (const imgB64 of (oferta.imagens || [])) {
      itens.push({ texto: oferta.conteudoOriginal || '', imagemBase64: imgB64, timestamp: Date.now() });
    }
    // Se não tinha imagem, usar só o texto
    if (itens.length === 0 && oferta.conteudoOriginal) {
      itens.push({ texto: oferta.conteudoOriginal, imagemBase64: null, timestamp: Date.now() });
    }
    if (itens.length === 0) return res.status(400).json({ ok:false, erro:'Sem conteúdo para reprocessar.' });

    // Rodar o pipeline
    console.log('[REPROCESS] Reprocessando oferta #'+id+' com '+itens.length+' item(ns)');
    const classificacoes = await classificarItens(itens);
    const validas = classificacoes.filter(c => c.valido);
    if (validas.length === 0) {
      return res.json({ ok:false, erro:'Nenhuma emissão válida encontrada após reprocessamento.' });
    }
    const emissoes = await agruparEFormatar(classificacoes);
    if (emissoes.length === 0) {
      return res.json({ ok:false, erro:'Agrupamento retornou 0 emissões.' });
    }
    // Atualizar a oferta com a mensagem reprocessada (usa a primeira emissão)
    oferta.mensagemFormatada = emissoes[0].mensagem;
    oferta.dadosExtraidos    = emissoes[0];
    oferta.timestamp         = new Date().toISOString();
    salvarFila();
    console.log('[REPROCESS] Oferta #'+id+' reprocessada com sucesso.');
    res.json({ ok:true, mensagemFormatada: oferta.mensagemFormatada });
  } catch(e) {
    console.error('[REPROCESS] Erro:', e.message);
    res.status(500).json({ ok:false, erro: e.message });
  }
});

// Mesclar duas ofertas pendentes em uma
// Injetar texto manualmente no pipeline (simula mensagem recebida)
app.post('/injetar', async (req, res) => {
  const { texto } = req.body;
  if (!texto || !texto.trim()) return res.status(400).json({ ok:false, erro:'Texto vazio.' });
  // Usar um grupoId fictício para injeções manuais
  const grupoFake = 'injecao_manual';
  if (!bufferAgrupamento.has(grupoFake)) {
    const timer = setTimeout(() => processarBuffer(grupoFake), JANELA_AGRUPAMENTO_MS);
    bufferAgrupamento.set(grupoFake, { itens:[], timer });
  }
  const entrada = bufferAgrupamento.get(grupoFake);
  entrada.itens.push({ texto: texto.trim(), imagemBase64: null, timestamp: Date.now() });
  console.log('[INJECT] Texto injetado manualmente. Buffer: '+entrada.itens.length+' item(ns)');
  res.json({ ok:true, bufferItens: entrada.itens.length });
});

app.post('/painel/mesclar', (req, res) => {
  const { id1, id2 } = req.body;
  if (!id1 || !id2) return res.status(400).json({ ok:false, erro:'ids necessarios.' });
  const o1 = filaPendentes.find(o => o.id===id1 && o.status==='pendente');
  const o2 = filaPendentes.find(o => o.id===id2 && o.status==='pendente');
  if (!o1 || !o2) return res.status(404).json({ ok:false, erro:'Uma ou ambas ofertas nao encontradas ou ja processadas.' });

  // Combinar conteudo: texto + imagens de ambas
  const textosMesclados  = [...(o1.conteudoOriginal||[]), ...(o2.conteudoOriginal||[])];
  const imagensMescladas = [...(o1.imagens||[]), ...(o2.imagens||[])];

  // Mensagem mesclada: unir as duas mensagens formatadas
  const msg1 = (o1.mensagemFormatada||'').trim();
  const msg2 = (o2.mensagemFormatada||'').trim();
  const mensagemMesclada = msg1 + (msg1 && msg2 ? '\n\n' : '') + msg2;

  // Atualizar o1 com dados mesclados
  o1.conteudoOriginal  = textosMesclados;
  o1.imagens           = imagensMescladas;
  o1.mensagemFormatada = mensagemMesclada;
  o1.tipoConteudo      = 'mesclado';
  o1.timestamp         = new Date().toISOString();

  // Marcar o2 como mesclado (removido)
  o2.status = 'mesclado';
  salvarFila();
  res.json({ ok:true, id: o1.id, mensagemMesclada });
});

app.post('/enviar', async (req, res) => {
  const { grupo, mensagem } = req.body;
  if (!conectado || !sock) return res.status(503).json({ ok:false, erro:'WhatsApp nao conectado.' });
  const grupoId = resolverGrupo(grupo);
  if (!grupoId) return res.status(400).json({ ok:false, erro:'Grupo invalido: '+grupo });
  if (!mensagem?.trim()) return res.status(400).json({ ok:false, erro:'Mensagem vazia.' });
  try { await sock.sendMessage(grupoId, { text:mensagem }); res.json({ ok:true }); }
  catch(err) { res.status(500).json({ ok:false, erro:err.message }); }
});

app.post('/enviar-imagem', upload.single('imagem'), async (req, res) => {
  const { grupo, legenda } = req.body;
  const file = req.file;
  if (!conectado || !sock) { if(file) unlinkSync(file.path); return res.status(503).json({ ok:false, erro:'WhatsApp nao conectado.' }); }
  const grupoId = resolverGrupo(grupo);
  if (!grupoId) { if(file) unlinkSync(file.path); return res.status(400).json({ ok:false, erro:'Grupo invalido.' }); }
  if (!file) return res.status(400).json({ ok:false, erro:'Imagem obrigatoria.' });
  try {
    const buffer = readFileSync(file.path);
    await sock.sendMessage(grupoId, { image:buffer, caption:legenda||'' });
    res.json({ ok:true });
  } catch(err) { res.status(500).json({ ok:false, erro:err.message }); }
  finally { if(existsSync(file.path)) unlinkSync(file.path); }
});

app.get('/grupos', async (req, res) => {
  if (!conectado || !sock) return res.status(503).json({ ok:false, erro:'WhatsApp nao conectado.' });
  try {
    const chats  = await sock.groupFetchAllParticipating();
    const grupos = Object.values(chats).map(g => ({ id:g.id, nome:g.subject||'(sem nome)' })).sort((a,b) => a.nome.localeCompare(b.nome,'pt-BR'));
    res.json({ ok:true, total:grupos.length, grupos });
  } catch(err) { res.status(500).json({ ok:false, erro:err.message }); }
});

app.listen(PORT, () => {
  console.log('Servidor na porta '+PORT);
  console.log('Monitorando: '+GRUPOS_MONITORADOS.join(', '));
  console.log('Janela de agrupamento: '+JANELA_AGRUPAMENTO_MS/60000+' min');
});

conectar();
