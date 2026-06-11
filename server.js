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
import { NewMessage } from 'telegram/events/index.js';

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

// Filtro de datas mínimas por grupo (grupos não listados = sem filtro)
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

// Aguarda sock estar disponível (até 8s)
async function aguardarSock(ms = 8000) {
  const inicio = Date.now();
  while ((!sock || !conectado) && Date.now() - inicio < ms) {
    await new Promise(r => setTimeout(r, 300));
  }
  return !!sock && conectado;
}
let qrAtual   = null;
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

function salvarFila() {
  try {
    writeFileSync(FILA_PATH, JSON.stringify(filaPendentes.slice(0, 100)), 'utf-8');
  } catch(e) { console.log('[FILA] Erro ao salvar fila:', e.message); }
}

const filaPendentes = [];
carregarFila();
// Iniciar contadorId após o maior ID já existente para evitar colisões
let contadorId = filaPendentes.length > 0
  ? filaPendentes.reduce((max, o) => Math.max(max, parseInt(o.id)||0), 0) + 1
  : 1;
console.log('[FILA] Contador de IDs iniciado em: ' + contadorId);
const bufferAgrupamento = new Map();

// ── FILA DE ENVIO (intervalo de 5 min entre mensagens) ───────────────────────
const INTERVALO_ENVIO_MS = 5 * 60 * 1000;
const filaEnvio = [];   // { ofertaId, mensagem, resolve, reject }
let promessaFila = Promise.resolve(); // cadeia sequencial garantida

function enfileirarEnvio(ofertaId, mensagem) {
  return new Promise((resolve, reject) => {
    const posicao = filaEnvio.length;
    filaEnvio.push({ ofertaId, mensagem, resolve, reject });
    console.log('[ENVIO] Oferta #'+ofertaId+' enfileirada. Posição: '+(posicao+1));

    // Encadeia na promessa atual — garante execução sequencial com delay
    promessaFila = promessaFila.then(() => new Promise(res => {
      const item = filaEnvio.shift();
      if (!item) { res(); return; }
      console.log('[ENVIO] Enviando oferta #'+item.ofertaId+' ('+filaEnvio.length+' restantes na fila)');
      sock.sendMessage(GRUPOS[GRUPO_DESTINO_PASSAGENS], { text: item.mensagem })
        .then(() => {
          item.resolve();
          console.log('[ENVIO] Oferta #'+item.ofertaId+' enviada. Aguardando '+INTERVALO_ENVIO_MS/60000+' min...');
          setTimeout(res, INTERVALO_ENVIO_MS);
        })
        .catch(e => {
          item.reject(e);
          console.error('[ENVIO] Erro ao enviar oferta #'+item.ofertaId+':', e.message);
          setTimeout(res, INTERVALO_ENVIO_MS); // aguarda mesmo em erro
        });
    }));
  });
}

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

// ── CONTAR DATAS TOTAIS ───────────────────────────────────────────────────────
function contarDatas(datasStr) {
  if (!datasStr || datasStr === '-') return 0;
  const matches = datasStr.match(/\b\d{1,2}\b/g);
  return matches ? matches.length : 0;
}

// ── FORMATAR DATAS (quebra de linha por mês) ─────────────────────────────────
function formatarDatas(str) {
  if (!str || str === '-') return '-';
  var resultado = str
    .replace(/([A-Za-záàãâéêíóôõúüç]+\/\d{2}:)/g, '\n$1')
    .replace(/^\n/, '')
    .trim();
  return resultado;
}

function formatarMensagemCDV(d) {
  var n = '\n';
  var rodape = '`Dica de emissão encontrada por @davileles - Clube do Viajante`';
  var balcao = '`Faça parte do Balcão clicando aqui: https://pay.hub.la/TkIbYhix67evTSu1be7c`';
  var cpm = PROGRAMAS_CPM[d.programa] || 0;
  var rawPontos = String(d.pontos||'0').replace(/[.,\s]/g,'');
  var num = parseInt(rawPontos) || 0;
  if (num > 5000000) { console.log('[WARN] Pontos suspeitos: '+d.pontos+' -> '+num+'. Ignorando.'); num = 0; }
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
  msg += '🛫 *DATAS DE IDA*'+n+formatarDatas(d.datasIda)+n+n;
  msg += '🛬 *DATAS DE VOLTA*'+n+formatarDatas(d.datasVolta)+n+n;
  msg += '🎟️ *PROGRAMA* '+d.programa+n+n;
  msg += '✈️ *CIA AÉREA* '+d.cia+n+n;
  msg += '🔗 *LINK* '+link+n+n;
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

// ── LINKS AFILIADOS TSP ────────────────────────────────────────────────────────
const LINKS_TSP = {
  'Amazon':        'https://amzn.to/4dFRSzy',
  'Mercado Livre': 'https://meli.la/2xystLt',
  'Shopee_sem':    'https://s.shopee.com.br/9fHPmP3QZF',
  'Shopee_com':    'https://s.shopee.com.br/30kdYeLY0W',
};

// ── FORMATAR CUPOM TSP ──────────────────────────────────────────────────
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
  } else { msg += '\n\n'; }
  let url = '';
  if (loja === 'Amazon')             url = LINKS_TSP['Amazon'];
  else if (loja === 'Mercado Livre') url = LINKS_TSP['Mercado Livre'];
  else if (loja === 'Shopee')        url = codigo ? LINKS_TSP['Shopee_com'] : LINKS_TSP['Shopee_sem'];
  if (url) msg += `🔗 *RESGATE O CUPOM AQUI* ${url}`;
  msg += '\n\n`Convide seus amigos para entrar aqui no grupo: https://chat.whatsapp.com/HK7NL13BdPXKJPAGtvTKKg`';
  return msg;
}

// ── TELEGRAM CLIENT ───────────────────────────────────────────────────────────
const TG_API_ID   = parseInt(process.env.TG_API_ID   || '0');
const TG_API_HASH = process.env.TG_API_HASH || '';
const TG_SESSION_PATH = SESSAO_DIR + '/telegram_session.txt';
const TG_GRUPO_MONITORADO = process.env.TG_GRUPO || '@juaocupons';

let tgClient = null;
let tgConectado = false;
let tgAuthState = null;
let tgAuthResolve = null;
let tgAuthReject  = null;

async function extrairCupomTelegram(texto) {
  const system = 'Você é um extrator de dados de cupons de desconto para o mercado brasileiro. Analise a mensagem e retorne SOMENTE JSON válido, sem texto extra, sem markdown. Campos: {"eh_cupom": true/false, "loja": "Amazon" | "Mercado Livre" | "Shopee" | "Outro: nome", "tipo": "pct" | "reais", "valor": número, "minimo": número, "limite": número | null, "codigo": "CUPOM" | null, "multiplos": [{valor,minimo,codigo}] | null, "observacao": "texto" | null}. Se não for cupom retorne {"eh_cupom": false}.';
  return await chamarClaude(system, [{ type:'text', text: texto }], 500);
}

async function processarMensagemTelegram(texto) {
  if (!texto?.trim()) return;
  console.log('[TG] Nova mensagem:', texto.slice(0, 80));
  try {
    const campos = await extrairCupomTelegram(texto);
    if (!campos || !campos.eh_cupom) { console.log('[TG] Não é cupom, ignorado.'); return; }
    console.log(`[TG] Cupom: ${campos.loja} | ${campos.valor}${campos.tipo === 'pct' ? '%' : ' R$'}`);
    const lista = campos.multiplos?.length
      ? campos.multiplos.map(m => ({ ...campos, valor: m.valor, minimo: m.minimo, codigo: m.codigo ?? campos.codigo, multiplos: null }))
      : [campos];
    for (const c of lista) {
      const oferta = { id: gerarId(), timestamp: new Date().toISOString(), grupoOrigem: 'telegram:@juaocupons', tipoConteudo: 'cupom_tsp', conteudoOriginal: texto, imagens: [], mensagemFormatada: formatarCupomTSP(c), dadosExtraidos: c, status: 'pendente' };
      filaPendentes.unshift(oferta);
      if (filaPendentes.length > 100) filaPendentes.splice(100);
      salvarFila();
      console.log(`[TG] Cupom #${oferta.id} adicionado — ${c.loja}`);
    }
  } catch(err) { console.error('[TG] Erro:', err.message); }
}

async function iniciarTelegram() {
  if (!TG_API_ID || !TG_API_HASH) { console.log('[TG] Desativado (sem TG_API_ID/HASH).'); return; }
  const sessionStr = existsSync(TG_SESSION_PATH) ? readFileSync(TG_SESSION_PATH, 'utf-8').trim() : '';
  tgClient = new TelegramClient(new StringSession(sessionStr), TG_API_ID, TG_API_HASH, { connectionRetries: 5 });
  await tgClient.start({
    phoneNumber: () => new Promise((res, rej) => { tgAuthState = 'aguardando_telefone'; tgAuthResolve = res; tgAuthReject = rej; }),
    password:    () => new Promise((res, rej) => { tgAuthState = 'aguardando_senha';    tgAuthResolve = res; tgAuthReject = rej; }),
    phoneCode:   () => new Promise((res, rej) => { tgAuthState = 'aguardando_codigo';  tgAuthResolve = res; tgAuthReject = rej; }),
    onError: (err) => { console.error('[TG] Erro auth:', err.message); tgAuthState = 'erro'; },
  });
  writeFileSync(TG_SESSION_PATH, tgClient.session.save(), 'utf-8');
  tgConectado = true; tgAuthState = 'ok';
  console.log(`[TG] Conectado! Monitorando ${TG_GRUPO_MONITORADO}`);
  tgClient.addEventHandler(async (event) => {
    await processarMensagemTelegram(event.message?.message || '');
  }, new NewMessage({ chats: [TG_GRUPO_MONITORADO] }));
}

iniciarTelegram().catch(err => { console.error('[TG] Falha:', err.message); tgAuthState = 'erro'; });

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
      +'\nREGRAS DE EXTRACAO:\n'
      +'1. Se houver multiplas emissoes no TEXTO (separadas por "Oportunidade de resgate", programas diferentes, rotas diferentes ou cidades diferentes), retorne UMA entrada por emissao. NUNCA agrupe emissões diferentes em uma única entrada mesmo que compartilhem uma cidade de origem ou destino. Ex: GRU→MIA e CGH→RAO são DUAS emissões distintas e devem gerar DUAS entradas separadas.\n'
      +'2. Se houver IMAGEM junto com texto: a imagem e um screenshot de confirmacao da PRIMEIRA emissao do texto. Use o texto como fonte principal dos dados (programa, milhas, datas). A imagem serve apenas para confirmar dados visuais nao presentes no texto.\n'
      +'3. Priorize SEMPRE os dados do texto sobre os dados da imagem quando houver conflito.\n'
      +'4. REGRA OBRIGATÓRIA DE DATAS: Qualquer item (imagem ou texto) SÓ é válido se contiver uma lista de datas de disponibilidade explícita (ex: "Junho/26: 11, 12" ou "Datas de ida: ..."). SEM lista de datas = INVÁLIDO, independente de ter origem, destino ou milhas.\n'
      +'5. DESCARTE screenshots de sites de busca (Smiles, LATAM, Azul, etc.) que mostrem apenas resultado de busca sem lista de datas. Ex: tela com "463.000 milhas" e opção de selecionar tarifa mas sem datas listadas = INVÁLIDO.\n'
      +'6. Textos válidos como emissão DEVEM conter: programa de fidelidade, origem, destino E lista de datas. Textos sem lista de datas = INVÁLIDO.\n'
      +'\nIMPORTANTE sobre datas: Use as datas do TEXTO quando disponiveis. So leia datas da imagem se o texto nao tiver datas. Normalize para o formato "Mês/Ano: dias". Ex: "Jun/26: 16, 19, 22".\n'
      +'CRITICO sobre datasIda vs datasVolta: Se o conteudo mencionar explicitamente "Datas de ida" ou "Datas ida", coloque em datasIda. Se mencionar "Datas de volta" ou "Datas volta", coloque em datasVolta. Se a rota for de VOLTA (ex: MIA->GIG sendo a volta de uma emissao GIG->MIA), as datas devem ir em datasVolta.\n'
      +'\nIMPORTANTE sobre cidades: use o nome completo da cidade, nao o codigo IATA. Ex: GRU = São Paulo, GIG = Rio de Janeiro, CUN = Cancún, SCL = Santiago, LIM = Lima, CNF = Belo Horizonte, MAD = Madrid, FOR = Fortaleza, SLZ = São Luís, JPA = João Pessoa, SSA = Salvador, NAT = Natal, MCZ = Maceió, REC = Recife, POA = Porto Alegre, CWB = Curitiba, BSB = Brasília.\n'
      +'CRITICO: use SEMPRE o codigo IATA do texto quando disponivel. Nunca substitua o codigo IATA correto por outro.\n'
      +'CRITICO sobre origem e destino: a ordem importa. GRU→IAH é DIFERENTE de IAH→GRU. Se a imagem/texto mostrar IAH→GRU, a origem é IAH e o destino é GRU. NUNCA inverta a rota. O primeiro código IATA é sempre a ORIGEM, o segundo é sempre o DESTINO.\n'
      +'\nResponda com este JSON (uma entrada por emissao encontrada):\n'
      +'{"resultados":[{"valido":true,"indice":'+i+',"origem":"São Paulo","destino":"Cancún","origemCodigo":"GRU","destinoCodigo":"CUN","cia":"LATAM","programa":"LATAM Pass","pontos":"31494","cabine":"Economica","tipoVoo":"internacional","direcao":"ida_volta","datasIda":"Jun/26: 16, 19, 22","datasVolta":"Jun/26: 22, 23"}]}\n'
      +'Programa deve ser um destes: Smiles, Azul Fidelidade, Azul pelo Mundo, LATAM Pass, Iberia Plus, Privilege Club, Executive Club, TAP, AAdvantage, SUMA, Flying Club, Finnair Plus, Aeroplan.\n'
      +'IMPORTANTE: TudoAzul = Azul Fidelidade. Tudo Azul = Azul Fidelidade. Utilize sempre o nome exato da lista acima.\n'
      +'REGRA CIA AÉREA DOMÉSTICA BRASIL: Para voos domésticos no Brasil, a companhia aérea operadora é SEMPRE determinada pelo programa: Smiles = GOL, LATAM Pass = LATAM, Azul Fidelidade = AZUL, Azul pelo Mundo = AZUL. Não use outra cia para voos domésticos nesses programas.\n'
      +'REGRA IMAGEM SEM TEXTO: Imagens enviadas SOZINHAS (sem texto/caption) de sites de busca de passagens (Azul, LATAM, Smiles, GOL, etc.) mostrando apenas resultado de busca, confirmação de reserva ou tela de seleção de tarifa são INVÁLIDAS — retorne valido:false. Uma imagem isolada só é válida se contiver: origem, destino, programa, pontos E lista de datas explícita.\n'
      +'REGRA IMAGEM COM TEXTO: Quando uma imagem é enviada junto com um texto, o texto é a fonte principal. Se o texto tiver as datas, USE as datas do texto. A imagem serve apenas para confirmar dados visuais ausentes no texto. Se a imagem for de uma rota DIFERENTE do texto (ex: texto é POA→CNF e imagem mostra POA→RIO), a imagem é de outra emissão — IGNORE a imagem e processe apenas o texto.\n'
      +'Cabine deve ser exatamente "Economica" ou "Executiva".\n'
      +'Se NAO houver nenhuma passagem aerea retorne: {"resultados":[{"valido":false,"indice":'+i+'}]}'
    });
    const resultado = await chamarClaude(system, content, 4096);
    const lista = resultado?.resultados || (resultado?.valido !== undefined ? [resultado] : [{ valido:false, indice:i }]);
    for (const r of lista) {
      if (r?.valido) {
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

  const grupos = new Map();
  for (const v of validas) {
    const cidadeA = [v.origemCodigo||v.origem, v.destinoCodigo||v.destino].sort().join('-');
    const chave = (v.programa||'') + '|' + (v.cabine||'Economica') + '|' + cidadeA;
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(v);
  }

  if (grupos.size > 1) {
    console.log('   Pré-agrupamento: '+grupos.size+' grupos distintos detectados — criando emissões separadas');
    const resultado = [];
    for (const [chave, items] of grupos) {
      const origens = new Set(items.map(i => (i.origemCodigo||i.origem||'').toUpperCase()));
      const isIdaVolta = items.length >= 2 && origens.size > 1;

      let v, tipo, datasIda, datasVolta;
      if (isIdaVolta) {
        const itemIda    = items[0];
        const itemVolta  = items.find(i => (i.origemCodigo||i.origem) !== (itemIda.origemCodigo||itemIda.origem)) || items[1];
        v         = itemIda;
        tipo      = 'ida_volta';
        datasIda  = itemIda.datasIda  || itemIda.datasVolta  || '';
        datasVolta= itemVolta.datasIda || itemVolta.datasVolta || '';
        const pontosIda   = parseInt(String(itemIda.pontos).replace(/\D/g,''))||0;
        const pontosVolta = parseInt(String(itemVolta.pontos).replace(/\D/g,''))||0;
        v = { ...itemIda, pontos: Math.max(pontosIda, pontosVolta) };
      } else {
        const temVolta = items.some(i => i.datasVolta && i.datasVolta.trim().length > 0);
        const temIda   = items.some(i => i.datasIda   && i.datasIda.trim().length   > 0);
        if (temIda && temVolta && items.length >= 2) {
          const itemIda   = items.find(i => i.datasIda   && i.datasIda.trim().length   > 0) || items[0];
          const itemVolta = items.find(i => i.datasVolta && i.datasVolta.trim().length > 0) || items[1];
          v         = itemIda;
          tipo      = 'ida_volta';
          datasIda  = itemIda.datasIda   || '';
          datasVolta= itemVolta.datasVolta || '';
          const pontosIda   = parseInt(String(itemIda.pontos).replace(/\D/g,''))||0;
          const pontosVolta = parseInt(String(itemVolta.pontos).replace(/\D/g,''))||0;
          v = { ...itemIda, pontos: Math.max(pontosIda, pontosVolta) };
        } else {
          v = items.reduce((best, cur) => {
            const dBest = contarDatas((best.datasIda||'') + ' ' + (best.datasVolta||''));
            const dCur  = contarDatas((cur.datasIda||'') + ' ' + (cur.datasVolta||''));
            return dCur > dBest ? cur : best;
          }, items[0]);
          tipo       = v.direcao || 'ida';
          datasIda   = v.datasIda  || '';
          datasVolta = v.datasVolta || '';
        }
      }

      const dados = { origem:v.origem, destino:v.destino, pontos:v.pontos, programa:v.programa, cia:v.cia, cabine:v.cabine||'Economica', tipoVoo:v.tipoVoo||'internacional', datasIda, datasVolta };
      resultado.push({ indices:items.map(i=>i.indice), tipo, ...dados, mensagem:formatarMensagemCDV(dados) });
    }
    return resultado;
  }

  const system = 'Voce e especialista em passagens aereas. Agrupe trechos da mesma emissao. Responda APENAS JSON sem markdown.';
  const prompt = 'Agrupe estas '+validas.length+' ofertas que pertencem a mesma emissao. IMPORTANTE: ofertas com rotas distintas (ex: GRU→MIA e CGH→RAO) NAO pertencem à mesma emissao — crie grupos separados para elas.\n\n'
    +'Criterios para pertencer ao MESMO grupo: mesmo programa, mesmas milhas (valores proximos), mesma companhia aerea, mesma cabine, rotas complementares (ex: ida e volta da mesma viagem).\n\n'
    +'REGRAS DE SEPARACAO OBRIGATORIA — sempre crie grupos SEPARADOS quando:\n'
    +'- Programas diferentes (ex: LATAM Pass e Smiles = SEPARADOS)\n'
    +'- Companhias aereas diferentes\n'
    +'- Cabines diferentes (Economica vs Executiva)\n'
    +'- Rotas sem relacao de ida/volta (ex: CNF->SCL e GRU->MIA = SEPARADOS)\n\n'
    +'IMPORTANTE para pontos: use SEMPRE o MENOR valor numerico entre os trechos. Nunca concatene valores. Ex: se ida=72700 e volta=70300, pontos=70300.\n\n'
    +'Ofertas:\n'+JSON.stringify(validas,null,2)+'\n\n'
    +'Responda:\n{"emissoes":[{"indices":[0,1],"tipo":"ida_volta","origem":"São Paulo","destino":"Cancún","origemCodigo":"GRU","destinoCodigo":"CUN","cia":"LATAM","programa":"LATAM Pass","pontos":70300,"cabine":"Economica","tipoVoo":"internacional","datasIda":"Jun/26: 16, 19, 22","datasVolta":"Jun/26: 22, 23"}]}';

  const resultado = await chamarClaude(system, [{ type:'text', text:prompt }], 4096);
  const emissoes  = resultado?.emissoes || [];

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

    const minDatas = GRUPOS_FILTRO_DATAS_MIN[grupoId];
    if (minDatas) {
      const validasFiltradas = validas.filter(v => {
        const total = contarDatas(v.datasIda) + contarDatas(v.datasVolta);
        if (total <= minDatas) {
          console.log('   [FILTRO] Emissão descartada por poucas datas ('+total+' <= '+minDatas+'): '+v.origemCodigo+'->'+v.destinoCodigo);
          return false;
        }
        return true;
      });
      if (validasFiltradas.length === 0) {
        console.log('   [FILTRO] Todas emissões descartadas por poucas datas.');
        return;
      }
      classificacoes.forEach(c => {
        if (c?.valido && !validasFiltradas.includes(c)) c.valido = false;
      });
    }

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
        if (!texto) texto = '[imagem sem legenda]';
      }
    } else { return; }
    if (!texto && !imagemB64) return;

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
      bufferAgrupamento.set(jid, { itens:[], timer:null });
      console.log('Janela deslizante iniciada para '+jid);
    }
    const entrada = bufferAgrupamento.get(jid);

    if (entrada.timer) clearTimeout(entrada.timer);
    entrada.timer = setTimeout(() => processarBuffer(jid), JANELA_AGRUPAMENTO_MS);

    entrada.itens.push({ texto, imagemBase64:imagemB64, timestamp:Date.now() });
    console.log('Buffer: '+entrada.itens.length+' item(ns) | timer reiniciado (+'+JANELA_AGRUPAMENTO_MS/60000+' min)');
  } catch(err) { console.error('Erro ao processar mensagem:', err.message); }
}

// ── WHATSAPP ──────────────────────────────────────────────────────────────────
var HEALTH_CHECK_MS  = 8 * 60 * 1000;
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

var errosDescripto   = 0;
var ERROS_DESCR_MAX  = 15;

async function limparSessaoEReconectar() {
  console.log('[HEALTH] Muitos erros de descriptografia. Limpando sessão e reconectando...');
  conectado = false;
  if (sock) { try { sock.end(new Error('bad-session')); } catch(e) {} sock = null; }
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

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (conectado) resetarHealthTimer();
    console.log('upsert: type='+type+' qtd='+messages.length+' jids='+messages.map(m=>m.key.remoteJid).join(','));
    if (type !== 'notify') return;
    for (const msg of messages) {
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
  res.json({ conectado, qrDisponivel:!!qrAtual, telegramConectado:tgConectado, telegramAuthState:tgAuthState, grupos:Object.keys(GRUPOS), gruposMonitorados:GRUPOS_MONITORADOS, janelaMin:JANELA_AGRUPAMENTO_MS/60000, bufferAtivo:emBuffer, filaPendentes:filaPendentes.filter(o=>o.status==='pendente').length, filaTotal:filaPendentes.length });
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

app.get('/tg-auth', (req, res) => {
  if (tgConectado) return res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>TG Auth</title></head><body style="background:#0d0d0d;color:#22c55e;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:16px"><h2>✅ Telegram conectado!</h2><p style="color:#aaa">Monitorando ' + TG_GRUPO_MONITORADO + '</p><a href="/painel" style="color:#ffa500">Ir para o painel</a></body></html>');
  const labels = { 'aguardando_telefone': { titulo: 'Digite seu número do Telegram', placeholder: '+5511999999999', campo: 'telefone' }, 'aguardando_codigo': { titulo: 'Digite o código de verificação', placeholder: '12345', campo: 'codigo' }, 'aguardando_senha': { titulo: 'Digite sua senha 2FA', placeholder: 'sua senha', campo: 'senha' } };
  const info = labels[tgAuthState] || { titulo: 'Aguardando inicialização...', placeholder: '', campo: '' };
  res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>TG Auth</title><style>body{font-family:sans-serif;background:#0d0d0d;color:#f0f0f0;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;gap:20px;padding:24px}h2{color:#ffa500}input{background:#1a1a1a;border:1px solid #333;border-radius:8px;color:#f0f0f0;font-size:16px;padding:12px 16px;width:280px;outline:none}button{background:#ffa500;color:#000;border:none;border-radius:8px;font-size:15px;font-weight:700;padding:12px 32px;cursor:pointer}p{color:#888;font-size:14px}</style></head><body><h2>🔐 Autenticação Telegram</h2><p>' + info.titulo + '</p>' + (info.campo ? '<input type="text" id="val" placeholder="' + info.placeholder + '" autocomplete="off"/><button onclick="enviar()">Confirmar</button><p id="msg"></p><script>async function enviar(){const v=document.getElementById("val").value.trim();if(!v)return;const r=await fetch("/tg-auth/submit",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({valor:v})});const d=await r.json();document.getElementById("msg").textContent=d.ok?"✓ Enviado! Aguardando...":"Erro: "+d.erro;if(d.ok)setTimeout(()=>location.reload(),2000);}document.getElementById("val").addEventListener("keydown",e=>{if(e.key==="Enter")enviar();});<\/script>' : '<script>setTimeout(()=>location.reload(),3000)<\/script>') + '</body></html>');
});

app.post('/tg-auth/submit', (req, res) => {
  const { valor } = req.body;
  if (!valor?.trim()) return res.status(400).json({ ok:false, erro:'Valor vazio.' });
  if (!tgAuthResolve) return res.status(400).json({ ok:false, erro:'Nenhuma autenticação em andamento.' });
  tgAuthResolve(valor.trim());
  tgAuthResolve = null; tgAuthReject = null;
  res.json({ ok:true });
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
  try {
    const emBuffer = [...bufferAgrupamento.values()].reduce((s,e) => s+e.itens.length, 0);
    const ofertas = filaPendentes.slice(0,50).map(o => ({
      ...o,
      conteudoOriginal: typeof o.conteudoOriginal === 'string' ? o.conteudoOriginal : (Array.isArray(o.conteudoOriginal) ? o.conteudoOriginal.join('\n') : ''),
      imagens: Array.isArray(o.imagens) ? o.imagens : [],
    }));
    res.json({ ok:true, bufferAtivo:emBuffer, ofertas });
  } catch(e) {
    console.error('[PAINEL-JSON] Erro:', e.message);
    res.status(500).json({ ok:false, erro: e.message });
  }
});

app.post('/painel/aprovar/:id', async (req, res) => {
  const id     = parseInt(req.params.id);
  const oferta = filaPendentes.find(o => String(o.id)===String(id));
  if (!oferta)             return res.status(404).json({ ok:false, erro:'Oferta nao encontrada.' });
  if (!conectado || !sock) {
    const ok = await aguardarSock();
    if (!ok) return res.status(503).json({ ok:false, erro:'WhatsApp nao conectado.' });
  }
  const mensagem = req.body.mensagem || oferta.mensagemFormatada;
  const posicao  = filaEnvio.length;
  const tempoMin = posicao * (INTERVALO_ENVIO_MS / 60000);
  try {
    oferta.status = 'aprovado';
    oferta.mensagemFinal = mensagem;
    salvarFila();
    res.json({ ok:true, posicao, tempoMin: tempoMin > 0 ? tempoMin : 0 });
    await enfileirarEnvio(oferta.id, mensagem);
  } catch(err) {
    console.error('[APROVAR] Erro no envio:', err.message);
  }
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
  const oferta = filaPendentes.find(o => String(o.id) === String(id) && o.status === 'pendente');
  if (!oferta) return res.status(404).json({ ok:false, erro:'Oferta não encontrada.' });
  try {
    const itens = [];
    for (const imgB64 of (oferta.imagens || [])) {
      itens.push({ texto: oferta.conteudoOriginal || '', imagemBase64: imgB64, timestamp: Date.now() });
    }
    if (itens.length === 0 && oferta.conteudoOriginal) {
      itens.push({ texto: oferta.conteudoOriginal, imagemBase64: null, timestamp: Date.now() });
    }
    if (itens.length === 0) return res.status(400).json({ ok:false, erro:'Sem conteúdo para reprocessar.' });
    console.log('[REPROCESS] Reprocessando oferta #'+id+' com '+itens.length+' item(ns)');
    const classificacoes = await classificarItens(itens);
    const validas = classificacoes.filter(c => c.valido);
    if (validas.length === 0) return res.json({ ok:false, erro:'Nenhuma emissão válida encontrada.' });
    const emissoes = await agruparEFormatar(classificacoes);
    if (emissoes.length === 0) return res.json({ ok:false, erro:'Agrupamento retornou 0 emissões.' });
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

app.post('/painel/mesclar', (req, res) => {
  const { id1, id2 } = req.body;
  if (!id1 || !id2) return res.status(400).json({ ok:false, erro:'ids necessarios.' });
  const o1 = filaPendentes.find(o => String(o.id)===String(id1) && o.status==='pendente');
  const o2 = filaPendentes.find(o => String(o.id)===String(id2) && o.status==='pendente');
  if (!o1 || !o2) return res.status(404).json({ ok:false, erro:'Uma ou ambas ofertas nao encontradas ou ja processadas.' });
  const toArray = v => Array.isArray(v) ? v : (v ? [v] : []);
  const textosMesclados  = [...toArray(o1.conteudoOriginal), ...toArray(o2.conteudoOriginal)];
  const imagensMescladas = [...(o1.imagens||[]), ...(o2.imagens||[])];
  const msg1 = (o1.mensagemFormatada||'').trim();
  const msg2 = (o2.mensagemFormatada||'').trim();
  const mensagemMesclada = msg1 + (msg1 && msg2 ? '\n\n' : '') + msg2;
  o1.conteudoOriginal  = textosMesclados;
  o1.imagens           = imagensMescladas;
  o1.mensagemFormatada = mensagemMesclada;
  o1.tipoConteudo      = 'mesclado';
  o1.timestamp         = new Date().toISOString();
  o2.status = 'mesclado';
  salvarFila();
  res.json({ ok:true, id: o1.id, mensagemMesclada });
});

app.post('/painel/limpar', (req, res) => {
  const { confirmar } = req.body;
  if (confirmar !== 'sim') return res.status(400).json({ ok:false, erro:'Envie { "confirmar": "sim" } para confirmar.' });
  const antes = filaPendentes.length;
  filaPendentes.forEach(o => { if (o.status === 'pendente') o.status = 'rejeitado'; });
  salvarFila();
  const depois = filaPendentes.filter(o => o.status === 'pendente').length;
  console.log('[LIMPAR] '+antes+' ofertas, '+depois+' pendentes restantes.');
  res.json({ ok:true, antes, depois });
});

app.post('/injetar', async (req, res) => {
  const { texto } = req.body;
  if (!texto || !texto.trim()) return res.status(400).json({ ok:false, erro:'Texto vazio.' });
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

app.post('/enviar', async (req, res) => {
  const { grupo, mensagem } = req.body;
  if (!conectado || !sock) {
    const ok = await aguardarSock();
    if (!ok) return res.status(503).json({ ok:false, erro:'WhatsApp nao conectado.' });
  }
  const grupoId = resolverGrupo(grupo);
  if (!grupoId) return res.status(400).json({ ok:false, erro:'Grupo invalido: '+grupo });
  if (!mensagem?.trim()) return res.status(400).json({ ok:false, erro:'Mensagem vazia.' });

  const isEmissao = grupo === 'cdv_emissao' || grupoId === GRUPOS['cdv_emissao'];
  if (isEmissao) {
    const posicao = filaEnvio.length;
    const tempoMin = posicao * (INTERVALO_ENVIO_MS / 60000);
    try {
      res.json({ ok:true, posicao, tempoMin: tempoMin > 0 ? tempoMin : 0 });
      await enfileirarEnvio('manual', mensagem);
    } catch(err) { console.error('[ENVIAR] Erro no envio:', err.message); }
  } else {
    try { await sock.sendMessage(grupoId, { text:mensagem }); res.json({ ok:true }); }
    catch(err) { res.status(500).json({ ok:false, erro:err.message }); }
  }
});

app.post('/enviar-imagem', upload.single('imagem'), async (req, res) => {
  const { grupo, legenda } = req.body;
  const file = req.file;
  if (!conectado || !sock) {
    const ok = await aguardarSock();
    if (!ok) { if(file) unlinkSync(file.path); return res.status(503).json({ ok:false, erro:'WhatsApp nao conectado.' }); }
  }
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
  if (!sock) return res.status(503).json({ ok:false, erro:'sock null — aguarde reconexao.' });
  if (!conectado) return res.status(503).json({ ok:false, erro:'WhatsApp nao conectado (conectado=false).' });
  try {
    const chats  = await sock.groupFetchAllParticipating();
    const grupos = Object.values(chats).map(g => ({ id:g.id, nome:g.subject||'(sem nome)' })).sort((a,b) => a.nome.localeCompare(b.nome,'pt-BR'));
    res.json({ ok:true, total:grupos.length, grupos });
  } catch(err) { res.status(500).json({ ok:false, erro:'groupFetchAllParticipating falhou: '+err.message }); }
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
  const ev = payload.event;
  if (!ev) return null;
  return (
    ev.member?.phone ||
    ev.member?.user?.phone ||
    ev.subscriber?.phone ||
    ev.customer?.phone ||
    ev.user?.phone ||
    null
  );
}

function extrairNome(payload) {
  const ev = payload.event;
  if (!ev) return 'novo membro';
  const nomeCompleto =
    ev.member?.fullName ||
    ev.member?.name ||
    ev.member?.user?.name ||
    ev.subscriber?.name ||
    ev.customer?.name ||
    ev.user?.name ||
    null;
  if (!nomeCompleto) return 'novo membro';
  return nomeCompleto.split(' ')[0];
}

app.post('/webhook/hubla', async (req, res) => {
  try {
    const tokenRecebido = req.headers['x-hubla-token'];
    const tokenEsperado = process.env.HUBLA_TOKEN;

    if (!tokenEsperado) {
      console.error('[Hubla] HUBLA_TOKEN não configurado nas variáveis de ambiente');
      return res.status(500).json({ error: 'Configuração interna ausente' });
    }

    if (!tokenRecebido || tokenRecebido !== tokenEsperado) {
      console.warn('[Hubla] Token inválido ou ausente');
      return res.status(401).json({ error: 'Token inválido' });
    }

    const payload = req.body;
    const tipo = payload?.type;

    console.log(`[Hubla] Evento recebido: ${tipo}`);

    if (tipo !== 'customer.member_added') {
      console.log(`[Hubla] Evento ignorado: ${tipo}`);
      return res.status(200).json({ status: 'ignorado', tipo });
    }

    const telefone = extrairTelefone(payload);
    const nome = extrairNome(payload);

    if (!telefone) {
      console.warn('[Hubla] Telefone não encontrado. Payload completo:', JSON.stringify(payload, null, 2));
      return res.status(200).json({ status: 'sem_telefone', tipo });
    }

    const numeroFormatado = formatarNumero(telefone);
    const mensagem = MENSAGEM_BOAS_VINDAS(nome);

    console.log(`[Hubla] Enviando boas-vindas para ${nome} (${numeroFormatado})`);

    if (!conectado || !sock) {
      const ok = await aguardarSock();
      if (!ok) {
        console.error('[Hubla] WhatsApp não conectado ao tentar enviar boas-vindas');
        return res.status(503).json({ error: 'WhatsApp não conectado' });
      }
    }

    await sock.sendMessage(numeroFormatado, { text: mensagem });

    console.log(`[Hubla] ✅ Boas-vindas enviadas com sucesso para ${nome}`);
    return res.status(200).json({ status: 'enviado', para: nome });

  } catch (err) {
    console.error('[Hubla] Erro ao processar webhook:', err);
    return res.status(500).json({ error: 'Erro interno' });
  }
});

// ── INICIAR ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('Servidor na porta '+PORT);
  console.log('Monitorando: '+GRUPOS_MONITORADOS.join(', '));
  console.log('Janela de agrupamento: '+JANELA_AGRUPAMENTO_MS/60000+' min');
});

conectar();
