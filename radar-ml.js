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

import { readFileSync, writeFileSync, existsSync } from 'fs';

const SESSAO_DIR = './sessao';
const TOKEN_PATH = SESSAO_DIR + '/ml_token.json';
const API = 'https://api.mercadolibre.com';
const AUTH = 'https://auth.mercadolivre.com.br';

export const ML_REDIRECT_URI =
  process.env.ML_REDIRECT_URI ||
  'https://baileys-server-production-ebfe.up.railway.app/ml/callback';

let _tok = null;   // { access_token, refresh_token, expira_em }

export function credenciaisMlOk() {
  return !!(process.env.ML_CLIENT_ID && process.env.ML_CLIENT_SECRET);
}
export function tagMl() { return process.env.ML_TAG || null; }

function carregarToken() {
  try { if (existsSync(TOKEN_PATH)) _tok = JSON.parse(readFileSync(TOKEN_PATH, 'utf-8')); }
  catch (e) { _tok = null; }
  return _tok;
}
function salvarToken(t) {
  _tok = t;
  try { writeFileSync(TOKEN_PATH, JSON.stringify(t, null, 2), 'utf-8'); }
  catch (e) { console.log('[ML] Erro ao salvar token:', e.message); }
}

export function estadoMl() {
  if (!_tok) carregarToken();
  return {
    credenciais: credenciaisMlOk(),
    tag: tagMl(),
    autorizado: !!_tok?.refresh_token,
    expiraEm: _tok?.expira_em ? new Date(_tok.expira_em).toISOString() : null,
    tokenValido: !!(_tok?.access_token && Date.now() < (_tok.expira_em || 0)),
    redirectUri: ML_REDIRECT_URI,
    diagnostico: {
      ML_CLIENT_ID_presente: !!process.env.ML_CLIENT_ID,
      ML_CLIENT_SECRET_presente: !!process.env.ML_CLIENT_SECRET,
      ML_TAG_presente: !!process.env.ML_TAG,
      variaveis_ml_vistas: Object.keys(process.env).filter(k => /^ML_/.test(k)).sort(),
    },
  };
}

/** URL para o operador autorizar a aplicacao. Uma vez so. */
export function urlAutorizacao(estado = 'cdv') {
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.ML_CLIENT_ID,
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
    refresh_token: d.refresh_token || _tok?.refresh_token || null,
    expira_em: Date.now() + ((d.expires_in || 21600) - 300) * 1000,
    user_id: d.user_id ?? _tok?.user_id ?? null,
  });
  return _tok;
}

/** Troca o 'code' do callback pelo par de tokens. */
export async function trocarCodePorToken(code) {
  return pedirToken({
    grant_type: 'authorization_code',
    client_id: process.env.ML_CLIENT_ID,
    client_secret: process.env.ML_CLIENT_SECRET,
    code,
    redirect_uri: ML_REDIRECT_URI,
  });
}

async function renovar() {
  if (!_tok?.refresh_token) throw new Error('sem refresh_token — autorize em /ml/conectar');
  console.log('[ML] Renovando access_token…');
  return pedirToken({
    grant_type: 'refresh_token',
    client_id: process.env.ML_CLIENT_ID,
    client_secret: process.env.ML_CLIENT_SECRET,
    refresh_token: _tok.refresh_token,
  });
}

async function tokenValido() {
  if (!_tok) carregarToken();
  if (!_tok) throw new Error('não autorizado — acesse /ml/conectar');
  if (Date.now() >= (_tok.expira_em || 0)) await renovar();
  return _tok.access_token;
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
    token = _tok.access_token;
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
    let id = idDeUrl(url);
    if (!id) {
      try { id = idDeUrl(await resolverEncurtadorMl(url)); }
      catch (e) { console.warn('[ML] Falha ao resolver', url, '-', e.message); }
    }
    if (id) ids.add(id); else console.warn('[ML] Sem MLB para', url);
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

function metaConteudo(html, prop) {
  const m = html.match(new RegExp('<meta[^>]+(?:property|name)=["\']' + prop + '["\'][^>]*content=["\']([^"\']+)', 'i'));
  return m ? m[1] : null;
}

/** Busca a pagina do produto com o cookie e extrai o que der. */
export async function buscarDadosProdutoMl(url) {
  const cookie = cookieAff();
  if (!cookie) throw new Error('ML_AFF_TOKEN nao configurado');
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
  if (!res.ok) throw new Error('pagina do produto respondeu HTTP ' + res.status);
  const html = await res.text();

  const ld = extrairLdProduto(html);
  const oferta = ld?.offers
    ? (Array.isArray(ld.offers) ? ld.offers[0] : ld.offers)
    : null;

  const preco = Number(oferta?.price ?? oferta?.lowPrice) || null;
  const titulo = ld?.name || metaConteudo(html, 'og:title') || null;
  const imagem = (Array.isArray(ld?.image) ? ld.image[0] : ld?.image) || metaConteudo(html, 'og:image') || null;

  // O "de" nao vem no JSON-LD; sai do bloco de preco original da pagina.
  const mDe = html.match(/"original_price"\s*:\s*([\d.]+)/) ||
              html.match(/andes-money-amount--previous[\s\S]{0,220}?andes-money-amount__fraction[^>]*>([\d.]+)/);
  let precoDe = mDe ? Number(String(mDe[1]).replace(/\./g, '')) : null;

  // Sanidade: a pagina traz varios blocos de preco (recomendados, parcelamento,
  // outros anuncios) e o regex pode pegar o valor errado. Um "de" so e crivel
  // entre o preco atual e 5x ele — acima disso o desconto sairia absurdo e a
  // mensagem anunciaria algo como "100% de desconto".
  if (precoDe && preco && (precoDe <= preco || precoDe > preco * 5)) {
    if (precoDe > preco * 5) console.warn('[ML] precoDe implausivel (' + precoDe + ' vs ' + preco + ') — descartado');
    precoDe = null;
  }

  const disponivel = !/OutOfStock|Sem estoque|Publicação pausada/i.test(
    (oferta?.availability || '') + html.slice(0, 60000));

  return {
    titulo, preco, precoDe, imagem, disponivel,
    marca: ld?.brand?.name || '',
    nota: Number(ld?.aggregateRating?.ratingValue) || null,
    avaliacoes: Number(ld?.aggregateRating?.reviewCount) || null,
    vendedor: oferta?.seller?.name || null,
    achouLd: !!ld,
  };
}

/**
 * Gera links de afiliado em lote pelo painel. Uma chamada resolve varias URLs.
 * error_code 111 = produto fora do programa (nao e falha nossa).
 */
export async function gerarLinksAfiliadoMl(urls) {
  const tag = tagMl();
  if (!tag) throw new Error('ML_TAG nao configurado');
  const r = await chamarAff('https://www.mercadolivre.com.br/affiliate-program/api/v2/affiliates/createLink', {
    method: 'POST',
    body: JSON.stringify({ urls, tag }),
    headers: {
      'Origin': 'https://www.mercadolivre.com.br',
      'Referer': 'https://www.mercadolivre.com.br/afiliados/linkbuilder',
    },
  });
  if (!r.ok || typeof r.corpo !== 'object') throw new Error('createLink respondeu HTTP ' + r.status);
  const mapa = new Map();
  for (const u of (r.corpo.urls || [])) {
    mapa.set(u.origin_url, u.created
      ? { link: u.short_url, linkLongo: u.long_url, codigoBusca: u.regex }
      : { erro: u.message || ('error_code ' + u.error_code) });
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

export function tokenAffOk() { return !!process.env.ML_AFF_TOKEN; }
export function saudeAff() { return { ..._saudeAff, configurado: tokenAffOk() }; }

/**
 * O token e o cookie de sessao do ML em base64 (comeca com c3NpZD…, que decodifica
 * para "ssid="). Vai no header Cookie, nao em Authorization — foi por isso que a
 * primeira tentativa deu 404/403.
 */
export function cookieAff() {
  const bruto = (process.env.ML_AFF_TOKEN || '').trim();
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
  const tk = (process.env.ML_AFF_TOKEN || '').replace(/^Bearer\s+/i, '').trim();
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

import { melhorCupom, templateDaLoja, renderTemplate, varsDoProduto } from './radar-amazon.js';

export function formatarOfertaMl(p, opcoes = {}) {
  const tpl = opcoes.template || templateDaLoja('Mercado Livre');
  const vars = varsDoProduto(p, opcoes.cupom || null);
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

  // O link do botao "Ir para produto". Aceita as duas formas de URL de item.
  const candidatos = [...html.matchAll(/href=["']([^"']*\/(?:MLB-\d{6,}[^"'?]*|p\/MLB\d{6,})[^"']*)["']/gi)]
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

export async function processarTextoMl(texto) {
  // URLs completas, nao so o MLB: o createLink recebe a URL de origem.
  const urls = [...new Set(String(texto || '').match(REGEX_URL_ML) || [])]
    .map(u => u.replace(/[)\]}.,;!]+$/, ''));
  if (!urls.length) return [];

  // Encurtador precisa virar URL canonica antes de ir para o painel.
  const canonicas = [];
  for (const u of urls) {
    let alvo = u;
    if (!idDeUrl(alvo)) {
      try { alvo = await resolverEncurtadorMl(alvo); }
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
    if (idDeUrl(alvo)) canonicas.push(alvo);
    else console.warn('[ML] Sem MLB apos resolver:', u);
  }
  if (!canonicas.length) return [];

  let links;
  try { links = await gerarLinksAfiliadoMl(canonicas); }
  catch (e) {
    console.error('[ML] createLink falhou:', e.message);
    return canonicas.map(u => ({ produto: { loja: 'Mercado Livre', link: u },
                                 descartadoPor: 'painel de afiliados: ' + e.message }));
  }

  const saida = [];
  for (const url of canonicas) {
    const r = links.get(url) || { erro: 'sem resposta do painel' };
    if (r.erro) {
      saida.push({ produto: { loja: 'Mercado Livre', titulo: url, link: url },
                   descartadoPor: r.erro });
      continue;
    }

    let dados;
    try { dados = await buscarDadosProdutoMl(url); }
    catch (e) {
      saida.push({ produto: { loja: 'Mercado Livre', link: r.link },
                   descartadoPor: 'dados do produto: ' + e.message });
      continue;
    }

    const p = {
      asin: idDeUrl(url) || r.link, id: idDeUrl(url),
      titulo: dados.titulo || '',
      marca: dados.marca || '',
      imagemUrl: dados.imagem,
      link: r.link,                 // meli.la curto, com atribuicao
      linkLongo: r.linkLongo,
      codigoBusca: r.codigoBusca,   // ex: DAVILE-QLJD
      preco: dados.preco,
      precoTexto: dados.preco ? 'R$ ' + dados.preco.toFixed(2).replace('.', ',') : null,
      precoDe: dados.precoDe,
      precoDeTexto: dados.precoDe ? 'R$ ' + dados.precoDe.toFixed(2).replace('.', ',') : null,
      desconto: (dados.precoDe && dados.preco && dados.precoDe > dados.preco)
        ? Math.round((1 - dados.preco / dados.precoDe) * 100) : 0,
      disponivel: dados.disponivel,
      vendedor: dados.vendedor,
      nota: dados.nota, avaliacoes: dados.avaliacoes,
      dealTermina: null, ehDeal: false,
      loja: 'Mercado Livre',
    };

    if (!p.preco)      { saida.push({ produto: p, descartadoPor: 'sem preço na página' }); continue; }
    if (!p.disponivel) { saida.push({ produto: p, descartadoPor: 'produto pausado ou sem estoque' }); continue; }

    const cupom = melhorCupom('Mercado Livre', p.preco, texto);
    if (cupom) console.log('[ML] ' + p.id + ' + cupom ' + cupom.reg.codigo);

    saida.push({
      produto: p,
      cupom: cupom ? { codigo: cupom.reg.codigo, desconto: cupom.desconto,
                       citado: cupom.citado, generico: !!cupom.generico } : null,
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

/** Le a pagina e devolve os cupons ativos do Mercado Livre. */
export async function lerCuponsAtivosMl() {
  const cookie = cookieAff();
  if (!cookie) throw new Error('ML_AFF_TOKEN nao configurado');
  const res = await fetch(URL_CUPONS_ML, {
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

  const re = /Cupom ativado de (?:(\d+)% OFF|R\$\s?([\d.,]+) OFF) com ([A-Z0-9]{4,25})(.{0,260}?)(?=Cupom ativado de |$)/g;
  const achados = [];
  for (const m of texto.matchAll(re)) {
    const trecho = m[4] || '';
    const hhmmss = (trecho.match(/Encerra em (\d{1,2}):(\d{2}):(\d{2})/) || null);
    achados.push({
      codigo: m[3],
      tipo: m[1] ? 'pct' : 'reais',
      valor: Number(String(m[1] || m[2]).replace(/\./g, '').replace(',', '.')),
      minimo: Number((trecho.match(/Compra mínima R\$\s?([\d.]+)/) || [])[1]) || null,
      limite: Number((trecho.match(/Limite de R\$\s?([\d.]+)/) || [])[1]) || null,
      // Contador -> validade absoluta. So aparece nas ultimas horas.
      expiraEm: hhmmss
        ? new Date(Date.now() + ((+hhmmss[1]) * 3600 + (+hhmmss[2]) * 60 + (+hhmmss[3])) * 1000).toISOString()
        : null,
      esgotando: /Está esgotando/.test(trecho),
    });
  }
  // A pagina repete o cupom no cabecalho do card: fica com a ocorrencia que
  // tem minimo/limite preenchidos.
  const porCodigo = new Map();
  for (const c of achados) {
    const ant = porCodigo.get(c.codigo);
    if (!ant || (c.minimo != null && ant.minimo == null)) porCodigo.set(c.codigo, c);
  }
  return [...porCodigo.values()];
}
