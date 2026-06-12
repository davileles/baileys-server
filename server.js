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

// ── HANDLERS DE ERRO GLOBAIS ──────────────────────────────────────────────────
process.on('uncaughtException',  (err) => console.error('[FATAL] uncaughtException:', err.message, err.stack));
process.on('unhandledRejection', (err) => console.error('[FATAL] unhandledRejection:', err?.message || err));

// ── GRUPOS DE DESTINO ─────────────────────────────────────────────────────────
const GRUPOS = {
  tsp:         '120363424721106736@g.us',
  cdv_ofertas: '120363423014138662@g.us',
  cdv_emissao: '120363172490263905@g.us',
};
const GRUPOS_MONITORADOS      = [
  '120363427512561555@g.us',
  '120363409136599326@g.us',
  '120363410708080270@g.us',
  '120363229600818869@g.us',
  '120363298361885116@g.us',
  '120363301488379027@g.us',
  '120363230402728347@g.us',
  '120363229682219999@g.us',
  '120363212151306916@g.us',
  '120363318399199070@g.us',
  '120363230586056001@g.us',
];
const GRUPO_DESTINO_PASSAGENS = 'cdv_emissao';
const JANELA_AGRUPAMENTO_MS   = 3 * 60 * 1000;

const GRUPOS_FILTRO_DATAS_MIN = {
  '120363229600818869@g.us': 5,
  '120363298361885116@g.us': 5,
  '120363301488379027@g.us': 5,
  '120363230402728347@g.us': 5,
  '120363229682219999@g.us': 5,
  '120363212151306916@g.us': 5,
  '120363318399199070@g.us': 5,
  '120363230586056001@g.us': 5,
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

let sock      = null;
let conectado = false;
let qrAtual   = null;

// Aguarda sock estar disponível (até 8s)
async function aguardarSock(ms = 8000) {
  const inicio = Date.now();
  while ((!sock || !conectado) && Date.now() - inicio < ms) {
    await new Promise(r => setTimeout(r, 300));
  }
  return !!sock && conectado;
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
    .sort((a, b) => new Date(a.o.timestamp) - new Date(b.o.timestamp)); // mais antigas primeiro
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
const bufferAgrupamento = new Map();

// ── FILA DE ENVIO CDV (intervalo de 5 min, janela 07h–21h, fuso SP) ──────────
const INTERVALO_ENVIO_MS  = 5 * 60 * 1000;
const HORA_INICIO_ENVIO   = 7;   // 07:00 SP
const HORA_FIM_ENVIO      = 21;  // 21:00 SP (exclusive: não envia após 21:00)
const TZ_SP               = 'America/Sao_Paulo';
const filaEnvio = [];
let promessaFila = Promise.resolve();

// Retorna a hora atual em SP (0-23)
function horaSP() {
  return parseInt(new Intl.DateTimeFormat('pt-BR', { timeZone:TZ_SP, hour:'numeric', hour12:false }).format(new Date()), 10);
}

// Retorna quantos ms faltam até a próxima janela permitida (07h SP) se fora dela
function msAteJanela() {
  const agora = new Date();
  const hora  = horaSP();
  if (hora >= HORA_INICIO_ENVIO && hora < HORA_FIM_ENVIO) return 0;
  // Calcula quantos ms até 07:00 SP do próximo dia (ou hoje se ainda não chegou)
  const partes = new Intl.DateTimeFormat('pt-BR', {
    timeZone:TZ_SP, year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false
  }).formatToParts(agora);
  const get = (t) => parseInt(partes.find(p => p.type===t).value, 10);
  let ano=get('year'),mes=get('month')-1,dia=get('day'),h=get('hour'),min=get('minute'),seg=get('second');
  // Próximo 07:00 SP: se ainda é antes de 07:00 hoje, usa hoje; senão usa amanhã
  let alvo;
  if (h < HORA_INICIO_ENVIO) {
    alvo = new Date(agora.getTime() - ((h*3600+min*60+seg)*1000) + HORA_INICIO_ENVIO*3600*1000);
  } else {
    // após 21:00 → próximo dia 07:00
    alvo = new Date(agora.getTime() - ((h*3600+min*60+seg)*1000) + (24+HORA_INICIO_ENVIO)*3600*1000);
  }
  return Math.max(0, alvo.getTime() - agora.getTime());
}

// Calcula o tempo de envio estimado para um item na posição `posicao` da fila (0-based)
// levando em conta a janela horária. Retorna { posicao, tempoMin, horario }
function calcularPosicaoFila(posicaoNaFila) {
  const agora = Date.now();
  const espera = msAteJanela();
  // Base: quando o primeiro item poderá ser enviado
  let baseMs = agora + espera;
  // Cada posição adiciona INTERVALO_ENVIO_MS, mas se o slot cair fora da janela, pula para 07h do próximo dia
  let tempoMs = baseMs;
  for (let i = 0; i < posicaoNaFila; i++) {
    tempoMs += INTERVALO_ENVIO_MS;
    // Verificar se caiu fora da janela
    const h = parseInt(new Intl.DateTimeFormat('pt-BR',{timeZone:TZ_SP,hour:'numeric',hour12:false}).format(new Date(tempoMs)),10);
    if (h >= HORA_FIM_ENVIO || h < HORA_INICIO_ENVIO) {
      // Avança para 07:00 do próximo dia
      const diff = tempoMs - agora;
      const msAte = msAteJanela.call({ _t: tempoMs }) || (() => {
        // recalcular baseado em tempoMs
        const hh = h;
        if (hh < HORA_INICIO_ENVIO) return (HORA_INICIO_ENVIO - hh) * 3600000;
        return (24 + HORA_INICIO_ENVIO - hh) * 3600000;
      })();
      tempoMs += msAte;
    }
  }
  const tempoMin = Math.round((tempoMs - agora) / 60000);
  const horario  = new Intl.DateTimeFormat('pt-BR',{timeZone:TZ_SP,hour:'2-digit',minute:'2-digit'}).format(new Date(tempoMs));
  return { posicao: posicaoNaFila, tempoMin, horario };
}

function enfileirarEnvio(ofertaId, mensagem, grupoAlvo) {
  const destino = grupoAlvo || GRUPOS[GRUPO_DESTINO_PASSAGENS];
  return new Promise((resolve, reject) => {
    const posicao = filaEnvio.length;
    filaEnvio.push({ ofertaId, mensagem, destino, resolve, reject });
    console.log('[ENVIO] Oferta #'+ofertaId+' enfileirada. Posição: '+(posicao+1));
    promessaFila = promessaFila.then(() => new Promise(res => {
      const item = filaEnvio.shift();
      if (!item) { res(); return; }
      // Aguardar janela horária se necessário
      const espera = msAteJanela();
      const despachar = () => {
        console.log('[ENVIO] Enviando oferta #'+item.ofertaId+' ('+filaEnvio.length+' restantes na fila)');
        sock.sendMessage(item.destino, { text: item.mensagem })
          .then(() => { item.resolve(); setTimeout(res, INTERVALO_ENVIO_MS); })
          .catch(e  => { item.reject(e);  setTimeout(res, INTERVALO_ENVIO_MS); });
      };
      if (espera > 0) {
        console.log('[ENVIO] Fora da janela horária. Aguardando '+Math.round(espera/60000)+' min para retomar.');
        setTimeout(despachar, espera);
      } else {
        despachar();
      }
    }));
  });
}

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

// Verifica a cada 30s se há agendamentos a disparar
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
      enfileirarEnvio('ag-'+ag.id, ag.mensagem, grupoId).catch(e => console.error('[AGEND] Erro envio:', e.message));
    } else {
      if (!sock || !conectado) { ag.status = 'erro'; salvarAgendamentos(); continue; }
      sock.sendMessage(grupoId, { text: ag.mensagem })
        .then(() => { ag.status = 'enviado'; salvarAgendamentos(); })
        .catch(e  => { ag.status = 'erro';   salvarAgendamentos(); console.error('[AGEND] Erro envio:', e.message); });
    }
    console.log('[AGEND] Disparando agendamento #'+ag.id+' para grupo '+ag.grupo);
  }
}, 30 * 1000);

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

// Comprime sequências numéricas contíguas: [1,2,3,4,7,8] → "1-4, 7-8"
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
  // Quebra por mês, comprime dias sequenciais em cada trecho
  return str
    .replace(/([A-Za-záàãâéêíóôõúüç]+\/\d{2}:)/g, '\n$1')
    .replace(/^\n/, '')
    .trim()
    .split('\n')
    .map(linha => {
      // Linha esperada: "Jun/26: 1, 2, 3, 4, 7, 8"
      const match = linha.match(/^([A-Za-záàãâéêíóôõúüç]+\/\d{2}:)\s*(.+)$/);
      if (!match) return linha;
      const prefixo = match[1];
      const dias = match[2].match(/\d+/g);
      if (!dias || dias.length <= 2) return linha; // não vale comprimir 1 ou 2 dias
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
  var rawPontos = String(d.pontos||'0').replace(/[.,\s]/g,'');
  var num = parseInt(rawPontos) || 0;
  if (num > 5000000) { num = 0; }
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

// ── LINKS AFILIADOS TSP ───────────────────────────────────────────────────────
const LINKS_TSP = {
  'Amazon':        'https://amzn.to/4dFRSzy',
  'Mercado Livre': 'https://meli.la/2xystLt',
  'Shopee_sem':    'https://s.shopee.com.br/9fHPmP3QZF',
  'Shopee_com':    'https://s.shopee.com.br/30kdYeLY0W',
};

// ── FORMATAR CUPOM TSP (replicando gerarCupom() do HTML) ─────────────────────
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
  "minimo": número (valor mínimo de compra),
  "limite": número | null (limite máximo de desconto em R$, só para tipo "pct"),
  "codigo": "CUPOM123" | null,
  "multiplos": [ {valor, minimo, codigo} ] | null (quando há múltiplos cupons na mesma mensagem),
  "observacao": "texto livre" | null
}

Regras:
- Se não for cupom de desconto, retorne {"eh_cupom": false}
- Shopee sem código = "codigo": null
- Para múltiplos cupons (ex: R$30 em R$299 + R$90 em R$899), use "multiplos"
- Valores devem ser números puros sem símbolo`;

  return await chamarClaude(system, [{ type:'text', text: texto }], 500);
}

// ── PROCESSAR MENSAGEM DO TELEGRAM ────────────────────────────────────────────
async function processarMensagemTelegram(texto) {
  if (!texto?.trim()) return;
  console.log('[TG] Nova mensagem recebida:', texto.slice(0, 80));

  try {
    const campos = await extrairCupomTelegram(texto);
    if (!campos || !campos.eh_cupom) {
      console.log('[TG] Não é cupom, ignorado.');
      return;
    }

    console.log(`[TG] Cupom identificado: ${campos.loja} | ${campos.valor}${campos.tipo === 'pct' ? '%' : ' R$'}`);

    // Múltiplos cupons na mesma mensagem
    const lista = campos.multiplos?.length
      ? campos.multiplos.map(m => ({ ...campos, valor: m.valor, minimo: m.minimo, codigo: m.codigo ?? campos.codigo, multiplos: null }))
      : [campos];

    for (const c of lista) {
      const mensagemFormatada = formatarCupomTSP(c);
      const oferta = {
        id: gerarId(),
        timestamp: new Date().toISOString(),
        grupoOrigem: 'telegram:@juaocupons',
        tipoConteudo: 'cupom_tsp',
        conteudoOriginal: texto,
        imagens: [],
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
const TG_GRUPO_MONITORADO = process.env.TG_GRUPO || '@juaocupons';

let tgClient = null;
let tgConectado = false;

// Estado da autenticação interativa via web
let tgAuthState = null; // null | 'aguardando_telefone' | 'aguardando_codigo' | 'aguardando_senha' | 'ok' | 'erro'
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

  // Callbacks de autenticação interativa via web
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

  // Salvar sessão para próximos deploys
  const sessionSalva = tgClient.session.save();
  writeFileSync(TG_SESSION_PATH, sessionSalva, 'utf-8');
  tgConectado = true;
  tgAuthState = 'ok';
  console.log(`[TG] Conectado! Monitorando ${TG_GRUPO_MONITORADO}`);

  // Listener de novas mensagens de canal (UpdateNewChannelMessage)
  tgClient.addEventHandler(async (update) => {
    try {
      const msg = update.message;
      if (!msg?.message) return;

      // Verificar se veio do canal monitorado
      const entity = await tgClient.getEntity(msg.peerId).catch(() => null);
      const username = entity?.username || '';
      if (username.toLowerCase() !== TG_GRUPO_MONITORADO.replace('@', '').toLowerCase()) return;

      const texto = msg.message;
      console.log('[TG] Nova mensagem do canal:', texto.slice(0, 80));
      await processarMensagemTelegram(texto);
    } catch (err) { console.error('[TG] Erro no handler de canal:', err.message); }
  }, new Raw({ types: [Api.UpdateNewChannelMessage] }));
}

// Iniciar Telegram em background (sem bloquear o servidor)
iniciarTelegram().catch(err => {
  console.error('[TG] Falha ao iniciar:', err.message);
  tgAuthState = 'erro';
});

// ── GRUPOS COM REGRAS ESPECIAIS DE EXTRAÇÃO ───────────────────────────────────
// Grupo que usa APENAS imagem como fonte principal (ignorar texto)
const GRUPO_APENAS_IMAGEM = '120363427512561555@g.us';
// Grupo executiva: ignorar imagens, sempre Executiva, usar só 1º programa
const GRUPO_EXECUTIVA     = '120363410708080270@g.us';
// Grupos texto estruturado: ignorar imagens, padrão "Oportunidade de resgate"
const GRUPOS_TEXTO_ESTRUTURADO = new Set([
  '120363229600818869@g.us',
  '120363298361885116@g.us',
  '120363301488379027@g.us',
  '120363230402728347@g.us',
  '120363229682219999@g.us',
  '120363212151306916@g.us',
  '120363318399199070@g.us',
  '120363230586056001@g.us',
]);

const SYSTEM_CDV = 'Voce e especialista em passagens aereas com milhas para o mercado brasileiro. Seja GENEROSO: qualquer mencao a rota aerea, milhas/pontos, programa de fidelidade ou companhia aerea deve ser valido. Responda APENAS JSON sem markdown.';
const PROGRAMAS_VALIDOS = 'Programa deve ser um destes: Smiles, Azul Fidelidade, Azul pelo Mundo, LATAM Pass, Iberia Plus, Privilege Club, Executive Club, TAP, AAdvantage, SUMA, Flying Club, Finnair Plus, Aeroplan.\nIMPORTANTE: TudoAzul = Azul Fidelidade. Tudo Azul = Azul Fidelidade. LatamPass = LATAM Pass.\nCabine deve ser exatamente "Economica" ou "Executiva".';
const JSON_EXEMPLO = (i) => '{"resultados":[{"valido":true,"indice":'+i+',"origem":"São Paulo","destino":"Cancún","origemCodigo":"GRU","destinoCodigo":"CUN","cia":"LATAM","programa":"LATAM Pass","pontos":"31494","cabine":"Economica","tipoVoo":"internacional","direcao":"ida_volta","datasIda":"Jun/26: 16, 19, 22","datasVolta":"Jun/26: 22, 23"}]}';
const JSON_INVALIDO = (i) => '{"resultados":[{"valido":false,"indice":'+i+'}]}';

// ── PASSO 1: CLASSIFICAR (CDV) ────────────────────────────────────────────────
async function classificarItens(itens, grupoId) {
  const resultados = [];

  // ── Grupo 120363427512561555: extração APENAS da imagem ───────────────────
  if (grupoId === GRUPO_APENAS_IMAGEM) {
    // Agrupa itens com imagem; itens sem imagem são descartados
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
        if (r?.valido) { r.origem = resolverCidade(r.origemCodigo, r.origem); r.destino = resolverCidade(r.destinoCodigo, r.destino); }
        resultados.push(r || { valido:false, indice:indiceOriginal });
      }
    }
    return resultados;
  }

  // ── Grupo 120363410708080270: executiva, ignorar imagens, 1º programa ─────
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
        }
        resultados.push(r || { valido:false, indice:indiceOriginal });
      }
    }
    return resultados;
  }

  // ── 8 grupos texto estruturado: ignorar imagens, padrão "Oportunidade" ────
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
        if (r?.valido) { r.origem = resolverCidade(r.origemCodigo, r.origem); r.destino = resolverCidade(r.destinoCodigo, r.destino); }
        resultados.push(r || { valido:false, indice:indiceOriginal });
      }
    }
    return resultados;
  }

  // ── Comportamento padrão (demais grupos) ──────────────────────────────────
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
      if (r?.valido) { r.origem = resolverCidade(r.origemCodigo, r.origem); r.destino = resolverCidade(r.destinoCodigo, r.destino); }
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
    return { ...e, ...dados, mensagem:formatarMensagemCDV(dados) };
  });
}

// ── MESCLAR PARES IDA/VOLTA (grupos com trecho separado) ─────────────────────
// Regra de proximidade: uma emissão só pode ser mergeada com a VIZINHA IMEDIATA
// (i com i+1). Reflete a lógica real de envio: imagens consecutivas no grupo
// pertencem à mesma emissão. Nunca busca par além do vizinho imediato.
function mesclarParesIdaVolta(validas) {
  const resultado = [];
  let i = 0;

  function normalizar(codigo, nome) {
    return (codigo || resolverCidade('', nome) || '').toLowerCase().trim();
  }

  function ehParInvertido(v, w) {
    const mesmoPrograma = (v.programa||'') === (w.programa||'');
    const mesmaCabine   = (v.cabine||'Economica') === (w.cabine||'Economica');
    const vOri = normalizar(v.origemCodigo,  v.origem);
    const vDes = normalizar(v.destinoCodigo, v.destino);
    const wOri = normalizar(w.origemCodigo,  w.origem);
    const wDes = normalizar(w.destinoCodigo, w.destino);
    const rotaInvertida = vOri && vDes && wOri && wDes && vOri === wDes && vDes === wOri;
    return mesmoPrograma && mesmaCabine && rotaInvertida;
  }

  while (i < validas.length) {
    const v = validas[i];
    const w = validas[i + 1];

    if (w && ehParInvertido(v, w)) {
      const merged = {
        ...v,
        direcao:    'ida_volta',
        datasIda:   v.datasIda   || v.datasVolta || '',
        datasVolta: w.datasIda   || w.datasVolta || '',
        indices:    [...(v.indices||[v.indice]), ...(w.indices||[w.indice])],
      };
      merged.origem  = resolverCidade(merged.origemCodigo,  merged.origem);
      merged.destino = resolverCidade(merged.destinoCodigo, merged.destino);
      console.log('[MERGE] Par ida/volta mesclado: '+(v.origemCodigo||v.origem)+'->'+(v.destinoCodigo||v.destino));
      resultado.push(merged);
      i += 2;
    } else {
      resultado.push({ ...v, indices: v.indices||[v.indice] });
      i += 1;
    }
  }
  return resultado;
}

// ── PROCESSAR BUFFER (CDV) ────────────────────────────────────────────────────
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

    // Mesclar pares ida/volta para grupos que enviam trechos separados
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

    // Grupos de imagem/executiva: cada emissão já está individualizada após o merge —
    // NÃO passar pelo agruparEFormatar (Claude do passo 2 confunde emissões díspares).
    const gruposBypass = new Set([GRUPO_APENAS_IMAGEM, GRUPO_EXECUTIVA]);
    if (gruposBypass.has(grupoId)) {
      for (const v of validas) {
        const indices = v.indices || [v.indice];
        const imagens = indices.map(i => itens[i]?.imagemBase64).filter(Boolean);
        const textos  = indices.map(i => itens[i]?.texto).filter(Boolean).join('\n');
        const dados   = { origem:v.origem, destino:v.destino, pontos:v.pontos, programa:v.programa, cia:v.cia, cabine:v.cabine||'Economica', tipoVoo:v.tipoVoo||'internacional', tipo:v.direcao||'ida', datasIda:v.datasIda||'', datasVolta:v.datasVolta||'' };
        const mensagem = formatarMensagemCDV(dados);
        const oferta   = { id:gerarId(), timestamp:new Date().toISOString(), grupoOrigem:grupoId, tipoConteudo:imagens.length>1?imagens.length+' imagens':imagens.length===1?'imagem':'texto', conteudoOriginal:textos, imagens, mensagemFormatada:mensagem, dadosExtraidos:{ ...dados, indices }, status:'pendente' };
        filaPendentes.unshift(oferta);
        salvarFila();
        console.log('[BYPASS] Oferta criada direto: '+v.origemCodigo+'->'+v.destinoCodigo+' ('+v.programa+')');
      }
      return;
    }

    // Demais grupos: agruparEFormatar via Claude
    const classificacoesFinais = validas.map(v => ({ ...v, valido:true }));
    const emissoes = await agruparEFormatar(classificacoesFinais);
    for (const emissao of emissoes) {
      const indices = emissao.indices || [];
      const imagens = indices.map(i => itens[i]?.imagemBase64).filter(Boolean);
      const textos  = indices.map(i => itens[i]?.texto).filter(Boolean).join('\n');
      const oferta  = { id:gerarId(), timestamp:new Date().toISOString(), grupoOrigem:grupoId, tipoConteudo:imagens.length>1?imagens.length+' imagens':imagens.length===1?'imagem':'texto', conteudoOriginal:textos, imagens, mensagemFormatada:emissao.mensagem, dadosExtraidos:emissao, status:'pendente' };
      filaPendentes.unshift(oferta);
      salvarFila();
    }
  } catch (err) { console.error('Erro ao processar buffer:', err.message); }
}

// Iniciar Telegram em background (sem bloquear o servidor)
iniciarTelegram().catch(err => {
  console.error('[TG] Falha ao iniciar:', err.message);
  tgAuthState = 'erro';
});

// ── LISTENER WHATSAPP ─────────────────────────────────────────────────────────
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
var HEALTH_CHECK_MS  = 8 * 60 * 1000;
var ultimoUpsert     = Date.now();
var healthTimer      = null;

function resetarHealthTimer() {
  ultimoUpsert = Date.now();
  if (healthTimer) clearTimeout(healthTimer);
  healthTimer = setTimeout(() => {
    console.log('[HEALTH] Forçando reconexão...');
    conectado = false;
    if (sock) { try { sock.end(new Error('health-check-timeout')); } catch(e) {} sock = null; }
    // Limpeza automática da fila a cada hora
setInterval(() => {
  const antes = filaPendentes.length;
  limparFila();
  salvarFila();
  const depois = filaPendentes.length;
  if (antes !== depois) console.log('[FILA] Limpeza automática: ' + (antes - depois) + ' oferta(s) removida(s).');
}, 60 * 60 * 1000);

conectar();
  }, HEALTH_CHECK_MS);
}

var errosDescripto  = 0;
var ERROS_DESCR_MAX = 15;

async function limparSessaoEReconectar() {
  conectado = false;
  if (sock) { try { sock.end(new Error('bad-session')); } catch(e) {} sock = null; }
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

async function conectar() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSAO_DIR);
  const { version }          = await fetchLatestBaileysVersion();
  sock = makeWASocket({ version, auth: state, logger: baileysLogger, printQRInTerminal: false, syncFullHistory: false, markOnlineOnConnect: true, getMessage: async () => undefined });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) { qrAtual = await QRCode.toDataURL(qr); }
    if (connection === 'open') { conectado = true; qrAtual = null; errosDescripto = 0; resetarHealthTimer(); console.log('WhatsApp conectado!'); }
    if (connection === 'close') {
      conectado = false;
      if (healthTimer) { clearTimeout(healthTimer); healthTimer = null; }
      const codigo = new Boom(lastDisconnect?.error)?.output?.statusCode;
      if (codigo !== DisconnectReason.loggedOut) { sock = null; setTimeout(conectar, 5000); }
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
      await processarMensagem(msg);
    }
  });
  resetarHealthTimer();
}

// ── CSS DO PAINEL ─────────────────────────────────────────────────────────────
const PAINEL_CSS = `*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#0d0d0d;color:#f0f0f0;min-height:100vh}header{background:#111;border-bottom:1px solid #222;padding:16px 24px;display:flex;align-items:center;justify-content:space-between}header h1{font-size:18px;color:#ffa500}header .nav a{color:#aaa;text-decoration:none;margin-left:16px;font-size:14px}header .nav a:hover{color:#ffa500}.container{max-width:960px;margin:0 auto;padding:24px 16px}.badge{background:#ffa500;color:#000;font-size:11px;font-weight:700;padding:2px 7px;border-radius:10px;margin-left:6px}.empty{text-align:center;color:#555;padding:60px 0;font-size:15px}.card{background:#161616;border:1px solid #222;border-radius:12px;margin-bottom:16px;overflow:hidden}.card-header{padding:12px 16px;background:#1a1a1a;border-bottom:1px solid #222;display:flex;align-items:center;gap:8px;font-size:13px;color:#aaa;flex-wrap:wrap}.card-header .id{color:#ffa500;font-weight:700;font-size:14px}.tag{background:#252525;padding:2px 8px;border-radius:6px;font-size:11px}.tag-iv{background:#1a2e1a;color:#22c55e}.tag-ida{background:#1a1f2e;color:#60a5fa}.tag-exec{background:#2e1a2e;color:#c084fc}.tag-eco{background:#1a2020;color:#67e8f9}.tag-tsp{background:#2e1a00;color:#ffa500}.card-body{display:grid;grid-template-columns:1fr 1fr}.col{padding:16px}.col+.col{border-left:1px solid #222}.col-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#444;margin-bottom:10px}.imgs-grid{display:flex;flex-wrap:wrap;gap:8px}.imgs-grid img{width:calc(50% - 4px);min-width:120px;border-radius:8px;object-fit:cover}.imgs-grid img:only-child{width:100%}.texto-orig{font-size:13px;color:#888;white-space:pre-wrap;word-break:break-word;margin-top:8px}.edit-area{width:100%;background:#0d0d0d;color:#f0f0f0;border:1px solid #2a2a2a;border-radius:8px;padding:12px;font-size:13px;font-family:inherit;line-height:1.7;resize:vertical;min-height:200px}.edit-area:focus{outline:none;border-color:#444}.card-footer{padding:12px 16px;border-top:1px solid #1a1a1a;display:flex;gap:10px;align-items:center;flex-wrap:wrap}.btn{padding:8px 20px;border-radius:8px;border:none;font-size:13px;font-weight:600;cursor:pointer;transition:opacity .15s}.btn:hover{opacity:.8}.btn-ap{background:#22c55e;color:#000}.btn-rej{background:#333;color:#aaa}.ok-ap{color:#22c55e;font-size:13px}.ok-rej{color:#555;font-size:13px}.buffer-bar{background:#1a1400;border:1px solid #3a2e00;border-radius:8px;padding:10px 16px;font-size:13px;color:#ffa500;margin-bottom:16px}.sep{color:#333;font-size:12px;text-transform:uppercase;letter-spacing:1px;margin:28px 0 12px}.tg-bar{background:#0d1a2e;border:1px solid #1a3a5e;border-radius:8px;padding:10px 16px;font-size:13px;margin-bottom:16px;display:flex;align-items:center;gap:8px}.tg-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}.tg-dot-on{background:#22c55e}.tg-dot-off{background:#555}.tg-dot-wait{background:#ffa500}@media(max-width:600px){.card-body{grid-template-columns:1fr}.col+.col{border-left:none;border-top:1px solid #1a1a1a}.imgs-grid img{width:100%}}`;

// ── ROTAS ─────────────────────────────────────────────────────────────────────

// Rota de autenticação Telegram via web
app.get('/tg-auth', (req, res) => {
  const estado = tgAuthState;
  const conectadoTg = tgConectado;

  if (conectadoTg) {
    return res.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Telegram Auth</title><style>body{font-family:sans-serif;background:#0d0d0d;color:#f0f0f0;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;gap:16px}h2{color:#22c55e}a{color:#ffa500}</style></head><body><h2>✅ Telegram conectado!</h2><p>Monitorando ${TG_GRUPO_MONITORADO}</p><a href="/painel">Ir para o painel</a></body></html>`);
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
  if (!qrAtual)  return res.send('<html><head><meta http-equiv="refresh" content="3"></head><body style="background:#0d0d0d;color:#f0f0f0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh"><h2>Gerando QR...</h2></body></html>');
  res.send('<html><head><title>QR</title><meta http-equiv="refresh" content="30"><style>body{background:#0d0d0d;color:#f0f0f0;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;gap:16px;margin:0}h2{color:#ffa500}img{border:4px solid #ffa500;border-radius:12px;width:260px}p{color:#aaa;font-size:.9rem;text-align:center}</style></head><body><h2>Escanear QR Code</h2><img src="'+qrAtual+'" alt="QR"/><p>WhatsApp - Dispositivos conectados - Conectar dispositivo</p></body></html>');
});

app.get('/status', (req, res) => {
  const emBuffer = [...bufferAgrupamento.values()].reduce((s,e) => s+e.itens.length, 0);
  res.json({ conectado, sockAtivo:!!sock, qrDisponivel:!!qrAtual, telegramConectado:tgConectado, telegramAuthState:tgAuthState, telegramGrupo:TG_GRUPO_MONITORADO, grupos:Object.keys(GRUPOS), gruposMonitorados:GRUPOS_MONITORADOS, bufferAtivo:emBuffer, filaPendentes:filaPendentes.filter(o=>o.status==='pendente').length, filaTotal:filaPendentes.length });
});

app.get('/painel', (req, res) => {
  const pendentes   = filaPendentes.filter(o => o.status==='pendente');
  const processados = filaPendentes.filter(o => o.status!=='pendente');
  const emBuffer    = [...bufferAgrupamento.values()].reduce((s,e) => s+e.itens.length, 0);

  const tgStatusDot = tgConectado ? 'tg-dot-on' : (tgAuthState && tgAuthState !== 'ok' && tgAuthState !== 'erro' ? 'tg-dot-wait' : 'tg-dot-off');
  const tgStatusTxt = tgConectado ? `Telegram conectado — monitorando ${TG_GRUPO_MONITORADO}` : (tgAuthState === 'aguardando_telefone' || tgAuthState === 'aguardando_codigo' || tgAuthState === 'aguardando_senha' ? `Telegram aguardando autenticação — <a href="/tg-auth" style="color:#ffa500">clique aqui para autenticar</a>` : `Telegram desconectado — <a href="/tg-auth" style="color:#ffa500">conectar</a>`);

  const renderCard = (o) => {
    const data = new Date(o.timestamp).toLocaleString('pt-BR');
    const d    = o.dadosExtraidos || {};
    const isTSP = o.tipoConteudo === 'cupom_tsp';

    if (isTSP) {
      // Card especial para cupons TSP
      const loja  = d.loja || '';
      const valor = d.valor || '';
      const tipo  = d.tipo === 'pct' ? '%' : ' R$';
      const cod   = d.codigo ? `<span class="tag">${d.codigo}</span>` : '';
      const textoHtml = o.conteudoOriginal ? `<div class="texto-orig">${o.conteudoOriginal}</div>` : '';
      if (o.status==='aprovado')  return `<div class="card"><div class="card-header"><span class="id">#${o.id}</span><span class="tag tag-tsp">📦 Cupom TSP</span><span style="color:#f0f0f0;font-weight:600">${loja} ${valor}${tipo}</span>${cod}<span style="margin-left:auto">${data}</span></div><div style="padding:12px 16px"><span class="ok-ap">Aprovado e enviado</span></div></div>`;
      if (o.status==='rejeitado') return `<div class="card"><div class="card-header"><span class="id">#${o.id}</span><span class="tag tag-tsp">📦 Cupom TSP</span><span style="color:#f0f0f0;font-weight:600">${loja} ${valor}${tipo}</span>${cod}<span style="margin-left:auto">${data}</span></div><div style="padding:12px 16px"><span class="ok-rej">Rejeitado</span></div></div>`;
      return `<div class="card" id="card-${o.id}"><div class="card-header"><span class="id">#${o.id}</span><span class="tag tag-tsp">📦 Cupom TSP</span><span style="color:#f0f0f0;font-weight:600">${loja} ${valor}${tipo}</span>${cod}<span style="font-size:12px;color:#555;margin-left:auto">${data}</span></div><div class="card-body"><div class="col"><div class="col-title">Original (Telegram)</div>${textoHtml}</div><div class="col"><div class="col-title">Mensagem formatada</div><textarea class="edit-area" id="msg-${o.id}">${o.mensagemFormatada}</textarea></div></div><div class="card-footer"><button class="btn btn-ap" onclick="aprovar(${o.id})">Aprovar e enviar</button><button class="btn btn-rej" onclick="rejeitar(${o.id})">Rejeitar</button><span id="fb-${o.id}" style="font-size:13px;margin-left:auto"></span></div></div>`;
    }

    // Card CDV (original)
    const tipoTag   = d.tipo==='ida_volta'?'<span class="tag tag-iv">Ida e volta</span>':d.tipo==='ida'?'<span class="tag tag-ida">Somente ida</span>':'';
    const cabineTag = d.cabine==='Executiva'?'<span class="tag tag-exec">Executiva</span>':'<span class="tag tag-eco">Economica</span>';
    const rota = d.origem&&d.destino?`<span style="color:#f0f0f0;font-weight:600">${d.origem} - ${d.destino}</span>`:'';
    const prog = d.programa?`<span class="tag">${d.programa}</span>`:'';
    const imgsHtml = (o.imagens||[]).length>0?'<div class="imgs-grid">'+(o.imagens.map(b=>'<img src="data:image/jpeg;base64,'+b+'" />')).join('')+'</div>':'';
    const textoHtml = o.conteudoOriginal?`<div class="texto-orig">${typeof o.conteudoOriginal === 'string' ? o.conteudoOriginal : o.conteudoOriginal.join?.('\n') || ''}</div>`:'';
    if (o.status==='aprovado')  return `<div class="card"><div class="card-header"><span class="id">#${o.id}</span>${rota}${tipoTag}${cabineTag}<span style="margin-left:auto">${data}</span></div><div style="padding:12px 16px"><span class="ok-ap">Aprovado e enviado</span></div></div>`;
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

  // Agendamento futuro explícito
  if (agendarEm) {
    const dispararEm = new Date(agendarEm).getTime();
    if (isNaN(dispararEm)) return res.status(400).json({ ok:false, erro:'Data inválida.' });
    const agId = gerarId();
    agendamentos.push({ id:agId, grupo:'cdv_emissao', mensagem, dispararEm, status:'aguardando', criadoEm:new Date().toISOString() });
    salvarAgendamentos();
    oferta.status = 'aprovado'; oferta.mensagemFinal = mensagem; salvarFila();
    const horario = new Intl.DateTimeFormat('pt-BR',{timeZone:TZ_SP,dateStyle:'short',timeStyle:'short'}).format(new Date(dispararEm));
    return res.json({ ok:true, agendado:true, horario });
  }

  // Cupons TSP: enviar direto para o grupo tsp (sem fila de intervalo)
  if (oferta.tipoConteudo === 'cupom_tsp') {
    try {
      await sock.sendMessage(GRUPOS['tsp'], { text: mensagem });
      oferta.status = 'aprovado'; oferta.mensagemFinal = mensagem; salvarFila();
      res.json({ ok:true });
    } catch(err) { res.status(500).json({ ok:false, erro: err.message }); }
    return;
  }

  // CDV: fila com intervalo de 5min + restrição de janela horária
  const info = calcularPosicaoFila(filaEnvio.length);
  try {
    oferta.status = 'aprovado'; oferta.mensagemFinal = mensagem; salvarFila();
    res.json({ ok:true, posicao:info.posicao, tempoMin:info.tempoMin, horario:info.horario });
    await enfileirarEnvio(oferta.id, mensagem, GRUPOS[GRUPO_DESTINO_PASSAGENS]);
  } catch(err) { console.error('[APROVAR] Erro:', err.message); }
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
  const grupoFake = 'injecao_manual';
  if (!bufferAgrupamento.has(grupoFake)) {
    const timer = setTimeout(() => processarBuffer(grupoFake), JANELA_AGRUPAMENTO_MS);
    bufferAgrupamento.set(grupoFake, { itens:[], timer });
  }
  const entrada = bufferAgrupamento.get(grupoFake);
  entrada.itens.push({ texto:texto.trim(), imagemBase64:null, timestamp:Date.now() });
  res.json({ ok:true, bufferItens:entrada.itens.length });
});

app.post('/enviar', async (req, res) => {
  const { grupo, mensagem, agendarEm } = req.body;
  if (!conectado||!sock) return res.status(503).json({ ok:false, erro:'WhatsApp nao conectado.' });
  const grupoId = resolverGrupo(grupo);
  if (!grupoId) return res.status(400).json({ ok:false, erro:'Grupo invalido: '+grupo });
  if (!mensagem?.trim()) return res.status(400).json({ ok:false, erro:'Mensagem vazia.' });

  // Agendamento futuro
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
    const info = calcularPosicaoFila(filaEnvio.length);
    try {
      res.json({ ok:true, posicao:info.posicao, tempoMin:info.tempoMin, horario:info.horario });
      await enfileirarEnvio('manual', mensagem, grupoId);
    } catch(err) { console.error('[ENVIAR] Erro:', err.message); }
  } else {
    try { await sock.sendMessage(grupoId, { text:mensagem }); res.json({ ok:true }); }
    catch(err) { res.status(500).json({ ok:false, erro:err.message }); }
  }
});

app.post('/enviar-imagem', upload.single('imagem'), async (req, res) => {
  const { grupo, legenda } = req.body;
  const file = req.file;
  if (!conectado||!sock) { if(file) unlinkSync(file.path); return res.status(503).json({ ok:false, erro:'WhatsApp nao conectado.' }); }
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
  if (!sock || !conectado) return res.status(503).json({ ok:false, erro:'WhatsApp nao conectado.' });
  try {
    const chats  = await sock.groupFetchAllParticipating();
    const grupos = Object.values(chats).map(g=>({id:g.id,nome:g.subject||'(sem nome)'})).sort((a,b)=>a.nome.localeCompare(b.nome,'pt-BR'));
    res.json({ ok:true, total:grupos.length, grupos });
  } catch(err) { res.status(500).json({ ok:false, erro:err.message }); }
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
    await sock.sendMessage(numeroFormatado, { text: MENSAGEM_BOAS_VINDAS(nome) });
    console.log(`[Hubla] ✅ Enviado para ${nome}`);
    return res.status(200).json({ status: 'enviado', para: nome });
  } catch (err) { console.error('[Hubla] Erro:', err); return res.status(500).json({ error: 'Erro interno' }); }
});


app.listen(PORT, () => {
  console.log('Servidor na porta '+PORT);
});


conectar();
