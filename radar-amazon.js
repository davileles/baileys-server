// ═══════════════════════════════════════════════════════════════════════════
// radar-amazon.js — Radar de ofertas de marketplace para o Gestão TSP
//
// Fluxo: grupo-fonte (WhatsApp) -> link Amazon -> ASIN -> Creators API
//        -> link com o SEU partnerTag -> mensagem no formato da aba Oferta
//        -> filaPendentes com tipoConteudo 'oferta_amazon'
//
// A Creators API substituiu a PA-API 5.0 (descontinuada em 15/05/2026).
// Autenticacao: OAuth client_credentials via Login with Amazon.
// Brasil fica na regiao NA -> token endpoint api.amazon.com.
//
// Requisitos no Railway:
//   AMZ_CLIENT_ID      credencial da Creators API
//   AMZ_CLIENT_SECRET  segredo da Creators API
//   AMZ_PARTNER_TAG    ex: tudosobrepromos-20
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, existsSync } from 'fs';

const SESSAO_DIR      = './sessao';
const RADAR_CFG_PATH  = SESSAO_DIR + '/radar_config.json';
const RADAR_DEDUP_PATH = SESSAO_DIR + '/radar_vistos.json';

const LINK_CONVITE_OFERTAS = 'https://chat.whatsapp.com/Ia5ZTqeTJdXHG5OT9LUwz8';

// ── CONFIG ────────────────────────────────────────────────────────────────

const CFG_PADRAO = {
  // jid -> 'fonte' | 'destino'. Gravado pela aba Grupos do painel.
  papeis: {},
  ativo: true,
  descontoMinimo: 5,      // % — abaixo disso descarta, salvo se for deal relampago
  dedupHoras: 24,
  partnerTag: process.env.AMZ_PARTNER_TAG || '',
  gatilhoPadrao: '',      // texto opcional no topo da mensagem
};

let _cfg = { ...CFG_PADRAO };

export function carregarRadarConfig() {
  try {
    if (existsSync(RADAR_CFG_PATH)) {
      _cfg = { ...CFG_PADRAO, ...JSON.parse(readFileSync(RADAR_CFG_PATH, 'utf-8')) };
      const f = radarFontes().length, d = radarDestinos().length;
      console.log(`[MKT] Config carregada — ${f} grupo(s) fonte, ${d} destino.`);
    } else {
      console.log('[MKT] Sem config em disco, usando padrao.');
    }
  } catch (e) {
    console.log('[MKT] Erro ao carregar config:', e.message);
  }
  return _cfg;
}

export function radarConfig() { return _cfg; }

export function salvarRadarConfig(novo = {}) {
  _cfg = { ..._cfg, ...novo };
  if (novo.papeis) _cfg.papeis = novo.papeis;
  try {
    writeFileSync(RADAR_CFG_PATH, JSON.stringify(_cfg, null, 2), 'utf-8');
  } catch (e) {
    console.log('[MKT] Erro ao salvar config:', e.message);
  }
  return _cfg;
}

export function radarFontes() {
  return Object.keys(_cfg.papeis || {}).filter(j => _cfg.papeis[j] === 'fonte');
}
export function radarDestinos() {
  return Object.keys(_cfg.papeis || {}).filter(j => _cfg.papeis[j] === 'destino');
}
export function ehFonteRadar(jid) {
  return _cfg.ativo !== false && _cfg.papeis?.[jid] === 'fonte';
}

// ── DEDUPLICACAO ──────────────────────────────────────────────────────────
// Persiste em disco para nao repostar o mesmo ASIN depois de um restart.

let _vistos = {};   // asin -> { preco, ts }

function carregarVistos() {
  try {
    if (existsSync(RADAR_DEDUP_PATH)) _vistos = JSON.parse(readFileSync(RADAR_DEDUP_PATH, 'utf-8'));
  } catch (e) { _vistos = {}; }
}
function salvarVistos() {
  try {
    const limite = Date.now() - (_cfg.dedupHoras || 24) * 3600e3;
    for (const k of Object.keys(_vistos)) if (_vistos[k].ts < limite) delete _vistos[k];
    writeFileSync(RADAR_DEDUP_PATH, JSON.stringify(_vistos), 'utf-8');
  } catch (e) {}
}
carregarVistos();

function jaDivulgado(p) {
  const ant = _vistos[p.asin];
  if (!ant) return false;
  if (Date.now() - ant.ts > (_cfg.dedupHoras || 24) * 3600e3) return false;
  // Se caiu mais de 5% desde a ultima vez, vale repostar
  if (ant.preco && p.preco && p.preco < ant.preco * 0.95) return false;
  return true;
}
function registrarVisto(p) {
  _vistos[p.asin] = { preco: p.preco, ts: Date.now() };
  salvarVistos();
}

// ── BASE DE CUPONS ────────────────────────────────────────────────────────
// Alimentada pelo mesmo ponto que registra a deduplicacao no server.js: todo
// cupom capturado (Telegram ou WhatsApp) entra aqui com os campos que a IA ja
// extrai. Serve para aplicar o desconto sobre o preco cheio que a Creators API
// devolve, que e sempre o preco de tabela — a API nao conhece cupom.
//
// Validade: 2 dias a partir da captura, salvo se o registro for editado a mao
// via endpoint. Flag 'ativo' permite desligar um cupom sem apagar o historico.

const CUPONS_BASE_PATH = SESSAO_DIR + '/cupons_base.json';
const CUPOM_VALIDADE_PADRAO_MS = 2 * 24 * 3600e3;

let _cupons = {};   // chave -> registro

function normalizarTexto(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/^outro:\s*/, '')
    .replace(/[^a-z0-9]/g, '');
}

// Mesma logica de chave do dedup do server.js, para os dois lados baterem.
export function chaveCupom(loja, codigo) {
  const l = normalizarTexto(loja) || 'outros';
  const c = normalizarTexto(codigo);
  return c ? `${l}:${c}` : null;
}

export function carregarCuponsBase() {
  try {
    if (existsSync(CUPONS_BASE_PATH)) {
      _cupons = JSON.parse(readFileSync(CUPONS_BASE_PATH, 'utf-8'));
      console.log('[CUPONS] Base carregada — ' + Object.keys(_cupons).length + ' cupom(ns).');
    }
  } catch (e) { console.log('[CUPONS] Erro ao carregar base:', e.message); _cupons = {}; }
  return _cupons;
}

function salvarCuponsBase() {
  try {
    // Purga o que venceu ha mais de 7 dias para o arquivo nao crescer sem fim.
    const corte = Date.now() - 7 * 24 * 3600e3;
    for (const k of Object.keys(_cupons)) {
      if (new Date(_cupons[k].validadeAte).getTime() < corte) delete _cupons[k];
    }
    writeFileSync(CUPONS_BASE_PATH, JSON.stringify(_cupons, null, 2), 'utf-8');
  } catch (e) { console.log('[CUPONS] Erro ao salvar base:', e.message); }
}

/**
 * Grava (ou atualiza) um cupom na base a partir do objeto que a IA extraiu.
 * Cupom sem codigo nao entra: sem codigo nao ha o que aplicar no checkout.
 */
export function registrarCupomBase(c) {
  const chave = chaveCupom(c?.loja, c?.codigo);
  if (!chave) return null;
  const agora = Date.now();
  const anterior = _cupons[chave];

  const reg = {
    chave,
    loja: c.loja || null,
    codigo: c.codigo,
    tipo: c.tipo === 'reais' ? 'reais' : 'pct',
    valor: Number(c.valor) || 0,
    minimo: c.minimo === null || c.minimo === undefined ? null : Number(c.minimo),
    limite: c.limite === null || c.limite === undefined ? null : Number(c.limite),
    observacao: c.observacao || null,
    capturadoEm: anterior?.capturadoEm || new Date(agora).toISOString(),
    atualizadoEm: new Date(agora).toISOString(),
    validadeAte: new Date(agora + CUPOM_VALIDADE_PADRAO_MS).toISOString(),
    // Reaparecer no grupo nao deve ressuscitar cupom que o operador desativou.
    ativo: anterior ? anterior.ativo !== false : true,
  };
  _cupons[chave] = reg;
  salvarCuponsBase();
  console.log('[CUPONS] ' + (anterior ? 'Atualizado' : 'Novo') + ' — ' + reg.loja + ' ' + reg.codigo +
    ' ' + reg.valor + (reg.tipo === 'pct' ? '%' : ' R$'));
  return reg;
}

export function listarCuponsBase() {
  return Object.values(_cupons).sort((a, b) => (a.loja || '').localeCompare(b.loja || '', 'pt-BR'));
}

export function atualizarCupomBase(chave, campos = {}) {
  const reg = _cupons[chave];
  if (!reg) return null;
  for (const k of ['ativo', 'valor', 'minimo', 'limite', 'tipo', 'validadeAte', 'observacao']) {
    if (campos[k] !== undefined) reg[k] = campos[k];
  }
  reg.atualizadoEm = new Date().toISOString();
  salvarCuponsBase();
  return reg;
}

export function removerCupomBase(chave) {
  if (!_cupons[chave]) return false;
  delete _cupons[chave];
  salvarCuponsBase();
  return true;
}

export function cupomVigente(reg) {
  return !!reg && reg.ativo !== false && new Date(reg.validadeAte).getTime() > Date.now();
}

/**
 * Desconto em R$ que o cupom gera sobre um preco. 0 quando nao se aplica.
 * O teto ('limite') so faz sentido em cupom percentual.
 */
export function calcularDesconto(reg, preco) {
  if (!reg || !preco || preco <= 0) return 0;
  if (reg.minimo != null && preco < reg.minimo) return 0;

  let d = reg.tipo === 'reais'
    ? (Number(reg.valor) || 0)
    : preco * (Number(reg.valor) || 0) / 100;

  if (reg.tipo === 'pct' && reg.limite != null) d = Math.min(d, Number(reg.limite));
  d = Math.min(d, preco);                       // nunca zera ou inverte o preco
  return d > 0 ? Math.round(d * 100) / 100 : 0;
}

/**
 * Melhor cupom para (loja, preco) DENTRE os codigos citados na mensagem
 * original. Nao aplica cupom que a mensagem nao mencione: o cupom costuma valer
 * para uma selecao especifica de produtos, e cruzar um cupom generico da base
 * com um produto qualquer anunciaria um preco que nao existe no checkout.
 * A base entra para fornecer as regras (percentual, minimo, teto) que o texto
 * do grupo quase nunca traz por completo.
 */
export function melhorCupom(loja, preco, textoOriginal = '') {
  const lojaKey = normalizarTexto(loja);
  const texto = normalizarTexto(textoOriginal);
  if (!texto) return null;
  let melhor = null;

  for (const reg of Object.values(_cupons)) {
    if (!cupomVigente(reg)) continue;
    if (normalizarTexto(reg.loja) !== lojaKey) continue;
    if (!reg.codigo || !texto.includes(normalizarTexto(reg.codigo))) continue;

    const desconto = calcularDesconto(reg, preco);
    if (desconto <= 0) continue;

    if (!melhor || desconto > melhor.desconto) melhor = { reg, desconto, citado: true };
  }
  return melhor;
}

carregarCuponsBase();

// ── EXTRACAO DE ASIN ──────────────────────────────────────────────────────

const PADROES_ASIN = [
  /\/dp\/(?:product\/)?([A-Z0-9]{10})/i,
  /\/gp\/(?:product|aw\/d|offer-listing)\/([A-Z0-9]{10})/i,
  /\/product\/([A-Z0-9]{10})/i,
  /[?&]asin=([A-Z0-9]{10})/i,
];

const REGEX_URL_AMAZON = /https?:\/\/(?:[\w-]+\.)*(?:amazon\.com\.br|amzn\.to|a\.co|amzn\.eu)\/\S+/gi;

function asinDeUrl(url) {
  for (const re of PADROES_ASIN) {
    const m = url.match(re);
    if (m) return m[1].toUpperCase();
  }
  return null;
}

// Encurtadores (amzn.to, a.co) nao carregam o ASIN. Segue os redirects
// manualmente. Usa Range para nao baixar a pagina inteira — a Amazon costuma
// ignorar HEAD nesses shortlinks.
async function resolverEncurtador(url, tentativas = 5) {
  let atual = url;
  for (let i = 0; i < tentativas; i++) {
    const res = await fetch(atual, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Range': 'bytes=0-0',
      },
      signal: AbortSignal.timeout(8000),
    });
    const loc = res.headers.get('location');
    if (!loc) return res.url || atual;
    atual = new URL(loc, atual).href;
    if (asinDeUrl(atual)) return atual;
  }
  return atual;
}

export async function extrairAsins(texto) {
  if (!texto) return [];
  const urls = [...new Set(texto.match(REGEX_URL_AMAZON) || [])]
    .map(u => u.replace(/[)\]}.,;!]+$/, ''));
  const asins = new Set();
  for (const url of urls) {
    let asin = asinDeUrl(url);
    if (!asin) {
      try { asin = asinDeUrl(await resolverEncurtador(url)); }
      catch (e) { console.warn('[MKT] Falha ao resolver', url, '-', e.message); }
    }
    if (asin) asins.add(asin);
  }
  return [...asins];
}

// ── CREATORS API ──────────────────────────────────────────────────────────

const TOKEN_ENDPOINT = 'https://api.amazon.com/auth/o2/token';  // regiao NA (BR)
const API_BASE       = 'https://creatorsapi.amazon';
const MARKETPLACE    = 'www.amazon.com.br';

let _token = { valor: null, expiraEm: 0 };

async function getToken() {
  if (_token.valor && Date.now() < _token.expiraEm) return _token.valor;
  if (!process.env.AMZ_CLIENT_ID || !process.env.AMZ_CLIENT_SECRET) {
    throw new Error('AMZ_CLIENT_ID / AMZ_CLIENT_SECRET nao configurados.');
  }
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: process.env.AMZ_CLIENT_ID,
      client_secret: process.env.AMZ_CLIENT_SECRET,
      scope: 'creatorsapi::default',
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error('Token Creators API falhou: ' + res.status + ' ' + (await res.text()).slice(0, 200));
  const data = await res.json();
  _token = { valor: data.access_token, expiraEm: Date.now() + (data.expires_in - 300) * 1000 };
  return _token.valor;
}

const RECURSOS = [
  'itemInfo.title',
  'itemInfo.byLineInfo',
  'images.primary.large',
  'offersV2.listings.price',
  'offersV2.listings.availability',
  'offersV2.listings.condition',
  'offersV2.listings.dealDetails',
  'offersV2.listings.isBuyBoxWinner',
  'offersV2.listings.merchantInfo',
  'customerReviews.starRating',
  'customerReviews.count',
];

// GetItems aceita ate 10 ASINs por chamada.
export async function buscarProdutos(asins) {
  if (!asins.length) return [];
  const token = await getToken();
  const partnerTag = _cfg.partnerTag || process.env.AMZ_PARTNER_TAG;
  if (!partnerTag) throw new Error('partnerTag nao configurado.');

  const lotes = [];
  for (let i = 0; i < asins.length; i += 10) lotes.push(asins.slice(i, i + 10));

  const itens = [];
  for (const lote of lotes) {
    const res = await fetch(API_BASE + '/catalog/v1/getItems', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'x-marketplace': MARKETPLACE,
      },
      body: JSON.stringify({
        itemIds: lote,
        itemIdType: 'ASIN',
        marketplace: MARKETPLACE,
        partnerTag,
        partnerType: 'Associates',
        resources: RECURSOS,
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      console.error('[MKT] getItems', res.status, (await res.text()).slice(0, 300));
      continue;
    }
    const data = await res.json();
    itens.push(...(data?.itemsResult?.items || []));
    if (lotes.length > 1) await new Promise(r => setTimeout(r, 1100));
  }
  return itens;
}

// ── NORMALIZACAO ──────────────────────────────────────────────────────────

// A Amazon pode devolver mais de um listing para o mesmo ASIN (ex.: um Prime
// Exclusive e um aberto) e a ordem NAO e garantida. Anunciar o preco Prime como
// se fosse geral gera reclamacao no grupo, entao prioriza o buy box.
function escolherListing(item) {
  const listings = item?.offersV2?.listings || [];
  if (!listings.length) return null;
  return listings.find(l => l.isBuyBoxWinner) || listings[0];
}

export function normalizar(item) {
  const l = escolherListing(item);
  const preco = l?.price?.money;
  const de    = l?.price?.savingBasis?.money;
  const desconto = (de?.amount && preco?.amount)
    ? Math.round((1 - preco.amount / de.amount) * 100)
    : 0;

  return {
    asin: item.asin,
    titulo: item?.itemInfo?.title?.displayValue || '',
    marca: item?.itemInfo?.byLineInfo?.brand?.displayValue || '',
    imagemUrl: item?.images?.primary?.large?.url || null,
    link: item.detailPageURL,          // ja vem com o partnerTag aplicado
    preco: preco?.amount ?? null,
    precoTexto: preco?.displayAmount || null,
    precoDe: de?.amount ?? null,
    precoDeTexto: de?.displayAmount || null,
    desconto,
    disponivel: l?.availability?.type === 'IN_STOCK',
    vendedor: l?.merchantInfo?.name || null,
    ehDeal: Boolean(l?.dealDetails),
    dealTermina: l?.dealDetails?.endTime || null,
    nota: item?.customerReviews?.starRating?.value ?? null,
    avaliacoes: item?.customerReviews?.count ?? null,
    loja: 'Amazon',
  };
}

// ── FORMATACAO ────────────────────────────────────────────────────────────
// Segue exatamente o formato da aba Oferta do gerador, para a mensagem do robo
// ser indistinguivel da que voce escreve na mao.

function brl(n) {
  return Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function encurtarTitulo(t, max = 80) {
  if (!t || t.length <= max) return t || '';
  const corte = t.lastIndexOf(' ', max);
  return t.slice(0, corte > 40 ? corte : max) + '...';
}

export function formatarOfertaAmazon(p, opcoes = {}) {
  const gatilho = opcoes.gatilho ?? _cfg.gatilhoPadrao ?? '';
  let msg = '';

  if (gatilho) msg += '`🚨 ' + gatilho + '`\n\n';

  msg += '*' + encurtarTitulo(p.titulo) + '*\n\n';

  // Com cupom aplicavel, o 'Por' passa a ser o preco final e o riscado vira o
  // maior valor conhecido (preco de lista, ou o proprio preco cheio da API).
  const cupom = opcoes.cupom || null;
  const precoFinal = cupom ? Math.max(0, p.preco - cupom.desconto) : p.preco;
  const riscado = cupom ? (p.precoDe || p.preco) : p.precoDe;

  if (riscado && riscado > precoFinal) {
    msg += 'De: ~R$ ' + brl(riscado) + '~\nPor: R$ ' + brl(precoFinal) + '\n';
  } else {
    msg += 'Por: R$ ' + brl(precoFinal) + '\n';
  }

  // Só o código: as regras (mínimo, teto, percentual) já foram aplicadas no
  // preço acima, então repeti-las aqui só polui a mensagem.
  if (cupom) msg += '\n\uD83C\uDFAB *CUPOM* ' + cupom.reg.codigo + '\n';
  msg += '\n';

  msg += '🛒 *LOJA* AMAZON\n\n🔗 *LINK* ' + p.link + '\n\n';
  msg += '`Convide seus amigos para entrar aqui no grupo:  ' + LINK_CONVITE_OFERTAS + '`';

  return msg;
}

// ── PIPELINE ──────────────────────────────────────────────────────────────

/**
 * Recebe o texto bruto de uma mensagem e devolve as ofertas prontas.
 * A API e a fonte da verdade: preco, estoque e desconto vem dela, nunca do
 * texto do grupo de origem — e o que evita repassar oferta que ja morreu.
 *
 * @param {string} texto
 * @param {object} opcoes  { ignorarDedup: bool, gatilho: string }
 * @returns {Promise<Array<{ produto, mensagem, descartadoPor? }>>}
 */
export async function processarTextoAmazon(texto, opcoes = {}) {
  const asins = await extrairAsins(texto);
  if (!asins.length) return [];

  const itens = await buscarProdutos(asins);
  const saida = [];

  for (const item of itens) {
    const p = normalizar(item);

    if (!p.preco)      { saida.push({ produto: p, descartadoPor: 'sem preço disponível' }); continue; }
    if (!p.disponivel) { saida.push({ produto: p, descartadoPor: 'produto esgotado' }); continue; }
    if (p.desconto < (_cfg.descontoMinimo ?? 5) && !p.ehDeal) {
      saida.push({ produto: p, descartadoPor: 'desconto de ' + p.desconto + '% abaixo do mínimo' });
      continue;
    }
    if (!opcoes.ignorarDedup && jaDivulgado(p)) {
      saida.push({ produto: p, descartadoPor: 'já divulgado nas últimas ' + (_cfg.dedupHoras || 24) + 'h' });
      continue;
    }

    // A API devolve sempre o preco de tabela; o cupom vem da base alimentada
    // pelo pipeline de cupons e e aplicado aqui sobre esse preco cheio.
    const cupom = melhorCupom(p.loja, p.preco, texto);
    if (cupom) {
      console.log('[MKT] ' + p.asin + ' + cupom ' + cupom.reg.codigo +
        ' (-R$ ' + cupom.desconto.toFixed(2) + ')' + (cupom.citado ? ' [citado no texto]' : ''));
    }
    saida.push({
      produto: p,
      cupom: cupom ? { codigo: cupom.reg.codigo, desconto: cupom.desconto, citado: cupom.citado } : null,
      precoFinal: cupom ? Math.max(0, p.preco - cupom.desconto) : p.preco,
      mensagem: formatarOfertaAmazon(p, { ...opcoes, cupom }),
    });
    if (!opcoes.ignorarDedup) registrarVisto(p);
  }
  return saida;
}

carregarRadarConfig();
