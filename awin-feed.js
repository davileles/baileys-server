// ═══════════════════════════════════════════════════════════════════════════
// awin-feed.js — Product Feeds da Awin.
//
// Existe para cobrir o furo do radar-awin.js: parte das lojas responde 403 a
// leitura automatica da pagina (Centauro, entre outras), e sem preco nao ha
// oferta. O feed traz preco, titulo, imagem, estoque e o link de afiliado ja
// pronto (aw_deep_link) — sem scraping e sem gastar quota do Link Builder.
//
// Credencial: AWIN_FEED_APIKEY. E DIFERENTE do AWIN_TOKEN da API — sai em
// Toolbox > Create-a-Feed, na caixa "Feed List Download".
//
// Precedencia: a pagina da loja continua sendo a fonte primaria, porque e o
// preco que o cliente vai ver no checkout. O feed e o plano B, e o que sai
// dele vem marcado como preco de referencia.
// ═══════════════════════════════════════════════════════════════════════════

import { createGunzip } from 'zlib';
import { Readable } from 'stream';
import { createInterface } from 'readline';
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync, readFileSync, writeFileSync } from 'fs';
import { pipeline } from 'stream/promises';

const PASTA_FEEDS = './sessao/feeds';
const LISTA_PATH  = './sessao/awin_feedlist.json';

// Colunas pedidas no download. Feed que nao mapeia alguma devolve a coluna
// vazia em vez de erro, entao da para pedir o conjunto todo sempre.
const COLUNAS = [
  'aw_deep_link', 'aw_image_url', 'merchant_product_id', 'product_name',
  'merchant_deep_link', 'search_price', 'product_price_old', 'store_price',
  'rrp_price', 'base_price', 'in_stock', 'brand_name',
];

let _lista = [];          // feeds ativos
let _listaEm = 0;
let _porAnunciante = new Map();  // advertiserId -> [feeds]

export function credenciaisFeedOk() { return !!process.env.AWIN_FEED_APIKEY; }

function apikey()      { return String(process.env.AWIN_FEED_APIKEY || '').trim(); }
function publisherId() { return String(process.env.AWIN_PUBLISHER_ID || '').trim(); }
// TTL vem da config do painel quando definido; a env fica como valor inicial.
let _ttlFeedHoras = null;
export function definirTtlFeedHoras(h) {
  const v = Number(h);
  if (isFinite(v) && v > 0) _ttlFeedHoras = v;
}
function ttlFeedMs() {
  if (_ttlFeedHoras) return _ttlFeedHoras * 3600 * 1000;
  const h = Number(process.env.AWIN_FEED_TTL_H);
  return (isFinite(h) && h > 0 ? h : 12) * 3600 * 1000;
}

function urlFeedList() {
  return 'https://ui.awin.com/productdata-darwin-download/publisher/'
    + publisherId() + '/' + apikey() + '/1/feedList';
}

function urlDownload(fid) {
  return 'https://productdata.awin.com/datafeed/download/apikey/' + apikey()
    + '/fid/' + fid + '/format/csv/language/pt/delimiter/%2C/compression/gzip/columns/'
    + COLUNAS.join('%2C') + '/';
}

// ── CSV ──────────────────────────────────────────────────────────────────────
// Parser proprio em vez de dependencia: o feed vem com virgula dentro de campo
// entre aspas ("Camiseta Nike, Preta") e split(',') quebraria a linha inteira.
function partirLinhaCsv(linha) {
  const campos = [];
  let atual = '', dentroDeAspas = false;
  for (let i = 0; i < linha.length; i++) {
    const c = linha[i];
    if (c === '"') {
      if (dentroDeAspas && linha[i + 1] === '"') { atual += '"'; i++; }
      else dentroDeAspas = !dentroDeAspas;
    } else if (c === ',' && !dentroDeAspas) { campos.push(atual); atual = ''; }
    else atual += c;
  }
  campos.push(atual);
  return campos;
}

// Os feeds misturam "144.99" e "144.99 BRL" na mesma coluna — sem tirar o
// sufixo, Number() devolve NaN e o produto some do resultado.
export function paraNumero(v) {
  if (!v) return null;
  const n = Number(String(v).replace(/[^\d.,-]/g, '').replace(',', '.'));
  return isFinite(n) && n > 0 ? n : null;
}

// ── LISTA DE FEEDS ───────────────────────────────────────────────────────────
export function carregarFeedListDoDisco() {
  try {
    if (existsSync(LISTA_PATH)) {
      const b = JSON.parse(readFileSync(LISTA_PATH, 'utf-8'));
      _lista = b.feeds || []; _listaEm = b.em || 0;
      indexar();
      console.log('[AWIN-FEED] Lista carregada — ' + _lista.length + ' feed(s) ativo(s).');
    }
  } catch (e) { console.log('[AWIN-FEED] Erro ao ler lista:', e.message); }
  return _lista;
}

function indexar() {
  _porAnunciante = new Map();
  for (const f of _lista) {
    if (!_porAnunciante.has(f.advertiserId)) _porAnunciante.set(f.advertiserId, []);
    _porAnunciante.get(f.advertiserId).push(f);
  }
  // Feed com mais produtos primeiro: e o que tem mais chance de conter o item.
  for (const arr of _porAnunciante.values()) arr.sort((a, b) => b.produtos - a.produtos);
}

export async function atualizarFeedList(forcar = false) {
  if (!credenciaisFeedOk()) return [];
  if (!forcar && _lista.length && Date.now() - _listaEm < 24 * 3600 * 1000) return _lista;

  const res = await fetch(urlFeedList(), { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error('feedList respondeu ' + res.status);
  const texto = await res.text();

  const linhas = texto.split('\n').filter(l => l.trim());
  const cab = partirLinhaCsv(linhas[0]).map(c => c.trim());
  const idx = n => cab.indexOf(n);
  const novos = [];
  for (const l of linhas.slice(1)) {
    const c = partirLinhaCsv(l);
    // "Not Joined" e feed de anunciante sem parceria: usar geraria link sem
    // comissao, entao nao entra no indice.
    if (String(c[idx('Membership Status')] || '').toLowerCase() !== 'active') continue;
    novos.push({
      advertiserId: Number(c[idx('Advertiser ID')]),
      anunciante: c[idx('Advertiser Name')],
      regiao: c[idx('Primary Region')],
      fid: String(c[idx('Feed ID')]).replace(/^F/i, ''),
      produtos: Number(c[idx('No of products')]) || 0,
      atualizadoEm: c[idx('Last Imported')] || null,
    });
  }
  _lista = novos; _listaEm = Date.now();
  indexar();
  try {
    if (!existsSync('./sessao')) mkdirSync('./sessao', { recursive: true });
    writeFileSync(LISTA_PATH, JSON.stringify({ em: _listaEm, feeds: _lista }));
  } catch (e) { console.log('[AWIN-FEED] Falha ao gravar lista:', e.message); }
  console.log('[AWIN-FEED] Lista atualizada — ' + _lista.length + ' feed(s) ativo(s).');
  return _lista;
}

export function listarAnunciantesComFeed() {
  return [..._porAnunciante.keys()];
}

export function feedsDoAnunciante(advertiserId) {
  return _porAnunciante.get(Number(advertiserId)) || [];
}

export function estadoFeed() {
  return {
    configurado: credenciaisFeedOk(),
    feeds: _lista.length,
    anunciantes: _porAnunciante.size,
    atualizadoEm: _listaEm ? new Date(_listaEm).toISOString() : null,
    ttlHoras: ttlFeedMs() / 3600000,
  };
}

// ── DOWNLOAD COM CACHE ───────────────────────────────────────────────────────
async function garantirFeedEmDisco(fid) {
  if (!existsSync(PASTA_FEEDS)) mkdirSync(PASTA_FEEDS, { recursive: true });
  const caminho = PASTA_FEEDS + '/F' + fid + '.csv.gz';
  try {
    const st = statSync(caminho);
    if (Date.now() - st.mtimeMs < ttlFeedMs()) return caminho;
  } catch {}

  const res = await fetch(urlDownload(fid), { signal: AbortSignal.timeout(300000) });
  if (!res.ok) throw new Error('download do feed ' + fid + ' respondeu ' + res.status);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(caminho));
  console.log('[AWIN-FEED] Feed ' + fid + ' baixado (' + Math.round(statSync(caminho).size / 1024) + ' KB).');
  return caminho;
}

/**
 * Identificadores que podem casar a URL colada com a linha do feed. A URL da
 * loja no feed nem sempre e byte a byte igual a que o operador colou (query,
 * variante de cor), entao o caminho e o codigo do produto valem mais que a
 * string inteira.
 */
function chavesDaUrl(url) {
  const chaves = new Set();
  try {
    const u = new URL(url);
    const caminho = u.pathname.replace(/\/+$/, '');
    if (caminho.length > 3) chaves.add(caminho.toLowerCase());
    // Codigos de 6+ digitos: identificador de produto na maioria das lojas.
    for (const m of caminho.matchAll(/(\d{6,})/g)) chaves.add(m[1]);
  } catch {}
  return [...chaves];
}

// ── BUSCA ────────────────────────────────────────────────────────────────────
/**
 * Varre os feeds do anunciante procurando o produto. Le linha a linha e para no
 * primeiro acerto: um feed de 300 mil produtos nao cabe em memoria no Railway.
 */
export async function buscarProdutoNoFeed(advertiserId, urlProduto) {
  if (!credenciaisFeedOk()) return null;
  const feeds = feedsDoAnunciante(advertiserId);
  if (!feeds.length) return null;

  const chaves = chavesDaUrl(urlProduto);
  if (!chaves.length) return null;

  for (const feed of feeds.slice(0, 3)) {   // 3 feeds por anunciante ja e bastante
    let caminho;
    try { caminho = await garantirFeedEmDisco(feed.fid); }
    catch (e) { console.log('[AWIN-FEED] ' + e.message); continue; }

    const rl = createInterface({
      input: createReadStream(caminho).pipe(createGunzip()),
      crlfDelay: Infinity,
    });

    let cab = null, achado = null;
    try {
      for await (const linha of rl) {
        if (!linha.trim()) continue;
        if (!cab) { cab = partirLinhaCsv(linha).map(c => c.trim()); continue; }
        const minuscula = linha.toLowerCase();
        if (!chaves.some(k => minuscula.includes(k))) continue;
        const campos = partirLinhaCsv(linha);
        const linhaObj = {};
        cab.forEach((c, i) => { linhaObj[c] = campos[i] ?? ''; });
        // Confirma no campo certo: a chave pode ter batido na descricao.
        const destino = String(linhaObj.merchant_deep_link || '').toLowerCase();
        if (!chaves.some(k => destino.includes(k))) continue;
        achado = linhaObj;
        break;
      }
    } finally { rl.close(); }

    if (achado) return normalizarLinhaFeed(achado, feed);
  }
  return null;
}

/**
 * Traduz a linha do feed para o formato de produto do TSP.
 *
 * Preco e a parte delicada: a Awin nao impoe semantica igual para todo mundo.
 *
 * Quando a loja preenche 'product_price_old' (30 dos 62 feeds BR), a leitura e
 * direta: 'search_price' e o preco atual e 'product_price_old' o de lista.
 *
 * Sem esse campo, sobra adivinhar — e ha loja (Centauro) em que 'search_price'
 * e o preco de LISTA e o promocional vai em 'base_price', invertendo a
 * convencao. Nesse caso pega o menor como "por" e o maior como "de", que
 * acerta nos dois arranjos. A protecao contra preco unitario (R$/kg em
 * mercado) e a razao minima: diferenca acima de 70% e descartada em vez de
 * virar uma oferta boa demais para ser verdade.
 */
export function normalizarLinhaFeed(l, feed) {
  const atual  = paraNumero(l.search_price);
  const antigo = paraNumero(l.product_price_old);

  let preco = null, precoDe = null;
  if (atual && antigo) {
    preco   = Math.min(atual, antigo);
    precoDe = Math.max(atual, antigo) > preco ? Math.max(atual, antigo) : null;
  } else {
    const candidatos = [
      atual, paraNumero(l.store_price), paraNumero(l.rrp_price), paraNumero(l.base_price),
    ].filter(Boolean);
    if (!candidatos.length) return null;
    const menor = Math.min(...candidatos);
    const maior = Math.max(...candidatos);
    preco   = menor;
    precoDe = (maior > menor && menor / maior >= 0.3) ? maior : null;
  }
  if (!preco) return null;

  return {
    titulo: l.product_name || null,
    imagem: l.aw_image_url || null,
    preco,
    precoDe,
    desconto: precoDe ? Math.round((1 - preco / precoDe) * 100) : 0,
    marca: l.brand_name || '',
    // in_stock vazio nao e o mesmo que zero: so o "0" explicito significa fora
    // de estoque, senao produto de feed sem a coluna seria sempre descartado.
    disponivel: String(l.in_stock).trim() === '0' ? false : true,
    linkAfiliado: l.aw_deep_link || null,
    urlLoja: l.merchant_deep_link || null,
    codigoLoja: l.merchant_product_id || null,
    fonte: 'feed',
    feedId: feed?.fid || null,
    feedAtualizadoEm: feed?.atualizadoEm || null,
  };
}

/**
 * Varre um feed inteiro atras de produtos com desconto, ja deduplicados.
 *
 * Loja de moda repete a MESMA peca uma vez por tamanho e cor — o feed da Dafiti
 * tem 308 mil linhas para um catalogo muito menor. Sem deduplicar por nome e
 * preco, uma unica camiseta viraria seis ofertas identicas no grupo.
 */
export async function varrerFeedComDesconto(advertiserId, {
  minPct = 60, minPreco = 100, maxPreco = null, limite = 200,
} = {}) {
  const feeds = feedsDoAnunciante(advertiserId);
  if (!feeds.length) return [];
  const feed = feeds[0];

  let caminho;
  try { caminho = await garantirFeedEmDisco(feed.fid); }
  catch (e) { console.log('[AWIN-FEED] ' + e.message); return []; }

  const rl = createInterface({ input: createReadStream(caminho).pipe(createGunzip()), crlfDelay: Infinity });
  const vistos = new Set();
  const achados = [];
  let cab = null;

  try {
    for await (const linha of rl) {
      if (!linha.trim()) continue;
      if (!cab) { cab = partirLinhaCsv(linha).map(c => c.trim()); continue; }
      const campos = partirLinhaCsv(linha);
      const o = {}; cab.forEach((c, i) => { o[c] = campos[i] ?? ''; });
      if (String(o.in_stock).trim() === '0') continue;

      const p = normalizarLinhaFeed(o, feed);
      if (!p || !p.precoDe || p.desconto < minPct) continue;
      if (p.preco < minPreco) continue;
      if (maxPreco && p.preco > maxPreco) continue;

      // Alem de tamanho, a mesma peca aparece uma vez por COR ("Tenis Colcci
      // Marrom" e "... Preto"). Tirar a cor do fim do nome junta as variantes
      // em uma oferta so.
      const chave = String(p.titulo || '').toLowerCase()
        .replace(/\s+/g, ' ').trim()
        .replace(/\b(preto|preta|branco|branca|azul|vermelho|vermelha|verde|amarelo|amarela|rosa|cinza|bege|marrom|roxo|roxa|laranja|dourado|dourada|prata|nude|vinho|caramelo|off white|multicolorido)\b\s*$/, '')
        .trim() + '|' + p.preco.toFixed(2);
      if (vistos.has(chave)) continue;
      vistos.add(chave);

      achados.push({ ...p, anunciante: feed.anunciante, advertiserId: Number(advertiserId), chave });
    }
  } finally { rl.close(); }

  // Melhores primeiro: a cota diaria vai cortar a lista, entao o que sobra tem
  // de ser o topo, nao o comeco do arquivo.
  achados.sort((a, b) => (b.desconto - a.desconto) || (b.preco - a.preco));
  return achados.slice(0, limite);
}

/** Primeiras linhas de um feed, para conferir na mao qual coluna traz o preco. */
export async function amostraFeed(advertiserId, quantidade = 5) {
  const feeds = feedsDoAnunciante(advertiserId);
  if (!feeds.length) return { erro: 'anunciante sem feed ativo' };
  const feed = feeds[0];
  const caminho = await garantirFeedEmDisco(feed.fid);
  const rl = createInterface({ input: createReadStream(caminho).pipe(createGunzip()), crlfDelay: Infinity });

  let cab = null; const amostras = [];
  try {
    for await (const linha of rl) {
      if (!linha.trim()) continue;
      if (!cab) { cab = partirLinhaCsv(linha).map(c => c.trim()); continue; }
      const campos = partirLinhaCsv(linha);
      const o = {}; cab.forEach((c, i) => { o[c] = campos[i] ?? ''; });
      amostras.push({
        produto: o.product_name, url: o.merchant_deep_link,
        search_price: o.search_price, store_price: o.store_price,
        rrp_price: o.rrp_price, base_price: o.base_price,
        interpretado: normalizarLinhaFeed(o, feed),
      });
      if (amostras.length >= quantidade) break;
    }
  } finally { rl.close(); }
  return { feed, amostras };
}
