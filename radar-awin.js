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
  templateDaLoja, renderTemplate, varsDoProduto, melhorCupom,
} from './radar-amazon.js';

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
        precoDe: paraNumero(of?.highPrice),
        disponivel: of?.availability ? !/OutOfStock|SoldOut/i.test(String(of.availability)) : true,
      };
    }
  }
  return null;
}

/** Le a pagina do produto e devolve o que conseguiu extrair (nunca inventa). */
export async function extrairProdutoAwin(url) {
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

  // Preco "de" nao tem padrao entre as lojas. Tenta os nomes mais comuns e,
  // nao achando, fica null: melhor sem De/Por do que com um valor chutado.
  let precoDe = ld.precoDe;
  if (!precoDe) {
    for (const re of [
      /["'](?:listPrice|oldPrice|originalPrice|priceFrom|regularPrice|specialPrice)["']\s*:\s*["']?([\d.,]+)/i,
      /itemprop=["'](?:listPrice|highPrice)["'][^>]*content=["']([\d.,]+)/i,
      /data-field=["']specialPrice["'][^>]*>\s*R\$\s*([\d.,]+)/i,
    ]) { const m = html.match(re); if (m) { precoDe = paraNumero(m[1]); break; } }
  }
  if (precoDe && preco && precoDe <= preco) precoDe = null;

  return { titulo, imagem, preco, precoDe, marca: ld.marca || '', disponivel: ld.disponivel !== false };
}

export function formatarOfertaAwin(p, opcoes = {}) {
  const tpl = opcoes.template || templateDaLoja(p.loja) || templateDaLoja('Amazon');
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

    const loja = String(prog.name).replace(/\s*\(?(BR|Global)\)?\s*$/i, '').trim();
    const dados = await extrairProdutoAwin(url);

    let link = null;
    try {
      const l = await gerarLinkAwin({ url, advertiserId: prog.id, clickref });
      link = l.shortUrl || l.url;
    } catch (e) {
      link = deeplinkAwin(prog.id, url, clickref);
      console.log('[AWIN] Deeplink manual para ' + loja + ': ' + e.message);
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
    };

    const cupom = melhorCupom(loja, p.preco, texto);
    saida.push({
      produto: p,
      cupom: cupom ? { codigo: cupom.reg.codigo, desconto: cupom.desconto,
                       citado: cupom.citado, generico: !!cupom.generico } : null,
      precoFinal: cupom ? Math.max(0, p.preco - cupom.desconto) : p.preco,
      mensagem: formatarOfertaAwin(p, { cupom }),
    });
  }
  return saida;
}
