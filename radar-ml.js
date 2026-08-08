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
    const valor = u.created
      ? { link: u.short_url, linkLongo: u.long_url, codigoBusca: u.regex }
      : { erro: u.message || ('error_code ' + u.error_code) };
    mapa.set(u.origin_url, valor);
    // Indexa tambem pelo MLB: o painel pode devolver a origin_url normalizada
    // (barra final, maiusculas, parametro a mais) e o casamento por string
    // exata falharia em silencio, virando 'sem resposta do painel'.
    const id = idDeUrl(u.origin_url);
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
    if (idDeUrl(alvo)) canonicas.push(urlCanonicaMl(alvo));
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
    const r = links.get(url) || links.get(idDeUrl(url)) || { erro: 'sem resposta do painel' };
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

/**
 * Ativa um cupom na conta, como o botao "Inserir codigo" da pagina de cupons.
 * Cupom capturado num grupo so vale nas suas compras depois de ativado.
 */
export async function ativarCupomMl(codigo) {
  const r = await chamarAff('https://www.mercadolivre.com.br/cupons/api/input-code', {
    method: 'POST',
    body: JSON.stringify({ code: String(codigo || '').trim().toUpperCase() }),
    headers: {
      'Origin': 'https://www.mercadolivre.com.br',
      'Referer': 'https://www.mercadolivre.com.br/cupons',
      'x-requested-with': 'XMLHttpRequest',
    },
  });
  const msg = r.corpo?.responseMessage || {};
  const texto = msg.text || '';
  return {
    codigo,
    ok: msg.type === 'success',
    // "ja foi adicionado" nao e falha: o cupom esta ativo, e o que importa.
    jaTinha: /já foi adicionad/i.test(texto),
    invalido: /Confira se o cupom/i.test(texto),
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
      valor: Number(String(m[1] || m[2]).replace(/\./g, '').replace(',', '.')),
      minimo: /Sem compra mínima/i.test(trecho) ? 0
            : (Number((trecho.match(/Compra mínima R\$\s?([\d.]+)/) || [])[1]) || null),
      limite: Number((trecho.match(/Limite de R\$\s?([\d.]+)/) || [])[1]) || null,
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
