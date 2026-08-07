import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  initAuthCreds,
  BufferJSON,
  proto,
} from '@whiskeysockets/baileys';
import express from 'express';
import cors from 'cors';
import pino from 'pino';
import multer from 'multer';
import { Boom } from '@hapi/boom';
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { readdir, unlink, writeFile as writeFileAsync, readFile as readFileAsync, rename as renameAsync, mkdir as mkdirAsync } from 'fs/promises';
import { join } from 'path';
import QRCode from 'qrcode';

// ── RADAR DE MARKETPLACE (Amazon hoje; ML e Shopee entram pelo mesmo pipeline) ─
import {
  carregarRadarConfig, salvarRadarConfig, radarConfig,
  radarFontes, radarDestinos, ehFonteRadar,
  processarTextoAmazon,
  registrarCupomBase, listarCuponsBase, atualizarCupomBase, removerCupomBase, definirAtivoPorLoja,
  listarTemplates, templateDaLoja, salvarTemplate, removerTemplate,
  renderTemplate, varsDoProduto, VARIAVEIS_TEMPLATE,
  resolverLinhaVitrine, listarVitrine, salvarItemVitrine, removerItemVitrine,
  itemVitrine, marcarDisparo, montarOfertasVitrine,
  listarMonitor, monitorDoGrupo, salvarMonitor, removerMonitor,
  podeCapturar, LOJAS_MONITORAVEIS, semearMonitorDasFontes,
  carregarCuponsBase, carregarTemplates, carregarVitrine,
} from './radar-amazon.js';

// ── SINCRONIZACAO COM O GITHUB ────────────────────────────────────────────────
import {
  baixarDoGitHub, pushImediato, estadoSync, sincronizacaoAtiva, testarAcesso,
} from './sync-github.js';

// ── RADAR SHOPEE ──────────────────────────────────────────────────────────────
import {
  processarTextoShopee, ehLinkShopee, extrairIdsShopee, buscarProdutoShopee,
  normalizarShopee, credenciaisShopeeOk, montarOfertasShopeeVitrine,
  validarAtribuicao,
} from './radar-shopee.js';

// ── TELEGRAM ──────────────────────────────────────────────────────────────────
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Raw, NewMessage } from 'telegram/events/index.js';
import { Api } from 'telegram';

// ── LOGGER CUSTOMIZADO (suprimir ruído do Baileys) ───────────────────────────
const baileysLogger = pino({ level: 'silent' });

// Intercepta console.log/warn para suprimir dumps de criptografia do Baileys
// que causam rate limit de 500 logs/s no Railway e derrubam o processo.
// Filtro de noise removido temporariamente para diagnóstico.

// Boot: o GitHub e a copia durável. Os modulos ja carregaram do disco no import;
// depois do download recarregam, agora com o conteudo do repositorio.
(async () => {
  try {
    const r = await baixarDoGitHub();
    if (r.baixados) {
      carregarRadarConfig(); carregarCuponsBase(); carregarTemplates(); carregarVitrine();
      semearMonitorDasFontes();
      console.log('[SYNC] Modulos recarregados a partir do repositorio.');
    }
  } catch (e) { console.error('[SYNC] Falha no boot:', e.message); }
})();

// ── HANDLERS DE ERRO GLOBAIS ──────────────────────────────────────────────────
process.on('uncaughtException',  (err) => console.error('[FATAL] uncaughtException:', err.message, err.stack));
process.on('unhandledRejection', (err) => console.error('[FATAL] unhandledRejection:', err?.message || err));

// ── GRUPOS DE DESTINO ─────────────────────────────────────────────────────────
const GRUPOS = {
  tsp:         '120363424721106736@g.us',
  // Grupo exclusivo de cupons — recebe copia de todo cupom_tsp com rodape
  // convidando para o grupo de ofertas (convite cruzado).
  tsp_cupons:  '120363410183381243@g.us',
  cdv_ofertas: '120363170138704529@g.us',
  cdv_emissao: '120363172490263905@g.us',
  // Grupo interno do operador — avisos operacionais que NAO vao para clientes
  // (novo cupom capturado, falha de coleta, etc).
  operador:    '120363409136599326@g.us',
};
const GRUPOS_MONITORADOS      = [
  '120363430801699326@g.us',
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

// ── AUTH STATE ATÔMICO ────────────────────────────────────────────────────────
// Substitui o useMultiFileAuthState do Baileys mantendo o MESMO formato de
// arquivos (100% compatível com a sessão existente em ./sessao), mas com duas
// proteções que ele não tem:
//   1. Escrita atômica: grava em arquivo .tmp e faz rename() — um restart do
//      Railway no meio de um write nunca mais deixa JSON truncado (causa raiz
//      clássica de "Bad MAC" / "Failed to decrypt").
//   2. Escritas serializadas: uma cadeia única de Promise evita dois writes
//      concorrentes no mesmo arquivo de chave.
async function useAuthStateAtomico(pasta) {
  await mkdirAsync(pasta, { recursive: true });
  const fixFileName = (file) => file?.replace(/\//g, '__')?.replace(/:/g, '-');
  let cadeiaEscrita = Promise.resolve();

  const writeData = (data, file) => {
    const destino = join(pasta, fixFileName(file));
    const tmp = destino + '.tmp';
    cadeiaEscrita = cadeiaEscrita
      .then(async () => {
        await writeFileAsync(tmp, JSON.stringify(data, BufferJSON.replacer));
        await renameAsync(tmp, destino);
      })
      .catch(e => console.error('[AUTH] Erro ao gravar', file, '-', e.message));
    return cadeiaEscrita;
  };

  const readData = async (file) => {
    try {
      const raw = await readFileAsync(join(pasta, fixFileName(file)), 'utf-8');
      return JSON.parse(raw, BufferJSON.reviver);
    } catch { return null; }
  };

  const removeData = async (file) => {
    try { await unlink(join(pasta, fixFileName(file))); } catch {}
  };

  const creds = (await readData('creds.json')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async (id) => {
            let value = await readData(type + '-' + id + '.json');
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }));
          return data;
        },
        set: async (data) => {
          const tarefas = [];
          for (const categoria in data) {
            for (const id in data[categoria]) {
              const value = data[categoria][id];
              const file = categoria + '-' + id + '.json';
              tarefas.push(value ? writeData(value, file) : removeData(file));
            }
          }
          await Promise.all(tarefas);
        },
      },
    },
    saveCreds: () => writeData(creds, 'creds.json'),
  };
}

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

// ── DEDUPLICAÇÃO DE CUPONS TSP ────────────────────────────────────────────────
// Ignora cupons já vistos (mesma loja + código) nas últimas N horas.
// Persiste em disco para sobreviver a restarts.
const CUPONS_VISTOS_PATH = SESSAO_DIR + '/cupons_vistos.json';
// TTL de 24h: cupons costumam durar mais que 6h e, com auto-envio ligado, um
// repost do mesmo cupom 7h depois viraria mensagem duplicada para os clientes.
const CUPONS_VISTOS_TTL_MS = 24 * 60 * 60 * 1000; // 24 horas

let _cuponsVistos = {};

function carregarCuponsVistos() {
  try {
    if (existsSync(CUPONS_VISTOS_PATH)) {
      _cuponsVistos = JSON.parse(readFileSync(CUPONS_VISTOS_PATH, 'utf-8'));
      console.log('[DEDUP] Cupons vistos carregados:', Object.keys(_cuponsVistos).length);
    }
  } catch(e) { console.warn('[DEDUP] Erro ao carregar cupons_vistos:', e.message); _cuponsVistos = {}; }
}

function salvarCuponsVistos() {
  try {
    // Limpa entradas expiradas antes de salvar
    const agora = Date.now();
    for (const k of Object.keys(_cuponsVistos)) {
      if (agora - _cuponsVistos[k] > CUPONS_VISTOS_TTL_MS) delete _cuponsVistos[k];
    }
    writeFileSync(CUPONS_VISTOS_PATH, JSON.stringify(_cuponsVistos), 'utf-8');
  } catch(e) { console.warn('[DEDUP] Erro ao salvar cupons_vistos:', e.message); }
}

// Normaliza forte para que "Outro: Casas Bahia", "outro: casasbahia" e
// "Casas Bahia" gerem a MESMA chave. Sem isso, os dois canais monitorados
// escrevendo a loja de formas diferentes furam a deduplicacao.
function normalizarDedup(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // remove acentos
    .replace(/^outro:\s*/, '')
    .replace(/[^a-z0-9]/g, '');
}

function chaveDedup(cupom) {
  const lojaKey = normalizarDedup(cupom?.loja) || 'outros';
  const codKey  = normalizarDedup(cupom?.codigo);
  // Com codigo: loja+codigo identifica o cupom sem ambiguidade.
  // Sem codigo (caso Shopee): usar so "__sem_codigo__" faria QUALQUER cupom sem
  // codigo da mesma loja dedupar contra outro na janela, suprimindo cupons
  // legitimamente diferentes. Entao a chave incorpora tipo+valor+minimo.
  if (codKey) return `${lojaKey}:${codKey}`;
  const tipo   = normalizarDedup(cupom?.tipo) || 'x';
  const valor  = Number(cupom?.valor)  || 0;
  const minimo = Number(cupom?.minimo) || 0;
  return `${lojaKey}:sc:${tipo}:${valor}:${minimo}`;
}

function cupomJaVisto(cupom) {
  const chave = chaveDedup(cupom);
  const ts = _cuponsVistos[chave];
  if (!ts) return false;
  if (Date.now() - ts > CUPONS_VISTOS_TTL_MS) {
    delete _cuponsVistos[chave];
    return false;
  }
  return true;
}

function registrarCupomVisto(cupom) {
  const chave = chaveDedup(cupom);
  _cuponsVistos[chave] = Date.now();
  salvarCuponsVistos();
}

carregarCuponsVistos();

function carregarFila() {
  try {
    if (existsSync(FILA_PATH)) {
      const dados = JSON.parse(readFileSync(FILA_PATH, 'utf-8'));
      filaPendentes.push(...dados);
      console.log('[FILA] Carregadas ' + dados.length + ' ofertas do disco.');
    }
  } catch(e) { console.log('[FILA] Erro ao carregar fila:', e.message); }
}

// Tipos que o painel Gestao TSP trata como oferta de marketplace. Amazon hoje;
// ML e Shopee entram aqui sem mudar mais nada no roteamento.
const TIPOS_OFERTA_MARKETPLACE = new Set(['oferta_amazon', 'oferta_ml', 'oferta_shopee']);

function limparFila() {
  const agora = Date.now();
  const LIMITE_PENDENTE = 18 * 60 * 60 * 1000; // pendentes somem 18h após a captura
  const LIMITE_CUPOM_TSP = 12 * 60 * 60 * 1000; // cupons expiram rápido
  const LIMITE_PROCESSADAS_MS = 24 * 60 * 60 * 1000;
  const LIMITE_PROCESSADAS = 20;

  // 1. Remove ofertas expiradas, sempre contando a partir de item.timestamp
  //    (momento em que a captura foi registrada na fila):
  //    - pendente: 18h — se não foi aprovada nesse prazo, sai sozinha
  //    - pendente do tipo cupom_tsp: 12h, pois perde validade antes
  //    - já processada (aprovado/agendado/enviado/rejeitado): 24h, só histórico
  for (let i = filaPendentes.length - 1; i >= 0; i--) {
    const item = filaPendentes[i];
    const ts = new Date(item.timestamp).getTime();
    if (!ts || isNaN(ts)) continue;

    let limite;
    if (item.status !== 'pendente') limite = LIMITE_PROCESSADAS_MS;
    else if (item.tipoConteudo === 'cupom_tsp') limite = LIMITE_CUPOM_TSP;
    // Oferta de produto envelhece igual cupom: preco muda e estoque acaba.
    else if (TIPOS_OFERTA_MARKETPLACE.has(item.tipoConteudo)) limite = LIMITE_CUPOM_TSP;
    else limite = LIMITE_PENDENTE;

    if (agora - ts > limite) filaPendentes.splice(i, 1);
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

// ── Reaplica links de afiliado em cupons TSP já pendentes ────────────────────
// Quando o formatador passa a conhecer um link novo (ex.: Magazine Luiza), os
// cupons que já estavam na fila continuariam sem o bloco de resgate. Esta
// varredura regenera a mensagem a partir de dadosExtraidos, mas SOMENTE quando
// a mensagem atual está sem link — nunca sobrescreve algo que já tem link nem
// edições manuais feitas no painel.
function reformatarCupomsTSPPendentes() {
  let n = 0;
  for (const o of filaPendentes) {
    if (o.tipoConteudo !== 'cupom_tsp' || o.status !== 'pendente') continue;
    if (!o.dadosExtraidos) continue;
    if ((o.mensagemFormatada || '').includes('RESGATE O CUPOM AQUI')) continue;
    const nova = formatarCupomTSP(o.dadosExtraidos);
    if (!nova.includes('RESGATE O CUPOM AQUI')) continue; // loja sem link cadastrado
    o.mensagemFormatada = nova;
    n++;
  }
  if (n > 0) {
    salvarFila();
    console.log('[FILA] ' + n + ' cupom(ns) TSP pendente(s) reformatado(s) com link de afiliado.');
  }
  return n;
}
// A chamada de boot fica LOGO APÓS a definição de LINKS_TSP/formatarCupomTSP:
// a função é hoisted, mas LINKS_TSP é `const` e estaria em TDZ aqui.

// Varredura periódica (15 min): garante que a expiração de 18h aconteça mesmo
// sem ninguém abrir o painel ou aprovar/rejeitar nada.
setInterval(() => {
  const antes = filaPendentes.length;
  salvarFila();
  const removidos = antes - filaPendentes.length;
  if (removidos > 0) console.log('[FILA] Varredura automática removeu ' + removidos + ' item(ns) expirado(s).');
}, 15 * 60 * 1000);

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
    const resultado = await sock.sendMessage(destino, conteudo);
    guardarMensagemEnviada(resultado);
    return resultado;
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
      if (ofertaEnviada) {
        ofertaEnviada.status = 'enviado';
        ofertaEnviada.enviadoEm = new Date().toISOString();
        salvarFila();
      }

      // ÚNICO ponto de gravação definitiva em passagens.json (fonte 'alerta').
      // Antes da aprovação o pré-registro roda com apenasConsulta:true, então
      // só emissões efetivamente enviadas entram no histórico divulgado.
      // Fallback em item.dados cobre agendamentos cuja oferta já saiu da fila.
      const de = ofertaEnviada?.dadosExtraidos || item.dados || {};
      if (de.origem && de.destino && de.programa && ofertaEnviada?.tipoConteudo !== 'cupom_tsp') {
        registrarPassagemProxy({
          origem:      de.origem,
          destino:     de.destino,
          cia:         de.cia || '',
          programa:    de.programa,
          pontos:      Number(de.pontos) || 0,
          cabine:      de.cabine || 'Economica',
          datas_ida:   de.datasIda || '',
          datas_volta: de.datasVolta || '',
          fonte:       'alerta',
        }).catch(() => {});
      }

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

function enfileirarEnvio(ofertaId, mensagem, grupoAlvo, dados) {
  const destino = grupoAlvo || GRUPOS[GRUPO_DESTINO_PASSAGENS];
  const posicao = filaEnvio.length;
  // dados: snapshot de dadosExtraidos usado como fallback no registro de passagem
  // quando a oferta já saiu de filaPendentes (agendamentos de mais de 24h).
  filaEnvio.push({ ofertaId, mensagem, destino, dados: dados || null });
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
    if (isEmissao && !ag.direto) {
      enfileirarEnvio(ag.ofertaId ?? ('ag-'+ag.id), ag.mensagem, grupoId, ag.dados || null);
    } else {
      enviarMensagem(grupoId, { text: ag.mensagem })
        .then(() => { ag.status = 'enviado'; salvarAgendamentos(); })
        .catch(e  => { ag.status = 'erro';   salvarAgendamentos(); console.error('[AGEND] Erro envio:', e.message); });
    }
    console.log('[AGEND] Disparando agendamento #'+ag.id+' para grupo '+ag.grupo);
  }
}, 30 * 1000);

// ── Limpeza automática da fila (a cada 15 min) — nível do módulo ────────────
setInterval(() => {
  const antes = filaPendentes.length;
  limparFila();
  salvarFila();
  const depois = filaPendentes.length;
  if (antes !== depois) console.log('[FILA] Limpeza automática: ' + (antes - depois) + ' oferta(s) removida(s).');
}, 15 * 60 * 1000);

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
  // Ampliacao para cobrir as cidades mais frequentes da base de emissoes que
  // ainda nao tinham codigo — sem codigo o link cai no destino padrao.
  'NVT':'Navegantes','VIX':'Vitória','GYN':'Goiânia','IGU':'Foz do Iguaçu',
  'BPS':'Porto Seguro','UDI':'Uberlândia','CGR':'Campo Grande','CGB':'Cuiabá',
  'JOI':'Joinville','FEN':'Fernando de Noronha','LDB':'Londrina','PNZ':'Petrolina',
  'BYO':'Bonito','IOS':'Ilhéus','MGF':'Maringá','RAO':'Ribeirão Preto',
  'AUA':'Aruba','CTG':'Cartagena','PUJ':'Punta Cana','ADZ':'San Andrés',
  'MDZ':'Mendoza','UIO':'Quito','CUR':'Curaçao','CUZ':'Cusco','BRC':'Bariloche',
  'SJO':'San José','IAD':'Washington','YYZ':'Toronto','YUL':'Montreal',
  'OPO':'Porto','FNC':'Madeira','LPA':'Las Palmas','EDI':'Edimburgo',
  'BRU':'Bruxelas','GVA':'Genebra','NCE':'Nice','VCE':'Veneza','ZAG':'Zagreb',
  'IST':'Istambul','TPE':'Taipei','NGO':'Nagoia','HNL':'Honolulu',
};

// Grafias alternativas que a IA as vezes devolve em ingles ou sem acento.
const CIDADE_ALIAS = {
  'amsterdam':'Amsterdã', 'cape town':'Cidade do Cabo', 'sao francisco':'São Francisco',
  'san jose':'San José', 'uberlandia':'Uberlândia', 'mexico city':'Cidade do México',
  'new york':'Nova York', 'lisbon':'Lisboa', 'rome':'Roma', 'milan':'Milão',
  'panama city':'Cidade do Panamá', 'shangai':'Xangai', 'singapora':'Singapura',
};

// Reverso de IATA_CIDADES: cidade → aeroporto principal. Como o objeto acima
// lista o aeroporto principal primeiro em cada cidade (GRU antes de CGH, GIG
// antes de SDU, EZE antes de AEP, JFK antes de EWR/LGA, NRT antes de HND), a
// regra "primeiro vence" ja entrega a escolha certa.
const CIDADE_IATA = (function () {
  const m = {};
  for (const cod of Object.keys(IATA_CIDADES)) {
    const chave = normalizarCidade(IATA_CIDADES[cod]);
    if (!m[chave]) m[chave] = cod;
  }
  return m;
})();

function normalizarCidade(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function iataDaCidade(nome) {
  const k = normalizarCidade(nome);
  if (CIDADE_IATA[k]) return CIDADE_IATA[k];
  const alias = CIDADE_ALIAS[k];
  return alias ? (CIDADE_IATA[normalizarCidade(alias)] || null) : null;
}

// ── Extracao de datas do texto livre de datasIda / datasVolta ────────────────
// Os formatos usados nas mensagens sao "Ago/26: 15, 20", "18, 20 de Junho" e
// "26,27/03;04/06". Devolve ISO ordenado; o link usa a PRIMEIRA ida e a ULTIMA
// volta, que e o intervalo que cobre a oferta inteira.
const MESES_NUM = { jan:1, fev:2, mar:3, abr:4, mai:5, jun:6, jul:7, ago:8, set:9, out:10, nov:11, dez:12 };

function extrairDatasISO(str, ref) {
  const txt = String(str || '').trim();
  if (!txt || txt === '-') return [];
  const hoje = ref instanceof Date ? ref : new Date();
  const out = new Set();
  const add = (a, mes, dia) => {
    const d = new Date(Date.UTC(a, mes - 1, dia));
    if (d.getUTCMonth() === mes - 1 && d.getUTCDate() === dia) out.add(d.toISOString().slice(0, 10));
  };
  const anoImplicito = (mes) => (mes >= hoje.getUTCMonth() + 1 ? hoje.getUTCFullYear() : hoje.getUTCFullYear() + 1);
  const expandir = (t) => {
    const dias = [];
    for (const p of String(t).split(/[,\s]+|\se\s/)) {
      const f = p.trim().match(/^(\d{1,2})\s*[-\u2013a]\s*(\d{1,2})$/);
      if (f) { const a = +f[1], b = +f[2]; if (a <= b && b <= 31) for (let x = a; x <= b; x++) dias.push(x); }
      else if (/^\d{1,2}$/.test(p.trim())) dias.push(+p.trim());
    }
    return dias;
  };
  const mesDe = (n) => MESES_NUM[normalizarCidade(n).slice(0, 3)];

  // "Ago/26: 15, 20"  |  "Marco: 03, 09-11"
  let achou = false;
  const re1 = /([A-Za-z\u00C0-\u00FF]{3,10})\s*(?:\/\s*(\d{2,4}))?\s*:\s*([0-9][0-9,\s\-\u2013]*)/g;
  let m;
  while ((m = re1.exec(txt))) {
    const mes = mesDe(m[1]); if (!mes) continue;
    const ano = m[2] ? (+m[2] < 100 ? 2000 + +m[2] : +m[2]) : anoImplicito(mes);
    for (const d of expandir(m[3])) { add(ano, mes, d); achou = true; }
  }
  // "18, 20 de Junho [2026]"
  if (!achou) {
    const re2 = /([0-9][0-9,\s\-\u2013]*?)\s*(?:de\s+)?([A-Za-z\u00C0-\u00FF]{3,10})\s*(\d{4})?/g;
    while ((m = re2.exec(txt))) {
      const mes = mesDe(m[2]); if (!mes) continue;
      const ano = m[3] ? +m[3] : anoImplicito(mes);
      for (const d of expandir(m[1])) { add(ano, mes, d); achou = true; }
    }
  }
  // "26,27/03;04/06"
  if (!achou) {
    const re3 = /(\d{1,2}(?:\s*[-\u2013]\s*\d{1,2})?)\s*\/\s*(\d{1,2})(?!\d)/g;
    while ((m = re3.exec(txt))) {
      const mes = +m[2]; if (mes < 1 || mes > 12) continue;
      for (const d of expandir(m[1])) add(anoImplicito(mes), mes, d);
    }
  }
  return [...out].sort();
}

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
// Links mascarados do Clube do Viajante. O destino real (com os parametros de
// afiliado) vive em painel-cdv/links.json e e resolvido pelo endpoint /ir do
// proxy. Para trocar um destino NAO mexa aqui: edite links.json.
// ATENCAO: manter os slugs iguais aos de gerador-cdv/index.html (PROGRAMAS_SLUG).
const IR_BASE = 'https://ir.clubedoviajante.com.br/';
const PROGRAMAS_SLUG = {
  'Smiles':'smiles',
  'Azul Fidelidade':'azul',
  'Azul pelo Mundo':'azul-mundo',
  'LATAM Pass':'latam',
  'Iberia Plus':'iberia',
  'Privilege Club':'qatar',
  'Executive Club':'british',
  'TAP':'tap',
  'AAdvantage':'aadvantage',
  'SUMA':'suma',
  'Flying Club':'virgin',
  'Finnair Plus':'finnair',
  'Aeroplan':'aeroplan'
};
// Programas cujo link mascarado aceita a busca ja preenchida (o proxy monta a
// URL final em BUSCA_BUILDERS). Adicionar aqui conforme forem mapeados.
const PROGRAMAS_COM_BUSCA = new Set(['smiles']);

function linkPrograma(programa, origem, busca) {
  const slug = PROGRAMAS_SLUG[programa];
  if (!slug) {
    console.warn('[links] programa sem slug cadastrado:', programa);
    return '';
  }
  const qs = [];
  if (origem) qs.push('o=' + encodeURIComponent(origem));
  if (busca && PROGRAMAS_COM_BUSCA.has(slug) && busca.bo && busca.bd && busca.bi) {
    qs.push('bo=' + busca.bo, 'bd=' + busca.bd, 'bi=' + busca.bi);
    if (busca.bv) qs.push('bv=' + busca.bv);
    if (busca.bc) qs.push('bc=' + busca.bc);
  }
  return IR_BASE + slug + (qs.length ? '?' + qs.join('&') : '');
}

// Monta os parametros de busca a partir dos dados da emissao.
// Regra: primeira data de ida; se houver volta, a ULTIMA data de volta.
function buscaDaEmissao(d) {
  const bo = iataDaCidade(d.origem), bd = iataDaCidade(d.destino);
  if (!bo || !bd) return null;   // cidade fora da tabela IATA: link continua o padrao
  const idas = extrairDatasISO(d.datasIda);
  if (!idas.length) return null;
  const bi = idas[0];
  // A lista de volta nem sempre pertence a mesma combinacao da ida — ha ofertas
  // com voltas anteriores a primeira ida. Volta antes da ida faria a Smiles
  // recusar a busca, entao nesse caso o link sai como so-ida.
  const voltas = extrairDatasISO(d.datasVolta).filter((v) => v >= bi);
  return {
    bo, bd,
    bi,
    bv: voltas.length ? voltas[voltas.length - 1] : '',
    bc: /execut|business/i.test(d.cabine || '') ? 'exec' : 'eco',
  };
}

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

// ── CAMPOS EDITAVEIS DO PAINEL ───────────────────────────────────────────────
// Os campos abaixo sao a fonte unica de verdade da emissao: o que o operador
// corrige no painel vale tanto para a mensagem que sai no grupo quanto para o
// registro em passagens.json (gravado pelo worker de envio a partir de
// dadosExtraidos). Metadados internos (indices, origemCodigo, tipo, indice)
// nao sao editaveis e ficam preservados.
const CAMPOS_EDITAVEIS_ALERTA = ['origem','destino','cia','programa','pontos','cabine','tipoVoo','datasIda','datasVolta'];

function aplicarDadosEditados(oferta, dados) {
  // Sem payload de campos (ex: painel HTML interno do Baileys), nao mexe em nada.
  if (!dados || typeof dados !== 'object') return oferta.dadosExtraidos || {};
  if (!oferta.dadosExtraidos) oferta.dadosExtraidos = {};
  const de = oferta.dadosExtraidos;
  for (const k of CAMPOS_EDITAVEIS_ALERTA) {
    const v = dados[k];
    if (v === undefined || v === null) continue;
    de[k] = String(v).trim();
  }
  return de;
}

// Corrige a grafia da cabine APENAS para exibicao. O valor canonico interno
// segue sem acento ("Economica"), porque a deduplicacao de emissoes e o
// registro em passagens.json comparam esse formato por igualdade estrita.
function rotuloCabine(c) {
  var s = String(c == null ? '' : c).trim();
  if (!s) return 'Econômica';
  var base = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  var alta = s === s.toUpperCase();
  var MAP = {
    'economica': 'Econômica',
    'economy': 'Econômica',
    'economica premium': 'Econômica Premium',
    'premium economica': 'Premium Econômica',
    'executiva': 'Executiva',
    'business': 'Executiva',
    'primeira classe': 'Primeira Classe'
  };
  var r = MAP[base];
  if (!r) return s;
  return alta ? r.toUpperCase() : r;
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
  var link = linkPrograma(d.programa, 'alerta', buscaDaEmissao(d));
  var trecho = d.tipoVoo === 'internacional' ? ' o trecho em '+rotuloCabine(d.cabine) : '';
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

// ── FILTRO: preço fora da curva vs média 180 dias ────────────────────────────
// Descarta emissões cujo valor supera a média dos últimos 180 dias da MESMA
// chave (origem|destino|programa|cabine|cia — a mesma usada pelo proxy no
// hist180) em mais de 30% (internacional) ou 50% (nacional). Valores tão
// acima do histórico já computado não valem alerta.
function precoForaDaCurva(pontos, hist180, tipoVoo) {
  if (!hist180 || !hist180.mediaPts || hist180.count < 1) return false;
  const pts = Number(pontos) || 0;
  if (pts <= 0) return false;
  const tipo = String(tipoVoo || '').toLowerCase();
  // "internacional" contém "nacional" — teste de internacional vem primeiro;
  // tipoVoo ausente assume internacional (mesmo default do restante do código)
  const nacional = !/internacion/.test(tipo) && /nacion|domest/.test(tipo);
  const fator  = nacional ? 1.50 : 1.30;
  const limite = Math.round(hist180.mediaPts * fator);
  if (pts > limite) {
    console.log('[FILTRO-180D] Fora da curva: ' + pts.toLocaleString('pt-BR') + ' pts > limite ' + limite.toLocaleString('pt-BR') + ' (média ' + hist180.mediaPts.toLocaleString('pt-BR') + ' × ' + fator + ', ' + hist180.count + ' amostra(s), ' + (nacional ? 'nacional' : 'internacional') + ')');
    return true;
  }
  return false;
}

// ── LINKS AFILIADOS TSP ───────────────────────────────────────────────────────
const LINKS_TSP = {
  'Amazon':        'https://amzn.to/4dFRSzy',
  'Mercado Livre': 'https://meli.la/2xystLt',
  'Shopee_sem':    'https://s.shopee.com.br/9fHPmP3QZF',
  'Shopee_com':    'https://s.shopee.com.br/30kdYeLY0W',
  'Magazine Luiza':'https://magazineluiza.onelink.me/589508454/3jdc7bbv',
  'Zé Delivery':   'https://ze.onelink.me/qZhP/p8z09c1x',
};

// A IA devolve a loja como "Zé Delivery", "Ze Delivery", "zedelivery" ou
// "Outro: Zé Delivery" dependendo de como o texto original escreveu. Uma unica
// funcao de reconhecimento evita repetir a variacao em cada ponto.
function ehZeDelivery(loja) {
  const n = String(loja || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/^outro:\s*/, '').replace(/[^a-z]/g, '');
  return n.includes('zedelivery') || n === 'ze';
}

function formatarCupomTSP(dados) {
  const loja   = dados.loja   || '';
  const tipo   = dados.tipo   || 'reais';
  const valor  = dados.valor  || 0;
  // minimo null/0 = sem valor minimo. Antes caia em `|| 0` e a mensagem saia
  // como "Válido em compras acima de R$ 0".
  const minimo = (dados.minimo === null || dados.minimo === undefined) ? null : Number(dados.minimo);
  const temMin = minimo !== null && minimo > 0;
  const limite = dados.limite || null;
  const codigo = dados.codigo || null;
  const isPct  = tipo === 'pct';
  const tipoStr = isPct ? '%' : ' reais';

  let validade;
  if (isPct && limite) {
    validade = temMin
      ? `Válido em compras acima de R$ ${minimo} com limite de R$ ${limite} de desconto.`
      : `Válido sem valor mínimo de compra, com limite de R$ ${limite} de desconto.`;
  } else {
    validade = temMin
      ? `Válido em compras acima de R$ ${minimo}.`
      : `Válido sem valor mínimo de compra.`;
  }

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

  const lojaNorm = loja.toLowerCase().replace(/^outro:\s*/, '').trim();
  const isMagalu = /magazine\s*luiza|magalu/.test(lojaNorm);

  let url = '';
  if (loja === 'Amazon')        url = LINKS_TSP['Amazon'];
  else if (loja === 'Mercado Livre') url = LINKS_TSP['Mercado Livre'];
  else if (loja === 'Shopee')   url = codigo ? LINKS_TSP['Shopee_com'] : LINKS_TSP['Shopee_sem'];
  else if (isMagalu)            url = LINKS_TSP['Magazine Luiza'];
  else if (ehZeDelivery(loja))  url = LINKS_TSP['Zé Delivery'];

  if (url) msg += `🔗 *RESGATE O CUPOM AQUI* ${url}`;

  msg += '\n\n`Convide seus amigos para entrar aqui no grupo: https://chat.whatsapp.com/HK7NL13BdPXKJPAGtvTKKg`';
  return msg;
}

// Boot: reaplica links de afiliado nos cupons TSP que já estavam na fila.
// Precisa rodar aqui (e não junto de carregarFila) porque depende de LINKS_TSP.
reformatarCupomsTSPPendentes();

// ── CHAMADA ANTHROPIC ─────────────────────────────────────────────────────────
async function chamarClaude(system, userContent, maxTokens) {
  // 3 tentativas com backoff — antes uma falha momentânea da API/parse fazia
  // a classificação retornar null e o item sumia silenciosamente do buffer.
  const ESPERAS = [0, 2000, 5000];
  for (let tentativa = 0; tentativa < ESPERAS.length; tentativa++) {
    if (ESPERAS[tentativa] > 0) await new Promise(r => setTimeout(r, ESPERAS[tentativa]));
    try {
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
      if (data.error) { console.log('API erro (tentativa '+(tentativa+1)+'/3):', JSON.stringify(data.error)); continue; }
      const raw = data.content?.[0]?.text || '{}';
      try { return JSON.parse(raw.replace(/```json|```/g,'').trim()); }
      catch(e) { console.log('JSON parse falhou (tentativa '+(tentativa+1)+'/3):', e.message); continue; }
    } catch(e) {
      console.log('Fetch API falhou (tentativa '+(tentativa+1)+'/3):', e.message);
    }
  }
  console.log('[CLAUDE] Todas as tentativas falharam — retornando null.');
  return null;
}

// ── EXTRAIR CAMPOS DO CUPOM TELEGRAM ─────────────────────────────────────────
async function extrairCupomTelegram(texto) {
  const system = `Você é um extrator de dados de cupons de desconto para o mercado brasileiro.
Analise a mensagem e retorne SOMENTE JSON válido, sem texto extra, sem markdown.

Campos:
{
  "eh_cupom": true/false,
  "loja": "Amazon" | "Mercado Livre" | "Shopee" | "Magazine Luiza" | "Outro: nome",
  "tipo": "pct" | "reais",
  "valor": número (ex: 10, 30, 15),
  "minimo": número | null (valor mínimo de compra; use null se a mensagem NÃO informar mínimo),
  "limite": número | null (limite máximo de desconto em R$, só para tipo "pct"),
  "codigo": "CUPOM123" | null,
  "multiplos": [ {valor, minimo, codigo, tipo} ] | null (quando há múltiplos cupons na mesma mensagem),
  "observacao": "texto livre" | null
}

Regras:
- Se não for cupom de desconto com código de DESCONTO aplicável em compras, retorne {"eh_cupom": false}
- NÃO é cupom: ofertas de milhas, pontos, cashback em programas de fidelidade (Azul Fidelidade, Smiles, TudoAzul, Livelo, etc), bônus de cadastro, promoções de acúmulo de pontos, sorteios, gifts, reembolso, indique-e-ganhe — mesmo que tenham um código
- É cupom: código de desconto (%) ou valor fixo (R$) aplicável em compras em lojas como Amazon, Mercado Livre, Shopee, iFood, Uber Eats, Rappi, Magazine Luiza, etc
- Magalu / Magazine Luiza / Magazine Você = sempre retorne "loja": "Magazine Luiza"
- Shopee sem código = "codigo": null
- "tipo": use "pct" quando o desconto for em porcentagem (ex: 20% OFF, 15% de desconto). Use "reais" quando for valor fixo em R$ (ex: R$30 OFF, R$10 de desconto)
- Em "multiplos", cada item DEVE ter seu próprio campo "tipo" ("pct" ou "reais") — não herde o tipo do cupom principal
- Para múltiplos cupons na mesma mensagem (ex: 20% OFF em TVs + 15% OFF em Celulares), use "multiplos" com um item por cupom
- Valores devem ser números puros sem símbolo (ex: 20 para 20%, 30 para R$30)
- "minimo": use null quando a mensagem não informar valor mínimo de compra. Use 0 SOMENTE se a mensagem disser explicitamente que não há mínimo ("sem valor mínimo", "sem mínimo"). Nunca chute um valor.`;

  return await chamarClaude(system, [{ type:'text', text: texto }], 500);
}

// ── AUTO-ENVIO DE CUPOM TSP ──────────────────────────────────────────────────
// AUTO_ENVIO_CUPOM: 'off' (tudo vai para fila) | 'sombra' (avalia e loga, mas
// continua indo para fila) | 'on' (envia direto quando passa em todos os gates).
// Default 'sombra': ligar em producao exige acao explicita no Railway.
const AUTO_ENVIO_MODO       = (process.env.AUTO_ENVIO_CUPOM || 'sombra').toLowerCase();
const AUTO_ENVIO_INTERVALO  = 90 * 1000; // intervalo minimo entre auto-envios
const AUTO_ENVIO_TEXTO_MIN  = 20;        // texto curto demais = info provavelmente na imagem
const AUTO_ENVIO_MAX_ESPERA = 30 * 60 * 1000; // agendado ha mais que isso = cupom provavelmente vencido, vira aprovacao manual
let   _ultimoAutoEnvio      = 0;

// Lojas elegiveis: precisam ter link de afiliado em LINKS_TSP, senao a mensagem
// sai sem "RESGATE O CUPOM AQUI" — comercialmente inutil.
function lojaComLink(loja, codigo) {
  const norm = (loja || '').toLowerCase().replace(/^outro:\s*/, '').trim();
  if (loja === 'Amazon')        return !!LINKS_TSP['Amazon'];
  if (loja === 'Mercado Livre') return !!LINKS_TSP['Mercado Livre'];
  // Shopee: auto-envio SOMENTE com codigo (decisao do operador).
  if (loja === 'Shopee')        return !!codigo && !!LINKS_TSP['Shopee_com'];
  if (/magazine\s*luiza|magalu/.test(norm)) return !!LINKS_TSP['Magazine Luiza'];
  if (ehZeDelivery(loja))       return !!LINKS_TSP['Zé Delivery'];
  return false;
}

// Confere se um numero extraido pela IA aparece de fato no texto original.
// Pega a maior parte das alucinacoes numericas do modelo por um custo trivial.
function numeroNoTexto(texto, n) {
  if (n === null || n === undefined) return true;
  const num = Number(n);
  if (!isFinite(num)) return false;
  const digitos = String(Math.round(num));
  // aceita 1000, 1.000, 1,000 e variacoes com separador
  const re = new RegExp(digitos.split('').join('[.,\\s]?'), 'i');
  return re.test(texto);
}

// Em mensagem com varios cupons, o risco nao e a extracao em si — e a IA
// ATRIBUIR o minimo/limite de um cupom ao outro. Em vez de bloquear tudo,
// particiona o texto por codigo: o escopo de um cupom vai do fim do bloco
// anterior ate a linha onde o proprio codigo aparece. Validar os numeros
// dentro desse escopo prova que a atribuicao esta correta.
function escopoDoCupom(texto, codigo, todosCodigos) {
  const linhas = (texto || '').split('\n');
  const alvo = String(codigo || '').toLowerCase();
  if (!alvo) return null;
  const marcadas = linhas.map(l => {
    const low = l.toLowerCase();
    return todosCodigos.some(cd => cd && low.includes(String(cd).toLowerCase()));
  });
  const idx = linhas.findIndex(l => l.toLowerCase().includes(alvo));
  if (idx === -1) return null;
  let prev = -1;
  for (let i = 0; i < idx; i++) if (marcadas[i]) prev = i;
  return linhas.slice(prev + 1, idx + 1).join('\n');
}

// Gate deterministico. Retorna { auto:boolean, motivo:string }.
function avaliarAutoEnvio(cupom, textoOriginal, tinhaMultiplos, codigosIrmaos = []) {
  let t = textoOriginal || '';

  if (AUTO_ENVIO_MODO === 'off')          return { auto:false, motivo:'modo off' };
  if (t.trim().length < AUTO_ENVIO_TEXTO_MIN) return { auto:false, motivo:'texto curto demais (info pode estar na imagem)' };

  // Mensagem com varios cupons: restringe a validacao cruzada ao bloco deste
  // cupom. Se o bloco nao for identificavel, cai para a fila.
  if (tinhaMultiplos) {
    if (!cupom.codigo) return { auto:false, motivo:'multiplos cupons e este item sem codigo' };
    const escopo = escopoDoCupom(textoOriginal, cupom.codigo, codigosIrmaos);
    if (!escopo) return { auto:false, motivo:'multiplos cupons e bloco do codigo nao identificado' };
    t = escopo;
  }

  if (!cupom.loja)                        return { auto:false, motivo:'sem loja' };
  if (!cupom.codigo)                      return { auto:false, motivo:'sem codigo do cupom' };
  if (!lojaComLink(cupom.loja, cupom.codigo)) return { auto:false, motivo:`loja sem link de afiliado (${cupom.loja})` };

  if (cupom.tipo !== 'pct' && cupom.tipo !== 'reais') return { auto:false, motivo:'tipo invalido' };
  if (!(Number(cupom.valor) > 0))         return { auto:false, motivo:'valor ausente ou zero' };

  if (cupom.minimo === null || cupom.minimo === undefined)
    return { auto:false, motivo:'minimo nao informado (regra de aplicacao incompleta)' };
  if (Number(cupom.minimo) < 0)           return { auto:false, motivo:'minimo invalido' };

  if (cupom.tipo === 'pct' && !(Number(cupom.limite) > 0))
    return { auto:false, motivo:'cupom percentual sem limite de desconto' };

  // Validacao cruzada contra o texto original
  const ondeStr = tinhaMultiplos ? 'no bloco deste cupom' : 'no texto original';
  if (!numeroNoTexto(t, cupom.valor))     return { auto:false, motivo:'valor nao confere '+ondeStr };
  if (Number(cupom.minimo) > 0 && !numeroNoTexto(t, cupom.minimo))
    return { auto:false, motivo:'minimo nao confere '+ondeStr };
  if (cupom.limite && !numeroNoTexto(t, cupom.limite))
    return { auto:false, motivo:'limite nao confere '+ondeStr };
  if (!t.toLowerCase().includes(String(cupom.codigo).toLowerCase()))
    return { auto:false, motivo:'codigo nao aparece '+ondeStr };

  // Janela de horario (mesma da fila CDV) — nada de cupom as 3h da manha
  const h = horaSP();
  if (h < HORA_INICIO_ENVIO || h >= HORA_FIM_ENVIO)
    return { auto:false, motivo:`fora da janela ${HORA_INICIO_ENVIO}h-${HORA_FIM_ENVIO}h SP` };

  // Anti-flood: canal despejando varios cupons de uma vez
  const desde = Date.now() - _ultimoAutoEnvio;
  if (desde < AUTO_ENVIO_INTERVALO)
    return { auto:false, motivo:`intervalo minimo (faltam ${Math.ceil((AUTO_ENVIO_INTERVALO-desde)/1000)}s)` };

  return { auto:true, motivo:'aprovado' };
}

// Rodape usado na copia enviada ao grupo so-cupons: em vez de convidar para o
// proprio grupo, faz o convite cruzado para o grupo de ofertas.
const RODAPE_TSP_CUPONS = '`Entre no grupo de ofertas: https://chat.whatsapp.com/C7ed3Z1tYIb980POo9MqF8?s=cl&p=i&ilr=4`';

// Troca o rodape padrao do TSP pelo convite cruzado. Se o operador tiver
// editado/removido o rodape na fila, apenas anexa o novo ao final.
function mensagemParaGrupoCupons(msg) {
  const rodapeTsp = /`Convide seus amigos para entrar aqui no grupo:[^`]*`/;
  if (rodapeTsp.test(msg)) return msg.replace(rodapeTsp, RODAPE_TSP_CUPONS);
  return msg + '\n\n' + RODAPE_TSP_CUPONS;
}

// Envia um cupom para o grupo TSP principal e a copia (com rodape trocado)
// para o grupo so-cupons. Falha no grupo so-cupons NAO derruba o envio
// principal: loga e avisa o operador.
async function enviarCupomParaGrupos(mensagem, imagem) {
  if (imagem?.imagemBase64) {
    await enviarMensagem(GRUPOS['tsp'], {
      image: Buffer.from(imagem.imagemBase64, 'base64'),
      caption: mensagem,
      mimetype: imagem.mime || 'image/jpeg',
    });
  } else {
    await enviarMensagem(GRUPOS['tsp'], { text: mensagem });
  }
  try {
    const msgCupons = mensagemParaGrupoCupons(mensagem);
    if (imagem?.imagemBase64) {
      await enviarMensagem(GRUPOS['tsp_cupons'], {
        image: Buffer.from(imagem.imagemBase64, 'base64'),
        caption: msgCupons,
        mimetype: imagem.mime || 'image/jpeg',
      });
    } else {
      await enviarMensagem(GRUPOS['tsp_cupons'], { text: msgCupons });
    }
  } catch(e) {
    console.error('[CUPONS] Falha ao enviar para o grupo so-cupons:', e.message);
    try {
      await enviarMensagem(GRUPOS.operador, { text: '*Falha ao enviar cupom no grupo so-cupons* \u26a0\ufe0f\n\n' + e.message });
    } catch(_) {}
  }
}

// Envia uma oferta de marketplace para os grupos marcados como 'destino' no
// painel. Sem destino marcado, cai no grupo TSP principal.
//
// O espacamento de 3–5s entre grupos e proposital: disparo simultaneo em varios
// grupos e justamente o padrao que o WhatsApp usa para identificar automacao, e
// o custo de perder a sessao e muito maior que o de a oferta sair 1min depois.
// Monta o preview de link nativo. O Baileys aceita um linkPreview pronto
// (Utils/messages.js), entao nao precisamos de link-preview-js nem de raspar a
// pagina da Amazon — que bloqueia bots. A thumbnail vem da propria API.
// Acima de ~100KB o WhatsApp descarta o jpegThumbnail e a mensagem sai sem
// imagem; melhor mandar preview sem foto do que a mensagem falhar.
const THUMB_MAX_BYTES = 100 * 1024;

function montarLinkPreview(oferta, mensagem) {
  const d = oferta.dadosExtraidos || {};
  const url = d.link;
  if (!url) return null;

  const preview = {
    'canonical-url': url,
    'matched-text': url,
    title: d.titulo || d.loja || 'Oferta',
    description: [d.precoFinal != null ? 'R$ ' + Number(d.precoFinal).toFixed(2).replace('.', ',') : null,
                  d.loja].filter(Boolean).join(' · '),
  };

  const img = (oferta.imagens || [])[0];
  if (img?.imagemBase64) {
    const buf = Buffer.from(img.imagemBase64, 'base64');
    if (buf.length <= THUMB_MAX_BYTES) preview.jpegThumbnail = buf;
    else console.log('[MKT] Thumbnail de ' + buf.length + ' bytes acima do limite — preview sem imagem.');
  }
  return preview;
}

async function enviarOfertaParaDestinos(mensagem, imagem, oferta) {
  const destinos = radarDestinos();
  const alvos = destinos.length ? destinos : [GRUPOS['tsp']];
  const enviados = [], falhas = [];
  const preview = oferta ? montarLinkPreview(oferta, mensagem) : null;

  for (const jid of alvos) {
    try {
      await enviarMensagem(jid, preview ? { text: mensagem, linkPreview: preview } : { text: mensagem });
      enviados.push(jid);
      if (alvos.length > 1) await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000));
    } catch (e) {
      console.error('[MKT] Falha ao enviar em ' + jid + ':', e.message);
      falhas.push({ jid, erro: e.message });
    }
  }
  if (!enviados.length) throw new Error('Nenhum grupo recebeu a oferta.');
  return { enviados, falhas };
}

// Envia um cupom aprovado pelo gate para os grupos de cupons e marca a oferta
// como enviada. Lanca excecao se o envio principal falhar (caller decide o fallback).
async function despacharCupomAuto(oferta) {
  await enviarCupomParaGrupos(oferta.mensagemFormatada, oferta.imagens?.[0]);
  _ultimoAutoEnvio     = Date.now();
  oferta.status        = 'enviado';
  oferta.mensagemFinal = oferta.mensagemFormatada;
  oferta.autoEnviado   = true;
  delete oferta.autoAgendado;
}

// ── WORKER DE ESPACAMENTO DO AUTO-ENVIO ──────────────────────────────────────
// Cupons que passaram em TODAS as regras de conteudo mas foram bloqueados por
// motivo apenas temporal (janela de horario ou intervalo minimo entre envios)
// ficam na fila com autoAgendado=true. Este worker envia um por vez, sempre
// respeitando a janela e o intervalo de 90s. Cupons agendados ha mais de
// AUTO_ENVIO_MAX_ESPERA viram aprovacao manual (provavelmente ja venceram).
let _workerAutoRodando = false;
setInterval(async () => {
  if (AUTO_ENVIO_MODO !== 'on') return;
  if (_workerAutoRodando) return;
  _workerAutoRodando = true;
  try {
    const agora = Date.now();

    // 1. Expira agendamentos velhos → viram aprovacao manual (com o alerta de
    //    "novo cupom" que foi pulado na captura, para o operador ficar sabendo)
    for (const o of filaPendentes) {
      if (!o.autoAgendado || o.status !== 'pendente') continue;
      const ts = new Date(o.timestamp).getTime();
      if (!ts || isNaN(ts) || agora - ts <= AUTO_ENVIO_MAX_ESPERA) continue;
      delete o.autoAgendado;
      if (o.autoAvaliacao) o.autoAvaliacao.motivo += ' — prazo de auto-envio expirado, requer aprovacao manual';
      salvarFila();
      console.log(`[AUTO-FILA] Cupom #${o.id} expirou o prazo de auto-envio — caindo para aprovacao manual.`);
      try {
        await enviarMensagem(GRUPOS.operador, {
          text: '*Novo cupom capturado* ✅\n\nAprove aqui: https://davileles.github.io/tudo-sobre-promos/'
        });
      } catch(e) { console.warn('[AUTO-FILA] Falha ao avisar operador:', e.message); }
    }

    // 2. Condicoes temporais para enviar o proximo da fila
    const h = horaSP();
    if (h < HORA_INICIO_ENVIO || h >= HORA_FIM_ENVIO) return;
    if (agora - _ultimoAutoEnvio < AUTO_ENVIO_INTERVALO) return;
    if (!conectado || !sock) return;

    // 3. Mais antigo primeiro (ordem de captura)
    const candidatos = filaPendentes
      .filter(o => o.autoAgendado && o.status === 'pendente' && o.tipoConteudo === 'cupom_tsp')
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const oferta = candidatos[0];
    if (!oferta) return;

    const d = oferta.dadosExtraidos || {};
    const rotulo = `${d.loja} ${d.valor}${d.tipo === 'pct' ? '%' : ' R$'}${d.codigo ? ' · '+d.codigo : ''}`;

    // Marca como 'enviando' antes do await para o card sumir do painel e
    // reduzir a janela de corrida com uma aprovacao manual simultanea.
    oferta.status = 'enviando';
    try {
      await despacharCupomAuto(oferta);
      salvarFila();
      console.log(`[AUTO-FILA] Cupom #${oferta.id} ENVIADO automaticamente (espacamento) — ${rotulo}`);
      try {
        await enviarMensagem(GRUPOS.operador, {
          text: `*Cupom enviado automaticamente* 🤖\n\n${rotulo}\n\nOrigem: ${oferta.grupoOrigem || '?'}`
        });
      } catch(e) { console.warn('[AUTO-FILA] Falha ao avisar operador:', e.message); }
    } catch(err) {
      oferta.status = 'pendente';
      delete oferta.autoAgendado;
      if (oferta.autoAvaliacao) oferta.autoAvaliacao.motivo += ' — falha no envio automatico, requer aprovacao manual';
      salvarFila();
      console.error(`[AUTO-FILA] Falha no envio do cupom #${oferta.id}: ${err.message} — caindo para aprovacao manual`);
      try {
        await enviarMensagem(GRUPOS.operador, {
          text: '*Novo cupom capturado* ✅\n\nAprove aqui: https://davileles.github.io/tudo-sobre-promos/'
        });
      } catch(e) { console.warn('[AUTO-FILA] Falha ao avisar operador:', e.message); }
    }
  } finally { _workerAutoRodando = false; }
}, 15 * 1000);

// ── PROCESSAR MENSAGEM DO TELEGRAM ────────────────────────────────────────────
// Serializacao: o gate de dedup so roda DEPOIS da chamada a Anthropic (1-3s).
// Sem mutex, o mesmo cupom chegando pelos dois canais com poucos segundos de
// diferenca passa duas vezes pelo gate — e com auto-envio isso vira mensagem
// duplicada no grupo de clientes. Uma cadeia de promises basta (processo unico).
let _tgChain = Promise.resolve();

function processarMensagemTelegram(texto, canalUsername = 'desconhecido', imagemBase64 = null) {
  _tgChain = _tgChain
    .then(() => _processarMensagemTelegram(texto, canalUsername, imagemBase64))
    .catch(e => console.error('[TG] Erro na cadeia:', e.message));
  return _tgChain;
}

async function _processarMensagemTelegram(texto, canalUsername = 'desconhecido', imagemBase64 = null) {
  if (!texto?.trim()) return;
  console.log('[TG] Nova mensagem recebida:', texto.slice(0, 80));

  try {
    const campos = await extrairCupomTelegram(texto);
    if (!campos || !campos.eh_cupom) {
      console.log('[TG] Não é cupom, ignorado.');
      return;
    }

    console.log(`[TG] Cupom identificado: ${campos.loja} | ${campos.valor}${campos.tipo === 'pct' ? '%' : ' R$'}`);

    const tinhaMultiplos = !!campos.multiplos?.length;
    const lista = tinhaMultiplos
      ? campos.multiplos.map(m => ({ ...campos, valor: m.valor, minimo: m.minimo ?? null, codigo: m.codigo ?? campos.codigo, tipo: m.tipo ?? campos.tipo, limite: m.limite ?? campos.limite ?? null, multiplos: null }))
      : [campos];
    const codigosLista = lista.map(x => x.codigo).filter(Boolean);

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
      // Verificar deduplicação: ignorar se o mesmo cupom já foi visto recentemente
      if (cupomJaVisto(c)) {
        console.log(`[DEDUP] Cupom ignorado (duplicata): ${c.loja} | ${c.codigo || 'sem código'}`);
        continue;
      }

      // Registra ANTES de qualquer envio: se o envio falhar preferimos perder um
      // cupom a arriscar mandar duplicado quando o outro canal repostar.
      registrarCupomVisto(c);
      // Mesmo ponto, mesma garantia: o cupom entra na base antes de qualquer
      // envio, para ja estar disponivel quando uma oferta do radar chegar.
      try { registrarCupomBase(c); } catch(e) { console.warn('[CUPONS] Falha ao gravar na base:', e.message); }

      const veredito = avaliarAutoEnvio(c, texto, tinhaMultiplos, codigosLista);
      const rotulo   = `${c.loja} ${c.valor}${c.tipo === 'pct' ? '%' : ' R$'}${c.codigo ? ' · '+c.codigo : ''}`;

      // Veredito fica gravado na oferta para aparecer no card da fila (o log do
      // Railway sozinho nao serve: em modo sombra o operador precisa comparar a
      // decisao do gate com a propria aprovacao manual, cupom a cupom.
      oferta.autoAvaliacao = {
        auto: veredito.auto,
        motivo: veredito.motivo,
        modo: AUTO_ENVIO_MODO,
        avaliadoEm: new Date().toISOString(),
      };

      // Bloqueio APENAS temporal (janela/intervalo): todas as regras de conteudo
      // passaram. Em modo 'on', em vez de exigir aprovacao manual, o cupom entra
      // agendado e o worker de espacamento envia quando a condicao liberar.
      const bloqueioTemporal = !veredito.auto && /^(fora da janela|intervalo minimo)/.test(veredito.motivo);
      if (AUTO_ENVIO_MODO === 'on' && bloqueioTemporal) oferta.autoAgendado = true;

      // MODO SOMBRA: decide e loga, mas nao envia. Serve para medir a taxa de
      // acerto do gate contra a aprovacao manual antes de ligar 'on'.
      if (AUTO_ENVIO_MODO === 'sombra') {
        console.log(`[AUTO-SOMBRA] ${veredito.auto ? 'ENVIARIA' : 'BLOQUEADO'} — ${rotulo} — ${veredito.motivo}`);
      }

      if (AUTO_ENVIO_MODO === 'on' && veredito.auto) {
        try {
          await despacharCupomAuto(oferta);
          filaPendentes.unshift(oferta);
          salvarFila();
          console.log(`[AUTO] Cupom #${oferta.id} ENVIADO automaticamente — ${rotulo}`);
          try {
            await enviarMensagem(GRUPOS.operador, {
              text: `*Cupom enviado automaticamente* 🤖\n\n${rotulo}\n\nOrigem: @${canalUsername}`
            });
          } catch(e) { console.warn('[AUTO] Falha ao avisar operador:', e.message); }
          continue;
        } catch(err) {
          // Falha no envio: cai para a fila manual em vez de perder o cupom.
          console.error(`[AUTO] Falha no envio automatico, caindo para fila: ${err.message}`);
        }
      }

      filaPendentes.unshift(oferta);
      salvarFila();
      console.log(`[TG] Cupom #${oferta.id} adicionado à fila — ${rotulo} (${veredito.motivo})`);

      // Cupom agendado para auto-envio: sem alerta de aprovacao — o worker de
      // espacamento avisa o operador quando de fato enviar (ou se expirar).
      if (oferta.autoAgendado) {
        console.log(`[AUTO-FILA] Cupom #${oferta.id} agendado para auto-envio com espacamento.`);
        continue;
      }

      // Alerta de novo cupom no grupo do operador
      try {
        await enviarMensagem(GRUPOS.operador, {
          text: '*Novo cupom capturado* ✅\n\nAprove aqui: https://davileles.github.io/tudo-sobre-promos/'
        });
      } catch(e) { console.warn('[TG] Falha ao enviar alerta de cupom:', e.message); }
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
// Blacklist: channelIds numéricos ou substrings de title/username a ignorar (separados por vírgula)
const TG_CANAIS_IGNORADOS_RAW = (process.env.TG_CANAIS_IGNORADOS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

let tgClient = null;
let tgConectado = false;

let tgAuthState = null;
let tgConta = null;
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
    receiveUpdates: true,
    floodSleepThreshold: 60,
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
  tgConta = await tgClient.getMe().then(u => ({ id: u.id?.toString(), username: u.username || null, phone: u.phone || null, nome: ((u.firstName||'')+' '+(u.lastName||'')).trim() })).catch(() => null);
  // Sincronizar diálogos para garantir recebimento de updates de todos os canais seguidos
  try {
    const dialogs = await tgClient.getDialogs({ limit: 500 });
    console.log(`[TG] ${dialogs.length} diálogos sincronizados`);
  } catch(e) { console.warn('[TG] Falha ao sincronizar diálogos:', e.message); }

  // Forçar acesso explícito aos canais monitorados via getMessages — ativa recebimento de updates
  // Só getInputEntity não é suficiente; é preciso acessar histórico para o MTProto liberar updates
  for (const canal of TG_CANAIS_MONITORADOS) {
    try {
      const ent = await tgClient.getInputEntity(canal);
      const cid = (ent?.channelId ?? ent?.chatId ?? ent?.userId)?.toString();
      // Buscar última mensagem para registrar o canal como "acessado" no MTProto
      await tgClient.getMessages(ent, { limit: 1 });
      console.log(`[TG] Canal monitorado ativo: @${canal} → channelId=${cid}`);
    } catch(e) { console.warn(`[TG] Falha ao ativar canal monitorado @${canal}: ${e.message}`); }
  }

  // Resolver blacklist para channelIds numéricos
  const _ignoradosIds = new Set();
  for (const termo of TG_CANAIS_IGNORADOS_RAW) {
    if (/^\d+$/.test(termo)) { _ignoradosIds.add(termo); continue; } // já é um ID
    try {
      const ent = await tgClient.getInputEntity(termo).catch(() => null);
      const cid = ent && (ent.channelId ?? ent.chatId ?? ent.userId)?.toString();
      if (cid) { _ignoradosIds.add(cid); console.log(`[TG] Blacklist resolvido "${termo}" → channelId=${cid}`); }
    } catch(e) { /* termo será comparado por título em runtime */ }
  }
  console.log(`[TG] Conectado! Modo: captura geral | Blacklist: ${TG_CANAIS_IGNORADOS_RAW.join(', ') || 'nenhum'}`);

  // ── KEEPALIVE: mantém sessão ativa para o servidor TG continuar entregando updates ──
  // Sem isso, sessões inativas perdem updates de canais broadcast após alguns minutos
  const _keepaliveInterval = setInterval(async () => {
    try {
      await tgClient.invoke(new Api.updates.GetState());
    } catch(e) {
      console.warn('[TG] Keepalive falhou:', e.message);
    }
  }, 30000); // a cada 30 segundos

  // Cache de deduplicação: evita processar mesma mensagem duas vezes (NewMessage + Polling)
  const _msgProcessadas = new Map(); // chave: "channelId:msgId" → timestamp
  const MSG_DEDUP_TTL = 10 * 60 * 1000; // 10 minutos (cobre janela do polling)

  // ── POLLING de segurança: busca últimas msgs dos canais monitorados a cada 5 min ──
  // Garante captura mesmo se algum update MTProto for perdido
  const _ultimosMsgIds = {}; // channelId → último msgId processado
  const _pollingInterval = setInterval(async () => {
    for (const canal of TG_CANAIS_MONITORADOS) {
      try {
        const ent = await tgClient.getInputEntity(canal);
        const msgs = await tgClient.getMessages(ent, { limit: 5 });
        const cid = (ent?.channelId ?? ent?.chatId ?? ent?.userId)?.toString();
        for (const msg of msgs.reverse()) { // do mais antigo ao mais novo
          if (!msg.message?.trim()) continue;
          const ultimoId = _ultimosMsgIds[cid] || 0;
          if (msg.id <= ultimoId) continue; // já processado
          _ultimosMsgIds[cid] = msg.id;
          // Verificar blacklist
          const bloqueado = _ignoradosIds.has(cid) ||
            TG_CANAIS_IGNORADOS_RAW.some(t => canal.includes(t));
          if (bloqueado) continue;
          // Checar deduplicação — evita reprocessar msg já capturada pelo NewMessage
          const dedupKeyPolling = `${cid}:${msg.id}`;
          if (_msgProcessadas.has(dedupKeyPolling)) continue;
          _msgProcessadas.set(dedupKeyPolling, Date.now());
          console.log(`[TG] Polling ACEITA @${canal} msgId=${msg.id}: ${msg.message.slice(0,60)}`);
          await processarMensagemTelegram(msg.message, canal, null);
        }
      } catch(e) { /* silencioso — canal pode estar temporariamente inacessível */ }
    }
  }, 60 * 1000); // a cada 1 minuto

  // Handler principal: NewMessage captura UpdateNewMessage + UpdateNewChannelMessage de forma normalizada
  tgClient.addEventHandler(async (event) => {
    try {
      const msg = event.message;
      if (!msg) return;

      // Resolver identidade do canal remetente
      const peerId = msg.peerId;
      const peerChannelId = (peerId?.channelId ?? peerId?.chatId ?? peerId?.userId)?.toString();
      const entity = await tgClient.getEntity(peerId).catch(() => null);
      const username = (entity?.username || '').toLowerCase();
      const title    = (entity?.title    || '').toLowerCase();

      // Verificar blacklist: por channelId numérico OU substring de title/username
      const bloqueadoPorId   = peerChannelId && _ignoradosIds.has(peerChannelId);
      const bloqueadoPorNome = TG_CANAIS_IGNORADOS_RAW.some(t => username.includes(t) || title.includes(t));
      if (bloqueadoPorId || bloqueadoPorNome) {
        console.log(`[TG] BLOQUEADO (blacklist) channelId=${peerChannelId} username="${username}" title="${title}"`);
        return;
      }

      // Deduplicação por messageId — evita processar mesma msg de canais espelhados
      const dedupKey = `${peerChannelId}:${msg.id}`;
      const agora = Date.now();
      for (const [k, ts] of _msgProcessadas) { if (agora - ts > MSG_DEDUP_TTL) _msgProcessadas.delete(k); }
      if (_msgProcessadas.has(dedupKey)) {
        console.log(`[TG] DUPLICATA ignorada channelId=${peerChannelId} msgId=${msg.id}`);
        return;
      }
      _msgProcessadas.set(dedupKey, agora);

      console.log(`[TG] Mensagem ACEITA channelId=${peerChannelId} username="${username}" title="${title}"`);

      const texto = msg.message || '';
      if (!texto.trim()) return;

      // Tentar baixar mídia se existir
      let imagemBase64 = null;
      if (msg.media) {
        try {
          const buffer = await tgClient.downloadMedia(msg, {});
          if (buffer) imagemBase64 = buffer.toString('base64');
          console.log('[TG] Mídia capturada:', buffer?.length, 'bytes');
        } catch(e) { console.warn('[TG] Falha ao baixar mídia:', e.message); }
      }

      console.log('[TG] Nova mensagem:', texto.slice(0, 80));
      await processarMensagemTelegram(texto, username, imagemBase64);
    } catch (err) { console.error('[TG] Erro no handler NewMessage:', err.message); }
  }, new NewMessage({}));
}

iniciarTelegram().catch(err => {
  console.error('[TG] Falha ao iniciar:', err.message);
  tgAuthState = 'erro';
});

// ── GRUPOS COM REGRAS ESPECIAIS DE EXTRAÇÃO ───────────────────────────────────
const GRUPO_APENAS_IMAGEM = '120363430801699326@g.us';
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
const PROGRAMAS_VALIDOS = 'Programa deve ser um destes: Smiles, Azul Fidelidade, Azul pelo Mundo, LATAM Pass, Iberia Plus, Privilege Club, Executive Club, TAP, AAdvantage, SUMA, Flying Club, Finnair Plus, Aeroplan.\nIMPORTANTE: TudoAzul = Azul Fidelidade. Tudo Azul = Azul Fidelidade. LatamPass = LATAM Pass.\nCabine deve ser exatamente "Economica" ou "Executiva".'
  + '\nREGRAS DE COMPANHIA AEREA (campo "cia"):'
  + '\n- "SAA" ou "South African Airways" deve ser sempre gravado como "South African".'
  + '\n- Voo NACIONAL dentro do Brasil (origem E destino brasileiros): a cia segue o programa — Smiles = "GOL"; Azul Fidelidade/TudoAzul = "Azul"; LATAM Pass = "LATAM". Nunca use outra cia nesses casos.'
  + '\n- Voo INTERNACIONAL: identifique a companhia aerea OPERADORA ("cia") lendo o texto e principalmente a IMAGEM quando houver — screenshots da Smiles mostram o nome da cia (ex: "AIR FRANCE"). Preencha "cia" apenas com o que estiver visivel na fonte; NUNCA deduza a cia a partir do programa (Smiles NAO implica GOL em voo internacional). Se nao estiver visivel, deixe "cia" vazia.'
  + '\n- Defina tipoVoo="nacional" sempre que origem e destino forem cidades brasileiras.';

// ── DE-PARA: programa → CIA operadora (para voos nacionais BR e fallback) ─────
const CIA_POR_PROGRAMA = {
  'Smiles':           'GOL',
  'Azul Fidelidade':  'Azul',
  'Azul':             'Azul',
  'TudoAzul':         'Azul',
  'LATAM Pass':       'LATAM',
};

// ── DE-PARA: destino internacional Smiles → parceira típica ──────────────────
// Fallback usado APENAS quando a fonte não informa a cia em voo internacional
// do programa Smiles. Chaves: código IATA ou nome de cidade normalizado
// (maiúsculas, sem acento). Nunca inclui destinos que a GOL também opera
// (EUA, Buenos Aires etc.) para evitar atribuição errada.
const CIA_SMILES_POR_DESTINO = {
  'CDG':'Air France', 'ORY':'Air France', 'PARIS':'Air France',
  'AMS':'KLM', 'AMSTERDA':'KLM', 'AMSTERDAM':'KLM',
  'MAD':'Air Europa', 'MADRI':'Air Europa', 'MADRID':'Air Europa',
  'BOG':'Avianca', 'BOGOTA':'Avianca',
  'MDE':'Avianca', 'MEDELLIN':'Avianca',
  'PTY':'COPA', 'PANAMA':'COPA', 'CIDADE DO PANAMA':'COPA',
  'DXB':'Emirates', 'DUBAI':'Emirates',
  'IST':'Turkish', 'ISTAMBUL':'Turkish', 'ISTANBUL':'Turkish',
  'ADD':'Ethiopian', 'ADIS ABEBA':'Ethiopian',
};

function chaveDestinoSmiles(s) {
  return String(s == null ? '' : s)
    .toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── NORMALIZAÇÃO DE NOME DE CIA (siglas e variações → nome canônico) ──────────
const ALIAS_CIA = {
  'saa':'South African', 'south african airways':'South African', 'south african':'South African',
  'sa':'South African',
  'gol':'GOL', 'gol linhas aereas':'GOL', 'g3':'GOL', 'voegol':'GOL',
  'azul':'Azul', 'azul linhas aereas':'Azul', 'ad':'Azul', 'voeazul':'Azul',
  'latam':'LATAM', 'latam airlines':'LATAM', 'tam':'LATAM', 'la':'LATAM',
  'aa':'American Airlines', 'american':'American Airlines', 'american airlines':'American Airlines',
  'tap':'TAP', 'tap air portugal':'TAP', 'tp':'TAP',
  'af':'Air France', 'air france':'Air France',
  'kl':'KLM', 'klm':'KLM', 'klm royal dutch airlines':'KLM',
  'ba':'British Airways', 'british':'British Airways', 'british airways':'British Airways',
  'ib':'Iberia', 'iberia':'Iberia',
  'cm':'COPA', 'copa':'COPA', 'copa airlines':'COPA',
  'ua':'United', 'united':'United', 'united airlines':'United',
  'dl':'Delta', 'delta':'Delta', 'delta air lines':'Delta',
  'tk':'Turkish', 'turkish':'Turkish', 'turkish airlines':'Turkish',
  'qr':'Qatar Airways', 'qatar':'Qatar Airways', 'qatar airways':'Qatar Airways',
  'ek':'Emirates', 'emirates':'Emirates',
  'ay':'Finnair', 'finnair':'Finnair',
  'lh':'Lufthansa', 'lufthansa':'Lufthansa',
  'ux':'Air Europa', 'air europa':'Air Europa',
  'ar':'Aerolineas Argentinas', 'aerolineas':'Aerolineas Argentinas', 'aerolineas argentinas':'Aerolineas Argentinas',
  'av':'Avianca', 'avianca':'Avianca',
  'et':'Ethiopian', 'ethiopian':'Ethiopian', 'ethiopian airlines':'Ethiopian',
  'ac':'Air Canada', 'air canada':'Air Canada',
  'sq':'Singapore Airlines', 'singapore':'Singapore Airlines', 'singapore airlines':'Singapore Airlines',
  'a3':'Aegean', 'aegean':'Aegean', 'aegean airlines':'Aegean',
  'ib plus':'Iberia', 'iberia express':'Iberia',
  'vs':'Virgin Atlantic', 'virgin atlantic':'Virgin Atlantic',
  'af/klm':'Air France', 'airfrance':'Air France',
};

function normalizarCia(cia) {
  const bruto = String(cia == null ? '' : cia).trim();
  if (!bruto) return bruto;
  const chave = bruto
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[.]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return ALIAS_CIA[chave] || bruto;
}

// Aeroportos brasileiros com voo comercial (lista ampla — evita classificar
// voo nacional como internacional só porque o IATA não estava mapeado)
const IATAS_BR = new Set([
  // Sudeste
  'GRU','CGH','VCP','GIG','SDU','CNF','PLU','VIX','RAO','SJP','SJK','BAU','ARU',
  'MII','PPB','UBA','UDI','IPN','MOC','GVR','POJ','JDF','VAG','AAX','DIQ','SOD',
  'QSC','RVD','JTC','MEA','ITR','CAW','MOC',
  // Sul
  'CWB','POA','FLN','NVT','JOI','IGU','MGF','LDB','CAC','XAP','CXJ','PFB','PET',
  'BGX','URG','LAJ','CCM','JJG','CFC','SQX','PTO','TOW','RIA','GEL','ERM','CBW',
  // Centro-Oeste
  'BSB','CGB','CGR','GYN','CLV','ROO','OPS','DOU','CMG','AFL','BAT','TJL','SIN',
  'AQA','MTG',
  // Nordeste
  'SSA','REC','FOR','NAT','MCZ','AJU','JPA','SLZ','THE','IOS','BPS','JDO','PNZ',
  'PHB','CPV','JJD','FEN','LEC','VDC','MVF','BRA','GNM','PTZ','TMT','JDR','ARS',
  'IMP','PIN','STZ','CZB','SSZ','FLB','BVM','PDF',
  // Norte
  'MAO','BEL','STM','MCP','PVH','RBR','BVB','PMW','MAB','ATM','TBT','CZS','TFF',
  'JPR','CAF','SJL','OAL','ITB','ERN','TMT','RBB','HUW','LBR','MNX','PIN','ALT',
  'AUX','GRP','PBQ','TUR','SXX','APQ',
]);

function corrigirCia(cia, programa, origemCodigo, destinoCodigo, tipoVoo, destinoNome) {
  const oc   = String(origemCodigo  || '').toUpperCase().trim();
  const dc   = String(destinoCodigo || '').toUpperCase().trim();
  const tipo = String(tipoVoo || '').toLowerCase();

  const internacionalIA = /internacion/.test(tipo);
  // "internacional" contém "nacional" — por isso o teste de internacional vem primeiro
  const nacionalIA      = !internacionalIA && /nacion|domest/.test(tipo);

  const oriBR  = oc ? IATAS_BR.has(oc) : null;
  const destBR = dc ? IATAS_BR.has(dc) : null;

  let isDomestico;
  if (oriBR === true && destBR === true) {
    // Ambos os IATAs reconhecidos como brasileiros → nacional
    isDomestico = true;
  } else if (nacionalIA && (oriBR === true || destBR === true || (oriBR === null && destBR === null))) {
    // A fonte diz que é nacional e nada contradiz (IATA BR fora da lista, p.ex.)
    isDomestico = true;
  } else if (oriBR === null && destBR === null) {
    // Sem códigos IATA: assume nacional salvo se a fonte disser internacional
    isDomestico = !internacionalIA;
  } else {
    isDomestico = false;
  }

  // Nacional BR: o programa determina a operadora
  // (Smiles→GOL, Azul Fidelidade→Azul, LATAM Pass→LATAM)
  if (isDomestico && CIA_POR_PROGRAMA[programa]) {
    return normalizarCia(CIA_POR_PROGRAMA[programa]);
  }
  // Internacional com CIA explícita na fonte (ex: Air France, Turkish) — respeita
  if (cia && cia !== programa) return normalizarCia(cia);
  // Doméstico sem CIA identificada: programa determina a operadora
  if (isDomestico) return normalizarCia(CIA_POR_PROGRAMA[programa] || cia);
  // Internacional Smiles sem CIA: a GOL quase não voa internacional —
  // tenta a parceira típica do destino; senão, "Desconhecida" (nunca GOL).
  if (programa === 'Smiles') {
    const porDestino = CIA_SMILES_POR_DESTINO[dc] || CIA_SMILES_POR_DESTINO[chaveDestinoSmiles(destinoNome)];
    return porDestino || 'Desconhecida';
  }
  // Demais programas (LATAM Pass, Azul Fidelidade): a própria cia do programa
  // opera amplamente voos internacionais — mantém o comportamento anterior.
  return normalizarCia(CIA_POR_PROGRAMA[programa] || cia || 'Desconhecida');
}
const JSON_EXEMPLO = (i) => '{"resultados":[{"valido":true,"indice":'+i+',"origem":"São Paulo","destino":"Cancún","origemCodigo":"GRU","destinoCodigo":"CUN","cia":"LATAM","programa":"LATAM Pass","pontos":"31494","cabine":"Economica","tipoVoo":"internacional","direcao":"ida_volta","datasIda":"Jun/26: 16, 19, 22","datasVolta":"Jun/26: 22, 23"}]}';
const JSON_INVALIDO = (i) => '{"resultados":[{"valido":false,"indice":'+i+'}]}';

// ── PASSO 1: CLASSIFICAR (CDV) ────────────────────────────────────────────────
// ── FILTRO: programas descartados automaticamente nos monitoramentos ─────────
// Emissoes cujo programa seja Aeroplan ou Aegean nao devem alimentar a aba
// Alertas do gerador-cdv — marcamos como invalidas (preserva indices p/ pareamento).
const PROGRAMAS_BLOQUEADOS_ALERTA = /aeroplan|aegean/i;
function filtrarProgramasBloqueados(resultados) {
  return resultados.map(r => {
    if (r?.valido && PROGRAMAS_BLOQUEADOS_ALERTA.test(String(r.programa || ''))) {
      console.log('   [FILTRO] Descartada por programa bloqueado: ' + r.programa + ' (' + (r.origemCodigo || r.origem || '?') + '->' + (r.destinoCodigo || r.destino || '?') + ')');
      return { ...r, valido: false };
    }
    return r;
  });
}

async function classificarItens(itens, grupoId) {
  const resultados = [];

  if (grupoId === GRUPO_APENAS_IMAGEM) {
    // Aceita também itens SEM imagem mas COM legenda (ex: download da imagem
    // falhou) — a legenda deste grupo traz rota, programa e milhas completos,
    // o que permite ao menos classificar e parear ida/volta. Antes esses itens
    // eram descartados silenciosamente e o par nunca fechava.
    const itensClassificaveis = itens.filter(item => item.imagemBase64 || (item.texto && item.texto.trim() && item.texto.trim() !== '[imagem sem legenda]'));
    const descartados = itens.length - itensClassificaveis.length;
    if (descartados > 0) console.log('[GRUPO-IMG] '+descartados+' item(ns) sem imagem e sem legenda descartado(s).');
    if (itensClassificaveis.length === 0) { console.log('[GRUPO-IMG] Nenhum item classificável, descartando.'); return []; }

    for (let i = 0; i < itensClassificaveis.length; i++) {
      const item = itensClassificaveis[i];
      const indiceOriginal = itens.indexOf(item);
      const temImagem  = !!item.imagemBase64;
      const temLegenda = !!(item.texto && item.texto.trim());
      const introducaoImg = !temImagem
        ? (
            'Este texto é a legenda de uma postagem de um grupo de alertas de passagens aéreas com milhas. A imagem que a acompanhava não pôde ser baixada — extraia TODOS os dados possíveis da legenda abaixo. As datas de ida/volta normalmente ficam na imagem; se não constarem na legenda, deixe os campos de datas vazios.\n\n'
            +'"""\n'+item.texto.trim()+'\n"""\n\n'
          )
        : temLegenda
        ? (
            'Esta imagem é de um grupo de alertas de passagens aéreas com milhas. Ela veio acompanhada da seguinte legenda/descrição em texto:\n\n'
            +'"""\n'+item.texto.trim()+'\n"""\n\n'
            +'REGRAS DE PRIORIDADE (IMPORTANTE):\n'
            +'1. Trate a legenda acima como fonte PRINCIPAL: programa de fidelidade, origem, destino, quantidade de milhas/pontos, classe/cabine e companhia aérea ("cia") normalmente já vêm prontos nela — extraia esses campos do texto.\n'
            +'2. Use a IMAGEM principalmente para ler as DATAS de ida e volta, que costumam ser a única informação que falta na legenda.\n'
            +'3. Se algum campo não estiver claro na legenda (ex: código IATA, cia), complemente lendo a imagem.\n'
            +'4. Se legenda e imagem tiverem informação conflitante em algum campo, priorize a legenda.\n\n'
          )
        : (
            'Esta imagem é de um grupo de alertas de passagens aéreas com milhas e não veio acompanhada de nenhum texto/legenda. Extraia TODOS os dados diretamente da imagem.\n\n'
          );
      const content = [
        ...(temImagem ? [{ type:'image', source:{ type:'base64', media_type:'image/jpeg', data:item.imagemBase64 } }] : []),
        { type:'text', text:
          introducaoImg
          +'Leia (priorizando a legenda quando houver, complementando com a imagem):\n'
          +'- Programa de fidelidade (ex: LATAM Pass, Smiles, Azul Fidelidade, Azul pelo Mundo)\n'
          +'- Origem e destino com código IATA\n'
          +'- Quantidade de milhas/pontos\n'
          +'- Classe (Econômica ou Executiva)\n'
          +'- Companhia aérea operadora do voo (campo "cia")\n'
          +'- Datas de ida\n'
          +'- Datas de volta (pode estar em imagem separada)\n\n'
          +'CRÍTICO sobre códigos IATA (origemCodigo e destinoCodigo):\n'
          +'- Leia o código IATA EXATAMENTE como aparece na legenda ou na imagem. Ex: se mostrar "VIX → RAO", origemCodigo="VIX" e destinoCodigo="RAO".\n'
          +'- NUNCA substitua, corrija ou invente um código IATA diferente do que está na fonte.\n'
          +'- Para o campo "origem" use o nome da cidade do IATA de origem. Para "destino" use o nome da cidade do IATA de destino. Ex: VIX=Vitória, RAO=Ribeirão Preto, CLV=Caldas Novas, CTG=Cartagena, CGB=Cuiabá, SSA=Salvador.\n'
          +'- Se não souber o nome da cidade, use o próprio código IATA como nome — nunca invente.\n\n'
          +'CRÍTICO sobre companhia aérea (campo "cia"):\n'
          +'- "cia" é a companhia que OPERA o voo, não o programa de fidelidade.\n'
          +'- Quando o programa for "Azul pelo Mundo", a CIA é sempre uma parceira estrangeira mencionada na fonte (ex: COPA, United, TAP, Air France, KLM, Air Europa). NUNCA coloque "Azul" como CIA nesse programa.\n'
          +'- Frases como "voando pela COPA", "operado por United", "voando pela Air Europa" indicam a CIA correta.\n\n'
          +'Se houver APENAS datas de ida (sem datas de volta) ou APENAS datas de volta, preencha somente o campo correspondente e deixe o outro vazio.\n'
          +'Normalize as datas para o formato "Mês/Ano: dias". Ex: "Jun/26: 11, 13, 15".\n'
          +'IMPORTANTE sobre cidades: use o nome completo da cidade, não o código IATA.\n\n'
          +PROGRAMAS_VALIDOS+'\n\n'
          +'Responda com este JSON:\n'+JSON_EXEMPLO(indiceOriginal)+'\n'
          +'Se não houver passagem aérea retorne: '+JSON_INVALIDO(indiceOriginal)
        }
      ];
      const resultado = await chamarClaude(SYSTEM_CDV, content, 4096);
      const lista = resultado?.resultados || (resultado?.valido !== undefined ? [resultado] : [{ valido:false, indice:indiceOriginal }]);
      for (const r of lista) {
        // Indice deterministico do item no buffer - nunca confia no valor devolvido
        // pela IA (ela renumera quando um mesmo item contem varias emissoes,
        // fazendo a oferta herdar imagem/texto original de OUTRA mensagem).
        if (r) r.indice = indiceOriginal;
        if (r?.valido) {
          r.origem  = resolverCidade(r.origemCodigo, r.origem);
          r.destino = resolverCidade(r.destinoCodigo, r.destino);
          r.cia     = corrigirCia(r.cia, r.programa, r.origemCodigo, r.destinoCodigo, r.tipoVoo, r.destino);
        } else {
          // Diagnóstico: item do grupo-imagem descartado como inválido
          console.log('[GRUPO-IMG] Item '+indiceOriginal+' classificado como INVÁLIDO ('+(temImagem?'com imagem':'sem imagem')+'). Legenda: '+(item.texto||'').slice(0,80).replace(/\n/g,' | '));
        }
        resultados.push(r || { valido:false, indice:indiceOriginal });
      }
    }
    return filtrarProgramasBloqueados(resultados);
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
        // Indice deterministico do item no buffer - nunca confia no valor devolvido
        // pela IA (ela renumera quando um mesmo item contem varias emissoes,
        // fazendo a oferta herdar imagem/texto original de OUTRA mensagem).
        if (r) r.indice = indiceOriginal;
        if (r?.valido) {
          r.cabine  = 'Executiva';
          r.origem  = resolverCidade(r.origemCodigo, r.origem);
          r.destino = resolverCidade(r.destinoCodigo, r.destino);
          r.cia     = corrigirCia(r.cia, r.programa, r.origemCodigo, r.destinoCodigo, r.tipoVoo, r.destino);
        }
        resultados.push(r || { valido:false, indice:indiceOriginal });
      }
    }
    return filtrarProgramasBloqueados(resultados);
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
        // Indice deterministico do item no buffer - nunca confia no valor devolvido
        // pela IA (ela renumera quando um mesmo item contem varias emissoes,
        // fazendo a oferta herdar imagem/texto original de OUTRA mensagem).
        if (r) r.indice = indiceOriginal;
        if (r?.valido) {
          r.origem  = resolverCidade(r.origemCodigo, r.origem);
          r.destino = resolverCidade(r.destinoCodigo, r.destino);
          r.cia     = corrigirCia(r.cia, r.programa, r.origemCodigo, r.destinoCodigo, r.tipoVoo, r.destino);
        }
        resultados.push(r || { valido:false, indice:indiceOriginal });
      }
    }
    return filtrarProgramasBloqueados(resultados);
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
      // Indice deterministico do item no buffer (ver comentario acima).
      if (r) r.indice = i;
      if (r?.valido) {
        r.origem  = resolverCidade(r.origemCodigo, r.origem);
        r.destino = resolverCidade(r.destinoCodigo, r.destino);
        r.cia     = corrigirCia(r.cia, r.programa, r.origemCodigo, r.destinoCodigo, r.tipoVoo, r.destino);
      }
      resultados.push(r || { valido:false, indice:i });
    }
  }
  return filtrarProgramasBloqueados(resultados);
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

    // Diagnóstico: rota é invertida mas alguma condição barrou a mescla
    if (rotaInvertida && !(mesmoPrograma && mesmaCabine && mesmaCia && milhasSimilares)) {
      const motivos = [];
      if (!mesmoPrograma)   motivos.push('programa "'+(v.programa||'?')+'"≠"'+(w.programa||'?')+'"');
      if (!mesmaCabine)     motivos.push('cabine "'+(v.cabine||'?')+'"≠"'+(w.cabine||'?')+'"');
      if (!mesmaCia)        motivos.push('cia "'+(v.cia||'?')+'"≠"'+(w.cia||'?')+'"');
      if (!milhasSimilares) motivos.push('milhas '+pV+' vs '+pW+' ('+Math.round(Math.abs(pV-pW)/Math.max(pV,pW)*100)+'%)');
      console.log('[MERGE-SKIP] '+(v.origemCodigo||v.origem)+'<->'+(w.origemCodigo||w.origem)+' rota invertida mas: '+motivos.join(' | '));
    }

    return mesmoPrograma && mesmaCabine && mesmaCia && milhasSimilares && rotaInvertida;
  }

  const usados = new Set();

  while (i < validas.length) {
    if (usados.has(i)) { i++; continue; }
    const v = validas[i];

    let parIdx = -1;
    // Busca par ida/volta em TODO o restante do buffer.
    // (Antes limitava a 2 posições à frente — perdia pares separados por
    // outras postagens dentro da mesma janela de 3 min.)
    // O Set "usados" garante que nenhuma mensagem é reutilizada.
    for (let j = i + 1; j <= validas.length - 1; j++) {
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
    // Valida cia e milhas antes de mesclar (mesmo rigor de ehParInvertido):
    // rota+programa+cabine já batem pela chave; cia deve bater (leniente se vazia)
    // e milhas devem estar dentro de ±15%.
    const dE = esperando.oferta.dadosExtraidos || {};
    const dO = oferta.dadosExtraidos || {};
    const ciaE = (dE.cia||'').toLowerCase().trim();
    const ciaO = (dO.cia||'').toLowerCase().trim();
    const mesmaCia = !ciaE || !ciaO || ciaE === ciaO;
    const pE = Number(dE.pontos) || 0;
    const pO = Number(dO.pontos) || 0;
    const milhasSimilares = pE === 0 || pO === 0 || Math.abs(pE - pO) / Math.max(pE, pO) <= 0.15;
    if (!mesmaCia || !milhasSimilares) {
      const motivos = [];
      if (!mesmaCia)        motivos.push('cia "'+(dE.cia||'?')+'"≠"'+(dO.cia||'?')+'"');
      if (!milhasSimilares) motivos.push('milhas '+pE+' vs '+pO);
      console.log('[PAR-BUFFER] Par com mesma chave mas incompatível ('+motivos.join(' | ')+') — liberando ambas separadas.');
      return false; // libera a nova como somente-ida; a que espera segue no timer
    }
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
    const hist180Par = await registrarPassagemProxy({ origem:mesclada.dadosExtraidos?.origem||'', destino:mesclada.dadosExtraidos?.destino||'', cia:mesclada.dadosExtraidos?.cia||'', programa:mesclada.dadosExtraidos?.programa||'', pontos:Number(mesclada.dadosExtraidos?.pontos)||0, cabine:mesclada.dadosExtraidos?.cabine||'Economica', datas_ida:mesclada.dadosExtraidos?.datasIda||'', datas_volta:mesclada.dadosExtraidos?.datasVolta||'', fonte:'alerta_pendente', apenasConsulta:true });
    if (precoForaDaCurva(mesclada.dadosExtraidos?.pontos, hist180Par, mesclada.dadosExtraidos?.tipoVoo)) {
      console.log('[PAR-BUFFER] Par mesclado descartado pelo filtro 180d: ' + (mesclada.dadosExtraidos?.origemCodigo) + '↔' + (mesclada.dadosExtraidos?.destinoCodigo));
      return true; // consumido (descartado)
    }
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
      registrarPassagemProxy({ origem:oferta.dadosExtraidos?.origem||'', destino:oferta.dadosExtraidos?.destino||'', cia:oferta.dadosExtraidos?.cia||'', programa:oferta.dadosExtraidos?.programa||'', pontos:Number(oferta.dadosExtraidos?.pontos)||0, cabine:oferta.dadosExtraidos?.cabine||'Economica', datas_ida:oferta.dadosExtraidos?.datasIda||'', datas_volta:oferta.dadosExtraidos?.datasVolta||'', fonte:'alerta_pendente', apenasConsulta:true })
        .then(hist180 => {
          if (precoForaDaCurva(oferta.dadosExtraidos?.pontos, hist180, oferta.dadosExtraidos?.tipoVoo)) {
            console.log('[PAR-BUFFER] Somente-ida descartada pelo filtro 180d: ' + (oferta.dadosExtraidos?.origemCodigo) + '->' + (oferta.dadosExtraidos?.destinoCodigo));
            return;
          }
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
        const hist180Bypass = await registrarPassagemProxy({ origem:dados.origem, destino:dados.destino, cia:dados.cia, programa:dados.programa, pontos:Number(dados.pontos)||0, cabine:dados.cabine, datas_ida:dados.datasIda, datas_volta:dados.datasVolta, fonte:'alerta_pendente', apenasConsulta:true });
        if (precoForaDaCurva(dados.pontos, hist180Bypass, dados.tipoVoo)) {
          console.log('[BYPASS] Emissão descartada pelo filtro 180d: ' + v.origemCodigo + '->' + v.destinoCodigo + ' (' + v.programa + ')');
          continue;
        }
        const mensagem = appendHistoricoMensagem(formatarMensagemCDV(dados), hist180Bypass);
        // indices já contém os índices reais de itens[] — inclui par ida+volta após mesclarParesIdaVolta
        const imagens  = indices.map(i => itens[i]?.imagemBase64).filter(Boolean);
        const oferta   = { id:gerarId(), timestamp:new Date().toISOString(), grupoOrigem:grupoId, tipoConteudo:imagens.length>1?imagens.length+' imagens':imagens.length===1?'imagem':'texto', conteudoOriginal:textos, imagens, mensagemFormatada:mensagem, dadosExtraidos:{ ...dados, indices }, status:'pendente' };
        // Somente-ida: aguarda até 5 min por par ida/volta de outro buffer
        // (antes o bypass entrava direto na fila e pares divididos entre
        // buffers viravam duas ofertas separadas)
        const parEsperandoBypass = await aguardarParIdaVolta(oferta, grupoId);
        if (!parEsperandoBypass) {
          filaPendentes.unshift(oferta);
          salvarFila();
          console.log('[BYPASS] Oferta criada direto: '+v.origemCodigo+'->'+v.destinoCodigo+' ('+v.programa+')');
        }
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

      const hist180Normal = await registrarPassagemProxy({ origem:emissao.origem, destino:emissao.destino, cia:emissao.cia, programa:emissao.programa, pontos:Number(emissao.pontos)||0, cabine:emissao.cabine||'Economica', datas_ida:emissao.datasIda||'', datas_volta:emissao.datasVolta||'', fonte:'alerta_pendente', apenasConsulta:true });
      if (precoForaDaCurva(emissao.pontos, hist180Normal, emissao.tipoVoo)) {
        console.log('[FILTRO-180D] Emissão descartada: ' + emissao.origem + '->' + emissao.destino + ' (' + emissao.programa + ')');
        continue;
      }
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

// Buffer circular de diagnostico dos ultimos upserts recebidos (ver /debug-upserts).
const _debugUpserts = [];

// jid -> nome do grupo. Preenchido sob demanda para o painel mostrar de onde
// veio cada oferta sem depender de uma chamada extra ao WhatsApp.
const NOMES_GRUPOS = new Map();
async function atualizarNomesGrupos() {
  if (!sock || !conectado) return;
  try {
    const chats = await sock.groupFetchAllParticipating();
    for (const g of Object.values(chats)) NOMES_GRUPOS.set(g.id, g.subject || '(sem nome)');
    console.log('[GRUPOS] Cache de nomes atualizado — ' + NOMES_GRUPOS.size + ' grupo(s).');
  } catch (e) { console.warn('[GRUPOS] Falha ao atualizar cache de nomes:', e.message); }
}

// Arquivos de ./sessao que sobrevivem a um reset completo: nao sao credenciais
// do WhatsApp e nao se regeneram sozinhos. Ao criar um arquivo novo nessa pasta,
// avaliar se ele pertence a esta lista.
const PRESERVAR_NO_RESET = new Set([
  'fila_pendentes.json',    // fila de aprovacao
  'agendamentos.json',      // envios agendados
  'telegram_session.txt',   // sessao do Telegram (independente do WhatsApp)
  'cupons_base.json',       // base de cupons — cadastro manual/capturado
  'radar_config.json',      // papeis fonte/destino dos grupos do radar
  'cupons_vistos.json',     // dedup de cupons
  'radar_vistos.json',      // dedup do radar
  'msgs-enviadas.json',     // dedup de mensagens enviadas
]);

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

// Desembrulha wrappers comuns do WhatsApp (mensagens efêmeras, view-once,
// documento com legenda, etc.) até chegar ao conteúdo real.
const _WRAPPERS_WA = ['ephemeralMessage','viewOnceMessage','viewOnceMessageV2','viewOnceMessageV2Extension','documentWithCaptionMessage','deviceSentMessage'];
function desembrulharMessage(m) {
  let atual = m, prof = 0;
  while (atual && prof < 5) {
    const chave = _WRAPPERS_WA.find(w => atual[w]);
    if (!chave) break;
    atual = atual[chave].message || atual[chave];
    prof++;
  }
  return atual || m;
}

// Tipos que geram captura. A detecção busca por PRIORIDADE entre as chaves —
// nunca pela primeira chave do objeto (Object.keys(m)[0]), pois mensagens com
// metadados E2E na frente (ex: messageContextInfo, comum em imagens enviadas
// como álbum) eram classificadas com o tipo errado e descartadas SEM LOG.
const _TIPOS_TRATADOS = ['imageMessage','extendedTextMessage','conversation'];
// Tipos sem valor de captura — descartados sem log para não poluir
const _TIPOS_IGNORADOS = new Set(['protocolMessage','reactionMessage','pollUpdateMessage','senderKeyDistributionMessage','messageContextInfo','stickerMessage','audioMessage','pollCreationMessage','pollCreationMessageV2','pollCreationMessageV3']);

// ── RADAR DE MARKETPLACE ─────────────────────────────────────────────────────
// Extrai o link do produto da mensagem do grupo-fonte, consulta a Creators API
// (que e a fonte da verdade de preco e estoque — nunca o texto do grupo) e
// enfileira em filaPendentes com tipoConteudo 'oferta_amazon'. A partir dai
// segue exatamente o mesmo caminho de aprovacao dos cupons TSP.
async function baixarImagemProduto(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 4 * 1024 * 1024) return null;
    return { imagemBase64: buf.toString('base64'), mime: res.headers.get('content-type') || 'image/jpeg' };
  } catch (e) {
    console.warn('[MKT] Nao baixou a imagem do produto:', e.message);
    return null;
  }
}

async function processarRadarMarketplace(jid, texto) {
  if (!texto) return;

  // Uma mensagem pode trazer link de mais de uma loja; cada pipeline cuida dos
  // links que reconhece e ignora o resto.
  const resultados = [];

  // O cadastro de monitoramento decide loja a loja: um grupo pode estar dentro
  // da janela para Amazon e fora para Shopee.
  const podeAmazon = podeCapturar(jid, 'Amazon');
  if (podeAmazon.ok) {
    try { resultados.push(...await processarTextoAmazon(texto)); }
    catch (e) { console.error('[MKT] Falha no pipeline Amazon:', e.message); }
  } else if (/amazon|amzn|a\.co/i.test(texto)) {
    console.log('[MONITOR] Amazon ignorada em ' + jid.split('@')[0] + ' — ' + podeAmazon.motivo);
  }

  if (ehLinkShopee(texto)) {
    const podeShopee = podeCapturar(jid, 'Shopee');
    if (!podeShopee.ok) {
      console.log('[MONITOR] Shopee ignorada em ' + jid.split('@')[0] + ' — ' + podeShopee.motivo);
    } else if (!credenciaisShopeeOk()) {
      console.warn('[SHOPEE] Link detectado mas SHOPEE_APP_ID/SHOPEE_SECRET nao estao configurados.');
    } else {
      try { resultados.push(...await processarTextoShopee(texto)); }
      catch (e) { console.error('[SHOPEE] Falha no pipeline:', e.message); }
    }
  }
  if (!resultados.length) return;

  for (const r of resultados) {
    if (!r.mensagem) {
      console.log('[MKT] ' + (r.produto?.asin || r.produto?.itemId || '?') + ' descartado — ' + r.descartadoPor);
      continue;
    }
    const p = r.produto;
    const imagem = await baixarImagemProduto(p.imagemUrl);

    const oferta = {
      id: gerarId(),
      tipoConteudo: p.loja === 'Shopee' ? 'oferta_shopee' : 'oferta_amazon',
      origem: jid,
      conteudoOriginal: texto,
      mensagemFormatada: r.mensagem,
      dadosExtraidos: {
        loja: p.loja || 'Amazon',
        asin: p.asin,
        titulo: p.titulo,
        preco: p.preco,
        precoDe: p.precoDe,
        desconto: p.desconto,
        link: p.link,
        vendedor: p.vendedor,
        ehDeal: p.ehDeal,
        cupom: r.cupom || null,
        precoFinal: r.precoFinal ?? p.preco,
      },
      imagens: imagem ? [imagem] : [],
      // Nome do grupo resolvido na captura: no painel o jid sozinho nao diz nada,
      // e a lista de grupos pode nao estar carregada quando a fila renderiza.
      grupoOrigem: jid,
      grupoOrigemNome: (NOMES_GRUPOS.get(jid) || null),
      status: 'pendente',
      timestamp: new Date().toISOString(),
    };

    filaPendentes.unshift(oferta);
    salvarFila();
    console.log('[MKT] Oferta #' + oferta.id + ' na fila — ' + p.asin + ' R$ ' + p.preco + ' (' + p.desconto + '% off)');
  }
}

async function processarMensagem(msg) {
  try {
    const jid    = msg.key.remoteJid;
    // Dois monitoramentos convivem: GRUPOS_MONITORADOS alimenta o pipeline de
    // emissoes CDV; os grupos marcados como 'fonte' no painel alimentam o radar
    // de marketplace. Um grupo pode estar so em um dos dois.
    const _ehRadar = ehFonteRadar(jid);
    if (!GRUPOS_MONITORADOS.includes(jid) && !_ehRadar) return;
    const m    = desembrulharMessage(msg.message);
    const tipo = _TIPOS_TRATADOS.find(t => m && m[t]) || Object.keys(m || {})[0];
    let texto = '', imagemB64 = null;
    if (tipo === 'conversation') { texto = m.conversation; }
    else if (tipo === 'extendedTextMessage') { texto = m.extendedTextMessage.text; }
    else if (tipo === 'imageMessage') {
      texto = m.imageMessage.caption || '';
      try {
        const buffer = await downloadMediaMessage(msg,'buffer',{},{ logger:pino({level:'silent'}), reuploadRequest:sock.updateMediaMessage });
        imagemB64 = buffer.toString('base64');
      } catch(e) { console.error('[IMG] Erro ao baixar imagem:', e.message); if (!texto) texto = '[imagem sem legenda]'; }
    } else {
      // Antes: return silencioso. Agora loga o tipo não tratado de grupos
      // monitorados para nenhuma mensagem sumir sem rastro.
      const chaves = Object.keys(m || {});
      if (!chaves.every(k => _TIPOS_IGNORADOS.has(k))) {
        console.log('[MSG] Tipo não tratado de ' + jid.split('@')[0] + ': [' + chaves.join(', ') + '] — descartada.');
      }
      return;
    }
    if (!texto && !imagemB64) return;

    console.log('[MSG] Capturada de', jid.split('@')[0], '— tipo:', tipo, texto ? '| texto: '+texto.slice(0,60) : '| imagem');
    ultimaCapturaPorGrupo.set(jid, Date.now());

    if (texto && (
      texto.includes('Dica de emissao encontrada por @davileles') ||
      texto.includes('Dica de emissão encontrada por @davileles') ||
      texto.includes('Faca parte do Balcao clicando aqui') ||
      texto.includes('Faça parte do Balcão clicando aqui')
    )) { return; }

    // Radar de marketplace: sai antes do buffer de agrupamento, que e do
    // pipeline de emissoes CDV e nao sabe lidar com link de produto.
    if (_ehRadar) {
      await processarRadarMarketplace(jid, texto);
      if (!GRUPOS_MONITORADOS.includes(jid)) return;
    }

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
var ERROS_SOFT_MAX  = 8;   // 8 falhas seguidas → cura cirúrgica (só sender keys, sem reconectar)
var ERROS_DESCR_MAX = 20;  // 20 falhas seguidas → limpa sessions+sender keys (pre-keys preservadas)
var isResetting     = false; // true durante limpeza de sessão — bloqueia conexões/timers concorrentes
var _reconnectTimer = null;  // referência única do timer de reconexão pendente (evita corrida)

// Agenda uma única reconexão, cancelando qualquer timer pendente anterior.
function _agendarReconexao(delay) {
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); }
  _reconnectTimer = setTimeout(() => { _reconnectTimer = null; conectar(); }, delay);
}

async function limparSessaoEReconectar() {
  if (isResetting) { console.log('[WA] Reset já em andamento, ignorando chamada duplicada.'); return; }
  isResetting = true;
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  conectado = false;
  const sockRef = sock;
  sock = null;
  if (sockRef) { try { sockRef.end(new Error('bad-session')); } catch(e) {} }
  try {
    const arquivos = await readdir(SESSAO_DIR);
    for (const arq of arquivos) {
      // IMPORTANTE: NUNCA apagar arquivos 'pre-key-*'. As pre-keys locais precisam
      // bater com as registradas nos servidores do WhatsApp; apagá-las tornava
      // IMPOSSÍVEL decifrar qualquer nova sessão recebida (inclusive as re-tentativas
      // automáticas dos remetentes) → loop permanente de "Bad MAC" até novo QR.
      // Sessions e sender-keys são seguras de apagar: os remetentes as recriam
      // sozinhos via retry receipt, desde que as pre-keys estejam intactas.
      if (arq.startsWith('session-') || arq.startsWith('sender-key')) {
        await unlink(SESSAO_DIR + '/' + arq).catch(() => {});
      }
    }
  } catch(e) {}
  errosDescripto = 0;
  isResetting = false;
  _agendarReconexao(3000);
}

// Cura cirúrgica: apaga SOMENTE as sender keys (chaves de decodificação de grupos),
// sem derrubar a conexão e sem tocar em sessions/pre-keys. Como o auth state lê as
// chaves do disco sob demanda, o efeito é imediato: na próxima mensagem de cada
// grupo o Baileys envia retry receipt e o remetente redistribui a chave nova.
async function limparSenderKeys() {
  try {
    const arquivos = await readdir(SESSAO_DIR);
    let n = 0;
    for (const arq of arquivos) {
      if (arq.startsWith('sender-key')) {
        await unlink(SESSAO_DIR + '/' + arq).catch(() => {});
        n++;
      }
    }
    console.log('[WA] Cura cirúrgica: ' + n + ' sender keys apagadas (conexão mantida, remetentes redistribuirão as chaves).');
  } catch(e) { console.error('[WA] Erro na cura cirúrgica:', e.message); }
}

// Guarda as últimas mensagens ENVIADAS para responder retry receipts (getMessage).
const mensagensEnviadas = new Map();
function guardarMensagemEnviada(info) {
  try {
    if (info?.key?.id && info.message) {
      mensagensEnviadas.set(info.key.id, info.message);
      if (mensagensEnviadas.size > 300) mensagensEnviadas.delete(mensagensEnviadas.keys().next().value);
    }
  } catch(e) {}
}

// Última mensagem capturada por grupo monitorado (observabilidade em /status).
const ultimaCapturaPorGrupo = new Map();

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
    // Erros 500 são falhas de stream comuns em conexões longas — NUNCA apagar
    // sessão por causa deles. O wipe automático que existia aqui destruía as
    // chaves de decodificação dos grupos a cada instabilidade de rede e era a
    // causa raiz das mensagens sumirem da aba Alertas. Apenas reconectar com backoff.
    const delay = Math.min(5000 * _erros500Consecutivos, 60000);
    console.log('[WA] Stream error 500 (' + _erros500Consecutivos + ' seguido(s)). Reconectando em ' + (delay/1000) + 's...');
    return delay;
  } else {
    _erros500Consecutivos = 0;
  }
  _reconectarTentativas++;
  const delay = Math.min(5000 * Math.pow(2, _reconectarTentativas - 1), 60000);
  console.log('[WA] Erro (código ' + codigo + '). Reconectando em ' + (delay/1000) + 's...');
  return delay;
}

async function conectar() {
  if (isResetting) {
    console.log('[WA] Reset de sessão em andamento, adiando reconexão.');
    _agendarReconexao(3000);
    return;
  }
  if (isConnecting) {
    console.log('[WA] Conexão já em andamento, ignorando chamada duplicada.');
    return;
  }
  isConnecting = true;

  try {
    const { state, saveCreds } = await useAuthStateAtomico(SESSAO_DIR);
    const { version }          = await fetchLatestBaileysVersion();
    const novaSock = makeWASocket({
      version,
      auth: state,
      logger: baileysLogger,
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: true,
      // getMessage real: quando um destinatário não consegue decifrar uma mensagem
      // NOSSA, o WhatsApp pede reenvio (retry receipt). Devolver undefined fazia o
      // reenvio falhar e o destinatário ficar preso em "aguardando mensagem".
      getMessage: async (key) => mensagensEnviadas.get(key?.id),
      // Ignora status e newsletters: reduz drasticamente o volume de decodificação
      // (e de erros Bad MAC) de conteúdo que o servidor nunca usa.
      shouldIgnoreJid: (jid) => jid === 'status@broadcast' || (typeof jid === 'string' && jid.endsWith('@newsletter')),
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
        // Aquece o cache de nomes: a fila mostra de qual grupo veio cada oferta.
        atualizarNomesGrupos().catch(()=>{});
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
          if (delay >= 0) _agendarReconexao(delay);
        }
      }
    });
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      // Diagnostico: registra o evento CRU, antes de qualquer filtro. Sem isso
      // nao da para distinguir "socket nao recebe nada" de "recebe e descarta".
      try {
        for (const mm of (messages || [])) {
          _debugUpserts.push({
            em: new Date().toISOString(),
            type,
            jid: mm.key?.remoteJid || null,
            fromMe: !!mm.key?.fromMe,
            monitorado: GRUPOS_MONITORADOS.includes(mm.key?.remoteJid),
            fonteRadar: ehFonteRadar(mm.key?.remoteJid),
            chaves: mm.message ? Object.keys(mm.message) : null,
            stub: mm.messageStubType ?? null,
          });
          if (_debugUpserts.length > 60) _debugUpserts.shift();
        }
      } catch (e) {}
      if (conectado) resetarHealthTimer();
      if (type !== 'notify') {
        // Upserts 'append' (sync/reconexão) eram descartados sem rastro.
        // Loga quando envolvem grupos monitorados para diagnóstico de sumiços.
        const dosMonitorados = (messages || []).filter(mm => GRUPOS_MONITORADOS.includes(mm.key?.remoteJid));
        if (dosMonitorados.length > 0) {
          console.log('[WA] Upsert tipo "' + type + '" com ' + dosMonitorados.length + ' msg(s) de grupos monitorados DESCARTADA(S): ' + dosMonitorados.map(mm => mm.key?.remoteJid?.split('@')[0] + (mm.message ? ' [' + Object.keys(mm.message).join(',') + ']' : ' [sem message]')).join(' | '));
        }
        return;
      }
      for (const msg of messages) {
        if (msg.messageStubType === 2 || (msg.message === null && !msg.key.fromMe)) {
          errosDescripto++;
          console.warn('[WA] Mensagem indecifrável de ' + (msg.key?.remoteJid || '?') + ' (' + errosDescripto + ' seguidas). Baileys enviou retry receipt ao remetente.');
          if (errosDescripto === ERROS_SOFT_MAX) { limparSenderKeys(); }
          else if (errosDescripto >= ERROS_DESCR_MAX) { errosDescripto = 0; await limparSessaoEReconectar(); return; }
          continue;
        }
        if (msg.message) errosDescripto = 0; // decifrou com sucesso → sessão saudável
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
    if (delay >= 0) _agendarReconexao(delay);
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
  _agendarReconexao(1000);
  res.json({ ok: true, mensagem: 'Reconectando... aguarde 10s e verifique /status' });
});

app.get('/debug-upserts', (req, res) => {
  res.json({
    ok: true,
    total: _debugUpserts.length,
    ultimoEventoEm: _debugUpserts.length ? _debugUpserts[_debugUpserts.length - 1].em : null,
    eventos: _debugUpserts.slice().reverse(),
  });
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
  res.json({ conectado, sockAtivo:!!sock, qrDisponivel:!!qrAtual, telegramConectado:tgConectado, telegramAuthState:tgAuthState, telegramGrupos:TG_CANAIS_MONITORADOS, autoEnvioCupom:AUTO_ENVIO_MODO, telegramConta:tgConta, grupos:Object.keys(GRUPOS), gruposMonitorados:GRUPOS_MONITORADOS, radarFontes:radarFontes(), radarDestinos:radarDestinos(), radarAtivo:radarConfig().ativo!==false, bufferAtivo:emBuffer, filaPendentes:filaPendentes.filter(o=>o.status==='pendente').length, filaTotal:filaPendentes.length, reconectarTentativas:_reconectarTentativas, conexaoEmAndamento:!!_conexaoPromise, errosDecodificacao:errosDescripto, ultimasCapturas:Object.fromEntries([...ultimaCapturaPorGrupo].map(([j,t])=>[j, new Date(t).toISOString()])) });
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

// ── FILA DO RADAR (ofertas de bonificação aprovadas pelo gerador-cdv) ─────────
// Intervalo de 3 min entre envios, sem janela horária (envia a qualquer hora)
const RADAR_INTERVALO_MS = 3 * 60 * 1000;
const filaRadar = []; // { id, mensagem, grupo, tentativas }
let radarWorkerRodando = false;
let radarUltimoEnvioMs = 0;

async function radarWorker() {
  if (radarWorkerRodando) return;
  radarWorkerRodando = true;
  console.log('[RADAR] Worker iniciado. Itens na fila: ' + filaRadar.length);
  while (filaRadar.length > 0) {
    const decorrido = Date.now() - radarUltimoEnvioMs;
    const espera = radarUltimoEnvioMs === 0 ? 0 : Math.max(0, RADAR_INTERVALO_MS - decorrido);
    if (espera > 0) {
      console.log('[RADAR] Aguardando ' + Math.round(espera / 1000) + 's antes do próximo envio...');
      await new Promise(r => setTimeout(r, espera));
    }
    try {
      await aguardarConectado();
    } catch(e) {
      console.error('[RADAR] ' + e.message + '. Aguardando 30s.');
      await new Promise(r => setTimeout(r, 30000));
      continue;
    }
    const item = filaRadar[0];
    if (!item) break;
    try {
      console.log('[RADAR] Enviando oferta "' + item.id + '" para ' + item.grupo + ' (' + filaRadar.length + ' na fila)');
      await enviarMensagem(item.grupo, { text: item.mensagem });
      filaRadar.shift();
      radarUltimoEnvioMs = Date.now();
      console.log('[RADAR] ✓ Oferta "' + item.id + '" enviada. Restam ' + filaRadar.length + '.');
    } catch(e) {
      console.error('[RADAR] ✗ Erro ao enviar "' + item.id + '":', e.message);
      item.tentativas = (item.tentativas || 0) + 1;
      if (item.tentativas >= 3) {
        console.error('[RADAR] Desistindo após 3 tentativas: ' + item.id);
        filaRadar.shift();
      }
      await new Promise(r => setTimeout(r, 10000));
    }
  }
  radarWorkerRodando = false;
  console.log('[RADAR] Worker encerrado (fila vazia).');
}

// POST /radar/enviar — enfileira uma oferta do radar para envio
app.post('/radar/enviar', (req, res) => {
  const { id, mensagem, grupo } = req.body || {};
  if (!mensagem?.trim()) return res.status(400).json({ ok: false, erro: 'mensagem obrigatória' });
  const grupoId = grupo ? (GRUPOS[grupo] || grupo) : GRUPOS['cdv_ofertas'];
  if (!grupoId) return res.status(400).json({ ok: false, erro: 'grupo inválido: ' + grupo });

  const posicao = filaRadar.length;
  filaRadar.push({ id: id || ('r_' + Date.now()), mensagem, grupo: grupoId, tentativas: 0 });

  const agora = Date.now();
  const decorrido = agora - radarUltimoEnvioMs;
  const esperaMs = radarUltimoEnvioMs === 0 ? 0 : Math.max(0, RADAR_INTERVALO_MS - decorrido);
  const totalMs = esperaMs + posicao * RADAR_INTERVALO_MS;
  const minutos = Math.round(totalMs / 60000);

  console.log('[RADAR] Oferta "' + (id || '?') + '" enfileirada na posição ' + (posicao + 1));
  radarWorker().catch(e => { console.error('[RADAR] Worker erro:', e.message); radarWorkerRodando = false; });

  res.json({ ok: true, posicao: posicao + 1, minutos, total: filaRadar.length });
});

// GET /radar/fila — inspecionar a fila do radar
app.get('/radar/fila', (req, res) => {
  res.json({
    total: filaRadar.length,
    workerAtivo: radarWorkerRodando,
    intervaloMinutos: RADAR_INTERVALO_MS / 60000,
    itens: filaRadar.map((item, idx) => ({
      posicao: idx + 1,
      id: item.id,
      tentativas: item.tentativas || 0,
      preview: item.mensagem.substring(0, 80) + (item.mensagem.length > 80 ? '...' : ''),
    })),
  });
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
    const cabineTag = d.cabine==='Executiva'?'<span class="tag tag-exec">Executiva</span>':'<span class="tag tag-eco">Econômica</span>';
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

app.get('/grupos/nomes', (req, res) => {
  if (!NOMES_GRUPOS.size) atualizarNomesGrupos().catch(()=>{});
  res.json({ ok:true, nomes: Object.fromEntries(NOMES_GRUPOS) });
});

app.get('/painel-json', (req, res) => {
  try {
    limparFila(); // garante que cupons com +12h nunca apareçam no painel
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

  // Campos corrigidos no painel entram em dadosExtraidos ANTES do envio, para
  // que o worker (unico ponto de gravacao definitiva) registre em
  // passagens.json exatamente o que foi revisado — e nao a extracao bruta da IA.
  const deFinal = aplicarDadosEditados(oferta, req.body.dados);
  if (req.body.dados) salvarFila();

  if (agendarEm) {
    const dispararEm = new Date(agendarEm).getTime();
    if (isNaN(dispararEm)) return res.status(400).json({ ok:false, erro:'Data inválida.' });
    const agId = gerarId();
    agendamentos.push({ id:agId, ofertaId:oferta.id, dados:oferta.dadosExtraidos || null, grupo:'cdv_emissao', mensagem, dispararEm, status:'aguardando', criadoEm:new Date().toISOString() });
    salvarAgendamentos();
    oferta.status = 'agendado'; oferta.mensagemFinal = mensagem; salvarFila();
    const horario = new Intl.DateTimeFormat('pt-BR',{timeZone:TZ_SP,dateStyle:'short',timeStyle:'short'}).format(new Date(dispararEm));
    return res.json({ ok:true, agendado:true, horario });
  }

  if (oferta.tipoConteudo === 'cupom_tsp') {
    try {
      await enviarCupomParaGrupos(mensagem, oferta.imagens?.[0]);
      oferta.status = 'enviado'; oferta.mensagemFinal = mensagem; salvarFila();
      res.json({ ok:true });
    } catch(err) { res.status(500).json({ ok:false, erro: err.message }); }
    return;
  }

  if (TIPOS_OFERTA_MARKETPLACE.has(oferta.tipoConteudo)) {
    try {
      const r = await enviarOfertaParaDestinos(mensagem, oferta.imagens?.[0], oferta);
      oferta.status = 'enviado'; oferta.mensagemFinal = mensagem;
      oferta.destinos = r.enviados; oferta.falhas = r.falhas;
      salvarFila();
      res.json({ ok:true, enviados:r.enviados.length, falhas:r.falhas });
    } catch(err) { res.status(500).json({ ok:false, erro: err.message }); }
    return;
  }

  const info = calcularPosicaoFila(filaEnvio.length);
  oferta.status = 'aprovado'; oferta.mensagemFinal = mensagem; salvarFila();
  enfileirarEnvio(oferta.id, mensagem, GRUPOS[GRUPO_DESTINO_PASSAGENS], deFinal);
  res.json({ ok:true, posicao:info.posicao, tempoMin:info.tempoMin, horario:info.horario });
});

// ── Backfill: registra no proxy todos os 'enviados' que ainda não têm enviadoEm ─
app.post('/backfill-passagens', async (req, res) => {
  const force = req.body?.force === true;
  const enviados = filaPendentes.filter(o =>
    o.status === 'enviado' &&
    (force || !o.enviadoEm) &&
    o.tipoConteudo !== 'cupom_tsp' &&
    o.dadosExtraidos?.origem &&
    o.dadosExtraidos?.destino &&
    o.dadosExtraidos?.programa
  );
  console.log('[BACKFILL] Iniciando para ' + enviados.length + ' registros sem enviadoEm');
  let ok = 0, fail = 0;
  for (const oferta of enviados) {
    // Usa o timestamp original como data de envio
    const dataEnvio = oferta.timestamp || new Date().toISOString();
    oferta.enviadoEm = dataEnvio;
    const de = oferta.dadosExtraidos;
    try {
      await registrarPassagemProxy({
        origem:      de.origem,
        destino:     de.destino,
        cia:         de.cia || '',
        programa:    de.programa,
        pontos:      Number(de.pontos) || 0,
        cabine:      de.cabine || 'Economica',
        datas_ida:   de.datasIda || '',
        datas_volta: de.datasVolta || '',
        fonte:       'alerta',
      });
      ok++;
    } catch(e) {
      console.warn('[BACKFILL] Falha oferta #' + oferta.id + ':', e.message);
      fail++;
    }
  }
  salvarFila();
  console.log('[BACKFILL] Concluído: ' + ok + ' ok, ' + fail + ' falhas');
  res.json({ ok: true, processados: enviados.length, registrados: ok, falhas: fail });
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

app.post('/painel/remover-imagem/:id', (req, res) => {
  const id     = parseInt(req.params.id);
  const oferta = filaPendentes.find(o => String(o.id)===String(id));
  if (!oferta) return res.status(404).json({ ok:false, erro:'Oferta nao encontrada.' });
  oferta.imagens = [];
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

// ── Reformatar: regera a mensagem a partir dos campos editados no painel ─────
// O gerador envia os campos estruturados; aqui eles sobrescrevem dadosExtraidos
// e a mensagem e remontada pelo MESMO formatador usado na captura, garantindo
// que mensagem enviada e registro em passagens.json nunca divirjam.
app.post('/painel/reformatar/:id', async (req, res) => {
  const id     = parseInt(req.params.id);
  const oferta = filaPendentes.find(o => String(o.id)===String(id));
  if (!oferta) return res.status(404).json({ ok:false, erro:'Oferta nao encontrada.' });
  if (oferta.tipoConteudo === 'cupom_tsp') return res.status(400).json({ ok:false, erro:'Cupom TSP nao usa formatacao de emissao.' });
  try {
    const de = aplicarDadosEditados(oferta, req.body && req.body.dados);
    if (!de.origem || !de.destino || !de.programa) {
      return res.status(400).json({ ok:false, erro:'Origem, destino e programa sao obrigatorios.' });
    }
    const hist180 = await registrarPassagemProxy({
      origem:      de.origem,
      destino:     de.destino,
      cia:         de.cia || '',
      programa:    de.programa,
      pontos:      Number(de.pontos) || 0,
      cabine:      de.cabine || 'Economica',
      datas_ida:   de.datasIda || '',
      datas_volta: de.datasVolta || '',
      fonte:       'alerta_pendente',
      apenasConsulta: true,
    });
    oferta.mensagemFormatada = appendHistoricoMensagem(formatarMensagemCDV(de), hist180);
    salvarFila();
    res.json({ ok:true, mensagemFormatada: oferta.mensagemFormatada, dadosExtraidos: de });
  } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
});

// Reaplica links de afiliado nos cupons TSP pendentes sob demanda (sem restart)
app.post('/painel/reformatar-tsp', (req, res) => {
  try {
    const n = reformatarCupomsTSPPendentes();
    res.json({ ok:true, atualizados:n });
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

  // Mesclagem inteligente de datas de volta:
  // Se o1 tem bloco de volta vazio ("-") e o2 tem datas de ida, injeta em vez de concatenar.
  const datasVoltaO2 = (o2.dadosExtraidos && o2.dadosExtraidos.datasIda) || '';
  const blocoVoltaVazio = /(🛬 \*DATAS DE VOLTA\*\n)-\n/;
  if (datasVoltaO2 && blocoVoltaVazio.test(o1.mensagemFormatada||'')) {
    o1.mensagemFormatada = (o1.mensagemFormatada||'').replace(blocoVoltaVazio, '$1' + datasVoltaO2 + '\n');
    if (o1.dadosExtraidos) o1.dadosExtraidos.datasVolta = datasVoltaO2;
  } else {
    o1.mensagemFormatada = (o1.mensagemFormatada||'').trim()+'\n\n'+(o2.mensagemFormatada||'').trim();
  }

  o1.tipoConteudo = 'mesclado';
  o1.timestamp    = new Date().toISOString();
  o2.status = 'mesclado';
  salvarFila();
  res.json({ ok:true, id:o1.id, mensagemMesclada:o1.mensagemFormatada });
});

app.post('/painel/limpar', (req, res) => {
  const { confirmar, tipoConteudo } = req.body;
  if (confirmar!=='sim') return res.status(400).json({ ok:false, erro:'Envie { "confirmar": "sim" } para confirmar.' });
  // tipoConteudo opcional: limpa apenas pendentes daquele tipo (ex.: 'cupom_tsp'
  // vindo do painel Tudo Sobre Promos), preservando as emissoes CDV da fila.
  // Sem tipoConteudo mantem o comportamento antigo: limpa todos os pendentes.
  let removidos = 0;
  filaPendentes.forEach(o => {
    if (o.status !== 'pendente') return;
    if (tipoConteudo && o.tipoConteudo !== tipoConteudo) return;
    o.status = 'rejeitado';
    removidos++;
  });
  salvarFila();
  res.json({ ok:true, removidos });
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
  // direto:true → pula a fila de envio (intervalo de 10 min / janela 8h-21h SP).
  // Usado por mensagens unicas e datadas, como o resumo diario das 20h.
  const { grupo, mensagem, agendarEm, direto } = req.body;

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
    agendamentos.push({ id, grupo, mensagem, dispararEm, status:'aguardando', direto: !!direto, criadoEm: new Date().toISOString() });
    salvarAgendamentos();
    const horario = new Intl.DateTimeFormat('pt-BR',{timeZone:TZ_SP,dateStyle:'short',timeStyle:'short'}).format(new Date(dispararEm));
    return res.json({ ok:true, agendado:true, id, horario });
  }

  const isEmissao = grupo==='cdv_emissao'||grupoId===GRUPOS['cdv_emissao'];
  if (isEmissao && !direto) {
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

// ── ENVIAR ANEXO (imagem OU documento) ────────────────────────────────────────
// Handler unico usado por /enviar-imagem (retrocompatibilidade) e /enviar-arquivo.
// Aceita DOIS formatos:
//  1) multipart/form-data com campo 'imagem' (gerador-cdv) ou qualquer campo (/enviar-arquivo)
//  2) application/json { grupo, legenda, base64, mimetype, nomeArquivo } — concierge
// O tipo da mensagem e decidido pelo mimetype: image/* vai como imagem com legenda;
// qualquer outro (PDF, DOCX, XLSX, CSV...) vai como documento com caption e fileName.
const EXT_POR_MIME = {
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'text/csv': '.csv',
  'text/plain': '.txt',
  'text/html': '.html',
  'application/zip': '.zip',
};

async function enviarAnexoHandler(req, res, padraoImagem) {
  const { grupo, legenda, base64, mimetype, nomeArquivo } = req.body;
  const file = req.file;
  const limpar = () => { try { if (file && existsSync(file.path)) unlinkSync(file.path); } catch(e) {} };

  if (!file && !base64) return res.status(400).json({ ok:false, erro:'Arquivo obrigatorio (campo: imagem/arquivo ou base64).' });

  if (!conectado || !sock) {
    const ok = await aguardarSock(15000);
    if (!ok) { limpar(); return res.status(503).json({ ok:false, erro:'WhatsApp nao conectado.' }); }
  }
  const grupoId = resolverGrupo(grupo);
  if (!grupoId) { limpar(); return res.status(400).json({ ok:false, erro:'Grupo invalido: '+grupo }); }

  try {
    const buffer = file
      ? readFileSync(file.path)
      : Buffer.from(String(base64).replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (!buffer || !buffer.length) throw new Error('Arquivo vazio ou base64 invalido.');

    const mt   = String(mimetype || (file && file.mimetype) || '');
    const nome = String(nomeArquivo || (file && file.originalname) || '');
    // Sem mimetype: /enviar-imagem assume imagem (clientes antigos), /enviar-arquivo assume documento.
    const ehImagem = mt ? mt.indexOf('image/') === 0 : !!padraoImagem;
    const ehAudio  = mt.indexOf('audio/') === 0;

    let conteudo, tipo;
    if (ehImagem) {
      tipo = 'imagem';
      conteudo = { image: buffer, caption: legenda || '' };
      if (mt) conteudo.mimetype = mt;
    } else if (ehAudio) {
      tipo = 'audio';
      conteudo = { audio: buffer, mimetype: mt, ptt: false };
    } else {
      tipo = 'documento';
      conteudo = {
        document: buffer,
        mimetype: mt || 'application/octet-stream',
        fileName: nome || ('arquivo' + (EXT_POR_MIME[mt] || '')),
      };
      if (legenda && String(legenda).trim()) conteudo.caption = legenda;
    }

    await enviarMensagem(grupoId, conteudo);
    console.log('[ANEXO] ' + tipo + ' enviado para ' + grupoId + ' (' + buffer.length + ' bytes' + (nome ? ', ' + nome : '') + ')');
    res.json({ ok:true, tipo });
  } catch(err) {
    console.error('[ANEXO] Erro ao enviar anexo:', err.message);
    res.status(500).json({ ok:false, erro:err.message });
  }
  finally { limpar(); }
}

// Rota historica — mantida identica para gerador-cdv e clientes antigos.
app.post('/enviar-imagem', upload.single('imagem'), (req, res) => enviarAnexoHandler(req, res, true));

// Rota nova — aceita PDF, DOCX, XLSX, imagens etc. (multipart em qualquer campo ou JSON base64).
app.post('/enviar-arquivo', upload.any(), (req, res) => {
  if (!req.file && req.files && req.files.length) req.file = req.files[0];
  return enviarAnexoHandler(req, res, false);
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

// ── RADAR DE MARKETPLACE (TSP) ───────────────────────────────────────────────
// Nao confundir com /radar/* e filaRadar acima, que sao do Radar de Ofertas CDV.

// Config do radar de marketplace — a aba Grupos do painel Gestao TSP grava aqui.
app.get('/mkt/config', (req, res) => {
  const cfg = radarConfig();
  res.json({
    ok: true,
    papeis: cfg.papeis || {},
    ativo: cfg.ativo !== false,
    descontoMinimo: cfg.descontoMinimo,
    dedupHoras: cfg.dedupHoras,
    partnerTag: cfg.partnerTag,
    gatilhoPadrao: cfg.gatilhoPadrao || '',
    fontes: radarFontes(),
    destinos: radarDestinos(),
    credenciaisOk: !!(process.env.AMZ_CLIENT_ID && process.env.AMZ_CLIENT_SECRET),
    credenciaisShopeeOk: credenciaisShopeeOk(),
  });
});

app.post('/mkt/config', (req, res) => {
  try {
    const permitido = {};
    for (const k of ['papeis','ativo','descontoMinimo','dedupHoras','partnerTag','gatilhoPadrao']) {
      if (req.body[k] !== undefined) permitido[k] = req.body[k];
    }
    const cfg = salvarRadarConfig(permitido);
    console.log('[MKT] Config atualizada — ' + radarFontes().length + ' fonte(s), ' + radarDestinos().length + ' destino(s).');
    res.json({ ok:true, papeis: cfg.papeis, fontes: radarFontes(), destinos: radarDestinos() });
  } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
});

// ── SINCRONIZACAO ────────────────────────────────────────────────────────────
app.get('/sync', async (req, res) => {
  const base = estadoSync();
  res.json({ ok:true, ...base, acesso: base.ativo ? await testarAcesso() : null });
});

app.post('/sync/push', async (req, res) => {
  if (!sincronizacaoAtiva()) return res.status(400).json({ ok:false, erro:'GITHUB_TOKEN nao configurado.' });
  try { res.json({ ok:true, enviados: await pushImediato() }); }
  catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
});

app.post('/sync/pull', async (req, res) => {
  if (!sincronizacaoAtiva()) return res.status(400).json({ ok:false, erro:'GITHUB_TOKEN nao configurado.' });
  try {
    const r = await baixarDoGitHub();
    carregarRadarConfig(); carregarCuponsBase(); carregarTemplates(); carregarVitrine();
    res.json({ ok:true, ...r });
  } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
});

// ── MONITORAMENTO POR GRUPO ──────────────────────────────────────────────────
app.get('/monitor', (req, res) => {
  const monitor = listarMonitor();
  const fontes = radarFontes();
  res.json({
    ok: true,
    lojas: LOJAS_MONITORAVEIS,
    monitor,
    // Fonte sem cadastro nao captura nada: o painel precisa destacar isso.
    fontesSemCadastro: fontes.filter(j => !monitor[j]),
    agoraSP: new Intl.DateTimeFormat('pt-BR', { timeZone: TZ_SP, dateStyle: 'short', timeStyle: 'short' }).format(new Date()),
  });
});

app.post('/monitor/:jid', (req, res) => {
  try {
    const cfg = salvarMonitor(req.params.jid, req.body || {});
    if (!cfg) return res.status(400).json({ ok:false, erro:'jid invalido' });
    console.log('[MONITOR] ' + req.params.jid.split('@')[0] + ' — ' + (cfg.lojas.join('+') || 'nenhuma loja')
      + ' ' + cfg.inicio + '-' + cfg.fim + ' (' + cfg.dias + ')' + (cfg.ativo ? '' : ' [inativo]'));
    res.json({ ok:true, cfg, estadoAgora: podeCapturar(req.params.jid, cfg.lojas[0] || 'Amazon') });
  } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
});

app.delete('/monitor/:jid', (req, res) => {
  if (!removerMonitor(req.params.jid)) return res.status(404).json({ ok:false, erro:'sem cadastro para este grupo' });
  res.json({ ok:true });
});

// ── VITRINE ──────────────────────────────────────────────────────────────────
app.get('/vitrine', (req, res) => {
  const itens = listarVitrine();
  res.json({ ok:true, total: itens.length, itens });
});

// Recebe o texto colado (um link por linha) e cadastra o que conseguir resolver.
// So resolve o ASIN e o nome — preco fica para o disparo.
app.post('/vitrine', async (req, res) => {
  const linhas = String(req.body?.texto || '').split('\n').map(l => l.trim()).filter(Boolean);
  if (!linhas.length) return res.status(400).json({ ok:false, erro:'nenhuma linha enviada' });
  if (linhas.length > 60) return res.status(400).json({ ok:false, erro:'máximo de 60 linhas por vez' });

  const cupom = req.body?.cupom || null;
  const salvos = [], erros = [];

  for (const linha of linhas) {
    try {
      // Shopee tem seu proprio formato de link e de identificador.
      if (ehLinkShopee(linha)) {
        if (!credenciaisShopeeOk()) { erros.push({ linha, erro: 'Shopee não configurada no Railway' }); continue; }
        const nomeManual = (linha.match(/^(.*?)\s*[|;]\s*https?:\/\//) || [])[1];
        const ids = await extrairIdsShopee(linha);
        if (!ids.length) { erros.push({ linha, erro: 'não foi possível identificar o produto Shopee' }); continue; }
        const node = await buscarProdutoShopee(ids[0]);
        const chave = 'SHOPEE-' + ids[0].shopId + '-' + ids[0].itemId;
        const jaTinha = !!itemVitrine(chave);
        salvos.push({ ...salvarItemVitrine({
          asin: chave, loja: 'Shopee',
          shopId: String(ids[0].shopId), itemId: String(ids[0].itemId),
          nome: (nomeManual || '').trim() || node?.productName || ('Produto ' + ids[0].itemId),
          url: node?.offerLink || node?.productLink || linha.trim(),
          cupom,
        }), jaExistia: jaTinha });
        continue;
      }
      const r = await resolverLinhaVitrine(linha);
      if (!r || r.erro) { erros.push({ linha, erro: r?.erro || 'falhou' }); continue; }
      const jaTinha = !!itemVitrine(r.asin);
      salvos.push({ ...salvarItemVitrine({ ...r, cupom }), jaExistia: jaTinha });
    } catch (e) { erros.push({ linha, erro: e.message }); }
  }
  console.log('[VITRINE] Cadastro — ' + salvos.length + ' ok, ' + erros.length + ' erro(s).');
  res.json({ ok: salvos.length > 0, salvos, erros });
});

// Dispara direto para os grupos destino: o operador ja revisou ao cadastrar.
// O preco e SEMPRE consultado agora — item salvo tem preco velho, e anunciar
// preco que nao existe mais e o erro que este pipeline existe para evitar.
app.post('/vitrine/disparar', async (req, res) => {
  const asins = Array.isArray(req.body?.asins) ? req.body.asins.filter(Boolean) : [];
  if (!asins.length) return res.status(400).json({ ok:false, erro:'selecione ao menos um produto' });
  if (!conectado || !sock) {
    const ok = await aguardarSock();
    if (!ok) return res.status(503).json({ ok:false, erro:'WhatsApp não conectado.' });
  }

  // Cada loja tem sua API: separa antes de consultar e junta os resultados.
  const itens = asins.map(a => itemVitrine(a)).filter(Boolean);
  const daShopee = itens.filter(i => i.loja === 'Shopee');
  const daAmazon = asins.filter(a => !daShopee.some(s => s.asin === a));

  let montado = { prontos: [], descartados: [] };
  if (daAmazon.length) {
    try {
      const m = await montarOfertasVitrine(daAmazon, req.body?.cupom || null);
      montado.prontos.push(...m.prontos); montado.descartados.push(...m.descartados);
    } catch (e) { return res.status(500).json({ ok:false, erro:'falha na API da Amazon: ' + e.message }); }
  }
  if (daShopee.length) {
    if (!credenciaisShopeeOk()) {
      daShopee.forEach(i => montado.descartados.push({ asin:i.asin, nome:i.nome, motivo:'Shopee não configurada' }));
    } else {
      try {
        const m = await montarOfertasShopeeVitrine(daShopee, req.body?.cupom || null);
        montado.prontos.push(...m.prontos); montado.descartados.push(...m.descartados);
      } catch (e) {
        daShopee.forEach(i => montado.descartados.push({ asin:i.asin, nome:i.nome, motivo:'Shopee: ' + e.message }));
      }
    }
  }

  const enviados = [], falhas = [];
  for (const o of montado.prontos) {
    const oferta = {
      id: gerarId(), origem:'vitrine',
      tipoConteudo: o.produto.loja === 'Shopee' ? 'oferta_shopee' : 'oferta_amazon',
      mensagemFormatada: o.mensagem,
      dadosExtraidos: {
        loja:o.produto.loja || 'Amazon', asin:o.asin, titulo:o.produto.titulo, preco:o.produto.preco,
        precoDe:o.produto.precoDe, desconto:o.produto.desconto, link:o.produto.link,
        cupom:o.cupom, precoFinal:o.precoFinal,
      },
      imagens: [],
    };
    // A imagem alimenta o thumbnail do link preview; falha nela nao impede o envio.
    try {
      const img = await baixarImagemProduto(o.produto.imagemUrl);
      if (img) oferta.imagens = [img];
    } catch (e) {}

    try {
      const r = await enviarOfertaParaDestinos(o.mensagem, null, oferta);
      marcarDisparo(o.asin);
      enviados.push({ asin:o.asin, nome:o.nome, grupos:r.enviados.length,
                      cupom:o.cupom?.codigo || null, aviso:o.avisoCupom || null });
    } catch (e) {
      falhas.push({ asin:o.asin, nome:o.nome, erro:e.message });
    }
    // Mesmo espacamento do radar: rajada em varios grupos e o padrao que o
    // WhatsApp usa para identificar automacao.
    if (montado.prontos.length > 1) await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000));
  }

  console.log('[VITRINE] Disparo — ' + enviados.length + ' enviada(s), '
    + falhas.length + ' falha(s), ' + montado.descartados.length + ' descartada(s).');
  res.json({ ok:true, enviados, falhas, descartados: montado.descartados });
});

app.post('/vitrine/:asin', (req, res) => {
  if (!itemVitrine(req.params.asin)) return res.status(404).json({ ok:false, erro:'produto não está na vitrine' });
  res.json({ ok:true, item: salvarItemVitrine({ asin: req.params.asin, ...req.body }) });
});

app.delete('/vitrine/:asin', (req, res) => {
  if (!removerItemVitrine(req.params.asin)) return res.status(404).json({ ok:false, erro:'não encontrado' });
  res.json({ ok:true });
});

// ── TEMPLATES DE MENSAGEM POR LOJA ───────────────────────────────────────────
app.get('/templates', (req, res) => {
  res.json({ ok:true, templates: listarTemplates(), variaveis: VARIAVEIS_TEMPLATE });
});

// Renderiza um corpo de template com dados de exemplo. Serve ao preview ao vivo
// do editor: o operador ve o resultado sem precisar esperar uma oferta real.
app.post('/templates/preview', (req, res) => {
  try {
    const exemplo = {
      asin:'B0H6N6K239', loja: req.body.loja || 'Amazon', marca:'Samsung',
      titulo:'Samsung Smart TV 58" Crystal UHD 4K U8000H 2026, Vision AI Companion, Modo Jogo',
      preco:3032.10, precoDe:3639.00, desconto:17, disponivel:true,
      nota:4.6, avaliacoes:812, vendedor:'Amazon.com.br', dealTermina:null,
      link:'https://www.amazon.com.br/dp/B0H6N6K239?tag=tdsobrepromos-20',
    };
    const cupom = req.body.comCupom === false ? null
      : { reg:{ codigo:'CURTEAPROMO' }, desconto:100, citado:true };
    const corpo = req.body.corpo !== undefined
      ? req.body.corpo
      : (templateDaLoja(req.body.loja)?.corpo || '');
    res.json({ ok:true, mensagem: renderTemplate(corpo, varsDoProduto(exemplo, cupom)) });
  } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
});

app.post('/templates/:loja', (req, res) => {
  try {
    const tpl = salvarTemplate(req.params.loja, req.body || {});
    console.log('[TPL] Template salvo — ' + req.params.loja);
    res.json({ ok:true, template: tpl });
  } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
});

app.delete('/templates/:loja', (req, res) => {
  if (!removerTemplate(req.params.loja)) {
    return res.status(400).json({ ok:false, erro:'Template nao encontrado, ou e o padrao (que nao pode ser removido).' });
  }
  res.json({ ok:true });
});

// ── BASE DE CUPONS ───────────────────────────────────────────────────────────
// Alimentada automaticamente pelo pipeline de cupons. Estes endpoints existem
// para o operador corrigir um valor mal extraido ou desligar um cupom que a
// loja derrubou antes da validade.
app.get('/cupons/base', (req, res) => {
  const itens = listarCuponsBase();
  const agora = Date.now();
  res.json({
    ok: true,
    total: itens.length,
    vigentes: itens.filter(c => c.ativo !== false && new Date(c.validadeAte).getTime() > agora).length,
    itens,
  });
});

// Criacao manual (um objeto ou um array). Usa o mesmo caminho de gravacao da
// captura automatica, entao um cupom semeado a mao e indistinguivel de um
// capturado do grupo — inclusive na validade de 2 dias.
app.post('/cupons/base', (req, res) => {
  const body = req.body;
  const lista = Array.isArray(body) ? body : [body];
  const criados = [], erros = [];

  for (const c of lista) {
    if (!c?.loja || !c?.codigo) { erros.push({ item: c, erro: 'loja e codigo sao obrigatorios' }); continue; }
    if (c.valor === undefined || c.valor === null || !isFinite(Number(c.valor)) || Number(c.valor) <= 0) {
      erros.push({ item: c, erro: 'valor deve ser numero maior que zero' }); continue;
    }
    try {
      const reg = registrarCupomBase(c);
      // Validade explicita sobrescreve o padrao de 2 dias.
      const final = c.validadeAte ? atualizarCupomBase(reg.chave, { validadeAte: c.validadeAte }) : reg;
      criados.push(final);
    } catch (e) { erros.push({ item: c, erro: e.message }); }
  }
  console.log('[CUPONS] Criacao manual — ' + criados.length + ' ok, ' + erros.length + ' erro(s).');
  res.status(erros.length && !criados.length ? 400 : 200).json({ ok: !!criados.length, criados, erros });
});

// Liga/desliga todos os cupons de uma loja de uma vez. Existe como endpoint (em
// vez de N chamadas do painel) para a operacao ser atomica no arquivo.
app.post('/cupons/loja/:loja', (req, res) => {
  if (typeof req.body?.ativo !== 'boolean') {
    return res.status(400).json({ ok:false, erro:'informe { ativo: true|false }' });
  }
  const n = definirAtivoPorLoja(req.params.loja, req.body.ativo);
  console.log('[CUPONS] ' + req.params.loja + ' — ' + n + ' cupom(ns) ' + (req.body.ativo ? 'ativado(s)' : 'desativado(s)') + '.');
  res.json({ ok:true, alterados:n });
});

app.post('/cupons/base/:chave', (req, res) => {
  const reg = atualizarCupomBase(req.params.chave, req.body || {});
  if (!reg) return res.status(404).json({ ok:false, erro:'Cupom nao encontrado: ' + req.params.chave });
  console.log('[CUPONS] Editado via painel — ' + reg.chave);
  res.json({ ok:true, cupom: reg });
});

app.delete('/cupons/base/:chave', (req, res) => {
  if (!removerCupomBase(req.params.chave)) return res.status(404).json({ ok:false, erro:'Cupom nao encontrado.' });
  res.json({ ok:true });
});

// Cola um link e ve a mensagem que sairia, sem enfileirar nem publicar nada.
app.post('/mkt/testar', async (req, res) => {
  try {
    const r = await processarTextoAmazon(req.body.texto || '', { ignorarDedup: true });
    res.json({ ok:true, resultados: r });
  } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
});

// Cola um link Shopee e ve a mensagem que sairia, sem enfileirar nem publicar.
app.post('/shopee/testar', async (req, res) => {
  if (!credenciaisShopeeOk()) {
    return res.status(400).json({ ok:false, erro:'SHOPEE_APP_ID / SHOPEE_SECRET nao configurados no Railway.' });
  }
  try {
    const r = await processarTextoShopee(req.body?.texto || '');
    res.json({ ok:true, resultados: r });
  } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
});

// Prova que o link gerado rende comissao para esta conta: confere procedencia,
// parametros de tracking e o sub id injetado.
app.get('/shopee/validar', async (req, res) => {
  if (!credenciaisShopeeOk()) {
    return res.status(400).json({ ok:false, erro:'SHOPEE_APP_ID / SHOPEE_SECRET nao configurados.' });
  }
  if (!req.query.url) return res.status(400).json({ ok:false, erro:'passe ?url= com o link do produto' });
  try {
    const subId = req.query.subId || ('cdvteste' + Date.now().toString().slice(-6));
    res.json(await validarAtribuicao(req.query.url, subId));
  } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
});

// Diagnostico da credencial: uma consulta minima que prova assinatura e acesso.
app.get('/shopee/status', async (req, res) => {
  if (!credenciaisShopeeOk()) {
    return res.json({ ok:false, configurado:false, erro:'SHOPEE_APP_ID / SHOPEE_SECRET ausentes.' });
  }
  try {
    const ids = await extrairIdsShopee(req.query.url || '');
    if (!ids.length) return res.json({ ok:true, configurado:true, aviso:'passe ?url= com um link Shopee para testar a consulta.' });
    const node = await buscarProdutoShopee(ids[0]);
    res.json({ ok:true, configurado:true, produto: node ? normalizarShopee(node) : null });
  } catch(e) { res.json({ ok:false, configurado:true, erro:e.message }); }
});

app.get('/grupos', async (req, res) => {
  // groupFetchAllParticipating leva ~6s com 400 grupos e trava a aba a cada
  // abertura. O cache e preenchido na conexao e a lista muda raramente, entao
  // responde na hora e so busca de verdade com ?refresh=1 ou cache vazio.
  if (NOMES_GRUPOS.size && req.query.refresh !== '1') {
    const grupos = [...NOMES_GRUPOS.entries()]
      .map(([id, nome]) => ({ id, nome }))
      .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
    return res.json({ ok:true, total:grupos.length, grupos, doCache:true });
  }
  if (!sock || !conectado) {
    const ok = await aguardarSock(15000);
    if (!ok) return res.status(503).json({ ok:false, erro:'WhatsApp nao conectado.' });
  }
  try {
    const chats  = await sock.groupFetchAllParticipating();
    NOMES_GRUPOS.clear();
    for (const g of Object.values(chats)) NOMES_GRUPOS.set(g.id, g.subject || '(sem nome)');
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


app.post('/reset-sender-keys', async (req, res) => {
  console.log('[RESET] Cura cirúrgica de sender keys solicitada via endpoint.');
  await limparSenderKeys();
  res.json({ ok:true, mensagem:'Sender keys apagadas. Conexão mantida — os grupos voltam a decifrar conforme os remetentes redistribuírem as chaves (automático via retry receipt).' });
});

app.post('/reset-sessao', async (req, res) => {
  console.log('[RESET] Reset de sessão solicitado via endpoint.');
  res.json({ ok:true, mensagem:'Limpando sessão e reconectando...' });
  await limparSessaoEReconectar();
});

app.post('/reset-sessao-completo', async (req, res) => {
  console.log('[RESET] Reset COMPLETO de sessão solicitado via endpoint.');
  if (isResetting) {
    console.log('[RESET] Reset já em andamento, ignorando chamada duplicada.');
    return res.json({ ok:false, mensagem:'Reset já em andamento.' });
  }
  res.json({ ok:true, mensagem:'Apagando toda a sessão e reconectando...' });
  isResetting = true;
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  conectado = false;
  const sockRef = sock;
  sock = null;
  if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
  if (sockRef) { try { sockRef.end(new Error('reset-completo')); } catch(e) {} }
  try {
    const arquivos = await readdir(SESSAO_DIR);
    for (const arq of arquivos) {
      // Preserva tudo que NAO e credencial do WhatsApp. A pasta ./sessao guarda
      // dados de negocio junto com as chaves; apagar sem filtro custaria a base
      // de cupons e os papeis fonte/destino do radar, que sao trabalho manual.
      if (PRESERVAR_NO_RESET.has(arq)) continue;
      await unlink(SESSAO_DIR + '/' + arq).catch(() => {});
    }
    console.log('[RESET] Sessão apagada completamente. Aguardando novo QR...');
  } catch(e) { console.error('[RESET] Erro ao apagar sessão:', e.message); }
  errosDescripto = 0;
  _reconectarTentativas = 0;
  isResetting = false;

  _agendarReconexao(2000);
});
// ═══════════════════════════════════════════════════════════════════════════
// HISTÓRICO SEATS.AERO — BLOCO ÚNICO
//
// COMO APLICAR: cole TUDO abaixo no server.js, imediatamente ANTES da linha:
//
//     app.listen(PORT, () => {
//
// Não é preciso editar mais nada no arquivo. Este bloco só acrescenta.
// ═══════════════════════════════════════════════════════════════════════════


// ── HISTÓRICO SEATS.AERO (coleta diária) ─────────────────────────────────────
// Alimentado pelas tarefas programadas seats-aero-coleta-A/B/C (seg a sex).
// Diferente da fila de alertas: aqui NADA é enviado nem aprovado. É apenas
// série histórica de disponibilidade — inclusive dos dias em que não havia
// nada dentro do limite (registro com menorK null). Guardar a ausência é o
// que permite depois medir com que frequência uma rota abre assento; sem ela
// não dá para distinguir "não havia disponibilidade" de "a coleta não rodou".
const HIST_SEATS_PATH = SESSAO_DIR + '/historico_seats.json';
const HIST_SEATS_DIAS = 400; // retenção: descarta coletas mais antigas que isso

let historicoSeats = [];

function carregarHistoricoSeats() {
  try {
    if (existsSync(HIST_SEATS_PATH)) {
      historicoSeats = JSON.parse(readFileSync(HIST_SEATS_PATH, 'utf-8'));
      console.log('[HIST-SEATS] Carregados ' + historicoSeats.length + ' registros.');
    }
  } catch (e) {
    console.warn('[HIST-SEATS] Erro ao carregar:', e.message);
    historicoSeats = [];
  }
}

function salvarHistoricoSeats() {
  try {
    const limite = Date.now() - HIST_SEATS_DIAS * 24 * 60 * 60 * 1000;
    const antes = historicoSeats.length;
    historicoSeats = historicoSeats.filter(r => {
      const t = new Date(r.coletadoEm).getTime();
      return (!t || isNaN(t)) ? true : t >= limite;
    });
    if (antes !== historicoSeats.length) {
      console.log('[HIST-SEATS] Retenção: ' + (antes - historicoSeats.length) + ' registro(s) antigo(s) removido(s).');
    }
    writeFileSync(HIST_SEATS_PATH, JSON.stringify(historicoSeats), 'utf-8');
  } catch (e) {
    console.warn('[HIST-SEATS] Erro ao salvar:', e.message);
  }
}

carregarHistoricoSeats();

// Chave de deduplicação: uma linha por dia/rota/cabine/direção.
// Rodar o mesmo grupo duas vezes no mesmo dia SUBSTITUI em vez de duplicar.
function chaveHistSeats(r) {
  return [
    r.dia,
    (r.programa || '').toLowerCase(),
    (r.origem   || '').toUpperCase(),
    (r.destino  || '').toUpperCase(),
    (r.cabine   || '').toLowerCase(),
    (r.direcao  || '').toLowerCase(),
  ].join('|');
}

// ── PONTE COLETA → HISTÓRICO DE PASSAGENS (proxy CDV) ────────────────────────
// A coleta diária alimenta o mesmo /passagens/registrar que já produz o
// hist180 exibido nas mensagens ("MÍN. 180 DIAS" / "MÉDIA 180 DIAS").
// Antes desta ponte a base só continha emissões efetivamente divulgadas —
// amostra pequena e enviesada, porque só entrava o que já era bom o bastante
// para virar alerta. A coleta acrescenta ~300 pontos por semana das mesmas
// rotas, incluindo os patamares ruins, que é o que dá sentido ao "mínimo".
//
// Quatro normalizações são obrigatórias aqui, porque o proxy guarda os dados
// no formato das mensagens de alerta, não no formato do seats.aero:
//   1. origem/destino → NOME DE CIDADE, não IATA (o alerta grava "São Paulo",
//      não "GRU"). Sem converter, GRU e São Paulo viram buckets distintos.
//   2. pontos → número absoluto. menorK vem em milhares (92.5 = 92500).
//   3. cabine → "Economica" ou "Executiva" apenas. A coleta usa "Econômica",
//      "Business" e "Executiva"; sem mapear, "Business" vira um terceiro bucket.
//   4. valor → COM desconto Smiles. O hist180 atual é alimentado pelo texto da
//      mensagem, que já sai descontado. Enviar o valor cru criaria um degrau
//      artificial de ~10% na série das rotas Smiles.

// IATAs usados pela coleta que não estão em IATA_CIDADES. Fica aqui em vez de
// editar a tabela original para manter este bloco 100% aditivo.
const IATA_EXTRA_COLETA = { 'IAD': 'Washington', 'DCA': 'Washington', 'BWI': 'Baltimore' };

const cidadeColeta = (iata) =>
  IATA_EXTRA_COLETA[String(iata || '').toUpperCase()] || resolverCidade(iata, iata);

const CABINE_PROXY = (c) =>
  /exec|business|first|primeira/i.test(String(c || '')) ? 'Executiva' : 'Economica';

async function enviarColetaParaProxy(linhas) {
  let ok = 0, pulados = 0, falhas = 0;

  for (const r of linhas) {
    // Sem disponibilidade não é registro de preço — o dia vazio já está
    // guardado no historicoSeats local, que é onde ele tem significado.
    if (r.erro || r.menorK === null) { pulados++; continue; }

    const k = (r.menorKComDesconto !== null && r.menorKComDesconto !== undefined)
      ? r.menorKComDesconto
      : r.menorK;
    const pontos = Math.round(Number(k) * 1000);
    if (!pontos || pontos <= 0) { pulados++; continue; }

    const resultado = await registrarPassagemProxy({
      origem:      cidadeColeta(r.origem),
      destino:     cidadeColeta(r.destino),
      cia:         normalizarCia(r.cia),
      programa:    r.programa,
      pontos:      pontos,
      cabine:      CABINE_PROXY(r.cabine),
      datas_ida:   (r.datas || []).join(' '),
      datas_volta: '',
      fonte:       'coleta',
    });

    if (resultado === null) falhas++; else ok++;

    // Espaçamento leve: são até 20 chamadas por grupo, 3 grupos por dia.
    await new Promise(res => setTimeout(res, 300));
  }

  console.log('[HIST-SEATS→PROXY] ' + ok + ' registrada(s), '
    + pulados + ' pulada(s) (sem disponibilidade), ' + falhas + ' falha(s).');
}

// POST /historico-seats — grava uma coleta (um POST por grupo A/B/C)
// Body: { coletadoEm, grupo, registros: [ { cia, programa, programaColuna,
//         cabine, origem, destino, direcao, limiteK, menorK,
//         menorKComDesconto, totalDatas, datas, erro } ] }
app.post('/historico-seats', (req, res) => {
  const { coletadoEm, grupo, registros } = req.body || {};

  if (!Array.isArray(registros) || registros.length === 0) {
    return res.status(400).json({ ok: false, erro: 'registros obrigatório (array não vazio).' });
  }

  const tsValido = coletadoEm && !isNaN(new Date(coletadoEm).getTime());
  const ts = tsValido ? new Date(coletadoEm).toISOString() : new Date().toISOString();
  // Dia no fuso de São Paulo (en-CA devolve YYYY-MM-DD).
  const dia = new Intl.DateTimeFormat('en-CA', { timeZone: TZ_SP }).format(new Date(ts));

  const indice = new Map();
  historicoSeats.forEach((r, i) => indice.set(chaveHistSeats(r), i));

  const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return isNaN(n) ? null : n;
  };

  let novos = 0, atualizados = 0, invalidos = 0;
  const gravadas = [];

  for (const reg of registros) {
    if (!reg || !reg.origem || !reg.destino || !reg.programa || !reg.direcao) { invalidos++; continue; }

    const linha = {
      dia,
      coletadoEm: ts,
      grupo:      grupo || null,
      cia:        reg.cia || '',
      programa:   reg.programa,
      programaColuna: reg.programaColuna || '',
      cabine:     reg.cabine || 'Economica',
      origem:     String(reg.origem).toUpperCase().trim(),
      destino:    String(reg.destino).toUpperCase().trim(),
      direcao:    String(reg.direcao).toLowerCase().trim(),
      limiteK:    num(reg.limiteK),
      menorK:     num(reg.menorK),                   // valor cru do seats.aero
      menorKComDesconto: num(reg.menorKComDesconto), // Smiles já com -9%
      totalDatas: num(reg.totalDatas) || 0,
      datas:      Array.isArray(reg.datas) ? reg.datas : [],
      erro:       reg.erro === true,
    };

    const chave = chaveHistSeats(linha);
    if (indice.has(chave)) {
      historicoSeats[indice.get(chave)] = linha;
      atualizados++;
    } else {
      indice.set(chave, historicoSeats.length);
      historicoSeats.push(linha);
      novos++;
    }
    gravadas.push(linha);
  }

  salvarHistoricoSeats();
  console.log('[HIST-SEATS] Grupo ' + (grupo || '?') + ' (' + dia + ') — '
    + novos + ' novo(s), ' + atualizados + ' atualizado(s), '
    + invalidos + ' inválido(s). Total: ' + historicoSeats.length);

  res.json({ ok: true, dia, novos, atualizados, invalidos, total: historicoSeats.length });

  // Fan-out para o proxy DEPOIS de responder: a tarefa programada não fica
  // presa esperando até 20 chamadas HTTP, e uma falha do proxy nunca faz a
  // coleta local (que já está salva em disco) parecer ter falhado.
  enviarColetaParaProxy(gravadas)
    .catch(e => console.warn('[HIST-SEATS→PROXY] Erro no fan-out:', e.message));
});

// GET /historico-seats — consulta com filtros e estatísticas
// Ex: /historico-seats?origem=GRU&destino=CDG&cabine=Business&dias=180
app.get('/historico-seats', (req, res) => {
  const { origem, destino, programa, cabine, direcao, detalhe } = req.query;
  const janela = Number(req.query.dias) || 180;
  const limite = Date.now() - janela * 24 * 60 * 60 * 1000;

  const eq = (a, b) => String(a || '').toLowerCase().trim() === String(b || '').toLowerCase().trim();

  const filtrados = historicoSeats.filter(r => {
    const t = new Date(r.coletadoEm).getTime();
    if (t && !isNaN(t) && t < limite) return false;
    if (origem   && !eq(r.origem, origem))     return false;
    if (destino  && !eq(r.destino, destino))   return false;
    if (programa && !eq(r.programa, programa)) return false;
    if (cabine   && !eq(r.cabine, cabine))     return false;
    if (direcao  && !eq(r.direcao, direcao))   return false;
    return true;
  });

  const valores = filtrados.filter(r => r.menorK !== null && !r.erro).map(r => r.menorK);
  const diasColetados = new Set(filtrados.map(r => r.dia)).size;
  const diasComDisp   = new Set(filtrados.filter(r => r.menorK !== null).map(r => r.dia)).size;

  const stats = valores.length ? {
    minK:   Math.min(...valores),
    maxK:   Math.max(...valores),
    mediaK: Math.round((valores.reduce((s, v) => s + v, 0) / valores.length) * 10) / 10,
    amostras: valores.length,
  } : { minK: null, maxK: null, mediaK: null, amostras: 0 };

  res.json({
    ok: true,
    janelaDias: janela,
    diasColetados,
    diasComDisponibilidade: diasComDisp,
    // % dos dias coletados em que apareceu alguma disponibilidade no limite
    taxaDisponibilidade: diasColetados ? Math.round((diasComDisp / diasColetados) * 100) : 0,
    ...stats,
    registros: filtrados.length,
    detalhe: detalhe ? filtrados : undefined,
  });
});

// GET /historico-seats/rotas — combinações já coletadas e a última coleta de cada
app.get('/historico-seats/rotas', (req, res) => {
  const mapa = new Map();
  for (const r of historicoSeats) {
    const chave = [r.programa, r.cia, r.cabine, r.origem, r.destino, r.direcao].join(' | ');
    const atual = mapa.get(chave);
    if (!atual || r.dia > atual.ultimaColeta) {
      mapa.set(chave, {
        programa: r.programa, cia: r.cia, cabine: r.cabine,
        origem: r.origem, destino: r.destino, direcao: r.direcao,
        limiteK: r.limiteK, ultimaColeta: r.dia, ultimoMenorK: r.menorK,
      });
    }
  }
  const rotas = [...mapa.values()].sort((a, b) => a.origem.localeCompare(b.origem));
  res.json({ ok: true, total: rotas.length, totalRegistros: historicoSeats.length, rotas });
});

app.listen(PORT, () => {
  console.log('Servidor na porta '+PORT);
});

// Conecta ao WhatsApp imediatamente no startup.
// Garante que mensagens dos grupos monitorados não sejam perdidas após deploy.
console.log("[SERVER] Iniciando conexão com WhatsApp...");
conectar();
