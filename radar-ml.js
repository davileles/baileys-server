// ═══════════════════════════════════════════════════════════════════════════
// radar-ml.js — Mercado Livre.
//
// Diferente da Magalu, aqui existe API OFICIAL de produtos (api.mercadolibre.com),
// entao o preco volta a ser verificado, como na Amazon e na Shopee.
//
// Autenticacao OAuth2 com authorization_code + refresh_token:
//   - o operador autoriza UMA vez em /ml/conectar;
//   - o access_token dura ~6h e e renovado sozinho pelo refresh_token;
//   - os tokens ficam em ./sessao/ml_token.json.
//
// Requisitos no Railway:
//   ML_CLIENT_ID, ML_CLIENT_SECRET   da aplicacao criada no DevCenter
//   ML_TAG                            etiqueta de afiliado (opcional para consulta)
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { credencialTsp } from './config-tsp.js';
import { tenantContexto } from './tenants.js';
import {
  resolverPrecoDe, precoDeDoLd, precoDeDoEstado, precoDeDoDom,
  descontoDeclaradoNoHtml, numeroJson,
  FONTE_API, FONTE_LDJSON, FONTE_ESTADO, FONTE_DOM,
} from './preco-de.js';

const SESSAO_DIR = './sessao';
// Token OAuth por OPERADOR (fase 2.3): cada um autoriza a propria conta do
// Mercado Livre. Raiz mantem o caminho historico; demais em tenants/<id>/.
function tenantMl() { return tenantContexto() || 'tsp'; }
function tokenPath() {
  const id = tenantMl();
  if (id === 'tsp') return SESSAO_DIR + '/ml_token.json';
  const dir = SESSAO_DIR + '/tenants/' + id;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir + '/ml_token.json';
}
const API = 'https://api.mercadolibre.com';
const AUTH = 'https://auth.mercadolivre.com.br';

export const ML_REDIRECT_URI =
  process.env.ML_REDIRECT_URI ||
  'https://baileys-server-production-ebfe.up.railway.app/ml/callback';

const _toks = new Map();   // tenantId -> { access_token, refresh_token, expira_em } | null
function tokAtual()  { return _toks.get(tenantMl()) || null; }
function tokDef(t)   { _toks.set(tenantMl(), t); return t; }

export function credenciaisMlOk() {
  return !!(credencialTsp('ML_CLIENT_ID') && credencialTsp('ML_CLIENT_SECRET'));
}
export function tagMl() { return credencialTsp('ML_TAG') || null; }

// Tag por produto (pool criado a mao no painel do ML). Sem pool devolve null e
// tudo segue com a tag unica da conta.
import { tagMlDoProduto } from './radar-amazon.js';
// A etiqueta do ML e escolhida pela CATEGORIA do produto, entao a geracao de
// link precisa saber classificar. categorizador.js so depende de fs e do sync,
// entao nao ha ciclo de import aqui.
import { classificarProduto, categoriaConfiavel } from './categorizador.js';

function carregarToken() {
  try { if (existsSync(tokenPath())) tokDef(JSON.parse(readFileSync(tokenPath(), 'utf-8'))); }
  catch (e) { tokDef(null); }
  return tokAtual();
}
function salvarToken(t) {
  tokDef(t);
  try { writeFileSync(tokenPath(), JSON.stringify(t, null, 2), 'utf-8'); }
  catch (e) { console.log('[ML] Erro ao salvar token:', e.message); }
}

export function estadoMl() {
  if (!tokAtual()) carregarToken();
  const _tok = tokAtual();   // leitura local do operador do contexto
  return {
    credenciais: credenciaisMlOk(),
    tag: tagMl(),
    autorizado: !!_tok?.refresh_token,
    expiraEm: _tok?.expira_em ? new Date(_tok.expira_em).toISOString() : null,
    tokenValido: !!(_tok?.access_token && Date.now() < (_tok.expira_em || 0)),
    redirectUri: ML_REDIRECT_URI,
    diagnostico: {
      ML_CLIENT_ID_presente: !!credencialTsp('ML_CLIENT_ID'),
      ML_CLIENT_SECRET_presente: !!credencialTsp('ML_CLIENT_SECRET'),
      ML_TAG_presente: !!credencialTsp('ML_TAG'),
      variaveis_ml_vistas: Object.keys(process.env).filter(k => /^ML_/.test(k)).sort(),
    },
  };
}

/** URL para o operador autorizar a aplicacao. Uma vez so. */
export function urlAutorizacao(estado = 'cdv') {
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: credencialTsp('ML_CLIENT_ID'),
    redirect_uri: ML_REDIRECT_URI,
    state: estado,
  });
  return AUTH + '/authorization?' + p.toString();
}

async function pedirToken(corpo) {
  const res = await fetch(API + '/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: new URLSearchParams(corpo).toString(),
    signal: AbortSignal.timeout(20000),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('HTTP ' + res.status + ' — ' + (d.message || d.error || 'falha ao obter token'));
  // Renova 5 min antes do vencimento real, para nao correr o risco de usar um
  // token que expira no meio da chamada.
  salvarToken({
    access_token: d.access_token,
    refresh_token: d.refresh_token || tokAtual()?.refresh_token || null,
    expira_em: Date.now() + ((d.expires_in || 21600) - 300) * 1000,
    user_id: d.user_id ?? tokAtual()?.user_id ?? null,
  });
  return tokAtual();
}

/** Troca o 'code' do callback pelo par de tokens. */
export async function trocarCodePorToken(code) {
  return pedirToken({
    grant_type: 'authorization_code',
    client_id: credencialTsp('ML_CLIENT_ID'),
    client_secret: credencialTsp('ML_CLIENT_SECRET'),
    code,
    redirect_uri: ML_REDIRECT_URI,
  });
}

async function renovar() {
  if (!tokAtual()?.refresh_token) throw new Error('sem refresh_token — autorize em /ml/conectar');
  console.log('[ML] Renovando access_token…');
  return pedirToken({
    grant_type: 'refresh_token',
    client_id: credencialTsp('ML_CLIENT_ID'),
    client_secret: credencialTsp('ML_CLIENT_SECRET'),
    refresh_token: tokAtual().refresh_token,
  });
}

async function tokenValido() {
  if (!tokAtual()) carregarToken();
  if (!tokAtual()) throw new Error('não autorizado — acesse /ml/conectar');
  if (Date.now() >= (tokAtual().expira_em || 0)) await renovar();
  return tokAtual().access_token;
}

async function apiMl(caminho) {
  let token = await tokenValido();
  let res = await fetch(API + caminho, {
    headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  // 401 fora da janela prevista: renova e tenta uma vez.
  if (res.status === 401) {
    await renovar();
    token = tokAtual().access_token;
    res = await fetch(API + caminho, {
      headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(20000),
    });
  }
  const d = await res.json().catch(() => null);
  if (!res.ok) throw new Error('ML ' + res.status + ': ' + (d?.message || d?.error || 'erro'));
  return d;
}

// ── LINKS ─────────────────────────────────────────────────────────────────

const REGEX_URL_ML = /https?:\/\/(?:[\w-]+\.)*(?:mercadolivre\.com\.br|mercadolibre\.com|meli\.la|mercadolivre\.com)\/\S+/gi;

export function ehLinkMl(texto) {
  return new RegExp(REGEX_URL_ML.source, 'i').test(String(texto || ''));
}

/** Acha o MLB… em qualquer formato de URL do ML. */
export function idDeUrl(url) {
  const s = String(url || '');
  const m = s.match(/\bMLB-?(\d{6,})/i);
  return m ? 'MLB' + m[1] : null;
}

// ── RESOLUCAO DE LINK ─────────────────────────────────────────────────────
// Tres formatos chegam pelos grupos e pelo painel:
//   1. pagina de produto — /p/MLB123 ou /up/MLBU123 (catalogo unificado)
//   2. encurtador        — meli.la/xxxx e /sec/xxxx
//   3. perfil de afiliado — /social/<usuario>?ref=<token>
// O (3) e o formato que os SEUS links de afiliado assumem: meli.la redireciona
// para ele, e a pagina embute o produto destacado num bloco 'show_product'.

const RE_ENCURTADOR_ML = /^https?:\/\/(www\.)?meli\.la\/|\/sec\//i;
const RE_SOCIAL_ML = /mercadolivre\.com(\.br)?\/social\//i;

/** Qualquer id de produto do ML, incluindo o do catalogo unificado (MLBU). */
export function idProdutoMl(url) {
  const s = String(url || '');
  const m = s.match(/\/(?:p|up)\/(MLBU?\d{6,})/i) || s.match(/(?:^|[^A-Za-z0-9])(MLBU\d{6,})/i);
  return m ? m[1].toUpperCase() : idDeUrl(s);
}

/**
 * Converte qualquer um dos tres formatos na URL da pagina do produto.
 *
 * Importante: URL que ja e do dominio principal NAO passa pelo resolvedor de
 * encurtador. Ele faz ate 6 requisicoes ANONIMAS (sem o cookie de sessao), e
 * era isso que derrubava /up/MLBU na tela antibot — o id nao era reconhecido,
 * o codigo achava que era link curto e disparava a cascata.
 */
export async function resolverLinkMl(url) {
  let alvo = String(url || '').trim();
  if (!alvo) return alvo;

  if (RE_ENCURTADOR_ML.test(alvo)) alvo = await resolverEncurtadorMl(alvo);

  if (RE_SOCIAL_ML.test(alvo)) {
    const prod = await produtoDePerfilSocial(alvo);
    if (prod?.url) return prod.url;
    throw new Error('link de perfil de afiliado sem produto identificavel');
  }
  return alvo;
}

async function resolverEncurtadorMl(url, tentativas = 6) {
  let atual = url;
  for (let i = 0; i < tentativas; i++) {
    if (idDeUrl(atual)) return atual;
    const res = await fetch(atual, {
      method: 'GET', redirect: 'manual',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        'Accept-Language': 'pt-BR,pt;q=0.9', 'Range': 'bytes=0-0',
      },
      signal: AbortSignal.timeout(12000),
    });
    const loc = res.headers.get('location');
    if (!loc) return res.url || atual;
    atual = new URL(loc, atual).href;
  }
  return atual;
}

export async function extrairIdsMl(texto) {
  const urls = [...new Set(String(texto || '').match(REGEX_URL_ML) || [])]
    .map(u => u.replace(/[)\]}.,;!]+$/, ''));
  const ids = new Set();
  for (const url of urls) {
    // idProdutoMl reconhece tambem o catalogo unificado (/up/MLBU), que o
    // idDeUrl ignora — sem isso o link era descartado antes de virar oferta.
    let id = idProdutoMl(url);
    if (!id) {
      try { id = idProdutoMl(await resolverLinkMl(url)); }
      catch (e) { console.warn('[ML] Falha ao resolver', url, '-', e.message); }
    }
    if (id) ids.add(id); else console.warn('[ML] Sem id de produto para', url);
  }
  return [...ids];
}

/** Acrescenta a etiqueta de afiliado ao permalink do produto. */
export function comTagAfiliado(url) {
  const tag = tagMl();
  if (!url || !tag) return url;
  try {
    const u = new URL(url);
    u.searchParams.set('matt_word', tag);
    u.searchParams.set('matt_tool', tag);
    return u.href;
  } catch (e) { return url; }
}

// ── PRODUTOS VIA PAINEL DE AFILIADOS ──────────────────────────────────────
// A API publica (api.mercadolibre.com/items) devolve 403 para itens de
// terceiros. Com o cookie de sessao, porem, a pagina do produto abre normal —
// e o ML publica os dados em JSON-LD, que e um contrato estavel o suficiente.

const REGEX_LD_JSON = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

function extrairLdProduto(html) {
  for (const m of html.matchAll(REGEX_LD_JSON)) {
    try {
      const dado = JSON.parse(m[1].trim());
      const lista = Array.isArray(dado) ? dado : [dado];
      for (const d of lista) {
        if (d && (d['@type'] === 'Product' || d['@type'] === 'ProductGroup')) return d;
      }
    } catch (e) { /* bloco malformado: segue para o proximo */ }
  }
  return null;
}

// ── TRILHA DE CATEGORIA (breadcrumb) ──────────────────────────────────────
// O classificador ja usa breadcrumb da Amazon como fonte de maior confianca;
// sem isto, tudo que vem do ML e decidido so por palavra no titulo — que e
// exatamente onde o classificador erra. A pagina ja esta em maos aqui, entao
// ler a trilha nao custa nem uma requisicao a mais.
const LIXO_TRILHA_ML = /^(voltar|inicio|in\u00edcio|home|mercado livre|todas as categorias|categorias)$/i;

function decodificarEntidades(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

function limparTrilhaMl(nomes) {
  const limpos = [...new Set((nomes || [])
    .map(n => decodificarEntidades(n).replace(/\s+/g, ' ').trim())
    .filter(n => n && n.length > 1 && !LIXO_TRILHA_ML.test(n)))];
  if (!limpos.length) return null;
  return { categoria: limpos[0], caminho: limpos.slice(0, 5).join(' > ') };
}

/** Trilha de categoria do anuncio. JSON-LD primeiro; nav.andes-breadcrumb depois. */
export function extrairTrilhaMl(html) {
  for (const m of String(html || '').matchAll(REGEX_LD_JSON)) {
    try {
      const dado = JSON.parse(m[1].trim());
      for (const d of (Array.isArray(dado) ? dado : [dado])) {
        if (d?.['@type'] !== 'BreadcrumbList') continue;
        const t = limparTrilhaMl((d.itemListElement || [])
          .map(e => e?.name || e?.item?.name || ''));
        if (t) return t;
      }
    } catch (e) { /* bloco malformado: segue */ }
  }
  // O ultimo item do breadcrumb do ML costuma ser o proprio anuncio, sem <a>:
  // ler so os links ja descarta esse ruido de graca.
  const bloco = String(html || '').match(/andes-breadcrumb[\s\S]{0,4000}?<\/(?:nav|ol|ul)>/);
  if (bloco) {
    const nomes = [...bloco[0].matchAll(/<a[^>]*>\s*([^<>]{2,60}?)\s*<\/a>/g)].map(x => x[1]);
    const t = limparTrilhaMl(nomes);
    if (t) return t;
  }
  return null;
}

function metaConteudo(html, prop) {
  const m = html.match(new RegExp('<meta[^>]+(?:property|name)=["\']' + prop + '["\'][^>]*content=["\']([^"\']+)', 'i'));
  return m ? m[1] : null;
}

// ── PRECO CHEIO PELA API OFICIAL ──────────────────────────────────────────
// /items/{id}/prices e a fonte mais confiavel do valor riscado, mas responde
// 403 para itens de terceiros dependendo do escopo autorizado do app. Em vez
// de nunca tentar (era o caso ate aqui: o pipeline so raspava HTML) ou de
// insistir a cada produto, tenta e se desliga sozinha depois de tres recusas
// seguidas. Uma resposta boa religa o contador; o proximo boot zera tudo.
let _apiPrecosFalhas = 0;
const API_PRECOS_MAX_FALHAS = 3;

export function estadoApiPrecosMl() {
  return { ativa: _apiPrecosFalhas < API_PRECOS_MAX_FALHAS, falhasSeguidas: _apiPrecosFalhas };
}

async function precoDeApiMl(id) {
  if (!id || !credenciaisMlOk()) return null;
  if (_apiPrecosFalhas >= API_PRECOS_MAX_FALHAS) return null;
  try {
    const d = await apiMl('/items/' + encodeURIComponent(id) + '/prices');
    _apiPrecosFalhas = 0;
    const refs = [...(d?.reference_prices || []), ...(d?.prices || [])];
    for (const r of refs) {
      const tipo = String(r?.type || '').toLowerCase();
      if (!/was_price|list_price|reference|original/.test(tipo)) continue;
      const v = numeroJson(r?.amount ?? r?.regular_amount);
      if (v) return v;
    }
    return null;
  } catch (e) {
    _apiPrecosFalhas++;
    console.warn('[ML] Preco pela API indisponivel para ' + id + ' (' + e.message +
                 ') — falha ' + _apiPrecosFalhas + '/' + API_PRECOS_MAX_FALHAS);
    return null;
  }
}

// ── ANTIBOT DA PAGINA DE PRODUTO ─────────────────────────────────────────
// O ML nao responde 403 quando desconfia do trafego: devolve HTTP 200 com a
// tela /gz/account-verification ("suspicious-traffic") no lugar da pagina, sem
// JSON-LD nenhum. Ate 25/08 isso passava despercebido — o preco saia null, o
// produto era descartado como "sem preco na pagina", o radar ML ficou o dia
// inteiro mudo, listas de envio foram consumidas item a item e o teste do
// token (linkbuilder) seguia dizendo que estava tudo bem. Aqui o bloqueio e
// nomeado, contado, e a API oficial (quando autorizada) assume a leitura.
const ERRO_ANTIBOT_ML = 'pagina bloqueada pelo antibot do ML';
// Duas variantes ja vistas: /gz/account-verification ("suspicious-traffic",
// pede confirmacao da conta) e /captcha/wall ("Seguridad — Mercado Libre",
// assets abuse-captcha) — esta ultima e a que o IP do Railway recebe.
const RE_ANTIBOT_URL_ML = /\/captcha\/wall|\/gz\/account-verification/i;
const RE_ANTIBOT_ML = /abuse-captcha|suspicious-traffic|\/gz\/account-verification|\/captcha\/wall|Para continuar, confirme que/i;

let _antibot = { desde: null, ultimoEm: null, ultimaUrl: null, bloqueios: 0 };
export function estadoAntibotMl() { return { ..._antibot, ativo: !!_antibot.desde }; }
function registrarAntibotMl(url) {
  _antibot.bloqueios++;
  _antibot.ultimoEm = new Date().toISOString();
  _antibot.ultimaUrl = url;
  if (!_antibot.desde) {
    _antibot.desde = _antibot.ultimoEm;
    console.warn('[ML] Antibot: pagina de produto bloqueada (' + url + ')');
  }
}
function registrarPaginaMlOk() {
  if (_antibot.desde) console.log('[ML] Antibot: pagina de produto voltou a abrir.');
  _antibot.desde = null;
}

/** Pagina do ML ou URL final que caiu na tela antibot. Pagina real tem JSON-LD. */
function paginaMlBloqueada(res, html, ld) {
  return RE_ANTIBOT_URL_ML.test(res?.url || '') || (!ld && RE_ANTIBOT_ML.test(html || ''));
}

function apiMlAutorizada() {
  if (!tokAtual()) carregarToken();
  return credenciaisMlOk() && !!tokAtual()?.refresh_token;
}

/**
 * Preco pela API oficial, quando a pagina nao serviu.
 *
 * O que este app consegue ler (medido em 25/08 com o token autorizado):
 *   /products/{id}          200  nome, fotos, status do produto de catalogo
 *   /products/{id}/items    200  todas as ofertas, com price/original_price/frete,
 *                                na ordem do buy box (o 1o e o que a pagina mostra)
 *   /items/{id}             403  anuncio de terceiro — em qualquer item
 *   /user-products/{MLBU}   403  catalogo unificado de terceiro
 * Ou seja: so CATALOGO tem fallback. Anuncio classico (/MLB-...) e /up/MLBU
 * ficam sem — quem chama recebe null e mantem o erro de bloqueio.
 *
 * O id de catalogo vem da URL (/p/MLB...) ou de opcoes.id: na vitrine o asin
 * salvo de link meli.la costuma ser o id de catalogo (MLB curto), e e o que
 * salva os 58 itens da vitrine cujo link nem chega a resolver com o antibot.
 */
async function dadosViaApiMl(urlResolvida, urlOriginal, opcoes = {}) {
  if (!apiMlAutorizada()) return null;
  const s = String(urlResolvida || '');
  const daUrl = (s.match(/\/p\/(MLB\d{5,})/i) || [])[1] || null;
  const dica  = /^MLB\d{5,}$/i.test(String(opcoes.id || '')) ? String(opcoes.id).toUpperCase() : null;
  const candidatos = [...new Set([daUrl, dica].filter(Boolean))];
  if (!candidatos.length) return null;

  for (const catalogo of candidatos) {
    let prod;
    // 404 aqui = o id e de anuncio, nao de catalogo: tenta o proximo candidato.
    try { prod = await apiMl('/products/' + encodeURIComponent(catalogo)); }
    catch (e) {
      if (/\b404\b/.test(e.message)) continue;
      console.warn('[ML] API oficial /products/' + catalogo + ':', e.message);
      return null;
    }
    try {
      // Sequencial, nunca em paralelo: o refresh_token do ML e de uso unico e
      // duas renovacoes simultaneas derrubariam a sessao.
      const ofertas = await apiMl('/products/' + encodeURIComponent(catalogo) + '/items?limit=10');
      const lista = (ofertas?.results || []).filter(r => Number(r?.price) > 0);
      const venc = lista[0] || null;
      if (!venc) {
        console.log('[ML] ' + catalogo + ' — catalogo sem oferta ativa na API oficial');
        return null;
      }
      const preco = Number(venc.price);
      const original = Number(venc.original_price) || null;
      const precoDe = original && original > preco ? original : null;
      const imagem = (prod?.pictures || []).map(pic => pic?.url).find(Boolean) || null;
      console.log('[ML] ' + catalogo + ' — preco lido pela API oficial (catalogo, ' + lista.length
        + ' oferta(s), vencedor ' + venc.item_id + ': R$ ' + preco + ')');
      return {
        titulo: prod?.name || null, preco, precoDe, imagem,
        disponivel: String(prod?.status || 'active') === 'active',
        precoDeFonte: precoDe ? FONTE_API : null, precoDeDescartes: [], descontoDeclarado: null,
        marca: (prod?.attributes || []).find(a => a?.id === 'BRAND')?.value_name || '',
        nota: null, avaliacoes: null, vendedor: venc.seller_id ? String(venc.seller_id) : null,
        achouLd: false, trilha: null, cuponsPagina: [], fonte: 'api',
        itemId: venc.item_id || null, catalogoId: catalogo,
        freteGratis: !!venc.shipping?.free_shipping,
      };
    } catch (e) {
      console.warn('[ML] API oficial /products/' + catalogo + '/items:', e.message);
      return null;
    }
  }
  return null;
}

// ── SONDA DA PAGINA DE PRODUTO ───────────────────────────────────────────
// Complemento de verificarTokenAff: o linkbuilder pode seguir respondendo
// enquanto o antibot barra toda pagina de produto — foi o cenario de 25/08.
let _saudePagina = { ok: null, verificadoEm: null, url: null, erro: null, avisado: false };
export function saudePaginaMl() { return { ..._saudePagina, antibot: estadoAntibotMl() }; }

/**
 * Abre uma pagina de produto com o cookie e diz se o antibot barrou.
 * @param {function} aoBloquear  avisa o operador uma vez por bloqueio; rearma
 *                               quando a pagina volta a abrir.
 */
export async function verificarPaginaProdutoMl(urlTeste, aoBloquear) {
  const cookie = cookieAff();
  if (!cookie || !urlTeste) return _saudePagina;
  try {
    const res = await fetch(urlTeste, {
      headers: {
        'Cookie': cookie,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(25000),
    });
    const html = await res.text();
    const bloqueado = paginaMlBloqueada(res, html, extrairLdProduto(html));
    const antes = _saudePagina.ok;
    _saudePagina = {
      ok: res.ok && !bloqueado,
      verificadoEm: new Date().toISOString(),
      url: urlTeste,
      erro: bloqueado ? ERRO_ANTIBOT_ML : (res.ok ? null : 'HTTP ' + res.status),
      avisado: bloqueado ? _saudePagina.avisado : false,
    };
    if (bloqueado) registrarAntibotMl(urlTeste); else registrarPaginaMlOk();
    if (bloqueado && !_saudePagina.avisado && typeof aoBloquear === 'function') {
      _saudePagina.avisado = true;
      await aoBloquear('sonda periodica em ' + urlTeste);
    }
    if (!bloqueado && antes === false) console.log('[ML] Sonda: pagina de produto voltou a abrir.');
    return _saudePagina;
  } catch (e) {
    _saudePagina = { ..._saudePagina, ok: false, verificadoEm: new Date().toISOString(), url: urlTeste, erro: e.message };
    return _saudePagina;
  }
}

/**
 * Busca a pagina do produto com o cookie e extrai o que der.
 * @param {object} [opcoes.id]  MLB do anuncio, quando quem chama ja o tem
 *   (vitrine, monitor): e o que permite o fallback pela API em URL /up/MLBU.
 */
export async function buscarDadosProdutoMl(url, opcoes = {}) {
  const cookie = cookieAff();
  if (!cookie) throw new Error('ML_AFF_TOKEN nao configurado');
  // Aceita pagina de produto, encurtador e perfil de afiliado.
  let alvoUrl = url;
  try { alvoUrl = await resolverLinkMl(url); } catch (e) { /* segue com a original */ }
  const res = await fetch(alvoUrl, {
    headers: {
      'Cookie': cookie,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'pt-BR,pt;q=0.9',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error('pagina do produto respondeu HTTP ' + res.status);
  const html = await res.text();

  const ld = extrairLdProduto(html);

  // Tela antibot no lugar da pagina: nomeia o bloqueio e tenta a API oficial.
  // Sem API autorizada, o erro diz o que fazer — melhor que "sem preco".
  if (paginaMlBloqueada(res, html, ld)) {
    registrarAntibotMl(alvoUrl);
    const viaApi = await dadosViaApiMl(alvoUrl, url, opcoes);
    if (viaApi) return { ...viaApi, bloqueado: true, urlFinal: alvoUrl };
    throw new Error(ERRO_ANTIBOT_ML + (apiMlAutorizada()
      ? ' — API oficial nao cobre este anuncio (so catalogo /p/)'
      : ' — autorize a API oficial em /ml/conectar para o fallback'));
  }
  registrarPaginaMlOk();

  const oferta = ld?.offers
    ? (Array.isArray(ld.offers) ? ld.offers[0] : ld.offers)
    : null;

  const preco = Number(oferta?.price ?? oferta?.lowPrice) || null;

  // Pagina abriu mas o JSON-LD nao trouxe preco (layout novo, anuncio pausado,
  // sem oferta): a API oficial responde o que a pagina calou, inclusive o
  // status — "pausado ou sem estoque" e mais util que "sem preco na pagina".
  if (!preco) {
    const viaApi = await dadosViaApiMl(alvoUrl, url, opcoes);
    if (viaApi) return { ...viaApi, urlFinal: alvoUrl };
  }

  const titulo = ld?.name || metaConteudo(html, 'og:title') || null;
  const imagem = (Array.isArray(ld?.image) ? ld.image[0] : ld?.image) || metaConteudo(html, 'og:image') || null;

  // O "de" passa pela cascata unica de fontes (preco-de.js): API oficial,
  // JSON-LD, JSON embutido na pagina e, so como ultimo recurso, o bloco
  // riscado do DOM. Cada candidata e conferida contra o preco atual e contra
  // o percentual que a propria pagina anuncia ("28% OFF").
  //
  // O regex anterior lia "original_price": 33.61 e removia o ponto achando que
  // era separador de milhar — virava 3361, a trava de 5x descartava e a oferta
  // saia sem "De:" com o valor cheio a vista na pagina.
  const idProduto = idDeUrl(alvoUrl);
  const descontoDeclarado = descontoDeclaradoNoHtml(html);
  const resolvido = resolverPrecoDe({
    preco,
    descontoDeclarado,
    rotulo: idProduto || 'ML',
    candidatos: [
      { fonte: FONTE_API,    valor: await precoDeApiMl(idProduto) },
      { fonte: FONTE_LDJSON, valor: precoDeDoLd(ld) },
      { fonte: FONTE_ESTADO, valor: precoDeDoEstado(html) },
      { fonte: FONTE_DOM,    valor: precoDeDoDom(html) },
    ],
  });
  const precoDe = resolvido.precoDe;

  const disponivel = !/OutOfStock|Sem estoque|Publicação pausada/i.test(
    (oferta?.availability || '') + html.slice(0, 60000));

  return {
    titulo, preco, precoDe, imagem, disponivel,
    urlFinal: alvoUrl,            // pagina do produto ja resolvida (link curto -> canonica)
    precoDeFonte: resolvido.fonte,
    precoDeDescartes: resolvido.descartes,
    descontoDeclarado,
    marca: ld?.brand?.name || '',
    nota: Number(ld?.aggregateRating?.ratingValue) || null,
    avaliacoes: Number(ld?.aggregateRating?.reviewCount) || null,
    vendedor: oferta?.seller?.name || null,
    achouLd: !!ld,
    // Trilha de categoria: alimenta o cache do classificador (categorizador.js),
    // elevando o ML ao mesmo nivel de confianca que a Amazon ja tinha.
    trilha: extrairTrilhaMl(html),
    // Cupons que o proprio anuncio declara. O ML ja resolveu categoria,
    // vendedor, minimo e teto para ESTE item — coisa que a base nao modela.
    cuponsPagina: extrairCupomMl(html),
  };
}

/**
 * Gera links de afiliado em lote pelo painel. Uma chamada resolve varias URLs.
 * error_code 111 = produto fora do programa (nao e falha nossa).
 */
async function chamarCreateLink(urls, tag) {
  const r = await chamarAff('https://www.mercadolivre.com.br/affiliate-program/api/v2/affiliates/createLink', {
    method: 'POST',
    body: JSON.stringify({ urls, tag }),
    headers: {
      'Origin': 'https://www.mercadolivre.com.br',
      'Referer': 'https://www.mercadolivre.com.br/afiliados/linkbuilder',
    },
  });
  if (!r.ok || typeof r.corpo !== 'object') throw new Error('createLink respondeu HTTP ' + r.status);
  return r.corpo.urls || [];
}

/**
 * @param {string[]} urls
 * @param {object}  [opcoes]
 * @param {object}  [opcoes.titulos]  mapa url -> titulo do produto. E o que
 *   permite classificar e escolher a etiqueta do nicho. Sem titulo o produto
 *   cai na etiqueta do balde geral (ou na tag da conta, se nao houver mapa) —
 *   nunca fica sem afiliado.
 */
export async function gerarLinksAfiliadoMl(urls, opcoes = {}) {
  const tagConta = tagMl();
  if (!tagConta) throw new Error('ML_TAG nao configurado');

  const titulos = opcoes.titulos || {};

  // Uma chamada por tag: o createLink aceita varias URLs, mas uma unica tag por
  // requisicao. Sem mapa de etiquetas todo mundo cai no mesmo balde e o numero
  // de chamadas continua sendo um, como antes.
  const porTag = new Map();
  for (const u of urls) {
    const titulo = titulos[u] || titulos[idDeUrl(u)] || '';
    // Categoria so vale quando o classificador tem confianca: etiqueta errada
    // e pior que etiqueta generica, porque contamina a medicao do nicho.
    const cls = titulo
      ? classificarProduto({ titulo, asin: idDeUrl(u), loja: 'Mercado Livre' })
      : null;
    const cat = (cls && categoriaConfiavel(cls)) ? cls.categoria : '';
    const t = tagMlDoProduto(idDeUrl(u), cat) || tagConta;
    if (!porTag.has(t)) porTag.set(t, []);
    porTag.get(t).push(u);
  }

  const respostas = [];
  for (const [t, lote] of porTag) {
    let saida;
    try { saida = await chamarCreateLink(lote, t); }
    catch (e) {
      if (t === tagConta) throw e;
      console.warn('[ML] createLink falhou com a tag ' + t + ' — repetindo com a tag da conta:', e.message);
      saida = await chamarCreateLink(lote, tagConta);
    }
    // error_code 109 = a tag nao existe na conta de afiliado. Acontece quando
    // alguem poe no pool uma tag que nao foi criada no painel do ML. O link
    // NAO pode sair sem afiliado valido, entao refaz com a tag da conta e
    // avisa — perde-se a segmentacao daquele item, nunca a comissao.
    const semTag = saida.filter((u) => !u.created && Number(u.error_code) === 109);
    if (semTag.length && t !== tagConta) {
      console.warn(`[ML] tag "${t}" nao esta associada a conta — ${semTag.length} link(s) refeitos com a tag da conta`);
      const refeitos = await chamarCreateLink(semTag.map((u) => u.entity || u.origin_url), tagConta);
      const chavesRefeitas = new Set(semTag.map((u) => u.entity || u.origin_url));
      respostas.push(...saida.filter((u) => !chavesRefeitas.has(u.origin_url || u.entity)), ...refeitos);
      continue;
    }
    respostas.push(...saida);
  }

  const mapa = new Map();
  for (const u of respostas) {
    const valor = u.created
      ? { link: u.short_url, linkLongo: u.long_url, codigoBusca: u.regex }
      : { erro: u.message || ('error_code ' + u.error_code) };
    const chave = u.origin_url || u.entity;
    mapa.set(chave, valor);
    // Indexa tambem pelo MLB: o painel pode devolver a origin_url normalizada
    // (barra final, maiusculas, parametro a mais) e o casamento por string
    // exata falharia em silencio, virando 'sem resposta do painel'.
    const id = idDeUrl(chave);
    if (id && !mapa.has(id)) mapa.set(id, valor);
  }
  return mapa;
}

// ── PRODUTOS ──────────────────────────────────────────────────────────────

// ── TOKEN DO PAINEL DE AFILIADOS ──────────────────────────────────────────
// A API publica so devolve itens do proprio vendedor (403 para terceiros), entao
// os dados de produto vem da API interna do painel de afiliados — a mesma que a
// extensao do Busqy usa. O token vive em ML_AFF_TOKEN.
//
// Nao sabemos de antemao se esse token expira: o operador relata meses sem
// precisar trocar. Por isso o monitor abaixo nao assume validade — ele testa
// periodicamente e avisa no ato se parar de funcionar.

let _saudeAff = { ok: null, verificadoEm: null, erro: null, avisado: false };

export function tokenAffOk() { return !!credencialTsp('ML_AFF_TOKEN'); }
export function saudeAff() { return { ..._saudeAff, configurado: tokenAffOk() }; }

/**
 * O token e o cookie de sessao do ML em base64 (comeca com c3NpZD…, que decodifica
 * para "ssid="). Vai no header Cookie, nao em Authorization — foi por isso que a
 * primeira tentativa deu 404/403.
 */
export function cookieAff() {
  const bruto = (credencialTsp('ML_AFF_TOKEN') || '').trim();
  if (!bruto) return null;
  try {
    const decodificado = Buffer.from(bruto, 'base64').toString('utf-8');
    // So aceita se decodificar em algo com cara de cookie; senao usa como veio.
    if (/^[\w-]+=/.test(decodificado)) return decodificado;
  } catch (e) {}
  return bruto;
}

/** Nomes dos cookies presentes, sem revelar valores. */
export function chavesCookieAff() {
  const c = cookieAff();
  if (!c) return [];
  return c.split(/;\s*/).map(p => p.split('=')[0]).filter(Boolean);
}

/** Chamada crua a um endpoint do painel de afiliados, com o cookie de sessao. */
export async function chamarAff(url, opcoes = {}) {
  const cookie = cookieAff();
  if (!cookie) throw new Error('ML_AFF_TOKEN nao configurado');
  const res = await fetch(url, {
    ...opcoes,
    headers: {
      'Cookie': cookie,
      'Accept': 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      'Accept-Language': 'pt-BR,pt;q=0.9',
      ...(opcoes.headers || {}),
    },
    signal: AbortSignal.timeout(20000),
  });
  const texto = await res.text();
  let corpo; try { corpo = JSON.parse(texto); } catch (e) { corpo = texto.slice(0, 400); }
  return { status: res.status, corpo, ok: res.ok };
}

/**
 * Verifica se o token ainda responde. Chamado no boot e periodicamente.
 * @param {function} aoFalhar  callback para avisar o operador na primeira falha
 */
export async function verificarTokenAff(urlTeste, aoFalhar) {
  if (!tokenAffOk()) {
    _saudeAff = { ok: false, verificadoEm: new Date().toISOString(),
                  erro: 'ML_AFF_TOKEN nao configurado', avisado: _saudeAff.avisado };
    return _saudeAff;
  }
  try {
    const r = await chamarAff(urlTeste);
    const valido = r.ok && r.status !== 401 && r.status !== 403;
    const antes = _saudeAff.ok;
    _saudeAff = {
      ok: valido,
      verificadoEm: new Date().toISOString(),
      erro: valido ? null : ('HTTP ' + r.status),
      // Avisa uma vez por queda; se voltar a funcionar, rearma o aviso.
      avisado: valido ? false : _saudeAff.avisado,
    };
    if (!valido && !_saudeAff.avisado && typeof aoFalhar === 'function') {
      _saudeAff.avisado = true;
      await aoFalhar('HTTP ' + r.status);
    }
    if (valido && antes === false) console.log('[ML-AFF] Token voltou a funcionar.');
    return _saudeAff;
  } catch (e) {
    _saudeAff = { ok: false, verificadoEm: new Date().toISOString(), erro: e.message, avisado: _saudeAff.avisado };
    if (!_saudeAff.avisado && typeof aoFalhar === 'function') {
      _saudeAff.avisado = true;
      await aoFalhar(e.message);
    }
    return _saudeAff;
  }
}

/**
 * Se o token for um JWT, le o payload sem validar assinatura. Responde duas
 * perguntas sem expor o segredo: para qual API ele serve (iss/aud) e se tem
 * prazo de validade (exp).
 */
export function inspecionarTokenAff() {
  const tk = (credencialTsp('ML_AFF_TOKEN') || '').replace(/^Bearer\s+/i, '').trim();
  if (!tk) return { configurado: false };
  const base = { configurado: true, tamanho: tk.length, prefixo: tk.slice(0, 6) + '…', formatoJwt: false };
  const partes = tk.split('.');
  if (partes.length !== 3) {
    return { ...base, observacao: 'cookie de sessao (nao e JWT)',
             cookiesPresentes: chavesCookieAff() };
  }
  try {
    const payload = JSON.parse(Buffer.from(partes[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8'));
    const exp = payload.exp ? new Date(payload.exp * 1000) : null;
    return {
      ...base, formatoJwt: true,
      emissor: payload.iss || null,
      audiencia: payload.aud || null,
      escopos: payload.scope || payload.scopes || null,
      emitidoEm: payload.iat ? new Date(payload.iat * 1000).toISOString() : null,
      expiraEm: exp ? exp.toISOString() : null,
      jaExpirou: exp ? exp.getTime() < Date.now() : null,
      duracaoHoras: (payload.exp && payload.iat) ? Math.round((payload.exp - payload.iat) / 360) / 10 : null,
      campos: Object.keys(payload).sort(),
    };
  } catch (e) { return { ...base, erro: 'falha ao decodificar payload: ' + e.message }; }
}

/** Sonda: chama qualquer caminho da API com o token atual. Diagnostico. */
export async function sondarMl(caminho) {
  const token = await tokenValido();
  const res = await fetch(API + caminho, {
    headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  const texto = await res.text();
  let corpo; try { corpo = JSON.parse(texto); } catch (e) { corpo = texto.slice(0, 300); }
  return { status: res.status, corpo };
}

export async function buscarProdutoMl(id) {
  return apiMl('/items/' + encodeURIComponent(id));
}

export function normalizarMl(it) {
  const preco = Number(it.price);
  const original = Number(it.original_price) || null;
  const desconto = (original && original > preco) ? Math.round((1 - preco / original) * 100) : 0;
  const img = (it.pictures?.[0]?.secure_url) || it.thumbnail || null;

  return {
    asin: it.id, id: it.id,
    titulo: it.title || '',
    marca: (it.attributes || []).find(a => a.id === 'BRAND')?.value_name || '',
    imagemUrl: img,
    link: comTagAfiliado(it.permalink),
    linkOriginal: it.permalink,
    preco: isFinite(preco) ? preco : null,
    precoTexto: isFinite(preco) ? 'R$ ' + preco.toFixed(2).replace('.', ',') : null,
    precoDe: original,
    precoDeFonte: original ? FONTE_API : null,
    precoDeTexto: original ? 'R$ ' + original.toFixed(2).replace('.', ',') : null,
    desconto,
    disponivel: it.status === 'active' && (it.available_quantity ?? 0) > 0,
    vendedor: it.seller_id ? String(it.seller_id) : null,
    vendas: it.sold_quantity ?? null,
    nota: null, avaliacoes: null,
    dealTermina: null, ehDeal: false,
    loja: 'Mercado Livre',
  };
}

// ── PIPELINE ──────────────────────────────────────────────────────────────

import { melhorCupom, melhorCupomAplicavel, cupomPorCodigo, cupomVigente,
         calcularDesconto, templateDaLoja, renderTemplate, varsDoProduto,
         casarCupomDaPagina, registrarCupomBase, comRastreio } from './radar-amazon.js';

// Rastreio identico ao da Amazon: registra o produto no ledger; para esta
// loja a URL sai intacta (parametro extra pode quebrar a atribuicao da rede).
// `rastrear: false` protege previews/simulacoes de sujar o ledger.
export function formatarOfertaMl(p, opcoes = {}) {
  const tpl = opcoes.template || templateDaLoja('Mercado Livre');
  const vars = varsDoProduto(opcoes.rastrear === false ? p : comRastreio(p), opcoes.cupom || null);
  vars.vendas = p.vendas || '';
  vars.codigo_busca = p.codigoBusca || '';
  return renderTemplate(tpl?.corpo || '', vars);
}

/**
 * Links de afiliado de terceiros (meli.la -> /social/{tag}) nao apontam para o
 * produto: abrem o perfil social do divulgador, com o item compartilhado no topo
 * e uma lista de recomendados embaixo. O produto certo esta no botao "Ir para
 * produto" — link literal, sem criptografia.
 *
 * Nao usamos o primeiro MLB do HTML: os primeiros que aparecem sao dos blocos de
 * recomendacao, e pegar qualquer um mandaria o cliente para o produto errado.
 */
export async function produtoDePerfilSocial(urlSocial) {
  const cookie = cookieAff();
  if (!cookie) throw new Error('ML_AFF_TOKEN nao configurado');
  const res = await fetch(urlSocial, {
    headers: {
      'Cookie': cookie,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
      'Accept-Language': 'pt-BR,pt;q=0.9',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error('perfil social respondeu HTTP ' + res.status);
  const html = await res.text();

  // Ancora principal: o titulo declarado pelo proprio ML para a pagina.
  const tituloAlvo = (html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)/i) || [])[1] || null;

  // Ancora mais confiavel: o bloco JSON do CTA "Ir para produto", que traz a
  // URL canonica do item em destaque. Os href do HTML sao o plano B — a pagina
  // lista recomendacoes, e escolher entre elas depende do desempate por titulo.
  const cta = html.match(/"id"\s*:\s*"show_product"[\s\S]{0,400}?"url"\s*:\s*"([^"]+)"/i);
  if (cta) {
    const u = cta[1].replace(/\\u002F/gi, '/').replace(/\\\//g, '/');
    const abs = /^https?:\/\//i.test(u) ? u : 'https://' + u.replace(/^\/+/, '');
    return { url: abs, titulo: tituloAlvo };
  }

  // O link do botao "Ir para produto". Aceita item, catalogo (/p/) e catalogo
  // unificado (/up/MLBU) — este ultimo faltava e derrubava o link inteiro.
  const candidatos = [...html.matchAll(/href=["']([^"']*\/(?:MLB-\d{6,}[^"'?]*|p\/MLB\d{6,}|up\/MLBU\d{6,})[^"']*)["']/gi)]
    .map(m => m[1]);
  if (!candidatos.length) return null;

  // Prefere o candidato cujo slug bate com o og:title — evita pegar um item dos
  // blocos "Quem viu este produto tambem comprou".
  let escolhido = candidatos[0];
  if (tituloAlvo) {
    const chave = tituloAlvo.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const pedacos = chave.split('-').filter(t => t.length > 3);
    let melhorNota = -1;
    for (const c of candidatos) {
      const alvo = c.toLowerCase();
      const nota = pedacos.reduce((n, t) => n + (alvo.includes(t) ? 1 : 0), 0);
      if (nota > melhorNota) { melhorNota = nota; escolhido = c; }
    }
    // Nenhum candidato parecido com o titulo: melhor nao arriscar.
    if (melhorNota <= 0) return null;
  }

  const url = escolhido.startsWith('http') ? escolhido : 'https://www.mercadolivre.com.br' + escolhido;
  return { url: url.split('?')[0], titulo: tituloAlvo };
}

/**
 * URL que vai ao painel de afiliados: sem fragmento e sem query.
 * Link copiado do navegador vem com tracking colado (#position=1&search_layout,
 * ?pdp_filters=...). Nada disso identifica o produto, e o painel responde com a
 * origin_url ja limpa — a chave do mapa deixava de bater e o link "sumia".
 * No radar isso nao aparecia porque os links dos grupos chegam encurtados e o
 * redirect ja entrega a URL canonica.
 */
function urlCanonicaMl(u) {
  try { const x = new URL(u); return x.origin + x.pathname; }
  catch (e) { return String(u).split('#')[0].split('?')[0]; }
}

/**
 * @param {string} texto
 * @param {object} opcoes
 *   leitura=true  para ANTES do createLink e devolve so { produto }, sem link
 *                 de afiliado, sem mensagem e sem cupom.
 *
 * O modo leitura existe para o radar poder alimentar a serie de precos 24h,
 * inclusive fora da janela de disparo do grupo. Parar antes do createLink NAO
 * e economia de requisicao: e obrigatorio. gerarLinksAfiliadoMl GRUDA a
 * etiqueta de nicho no produto na primeira geracao, e ela nao gira depois —
 * o relatorio do ML nao separa resultado por data de disparo. Gerar link numa
 * leitura noturna queimaria a etiqueta de um produto que nao vai ser divulgado,
 * e quando ele voltasse na janela a segmentacao ja estaria perdida.
 */
export async function processarTextoMl(texto, opcoes = {}) {
  // URLs completas, nao so o MLB: o createLink recebe a URL de origem.
  const urls = [...new Set(String(texto || '').match(REGEX_URL_ML) || [])]
    .map(u => u.replace(/[)\]}.,;!]+$/, ''));
  if (!urls.length) return [];

  // Encurtador precisa virar URL canonica antes de ir para o painel.
  const canonicas = [];
  const dicasMlb = new Map();   // url canonica -> MLB do anuncio, quando a URL trazia
  for (const u of urls) {
    let alvo = u;
    if (!idProdutoMl(alvo)) {
      try { alvo = await resolverLinkMl(alvo); }
      catch (e) { console.warn('[ML] Falha ao resolver', u, '-', e.message); continue; }
    }
    // Caiu num perfil social de outro afiliado: extrai o produto do topo.
    if (/\/social\//i.test(alvo)) {
      try {
        const prod = await produtoDePerfilSocial(alvo);
        if (!prod) { console.warn('[ML] Perfil social sem produto identificavel:', u); continue; }
        console.log('[ML] Perfil social -> produto: ' + prod.titulo);
        alvo = prod.url;
      } catch (e) { console.warn('[ML] Falha no perfil social:', e.message); continue; }
    }
    if (idProdutoMl(alvo)) {
      const canon = urlCanonicaMl(alvo);
      canonicas.push(canon);
      // wid/MLB do anuncio some na canonizacao; guardado para o fallback pela API.
      const mlb = idDeUrl(alvo) || idDeUrl(u);
      if (mlb && !dicasMlb.has(canon)) dicasMlb.set(canon, mlb);
    }
    else console.warn('[ML] Sem id de produto apos resolver:', u);
  }
  if (!canonicas.length) return [];

  // Dados do produto ANTES do createLink. A ordem importa: a etiqueta de nicho
  // e escolhida dentro de gerarLinksAfiliadoMl a partir do TITULO, e o link do
  // grupo-fonte chega cru, sem titulo nenhum. Gerando o link primeiro, todo
  // produto do radar caia na etiqueta 'geral' — cadeirinha de bebe e
  // esmerilhadeira inclusive — e a medicao por nicho no ML nunca saia do papel.
  // Nao ha requisicao extra: buscarDadosProdutoMl ja era chamada para cada URL,
  // so que depois. De brinde, a trilha lida aqui alimenta o cache do
  // classificador, entao a classificacao fica melhor do que so pelo titulo.
  const dadosPorUrl = new Map();
  const falhaDados = new Map();
  for (const url of canonicas) {
    try { dadosPorUrl.set(url, await buscarDadosProdutoMl(url, { id: dicasMlb.get(url) || null })); }
    catch (e) { falhaDados.set(url, e.message); }
  }

  const titulos = {};
  for (const [url, d] of dadosPorUrl) if (d?.titulo) titulos[url] = d.titulo;

  // ── MODO LEITURA: para aqui, antes de qualquer link de afiliado. ──
  if (opcoes.leitura) {
    const so = [];
    for (const url of canonicas) {
      const dados = dadosPorUrl.get(url);
      if (!dados || !Number.isFinite(dados.preco)) continue;
      so.push({ produto: {
        asin: idProdutoMl(url), id: idProdutoMl(url),
        titulo: dados.titulo || '', loja: 'Mercado Livre',
        preco: dados.preco, precoDe: dados.precoDe ?? null,
        disponivel: dados.disponivel, link: url, trilha: dados.trilha || null,
      }, leitura: true });
    }
    return so;
  }

  // So quem teve dados lidos vai ao createLink. A geracao GRUDA a etiqueta de
  // nicho no produto (ver gerarLinksAfiliadoMl), entao gerar link para um
  // candidato que vai ser descartado logo depois queima a etiqueta a troco de
  // nada — em 25/08, com o antibot barrando toda pagina, foi um createLink por
  // link capturado, o dia inteiro, sem uma oferta sequer sair.
  const descartes = [];
  for (const url of canonicas) {
    if (dadosPorUrl.has(url)) continue;
    descartes.push({ produto: { loja: 'Mercado Livre', asin: idProdutoMl(url), titulo: url, link: url },
                     descartadoPor: 'dados do produto: ' + (falhaDados.get(url) || 'nao lidos') });
  }
  const legiveis = canonicas.filter(u => dadosPorUrl.has(u));
  if (!legiveis.length) return descartes;

  let links;
  try { links = await gerarLinksAfiliadoMl(legiveis, { titulos }); }
  catch (e) {
    console.error('[ML] createLink falhou:', e.message);
    return [...descartes, ...legiveis.map(u => ({ produto: { loja: 'Mercado Livre', link: u },
                                                 descartadoPor: 'painel de afiliados: ' + e.message }))];
  }

  const saida = [...descartes];
  for (const url of legiveis) {
    const r = links.get(url) || links.get(idDeUrl(url)) || { erro: 'sem resposta do painel' };
    if (r.erro) {
      saida.push({ produto: { loja: 'Mercado Livre', titulo: url, link: url },
                   descartadoPor: r.erro });
      continue;
    }

    const dados = dadosPorUrl.get(url);

    const p = {
      // idProdutoMl, nao idDeUrl: idDeUrl so casa MLB+digitos e devolve null
      // para o catalogo unificado (MLBU). Com o fallback antigo (|| r.link) o
      // asin virava o meli.la curto — 23% das ofertas ML de agosto sairam
      // assim, furando o dedup por produto e sujando o ledger de atribuicoes
      // com refs do tipo 'httpsmelila1oand8j', que o coletor de comissoes nao
      // casa com nada. Sem id de produto e melhor null do que um id falso.
      asin: idProdutoMl(url), id: idProdutoMl(url),
      titulo: dados.titulo || '',
      marca: dados.marca || '',
      imagemUrl: dados.imagem,
      link: r.link,                 // meli.la curto, com atribuicao
      linkLongo: r.linkLongo,
      codigoBusca: r.codigoBusca,   // ex: DAVILE-QLJD
      preco: dados.preco,
      precoTexto: dados.preco ? 'R$ ' + dados.preco.toFixed(2).replace('.', ',') : null,
      precoDe: dados.precoDe,
      precoDeFonte: dados.precoDeFonte || null,
      precoDeTexto: dados.precoDe ? 'R$ ' + dados.precoDe.toFixed(2).replace('.', ',') : null,
      desconto: (dados.precoDe && dados.preco && dados.precoDe > dados.preco)
        ? Math.round((1 - dados.preco / dados.precoDe) * 100) : 0,
      disponivel: dados.disponivel,
      vendedor: dados.vendedor,
      nota: dados.nota, avaliacoes: dados.avaliacoes,
      dealTermina: null, ehDeal: false,
      trilha: dados.trilha || null,
      loja: 'Mercado Livre',
    };

    if (!p.preco)      { saida.push({ produto: p, descartadoPor: 'sem preço na página' }); continue; }
    if (!p.disponivel) { saida.push({ produto: p, descartadoPor: 'produto pausado ou sem estoque' }); continue; }

    // Duas fontes de cupom, nesta ordem:
    //   1. o proprio anuncio — o ML confirmou que o cupom se aplica a ESTE item
    //      e ja declarou quanto economiza. E a unica fonte que enxerga restricao
    //      de categoria e de vendedor.
    //   2. o texto do post — inferencia: o cupom foi citado, mas nada garante
    //      que o item e elegivel.
    // A pagina vence quando casa com a base, porque promete um desconto que o
    // checkout realmente entrega.
    const daPagina = resolverCupomPaginaMl(dados.cuponsPagina, p.preco);
    let cupom = daPagina.cupom;
    if (!cupom) cupom = melhorCupom('Mercado Livre', p.preco, texto);

    if (cupom?.daPagina) {
      console.log('[ML] ' + p.id + ' + cupom do anúncio ' + cupom.codigo +
                  (cupom.ambiguo ? ' (ambíguo)' : '') + ' — R$ ' + cupom.desconto);
    } else if (cupom) {
      console.log('[ML] ' + p.id + ' + cupom ' + cupom.reg.codigo);
    }
    if (daPagina.aviso) {
      console.log('[ML] ' + p.id + ' — ' + daPagina.aviso.motivo + ' (' + daPagina.aviso.percentual + ')');
    }

    saida.push({
      produto: p,
      cupom: cupom
        ? (cupom.daPagina
            ? { codigo: cupom.codigo, desconto: cupom.desconto, citado: true,
                generico: false, daPagina: true, ambiguo: !!cupom.ambiguo,
                semCodigo: !!cupom.semCodigo, segmentado: !!cupom.segmentado,
                naoResgatado: !!cupom.naoResgatado,
                idCampanhaLoja: cupom.idCampanhaLoja, reg: cupom.reg }
            : { codigo: cupom.reg.codigo, desconto: cupom.desconto,
                citado: cupom.citado, generico: !!cupom.generico, daPagina: false })
        : null,
      // Cupom no anuncio sem correspondente na base: o server avisa o operador.
      avisoCupomPagina: daPagina.aviso,
      precoFinal: cupom ? Math.max(0, p.preco - cupom.desconto) : p.preco,
      mensagem: formatarOfertaMl(p, { cupom }),
    });
    await new Promise(r2 => setTimeout(r2, 400));
  }
  return saida;
}


// ── SINCRONIZACAO DE CUPONS ────────────────────────────────────────────────
// A pagina "Meus cupons" do ML lista os cupons ativos da conta com valor,
// minimo, teto e — quando esta perto de acabar — um contador de expiracao.
// E a unica fonte real de validade: melhor que o TTL de 24h, que e chute.

const URL_CUPONS_ML = 'https://www.mercadolivre.com.br/cupons/active';

/**
 * Converte dinheiro escrito no padrao BR para numero.
 * "1.000" -> 1000 | "1.234,56" -> 1234.56 | "9,90" -> 9.9
 * Number() nativo le "1.000" como 1 (ponto = decimal em JS): foi assim que um
 * cupom de 30% com teto de R$ 1.000 entrou na base com teto de R$ 1 e passou a
 * ser anunciado como se nao descontasse nada.
 */
function numeroBr(txt) {
  if (txt === null || txt === undefined) return null;
  const n = Number(String(txt).replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/**
 * Ativa um cupom na conta, como o botao "Inserir codigo" da pagina de cupons.
 * Cupom capturado num grupo so vale nas suas compras depois de ativado.
 */
export async function ativarCupomMl(codigo) {
  const r = await chamarAff('https://www.mercadolivre.com.br/cupons/api/input-code', {
    method: 'POST',
    // A chave e coupon_input_code, capturada do proprio botao "Adicionar cupom".
    // Com "code" o ML responde INVALID_6 para QUALQUER entrada — inclusive para
    // cupom que esta ativo na conta, e ate para corpo vazio. O sync lia essa
    // recusa generica como prova de cupom vencido e desativava cupom bom.
    body: JSON.stringify({ coupon_input_code: String(codigo || '').trim().toUpperCase() }),
    headers: {
      'Origin': 'https://www.mercadolivre.com.br',
      'Referer': 'https://www.mercadolivre.com.br/cupons',
      'x-requested-with': 'XMLHttpRequest',
    },
  });
  const msg = r.corpo?.responseMessage || {};
  const texto = msg.text || '';
  // O texto e traduzido e muda; response_code e estavel e distingue os casos.
  // Todos vem com type:'error', ate o "ja adicionado" — o texto sozinho engana.
  //   PENDING    -> ja esta na conta (o que importa)
  //   SOLD_OUT   -> acabou; nao ha o que ativar
  //   INVALID_1  -> codigo nao existe
  //   INVALID_6  -> o ML nao entendeu o payload: problema nosso, nao do cupom
  //   EXPIRED_ACTION -> venceu, e a mensagem traz data e hora exatas
  const rc = r.corpo?.tracking?.event?.eventData?.response_code || '';
  // HTTP 403 sem response_code e limite de taxa, nao veredito sobre o cupom:
  // ~13 chamadas seguidas derrubam o endpoint, e ate cupom ativo na conta passa
  // a responder "Tivemos um problema". Tratar isso como recusa apagaria a base.
  const bloqueado = r.status === 403 || (!rc && /Tivemos um problema/i.test(texto));
  return {
    codigo,
    rc,
    ok: msg.type === 'success',
    // "ja foi adicionado" nao e falha: o cupom esta ativo, e o que importa.
    jaTinha: rc === 'PENDING' || /já foi adicionad/i.test(texto),
    esgotado: rc === 'SOLD_OUT' || /cupom esgotou/i.test(texto),
    expirado: rc === 'EXPIRED_ACTION',
    // Validade real vinda do proprio ML, com data e hora. Melhor fonte que a
    // pagina: funciona ate para card que esconde o prazo atras de "esgotando".
    venceuEm: rc === 'EXPIRED_ACTION' ? validadeDeVencimento(texto) : null,
    invalido: rc === 'INVALID_1' || (!rc && !bloqueado && /Confira se o cupom/i.test(texto)),
    // Nenhum destes diz nada sobre o cupom — nunca podem virar desativacao.
    payloadRejeitado: rc === 'INVALID_6',
    bloqueado,
    mensagem: texto,
    status: r.status,
  };
}

/** Le a pagina e devolve os cupons ativos do Mercado Livre. */
export async function lerCuponsAtivosMl(url = URL_CUPONS_ML) {
  const cookie = cookieAff();
  if (!cookie) throw new Error('ML_AFF_TOKEN nao configurado');
  const res = await fetch(url, {
    headers: {
      'Cookie': cookie,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
      'Accept-Language': 'pt-BR,pt;q=0.9',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error('pagina de cupons respondeu HTTP ' + res.status);
  const html = await res.text();

  // Trabalha sobre o texto visivel aproximado: as classes do ML mudam com
  // frequencia, mas os rotulos ("Compra minima", "Limite de") sao estaveis.
  const texto = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/\s+/g, ' ');

  // O rotulo varia mais do que parece:
  //   "25% OFF com OFFPARACASA"      -> codigo em minusculo no "com"
  //   "18% OFF COM HORADOCUPOM"      -> "COM" maiusculo
  //   "18% OFF INTERNACIONAL"        -> codigo sem a palavra "com"
  //   "25% OFF em Itens para Casa"   -> SEM codigo: ativa por clique, nao por texto
  // Os dois primeiros formatos dao o codigo direto; o terceiro exige tratar a
  // ultima palavra como codigo; o quarto precisa ser ignorado, senao viraria um
  // cupom fantasma chamado "CASA".
  const re = /Cupom ativado de (?:(\d+)% OFF|R\$\s?([\d.,]+) OFF)\s+([^]{0,60}?)(?=Em produtos|Sem compra|Compra mínima|Cupom ativado de|$)/g;
  const achados = [];
  let semCodigo = 0;
  for (const m of texto.matchAll(re)) {
    const rotulo = (m[3] || '').trim();

    // Sem codigo digitavel: descricao em linguagem natural ("em Itens para Casa").
    // Nao entram na base (nao ha o que digitar), mas contam para conferir se a
    // leitura da pagina veio inteira.
    if (/^(em|para|de)\s/i.test(rotulo) || !rotulo) { semCodigo++; continue; }

    // Com "com"/"COM" o codigo vem depois; sem ele, o rotulo inteiro e o codigo.
    const mCom = rotulo.match(/\bcom\s+(.+)$/i);
    const bruto = (mCom ? mCom[1] : rotulo).trim();
    const codigo = bruto.replace(/\s+/g, '').toUpperCase();
    if (!/^[A-Z0-9]{4,30}$/.test(codigo)) continue;

    // Escopo do card: do rotulo ate o proximo "Cupom ativado de". Uma janela
    // fixa invadiria o card seguinte — foi assim que "Sem compra minima" de um
    // cupom virou minimo 0 em outro.
    const pos = m.index;
    const prox = texto.indexOf('Cupom ativado de', pos + m[0].length);
    const trecho = texto.slice(pos, prox === -1 ? pos + 320 : prox);
    const hhmmss = trecho.match(/Encerra em (\d{1,2}):(\d{2}):(\d{2})/);

    achados.push({
      codigo,
      tipo: m[1] ? 'pct' : 'reais',
      valor: numeroBr(m[1] || m[2]),
      minimo: /Sem compra mínima/i.test(trecho) ? 0
            : (numeroBr((trecho.match(/Compra mínima R\$\s?([\d.,]+)/) || [])[1]) || null),
      limite: numeroBr((trecho.match(/Limite de R\$\s?([\d.,]+)/) || [])[1]) || null,
      expiraEm: hhmmss
        ? new Date(Date.now() + ((+hhmmss[1]) * 3600 + (+hhmmss[2]) * 60 + (+hhmmss[3])) * 1000).toISOString()
        : null,
      venceTexto: (trecho.match(/Vence (?:em )?([^L]{2,24}?)(?=Conferir|Aplicar|Está|$)/) || [])[1]?.trim() || null,
      esgotando: /Está esgotando/.test(trecho),
    });
  }

  const porCodigo = new Map();
  for (const c of achados) {
    const ant = porCodigo.get(c.codigo);
    if (!ant || (c.minimo != null && ant.minimo == null)) porCodigo.set(c.codigo, c);
  }

  const mTotal = texto.match(/(\d+)\s+Cupons/);
  return {
    cupons: [...porCodigo.values()],
    semCodigo,
    totalDeclarado: mTotal ? Number(mTotal[1]) : null,
  };
}

/**
 * A pagina de cupons carrega parte dos cards por JS, entao uma leitura so
 * devolve incompleto. Os filtros da propria pagina servem de paginacao: cada um
 * traz um recorte, e a uniao cobre o total.
 */
const FILTROS_CUPONS_ML = [
  'https://www.mercadolivre.com.br/cupons/active',
  'https://www.mercadolivre.com.br/cupons/filter?about_to_expire=true',
  'https://www.mercadolivre.com.br/cupons/filter?most_used=true',
  'https://www.mercadolivre.com.br/cupons/filter?news=true',
];

export async function lerTodosCuponsMl() {
  const porCodigo = new Map();
  let totalDeclarado = null;
  // Cards sem codigo digitavel nao entram na base, mas contam para saber se a
  // leitura da pagina veio inteira.
  let semCodigo = 0;
  const fontes = [];

  for (const url of FILTROS_CUPONS_ML) {
    try {
      const r = await lerCuponsAtivosMl(url);
      // So a pagina /active declara o total DOS SEUS cupons; as de filtro
      // mostram o contador do catalogo inteiro do ML (milhares), que nao serve
      // de referencia para saber se a leitura veio completa.
      if (url.endsWith('/cupons/active')) {
        if (r.totalDeclarado) totalDeclarado = r.totalDeclarado;
        semCodigo = r.semCodigo || 0;
      }
      for (const c of r.cupons) {
        const ant = porCodigo.get(c.codigo);
        // Mantem a versao mais informativa (com minimo/limite/expiracao).
        if (!ant || (c.minimo != null && ant.minimo == null) || (c.expiraEm && !ant.expiraEm)) {
          porCodigo.set(c.codigo, c);
        }
      }
      fontes.push({ url, lidos: r.cupons.length });
    } catch (e) { fontes.push({ url, erro: e.message }); }
    await new Promise(r => setTimeout(r, 600));
  }
  return { cupons: [...porCodigo.values()], semCodigo, totalDeclarado, fontes };
}


// ── VALIDADE ──────────────────────────────────────────────────────────────
// A pagina informa o vencimento em linguagem natural. Converter em data
// absoluta troca o TTL de 24h (chute) pela validade real do ML.

const DIAS_SEMANA = ['domingo','segunda','terça','quarta','quinta','sexta','sábado'];
const MESES = ['janeiro','fevereiro','março','abril','maio','junho','julho',
               'agosto','setembro','outubro','novembro','dezembro'];

function semAcento(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * "quarta-feira" -> proxima quarta, 23:59 (SP)
 * "1 de setembro" -> 01/09 do ano corrente (ou do proximo, se ja passou)
 * "hoje" / "amanhã" -> obvio
 */
export function validadeDeTexto(txt, agora = new Date()) {
  if (!txt) return null;
  const t = semAcento(txt).trim();

  // Fim do dia no fuso de Sao Paulo (UTC-3), nao no do servidor — o Railway roda
  // em UTC e um cupom expiraria 3h antes do que deveria.
  const fim = (d) => { d.setUTCHours(23 + 3, 59, 0, 0); return d.toISOString(); };

  if (/^hoje/.test(t))   return fim(new Date(agora));
  if (/^amanha/.test(t)) { const d = new Date(agora); d.setDate(d.getDate() + 1); return fim(d); }

  const mData = t.match(/(\d{1,2})\s+de\s+([a-z]+)/);
  if (mData) {
    const mes = MESES.findIndex(m => semAcento(m).startsWith(mData[2].slice(0, 4)));
    if (mes >= 0) {
      const d = new Date(agora.getFullYear(), mes, Number(mData[1]));
      // Data ja passada significa ano que vem.
      if (d.getTime() < agora.getTime() - 86400e3) d.setFullYear(d.getFullYear() + 1);
      return fim(d);
    }
  }

  const idx = DIAS_SEMANA.findIndex(d => t.startsWith(semAcento(d).slice(0, 5)));
  if (idx >= 0) {
    const d = new Date(agora);
    // Mesmo dia da semana significa daqui a 7 dias, nao hoje.
    let delta = (idx - d.getDay() + 7) % 7;
    if (delta === 0) delta = 7;
    d.setDate(d.getDate() + delta);
    return fim(d);
  }
  return null;
}


/**
 * "O cupom venceu em 12 de agosto às 23:59." -> ISO absoluto.
 * Vem do input-code quando o codigo ja passou do prazo. E a unica fonte que da
 * hora exata, entao vale mais que o texto da pagina.
 */
export function validadeDeVencimento(txt) {
  const t = semAcento(txt);
  const m = t.match(/venceu em (\d{1,2}) de ([a-z]+)(?:\s+as\s+(\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const mes = MESES.findIndex(x => semAcento(x).startsWith(m[2].slice(0, 4)));
  if (mes < 0) return null;

  const agora = new Date();
  // Data e hora sao de Sao Paulo (UTC-3) e o servidor roda em UTC.
  const montar = (ano) => new Date(Date.UTC(ano, mes, Number(m[1]),
    Number(m[3] ?? 23) + 3, Number(m[4] ?? 59), 0, 0));

  let d = montar(agora.getUTCFullYear());
  // "Venceu" e sempre passado: data no futuro so pode ser do ano anterior.
  if (d.getTime() > agora.getTime() + 86400e3) d = montar(agora.getUTCFullYear() - 1);
  return d.toISOString();
}


// ── VITRINE — MERCADO LIVRE ───────────────────────────────────────────────
// Mesmo contrato da vitrine da Amazon e da Shopee: no cadastro guardamos so o
// identificador (MLB), o nome e a URL canonica. Preco, estoque e link de
// afiliado sao resolvidos no instante do disparo, porque preco salvo envelhece
// e anunciar preco que nao existe mais e o erro que este pipeline evita.

/** Nome legivel a partir do slug da URL, sem gastar rede no cadastro. */
function nomeDoSlugMl(url) {
  try {
    const caminho = decodeURIComponent(new URL(url).pathname);
    // /espumante-...-750ml/p/MLB18308612   (pagina de catalogo)
    // /MLB-1234567890-nome-do-produto-_JM  (anuncio)
    let m = caminho.match(/^\/([^\/]+)\/p\/MLB/i);
    if (!m) m = caminho.match(/^\/MLB-?\d{6,}-(.+?)(?:-_JM)?\/?$/i);
    if (!m) return '';
    return m[1].replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  } catch (e) { return ''; }
}

/**
 * Resolve uma linha colada pelo operador na vitrine. Aceita "nome | link" ou so
 * o link, em qualquer formato do ML: /p/ de catalogo, /MLB-.../ de anuncio,
 * encurtado (meli.la) ou perfil social de outro afiliado.
 */
export async function resolverLinhaVitrineMl(linha) {
  const bruto = String(linha || '').trim();
  if (!bruto) return null;

  let nomeManual = '', url = bruto;
  const sep = bruto.match(/^(.*?)\s*[|;]\s*(https?:\/\/\S+)$/);
  if (sep) { nomeManual = sep[1].trim(); url = sep[2].trim(); }
  else {
    const m = bruto.match(new RegExp(REGEX_URL_ML.source, 'i'));
    if (!m) return { erro: 'sem link do Mercado Livre', linha: bruto };
    url = m[0].replace(/[)\]}.,;!]+$/, '');
  }

  let alvo = url;
  if (!idDeUrl(alvo)) {
    try { alvo = await resolverEncurtadorMl(alvo); }
    catch (e) { return { erro: 'encurtador nao respondeu: ' + e.message, linha: bruto }; }
  }

  // Link de afiliado de terceiro abre o perfil social do divulgador, nao o
  // produto — o item certo esta no botao "Ir para produto".
  if (/\/social\//i.test(alvo)) {
    try {
      const prod = await produtoDePerfilSocial(alvo);
      if (!prod) return { erro: 'perfil social sem produto identificavel', linha: bruto };
      alvo = prod.url;
      if (!nomeManual && prod.titulo) nomeManual = prod.titulo;
    } catch (e) { return { erro: 'perfil social: ' + e.message, linha: bruto }; }
  }

  const id = idDeUrl(alvo);
  if (!id) return { erro: 'nao foi possivel identificar o produto', linha: bruto };

  // Tracking colado pelo navegador (?pdp_filters, #position) nao identifica o
  // produto e quebra o casamento com a origin_url que o painel devolve.
  const canonica = urlCanonicaMl(alvo);

  // Titulo real da pagina. Se o cookie estiver fora, cai no slug em vez de
  // recusar o cadastro: o disparo tenta de novo e reporta o erro la.
  let titulo = '';
  try { titulo = (await buscarDadosProdutoMl(canonica))?.titulo || ''; }
  catch (e) { console.warn('[ML] Vitrine — sem titulo da pagina:', e.message); }

  // Nome manual que e so o comeco do titulo real e recorte de captura, nao
  // escolha do operador — a extensao corta em ~180 chars. Nesse caso o titulo
  // da pagina vence, senao "...12V Displa" ficaria gravado na base e sairia
  // assim na mensagem. Nome manual de verdade (diferente do inicio do titulo)
  // continua vencendo.
  const recorte = (a, b) => {
    const n = s => String(s || '').toLowerCase().normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
    const x = n(a), y = n(b);
    // Piso de 100 chars: nome curto e escolha do operador, nunca recorte. So
    // titulo longo perto do teto da extensao (~180) entra nesta regra.
    return x.length >= 100 && y.length > x.length && y.startsWith(x.slice(0, 60));
  };
  const nomeBase = recorte(nomeManual, titulo) ? titulo : nomeManual;
  const nome = nomeBase || titulo || nomeDoSlugMl(canonica) || nomeDoSlugMl(url) || ('Produto ' + id);
  return { asin: id, nome, url: canonica, loja: 'Mercado Livre' };
}

const NOME_PROVISORIO_ML = /^Produto MLB\d+$/;

/**
 * Monta as mensagens da vitrine para itens do ML no momento do disparo: gera o
 * link de afiliado, le preco e estoque da pagina agora, aplica o cupom (o
 * informado no disparo vence o vinculado ao produto) e renderiza o template.
 * Nada e enviado aqui — devolve { prontos, descartados }.
 */
export async function montarOfertasMlVitrine(itens, codigoCupom = null) {
  const prontos = [], descartados = [];

  for (const salvo of itens) {
    const bruta = salvo.url || ('https://www.mercadolivre.com.br/p/' + salvo.asin);
    let url = urlCanonicaMl(bruta);

    // Dados ANTES do createLink, pelas mesmas razoes do radar (processarTextoMl):
    // nao queimar etiqueta de nicho em item que vai ser descartado — e porque
    // a leitura resolve o link curto. O asin salvo vai junto: na vitrine ele
    // costuma ser o id de catalogo, que e o que o fallback pela API aceita.
    let dados;
    try { dados = await buscarDadosProdutoMl(bruta, { id: salvo.asin }); }
    catch (e) {
      descartados.push({ asin: salvo.asin, nome: salvo.nome, motivo: 'dados do produto: ' + e.message });
      continue;
    }

    // Link curto (meli.la, /sec/) nao entra no createLink: o painel responde
    // "URL Invalid.". 58 dos 72 itens ML da vitrine estavam assim, e nenhum
    // envio ML por lista aconteceu em agosto por causa disso. Vai a pagina do
    // produto resolvida ou, se a leitura veio da API, a URL canonica do catalogo.
    if (RE_ENCURTADOR_ML.test(url)) {
      if (dados.catalogoId) url = 'https://www.mercadolivre.com.br/p/' + dados.catalogoId;
      else if (dados.urlFinal && idProdutoMl(dados.urlFinal) && !RE_ENCURTADOR_ML.test(dados.urlFinal)) {
        url = urlCanonicaMl(dados.urlFinal);
      }
    }

    let links;
    // O nome salvo na vitrine e o que da a categoria — e por isso que o item
    // cadastrado sai com a etiqueta do nicho e o link cru capturado num grupo
    // (que chega sem titulo) cai no balde geral.
    try { links = await gerarLinksAfiliadoMl([url], { titulos: { [url]: salvo.nome || '' } }); }
    catch (e) {
      descartados.push({ asin: salvo.asin, nome: salvo.nome, motivo: 'painel de afiliados: ' + e.message });
      continue;
    }
    const r = links.get(url) || links.get(salvo.asin) || links.get(idDeUrl(url)) || { erro: 'sem resposta do painel' };
    if (r.erro) { descartados.push({ asin: salvo.asin, nome: salvo.nome, motivo: r.erro }); continue; }

    const p = {
      asin: salvo.asin, id: salvo.asin,
      titulo: dados.titulo || salvo.nome || '',
      marca: dados.marca || '',
      imagemUrl: dados.imagem,
      link: r.link,                 // meli.la curto, com atribuicao
      linkLongo: r.linkLongo,
      codigoBusca: r.codigoBusca,
      preco: dados.preco,
      precoTexto: dados.preco ? 'R$ ' + dados.preco.toFixed(2).replace('.', ',') : null,
      precoDe: dados.precoDe,
      precoDeFonte: dados.precoDeFonte || null,
      precoDeTexto: dados.precoDe ? 'R$ ' + dados.precoDe.toFixed(2).replace('.', ',') : null,
      desconto: (dados.precoDe && dados.preco && dados.precoDe > dados.preco)
        ? Math.round((1 - dados.preco / dados.precoDe) * 100) : 0,
      disponivel: dados.disponivel,
      vendedor: dados.vendedor,
      nota: dados.nota, avaliacoes: dados.avaliacoes,
      vendas: null, dealTermina: null, ehDeal: false,
      trilha: dados.trilha || null,
      loja: 'Mercado Livre',
    };

    let nome = salvo.nome || p.titulo;
    if (NOME_PROVISORIO_ML.test(nome) && p.titulo) nome = p.titulo;

    if (!p.preco)      { descartados.push({ asin: salvo.asin, nome, motivo: 'sem preco na pagina' }); continue; }
    if (!p.disponivel) { descartados.push({ asin: salvo.asin, nome, motivo: 'produto pausado ou sem estoque' }); continue; }

    // Cupom do disparo vence o vinculado; sem nenhum dos dois, entra o do anuncio.
    // 'auto' e escolha automatica, nao ordem: o cupom que o operador vinculou ao
    // produto vence o automatico. Cupom fixo do disparo vence tudo; 'nenhum' sai
    // sem cupom mesmo quando o item tem vinculo.
    const semCupom = codigoCupom === 'nenhum';
    const codigo = semCupom ? null
                 : (codigoCupom && codigoCupom !== 'auto') ? codigoCupom
                 : (salvo.cupom || codigoCupom);
    let cupom = null, avisoCupom = null;

    // O cupom que o proprio anuncio declara. Vale para 'auto' e para o disparo
    // sem cupom escolhido — nos dois casos ninguem nomeou um cupom especifico, e
    // o anuncio e a fonte mais confiavel: o ML ja conferiu categoria, vendedor e
    // teto para ESTE item. Um codigo escolhido a mao pelo operador nao e
    // sobrescrito: ali a decisao e dele.
    const daPagina = (!semCupom && (!codigo || codigo === 'auto'))
      ? resolverCupomPaginaMl(dados.cuponsPagina, p.preco)
      : { cupom: null, aviso: null };

    if (daPagina.cupom) {
      cupom = daPagina.cupom;
    } else if (codigo === 'auto') {
      const m = melhorCupomAplicavel('Mercado Livre', p.preco);
      if (m) cupom = { reg: m.reg, desconto: m.desconto, citado: true };
      else avisoCupom = 'nenhum cupom do Mercado Livre vigente se aplica a este preco';
    } else if (codigo) {
      const reg = cupomPorCodigo('Mercado Livre', codigo);
      if (!reg)                    avisoCupom = 'cupom ' + codigo + ' nao esta na base (Mercado Livre)';
      else if (!cupomVigente(reg)) avisoCupom = 'cupom ' + codigo + ' expirado ou inativo';
      else {
        const desconto = calcularDesconto(reg, p.preco);
        if (desconto > 0) cupom = { reg, desconto, citado: true };
        else avisoCupom = 'cupom ' + codigo + ' nao se aplica a este preco';
      }
    }

    if (!cupom && daPagina.aviso) avisoCupom = daPagina.aviso.motivo +
      ' (' + daPagina.aviso.percentual + ')';

    prontos.push({
      asin: salvo.asin, nome, produto: p,
      cupom: cupom
        ? { codigo: cupom.codigo ?? cupom.reg?.codigo ?? null, desconto: cupom.desconto,
            daPagina: !!cupom.daPagina, semCodigo: !!cupom.semCodigo,
            segmentado: !!cupom.segmentado, naoResgatado: !!cupom.naoResgatado,
            ambiguo: !!cupom.ambiguo, idCampanhaLoja: cupom.idCampanhaLoja || null }
        : null,
      avisoCupom,
      precoFinal: cupom ? Math.max(0, p.preco - cupom.desconto) : p.preco,
      mensagem: formatarOfertaMl(p, { cupom }),
    });
    await new Promise(r2 => setTimeout(r2, 400));
  }
  return { prontos, descartados };
}

// ── DIAGNOSTICO DE CUPOM NA PAGINA DO PRODUTO ─────────────────────────────
// Passo 1 da leitura de cupom no PDP. Aqui nao ha parser nem casamento com a
// base: a funcao so despeja tudo que a pagina fala sobre cupom, para que o
// parser definitivo (extrairCupomMl) seja escrito contra o formato REAL em vez
// de contra um chute sobre nomes de chave.
//
// Tres frentes, porque o ML pode publicar o cupom em qualquer uma delas:
//   1. JSON-LD  — contrato estavel, mas raramente carrega promocao
//   2. estado embutido (__PRELOADED_STATE__ / __NEXT_DATA__) — onde o cupom
//      costuma viver, inclusive com codigo que a tela nao mostra
//   3. DOM/texto — a pilula visivel ("R$ 20 OFF com cupom")
//
// A query string e preservada inteira de proposito: pdp_filters=deal%3A... muda
// o preco exibido, e dropar isso faria o diagnostico ler o preco cheio.

const JANELA_CUPOM = 400;   // chars de contexto ao redor de cada ocorrencia
const MAX_OCORRENCIAS = 40; // teto para a resposta nao virar um dump de 2 MB

function janelasDeTexto(texto, regex, janela = JANELA_CUPOM, max = MAX_OCORRENCIAS) {
  const achados = [];
  const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
  let m;
  while ((m = re.exec(texto)) !== null && achados.length < max) {
    const ini = Math.max(0, m.index - janela);
    const fim = Math.min(texto.length, m.index + m[0].length + janela);
    achados.push({ pos: m.index, trecho: texto.slice(ini, fim) });
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return achados;
}

/**
 * Despeja tudo que a pagina do produto diz sobre cupom.
 * Retorna tambem o preco lido, para conferir se o JSON-LD ja vem com o cupom
 * abatido — se vier, subtrair de novo publicaria um preco inexistente.
 */
export async function dumpCupomMl(url) {
  const cookie = cookieAff();
  if (!cookie) throw new Error('ML_AFF_TOKEN nao configurado');

  let alvo = String(url || '').trim();
  if (!alvo) throw new Error('passe a url do produto');
  try { alvo = await resolverLinkMl(alvo); } catch (e) { /* segue com a original */ }

  const res = await fetch(alvo, {
    headers: {
      'Cookie': cookie,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'pt-BR,pt;q=0.9',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(25000),
  });
  const html = await res.text();

  // Se caiu na tela antibot, todo o resto do dump seria lixo — avisa e para.
  const bloqueado = /suspicious-traffic|Para continuar, confirme que|captcha/i.test(html);

  // ── Frente 1: JSON-LD ───────────────────────────────────────────────────
  const ld = extrairLdProduto(html);
  const oferta = ld?.offers ? (Array.isArray(ld.offers) ? ld.offers[0] : ld.offers) : null;
  const ldBrutos = [];
  for (const m of html.matchAll(REGEX_LD_JSON)) {
    if (/cupom|coupon/i.test(m[1])) ldBrutos.push(m[1].trim().slice(0, 3000));
  }

  // ── Frente 2: estado embutido ───────────────────────────────────────────
  // Nomes de chave que contenham "coupon"/"cupom" revelam o schema sem precisar
  // parsear o estado inteiro, que passa facil de 1 MB.
  const chaves = [...new Set(
    [...html.matchAll(/"([A-Za-z0-9_]*(?:coupon|cupom)[A-Za-z0-9_]*)"\s*:/gi)].map(m => m[1])
  )].slice(0, 60);

  const ocorrenciasJson = janelasDeTexto(html, /"[A-Za-z0-9_]*(?:coupon|cupom)[A-Za-z0-9_]*"\s*:/i);

  // ── Frente 3: texto visivel ─────────────────────────────────────────────
  const textoVisivel = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const ocorrenciasTexto = janelasDeTexto(textoVisivel, /cupom|coupon/i, 200, 20);

  // Percentuais/valores anunciados perto da palavra cupom — o sinal que o
  // casamento por (tipo, valor) vai usar caso o codigo nao apareca.
  const sinais = [...new Set([
    ...[...textoVisivel.matchAll(/(\d{1,2})\s*%\s*(?:OFF|de desconto)[^.]{0,40}cupom/gi)].map(m => m[1] + '%'),
    ...[...textoVisivel.matchAll(/cupom[^.]{0,40}?(\d{1,2})\s*%/gi)].map(m => m[1] + '%'),
    ...[...textoVisivel.matchAll(/R\$\s?([\d.,]+)\s*(?:OFF|de desconto)[^.]{0,40}cupom/gi)].map(m => 'R$ ' + m[1]),
    ...[...textoVisivel.matchAll(/cupom[^.]{0,40}?R\$\s?([\d.,]+)/gi)].map(m => 'R$ ' + m[1]),
  ])];

  return {
    url: alvo,
    id: idDeUrl(alvo),
    httpStatus: res.status,
    bloqueado,
    tamanhoHtml: html.length,
    // Confere a armadilha do preco: se este valor ja estiver com cupom abatido,
    // o parser NAO pode subtrair de novo.
    precoLdJson: Number(oferta?.price ?? oferta?.lowPrice) || null,
    descontoDeclarado: descontoDeclaradoNoHtml(html),
    temPalavraCupom: /cupom|coupon/i.test(html),
    chavesJsonComCupom: chaves,
    sinaisDeValor: sinais,
    jsonLdComCupom: ldBrutos,
    ocorrenciasJson,
    ocorrenciasTexto,
  };
}

// ── CUPOM ANUNCIADO NA PAGINA DO PRODUTO ──────────────────────────────────
// Diagnostico confirmou o formato: o estado embutido traz
//   "coupons":{"coupons":[{ "label":"25% OFF ao comprar. Você economiza R$ 16,5.",
//                           "status":"redeemed", "amount_type":"percentage",
//                           "amount":25, "campaign_id":"14022492",
//                           "type":"APPLIED_COUPON" }]}
// Sem codigo digitavel — so o beneficio e o id da campanha. O JSON-LD nao fala
// de cupom, entao esta e a fonte unica.
//
// Confirmado tambem que o preco do JSON-LD e ANTES do cupom (66 x 25% = 16,50,
// o mesmo valor que o proprio ML declara economizar), logo pode subtrair.

/** Recorta um {...} ou [...] equilibrado a partir de uma posicao, respeitando strings. */
function fatiarJsonBalanceado(texto, inicio) {
  const abre = texto[inicio];
  const fecha = abre === '[' ? ']' : '}';
  let nivel = 0, emString = false, escape = false;
  for (let i = inicio; i < texto.length; i++) {
    const c = texto[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { emString = !emString; continue; }
    if (emString) continue;
    if (c === abre) nivel++;
    else if (c === fecha && --nivel === 0) return texto.slice(inicio, i + 1);
  }
  return null;
}

function normalizarCupomPagina(c) {
  const valor = Number(c?.amount) || 0;
  if (!valor) return null;
  const tipo = String(c.amount_type || '').toLowerCase() === 'percentage' ? 'pct' : 'reais';
  // O ML ja calculou quanto o cupom vale em R$ neste item, aplicando minimo,
  // teto, categoria e vendedor — regras que a base nao consegue modelar.
  const m = String(c.label || '').match(/economiza\s*R\$\s*([\d.]*\d(?:,\d+)?)/i);
  const descontoMl = m ? Number(m[1].replace(/\./g, '').replace(',', '.')) : null;
  return {
    idCampanhaLoja: c.campaign_id ? String(c.campaign_id) : null,
    tipo, valor,
    descontoMl: Number.isFinite(descontoMl) && descontoMl > 0 ? descontoMl : null,
    status: c.status || null,      // 'redeemed' = ja resgatado nesta conta
    tipoMl: c.type || null,
    label: c.label || null,
  };
}

const MARCA_CUPONS_ML = '"coupons":{"coupons":[';

/** Cupons que a pagina do produto anuncia. Lista vazia quando nao ha nenhum. */
export function extrairCupomMl(html) {
  const achados = new Map();
  let i = 0;
  // O estado aparece duas vezes no HTML (SSR + hidratacao); a dedup por
  // campanha+valor resolve sem depender de qual bloco veio primeiro.
  while ((i = html.indexOf(MARCA_CUPONS_ML, i)) !== -1) {
    const bruto = fatiarJsonBalanceado(html, i + MARCA_CUPONS_ML.length - 1);
    i += MARCA_CUPONS_ML.length;
    if (!bruto) continue;
    let lista;
    try { lista = JSON.parse(bruto); } catch (e) { continue; }
    if (!Array.isArray(lista)) continue;
    for (const c of lista) {
      const n = normalizarCupomPagina(c);
      if (!n) continue;
      const k = (n.idCampanhaLoja || '') + '|' + n.tipo + '|' + n.valor;
      if (!achados.has(k)) achados.set(k, n);
    }
  }
  return [...achados.values()];
}

/**
 * Desconto do cupom da pagina, com trava de coerencia.
 *
 * O valor em R$ vem do label ("Você economiza R$ 16,5") e o percentual vem de
 * um campo separado. Quando os dois discordam, o percentual manda: economizar
 * MAIS do que o percentual sobre o preco e impossivel, e publicar isso seria
 * anunciar um preco que o checkout nao entrega. Economizar MENOS e legitimo —
 * e o teto do cupom agindo (cap_amount), entao esse caso passa intacto.
 */
function descontoSeguroMl(c, preco) {
  const tetoPercentual = c.tipo === 'pct' ? (preco * c.valor / 100) : c.valor;
  const bruto = c.descontoMl != null ? Math.min(c.descontoMl, tetoPercentual) : tetoPercentual;
  return Math.min(Math.round(bruto * 100) / 100, preco || 0);
}

function avisoDeCupomMl(p, desconto, motivo, segmentado) {
  return {
    motivo, segmentado,
    percentual: p.tipo === 'pct' ? p.valor + '%' : 'R$ ' + p.valor,
    desconto, idCampanhaLoja: p.idCampanhaLoja, status: p.status, label: p.label,
  };
}

/**
 * Resolve o cupom da pagina contra a base e devolve o que a mensagem precisa.
 * Nunca inventa desconto: quando o ML nao declara o valor em R$, cai para o
 * calculo pelo percentual sobre o preco lido.
 */
export function resolverCupomPaginaMl(cupons, preco) {
  if (!cupons?.length) return { cupom: null, aviso: null };
  // Entre varios, o de maior beneficio em reais.
  const melhorPagina = cupons
    .map(c => ({ c, r: descontoSeguroMl(c, preco) }))
    .sort((a, b) => b.r - a.r)[0];
  const p = melhorPagina.c;
  const desconto = melhorPagina.r;
  if (!(desconto > 0)) return { cupom: null, aviso: null };

  // O proprio PDP diz em que estado o cupom esta:
  //   redeemed   / APPLIED_COUPON            -> ja esta na conta, aplica no checkout
  //   unredeemed / INACTIVE_COUPON_NOT_APPLIED -> disponivel, falta clicar em aplicar
  // 'unredeemed' e resposta direta, nao inferencia: o cupom esta ali para
  // qualquer um que abrir o anuncio resgatar com um clique, sem digitar codigo.
  const naoResgatado = String(p.status || '').toLowerCase() === 'unredeemed'
    || /NOT_APPLIED|INACTIVE_COUPON/i.test(String(p.tipoMl || ''));

  // A campanha lida do sync manda sobre o casamento por valor. Sem essa ordem,
  // um cupom segmentado de 25% casaria com QUALQUER cupom de 25% da base e a
  // oferta sairia com um codigo que nao e o do anuncio.
  const conhecida = campanhaMlConhecida(p.idCampanhaLoja);

  // O estado lido no PROPRIO anuncio vence o que o mapa infere. Um cupom com
  // botao "Aplicar" na pagina esta disponivel para quem abriu o anuncio, mesmo
  // que a varredura de cupons tenha marcado a campanha como segmentada — o
  // anuncio e evidencia direta, o mapa e inferencia.
  if (naoResgatado && !conhecida?.codigo) {
    return {
      cupom: { codigo: null, semCodigo: true, segmentado: false, naoResgatado: true,
               desconto, idCampanhaLoja: p.idCampanhaLoja, daPagina: true,
               ambiguo: false, reg: null },
      aviso: null,
    };
  }

  if (conhecida && !conhecida.codigo) {
    // Campanha sem codigo digitavel: o desconto aparece sozinho na pagina para
    // quem for elegivel. Segmentada ou nao, a oferta e divulgada — suprimir o
    // cupom faria quem TEM acesso perder a oferta por causa de quem nao tem.
    // A diferenca fica no texto: campanha segmentada avisa que pode nao valer
    // para todos, para o membro conferir no anuncio antes de contar com o preco.
    return {
      cupom: { codigo: null, semCodigo: true, segmentado: !!conhecida.segmentado,
               desconto, idCampanhaLoja: p.idCampanhaLoja, daPagina: true,
               ambiguo: false, reg: null },
      aviso: null,
    };
  }

  if (conhecida?.codigo) {
    // Campanha conhecida e com codigo: e ESTE codigo, sem inferencia.
    const reg = cupomPorCodigo('Mercado Livre', conhecida.codigo);
    return {
      cupom: { codigo: conhecida.codigo, desconto, idCampanhaLoja: p.idCampanhaLoja,
               daPagina: true, ambiguo: false, semCodigo: false, reg },
      aviso: null,
    };
  }

  // Campanha desconhecida (o sync ainda nao rodou nesta instancia): cai para o
  // casamento por (tipo, valor) contra a base.
  const casado = casarCupomDaPagina('Mercado Livre', p);
  if (casado.ambiguo) {
    return {
      cupom: { codigo: casado.candidatos.map(r => r.codigo).join(' ou '), desconto,
               idCampanhaLoja: p.idCampanhaLoja, daPagina: true, ambiguo: true,
               semCodigo: false, reg: casado.candidatos[0] },
      aviso: null,
    };
  }
  if (casado.reg) {
    return {
      cupom: { codigo: casado.reg.codigo, desconto, idCampanhaLoja: p.idCampanhaLoja,
               daPagina: true, ambiguo: false, semCodigo: false, reg: casado.reg },
      aviso: null,
    };
  }
  // Campanha que nao aparece em NENHUM dos filtros de cupom da conta. Todo
  // cupom com codigo aplicavel a esta conta passa por /cupons/active, entao uma
  // campanha ausente da varredura inteira nao tem codigo para digitar: e
  // promocao do item ou do vendedor, que aplica sozinha para quem abrir o
  // anuncio. Tratada como aberta.
  //
  // A trava e o mapa estar populado: logo apos um redeploy ele esta vazio e
  // 'desconhecida' nao significa nada, entao ali o comportamento volta a ser o
  // conservador — avisa o operador e a oferta sai pelo preco cheio.
  if (_campanhasMl.size > 0) {
    return {
      cupom: { codigo: null, semCodigo: true, segmentado: false, desconto,
               idCampanhaLoja: p.idCampanhaLoja, daPagina: true, ambiguo: false, reg: null },
      aviso: null,
    };
  }
  return { cupom: null, aviso: avisoDeCupomMl(p, desconto,
    'cupom no anúncio e mapa de campanhas ainda vazio (sync não rodou)', false) };

}

// ── DIAGNOSTICO: campaign_id na pagina de cupons da conta ──────────────────
// Se a pagina /cupons/active publicar o campaign_id ao lado do codigo, o
// vinculo campanha -> codigo deixa de ser aprendido por (tipo, valor) e passa a
// ser exato desde o cadastro, matando a ambiguidade de dois cupons de mesmo
// percentual. Vale checar antes de aceitar o casamento por valor como teto.
export async function dumpCampanhasCupomMl() {
  const cookie = cookieAff();
  if (!cookie) throw new Error('ML_AFF_TOKEN nao configurado');
  const res = await fetch(URL_CUPONS_ML, {
    headers: {
      'Cookie': cookie,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'pt-BR,pt;q=0.9',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(25000),
  });
  const html = await res.text();
  const chaves = [...new Set(
    [...html.matchAll(/"([A-Za-z0-9_]*(?:campaign|campanha)[A-Za-z0-9_]*)"\s*:/gi)].map(m => m[1])
  )].slice(0, 60);
  return {
    httpStatus: res.status,
    bloqueado: /suspicious-traffic|captcha/i.test(html),
    tamanhoHtml: html.length,
    chavesComCampanha: chaves,
    ocorrencias: janelasDeTexto(html, /"[A-Za-z0-9_]*campaign[A-Za-z0-9_]*"\s*:/i, 300, 25),
  };
}

// ── CUPONS DA CONTA PELO BLOCO DE TRACKING ────────────────────────────────
// A pagina /cupons/active monta os cards para exibicao, mas tambem embute um
// payload de analytics em tracking.view.eventData.coupons_list — e esse payload
// e um contrato bem melhor do que os cards: traz o codigo, o campaign_id, o
// minimo, o teto do desconto, o tipo e a expiracao real, tudo tipado.
//
// O campaign_id e a peca que faltava: e a MESMA chave que a pagina do produto
// publica. Com ela, casar o cupom do anuncio com a base deixa de ser inferencia
// por percentual — o que importa porque hoje ha tres cupons de 25% ativos
// (COMPRINHASPRACASA, OFFMELI e MAISCUPONS) e o casamento por valor empataria
// entre os tres.

const MARCA_TRACKING_CUPONS = '"coupons_list":[';

// Codigo digitavel de cupom do ML: alfanumerico, curto, sem separadores
// (OFFMELI, HORADOCUPOM, COMPRINHASPRACASA). As paginas de FILTRO devolvem em
// 'code' um token opaco de resgate — base64 de ~88 chars com '_', '-' e '=' —
// que NAO e digitavel e nao pode ser anunciado como cupom. Sem esta checagem a
// mensagem sairia com o token inteiro no lugar do codigo.
const REGEX_CODIGO_CUPOM_ML = /^[A-Z0-9]{3,25}$/i;

function codigoCupomValidoMl(codigo) {
  const c = String(codigo || '').trim();
  return REGEX_CODIGO_CUPOM_ML.test(c) ? c.toUpperCase() : null;
}

// Campanhas do ML conhecidas, indexadas pelo id que a pagina do produto publica.
// Alimentado pelo sync (que ja roda de hora em hora). A pagina do produto diz
// QUE ha cupom; so a pagina de cupons diz se ele tem codigo e se e segmentado.
// Enquanto o primeiro sync nao roda, o mapa fica vazio e o comportamento e o
// conservador: nao aplica cupom sem codigo, avisa o operador.
const _campanhasMl = new Map();

export function campanhaMlConhecida(id) {
  return id ? (_campanhasMl.get(String(id)) || null) : null;
}
/** Lista o mapa de campanhas, para conferir de fora o que o sync aprendeu. */
export function listarCampanhasMl() {
  return [..._campanhasMl.values()].sort((a, b) =>
    (a.codigo || 'zzz').localeCompare(b.codigo || 'zzz', 'pt-BR'));
}
export function estadoCampanhasMl() {
  return { total: _campanhasMl.size,
           semCodigo: [..._campanhasMl.values()].filter(c => !c.codigo).length,
           segmentadas: [..._campanhasMl.values()].filter(c => c.segmentado).length };
}

/** Cupons da conta, a partir do payload de tracking da pagina de cupons. */
export function extrairCuponsTrackingMl(html) {
  const porCampanha = new Map();
  let i = 0;
  while ((i = html.indexOf(MARCA_TRACKING_CUPONS, i)) !== -1) {
    const bruto = fatiarJsonBalanceado(html, i + MARCA_TRACKING_CUPONS.length - 1);
    i += MARCA_TRACKING_CUPONS.length;
    if (!bruto) continue;
    let lista;
    try { lista = JSON.parse(bruto); } catch (e) { continue; }
    if (!Array.isArray(lista)) continue;
    for (const c of lista) {
      if (!c?.campaign_id) continue;
      const pct = String(c.discount_type || '').toUpperCase() === 'PERCENT';
      const valor = Number(c.discount_value) || 0;
      if (!valor) continue;
      porCampanha.set(String(c.campaign_id), {
        idCampanhaLoja: String(c.campaign_id),
        codigo: codigoCupomValidoMl(c.code),
        titulo: c.title || null,
        tipo: pct ? 'pct' : 'reais',
        valor,
        minimo: Number(c.min_amount) || null,
        // cap_amount e teto do DESCONTO, nao do produto — vai para 'limite'.
        // Em cupom de valor fixo o teto e o proprio valor, entao nao se aplica.
        limite: pct ? (Number(c.cap_amount) || null) : null,
        validadeAte: c.expiration_date || null,
        ativoNoMl: String(c.status_id || '').toUpperCase() === 'ACTIVE',
        // Cupom sem codigo so pode ser anunciado se for campanha ABERTA. Se o
        // ML segmentou por comprador, o membro nao vai ver o mesmo desconto e a
        // oferta viraria reclamacao. 'collectors' e a pista de segmentacao.
        segmentacao: {
          collectors: c.segmentations?.collectors?.length || 0,
          categorias: c.segmentations?.categories?.length || 0,
          containers: c.segmentations?.containers?.length || 0,
          itens: c.item_ids?.length || 0,
        },
        criadoPor: c.created_by || null,
      });
    }
  }
  return [...porCampanha.values()];
}

/**
 * Le os cupons da conta e grava na base com codigo, idCampanhaLoja e regras reais.
 * Cupom sem codigo digitavel (o ML tem campanhas que aplicam sozinhas) nao entra
 * na base: sem codigo nao ha o que passar ao membro. Ele volta em 'semCodigo'
 * para o operador decidir o que fazer.
 */
export async function sincronizarCuponsContaMl() {
  const cookie = cookieAff();
  if (!cookie) throw new Error('ML_AFF_TOKEN nao configurado');

  const buscar = async (url) => {
    const res = await fetch(url, {
      headers: {
        'Cookie': cookie,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(25000),
    });
    const html = await res.text();
    if (/suspicious-traffic|captcha/i.test(html)) throw new Error('pagina de cupons bloqueada (antibot)');
    return html;
  };

  // Duas varreduras com papeis diferentes:
  //   /active — SEUS cupons. Vai para a base, porque e de la que sai o codigo
  //             que o membro digita.
  //   filtros — catalogo mais amplo do ML. NAO vai para a base (encheria de
  //             cupom que nao e seu), mas alimenta o mapa de campanhas: e como
  //             descobrimos se a campanha que o anuncio cita tem codigo ou e
  //             segmentada. O PDP continua sendo o filtro de elegibilidade —
  //             ele so mostra cupom que se aplica a esta conta.
  _campanhasMl.clear();
  const gravados = [], semCodigo = [], inativos = [], fontes = [];

  const registrarNoMapa = (c, ehAtivos) => {
    const anterior = _campanhasMl.get(c.idCampanhaLoja);
    // Um mesmo cupom pode aparecer em varios filtros; fica a versao com codigo.
    if (anterior && anterior.codigo && !c.codigo) return;
    // 'collectors' so significa segmentacao por comprador em /cupons/active, que
    // lista OS SEUS cupons. Nas paginas de filtro o mesmo campo vem preenchido
    // para quase tudo (48 de 70 campanhas) e marcava como segmentada campanha
    // aberta — verificado num cupom que o modal do anuncio oferece a qualquer um.
    // Fora de /active a segmentacao fica indefinida, e indefinido nao e "sim".
    const segmentado = ehAtivos ? (c.segmentacao?.collectors || 0) > 0
                                : (anterior?.segmentado || false);
    _campanhasMl.set(c.idCampanhaLoja, {
      idCampanhaLoja: c.idCampanhaLoja, codigo: c.codigo, titulo: c.titulo,
      tipo: c.tipo, valor: c.valor, minimo: c.minimo, limite: c.limite,
      segmentado, segmentacaoConfirmada: !!ehAtivos || !!anterior?.segmentacaoConfirmada,
      ativoNoMl: c.ativoNoMl,
    });
  };

  for (const url of FILTROS_CUPONS_ML) {
    const ehAtivos = url.endsWith('/cupons/active');
    try {
      const lidos = extrairCuponsTrackingMl(await buscar(url));
      for (const c of lidos) {
        registrarNoMapa(c, ehAtivos);
        if (!ehAtivos) continue;            // filtros so alimentam o mapa
        if (!c.ativoNoMl) { inativos.push(c.idCampanhaLoja); continue; }
        if (!c.codigo)    { semCodigo.push({ idCampanhaLoja: c.idCampanhaLoja, titulo: c.titulo,
                                             tipo: c.tipo, valor: c.valor, minimo: c.minimo,
                                             limite: c.limite, validadeAte: c.validadeAte,
                                             segmentacao: c.segmentacao, criadoPor: c.criadoPor }); continue; }
        const reg = registrarCupomBase({
          loja: 'Mercado Livre', codigo: c.codigo, tipo: c.tipo, valor: c.valor,
          minimo: c.minimo, limite: c.limite, maximo: null,
          validadeAte: c.validadeAte, idCampanhaLoja: c.idCampanhaLoja,
        });
        if (reg) gravados.push({ codigo: reg.codigo, idCampanhaLoja: reg.idCampanhaLoja,
                                 tipo: reg.tipo, valor: reg.valor, minimo: reg.minimo,
                                 limite: reg.limite, validadeAte: reg.validadeAte });
      }
      fontes.push({ url, lidos: lidos.length });
    } catch (e) { fontes.push({ url, erro: e.message }); }
    await new Promise(r => setTimeout(r, 600));
  }

  console.log('[CUPONS-ML] ' + gravados.length + ' gravados, ' + semCodigo.length +
              ' sem codigo, ' + inativos.length + ' inativos, ' +
              _campanhasMl.size + ' campanhas no mapa');
  return { gravados, semCodigo, inativos, fontes, campanhas: estadoCampanhasMl() };
}
