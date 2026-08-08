// ═══════════════════════════════════════════════════════════════════════════
// radar-awin.js — Integracao com a Awin (rede de afiliados).
//
// Diferente dos outros radares (Amazon/ML/Shopee/Magalu), que sao UMA loja
// cada, a Awin e uma REDE: um unico token da acesso a dezenas de anunciantes.
// Isso cobre exatamente o buraco atual — cupom de loja fora das quatro grandes
// saia sem link de afiliado e ficava inelegivel para auto-envio.
//
// O que este modulo entrega:
//   • catalogo de programas afiliados (cache local, refresh diario)
//   • resolucao loja -> programa (por nome ou por dominio do link)
//   • link de afiliado SINCRONO via clickThroughUrl do programa (nao gasta
//     rede nem quota) e deeplink ASSINCRONO via Link Builder para URL especifica
//   • leitura das ofertas/cupons publicados pelos anunciantes (Offers API)
//
// Endpoints (base https://api.awin.com), Bearer token, 20 chamadas/min:
//   GET  /publishers/{id}/programmes?relationship=joined
//   POST /publishers/{id}/linkbuilder/generate      (shorten: 300/dia)
//   GET  /publishers/{id}/linkbuilder/quota
//   POST /publisher/{id}/promotions                 (repare: publisher singular)
//
// Requisitos no Railway:
//   AWIN_TOKEN         token de API gerado na interface da Awin
//   AWIN_PUBLISHER_ID  id da conta de publisher
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';

const API = 'https://api.awin.com';
const SESSAO_DIR   = './sessao';
const PROGRAMAS_PATH = SESSAO_DIR + '/awin_programas.json';
const LINKS_PATH     = SESSAO_DIR + '/awin_links.json';

// Catalogo regenera a partir da API a qualquer momento — por isso fica so em
// disco local, sem entrar no sync do GitHub.
const TTL_CATALOGO_MS = 24 * 60 * 60 * 1000;

let _programas = [];      // lista crua vinda da API
let _porChave  = new Map();  // nome normalizado -> programa
let _porDominio= new Map();  // dominio raiz -> programa
let _atualizadoEm = 0;
let _links = {};          // "advertiserId|url|clickref" -> { url, shortUrl, em }

export function credenciaisAwinOk() {
  return !!(process.env.AWIN_TOKEN && process.env.AWIN_PUBLISHER_ID);
}

function publisherId() { return String(process.env.AWIN_PUBLISHER_ID || '').trim(); }

async function chamarAwin(caminho, { metodo = 'GET', corpo = null } = {}) {
  if (!credenciaisAwinOk()) throw new Error('AWIN_TOKEN / AWIN_PUBLISHER_ID nao configurados.');
  const res = await fetch(API + caminho, {
    method: metodo,
    headers: {
      'Authorization': 'Bearer ' + process.env.AWIN_TOKEN,
      'Content-Type': 'application/json',
    },
    body: corpo ? JSON.stringify(corpo) : undefined,
    signal: AbortSignal.timeout(25000),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error('Awin ' + res.status + ': ' + txt.slice(0, 200));
  try { return JSON.parse(txt); } catch { throw new Error('Awin devolveu resposta nao-JSON.'); }
}

// ── NORMALIZACAO DE NOME DE LOJA ─────────────────────────────────────────────
// A IA devolve "Casas Bahia", "Outro: Casas Bahia" ou "casasbahia"; a Awin
// chama o mesmo programa de "Casas Bahia BR". Tokens de regiao sao ruido puro
// nessa comparacao e por isso caem fora antes do confronto.
const TOKENS_REGIAO = new Set([
  'br', 'bra', 'brasil', 'brazil', 'latam', 'global', 'com', 'loja', 'store', 'oficial',
]);

export function chaveLojaAwin(nome) {
  return String(nome || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/^outr[oa]s?\s*:\s*/, '')
    .split(/[^a-z0-9]+/)
    .filter(t => t && !TOKENS_REGIAO.has(t))
    .join('');
}

function dominioRaiz(host) {
  const h = String(host || '').toLowerCase().replace(/^\*\./, '').replace(/^www\./, '').trim();
  return h || null;
}

function hostDaUrl(url) {
  try { return dominioRaiz(new URL(String(url)).hostname); } catch { return null; }
}

function indexar(lista) {
  _porChave = new Map();
  _porDominio = new Map();
  for (const p of lista) {
    const chave = chaveLojaAwin(p.name);
    if (chave && !_porChave.has(chave)) _porChave.set(chave, p);
    const dominios = new Set();
    for (const d of (p.validDomains || [])) { const r = dominioRaiz(d.domain); if (r) dominios.add(r); }
    const hd = hostDaUrl(p.displayUrl); if (hd) dominios.add(hd);
    for (const d of dominios) if (!_porDominio.has(d)) _porDominio.set(d, p);
  }
}

// ── CATALOGO DE PROGRAMAS ────────────────────────────────────────────────────
export function carregarProgramasAwin() {
  try {
    if (existsSync(PROGRAMAS_PATH)) {
      const bruto = JSON.parse(readFileSync(PROGRAMAS_PATH, 'utf-8'));
      _programas = Array.isArray(bruto.programas) ? bruto.programas : [];
      _atualizadoEm = Number(bruto.atualizadoEm) || 0;
      indexar(_programas);
      console.log('[AWIN] Catalogo carregado — ' + _programas.length + ' programa(s).');
    }
  } catch (e) { console.log('[AWIN] Erro ao carregar catalogo:', e.message); }
  try {
    if (existsSync(LINKS_PATH)) _links = JSON.parse(readFileSync(LINKS_PATH, 'utf-8')) || {};
  } catch { _links = {}; }
  return _programas;
}

function gravarCatalogo() {
  try {
    if (!existsSync(SESSAO_DIR)) mkdirSync(SESSAO_DIR, { recursive: true });
    writeFileSync(PROGRAMAS_PATH, JSON.stringify({ atualizadoEm: _atualizadoEm, programas: _programas }));
  } catch (e) { console.log('[AWIN] Falha ao gravar catalogo:', e.message); }
}

function gravarLinks() {
  try {
    if (!existsSync(SESSAO_DIR)) mkdirSync(SESSAO_DIR, { recursive: true });
    writeFileSync(LINKS_PATH, JSON.stringify(_links));
  } catch (e) { console.log('[AWIN] Falha ao gravar cache de links:', e.message); }
}

/** Busca o catalogo na Awin e regrava o cache. `forcar` ignora o TTL. */
export async function atualizarProgramasAwin(forcar = false) {
  if (!credenciaisAwinOk()) return _programas;
  if (!forcar && _programas.length && Date.now() - _atualizadoEm < TTL_CATALOGO_MS) return _programas;
  const lista = await chamarAwin('/publishers/' + publisherId() + '/programmes?relationship=joined');
  if (!Array.isArray(lista)) throw new Error('resposta inesperada em /programmes');
  _programas = lista.map(p => ({
    id: p.id,
    name: p.name,
    displayUrl: p.displayUrl,
    clickThroughUrl: p.clickThroughUrl,
    logoUrl: p.logoUrl,
    status: p.status,
    setor: p.primarySector,
    moeda: p.currencyCode,
    validDomains: p.validDomains || [],
  }));
  _atualizadoEm = Date.now();
  indexar(_programas);
  gravarCatalogo();
  console.log('[AWIN] Catalogo atualizado — ' + _programas.length + ' programa(s) afiliado(s).');
  return _programas;
}

export function listarProgramasAwin() { return _programas.slice(); }

export function estadoAwin() {
  return {
    configurado: credenciaisAwinOk(),
    publisherId: publisherId() || null,
    programas: _programas.length,
    atualizadoEm: _atualizadoEm ? new Date(_atualizadoEm).toISOString() : null,
    linksEmCache: Object.keys(_links).length,
  };
}

// ── RESOLUCAO LOJA -> PROGRAMA ───────────────────────────────────────────────
/**
 * Encontra o programa pelo nome da loja. Match exato pela chave normalizada e,
 * so entao, por conteudo — "Renner" precisa achar "Favoritos Renner + Ashua
 * Team | Influenciadores BR", mas nomes curtos demais gerariam falso positivo,
 * dai o piso de 5 caracteres.
 */
export function programaAwinPorLoja(nome) {
  const chave = chaveLojaAwin(nome);
  if (!chave) return null;
  const exato = _porChave.get(chave);
  if (exato) return exato;
  if (chave.length < 5) return null;
  for (const [k, p] of _porChave) {
    if (k.length >= 5 && (k.includes(chave) || chave.includes(k))) return p;
  }
  return null;
}

/** Encontra o programa pelo dominio de um link (inclui subdominios). */
export function programaAwinPorUrl(url) {
  const host = hostDaUrl(url);
  if (!host) return null;
  if (_porDominio.has(host)) return _porDominio.get(host);
  for (const [d, p] of _porDominio) {
    if (host === d || host.endsWith('.' + d)) return p;
  }
  return null;
}

export function ehLinkAwin(texto) {
  const m = String(texto || '').match(/https?:\/\/[^\s]+/);
  return !!(m && programaAwinPorUrl(m[0]));
}

/**
 * Link de afiliado SINCRONO para a loja: usa o clickThroughUrl do proprio
 * programa (ja tracqueado). Sem rede e sem consumir a quota de shortlinks —
 * por isso serve dentro de formatarCupomTSP, que e sincrona.
 */
export function linkAwinDaLoja(nome) {
  const p = programaAwinPorLoja(nome);
  return p?.clickThroughUrl || null;
}

/** Deeplink manual, no formato que a propria Awin devolve no urlTracking. */
export function deeplinkAwin(advertiserId, destino, clickref) {
  if (!advertiserId || !destino) return null;
  const q = new URLSearchParams({ awinmid: String(advertiserId), awinaffid: publisherId() });
  if (clickref) q.set('clickref', String(clickref).slice(0, 100));
  return 'https://www.awin1.com/cread.php?' + q.toString() + '&ued=' + encodeURIComponent(destino);
}

// ── LINK BUILDER ─────────────────────────────────────────────────────────────
/**
 * Gera (ou reaproveita do cache) um link de afiliado para uma URL especifica.
 * `clickref` viaja ate o relatorio de transacoes — e o que permite saber depois
 * qual disparo/grupo gerou a venda.
 */
export async function gerarLinkAwin({ url, advertiserId = null, clickref = '', encurtar = true }) {
  const destino = String(url || '').trim();
  if (!destino) throw new Error('informe a url de destino.');
  const prog = advertiserId ? { id: advertiserId } : programaAwinPorUrl(destino);
  if (!prog?.id) throw new Error('nenhum programa Awin afiliado para esse link.');

  const chave = prog.id + '|' + destino + '|' + (clickref || '');
  const emCache = _links[chave];
  if (emCache) return { ...emCache, cache: true };

  let r;
  try {
    r = await chamarAwin('/publishers/' + publisherId() + '/linkbuilder/generate', {
      metodo: 'POST',
      corpo: {
        advertiserId: prog.id,
        destinationUrl: destino,
        parameters: clickref ? { clickref: String(clickref).slice(0, 100) } : {},
        shorten: !!encurtar,
      },
    });
  } catch (e) {
    // Quota de shortlink esgotada ou anunciante que nao libera o link builder:
    // o deeplink manual tem exatamente o mesmo efeito de tracking.
    const manual = deeplinkAwin(prog.id, destino, clickref);
    if (!manual) throw e;
    console.log('[AWIN] Link Builder falhou (' + e.message + ') — usando deeplink manual.');
    return { url: manual, shortUrl: null, advertiserId: prog.id, manual: true };
  }

  const saida = { url: r.url, shortUrl: r.shortUrl || null, advertiserId: prog.id, em: Date.now() };
  _links[chave] = saida;
  gravarLinks();
  return saida;
}

export async function quotaLinkAwin() {
  return await chamarAwin('/publishers/' + publisherId() + '/linkbuilder/quota');
}

// ── OFERTAS E CUPONS PUBLICADOS PELOS ANUNCIANTES ────────────────────────────
/**
 * Le a Offers API paginando ate o fim. `tipo`: 'voucher' | 'promotion' | 'all'.
 * `status`: 'active' | 'expiringSoon' | 'upcoming'.
 * Cada item ja vem com endDate real e urlTracking pronto — nada aqui depende de
 * IA para saber a loja, o codigo ou a validade.
 */
export async function buscarOfertasAwin({
  tipo = 'voucher', status = 'active', regioes = ['BR'], membership = 'joined',
  advertiserIds = null, atualizadoDesde = null, maxPaginas = 10,
} = {}) {
  const filtros = { membership, status, type: tipo };
  if (regioes?.length) filtros.regionCodes = regioes;
  if (advertiserIds?.length) filtros.advertiserIds = advertiserIds;
  if (atualizadoDesde) filtros.updatedSince = atualizadoDesde;

  const todos = [];
  for (let pagina = 1; pagina <= maxPaginas; pagina++) {
    const r = await chamarAwin('/publisher/' + publisherId() + '/promotions', {
      metodo: 'POST',
      corpo: { filters: filtros, pagination: { page: pagina, pageSize: 200 } },
    });
    const itens = Array.isArray(r?.data) ? r.data : [];
    todos.push(...itens);
    if (itens.length < 200) break;
  }
  return todos;
}

/**
 * Converte uma oferta da Awin no formato de cupom usado pelo TSP.
 * Valor/tipo/minimo nao vem estruturados da rede: sao lidos do titulo por
 * regex simples aqui, e quem quiser precisao chama a IA por cima do texto.
 */
export function normalizarOfertaAwin(oferta) {
  const texto = [oferta?.title, oferta?.description].filter(Boolean).join(' ');
  const pct   = texto.match(/(\d{1,2})\s*%/);
  const reais = texto.match(/R\$\s*([\d.]+)/);
  const min   = texto.match(/(?:acima de|a partir de|m[ií]nim[ao] de)\s*R\$\s*([\d.]+)/i);
  const numero = s => Number(String(s).replace(/\./g, '').replace(',', '.'));

  return {
    origem: 'awin',
    promotionId: oferta?.promotionId || null,
    loja: String(oferta?.advertiser?.name || '').replace(/\s*\(?(BR|Global)\)?\s*$/i, '').trim(),
    advertiserId: oferta?.advertiser?.id || null,
    codigo: oferta?.voucher?.code || null,
    exclusivo: !!oferta?.voucher?.exclusive,
    // Cupom "attributable" atribui a venda mesmo sem clique no nosso link — o
    // melhor formato possivel para divulgacao em grupo de WhatsApp.
    atribuivel: !!oferta?.voucher?.attributable,
    tipo: pct ? 'pct' : (reais ? 'reais' : null),
    valor: pct ? Number(pct[1]) : (reais ? numero(reais[1]) : null),
    minimo: min ? numero(min[1]) : null,
    maximo: null,
    limite: null,
    titulo: oferta?.title || '',
    descricao: oferta?.description || '',
    termos: oferta?.terms && oferta.terms !== '..' ? oferta.terms : null,
    inicioEm: oferta?.startDate || null,
    validadeAte: oferta?.endDate || null,
    url: oferta?.url || null,
    urlAfiliado: oferta?.urlTracking || null,
  };
}
