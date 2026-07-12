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

// ── TELEGRAM ──────────────────────────────────────────────────────────────────
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Raw } from 'telegram/events/index.js';
import { Api } from 'telegram';

// ── LOGGER CUSTOMIZADO (suprimir ruído do Baileys) ───────────────────────────
const baileysLogger = pino({ level: 'silent' });

// Intercepta console.log/warn para suprimir dumps de criptografia do Baileys
// que causam rate limit de 500 logs/s no Railway e derrubam o processo.
// Filtro de noise removido temporariamente para diagnóstico.

// ── HANDLERS DE ERRO GLOBAIS ──────────────────────────────────────────────────
process.on('uncaughtException',  (err) => console.error('[FATAL] uncaughtException:', err.message, err.stack));
process.on('unhandledRejection', (err) => console.error('[FATAL] unhandledRejection:', err?.message || err));

// ── GRUPOS DE DESTINO ─────────────────────────────────────────────────────────
const GRUPOS = {
  tsp:         '120363424721106736@g.us',
  cdv_ofertas: '120363170138704529@g.us',
  cdv_emissao: '120363172490263905@g.us',
};
const GRUPOS_MONITORADOS      = [
  '120363153036688838@g.us',
  '120363409136599326@g.us',
  '120363410708080270@g.us',
  '120363229600818869@g.us',
  '120363298361885116@g.us',
  '120363301488379027@g.us',
  '120363230402728347@g.us',
  '120363229682219999@g.us',
  '120363212151306916@g.us',
  '120363211235070904@g.us',
  '120363318399199070@g.us',
  '120363230586056001@g.us',
  '120363211276624072@g.us',
  '120363416996630307@g.us',
  '120363427410900900@g.us',
  '120363423603571989@g.us',
  '120363280292009756@g.us',
];
const GRUPO_DESTINO_PASSAGENS = 'cdv_emissao';
const JANELA_AGRUPAMENTO_MS   = 3 * 60 * 1000;

const GRUPOS_FILTRO_DATAS_MIN = {
  '120363229600818869@g.us': 5, // TSM - ALERTAS BH
  '120363298361885116@g.us': 5, // TSM - ALERTAS SP #3
  '120363301488379027@g.us': 5, // TSM - ALERTAS RJ #2
  '120363230402728347@g.us': 5, // TSM - ALERTAS GOIÂNIA
  '120363229682219999@g.us': 5, // TSM - ALERTAS CURITIBA
  '120363212151306916@g.us': 5, // TSM - ALERTAS POA
  '120363211235070904@g.us': 5, // TSM - ALERTAS FLORIPA/NAVEGANTES
  '120363318399199070@g.us': 5, // TSM - (sem nome na lista)
  '120363230586056001@g.us': 5, // TSM - ALERTAS FORTALEZA
  '120363211276624072@g.us': 5, // TSM - ALERTAS SALVADOR
  '120363416996630307@g.us': 5, // TSM - ALERTAS BRASÍLIA #3
  '120363427410900900@g.us': 5, // TSM - ALERTAS RECIFE #2
  '120363423603571989@g.us': 5, // TSM - ALERTAS UBERLÂNDIA
  '120363280292009756@g.us': 5, // TSM - ALERTAS CAMPO GRANDE
};

const PORT          = process.env.PORT || 3001;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const SESSAO_DIR    = './sessao';
const UPLOAD_DIR    = './tmp-uploads';

[SESSAO_DIR, UPLOAD_DIR].forEach(d => { if (!existsSync(d)) mkdirSync(d, { recursive: true }); });

const app    = express();
const upload = multer({ dest: UPLOAD_DIR });
app.use(cors());
app.use(express.json({ limit: '50mb' }));

let sock         = null;
let conectado    = false;
let qrAtual      = null;

// ── GERENCIADOR DE CONEXÃO ────────────────────────────────────────────────────
// Flag que indica se já existe um processo de conexão ativo.
// Evita instâncias duplas de sock sem complexidade de Promises aninhadas.
let _conexaoPromise = null; // apenas para expor no /status

// Aguarda sock disponível com polling leve.
// Dispara conectar() uma única vez se não estiver conectando.
async function aguardarSock(ms = 20000) {
  if (conectado && sock) return true;
  console.log('[WA] aguardarSock: aguardando conexão...');
  if (!isConnecting && !sock) conectar();
  const inicio = Date.now();
  while ((!conectado || !sock) && Date.now() - inicio < ms) {
    await new Promise(r => setTimeout(r, 500));
  }
  return conectado && !!sock;
}

// Alias mantido para compatibilidade com /qr route
function iniciarConexao() {
  if (!isConnecting && !sock) conectar();
}
const FILA_PATH = SESSAO_DIR + '/fila_pendentes.json';

function carregarFila() {
  try {
    if (existsSync(FILA_PATH)) {
      const dados = JSON.parse(readFileSync(FILA_PATH, 'utf-8'));
      filaPendentes.push(...dados);
      console.log('[FILA] Carregadas ' + dados.length + ' ofertas do disco.');
    }
  } catch(e) { console.log('[FILA] Erro ao carregar fila:', e.message); }
}

function limparFila() {
  const agora = Date.now();
  const LIMITE_24H = 24 * 60 * 60 * 1000;
  const LIMITE_PROCESSADAS = 20;

  // 1. Remove qualquer oferta (pendente ou não) com mais de 24h
  for (let i = filaPendentes.length - 1; i >= 0; i--) {
    const ts = new Date(filaPendentes[i].timestamp).getTime();
    if (agora - ts > LIMITE_24H) filaPendentes.splice(i, 1);
  }

  // 2. Garante no máximo 20 aprovadas/rejeitadas (remove as mais antigas)
  const processadas = filaPendentes
    .map((o, i) => ({ o, i }))
    .filter(({ o }) => o.status !== 'pendente')
    .sort((a, b) => new Date(a.o.timestamp) - new Date(b.o.timestamp));
  const excesso = processadas.length - LIMITE_PROCESSADAS;
  if (excesso > 0) {
    const idxRemover = new Set(processadas.slice(0, excesso).map(({ i }) => i));
    for (let i = filaPendentes.length - 1; i >= 0; i--) {
      if (idxRemover.has(i)) filaPendentes.splice(i, 1);
    }
  }
}

function salvarFila() {
  try {
    limparFila();
    writeFileSync(FILA_PATH, JSON.stringify(filaPendentes), 'utf-8');
  } catch(e) { console.log('[FILA] Erro ao salvar fila:', e.message); }
}

const filaPendentes = [];
carregarFila();
let contadorId = filaPendentes.length > 0
  ? filaPendentes.reduce((max, o) => Math.max(max, parseInt(o.id)||0), 0) + 1
  : 1;
console.log('[FILA] Contador de IDs iniciado em: ' + contadorId);

// Recolocar na fila de envio ofertas que foram aprovadas mas não enviadas (survives restart)
function requeueAprovadas() {
  const aprovadas = filaPendentes.filter(o => o.status === 'aprovado' && o.mensagemFinal);
  if (aprovadas.length === 0) return;
  console.log('[FILA] Reenfileirando ' + aprovadas.length + ' oferta(s) aprovada(s) após restart...');
  for (const o of aprovadas) {
    filaEnvio.push({ ofertaId: o.id, mensagem: o.mensagemFinal, destino: GRUPOS[GRUPO_DESTINO_PASSAGENS] });
    console.log('[FILA] Reenfileirada oferta #' + o.id);
  }
  workerFila().catch(e => { console.error('[FILA] Worker erro:', e.message); workerRodando = false; });
}
const bufferAgrupamento = new Map();

// ── FILA DE ENVIO CDV (intervalo de 5 min, janela 08h–21h, fuso SP) ──────────
const INTERVALO_ENVIO_MS = 10 * 60 * 1000;
const HORA_INICIO_ENVIO  = 8;
const HORA_FIM_ENVIO     = 21;
const TZ_SP              = 'America/Sao_Paulo';

const filaEnvio = [];
let workerRodando = false;

function horaSP() {
  return parseInt(new Intl.DateTimeFormat('pt-BR', { timeZone: TZ_SP, hour: 'numeric', hour12: false }).format(new Date()), 10);
}

function msAteJanela() {
  const hora = horaSP();
  if (hora >= HORA_INICIO_ENVIO && hora < HORA_FIM_ENVIO) return 0;
  const agora = Date.now();
  const partes = new Intl.DateTimeFormat('pt-BR', {
    timeZone: TZ_SP, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(new Date(agora));
  const get = t => parseInt(partes.find(p => p.type === t).value, 10);
  const h = get('hour'), m = get('minute'), s = get('second');
  const segundosPassados = h * 3600 + m * 60 + s;
  const segundosAte08   = HORA_INICIO_ENVIO * 3600;
  let diffMs;
  if (h < HORA_INICIO_ENVIO) {
    diffMs = (segundosAte08 - segundosPassados) * 1000;
  } else {
    diffMs = (86400 - segundosPassados + segundosAte08) * 1000;
  }
  return Math.max(0, diffMs);
}

function calcularPosicaoFila(posicaoNaFila) {
  const agora   = Date.now();
  let tempoMs   = agora + msAteJanela();
  for (let i = 0; i < posicaoNaFila; i++) {
    tempoMs += INTERVALO_ENVIO_MS;
    const h = parseInt(new Intl.DateTimeFormat('pt-BR', { timeZone: TZ_SP, hour: 'numeric', hour12: false }).format(new Date(tempoMs)), 10);
    if (h >= HORA_FIM_ENVIO || h < HORA_INICIO_ENVIO) {
      tempoMs += (24 + HORA_INICIO_ENVIO - h) * 3600000;
    }
  }
  const tempoMin = Math.round((tempoMs - agora) / 60000);
  const horario  = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ_SP, hour: '2-digit', minute: '2-digit' }).format(new Date(tempoMs));
  return { posicao: posicaoNaFila, tempoMin, horario };
}

async function aguardarConectado(timeoutMs = 180000) {
  // Dispara conexão sob demanda se worker precisar enviar
  if (!conectado || !sock) {
    console.log("[WORKER] Desconectado. Conectando sob demanda para envio...");
    conectar();
  }
  const inicio = Date.now();
  while (!conectado || !sock) {
    if (Date.now() - inicio > timeoutMs) throw new Error("Timeout aguardando conexão WhatsApp");
    await new Promise(r => setTimeout(r, 2000));
  }
  resetarInactivityTimer();
}

// Envia mensagem com retry automático (1 tentativa extra) caso a conexão caia no momento do envio.
// Isso resolve o erro que você vê na página TSP na primeira tentativa de envio.
async function enviarMensagem(destino, conteudo, tentativa = 0) {
  if (!conectado || !sock) {
    const ok = await aguardarSock(20000);
    if (!ok) throw new Error('WhatsApp não conectado após aguardar reconexão.');
  }
  try {
    return await sock.sendMessage(destino, conteudo);
  } catch (err) {
    const retryable = err.message?.includes('Connection Closed') ||
                      err.message?.includes('Connection Terminated') ||
                      err.message?.includes('timed out') ||
                      err.message?.includes('Bad MAC') ||
                      err.output?.statusCode === 428;
    if (retryable && tentativa < 2) {
      console.warn('[WA] Falha ao enviar (tentativa ' + (tentativa+1) + '):', err.message, '— aguardando reconexão...');
      await new Promise(r => setTimeout(r, 2000));
      const ok = await aguardarSock(20000);
      if (!ok) throw new Error('WhatsApp não reconectou a tempo para reenvio.');
      return enviarMensagem(destino, conteudo, tentativa + 1);
    }
    throw err;
  }
}

// Timestamp do último envio — persiste entre execuções do worker
let ultimoEnvioMs = 0;

async function workerFila() {
  if (workerRodando) return;
  workerRodando = true;
  console.log('[FILA] Worker iniciado.');
  while (filaEnvio.length > 0) {
    // 1. Aguardar janela de horário (8h–21h SP)
    const espera = msAteJanela();
    if (espera > 0) {
      console.log('[FILA] Fora da janela (hora SP:' + horaSP() + '). Aguardando ' + Math.round(espera / 60000) + ' min...');
      await new Promise(r => setTimeout(r, espera));
    }

    // 2. Respeitar intervalo desde o último envio (mesmo que worker tenha encerrado antes)
    const msDesdoUltimo = Date.now() - ultimoEnvioMs;
    if (ultimoEnvioMs > 0 && msDesdoUltimo < INTERVALO_ENVIO_MS) {
      const aguardar = INTERVALO_ENVIO_MS - msDesdoUltimo;
      console.log('[FILA] Intervalo entre envios: aguardando ' + Math.round(aguardar / 60000) + ' min (último envio há ' + Math.round(msDesdoUltimo / 60000) + ' min).');
      await new Promise(r => setTimeout(r, aguardar));
    }

    // 3. Verificar conexão
    try {
      await aguardarConectado();
    } catch(e) {
      console.error('[FILA] ' + e.message + '. Recolocando item na fila e aguardando 60s.');
      await new Promise(r => setTimeout(r, 60000));
      continue;
    }

    const item = filaEnvio[0];
    if (!item) break;
    try {
      console.log('[FILA] Enviando oferta #' + item.ofertaId + ' para ' + item.destino + ' (' + filaEnvio.length + ' na fila)');
      await enviarMensagem(item.destino, { text: item.mensagem });
      filaEnvio.shift();
      ultimoEnvioMs = Date.now(); // registra timestamp do envio

      // Marca como 'enviado' na filaPendentes para não reentrar na fila após restart
      const ofertaEnviada = filaPendentes.find(o => String(o.id) === String(item.ofertaId));
      if (ofertaEnviada) { ofertaEnviada.status = 'enviado'; salvarFila(); }

      console.log('[FILA] ✓ Oferta #' + item.ofertaId + ' enviada.');
    } catch(e) {
      console.error('[FILA] ✗ Erro ao enviar oferta #' + item.ofertaId + ':', e.message);
      await new Promise(r => setTimeout(r, 10000));
      continue;
    }
  }
  workerRodando = false;
  console.log('[FILA] Worker encerrado (fila vazia).');
}

function enfileirarEnvio(ofertaId, mensagem, grupoAlvo) {
  const destino = grupoAlvo || GRUPOS[GRUPO_DESTINO_PASSAGENS];
  const posicao = filaEnvio.length;
  filaEnvio.push({ ofertaId, mensagem, destino });
  console.log('[FILA] Oferta #' + ofertaId + ' enfileirada na posição ' + (posicao + 1));
  workerFila().catch(e => {
    console.error('[FILA] Worker encerrou com erro:', e.message);
    workerRodando = false;
  });
}

requeueAprovadas();

// ── AGENDAMENTOS ──────────────────────────────────────────────────────────────
const AGEND_PATH = SESSAO_DIR + '/agendamentos.json';
let agendamentos = [];

function carregarAgendamentos() {
  try {
    if (existsSync(AGEND_PATH)) {
      agendamentos = JSON.parse(readFileSync(AGEND_PATH, 'utf-8'));
      console.log('[AGEND] Carregados ' + agendamentos.length + ' agendamentos.');
    }
  } catch(e) { console.log('[AGEND] Erro ao carregar:', e.message); }
}

function salvarAgendamentos() {
  try { writeFileSync(AGEND_PATH, JSON.stringify(agendamentos), 'utf-8'); } catch(e) {}
}

carregarAgendamentos();

setInterval(() => {
  const agora = Date.now();
  const prontos = agendamentos.filter(a => a.status === 'aguardando' && a.dispararEm <= agora);
  for (const ag of prontos) {
    ag.status = 'despachado';
    salvarAgendamentos();
    const grupoId = resolverGrupo(ag.grupo);
    if (!grupoId) { ag.status = 'erro'; salvarAgendamentos(); continue; }
    const isEmissao = ag.grupo === 'cdv_emissao' || grupoId === GRUPOS['cdv_emissao'];
    if (isEmissao) {
      enfileirarEnvio('ag-'+ag.id, ag.mensagem, grupoId);
    } else {
      enviarMensagem(grupoId, { text: ag.mensagem })
        .then(() => { ag.status = 'enviado'; salvarAgendamentos(); })
        .catch(e  => { ag.status = 'erro';   salvarAgendamentos(); console.error('[AGEND] Erro envio:', e.message); });
    }
    console.log('[AGEND] Disparando agendamento #'+ag.id+' para grupo '+ag.grupo);
  }
}, 30 * 1000);

// ── Limpeza automática da fila (1x/hora) — nível do módulo ──────────────────
setInterval(() => {
  const antes = filaPendentes.length;
  limparFila();
  salvarFila();
  const depois = filaPendentes.length;
  if (antes !== depois) console.log('[FILA] Limpeza automática: ' + (antes - depois) + ' oferta(s) removida(s).');
}, 60 * 60 * 1000);

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
  'Smiles':16,'Azul Fidelidade':15,'Azul pelo Mundo':15,
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

function contarDatas(datasStr) {
  if (!datasStr || datasStr === '-') return 0;
  const matches = datasStr.match(/\b\d{1,2}\b/g);
  return matches ? matches.length : 0;
}

function comprimirSequencia(nums) {
  if (!nums || nums.length === 0) return '';
  const sorted = [...new Set(nums)].sort((a, b) => a - b);
  const grupos = [];
  let inicio = sorted[0], fim = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === fim + 1) {
      fim = sorted[i];
    } else {
      grupos.push(inicio === fim ? String(inicio) : fim === inicio + 1 ? `${inicio}, ${fim}` : `${inicio}-${fim}`);
      inicio = sorted[i]; fim = sorted[i];
    }
  }
  grupos.push(inicio === fim ? String(inicio) : fim === inicio + 1 ? `${inicio}, ${fim}` : `${inicio}-${fim}`);
  return grupos.join(', ');
}

function formatarDatas(str) {
  if (!str || str === '-') return '-';
  return str
    .replace(/([A-Za-záàãâéêíóôõúüç]+\/\d{2}:)/g, '\n$1')
    .replace(/^\n/, '')
    .trim()
    .split('\n')
    .map(linha => {
      const match = linha.match(/^([A-Za-záàãâéêíóôõúüç]+\/\d{2}:)\s*(.+)$/);
      if (!match) return linha;
      const prefixo = match[1];
      const dias = match[2].match(/\d+/g);
      if (!dias || dias.length <= 2) return linha;
      const nums = dias.map(Number);
      return `${prefixo} ${comprimirSequencia(nums)}`;
    })
    .join('\n');
}

function formatarMensagemCDV(d) {
  var n = '\n';
  var rodape = '`Dica de emissão encontrada por @davileles - Clube do Viajante`';
  var balcao = '`Faça parte do Balcão clicando aqui: https://pay.hub.la/TkIbYhix67evTSu1be7c`';
  var cpm = PROGRAMAS_CPM[d.programa] || 0;
  // Título usa SEMPRE o MENOR valor entre os trechos. d.pontos pode vir como
  // um número só ("458600"), com separador ("102.000") ou com os dois trechos
  // ("102000 (ida) / 86600 (volta)"). Extrai todos os números e pega o mínimo.
  var pontosTokens = String(d.pontos||'').replace(/\([^)]*\)/g, ' ').match(/\d[\d.,]*/g);
  var pontosNums = (pontosTokens || [])
    .map(function (s) { return parseInt(s.replace(/[.,]/g, ''), 10) || 0; })
    .filter(function (x) { return x > 0 && x <= 5000000; });
  var num = pontosNums.length ? Math.min.apply(null, pontosNums) : 0;
  var valR = cpm > 0 ? Math.round((num/1000)*cpm) : 0;
  var valStr = valR > 0 ? 'R$ '+valR.toLocaleString('pt-BR') : '-';
  var link = PROGRAMAS_LINK[d.programa] || '';
  var trecho = d.tipoVoo === 'internacional' ? ' o trecho em '+(d.cabine||'Econômica') : '';
  var pts = num > 0 ? num.toLocaleString('pt-BR') : (d.pontos||'-');
  var msg = '';
  msg += '*'+d.origem+' - '+d.destino+' por '+pts+' pontos OU '+valStr+trecho+'*'+n+n;
  msg += rodape+n+n;
  msg += 'Você pode comprar essa passagem no Balcão de Milhas CDV por aproximadamente '+valStr+' o trecho + taxa de embarque.'+n+n;
  msg += balcao+n+n;
  msg += '✈️ *DATAS DE IDA*'+n+formatarDatas(d.datasIda)+n+n;
  msg += '🛬 *DATAS DE VOLTA*'+n+formatarDatas(d.datasVolta)+n+n;
  msg += '🎟️ *PROGRAMA* '+d.programa+n+n;
  msg += '✈️ *CIA AÉREA* '+d.cia+n+n;
  msg += '🔗 *LINK* '+link+n+n;
  msg += rodape;
  return msg;
}

// ── REGISTRO DE PASSAGEM NO PROXY + HISTÓRICO 180 DIAS ───────────────────────
const CDV_PROXY_URL = 'https://cdv-proxy-production.up.railway.app';

async function registrarPassagemProxy(dados) {
  // Chama /passagens/registrar e retorna hist180 stats ({ minPts, mediaPts, count, isMin })
  // ou null em caso de falha (fire-and-register, não bloqueia o fluxo).
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(CDV_PROXY_URL + '/passagens/registrar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dados),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    const json = await r.json();
    return json.ok ? (json.hist180 || null) : null;
  } catch (e) {
    console.warn('[CDV-HIST] Falha ao registrar passagem no proxy:', e.message);
    return null;
  }
}

function appendHistoricoMensagem(msg, hist180) {
  // Insere bloco de histórico ANTES do 🔗 *LINK* na mensagem WhatsApp.
  // Só inclui se hist180 tiver ao menos 1 entrada prévia (count >= 1).
  if (!hist180 || hist180.count < 1) return msg;
  const min   = hist180.minPts.toLocaleString('pt-BR');
  const media = hist180.mediaPts.toLocaleString('pt-BR');
  const minLinha = hist180.isMin
    ? `🏆 *MÍN. 180 DIAS*: ${min} pts ➤ 🔥 Menor valor histórico`
    : `🏆 *MÍN. 180 DIAS*: ${min} pts`;
  const bloco = `${minLinha}\n\n📈 *MÉDIA 180 DIAS*: ${media} pts\n\n`;
  // Insere antes do marcador do LINK
  const linkMarker = '🔗 *LINK*';
  const linkIdx = msg.indexOf(linkMarker);
  if (linkIdx === -1) return msg + '\n\n' + bloco.trim();
  return msg.slice(0, linkIdx) + bloco + msg.slice(linkIdx);
}

// ── LINKS AFILIADOS TSP ───────────────────────────────────────────────────────
const LINKS_TSP = {
  'Amazon':        'https://amzn.to/4dFRSzy',
  'Mercado Livre': 'https://meli.la/2xystLt',
  'Shopee_sem':    'https://s.shopee.com.br/9fHPmP3QZF',
  'Shopee_com':    'https://s.shopee.com.br/30kdYeLY0W',
};

function formatarCupomTSP(dados) {
  const loja   = dados.loja   || '';
  const tipo   = dados.tipo   || 'reais';
  const valor  = dados.valor  || 0;
  const minimo = dados.minimo || 0;
  const limite = dados.limite || null;
  const codigo = dados.codigo || null;
  const isPct  = tipo === 'pct';
  const tipoStr = isPct ? '%' : ' reais';

  const validade = (isPct && limite)
    ? `Válido em compras acima de R$ ${minimo} com limite de R$ ${limite} de desconto.`
    : `Válido em compras acima de R$ ${minimo}.`;

  let msg = `*🚨 Cupom de ${valor}${tipoStr} - ${loja}*\n\n`;
  msg += validade + '\n\n';
  msg += `🛒 *LOJA* ${loja.toUpperCase()}`;

  if (codigo) msg += `\n\n🏷️ *CUPOM* ${codigo.toUpperCase()}`;

  if (isPct && limite) {
    const ideal = Math.ceil(100 * Number(limite) / Number(valor));
    msg += `\n\n⚠️ *IMPORTANTE* Ideal para compras de até R$ ${ideal}.\n\n`;
  } else {
    msg += '\n\n';
  }

  let url = '';
  if (loja === 'Amazon')        url = LINKS_TSP['Amazon'];
  else if (loja === 'Mercado Livre') url = LINKS_TSP['Mercado Livre'];
  else if (loja === 'Shopee')   url = codigo ? LINKS_TSP['Shopee_com'] : LINKS_TSP['Shopee_sem'];

  if (url) msg += `🔗 *RESGATE O CUPOM AQUI* ${url}`;

  msg += '\n\n`Convide seus amigos para entrar aqui no grupo: https://chat.whatsapp.com/HK7NL13BdPXKJPAGtvTKKg`';
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
  catch(e) { console.log('JSON parse falhou:', e.message); return null; }
}

// ── EXTRAIR CAMPOS DO CUPOM TELEGRAM ─────────────────────────────────────────
async function extrairCupomTelegram(texto) {
  const system = `Você é um extrator de dados de cupons de desconto para o mercado brasileiro.
Analise a mensagem e retorne SOMENTE JSON válido, sem texto extra, sem markdown.

Campos:
{
  "eh_cupom": true/false,
  "loja": "Amazon" | "Mercado Livre" | "Shopee" | "Outro: nome",
  "tipo": "pct" | "reais",
  "valor": número (ex: 10, 30, 15),
  "minimo": número (valor mínimo de compra, 0 se não informado),
  "limite": número | null (limite máximo de desconto em R$, só para tipo "pct"),
  "codigo": "CUPOM123" | null,
  "multiplos": [ {valor, minimo, codigo, tipo} ] | null (quando há múltiplos cupons na mesma mensagem),
  "observacao": "texto livre" | null
}

Regras:
- Se não for cupom de desconto, retorne {"eh_cupom": false}
- Shopee sem código = "codigo": null
- "tipo": use "pct" quando o desconto for em porcentagem (ex: 20% OFF, 15% de desconto). Use "reais" quando for valor fixo em R$ (ex: R$30 OFF, R$10 de desconto)
- Em "multiplos", cada item DEVE ter seu próprio campo "tipo" ("pct" ou "reais") — não herde o tipo do cupom principal
- Para múltiplos cupons na mesma mensagem (ex: 20% OFF em TVs + 15% OFF em Celulares), use "multiplos" com um item por cupom
- Valores devem ser números puros sem símbolo (ex: 20 para 20%, 30 para R$30)
- "minimo": 0 se não houver valor mínimo informado`;

  return await chamarClaude(system, [{ type:'text', text: texto }], 500);
}

// ── PROCESSAR MENSAGEM DO TELEGRAM ────────────────────────────────────────────
async function processarMensagemTelegram(texto, canalUsername = 'desconhecido', imagemBase64 = null) {
  if (!texto?.trim()) return;
  console.log('[TG] Nova mensagem recebida:', texto.slice(0, 80));

  try {
    const campos = await extrairCupomTelegram(texto);
    if (!campos || !campos.eh_cupom) {
      console.log('[TG] Não é cupom, ignorado.');
      return;
    }

    console.log(`[TG] Cupom identificado: ${campos.loja} | ${campos.valor}${campos.tipo === 'pct' ? '%' : ' R$'}`);

    const lista = campos.multiplos?.length
      ? campos.multiplos.map(m => ({ ...campos, valor: m.valor, minimo: m.minimo ?? 0, codigo: m.codigo ?? campos.codigo, tipo: m.tipo ?? campos.tipo, limite: m.limite ?? campos.limite ?? null, multiplos: null }))
      : [campos];

    for (const c of lista) {
      const mensagemFormatada = formatarCupomTSP(c);
      const oferta = {
        id: gerarId(),
        timestamp: new Date().toISOString(),
        grupoOrigem: `telegram:@${canalUsername}`,
        tipoConteudo: 'cupom_tsp',
        conteudoOriginal: texto,
        imagens: imagemBase64 ? [{ imagemBase64, mime: 'image/jpeg' }] : [],
        mensagemFormatada,
        dadosExtraidos: c,
        status: 'pendente',
      };
      filaPendentes.unshift(oferta);
      salvarFila();
      console.log(`[TG] Cupom #${oferta.id} adicionado à fila — ${c.loja} ${c.valor}${c.tipo === 'pct' ? '%' : ' R$'}`);
    }
  } catch(err) {
    console.error('[TG] Erro ao processar cupom:', err.message);
  }
}

// ── TELEGRAM CLIENT ───────────────────────────────────────────────────────────
const TG_API_ID   = parseInt(process.env.TG_API_ID   || '0');
const TG_API_HASH = process.env.TG_API_HASH || '';
const TG_SESSION_PATH = SESSAO_DIR + '/telegram_session.txt';
const TG_CANAIS_MONITORADOS = (process.env.TG_GRUPO || '@juaocupons,@canaldetestetsp').split(',').map(s => s.trim().replace('@','').toLowerCase());

let tgClient = null;
let tgConectado = false;

let tgAuthState = null;
let tgAuthResolve = null;
let tgAuthReject  = null;
let tgAuthValor   = null;

async function iniciarTelegram() {
  if (!TG_API_ID || !TG_API_HASH) {
    console.log('[TG] TG_API_ID ou TG_API_HASH não configurados. Monitor Telegram desativado.');
    return;
  }

  const sessionStr = existsSync(TG_SESSION_PATH)
    ? readFileSync(TG_SESSION_PATH, 'utf-8').trim()
    : '';

  const session = new StringSession(sessionStr);

  tgClient = new TelegramClient(session, TG_API_ID, TG_API_HASH, {
    connectionRetries: 5,
  });

  await tgClient.start({
    phoneNumber: () => new Promise((resolve, reject) => {
      console.log('[TG] Aguardando número de telefone via /tg-auth...');
      tgAuthState = 'aguardando_telefone';
      tgAuthResolve = resolve;
      tgAuthReject  = reject;
    }),
    password: () => new Promise((resolve, reject) => {
      console.log('[TG] Aguardando senha 2FA via /tg-auth...');
      tgAuthState = 'aguardando_senha';
      tgAuthResolve = resolve;
      tgAuthReject  = reject;
    }),
    phoneCode: () => new Promise((resolve, reject) => {
      console.log('[TG] Aguardando código de verificação via /tg-auth...');
      tgAuthState = 'aguardando_codigo';
      tgAuthResolve = resolve;
      tgAuthReject  = reject;
    }),
    onError: (err) => {
      console.error('[TG] Erro de autenticação:', err.message);
      tgAuthState = 'erro';
    },
  });

  const sessionSalva = tgClient.session.save();
  writeFileSync(TG_SESSION_PATH, sessionSalva, 'utf-8');
  tgConectado = true;
  tgAuthState = 'ok';
  console.log(`[TG] Conectado! Monitorando: ${TG_CANAIS_MONITORADOS.map(c=>'@'+c).join(', ')}`);

  tgClient.addEventHandler(async (update) => {
    try {
      const msg = update.message;
      if (!msg?.message && !msg?.media) return;

      const entity = await tgClient.getEntity(msg.peerId).catch(() => null);
      const username = entity?.username || '';
      if (!TG_CANAIS_MONITORADOS.includes(username.toLowerCase())) return;

      const texto = msg.message || '';
      if (!texto.trim()) return; // sem texto, ignora (só imagem sem legenda)

      // Tentar baixar mídia (foto/documento) se existir
      let imagemBase64 = null;
      if (msg.media) {
        try {
          const buffer = await tgClient.downloadMedia(msg, {});
          if (buffer) imagemBase64 = buffer.toString('base64');
          console.log('[TG] Mídia capturada:', buffer?.length, 'bytes');
        } catch(e) { console.warn('[TG] Falha ao baixar mídia:', e.message); }
      }

      console.log('[TG] Nova mensagem do canal:', texto.slice(0, 80));
      await processarMensagemTelegram(texto, username, imagemBase64);
    } catch (err) { console.error('[TG] Erro no handler de canal:', err.message); }
  }, new Raw({ types: [Api.UpdateNewChannelMessage] }));
}

iniciarTelegram().catch(err => {
  console.error('[TG] Falha ao iniciar:', err.message);
  tgAuthState = 'erro';
});

// ── GRUPOS COM REGRAS ESPECIAIS DE EXTRAÇÃO ───────────────────────────────────
const GRUPO_APENAS_IMAGEM = '120363153036688838@g.us';
const GRUPO_EXECUTIVA     = '120363410708080270@g.us';
const GRUPOS_TEXTO_ESTRUTURADO = new Set([
  '120363229600818869@g.us',
  '120363298361885116@g.us',
  '120363301488379027@g.us',
  '120363230402728347@g.us',
  '120363229682219999@g.us',
  '120363212151306916@g.us',
  '120363318399199070@g.us',
  '120363230586056001@g.us',
  '120363211235070904@g.us',
]);

const SYSTEM_CDV = 'Voce e especialista em passagens aereas com milhas para o mercado brasileiro. Seja GENEROSO: qualquer mencao a rota aerea, milhas/pontos, programa de fidelidade ou companhia aerea deve ser valido. Responda APENAS JSON sem markdown.';
const PROGRAMAS_VALIDOS = 'Programa deve ser um destes: Smiles, Azul Fidelidade, Azul pelo Mundo, LATAM Pass, Iberia Plus, Privilege Club, Executive Club, TAP, AAdvantage, SUMA, Flying Club, Finnair Plus, Aeroplan.\nIMPORTANTE: TudoAzul = Azul Fidelidade. Tudo Azul = Azul Fidelidade. LatamPass = LATAM Pass.\nCabine deve ser exatamente "Economica" ou "Executiva".';

// ── DE-PARA: programa → CIA operadora (para voos nacionais BR e fallback) ─────
const CIA_POR_PROGRAMA = {
  'Smiles':           'GOL',
  'Azul Fidelidade':  'Azul',
  'LATAM Pass':       'LATAM',
};

function corrigirCia(cia, programa, origemCodigo, destinoCodigo) {
  // Verifica se é voo doméstico brasileiro (ambos os aeroportos no BR ou código desconhecido)
  const IATAS_BR = new Set([
    'GRU','CGH','VCP','GIG','SDU','BSB','CNF','SSA','REC','FOR','MAO','BEL',
    'CWB','POA','FLN','NAT','MCZ','AJU','THE','SLZ','JPA','PMW','VIX','CLV',
    'RAO','CGB','CWB','IGU','MGF','LDB','UDI','BPS','PPB','JOI','NVT','XAP',
    'CFB','CFC','CCM','PFB','URG','BVB','STM','IMP','PIN','CAF','TFF','MCP',
  ]);
  const oriIsBR  = !origemCodigo  || IATAS_BR.has(origemCodigo.toUpperCase());
  const destIsBR = !destinoCodigo || IATAS_BR.has(destinoCodigo.toUpperCase());
  const isDomestico = oriIsBR && destIsBR;

  // Smiles: para voos domésticos = GOL. Para internacionais, usa CIA extraída da imagem/texto.
  // Para outros programas, aplicar de-para só em domésticos.
  if (isDomestico && CIA_POR_PROGRAMA[programa]) {
    return CIA_POR_PROGRAMA[programa];
  }
  // Internacional com CIA explícita na fonte (ex: Air France, Turkish) — respeita
  if (cia && cia !== programa) return cia;
  // Fallback para doméstico sem CIA identificada
  return CIA_POR_PROGRAMA[programa] || cia;
}
const JSON_EXEMPLO = (i) => '{"resultados":[{"valido":true,"indice":'+i+',"origem":"São Paulo","destino":"Cancún","origemCodigo":"GRU","destinoCodigo":"CUN","cia":"LATAM","programa":"LATAM Pass","pontos":"31494","cabine":"Economica","tipoVoo":"internacional","direcao":"ida_volta","datasIda":"Jun/26: 16, 19, 22","datasVolta":"Jun/26: 22, 23"}]}';
const JSON_INVALIDO = (i) => '{"resultados":[{"valido":false,"indice":'+i+'}]}';

// ── PASSO 1: CLASSIFICAR (CDV) ────────────────────────────────────────────────
async function classificarItens(itens, grupoId) {
  const resultados = [];

  if (grupoId === GRUPO_APENAS_IMAGEM) {
    const itensComImagem = itens.filter(item => item.imagemBase64);
    if (itensComImagem.length === 0) { console.log('[GRUPO-IMG] Nenhuma imagem encontrada, descartando.'); return []; }

    for (let i = 0; i < itensComImagem.length; i++) {
      const item = itensComImagem[i];
      const indiceOriginal = itens.indexOf(item);
      const content = [
        { type:'image', source:{ type:'base64', media_type:'image/jpeg', data:item.imagemBase64 } },
        { type:'text', text:
          'Esta imagem é de um grupo de alertas de passagens aéreas com milhas. Extraia os dados diretamente da imagem — IGNORE qualquer texto que acompanhe.\n\n'
          +'Leia da imagem:\n'
          +'- Programa de fidelidade (ex: LATAM Pass, Smiles, Azul Fidelidade, Azul pelo Mundo)\n'
          +'- Origem e destino com código IATA\n'
          +'- Quantidade de milhas/pontos\n'
          +'- Classe (Econômica ou Executiva)\n'
          +'- Companhia aérea operadora do voo (campo "cia")\n'
          +'- Datas de ida\n'
          +'- Datas de volta (pode estar em imagem separada)\n\n'
          +'CRÍTICO sobre códigos IATA (origemCodigo e destinoCodigo):\n'
          +'- Leia o código IATA EXATAMENTE como aparece na imagem. Ex: se a imagem mostra "VIX → RAO", origemCodigo="VIX" e destinoCodigo="RAO".\n'
          +'- NUNCA substitua, corrija ou invente um código IATA diferente do que está na imagem.\n'
          +'- Para o campo "origem" use o nome da cidade do IATA de origem. Para "destino" use o nome da cidade do IATA de destino. Ex: VIX=Vitória, RAO=Ribeirão Preto, CLV=Caldas Novas, CTG=Cartagena, CGB=Cuiabá, SSA=Salvador.\n'
          +'- Se não souber o nome da cidade, use o próprio código IATA como nome — nunca invente.\n\n'
          +'CRÍTICO sobre companhia aérea (campo "cia"):\n'
          +'- "cia" é a companhia que OPERA o voo, não o programa de fidelidade.\n'
          +'- Quando o programa for "Azul pelo Mundo", a CIA é sempre uma parceira estrangeira mencionada na imagem (ex: COPA, United, TAP, Air France, KLM). NUNCA coloque "Azul" como CIA nesse programa.\n'
          +'- Leia o texto da imagem: frases como "voando pela COPA", "operado por United" indicam a CIA correta.\n\n'
          +'Se a imagem mostrar APENAS datas de ida (sem datas de volta) ou APENAS datas de volta, preencha somente o campo correspondente e deixe o outro vazio.\n'
          +'Normalize as datas para o formato "Mês/Ano: dias". Ex: "Jun/26: 11, 13, 15".\n'
          +'IMPORTANTE sobre cidades: use o nome completo da cidade, não o código IATA.\n\n'
          +PROGRAMAS_VALIDOS+'\n\n'
          +'Responda com este JSON:\n'+JSON_EXEMPLO(indiceOriginal)+'\n'
          +'Se não houver passagem aérea na imagem retorne: '+JSON_INVALIDO(indiceOriginal)
        }
      ];
      const resultado = await chamarClaude(SYSTEM_CDV, content, 4096);
      const lista = resultado?.resultados || (resultado?.valido !== undefined ? [resultado] : [{ valido:false, indice:indiceOriginal }]);
      for (const r of lista) {
        if (r?.valido) {
          r.origem  = resolverCidade(r.origemCodigo, r.origem);
          r.destino = resolverCidade(r.destinoCodigo, r.destino);
          r.cia     = corrigirCia(r.cia, r.programa, r.origemCodigo, r.destinoCodigo);
        }
        resultados.push(r || { valido:false, indice:indiceOriginal });
      }
    }
    return resultados;
  }

  if (grupoId === GRUPO_EXECUTIVA) {
    const itensTexto = itens.filter(item => item.texto?.trim());
    if (itensTexto.length === 0) { console.log('[GRUPO-EXEC] Sem texto, descartando.'); return []; }

    for (let i = 0; i < itensTexto.length; i++) {
      const item = itensTexto[i];
      const indiceOriginal = itens.indexOf(item);
      const content = [{ type:'text', text:
        'Este texto é de um grupo especializado em passagens de CLASSE EXECUTIVA com milhas.\n\n'
        +'REGRAS CRÍTICAS:\n'
        +'1. Cabine é SEMPRE "Executiva" independente do que estiver no texto.\n'
        +'2. Se houver múltiplos programas de fidelidade listados (ex: Smiles, Azul, Aegean), use APENAS O PRIMEIRO programa e suas respectivas milhas. Ignore os demais.\n'
        +'3. Ignore COMPLETAMENTE imagens — extraia dados somente do texto.\n'
        +'4. Nas datas, remova números entre parênteses (quantidade de assentos). Ex: "JUL/26: 13(2), 19(1)" → "Jul/26: 13, 19".\n'
        +'5. Normalize datas para "Mês/Ano: dias". Ex: "JUL/26: 13, 19" → "Jul/26: 13, 19".\n'
        +'6. Pode haver uma mensagem somente com datas de ida (rota A→B) e outra somente com datas de volta (rota B→A). Nesse caso, indique "direcao":"ida" ou "direcao":"volta" conforme aplicável.\n\n'
        +'Texto:\n'+item.texto+'\n\n'
        +PROGRAMAS_VALIDOS+'\n\n'
        +'Responda com este JSON:\n'+JSON_EXEMPLO(indiceOriginal)+'\n'
        +'Se NAO houver passagem aerea retorne: '+JSON_INVALIDO(indiceOriginal)
      }];
      const resultado = await chamarClaude(SYSTEM_CDV, content, 4096);
      const lista = resultado?.resultados || (resultado?.valido !== undefined ? [resultado] : [{ valido:false, indice:indiceOriginal }]);
      for (const r of lista) {
        if (r?.valido) {
          r.cabine  = 'Executiva';
          r.origem  = resolverCidade(r.origemCodigo, r.origem);
          r.destino = resolverCidade(r.destinoCodigo, r.destino);
          r.cia     = corrigirCia(r.cia, r.programa, r.origemCodigo, r.destinoCodigo);
        }
        resultados.push(r || { valido:false, indice:indiceOriginal });
      }
    }
    return resultados;
  }

  if (GRUPOS_TEXTO_ESTRUTURADO.has(grupoId)) {
    const itensTexto = itens.filter(item => item.texto?.trim());
    if (itensTexto.length === 0) { console.log('[GRUPO-TEXTO] Sem texto, descartando.'); return []; }

    for (let i = 0; i < itensTexto.length; i++) {
      const item = itensTexto[i];
      const indiceOriginal = itens.indexOf(item);
      const content = [{ type:'text', text:
        'Este texto é de um grupo de alertas de passagens aéreas com milhas. Extraia os dados — IGNORE imagens completamente.\n\n'
        +'REGRAS:\n'
        +'1. O texto pode conter UMA ou MAIS emissões separadas por "Oportunidade de resgate" ou por rotas/programas diferentes. Retorne uma entrada por emissão.\n'
        +'2. Ignore tudo após as datas de volta: propagandas, valores em dinheiro, links de agência.\n'
        +'3. Milhas podem vir como "X mil milhas" — converta para número. Ex: "101.9 mil" = 101900, "39,5 mil" = 39500.\n'
        +'4. Datas podem vir em formato longo. Normalize para "Mês/Ano: dias". Ex: "Junho/26: 13, 14, 15" → "Jun/26: 13, 14, 15". "Agosto: 4 a 31" → "Ago/26: 4, 5, 6, ..., 31" (liste todos os dias).\n'
        +'5. Textos válidos DEVEM conter: programa, origem, destino, milhas e lista de datas. Se faltar lista de datas, retorne inválido.\n\n'
        +'Texto:\n'+item.texto+'\n\n'
        +PROGRAMAS_VALIDOS+'\n\n'
        +'Responda com este JSON (uma entrada por emissão):\n'+JSON_EXEMPLO(indiceOriginal)+'\n'
        +'Se NAO houver passagem aerea retorne: '+JSON_INVALIDO(indiceOriginal)
      }];
      const resultado = await chamarClaude(SYSTEM_CDV, content, 4096);
      const lista = resultado?.resultados || (resultado?.valido !== undefined ? [resultado] : [{ valido:false, indice:indiceOriginal }]);
      for (const r of lista) {
        if (r?.valido) {
          r.origem  = resolverCidade(r.origemCodigo, r.origem);
          r.destino = resolverCidade(r.destinoCodigo, r.destino);
          r.cia     = corrigirCia(r.cia, r.programa, r.origemCodigo, r.destinoCodigo);
        }
        resultados.push(r || { valido:false, indice:indiceOriginal });
      }
    }
    return resultados;
  }

  for (let i = 0; i < itens.length; i++) {
    const item = itens[i];
    const content = [];
    if (item.imagemBase64) content.push({ type:'image', source:{ type:'base64', media_type:'image/jpeg', data:item.imagemBase64 } });
    content.push({ type:'text', text:
      'Extraia TODAS as ofertas de passagem aerea presentes neste conteudo. Pode haver UMA ou MAIS emissoes separadas - identifique cada uma individualmente.\n'
      +(item.texto ? 'Texto: '+item.texto+'\n' : '')
      +'\nREGRAS DE EXTRACAO:\n'
      +'1. Se houver multiplas emissoes no TEXTO (separadas por "Oportunidade de resgate" ou programas/rotas diferentes), retorne UMA entrada por emissao.\n'
      +'2. Se houver IMAGEM junto com texto: a imagem e um screenshot de confirmacao da PRIMEIRA emissao do texto. Use o texto como fonte principal dos dados (programa, milhas, datas). A imagem serve apenas para confirmar dados visuais nao presentes no texto.\n'
      +'3. Priorize SEMPRE os dados do texto sobre os dados da imagem quando houver conflito.\n'
      +'4. DESCARTE imagens que sejam apenas screenshots de resultado de busca sem lista de datas explícita. Para uma imagem ser válida como emissão independente ela DEVE conter: origem, destino, programa/milhas E lista de datas. Se a imagem mostrar apenas o resultado de uma busca (ex: tela de seleção de voo sem datas listadas), descarte-a — ela é apenas uma confirmação visual de outra emissão.\n'
      +'5. Textos válidos como emissão DEVEM conter: programa de fidelidade, origem, destino, cabine E lista de datas. Textos sem lista de datas não são emissões válidas.\n'
      +'\nIMPORTANTE sobre datas: Use as datas do TEXTO quando disponiveis. So leia datas da imagem se o texto nao tiver datas. Normalize para o formato "Mês/Ano: dias". Ex: "Jun/26: 16, 19, 22".\n'
      +'\nIMPORTANTE sobre cidades: use o nome completo da cidade, nao o codigo IATA.\n'
      +'CRITICO: use SEMPRE o codigo IATA do texto quando disponivel. Nunca substitua o codigo IATA correto por outro.\n'
      +'\nResponda com este JSON (uma entrada por emissao encontrada):\n'
      +JSON_EXEMPLO(i)+'\n'
      +PROGRAMAS_VALIDOS+'\n'
      +'Se NAO houver nenhuma passagem aerea retorne: '+JSON_INVALIDO(i)
    });
    const resultado = await chamarClaude(SYSTEM_CDV, content, 4096);
    const lista = resultado?.resultados || (resultado?.valido !== undefined ? [resultado] : [{ valido:false, indice:i }]);
    for (const r of lista) {
      if (r?.valido) {
        r.origem  = resolverCidade(r.origemCodigo, r.origem);
        r.destino = resolverCidade(r.destinoCodigo, r.destino);
        r.cia     = corrigirCia(r.cia, r.programa, r.origemCodigo, r.destinoCodigo);
      }
      resultados.push(r || { valido:false, indice:i });
    }
  }
  return resultados;
}

// ── PASSO 2: AGRUPAR E FORMATAR (CDV) ─────────────────────────────────────────
async function agruparEFormatar(classificacoes) {
  const validas = classificacoes.filter(c => c?.valido);
  if (validas.length === 0) return [];

  if (validas.length === 1) {
    const v = validas[0];
    const dados = { origem:v.origem, destino:v.destino, pontos:v.pontos, programa:v.programa, cia:v.cia, cabine:v.cabine||'Economica', tipoVoo:v.tipoVoo||'internacional', datasIda:v.datasIda||'', datasVolta:v.datasVolta||'' };
    return [{ indices:[v.indice], tipo:v.direcao||'ida', ...dados, mensagem:formatarMensagemCDV(dados) }];
  }

  const grupos = new Map();
  for (const v of validas) {
    const cidadeA = [v.origemCodigo||v.origem, v.destinoCodigo||v.destino].sort().join('-');
    const chave = (v.programa||'') + '|' + (v.cabine||'Economica') + '|' + cidadeA;
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(v);
  }

  if (grupos.size > 1) {
    const resultado = [];
    for (const [, items] of grupos) {
      const v = items.reduce((best, cur) => {
        const dBest = contarDatas((best.datasIda||'') + ' ' + (best.datasVolta||''));
        const dCur  = contarDatas((cur.datasIda||'') + ' ' + (cur.datasVolta||''));
        return dCur > dBest ? cur : best;
      }, items[0]);
      const dados = { origem:v.origem, destino:v.destino, pontos:v.pontos, programa:v.programa, cia:v.cia, cabine:v.cabine||'Economica', tipoVoo:v.tipoVoo||'internacional', datasIda:v.datasIda||'', datasVolta:v.datasVolta||'' };
      resultado.push({ indices:items.map(i=>i.indice), tipo:v.direcao||'ida', ...dados, mensagem:formatarMensagemCDV(dados) });
    }
    return resultado;
  }

  const system = 'Voce e especialista em passagens aereas. Agrupe trechos da mesma emissao. Responda APENAS JSON sem markdown.';
  const prompt = 'Agrupe estas '+validas.length+' ofertas que pertencem a mesma emissao.\n\n'
    +'Criterios para pertencer ao MESMO grupo: mesmo programa, mesmas milhas, mesma companhia, mesma cabine, rotas complementares.\n\n'
    +'REGRAS DE SEPARACAO — sempre separe quando: programas diferentes, cias diferentes, cabines diferentes, rotas sem relacao.\n\n'
    +'IMPORTANTE para pontos: use SEMPRE o MENOR valor entre os trechos.\n\n'
    +'Ofertas:\n'+JSON.stringify(validas,null,2)+'\n\n'
    +'Responda:\n{"emissoes":[{"indices":[0,1],"tipo":"ida_volta","origem":"São Paulo","destino":"Cancún","origemCodigo":"GRU","destinoCodigo":"CUN","cia":"LATAM","programa":"LATAM Pass","pontos":70300,"cabine":"Economica","tipoVoo":"internacional","datasIda":"Jun/26: 16, 19, 22","datasVolta":"Jun/26: 22, 23"}]}';

  const resultado = await chamarClaude(system, [{ type:'text', text:prompt }], 4096);
  const emissoes  = resultado?.emissoes || [];

  if (emissoes.length === 0) {
    return validas.map(v => {
      const dados = { origem:v.origem, destino:v.destino, pontos:v.pontos, programa:v.programa, cia:v.cia, cabine:v.cabine||'Economica', tipoVoo:v.tipoVoo||'internacional', datasIda:v.datasIda||'', datasVolta:v.datasVolta||'' };
      return { indices:[v.indice], tipo:v.direcao||'ida', ...dados, mensagem:formatarMensagemCDV(dados) };
    });
  }

  return emissoes.map(e => {
    const origem  = resolverCidade(e.origemCodigo,  e.origem);
    const destino = resolverCidade(e.destinoCodigo, e.destino);
    const dados   = { origem, destino, pontos:e.pontos, programa:e.programa, cia:e.cia, cabine:e.cabine||'Economica', tipoVoo:e.tipoVoo||'internacional', datasIda:e.datasIda||'', datasVolta:e.datasVolta||'' };
    // A Claude AI retorna índices como posições em `validas` (0,1,2...).
    // Remapeia para os índices reais de `itens` (v.indice) antes de retornar.
    const indicesReais = (e.indices||[]).map(pos => validas[pos]?.indice ?? pos);
    // Também preserva o indice da classificação que melhor corresponde à emissão
    // (usado como fallback na associação de imagens no processarBuffer)
    const indiceClassif = indicesReais.length > 0 ? indicesReais[0] : undefined;
    return { ...e, ...dados, indices: indicesReais, indice: indiceClassif, mensagem:formatarMensagemCDV(dados) };
  });
}

// ── MESCLAR PARES IDA/VOLTA ───────────────────────────────────────────────────
function mesclarParesIdaVolta(validas) {
  const resultado = [];
  let i = 0;

  function normalizar(codigo, nome) {
    return (codigo || resolverCidade('', nome) || '').toLowerCase().trim();
  }

  function ehParInvertido(v, w) {
    const mesmoPrograma = (v.programa||'') === (w.programa||'');
    const mesmaCabine   = (v.cabine||'Economica') === (w.cabine||'Economica');

    // Mesma CIA (companhia operadora) — evita mesclar Finnair com Iberia, etc.
    const mesmaCia = !v.cia || !w.cia || (v.cia||'').toLowerCase().trim() === (w.cia||'').toLowerCase().trim();

    // Milhas similares (±15%) — evita mesclar 50.500 Avios com 77.250 Avios
    const pV = Number(v.pontos) || 0;
    const pW = Number(w.pontos) || 0;
    const milhasSimilares = pV === 0 || pW === 0 || Math.abs(pV - pW) / Math.max(pV, pW) <= 0.15;

    // Rota estritamente invertida: A→B com B→A usando código IATA
    const vOri = normalizar(v.origemCodigo,  v.origem);
    const vDes = normalizar(v.destinoCodigo, v.destino);
    const wOri = normalizar(w.origemCodigo,  w.origem);
    const wDes = normalizar(w.destinoCodigo, w.destino);
    const rotaInvertida = vOri && vDes && wOri && wDes && vOri === wDes && vDes === wOri;

    return mesmoPrograma && mesmaCabine && mesmaCia && milhasSimilares && rotaInvertida;
  }

  const usados = new Set();

  while (i < validas.length) {
    if (usados.has(i)) { i++; continue; }
    const v = validas[i];

    let parIdx = -1;
    // Busca par ida/volta nas próximas 2 posições.
    // Se msg 1 não é par de msg 2, verifica se msg 2 é par de msg 3, etc.
    // O Set "usados" garante que nenhuma mensagem é reutilizada.
    for (let j = i + 1; j <= Math.min(i + 2, validas.length - 1); j++) {
      if (!usados.has(j) && ehParInvertido(v, validas[j])) {
        parIdx = j;
        break;
      }
    }

    if (parIdx !== -1) {
      const w = validas[parIdx];
      const merged = {
        ...v,
        direcao:    'ida_volta',
        datasIda:   v.datasIda   || v.datasVolta || '',
        datasVolta: w.datasIda   || w.datasVolta || '',
        indices:    [...(v.indices||[v.indice]), ...(w.indices||[w.indice])],
      };
      merged.origem  = resolverCidade(merged.origemCodigo,  merged.origem);
      merged.destino = resolverCidade(merged.destinoCodigo, merged.destino);
      console.log('[MERGE] Par ida/volta mesclado (pos '+i+'+'+parIdx+'): '+(v.origemCodigo||v.origem)+'->'+(v.destinoCodigo||v.destino));
      resultado.push(merged);
      usados.add(i);
      usados.add(parIdx);
    } else {
      resultado.push({ ...v, indices: v.indices||[v.indice] });
      usados.add(i);
    }
    i++;
  }
  return resultado;
}

// ── PROCESSAR BUFFER (CDV) ────────────────────────────────────────────────────
// ── FILA DE ESPERA POR PAR IDA/VOLTA ENTRE BUFFERS ───────────────────────────
// Quando uma oferta somente-ida chega, aguarda até 5 minutos por sua volta.
// Se a volta chegar, mescla e libera. Se não chegar, libera como somente-ida.
const _esperandoPar = new Map(); // chave → { oferta, timer, grupoId }

function chaveParOuInverso(oferta) {
  const ori = (oferta.dadosExtraidos?.origemCodigo || '').toUpperCase();
  const des = (oferta.dadosExtraidos?.destinoCodigo || '').toUpperCase();
  const prog = (oferta.dadosExtraidos?.programa || '').toLowerCase();
  const cab  = (oferta.dadosExtraidos?.cabine || 'Economica').toLowerCase();
  if (!ori || !des) return null;
  return prog + '|' + cab + '|' + [ori, des].sort().join('-');
}

async function aguardarParIdaVolta(oferta, grupoId) {
  // Só aplica em ofertas somente-ida com rota identificada
  const tipo = oferta.dadosExtraidos?.tipo;
  if (tipo === 'ida_volta') return false; // já completa, libera direto

  const chave = chaveParOuInverso(oferta);
  if (!chave) return false;

  const esperando = _esperandoPar.get(chave);
  if (esperando) {
    // Par encontrado — mescla e libera
    clearTimeout(esperando.timer);
    _esperandoPar.delete(chave);
    const o1 = esperando.oferta;
    const o2 = oferta;
    // Determina qual é ida e qual é volta pela rota
    const o1Ori = (o1.dadosExtraidos?.origemCodigo || '').toUpperCase();
    const o2Ori = (o2.dadosExtraidos?.origemCodigo || '').toUpperCase();
    const base  = o1Ori <= o2Ori ? o1 : o2;
    const volta = o1Ori <= o2Ori ? o2 : o1;
    const mesclada = {
      ...base,
      id: gerarId(),
      dadosExtraidos: {
        ...base.dadosExtraidos,
        tipo: 'ida_volta',
        datasIda:   base.dadosExtraidos?.datasIda  || volta.dadosExtraidos?.datasIda  || '',
        datasVolta: volta.dadosExtraidos?.datasIda || base.dadosExtraidos?.datasVolta || '',
      },
      conteudoOriginal: [base.conteudoOriginal, volta.conteudoOriginal].filter(Boolean).join('\n'),
      imagens: [...(base.imagens||[]), ...(volta.imagens||[])],
    };
    const hist180Par = await registrarPassagemProxy({ origem:mesclada.dadosExtraidos?.origem||'', destino:mesclada.dadosExtraidos?.destino||'', cia:mesclada.dadosExtraidos?.cia||'', programa:mesclada.dadosExtraidos?.programa||'', pontos:Number(mesclada.dadosExtraidos?.pontos)||0, cabine:mesclada.dadosExtraidos?.cabine||'Economica', datas_ida:mesclada.dadosExtraidos?.datasIda||'', datas_volta:mesclada.dadosExtraidos?.datasVolta||'', fonte:'alerta' });
    mesclada.mensagemFormatada = appendHistoricoMensagem(formatarMensagemCDV({ ...mesclada.dadosExtraidos }), hist180Par);
    mesclada.tipoConteudo = mesclada.imagens.length > 1 ? mesclada.imagens.length+' imagens' : mesclada.imagens.length === 1 ? 'imagem' : 'texto';
    filaPendentes.unshift(mesclada);
    salvarFila();
    console.log('[PAR-BUFFER] Mesclado ida/volta entre buffers: ' + (mesclada.dadosExtraidos?.origemCodigo) + '↔' + (mesclada.dadosExtraidos?.destinoCodigo));
    return true; // consumido
  }

  // Sem par ainda — coloca na espera por 5 minutos
  const timer = setTimeout(() => {
    if (_esperandoPar.get(chave)?.oferta === oferta) {
      _esperandoPar.delete(chave);
      // Registra no proxy e appenda histórico (fire-and-update antes de entrar na fila)
      registrarPassagemProxy({ origem:oferta.dadosExtraidos?.origem||'', destino:oferta.dadosExtraidos?.destino||'', cia:oferta.dadosExtraidos?.cia||'', programa:oferta.dadosExtraidos?.programa||'', pontos:Number(oferta.dadosExtraidos?.pontos)||0, cabine:oferta.dadosExtraidos?.cabine||'Economica', datas_ida:oferta.dadosExtraidos?.datasIda||'', datas_volta:oferta.dadosExtraidos?.datasVolta||'', fonte:'alerta' })
        .then(hist180 => {
          if (hist180) oferta.mensagemFormatada = appendHistoricoMensagem(oferta.mensagemFormatada, hist180);
          filaPendentes.unshift(oferta);
          salvarFila();
        })
        .catch(() => { filaPendentes.unshift(oferta); salvarFila(); });
      console.log('[PAR-BUFFER] Timeout — liberando somente-ida: ' + (oferta.dadosExtraidos?.origemCodigo) + '->' + (oferta.dadosExtraidos?.destinoCodigo));
    }
  }, 5 * 60 * 1000);

  _esperandoPar.set(chave, { oferta, timer, grupoId });
  console.log('[PAR-BUFFER] Aguardando par para: ' + (oferta.dadosExtraidos?.origemCodigo) + '->' + (oferta.dadosExtraidos?.destinoCodigo));
  return true; // segurado
}

async function processarBuffer(grupoId) {
  const entrada = bufferAgrupamento.get(grupoId);
  if (!entrada) return;
  bufferAgrupamento.delete(grupoId);
  const { itens } = entrada;
  console.log('Janela encerrada - '+itens.length+' item(ns)');
  try {
    const classificacoes = await classificarItens(itens, grupoId);
    let validas = classificacoes.filter(c => c?.valido);
    if (validas.length === 0) { console.log('Nenhuma oferta encontrada.'); return; }

    const gruposMesclagem = new Set([GRUPO_APENAS_IMAGEM, GRUPO_EXECUTIVA, ...GRUPOS_TEXTO_ESTRUTURADO]);
    if (gruposMesclagem.has(grupoId)) {
      validas = mesclarParesIdaVolta(validas);
    }

    const minDatas = GRUPOS_FILTRO_DATAS_MIN[grupoId];
    if (minDatas) {
      const validasFiltradas = validas.filter(v => {
        const total = contarDatas(v.datasIda) + contarDatas(v.datasVolta);
        if (total <= minDatas) { console.log('   [FILTRO] Descartada por poucas datas ('+total+'): '+v.origemCodigo+'->'+v.destinoCodigo); return false; }
        return true;
      });
      if (validasFiltradas.length === 0) { console.log('   [FILTRO] Todas descartadas.'); return; }
      validas = validasFiltradas;
    }

    const gruposBypass = new Set([GRUPO_APENAS_IMAGEM, GRUPO_EXECUTIVA]);
    if (gruposBypass.has(grupoId)) {
      for (const v of validas) {
        const indices = v.indices || [v.indice];
        const textos  = indices.map(i => itens[i]?.texto).filter(Boolean).join('\n');
        const dados   = { origem:v.origem, destino:v.destino, pontos:v.pontos, programa:v.programa, cia:v.cia, cabine:v.cabine||'Economica', tipoVoo:v.tipoVoo||'internacional', tipo:v.direcao||'ida', datasIda:v.datasIda||'', datasVolta:v.datasVolta||'' };
        const hist180Bypass = await registrarPassagemProxy({ origem:dados.origem, destino:dados.destino, cia:dados.cia, programa:dados.programa, pontos:Number(dados.pontos)||0, cabine:dados.cabine, datas_ida:dados.datasIda, datas_volta:dados.datasVolta, fonte:'alerta' });
        const mensagem = appendHistoricoMensagem(formatarMensagemCDV(dados), hist180Bypass);
        // indices já contém os índices reais de itens[] — inclui par ida+volta após mesclarParesIdaVolta
        const imagens  = indices.map(i => itens[i]?.imagemBase64).filter(Boolean);
        const oferta   = { id:gerarId(), timestamp:new Date().toISOString(), grupoOrigem:grupoId, tipoConteudo:imagens.length>1?imagens.length+' imagens':imagens.length===1?'imagem':'texto', conteudoOriginal:textos, imagens, mensagemFormatada:mensagem, dadosExtraidos:{ ...dados, indices }, status:'pendente' };
        filaPendentes.unshift(oferta);
        salvarFila();
        console.log('[BYPASS] Oferta criada direto: '+v.origemCodigo+'->'+v.destinoCodigo+' ('+v.programa+')');
      }
      return;
    }

    const classificacoesFinais = validas.map(v => ({ ...v, valido:true }));
    const emissoes = await agruparEFormatar(classificacoesFinais);

    // Monta mapa indice→item para associação correta de imagens/textos
    // (os índices nas emissões vêm do passo 1 e podem não ser posicionais)
    const indiceMapa = new Map();
    itens.forEach((item, idx) => indiceMapa.set(idx, item));

    for (const emissao of emissoes) {
      const indices = emissao.indices || [];

      // Usa os índices reais da emissão (já remapeados de validas para itens no agruparEFormatar).
      // Para emissões com múltiplos programas/rotas no mesmo item (ex: texto com várias emissões),
      // a Claude AI pode retornar o mesmo índice para emissões diferentes — neste caso,
      // usamos o dadosExtraidos para identificar qual item é o original correto.
      // Estratégia: busca o item cujo texto/imagem melhor corresponde à emissão.
      let imagensFinal = indices.map(i => indiceMapa.get(i)?.imagemBase64).filter(Boolean);
      let textosFinal  = indices.map(i => indiceMapa.get(i)?.texto).filter(Boolean).join('\n');

      // Se não encontrou imagens pelos índices (bug de remapeamento), usa o índice da
      // classificação original que gerou esta emissão via dadosExtraidos.indice
      if (imagensFinal.length === 0 && emissao.indice !== undefined) {
        const img = indiceMapa.get(emissao.indice)?.imagemBase64;
        if (img) imagensFinal = [img];
        const txt = indiceMapa.get(emissao.indice)?.texto;
        if (txt && !textosFinal) textosFinal = txt;
      }

      const hist180Normal = await registrarPassagemProxy({ origem:emissao.origem, destino:emissao.destino, cia:emissao.cia, programa:emissao.programa, pontos:Number(emissao.pontos)||0, cabine:emissao.cabine||'Economica', datas_ida:emissao.datasIda||'', datas_volta:emissao.datasVolta||'', fonte:'alerta' });
      const mensagemComHist = appendHistoricoMensagem(emissao.mensagem, hist180Normal);
      const oferta = {
        id: gerarId(),
        timestamp: new Date().toISOString(),
        grupoOrigem: grupoId,
        tipoConteudo: imagensFinal.length > 1 ? imagensFinal.length+' imagens' : imagensFinal.length === 1 ? 'imagem' : 'texto',
        conteudoOriginal: textosFinal,
        imagens: imagensFinal,
        mensagemFormatada: mensagemComHist,
        dadosExtraidos: emissao,
        status: 'pendente'
      };
      // Aguarda par ida/volta de buffer diferente (até 5 min)
      const parEsperando = await aguardarParIdaVolta(oferta, grupoId);
      if (!parEsperando) {
        filaPendentes.unshift(oferta);
        salvarFila();
      }
    }
  } catch (err) { console.error('Erro ao processar buffer:', err.message); }
}

// ── LISTENER WHATSAPP ─────────────────────────────────────────────────────────
// ── FILA SERIAL POR GRUPO ─────────────────────────────────────────────────────
// Garante que mensagens do mesmo grupo são processadas uma por vez, em ordem.
// Grupos diferentes processam em paralelo entre si.
const _filaGrupo = new Map(); // jid → Promise (última tarefa na fila)

function enfileirarPorGrupo(jid, fn) {
  const anterior = _filaGrupo.get(jid) || Promise.resolve();
  const proxima  = anterior.then(() => fn()).catch(err => {
    console.error('[FILA-GRUPO] Erro ao processar mensagem do grupo', jid, ':', err.message);
  });
  _filaGrupo.set(jid, proxima);
  // Limpa o Map após processar para não vazar memória
  proxima.finally(() => {
    if (_filaGrupo.get(jid) === proxima) _filaGrupo.delete(jid);
  });
  return proxima;
}

async function processarMensagem(msg) {
  try {
    const jid    = msg.key.remoteJid;
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
      } catch(e) { console.error('[IMG] Erro ao baixar imagem:', e.message); if (!texto) texto = '[imagem sem legenda]'; }
    } else { return; }
    if (!texto && !imagemB64) return;

    console.log('[MSG] Capturada de', jid.split('@')[0], '— tipo:', tipo, texto ? '| texto: '+texto.slice(0,60) : '| imagem');

    if (texto && (
      texto.includes('Dica de emissao encontrada por @davileles') ||
      texto.includes('Dica de emissão encontrada por @davileles') ||
      texto.includes('Faca parte do Balcao clicando aqui') ||
      texto.includes('Faça parte do Balcão clicando aqui')
    )) { return; }

    if (!bufferAgrupamento.has(jid)) bufferAgrupamento.set(jid, { itens:[], timer:null });
    const entrada = bufferAgrupamento.get(jid);
    if (entrada.timer) clearTimeout(entrada.timer);
    entrada.timer = setTimeout(() => processarBuffer(jid), JANELA_AGRUPAMENTO_MS);
    entrada.itens.push({ texto, imagemBase64:imagemB64, timestamp:Date.now() });
  } catch(err) { console.error('Erro ao processar mensagem WA:', err.message); }
}

// ── WHATSAPP ──────────────────────────────────────────────────────────────────
var HEALTH_PING_MS   = 60 * 1000;   // ping leve a cada 60s (backstop p/ morte silenciosa)
var PING_TIMEOUT_MS  = 15 * 1000;   // sem resposta em 15s = falha
var PING_FALHAS_MAX  = 2;           // só reconecta após N pings falhos seguidos
var ultimoUpsert     = Date.now();
var healthTimer      = null;
var pingFalhas       = 0;

function _reconectarPorHealth(motivo) {
  console.log('[HEALTH] ' + motivo + ' Forçando reconexão...');
  conectado = false;
  isConnecting = false; // evita que reconexão seja ignorada por flag travada
  const sockRef = sock;
  sock = null;
  if (sockRef) { try { sockRef.end(new Error('health-ping-falhou')); } catch(e) {} }
  conectar();
}

// A detecção PRINCIPAL de queda continua sendo por eventos: o keepAliveIntervalMs
// do socket + o handler 'connection.update' (close) reconectam na hora.
// Aqui rodamos só um PING LEVE periódico como backstop para "morte silenciosa"
// (TCP meio-aberto: o socket parece vivo, mas está morto e nenhum evento de close
// dispara). Diferença crucial em relação ao antigo health-check: o ping NÃO derruba
// conexões saudáveis nem reage a canal quieto — só reconecta após PING_FALHAS_MAX
// pings sem resposta seguidos. Por ser leve, pode rodar a cada 60s sem causar churn,
// deixando a janela cega em ~60s em vez de minutos.
function resetarHealthTimer() {
  ultimoUpsert = Date.now();
  pingFalhas = 0;
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = setInterval(async () => {
    if (!conectado || !sock) return;  // queda real já é tratada por connection.update
    try {
      await Promise.race([
        sock.sendPresenceUpdate('available'),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), PING_TIMEOUT_MS)),
      ]);
      pingFalhas = 0;                 // respondeu → conexão viva, não faz nada
    } catch (e) {
      pingFalhas++;
      console.log('[HEALTH] Ping leve falhou (' + pingFalhas + '/' + PING_FALHAS_MAX + '): ' + e.message);
      if (pingFalhas >= PING_FALHAS_MAX) {
        pingFalhas = 0;
        _reconectarPorHealth('Ping leve sem resposta.');
      }
    }
  }, HEALTH_PING_MS);
}

var errosDescripto  = 0;
var ERROS_DESCR_MAX = 15;

async function limparSessaoEReconectar() {
  conectado = false;
  const sockRef = sock;
  sock = null;
  if (sockRef) { try { sockRef.end(new Error('bad-session')); } catch(e) {} }
  try {
    const arquivos = await readdir(SESSAO_DIR);
    for (const arq of arquivos) {
      if (arq.startsWith('session-') || arq.includes('pre-key') || arq.includes('sender-key')) {
        await unlink(SESSAO_DIR + '/' + arq).catch(() => {});
      }
    }
  } catch(e) {}
  errosDescripto = 0;
  setTimeout(conectar, 3000);
}

// ── WHATSAPP ──────────────────────────────────────────────────────────────────
var isConnecting = false; // evita instâncias duplas de conexão

// ── CONEXÃO PERMANENTE ───────────────────────────────────────────────────────
// O servidor mantém conexão ativa para monitorar mensagens dos grupos.
// O health timer cuida de reconexão em caso de queda real.
// O inactivity timer foi removido — ele desconectava o sock a cada 5 min e
// fazia o servidor perder todas as mensagens dos grupos monitorados.
let inactivityTimer = null; // mantido por compatibilidade (não usado)

function resetarInactivityTimer() {
  // Conexão permanente — não desconecta por inatividade.
}

// Garante que sock está pronto; usa iniciarConexao() para evitar instâncias duplas.
async function conectarSeNecessario() {
  if (conectado && sock) return true;
  return await aguardarSock(20000);
}

// Backoff exponencial para reconexões: evita hammering no WhatsApp
let _reconectarTentativas = 0;
let _erros500Consecutivos = 0;

function _delayReconexao(codigo) {
  if (codigo === 440) {
    _reconectarTentativas++;
    _erros500Consecutivos = 0;
    const delay = Math.min(15000 * _reconectarTentativas, 60000);
    console.log('[WA] Connection Replaced (440). Reconectando em ' + (delay/1000) + 's (tentativa ' + _reconectarTentativas + ')...');
    return delay;
  }
  if (codigo === 500) {
    _erros500Consecutivos++;
    if (_erros500Consecutivos >= 3) {
      // 3 erros 500 consecutivos = sessão corrompida. Limpa e reconecta do zero.
      _erros500Consecutivos = 0;
      _reconectarTentativas = 0;
      console.log('[WA] 3 erros 500 consecutivos — limpando sessão corrompida...');
      limparSessaoEReconectar();
      return -1; // sinaliza que já foi tratado
    }
  } else {
    _erros500Consecutivos = 0;
  }
  _reconectarTentativas++;
  const delay = Math.min(5000 * Math.pow(2, _reconectarTentativas - 1), 60000);
  console.log('[WA] Erro (código ' + codigo + '). Reconectando em ' + (delay/1000) + 's...');
  return delay;
}

async function conectar() {
  if (isConnecting) {
    console.log('[WA] Conexão já em andamento, ignorando chamada duplicada.');
    return;
  }
  isConnecting = true;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(SESSAO_DIR);
    const { version }          = await fetchLatestBaileysVersion();
    const novaSock = makeWASocket({
      version,
      auth: state,
      logger: baileysLogger,
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: true,
      getMessage: async () => undefined,
      // Keepalive agressivo para detectar quedas mais rápido
      keepAliveIntervalMs: 30000,
    });
    sock = novaSock;
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) { qrAtual = await QRCode.toDataURL(qr); }
      if (connection === 'open') {
        conectado = true;
        qrAtual = null;
        errosDescripto = 0;
        isConnecting = false;
        _reconectarTentativas = 0;
        _erros500Consecutivos = 0;
        resetarHealthTimer();
        console.log('[WA] ✓ WhatsApp conectado!');
      }
      if (connection === 'close') {
        // Ignora eventos de sock antigo (pode acontecer durante troca de instância)
        if (novaSock !== sock && sock !== null) {
          console.log('[WA] Evento de fechamento de sock antigo ignorado.');
          return;
        }
        conectado = false;
        isConnecting = false;
        sock = null;

        clearTimeout(inactivityTimer);
        if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
        const codigo = new Boom(lastDisconnect?.error)?.output?.statusCode;
        console.log('[WA] Conexão fechada. Código:', codigo);
        if (codigo === DisconnectReason.loggedOut) {
          console.log('[WA] Logout detectado. Escaneie o QR novamente em /qr');
          _reconectarTentativas = 0;
          // NÃO reconecta automaticamente
        } else {
          const delay = _delayReconexao(codigo);
          if (delay >= 0) setTimeout(conectar, delay);
        }
      }
    });
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (conectado) resetarHealthTimer();
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (msg.messageStubType === 2 || (msg.message === null && !msg.key.fromMe)) {
          errosDescripto++;
          if (errosDescripto >= ERROS_DESCR_MAX) { await limparSessaoEReconectar(); return; }
          continue;
        }
        // Enfileira por grupo: mesmo grupo = sequencial, grupos distintos = paralelo
        const jid = msg.key?.remoteJid;
        if (jid) {
          enfileirarPorGrupo(jid, () => processarMensagem(msg));
        } else {
          await processarMensagem(msg);
        }
      }
    });
    resetarHealthTimer();
  } catch (err) {
    console.error('[WA] Erro ao inicializar socket:', err.message);
    isConnecting = false;

    const delay = _delayReconexao(null);
    setTimeout(conectar, delay);
  }
}

// ── CSS DO PAINEL ─────────────────────────────────────────────────────────────
const PAINEL_CSS = `*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#0d0d0d;color:#f0f0f0;min-height:100vh}header{background:#111;border-bottom:1px solid #222;padding:16px 24px;display:flex;align-items:center;justify-content:space-between}header h1{font-size:18px;color:#ffa500}header .nav a{color:#aaa;text-decoration:none;margin-left:16px;font-size:14px}header .nav a:hover{color:#ffa500}.container{max-width:960px;margin:0 auto;padding:24px 16px}.badge{background:#ffa500;color:#000;font-size:11px;font-weight:700;padding:2px 7px;border-radius:10px;margin-left:6px}.empty{text-align:center;color:#555;padding:60px 0;font-size:15px}.card{background:#161616;border:1px solid #222;border-radius:12px;margin-bottom:16px;overflow:hidden}.card-header{padding:12px 16px;background:#1a1a1a;border-bottom:1px solid #222;display:flex;align-items:center;gap:8px;font-size:13px;color:#aaa;flex-wrap:wrap}.card-header .id{color:#ffa500;font-weight:700;font-size:14px}.tag{background:#252525;padding:2px 8px;border-radius:6px;font-size:11px}.tag-iv{background:#1a2e1a;color:#22c55e}.tag-ida{background:#1a1f2e;color:#60a5fa}.tag-exec{background:#2e1a2e;color:#c084fc}.tag-eco{background:#1a2020;color:#67e8f9}.tag-tsp{background:#2e1a00;color:#ffa500}.card-body{display:grid;grid-template-columns:1fr 1fr}.col{padding:16px}.col+.col{border-left:1px solid #222}.col-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#444;margin-bottom:10px}.imgs-grid{display:flex;flex-wrap:wrap;gap:8px}.imgs-grid img{width:calc(50% - 4px);min-width:120px;border-radius:8px;object-fit:cover}.imgs-grid img:only-child{width:100%}.texto-orig{font-size:13px;color:#888;white-space:pre-wrap;word-break:break-word;margin-top:8px}.edit-area{width:100%;background:#0d0d0d;color:#f0f0f0;border:1px solid #2a2a2a;border-radius:8px;padding:12px;font-size:13px;font-family:inherit;line-height:1.7;resize:vertical;min-height:200px}.edit-area:focus{outline:none;border-color:#444}.card-footer{padding:12px 16px;border-top:1px solid #1a1a1a;display:flex;gap:10px;align-items:center;flex-wrap:wrap}.btn{padding:8px 20px;border-radius:8px;border:none;font-size:13px;font-weight:600;cursor:pointer;transition:opacity .15s}.btn:hover{opacity:.8}.btn-ap{background:#22c55e;color:#000}.btn-rej{background:#333;color:#aaa}.ok-ap{color:#22c55e;font-size:13px}.ok-rej{color:#555;font-size:13px}.buffer-bar{background:#1a1400;border:1px solid #3a2e00;border-radius:8px;padding:10px 16px;font-size:13px;color:#ffa500;margin-bottom:16px}.sep{color:#333;font-size:12px;text-transform:uppercase;letter-spacing:1px;margin:28px 0 12px}.tg-bar{background:#0d1a2e;border:1px solid #1a3a5e;border-radius:8px;padding:10px 16px;font-size:13px;margin-bottom:16px;display:flex;align-items:center;gap:8px}.tg-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}.tg-dot-on{background:#22c55e}.tg-dot-off{background:#555}.tg-dot-wait{background:#ffa500}@media(max-width:600px){.card-body{grid-template-columns:1fr}.col+.col{border-left:none;border-top:1px solid #1a1a1a}.imgs-grid img{width:100%}}`;

// ── ROTAS ─────────────────────────────────────────────────────────────────────

app.get('/tg-auth', (req, res) => {
  const estado = tgAuthState;
  const conectadoTg = tgConectado;

  if (conectadoTg) {
    return res.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Telegram Auth</title><style>body{font-family:sans-serif;background:#0d0d0d;color:#f0f0f0;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;gap:16px}h2{color:#22c55e}a{color:#ffa500}</style></head><body><h2>✅ Telegram conectado!</h2><p>Monitorando ${TG_CANAIS_MONITORADOS.map(c=>'@'+c).join(', ')}</p><a href="/painel">Ir para o painel</a></body></html>`);
  }

  const labels = {
    'aguardando_telefone': { titulo: 'Digite seu número do Telegram', placeholder: '+5511999999999', campo: 'telefone' },
    'aguardando_codigo':   { titulo: 'Digite o código de verificação', placeholder: '12345', campo: 'codigo' },
    'aguardando_senha':    { titulo: 'Digite sua senha do Telegram (2FA)', placeholder: 'sua senha', campo: 'senha' },
    'erro':                { titulo: 'Erro na autenticação', placeholder: '', campo: '' },
  };

  const info = labels[estado] || { titulo: 'Aguardando...', placeholder: '', campo: '' };

  res.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Telegram Auth</title>
<style>body{font-family:-apple-system,sans-serif;background:#0d0d0d;color:#f0f0f0;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;gap:20px;padding:24px}h2{color:#ffa500;font-size:20px}input{background:#1a1a1a;border:1px solid #333;border-radius:8px;color:#f0f0f0;font-size:16px;padding:12px 16px;width:280px;outline:none}input:focus{border-color:#ffa500}button{background:#ffa500;color:#000;border:none;border-radius:8px;font-size:15px;font-weight:700;padding:12px 32px;cursor:pointer}p{color:#888;font-size:14px;text-align:center;max-width:300px}.ok{color:#22c55e}.err{color:#ef4444}</style></head>
<body>
<h2>🔐 Autenticação Telegram</h2>
<p>${info.titulo}</p>
${info.campo ? `<input type="text" id="val" placeholder="${info.placeholder}" autocomplete="off"/>
<button onclick="enviar()">Confirmar</button>
<p id="msg"></p>
<script>
async function enviar(){
  const v = document.getElementById('val').value.trim();
  if(!v) return;
  const r = await fetch('/tg-auth/submit', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({valor: v, campo: '${info.campo}'})});
  const d = await r.json();
  const m = document.getElementById('msg');
  if(d.ok){ m.className='ok'; m.textContent='✓ Enviado! Aguardando próximo passo...'; setTimeout(()=>location.reload(), 2000); }
  else { m.className='err'; m.textContent='Erro: '+d.erro; }
}
document.getElementById('val').addEventListener('keydown', e => { if(e.key==='Enter') enviar(); });
</script>` : `<p class="${estado === 'erro' ? 'err' : ''}">${estado === 'erro' ? 'Ocorreu um erro. Verifique os logs do servidor.' : 'Inicializando conexão com o Telegram...'}</p><script>setTimeout(()=>location.reload(), 3000)</script>`}
</body></html>`);
});

app.post('/tg-auth/submit', (req, res) => {
  const { valor } = req.body;
  if (!valor?.trim()) return res.status(400).json({ ok:false, erro:'Valor vazio.' });
  if (!tgAuthResolve) return res.status(400).json({ ok:false, erro:'Nenhuma autenticação em andamento.' });
  tgAuthResolve(valor.trim());
  tgAuthResolve = null;
  tgAuthReject  = null;
  res.json({ ok:true });
});

app.get('/', (req, res) => {
  const pendentes = filaPendentes.filter(o => o.status==='pendente').length;
  const emBuffer  = [...bufferAgrupamento.values()].reduce((s,e) => s+e.itens.length, 0);
  const statusWA  = conectado ? 'WhatsApp conectado' : qrAtual ? 'Aguardando QR' : 'Desconectado';
  const statusTG  = tgConectado ? 'Telegram conectado' : 'Telegram desconectado';
  res.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>CDV Server</title><style>body{font-family:sans-serif;background:#0d0d0d;color:#f0f0f0;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;gap:16px;margin:0}h1{color:#ffa500}p{color:#aaa;font-size:14px}.links{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;margin-top:8px}a{color:#ffa500;text-decoration:none;border:1px solid #333;padding:9px 20px;border-radius:8px;font-size:14px}a:hover{border-color:#ffa500}</style></head><body><h1>CDV Baileys Server</h1><p>${statusWA}</p><p>${statusTG}</p>${emBuffer>0?'<p>'+emBuffer+' item(ns) na janela</p>':''}<div class="links">${!conectado?'<a href="/qr">Escanear QR WhatsApp</a>':''}${!tgConectado?'<a href="/tg-auth">Conectar Telegram</a>':''}<a href="/painel">Painel${pendentes>0?' ('+pendentes+')':''}</a><a href="/status">Status</a><a href="/grupos">Grupos</a></div></body></html>`);
});

app.get('/qr', (req, res) => {
  if (conectado) return res.send('<html><body style="background:#0d0d0d;color:#ffa500;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:16px"><h2>WhatsApp ja conectado!</h2><a href="/" style="color:#ffa500">Voltar</a></body></html>');
  // Dispara conexão se ainda não estiver conectando (modo lazy)
  if (!isConnecting && !sock) iniciarConexao();
  if (!qrAtual)  return res.send('<html><head><meta http-equiv="refresh" content="3"></head><body style="background:#0d0d0d;color:#f0f0f0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh"><h2>Gerando QR...</h2></body></html>');
  res.send('<html><head><title>QR</title><meta http-equiv="refresh" content="30"><style>body{background:#0d0d0d;color:#f0f0f0;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;gap:16px;margin:0}h2{color:#ffa500}img{border:4px solid #ffa500;border-radius:12px;width:260px}p{color:#aaa;font-size:.9rem;text-align:center}</style></head><body><h2>Escanear QR Code</h2><img src="'+qrAtual+'" alt="QR"/><p>WhatsApp - Dispositivos conectados - Conectar dispositivo</p></body></html>');
});

app.post('/reconectar', async (req, res) => {
  console.log('[MANUAL] Reconexão forçada via /reconectar');
  conectado = false;
  isConnecting = false;
  _reconectarTentativas = 0;

  const sockRef = sock;
  sock = null;
  if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
  if (sockRef) { try { sockRef.end(new Error('manual-reconnect')); } catch(e) {} }
  setTimeout(conectar, 1000);
  res.json({ ok: true, mensagem: 'Reconectando... aguarde 10s e verifique /status' });
});

app.get('/debug-fila', (req, res) => {
  try {
    const raw = readFileSync(FILA_PATH, 'utf-8');
    const dados = JSON.parse(raw);
    res.json({ total: dados.length, itens: dados });
  } catch(e) {
    res.json({ erro: e.message });
  }
});

app.get('/status', (req, res) => {
  const emBuffer = [...bufferAgrupamento.values()].reduce((s,e) => s+e.itens.length, 0);
  res.json({ conectado, sockAtivo:!!sock, qrDisponivel:!!qrAtual, telegramConectado:tgConectado, telegramAuthState:tgAuthState, telegramGrupos:TG_CANAIS_MONITORADOS, grupos:Object.keys(GRUPOS), gruposMonitorados:GRUPOS_MONITORADOS, bufferAtivo:emBuffer, filaPendentes:filaPendentes.filter(o=>o.status==='pendente').length, filaTotal:filaPendentes.length, reconectarTentativas:_reconectarTentativas, conexaoEmAndamento:!!_conexaoPromise });
});

app.get('/fila-envio', (req, res) => {
  const itens = filaEnvio.map((item, idx) => ({
    posicao:  idx + 1,
    ofertaId: item.ofertaId,
    destino:  item.destino,
    preview:  item.mensagem.substring(0, 80) + (item.mensagem.length > 80 ? '...' : ''),
  }));
  const espera = msAteJanela();
  const horaSP_ = horaSP();
  res.json({
    total:         filaEnvio.length,
    workerAtivo:   workerRodando,
    dentroJanela:  espera === 0,
    horaSP:        horaSP_,
    janelaEnvio:   `${HORA_INICIO_ENVIO}h–${HORA_FIM_ENVIO}h SP`,
    msAteJanela:   espera,
    intervaloMinutos: INTERVALO_ENVIO_MS / 60000,
    itens,
  });
});

app.delete('/fila-envio/:ofertaId', (req, res) => {
  const id = req.params.ofertaId;
  const idx = filaEnvio.findIndex(i => String(i.ofertaId) === String(id));
  if (idx === -1) return res.status(404).json({ ok: false, erro: 'Item não encontrado na fila' });
  filaEnvio.splice(idx, 1);
  console.log('[FILA] Item #' + id + ' removido manualmente da fila. Restam ' + filaEnvio.length);
  res.json({ ok: true, removido: id, total: filaEnvio.length });
});

app.delete('/fila-envio', (req, res) => {
  const total = filaEnvio.length;
  filaEnvio.splice(0, filaEnvio.length);
  console.log('[FILA] Fila de envio limpa manualmente. ' + total + ' itens removidos.');
  res.json({ ok: true, removidos: total });
});

app.post('/fila-envio/marcar-enviado/:ofertaId', (req, res) => {
  const id = req.params.ofertaId;
  const oferta = filaPendentes.find(o => String(o.id) === String(id));
  if (!oferta) return res.status(404).json({ ok: false, erro: 'Oferta #' + id + ' não encontrada' });
  oferta.status = 'enviado';
  salvarFila();
  console.log('[FILA] Oferta #' + id + ' marcada como enviado manualmente.');
  res.json({ ok: true, id, statusAnterior: oferta.status });
});

app.post('/fila-envio/marcar-todas-enviado', (req, res) => {
  const aprovadas = filaPendentes.filter(o => o.status === 'aprovado');
  aprovadas.forEach(o => { o.status = 'enviado'; });
  salvarFila();
  console.log('[FILA] ' + aprovadas.length + ' oferta(s) marcada(s) como enviado manualmente.');
  res.json({ ok: true, marcadas: aprovadas.length, ids: aprovadas.map(o => o.id) });
});

app.get('/painel', (req, res) => {
  const pendentes   = filaPendentes.filter(o => o.status==='pendente');
  const processados = filaPendentes.filter(o => o.status!=='pendente');
  const emBuffer    = [...bufferAgrupamento.values()].reduce((s,e) => s+e.itens.length, 0);

  const tgStatusDot = tgConectado ? 'tg-dot-on' : (tgAuthState && tgAuthState !== 'ok' && tgAuthState !== 'erro' ? 'tg-dot-wait' : 'tg-dot-off');
  const tgStatusTxt = tgConectado ? `Telegram conectado — monitorando ${TG_CANAIS_MONITORADOS.map(c=>'@'+c).join(', ')}` : (tgAuthState === 'aguardando_telefone' || tgAuthState === 'aguardando_codigo' || tgAuthState === 'aguardando_senha' ? `Telegram aguardando autenticação — <a href="/tg-auth" style="color:#ffa500">clique aqui para autenticar</a>` : `Telegram desconectado — <a href="/tg-auth" style="color:#ffa500">conectar</a>`);

  const renderCard = (o) => {
    const data = new Date(o.timestamp).toLocaleString('pt-BR');
    const d    = o.dadosExtraidos || {};
    const isTSP = o.tipoConteudo === 'cupom_tsp';

    if (isTSP) {
      const loja  = d.loja || '';
      const valor = d.valor || '';
      const tipo  = d.tipo === 'pct' ? '%' : ' R$';
      const cod   = d.codigo ? `<span class="tag">${d.codigo}</span>` : '';
      const textoHtml = o.conteudoOriginal ? `<div class="texto-orig">${o.conteudoOriginal}</div>` : '';
      if (o.status==='aprovado'||o.status==='enviado')  return `<div class="card"><div class="card-header"><span class="id">#${o.id}</span><span class="tag tag-tsp">📦 Cupom TSP</span><span style="color:#f0f0f0;font-weight:600">${loja} ${valor}${tipo}</span>${cod}<span style="margin-left:auto">${data}</span></div><div style="padding:12px 16px"><span class="ok-ap">${o.status==='enviado'?'✓ Enviado':'Aprovado e enviado'}</span></div></div>`;
      if (o.status==='agendado') return `<div class="card"><div class="card-header"><span class="id">#${o.id}</span><span class="tag tag-tsp">📦 Cupom TSP</span><span style="color:#f0f0f0;font-weight:600">${loja} ${valor}${tipo}</span>${cod}<span style="margin-left:auto">${data}</span></div><div style="padding:12px 16px"><span class="ok-ap">📅 Agendado</span></div></div>`;
      if (o.status==='rejeitado') return `<div class="card"><div class="card-header"><span class="id">#${o.id}</span><span class="tag tag-tsp">📦 Cupom TSP</span><span style="color:#f0f0f0;font-weight:600">${loja} ${valor}${tipo}</span>${cod}<span style="margin-left:auto">${data}</span></div><div style="padding:12px 16px"><span class="ok-rej">Rejeitado</span></div></div>`;
      return `<div class="card" id="card-${o.id}"><div class="card-header"><span class="id">#${o.id}</span><span class="tag tag-tsp">📦 Cupom TSP</span><span style="color:#f0f0f0;font-weight:600">${loja} ${valor}${tipo}</span>${cod}<span style="font-size:12px;color:#555;margin-left:auto">${data}</span></div><div class="card-body"><div class="col"><div class="col-title">Original (Telegram)</div>${textoHtml}</div><div class="col"><div class="col-title">Mensagem formatada</div><textarea class="edit-area" id="msg-${o.id}">${o.mensagemFormatada}</textarea></div></div><div class="card-footer"><button class="btn btn-ap" onclick="aprovar(${o.id})">Aprovar e enviar</button><button class="btn btn-rej" onclick="rejeitar(${o.id})">Rejeitar</button><span id="fb-${o.id}" style="font-size:13px;margin-left:auto"></span></div></div>`;
    }

    const tipoTag   = d.tipo==='ida_volta'?'<span class="tag tag-iv">Ida e volta</span>':d.tipo==='ida'?'<span class="tag tag-ida">Somente ida</span>':'';
    const cabineTag = d.cabine==='Executiva'?'<span class="tag tag-exec">Executiva</span>':'<span class="tag tag-eco">Economica</span>';
    const rota = d.origem&&d.destino?`<span style="color:#f0f0f0;font-weight:600">${d.origem} - ${d.destino}</span>`:'';
    const prog = d.programa?`<span class="tag">${d.programa}</span>`:'';
    const imgsHtml = (o.imagens||[]).length>0?'<div class="imgs-grid">'+(o.imagens.map(b=>'<img src="data:image/jpeg;base64,'+b+'" />')).join('')+'</div>':'';
    const textoHtml = o.conteudoOriginal?`<div class="texto-orig">${typeof o.conteudoOriginal === 'string' ? o.conteudoOriginal : o.conteudoOriginal.join?.('\n') || ''}</div>`:'';
    if (o.status==='aprovado'||o.status==='enviado')  return `<div class="card"><div class="card-header"><span class="id">#${o.id}</span>${rota}${tipoTag}${cabineTag}<span style="margin-left:auto">${data}</span></div><div style="padding:12px 16px"><span class="ok-ap">${o.status==='enviado'?'✓ Enviado':'Aprovado — na fila de envio'}</span></div></div>`;
    if (o.status==='agendado')  return `<div class="card"><div class="card-header"><span class="id">#${o.id}</span>${rota}${tipoTag}${cabineTag}<span style="margin-left:auto">${data}</span></div><div style="padding:12px 16px"><span class="ok-ap">📅 Agendado</span></div></div>`;
    if (o.status==='rejeitado') return `<div class="card"><div class="card-header"><span class="id">#${o.id}</span>${rota}${tipoTag}${cabineTag}<span style="margin-left:auto">${data}</span></div><div style="padding:12px 16px"><span class="ok-rej">Rejeitado</span></div></div>`;
    return `<div class="card" id="card-${o.id}"><div class="card-header"><span class="id">#${o.id}</span>${rota}${tipoTag}${cabineTag}${prog}<span style="margin-left:auto;font-size:12px;color:#555">${data}</span></div><div class="card-body"><div class="col"><div class="col-title">Original (${o.tipoConteudo})</div>${imgsHtml}${textoHtml}</div><div class="col"><div class="col-title">Mensagem formatada</div><textarea class="edit-area" id="msg-${o.id}">${o.mensagemFormatada}</textarea></div></div><div class="card-footer"><button class="btn btn-ap" onclick="aprovar(${o.id})">Aprovar e enviar</button><button class="btn btn-rej" onclick="rejeitar(${o.id})">Rejeitar</button><span id="fb-${o.id}" style="font-size:13px;margin-left:auto"></span></div></div>`;
  };

  res.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Painel CDV</title><style>${PAINEL_CSS}</style></head><body><header><h1>Painel${pendentes.length>0?' <span class="badge">'+pendentes.length+'</span>':''}</h1><nav class="nav"><a href="/">Inicio</a><a href="/painel">Atualizar</a></nav></header><div class="container"><div class="tg-bar"><div class="tg-dot ${tgStatusDot}"></div><span>${tgStatusTxt}</span></div>${emBuffer>0?'<div class="buffer-bar">'+emBuffer+' item(ns) aguardando janela de '+JANELA_AGRUPAMENTO_MS/60000+' min...</div>':''}${pendentes.length===0&&emBuffer===0?'<div class="empty">Nenhuma oferta pendente.</div>':pendentes.map(renderCard).join('')}${processados.length>0?'<div class="sep">Processados recentemente</div>'+processados.slice(0,10).map(renderCard).join(''):''}</div><script>async function aprovar(id){const msg=document.getElementById("msg-"+id).value;const fb=document.getElementById("fb-"+id);fb.textContent="Enviando...";fb.style.color="#aaa";const r=await fetch("/painel/aprovar/"+id,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({mensagem:msg})});const d=await r.json();if(d.ok){fb.style.color="#22c55e";fb.textContent="Enviado!";setTimeout(()=>{const c=document.getElementById("card-"+id);if(c)c.style.opacity=".35"},800)}else{fb.style.color="#ef4444";fb.textContent="Erro: "+d.erro}}async function rejeitar(id){const fb=document.getElementById("fb-"+id);const r=await fetch("/painel/rejeitar/"+id,{method:"POST"});const d=await r.json();if(d.ok){fb.style.color="#555";fb.textContent="Rejeitado";setTimeout(()=>{const c=document.getElementById("card-"+id);if(c)c.style.opacity=".35"},400)}}${emBuffer>0?'setTimeout(()=>location.reload(),30000);':''}</script></body></html>`);
});

app.post('/api/claude', async (req, res) => {
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', { method:'POST', headers:{ 'Content-Type':'application/json', 'x-api-key':process.env.ANTHROPIC_API_KEY, 'anthropic-version':'2023-06-01' }, body:JSON.stringify(req.body) });
    res.json(await resp.json());
  } catch(e) { res.status(500).json({ error:{ message:e.message } }); }
});

app.get('/painel-json', (req, res) => {
  try {
    const emBuffer = [...bufferAgrupamento.values()].reduce((s,e) => s+e.itens.length, 0);
    const ofertas = filaPendentes.slice(0,50).map(o => ({ ...o, conteudoOriginal: typeof o.conteudoOriginal==='string'?o.conteudoOriginal:(Array.isArray(o.conteudoOriginal)?o.conteudoOriginal.join('\n'):''), imagens:Array.isArray(o.imagens)?o.imagens:[] }));
    res.json({ ok:true, bufferAtivo:emBuffer, ofertas });
  } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
});

app.post('/painel/aprovar/:id', async (req, res) => {
  const id     = parseInt(req.params.id);
  const oferta = filaPendentes.find(o => String(o.id)===String(id));
  if (!oferta) return res.status(404).json({ ok:false, erro:'Oferta nao encontrada.' });
  if (!conectado || !sock) {
    const ok = await aguardarSock();
    if (!ok) return res.status(503).json({ ok:false, erro:'WhatsApp nao conectado.' });
  }
  const mensagem  = req.body.mensagem || oferta.mensagemFormatada;
  const agendarEm = req.body.agendarEm || null;

  if (agendarEm) {
    const dispararEm = new Date(agendarEm).getTime();
    if (isNaN(dispararEm)) return res.status(400).json({ ok:false, erro:'Data inválida.' });
    const agId = gerarId();
    agendamentos.push({ id:agId, grupo:'cdv_emissao', mensagem, dispararEm, status:'aguardando', criadoEm:new Date().toISOString() });
    salvarAgendamentos();
    oferta.status = 'agendado'; oferta.mensagemFinal = mensagem; salvarFila();
    const horario = new Intl.DateTimeFormat('pt-BR',{timeZone:TZ_SP,dateStyle:'short',timeStyle:'short'}).format(new Date(dispararEm));
    return res.json({ ok:true, agendado:true, horario });
  }

  if (oferta.tipoConteudo === 'cupom_tsp') {
    try {
      const imagem = oferta.imagens?.[0];
      if (imagem?.imagemBase64) {
        await enviarMensagem(GRUPOS['tsp'], {
          image: Buffer.from(imagem.imagemBase64, 'base64'),
          caption: mensagem,
          mimetype: imagem.mime || 'image/jpeg',
        });
      } else {
        await enviarMensagem(GRUPOS['tsp'], { text: mensagem });
      }
      oferta.status = 'enviado'; oferta.mensagemFinal = mensagem; salvarFila();
      res.json({ ok:true });
    } catch(err) { res.status(500).json({ ok:false, erro: err.message }); }
    return;
  }

  const info = calcularPosicaoFila(filaEnvio.length);
  oferta.status = 'aprovado'; oferta.mensagemFinal = mensagem; salvarFila();
  enfileirarEnvio(oferta.id, mensagem, GRUPOS[GRUPO_DESTINO_PASSAGENS]);
  res.json({ ok:true, posicao:info.posicao, tempoMin:info.tempoMin, horario:info.horario });
});

app.get('/agendamentos', (req, res) => {
  res.json({ ok:true, agendamentos: agendamentos.filter(a => a.status === 'aguardando') });
});

app.delete('/agendamentos/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = agendamentos.findIndex(a => a.id === id);
  if (idx === -1) return res.status(404).json({ ok:false, erro:'Agendamento não encontrado.' });
  agendamentos[idx].status = 'cancelado';
  salvarAgendamentos();
  res.json({ ok:true });
});

app.post('/painel/rejeitar/:id', (req, res) => {
  const id     = parseInt(req.params.id);
  const oferta = filaPendentes.find(o => String(o.id)===String(id));
  if (!oferta) return res.status(404).json({ ok:false, erro:'Oferta nao encontrada.' });
  oferta.status = 'rejeitado';
  salvarFila();
  res.json({ ok:true });
});

app.post('/painel/reprocessar/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const oferta = filaPendentes.find(o => String(o.id)===String(id) && o.status==='pendente');
  if (!oferta) return res.status(404).json({ ok:false, erro:'Oferta não encontrada.' });
  try {
    const itens = [];
    for (const imgB64 of (oferta.imagens||[])) itens.push({ texto:oferta.conteudoOriginal||'', imagemBase64:imgB64, timestamp:Date.now() });
    if (itens.length===0 && oferta.conteudoOriginal) itens.push({ texto:oferta.conteudoOriginal, imagemBase64:null, timestamp:Date.now() });
    if (itens.length===0) return res.status(400).json({ ok:false, erro:'Sem conteúdo para reprocessar.' });
    const classificacoes = await classificarItens(itens, oferta.grupoOrigem||'');
    const validas = classificacoes.filter(c => c.valido);
    if (validas.length===0) return res.json({ ok:false, erro:'Nenhuma emissão válida encontrada.' });
    const emissoes = await agruparEFormatar(classificacoes);
    if (emissoes.length===0) return res.json({ ok:false, erro:'Agrupamento retornou 0 emissões.' });
    oferta.mensagemFormatada = emissoes[0].mensagem;
    oferta.dadosExtraidos    = emissoes[0];
    oferta.timestamp         = new Date().toISOString();
    salvarFila();
    res.json({ ok:true, mensagemFormatada:oferta.mensagemFormatada });
  } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
});

app.post('/painel/mesclar', (req, res) => {
  const { id1, id2 } = req.body;
  if (!id1||!id2) return res.status(400).json({ ok:false, erro:'ids necessarios.' });
  const o1 = filaPendentes.find(o => String(o.id)===String(id1)&&o.status==='pendente');
  const o2 = filaPendentes.find(o => String(o.id)===String(id2)&&o.status==='pendente');
  if (!o1||!o2) return res.status(404).json({ ok:false, erro:'Uma ou ambas não encontradas.' });
  const toArray = v => Array.isArray(v)?v:(v?[v]:[]);
  o1.conteudoOriginal  = [...toArray(o1.conteudoOriginal),...toArray(o2.conteudoOriginal)];
  o1.imagens           = [...(o1.imagens||[]),...(o2.imagens||[])];
  o1.mensagemFormatada = (o1.mensagemFormatada||'').trim()+'\n\n'+(o2.mensagemFormatada||'').trim();
  o1.tipoConteudo      = 'mesclado';
  o1.timestamp         = new Date().toISOString();
  o2.status = 'mesclado';
  salvarFila();
  res.json({ ok:true, id:o1.id, mensagemMesclada:o1.mensagemFormatada });
});

app.post('/painel/limpar', (req, res) => {
  const { confirmar } = req.body;
  if (confirmar!=='sim') return res.status(400).json({ ok:false, erro:'Envie { "confirmar": "sim" } para confirmar.' });
  filaPendentes.forEach(o => { if (o.status==='pendente') o.status='rejeitado'; });
  salvarFila();
  res.json({ ok:true });
});

app.post('/injetar', async (req, res) => {
  const { texto } = req.body;
  if (!texto?.trim()) return res.status(400).json({ ok:false, erro:'Texto vazio.' });
  // Cada injeção manual recebe seu PRÓPRIO grupo (id único) e é processada
  // isoladamente. Assim 1 injeção = 1 oferta: não há janela de 3 min
  // compartilhada (que quebrava as injeções em lotes conforme o tempo) nem
  // risco de o agrupamento por IA fundir rotas diferentes enviadas em sequência.
  const grupoFake = 'injecao_manual_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const entrada = { itens: [], timer: null };
  bufferAgrupamento.set(grupoFake, entrada);
  entrada.itens.push({ texto: texto.trim(), imagemBase64: null, timestamp: Date.now() });
  // Pequeno atraso só para a resposta HTTP retornar antes do processamento.
  entrada.timer = setTimeout(() => processarBuffer(grupoFake), 1500);
  res.json({ ok: true, grupo: grupoFake, bufferItens: entrada.itens.length });
});

app.post('/enviar', async (req, res) => {
  const { grupo, mensagem, agendarEm } = req.body;

  // Se sock nulo mas server está tentando reconectar, aguarda até 15s
  if (!conectado || !sock) {
    const ok = await aguardarSock(15000);
    if (!ok) return res.status(503).json({ ok:false, erro:'WhatsApp nao conectado. Acesse /qr para reconectar.' });
  }
  const grupoId = resolverGrupo(grupo);
  if (!grupoId) return res.status(400).json({ ok:false, erro:'Grupo invalido: '+grupo });
  if (!mensagem?.trim()) return res.status(400).json({ ok:false, erro:'Mensagem vazia.' });

  if (agendarEm) {
    const dispararEm = new Date(agendarEm).getTime();
    if (isNaN(dispararEm)) return res.status(400).json({ ok:false, erro:'Data inválida.' });
    const id = gerarId();
    agendamentos.push({ id, grupo, mensagem, dispararEm, status:'aguardando', criadoEm: new Date().toISOString() });
    salvarAgendamentos();
    const horario = new Intl.DateTimeFormat('pt-BR',{timeZone:TZ_SP,dateStyle:'short',timeStyle:'short'}).format(new Date(dispararEm));
    return res.json({ ok:true, agendado:true, id, horario });
  }

  const isEmissao = grupo==='cdv_emissao'||grupoId===GRUPOS['cdv_emissao'];
  if (isEmissao) {
    // Comprime datas consecutivas antes de enfileirar (ex: 1, 2, 3, 4 → 1-4)
    const mensagemComprimida = mensagem
      .split('\n')
      .map(linha => {
        const m = linha.match(/^([A-Za-záàãâéêíóôõúüçÁÀÃÂÉÊÍÓÔÕÚÜÇ]+\/\d{2}:)\s*(.+)$/);
        if (!m) return linha;
        const dias = m[2].match(/\d+/g);
        if (!dias || dias.length <= 2) return linha;
        const nums = dias.map(Number);
        return m[1] + ' ' + comprimirSequencia(nums);
      })
      .join('\n');
    const info = calcularPosicaoFila(filaEnvio.length);
    enfileirarEnvio('manual', mensagemComprimida, grupoId);
    res.json({ ok:true, posicao:info.posicao, tempoMin:info.tempoMin, horario:info.horario });
  } else {
    try { await enviarMensagem(grupoId, { text:mensagem }); res.json({ ok:true }); }
    catch(err) { res.status(500).json({ ok:false, erro:err.message }); }
  }
});

app.post('/enviar-imagem', upload.single('imagem'), async (req, res) => {
  const { grupo, legenda } = req.body;
  const file = req.file;
  if (!conectado || !sock) {
    const ok = await aguardarSock(15000);
    if (!ok) { if(file) unlinkSync(file.path); return res.status(503).json({ ok:false, erro:'WhatsApp nao conectado.' }); }
  }
  const grupoId = resolverGrupo(grupo);
  if (!grupoId) { if(file) unlinkSync(file.path); return res.status(400).json({ ok:false, erro:'Grupo invalido.' }); }
  if (!file) return res.status(400).json({ ok:false, erro:'Imagem obrigatoria.' });
  try {
    const buffer = readFileSync(file.path);
    await enviarMensagem(grupoId, { image:buffer, caption:legenda||'' });
    res.json({ ok:true });
  } catch(err) { res.status(500).json({ ok:false, erro:err.message }); }
  finally { if(existsSync(file.path)) unlinkSync(file.path); }
});

// ── ENVIAR ÁUDIO / VOICEMAIL ──────────────────────────────────────────────────
// Aceita upload de arquivo de áudio (ogg, mp4, m4a, mp3, etc) via multipart
// e envia como mensagem de voz (PTT = push-to-talk) no grupo indicado.
app.post('/enviar-audio', upload.single('audio'), async (req, res) => {
  const { grupo } = req.body;
  const file = req.file;
  if (!file) return res.status(400).json({ ok:false, erro:'Arquivo de áudio obrigatório (campo: audio).' });

  // Conecta sob demanda antes de tentar enviar
  const ok = await aguardarSock(20000);
  if (!ok) {
    if (existsSync(file.path)) unlinkSync(file.path);
    return res.status(503).json({ ok:false, erro:'WhatsApp não conectado. Tente novamente em instantes.' });
  }

  const grupoId = resolverGrupo(grupo || 'cdv_ofertas');
  if (!grupoId) {
    if (existsSync(file.path)) unlinkSync(file.path);
    return res.status(400).json({ ok:false, erro:'Grupo inválido: ' + grupo });
  }

  try {
    const buffer   = readFileSync(file.path);
    const mimetype = file.mimetype || 'audio/ogg; codecs=opus';
    await enviarMensagem(grupoId, {
      audio:    buffer,
      mimetype: mimetype,
      ptt:      true,
    });
    console.log('[AUDIO] Áudio enviado para ' + grupoId + ' (' + buffer.length + ' bytes)');
    res.json({ ok:true });
  } catch(err) {
    console.error('[AUDIO] Erro ao enviar áudio:', err.message);
    res.status(500).json({ ok:false, erro:err.message });
  } finally {
    if (existsSync(file.path)) unlinkSync(file.path);
  }
});

app.get('/grupos', async (req, res) => {
  if (!sock || !conectado) {
    const ok = await aguardarSock(15000);
    if (!ok) return res.status(503).json({ ok:false, erro:'WhatsApp nao conectado.' });
  }
  try {
    const chats  = await sock.groupFetchAllParticipating();
    const grupos = Object.values(chats).map(g=>({id:g.id,nome:g.subject||'(sem nome)'})).sort((a,b)=>a.nome.localeCompare(b.nome,'pt-BR'));
    res.json({ ok:true, total:grupos.length, grupos });
  } catch(err) {
    if (err.message?.includes('Connection Closed') || err.message?.includes('Connection Terminated')) {
      console.warn('[GRUPOS] Conexão caiu durante fetch, aguardando reconexão...');
      const ok = await aguardarSock(20000);
      if (!ok) return res.status(503).json({ ok:false, erro:'WhatsApp reconectando, tente novamente.' });
      try {
        const chats  = await sock.groupFetchAllParticipating();
        const grupos = Object.values(chats).map(g=>({id:g.id,nome:g.subject||'(sem nome)'})).sort((a,b)=>a.nome.localeCompare(b.nome,'pt-BR'));
        return res.json({ ok:true, total:grupos.length, grupos });
      } catch(err2) { return res.status(500).json({ ok:false, erro:err2.message }); }
    }
    res.status(500).json({ ok:false, erro:err.message });
  }
});

// ── HUBLA WEBHOOK ─────────────────────────────────────────────────────────────

const MENSAGEM_BOAS_VINDAS = (nome) => `Olá, ${nome}! Seja muito bem-vindo ao Clube do Viajante Premium! ✈️

Estou muito feliz em ter você com a gente. A partir de agora, você terá acesso aos nossos conteúdos, grupos e oportunidades para aprender a acumular e usar melhor seus pontos e milhas.

Para começar da melhor forma, minha orientação é que o *seu primeiro passo* seja acessar a área de membros e *assistir*, pelo menos, ao *módulo de boas-vindas*.

Nele eu explico algumas instruções importantes sobre como aproveitar os conteúdos, como funcionam os grupos, onde encontrar cada informação e quais são os próximos passos para você tirar o máximo proveito da sua assinatura.

Além disso, *você já está participando do desafio 100 em 3*: quem assistir a todas as aulas em até 3 meses ganha um kit de viagens personalizado. Todos os detalhes sobre o desafio também estão explicados no módulo de boas-vindas.

Mais uma vez, que bom ter você aqui! Tenho certeza de que esse será um passo muito importante para você viajar melhor, economizar mais e aproveitar muito mais o mundo dos pontos e milhas. 🚀

Acesse a área de membros aqui: https://app.hub.la/m/5aPVHUjfhTa79XR2bWqC

Davi Leles`;

function formatarNumero(telefone) {
  const apenasDigitos = telefone.replace(/\D/g, '');
  const comDDI = apenasDigitos.startsWith('55') ? apenasDigitos : `55${apenasDigitos}`;
  return `${comDDI}@s.whatsapp.net`;
}

function extrairTelefone(payload) {
  const ev = payload.event; if (!ev) return null;
  return ev.member?.phone || ev.member?.user?.phone || ev.subscriber?.phone || ev.customer?.phone || ev.user?.phone || null;
}

function extrairNome(payload) {
  const ev = payload.event; if (!ev) return 'novo membro';
  const n = ev.member?.fullName || ev.member?.name || ev.member?.user?.name || ev.subscriber?.name || ev.customer?.name || ev.user?.name || null;
  return n ? n.split(' ')[0] : 'novo membro';
}

app.post('/webhook/hubla', async (req, res) => {
  try {
    const tokenRecebido = req.headers['x-hubla-token'];
    const tokenEsperado = process.env.HUBLA_TOKEN;
    if (!tokenEsperado) { console.error('[Hubla] HUBLA_TOKEN não configurado'); return res.status(500).json({ error: 'Configuração interna ausente' }); }
    if (!tokenRecebido || tokenRecebido !== tokenEsperado) { console.warn('[Hubla] Token inválido'); return res.status(401).json({ error: 'Token inválido' }); }
    const payload = req.body;
    const tipo = payload?.type;
    console.log(`[Hubla] Evento: ${tipo}`);
    if (tipo !== 'customer.member_added') return res.status(200).json({ status: 'ignorado', tipo });
    const telefone = extrairTelefone(payload);
    const nome = extrairNome(payload);
    if (!telefone) { console.warn('[Hubla] Telefone não encontrado'); return res.status(200).json({ status: 'sem_telefone' }); }
    const numeroFormatado = formatarNumero(telefone);
    console.log(`[Hubla] Enviando boas-vindas para ${nome} (${numeroFormatado})`);
    if (!conectado || !sock) { const ok = await aguardarSock(); if (!ok) return res.status(503).json({ error: 'WhatsApp não conectado' }); }
    await enviarMensagem(numeroFormatado, { text: MENSAGEM_BOAS_VINDAS(nome) });
    console.log(`[Hubla] ✅ Enviado para ${nome}`);
    return res.status(200).json({ status: 'enviado', para: nome });
  } catch (err) { console.error('[Hubla] Erro:', err); return res.status(500).json({ error: 'Erro interno' }); }
});


app.post('/reset-sessao', async (req, res) => {
  console.log('[RESET] Reset de sessão solicitado via endpoint.');
  res.json({ ok:true, mensagem:'Limpando sessão e reconectando...' });
  await limparSessaoEReconectar();
});

app.post('/reset-sessao-completo', async (req, res) => {
  console.log('[RESET] Reset COMPLETO de sessão solicitado via endpoint.');
  res.json({ ok:true, mensagem:'Apagando toda a sessão e reconectando...' });
  conectado = false;
  const sockRef = sock;
  sock = null;
  if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
  if (sockRef) { try { sockRef.end(new Error('reset-completo')); } catch(e) {} }
  try {
    const arquivos = await readdir(SESSAO_DIR);
    for (const arq of arquivos) {
      if (arq === 'fila_pendentes.json' || arq === 'agendamentos.json') continue; // preserva fila e agendamentos
      await unlink(SESSAO_DIR + '/' + arq).catch(() => {});
    }
    console.log('[RESET] Sessão apagada completamente. Aguardando novo QR...');
  } catch(e) { console.error('[RESET] Erro ao apagar sessão:', e.message); }
  errosDescripto = 0;
  _reconectarTentativas = 0;

  setTimeout(conectar, 2000);
});

app.listen(PORT, () => {
  console.log('Servidor na porta '+PORT);
});

// Conecta ao WhatsApp imediatamente no startup.
// Garante que mensagens dos grupos monitorados não sejam perdidas após deploy.
console.log("[SERVER] Iniciando conexão com WhatsApp...");
conectar();
