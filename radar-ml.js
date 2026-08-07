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

/** Chamada crua a um endpoint do painel de afiliados, com o token de sessao. */
export async function chamarAff(url, opcoes = {}) {
  const tk = process.env.ML_AFF_TOKEN;
  if (!tk) throw new Error('ML_AFF_TOKEN nao configurado');
  const res = await fetch(url, {
    ...opcoes,
    headers: {
      'Authorization': tk.startsWith('Bearer ') ? tk : 'Bearer ' + tk,
      'Accept': 'application/json',
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
  return renderTemplate(tpl?.corpo || '', vars);
}

export async function processarTextoMl(texto) {
  const ids = await extrairIdsMl(texto);
  if (!ids.length) return [];

  const saida = [];
  for (const id of ids) {
    let it;
    try { it = await buscarProdutoMl(id); }
    catch (e) {
      console.error('[ML] Falha ao consultar ' + id + ':', e.message);
      // Erro de API precisa aparecer no teste, senao o resultado vazio nao
      // distingue "link nao reconhecido" de "consulta rejeitada".
      saida.push({ produto: { id, loja: 'Mercado Livre' }, descartadoPor: 'API: ' + e.message });
      continue;
    }

    const p = normalizarMl(it);
    if (!p.preco)      { saida.push({ produto: p, descartadoPor: 'sem preço disponível' }); continue; }
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
    if (ids.length > 1) await new Promise(r => setTimeout(r, 300));
  }
  return saida;
}
