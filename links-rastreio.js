// ═══════════════════════════════════════════════════════════════════════════
// links-rastreio.js — links rastreados das mensagens do Tica Promos.
//
// Todo link de loja que sai num grupo do TSP (oferta, cupom, envio manual,
// agendamento) e trocado por um link do nosso dominio:
//
//   https://ir.ticapromos.com.br/amazon/0kQm2-15
//                                 │      │     └─ grupo (#15; nicho vira sigla)
//                                 │      └─ codigo do envio (2 dia + 3 aleatorio)
//                                 └─ loja, so para quem le (o proxy ignora)
//
// O redirect e a contagem de cliques ficam no proxy (painel-cdv/index.js). Este
// modulo so GERA os codigos e guarda o mapa codigo -> destino, que e a fonte da
// verdade: disco local (lido pelo endpoint /links-rastreio/:codigo) + shard
// diario no repo de dados (tsp/links_rastreio_AAAA-MM-DD.json), que e o
// fallback do proxy quando este servidor esta fora.
//
// Os 2 primeiros caracteres do codigo sao o dia do envio (base62, dias desde
// 01/01/2026). E isso que deixa o proxy achar o shard certo sem indice.
//
// Regra de ouro: rastreio NUNCA derruba envio. Qualquer falha aqui devolve a
// mensagem original, com o link original.
//
// Desligar sem deploy: RASTREIO_LINKS=0 no Railway.
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'fs';
import { agendarPush, baixarArquivoDoGitHub } from './sync-github.js';

const SESSAO_DIR = './sessao';
const TZ_SP = 'America/Sao_Paulo';
const EPOCA_UTC = Date.UTC(2026, 0, 1);
const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export function rastreioAtivo() {
  return String(process.env.RASTREIO_LINKS ?? '1') !== '0';
}
function basePublica() {
  return String(process.env.RASTREIO_BASE || 'https://ir.ticapromos.com.br').replace(/\/+$/, '');
}

// ── Codigo ──────────────────────────────────────────────────────────────────
function diaSP(d = new Date()) {
  return d.toLocaleDateString('en-CA', { timeZone: TZ_SP });   // AAAA-MM-DD
}
function b62(n, largura) {
  let s = '';
  do { s = B62[n % 62] + s; n = Math.floor(n / 62); } while (n > 0);
  return s.padStart(largura, '0').slice(-largura);
}
function prefixoDoDia(dia) {
  const [a, m, d] = dia.split('-').map(Number);
  const idx = Math.round((Date.UTC(a, m - 1, d) - EPOCA_UTC) / 86400000);
  return b62(Math.max(0, idx), 2);
}
function aleatorio(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += B62[Math.floor(Math.random() * 62)];
  return s;
}

// ── Loja (so para leitura humana no link) ────────────────────────────────────
const LOJAS = [
  ['amazon',       /(^|\.)amazon\.[a-z.]+$|^amzn\.to$|^a\.co$|(^|\.)link\.amazon$/i],
  ['mercadolivre', /(^|\.)mercadoliv?re\.com(\.br)?$|(^|\.)mercadolibre\.com$|^meli\.la$/i],
  ['shopee',       /(^|\.)shopee\.com(\.br)?$|^shp\.ee$|^shope\.ee$/i],
  ['magalu',       /(^|\.)magazineluiza\.com\.br$|(^|\.)magalu\.com(\.br)?$|^maga\.lu$/i],
];
export function slugLoja(host) {
  const h = String(host || '').toLowerCase();
  for (const [slug, re] of LOJAS) if (re.test(h)) return slug;
  return 'loja';
}

// Links que nunca sao rastreados: convite de grupo, redes sociais e os nossos
// proprios dominios (inclui o distribuidor ir.ticapromos.com.br/<slug>, que ja
// conta clique por conta propria).
const HOST_NAO_RASTREAR = /(^|\.)(whatsapp\.com|wa\.me|t\.me|telegram\.me|instagram\.com|facebook\.com|fb\.com|youtube\.com|youtu\.be|tiktok\.com|twitter\.com|x\.com|linktr\.ee|github\.com|github\.io|githubusercontent\.com|railway\.app|ticapromos\.com\.br|tudosobrepromos\.com|clubedoviajante\.com\.br|davileles\.com)$/i;

// ── Grupo -> sufixo ──────────────────────────────────────────────────────────
const SIGLAS_NICHO = [
  [/bebida/, 'BE'],
  [/baby|kids|infantil|bebe/, 'KI'],
  [/ferrament/, 'FE'],
  [/cupo/, 'SC'],
];
const RESERVADAS = new Set(SIGLAS_NICHO.map(([, s]) => s));

export function sufixoDoGrupo(jid, nome) {
  const n = String(nome || '');
  const m = n.match(/#\s*0*(\d{1,3})\b/);
  if (m) return String(Number(m[1])).padStart(2, '0');
  const norm = n.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  for (const [re, sigla] of SIGLAS_NICHO) if (re.test(norm)) return sigla;
  // Grupo sem numero nem nicho conhecido: duas letras estaveis derivadas do jid.
  let h = 0;
  for (const c of String(jid || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (let i = 0; i < 676; i++) {
    const x = (h + i) % 676;
    const s = L[Math.floor(x / 26)] + L[x % 26];
    if (!RESERVADAS.has(s)) return s;
  }
  return 'XX';
}

// ── Shard diario ─────────────────────────────────────────────────────────────
const _dias = new Map();         // dia -> { dia, links:{}, origens:{} }
const _carregando = new Map();   // dia -> Promise

function nomeShard(dia) { return 'links_rastreio_' + dia + '.json'; }

async function shardDoDia(dia) {
  if (_dias.has(dia)) return _dias.get(dia);
  if (_carregando.has(dia)) return _carregando.get(dia);
  const p = (async () => {
    const local = SESSAO_DIR + '/' + nomeShard(dia);
    // Volume novo: restaura do repo antes da primeira gravacao, senao o
    // primeiro envio do dia sobrescreveria os codigos ja emitidos.
    if (!existsSync(local)) { try { await baixarArquivoDoGitHub(nomeShard(dia)); } catch { /* segue */ } }
    let doc = null;
    try { doc = JSON.parse(readFileSync(local, 'utf-8')); } catch { /* novo */ }
    if (!doc || typeof doc !== 'object' || !doc.links) doc = { dia, links: {}, origens: {} };
    doc.origens = doc.origens || {};
    _dias.set(dia, doc);
    // Mantem so os ultimos dias em memoria
    const chaves = [..._dias.keys()].sort();
    while (chaves.length > 3) _dias.delete(chaves.shift());
    return doc;
  })();
  _carregando.set(dia, p);
  try { return await p; } finally { _carregando.delete(dia); }
}

function salvarShard(doc) {
  const nome = nomeShard(doc.dia);
  const destino = SESSAO_DIR + '/' + nome;
  if (!existsSync(SESSAO_DIR)) mkdirSync(SESSAO_DIR, { recursive: true });
  writeFileSync(destino + '.tmp', JSON.stringify(doc), 'utf-8');
  renameSync(destino + '.tmp', destino);
  agendarPush(nome);
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

function metaDoContexto(ctx) {
  const o = ctx.oferta || null;
  const d = o?.dadosExtraidos || ctx.dados || {};
  const cupom = d.cupom?.codigo || (typeof d.cupom === 'string' ? d.cupom : null) || d.codigo || null;
  return {
    tipo: ctx.tipo || 'oferta',
    ofertaId: o?.id != null ? String(o.id) : null,
    loja: d.loja || null,
    produto: d.asin || d.mlb || d.itemId || d.produtoId || null,
    titulo: d.titulo ? String(d.titulo).slice(0, 160) : null,
    preco: num(d.precoFinal ?? d.preco),
    precoDe: num(d.precoDe),
    desconto: num(d.desconto),
    categoria: d.categoria || ctx.categoria || null,
    cupom: cupom ? String(cupom).slice(0, 40) : null,
    cupomValor: num(d.valor),
    cupomTipo: d.tipo === 'pct' || d.tipo === 'valor' ? d.tipo : null,
  };
}

const RE_URL = /https?:\/\/[^\s`"'<>]+/g;

/**
 * Troca os links de loja de UMA mensagem ja preparada para UM grupo (depois do
 * comTagDoGrupo, para o destino guardar a tag de afiliado daquele grupo).
 *
 * @param {string} texto
 * @param {object|null} preview   linkPreview do Baileys (ou null)
 * @param {object} ctx { jid, nomeGrupo, execId, tipo, oferta?, dados?, categoria? }
 * @returns {Promise<{texto:string, preview:object|null, links:string[]}>}
 */
export async function rastrearParaGrupo(texto, preview, ctx = {}) {
  const original = { texto, preview, links: [] };
  try {
    if (!rastreioAtivo() || !texto || !ctx.jid || !ctx.execId) return original;
    const urls = String(texto).match(RE_URL);
    if (!urls) return original;

    const agora = new Date();
    const dia = diaSP(agora);
    const doc = await shardDoDia(dia);
    const sufixo = sufixoDoGrupo(ctx.jid, ctx.nomeGrupo);
    const meta = metaDoContexto(ctx);
    const trocas = new Map();
    let mudou = false, n = 0;

    const novo = String(texto).replace(RE_URL, (u) => {
      const m = u.match(/[).,;!?*_~]+$/);
      const sufixoPont = m ? m[0] : '';
      const limpa = sufixoPont ? u.slice(0, -sufixoPont.length) : u;
      let host;
      try {
        const x = new URL(limpa);
        if (x.protocol !== 'https:' && x.protocol !== 'http:') return u;
        host = x.hostname;
      } catch { return u; }
      if (HOST_NAO_RASTREAR.test(host)) return u;

      // Chave estavel por execucao + posicao do link: todos os grupos do mesmo
      // disparo compartilham o codigo base, e uma retomada (outbox, restart)
      // reusa o codigo em vez de emitir outro.
      const chave = String(ctx.execId) + '|' + (n++);
      let base = doc.origens[chave];
      if (!base || !doc.links[base]) {
        do { base = prefixoDoDia(dia) + aleatorio(3); } while (doc.links[base]);
        doc.origens[chave] = base;
        doc.links[base] = {
          ...meta,
          slugLoja: slugLoja(host),
          url: limpa,
          enviadoEm: agora.toISOString(),
          execId: String(ctx.execId),
          grupos: {},
        };
      }
      const reg = doc.links[base];
      const g = reg.grupos[sufixo] || (reg.grupos[sufixo] = {});
      g.jid = ctx.jid;
      if (ctx.nomeGrupo) g.nome = String(ctx.nomeGrupo).slice(0, 80);
      if (!g.em) g.em = agora.toISOString();
      if (limpa !== reg.url) g.destino = limpa; else delete g.destino;

      const rastreado = basePublica() + '/' + reg.slugLoja + '/' + base + '-' + sufixo;
      trocas.set(limpa, rastreado);
      mudou = true;
      return rastreado + sufixoPont;
    });

    if (!mudou) return original;
    salvarShard(doc);

    let lp = preview;
    if (preview) {
      const alvo = trocas.get(String(preview['matched-text'] || ''))
                || trocas.get(String(preview['canonical-url'] || ''));
      if (alvo) lp = { ...preview, 'canonical-url': alvo, 'matched-text': alvo };
    }
    return { texto: novo, preview: lp, links: [...trocas.values()] };
  } catch (e) {
    console.warn('[RASTREIO] Falha — mensagem segue com o link original:', e.message);
    return original;
  }
}

/** Resolve um codigo base (5 chars) a partir do disco. Usado pelo proxy. */
export async function resolverCodigo(base) {
  const b = String(base || '');
  if (!/^[0-9A-Za-z]{5}$/.test(b)) return null;
  const idx = B62.indexOf(b[0]) * 62 + B62.indexOf(b[1]);
  const dia = new Date(EPOCA_UTC + idx * 86400000).toISOString().slice(0, 10);
  const doc = _dias.get(dia) || (() => {
    try { return JSON.parse(readFileSync(SESSAO_DIR + '/' + nomeShard(dia), 'utf-8')); } catch { return null; }
  })();
  const reg = doc?.links?.[b];
  return reg ? { dia, base: b, ...reg } : null;
}

export function estadoRastreio() {
  const hoje = diaSP();
  const doc = _dias.get(hoje);
  return {
    ativo: rastreioAtivo(),
    base: basePublica(),
    hoje,
    codigosHoje: doc ? Object.keys(doc.links).length : null,
  };
}
