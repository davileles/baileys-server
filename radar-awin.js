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
import {
  resolverPrecoDe, precoDeDoEstado, precoDeDoDom, descontoDeclaradoNoHtml,
  FONTE_LDJSON, FONTE_ESTADO, FONTE_DOM, FONTE_FEED, FONTE_MANUAL,
} from './preco-de.js';

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
    loja: String(oferta?.advertiser?.name || '').replace(/\s*\(?(BR(\s*&\s*LATAM)?|LATAM|Global)\)?\s*$/i, '').trim(),
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

// ═══════════════════════════════════════════════════════════════════════════
// PIPELINE DE PRODUTO — qualquer anunciante da rede
//
// As quatro lojas grandes tem API de afiliado propria. Os 80+ anunciantes da
// Awin nao tem: o que existe e a pagina publica do produto. Este pipeline le os
// dados estruturados que praticamente todo e-commerce ja publica (JSON-LD
// schema.org, microdata e Open Graph) e monta a oferta com deeplink Awin.
//
// Limite conhecido: parte das lojas bloqueia requisicao vinda de datacenter
// (403). Nesses casos o produto volta identificado, mas sem preco — cabe ao
// operador informar, em vez de a mensagem sair com preco inventado.
// ═══════════════════════════════════════════════════════════════════════════

import {
  templateDaLoja, templateProprioDaLoja, templateAwin,
  renderTemplate, varsDoProduto, melhorCupom,
  melhorCupomAplicavel, cupomPorCodigo, cupomVigente, calcularDesconto,
} from './radar-amazon.js';
import { createHash } from 'crypto';
import { credenciaisFeedOk, buscarProdutoNoFeed } from './awin-feed.js';

const UA_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) '
  + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

// Parametros de campanha de terceiros (Google Ads, Meta, e-mail) nao podem
// viajar dentro do deeplink: alem de sujar o cache, disputam a atribuicao da
// venda com o proprio link de afiliado.
const PARAMS_LIXO = /^(utm_|gad_|gclid|gbraid|wbraid|fbclid|msclkid|epik|irclickid|cmpid|origin|_branch)/i;

export function limparUrlAwin(url) {
  try {
    const u = new URL(String(url));
    for (const k of [...u.searchParams.keys()]) if (PARAMS_LIXO.test(k)) u.searchParams.delete(k);
    u.hash = '';
    return u.toString();
  } catch { return String(url || ''); }
}

function paraNumero(v) {
  if (v === null || v === undefined) return null;
  let s = String(v).replace(/[R$\s]/g, '');
  if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.');
  else if (s.includes(',')) s = s.replace(',', '.');
  const n = Number(s);
  return isFinite(n) && n > 0 ? n : null;
}

function metaConteudo(html, prop) {
  const re = new RegExp('<meta[^>]+(?:property|name)=["\']' + prop + '["\'][^>]+content=["\']([^"\']+)', 'i');
  const m = html.match(re);
  return m ? m[1].trim() : null;
}

/** Varre todos os blocos JSON-LD atras do primeiro objeto do tipo Product. */
function produtoJsonLd(html) {
  for (const bruto of html.match(/<script[^>]*application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi) || []) {
    const corpo = bruto.replace(/^[\s\S]*?>/, '').replace(/<\/script>$/i, '').trim();
    let dado;
    try { dado = JSON.parse(corpo); } catch { continue; }
    const fila = Array.isArray(dado) ? [...dado] : [dado];
    while (fila.length) {
      const it = fila.shift();
      if (!it || typeof it !== 'object') continue;
      if (Array.isArray(it['@graph'])) fila.push(...it['@graph']);
      if (!String(it['@type'] || '').includes('Product')) continue;
      const of = Array.isArray(it.offers) ? it.offers[0] : it.offers;
      return {
        titulo: it.name || null,
        imagem: Array.isArray(it.image) ? it.image[0] : (it.image?.url || it.image || null),
        marca: typeof it.brand === 'object' ? it.brand?.name : it.brand,
        preco: paraNumero(of?.price ?? of?.lowPrice),
        // highPrice de AggregateOffer com varias variacoes e o preco da versao
        // mais cara, nao o preco cheio desta — usar como "De" inventa desconto.
        precoDe: (/AggregateOffer/i.test(String(of?.['@type'] || '')) && Number(of?.offerCount) > 1)
          ? null : paraNumero(of?.highPrice),
        disponivel: of?.availability ? !/OutOfStock|SoldOut/i.test(String(of.availability)) : true,
      };
    }
  }
  return null;
}

/**
 * Dados do produto. A pagina da loja e a fonte primaria — e o preco que o
 * cliente vai ver no checkout. So quando ela nao responde (403 de datacenter) ou
 * nao expoe preco legivel e que entra o product feed, que vem marcado com
 * fonte:'feed' para a mensagem sair como preco de referencia.
 */
export async function extrairProdutoAwin(url, advertiserId = null) {
  const daPagina = await lerPaginaProduto(url);
  if (daPagina.preco) return daPagina;

  if (advertiserId && credenciaisFeedOk()) {
    try {
      const doFeed = await buscarProdutoNoFeed(advertiserId, url);
      if (doFeed?.preco) {
        console.log('[AWIN] Preco de ' + url.slice(0, 60) + ' veio do feed (pagina: '
          + (daPagina.erro || 'sem preco') + ').');
        return { ...doFeed, titulo: doFeed.titulo || daPagina.titulo,
                 imagem: doFeed.imagem || daPagina.imagem };
      }
    } catch (e) { console.log('[AWIN-FEED] Falha na consulta:', e.message); }
  }
  return daPagina;
}

async function lerPaginaProduto(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  let html;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA_MOBILE, 'Accept-Language': 'pt-BR,pt;q=0.9' },
      redirect: 'follow', signal: ctrl.signal,
    });
    if (!res.ok) return { erro: 'a loja respondeu ' + res.status + ' (bloqueio de leitura automatica)' };
    html = await res.text();
  } catch (e) {
    return { erro: 'falha ao abrir a pagina: ' + e.message };
  } finally { clearTimeout(t); }

  const ld = produtoJsonLd(html) || {};
  const titulo = ld.titulo || metaConteudo(html, 'og:title')
    || (html.match(/<title[^>]*>([^<]+)/i)?.[1] || '').trim() || null;
  const imagem = ld.imagem || metaConteudo(html, 'og:image');

  let preco = ld.preco;
  if (!preco) {
    const micro = html.match(/itemprop=["']price["'][^>]*content=["']([\d.,]+)/i)
              || html.match(/content=["']([\d.,]+)["'][^>]*itemprop=["']price["']/i);
    preco = paraNumero(micro?.[1]);
  }
  if (!preco) preco = paraNumero(metaConteudo(html, 'product:price:amount') || metaConteudo(html, 'og:price:amount'));

  // Preco "de" nao tem padrao entre as lojas da rede. A cascata unica tenta o
  // JSON-LD, depois o JSON embutido/microdados e por fim o bloco riscado do
  // DOM, conferindo cada candidata contra o preco atual e contra o percentual
  // que a propria pagina anuncia. Nao achando nada, fica null: melhor sem
  // De/Por do que com um valor chutado.
  const resolvido = resolverPrecoDe({
    preco,
    descontoDeclarado: descontoDeclaradoNoHtml(html),
    rotulo: 'Awin ' + url,
    candidatos: [
      { fonte: FONTE_LDJSON, valor: ld.precoDe ?? null },
      { fonte: FONTE_ESTADO, valor: precoDeDoEstado(html) },
      { fonte: FONTE_DOM,    valor: precoDeDoDom(html) },
    ],
  });

  return { titulo, imagem, preco, precoDe: resolvido.precoDe, precoDeFonte: resolvido.fonte,
           marca: ld.marca || '', disponivel: ld.disponivel !== false };
}

// Ordem de precedencia do layout: template da propria loja (quando o operador
// criou um para ela) -> template 'Awin' -> padrao das ofertas. Antes caia
// direto no padrao, entao nao havia como dar um formato proprio ao que vem da
// rede sem mexer no formato de TODAS as ofertas.
export function formatarOfertaAwin(p, opcoes = {}) {
  const tpl = opcoes.template || templateProprioDaLoja(p.loja) || templateAwin();
  return renderTemplate(tpl?.corpo || '', varsDoProduto(p, opcoes.cupom || null));
}

/**
 * Pipeline completo: texto com link de loja da rede -> oferta pronta.
 * `clickref` viaja ate o relatorio de transacoes da Awin.
 */
export async function processarTextoAwin(texto, { clickref = '' } = {}) {
  const urls = [...new Set(String(texto || '').match(/https?:\/\/[^\s<>"']+/g) || [])]
    .map(u => u.replace(/[)\]}.,;!]+$/, ''));
  const saida = [];
  const vistos = new Set();

  for (const bruta of urls) {
    const prog = programaAwinPorUrl(bruta);
    if (!prog) continue;

    const url = limparUrlAwin(bruta);
    if (vistos.has(url)) continue;
    vistos.add(url);

    const loja = String(prog.name).replace(/\s*\(?(BR(\s*&\s*LATAM)?|LATAM|Global)\)?\s*$/i, '').trim();
    const dados = await extrairProdutoAwin(url, prog.id);

    // Link curto (tidd.ly) primeiro: o cache do gerarLinkAwin evita gastar a
    // quota diaria em reenvio. O aw_deep_link do feed (longo) fica de plano B.
    let link = null;
    try {
      const l = await gerarLinkAwin({ url, advertiserId: prog.id, clickref });
      link = l.shortUrl || l.url;
    } catch (e) {
      link = dados.linkAfiliado || deeplinkAwin(prog.id, url, clickref);
      console.log('[AWIN] Link Builder indisponivel para ' + loja + ': ' + e.message);
    }

    if (dados.erro || !dados.preco) {
      // Loja reconhecida e link ja monetizado: o que falta e so o preco. Volta
      // como descarte com o produto preenchido para o operador completar.
      saida.push({
        produto: { loja, titulo: dados.titulo || null, imagemUrl: dados.imagem || null, link, disponivel: true },
        descartadoPor: dados.erro || 'a pagina nao expoe o preco em formato legivel — informe o preco manualmente',
      });
      continue;
    }

    const p = {
      asin: null,
      codigo: url,
      titulo: dados.titulo || loja,
      preco: dados.preco,
      precoDe: dados.precoDe || null,
      precoDeFonte: dados.precoDeFonte || (dados.fonte === 'feed' ? FONTE_FEED : null),
      precoTexto: 'R$ ' + dados.preco.toFixed(2).replace('.', ','),
      precoDeTexto: dados.precoDe ? 'R$ ' + dados.precoDe.toFixed(2).replace('.', ',') : null,
      desconto: (dados.precoDe && dados.precoDe > dados.preco)
        ? Math.round((1 - dados.preco / dados.precoDe) * 100) : 0,
      disponivel: dados.disponivel,
      link,
      imagemUrl: dados.imagem || null,
      vendedor: null, marca: dados.marca || '', nota: null, avaliacoes: null,
      dealTermina: null, ehDeal: false,
      loja,
      // Preco de feed pode estar algumas horas atras do site.
      precoDeReferencia: dados.fonte === 'feed',
    };

    const cupom = melhorCupom(loja, p.preco, texto);
    saida.push({
      produto: p,
      cupom: cupom ? { codigo: cupom.reg.codigo, desconto: cupom.desconto,
                       citado: cupom.citado, generico: !!cupom.generico } : null,
      precoFinal: cupom ? Math.max(0, p.preco - cupom.desconto) : p.preco,
      precoDeReferencia: dados.fonte === 'feed',
      mensagem: formatarOfertaAwin(p, { cupom }),
    });
  }
  return saida;
}

// ── VITRINE — REDE AWIN ──────────────────────────────────────────────────────
// A vitrine guarda o produto e so consulta o preco na hora do disparo, para
// nunca anunciar valor velho. Aqui isso e possivel na maioria das lojas (a
// pagina e publica), mas nem sempre: quando a loja bloqueia leitura automatica
// o preco informado no cadastro vale por um prazo, como na Magalu.

/** Horas que um preco informado a mao continua valendo. */
let _ttlPrecoHoras = null;
export function definirTtlPrecoAwin(h) {
  const v = Number(h);
  if (isFinite(v) && v > 0) _ttlPrecoHoras = v;
}
export function ttlPrecoAwin() {
  if (_ttlPrecoHoras) return _ttlPrecoHoras;
  const h = Number(process.env.AWIN_PRECO_TTL_H);
  return isFinite(h) && h > 0 ? h : 24;
}

function precosDaLinha(texto) {
  const achados = [...String(texto || '').matchAll(/R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2}|\d+[.,]\d{2})/gi)]
    .map(m => paraNumero(m[1])).filter(Boolean);
  if (!achados.length) return { preco: null, precoDe: null };
  if (achados.length === 1) return { preco: achados[0], precoDe: null };
  const ordenados = [...achados].sort((a, b) => a - b);
  return { preco: ordenados[0], precoDe: ordenados[ordenados.length - 1] };
}

/**
 * Cadastro na vitrine. Aceita "Nome do produto | https://... | R$ 99,90":
 * nome e preco escritos a mao servem de rede de seguranca para as lojas que
 * respondem 403 a leitura automatica.
 */
/**
 * Identificador do produto na vitrine. Precisa ser deterministico e vir de um
 * lugar so: o cadastro por link colado e o cadastro vindo do catalogo tem de
 * gerar a MESMA chave, senao o mesmo produto entra duas vezes na base.
 */
export function chaveVitrineAwin(advertiserId, urlProduto) {
  return 'AWIN-' + advertiserId + '-'
    + createHash('sha1').update(limparUrlAwin(String(urlProduto || ''))).digest('hex').slice(0, 10);
}

export async function resolverLinhaVitrineAwin(linha) {
  const bruto = String(linha || '').trim();
  if (!bruto) return null;

  const m = bruto.match(/https?:\/\/[^\s|;]+/);
  if (!m) return { erro: 'sem link', linha: bruto };
  const urlProduto = limparUrlAwin(m[0].replace(/[)\]}.,;!]+$/, ''));

  const prog = programaAwinPorUrl(urlProduto);
  if (!prog) return { erro: 'loja nao esta entre os anunciantes afiliados da Awin', linha: bruto };
  const loja = String(prog.name).replace(/\s*\(?(BR(\s*&\s*LATAM)?|LATAM|Global)\)?\s*$/i, '').trim();

  const resto = bruto.replace(m[0], ' ');
  const manual = precosDaLinha(resto);
  const nomeManual = resto
    .replace(/R?\$?\s*\d{1,3}(?:\.\d{3})*,\d{2}/gi, ' ')
    .replace(/R\$\s*\d+(?:[.,]\d{2})?/gi, ' ')
    .replace(/[|;]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);

  // Pagina primeiro, feed como plano B.
  const lido = await extrairProdutoAwin(urlProduto, prog.id);

  // Link curto (tidd.ly) primeiro; aw_deep_link do feed de plano B.
  let link = null;
  try {
    const l = await gerarLinkAwin({ url: urlProduto, advertiserId: prog.id });
    link = l.shortUrl || l.url;
  } catch (e) {
    link = lido.linkAfiliado || deeplinkAwin(prog.id, urlProduto);
  }

  const nome = nomeManual || lido.titulo || (loja + ' — produto');
  const preco = lido.preco ?? manual.preco ?? null;

  return {
    asin: chaveVitrineAwin(prog.id, urlProduto),
    nome,
    url: link,
    urlProduto,
    advertiserId: prog.id,
    loja,
    preco,
    precoDe: lido.precoDe ?? manual.precoDe ?? null,
    // Avisa o painel quando o preco veio da linha, nao da loja.
    precoManual: !lido.preco && manual.preco ? true : false,
  };
}

/** Monta as mensagens do disparo, reconsultando o preco quando possivel. */
export async function montarOfertasAwinVitrine(itens, codigoCupom = null) {
  const prontos = [], descartados = [];
  const ttlMs = ttlPrecoAwin() * 3600 * 1000;

  for (const salvo of itens) {
    const loja = salvo.loja || 'Awin';
    const lido = salvo.urlProduto
      ? await extrairProdutoAwin(salvo.urlProduto, salvo.advertiserId)
      : { erro: 'sem url de produto' };

    let preco = lido.preco || null;
    let precoDe = lido.precoDe || null;
    let precoDeReferencia = lido.fonte === 'feed';

    if (!preco) {
      // Leitura falhou: cai para o preco do cadastro, mas so dentro do prazo —
      // anunciar preco vencido e o risco real de uma vitrine.
      if (!salvo.preco) {
        descartados.push({ asin: salvo.asin, nome: salvo.nome,
          motivo: (lido.erro || 'a loja nao expoe o preco') + ' — informe o preco na vitrine' });
        continue;
      }
      const idade = salvo.precoEm ? Date.now() - new Date(salvo.precoEm).getTime() : Infinity;
      if (idade > ttlMs) {
        const horas = isFinite(idade) ? Math.round(idade / 3600000) : null;
        descartados.push({ asin: salvo.asin, nome: salvo.nome,
          motivo: 'preco informado ha ' + (horas != null ? horas + 'h' : 'tempo desconhecido')
                + ' (limite ' + ttlPrecoAwin() + 'h) e a loja bloqueou a releitura — reconfirme antes de disparar' });
        continue;
      }
      preco = Number(salvo.preco);
      precoDe = resolverPrecoDe({
        preco, rotulo: 'Awin ' + (salvo.asin || ''),
        candidatos: [{ fonte: FONTE_MANUAL, valor: salvo.precoDe ?? null }],
      }).precoDe;
      precoDeReferencia = true;
    }

    if (lido.disponivel === false) {
      descartados.push({ asin: salvo.asin, nome: salvo.nome, motivo: 'produto indisponivel na loja' });
      continue;
    }

    const p = {
      asin: salvo.asin,
      codigo: salvo.urlProduto || salvo.asin,
      titulo: salvo.nome || lido.titulo || '',
      preco, precoDe,
      precoDeFonte: lido.precoDeFonte || (precoDeReferencia ? FONTE_MANUAL : null),
      precoTexto: 'R$ ' + preco.toFixed(2).replace('.', ','),
      precoDeTexto: precoDe ? 'R$ ' + precoDe.toFixed(2).replace('.', ',') : null,
      desconto: precoDe && precoDe > preco ? Math.round((1 - preco / precoDe) * 100) : 0,
      disponivel: true,
      link: salvo.url,
      imagemUrl: lido.imagem || null,
      vendedor: null, marca: lido.marca || '', nota: null, avaliacoes: null,
      dealTermina: null, ehDeal: false,
      loja,
      precoDeReferencia,
    };

    const codigo = codigoCupom || salvo.cupom || null;
    let cupom = null, avisoCupom = null;
    if (codigo === 'auto') {
      const mc = melhorCupomAplicavel(loja, preco);
      if (mc) cupom = { reg: mc.reg, desconto: mc.desconto, citado: true };
      else avisoCupom = 'nenhum cupom de ' + loja + ' vigente se aplica a este preco';
    } else if (codigo) {
      const reg = cupomPorCodigo(loja, codigo);
      if (!reg)                    avisoCupom = 'cupom ' + codigo + ' nao esta na base (' + loja + ')';
      else if (!cupomVigente(reg)) avisoCupom = 'cupom ' + codigo + ' expirado ou inativo';
      else {
        const desconto = calcularDesconto(reg, preco);
        if (desconto > 0) cupom = { reg, desconto, citado: true };
        else avisoCupom = 'cupom ' + codigo + ' nao se aplica a este preco';
      }
    }

    prontos.push({
      asin: salvo.asin, nome: salvo.nome || p.titulo, produto: p,
      cupom: cupom ? { codigo: cupom.reg.codigo, desconto: cupom.desconto } : null,
      avisoCupom,
      precoFinal: cupom ? Math.max(0, preco - cupom.desconto) : preco,
      precoDeReferencia,
      mensagem: formatarOfertaAwin(p, { cupom }),
    });
  }
  return { prontos, descartados };
}
