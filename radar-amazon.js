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
import { agendarPush } from './sync-github.js';

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
  // Janela de publicacao dos cupons no auto-envio. Antes era o horario fixo da
  // fila CDV (8h-21h) no codigo; virou config porque cupom e oferta tem ritmos
  // diferentes e quem decide isso e o operador, nao o deploy.
  janelaCupom: { inicio: '08:00', fim: '21:00', dias: 'todos', intervaloSeg: 90 },
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
    agendarPush('radar_config.json');
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

// ── MONITORAMENTO POR GRUPO ───────────────────────────────────────────────
// Cada grupo-fonte precisa de um cadastro dizendo QUAIS lojas capturar e EM QUE
// janela. Sem cadastro o grupo nao captura nada — marcar como fonte passa a ser
// so metade da configuracao.
//
// A janela e restrita ao mesmo dia (inicio < fim); horarios e dia da semana sao
// avaliados no fuso de Sao Paulo, nao no do servidor.

export const LOJAS_MONITORAVEIS = ['Amazon', 'Shopee', 'Magazine Luiza', 'Mercado Livre'];
const TZ_SP = 'America/Sao_Paulo';

function minutosAgoraSP(d = new Date()) {
  const s = d.toLocaleString('en-GB', { timeZone: TZ_SP, hour12: false, hour: '2-digit', minute: '2-digit' });
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}

function diaSemanaSP(d = new Date()) {
  const s = d.toLocaleDateString('en-US', { timeZone: TZ_SP, weekday: 'short' });
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(s);
}

function paraMinutos(hhmm, padrao) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return padrao;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return padrao;
  return h * 60 + min;
}

// ── JANELA DE PUBLICACAO DOS CUPONS ───────────────────────────────────────
// Mesma mecanica da janela por grupo da aba Grupos, mas global: vale para todo
// cupom que o gate de auto-envio liberar.

export function janelaCupom() {
  return { ...CFG_PADRAO.janelaCupom, ...(_cfg.janelaCupom || {}) };
}

export function salvarJanelaCupom(dados = {}) {
  const atual = janelaCupom();
  const nova = {
    inicio: dados.inicio !== undefined ? String(dados.inicio) : atual.inicio,
    fim:    dados.fim    !== undefined ? String(dados.fim)    : atual.fim,
    dias:   dados.dias === 'uteis' ? 'uteis' : (dados.dias === 'todos' ? 'todos' : atual.dias),
    intervaloSeg: dados.intervaloSeg !== undefined
      ? Math.max(0, Math.min(3600, Number(dados.intervaloSeg) || 0))
      : atual.intervaloSeg,
  };
  // Horario invalido cairia no padrao do paraMinutos e o operador nunca saberia
  // por que a janela nao mudou — melhor recusar na hora de gravar.
  if (paraMinutos(nova.inicio, null) === null) throw new Error('horario inicial invalido (use HH:MM)');
  if (paraMinutos(nova.fim, null) === null)    throw new Error('horario final invalido (use HH:MM)');
  salvarRadarConfig({ janelaCupom: nova });
  return nova;
}

/** { ok, motivo } — o motivo aparece no veredito do gate, no card da fila. */
export function dentroDaJanelaCupom(quando = new Date()) {
  const j = janelaCupom();
  if (j.dias === 'uteis') {
    const dia = diaSemanaSP(quando);
    if (dia === 0 || dia === 6) return { ok: false, motivo: 'fora da janela (so dias uteis)' };
  }
  const agora  = minutosAgoraSP(quando);
  const inicio = paraMinutos(j.inicio, 8 * 60);
  const fim    = paraMinutos(j.fim, 21 * 60);
  // Janela que vira a meia-noite (ex: 20:00-02:00) e um intervalo unico partido
  // em dois pedacos do dia, nao um erro de digitacao.
  const dentro = inicio <= fim
    ? (agora >= inicio && agora < fim)
    : (agora >= inicio || agora < fim);
  if (!dentro) return { ok: false, motivo: `fora da janela ${j.inicio}-${j.fim} SP` };
  return { ok: true, motivo: 'dentro da janela' };
}

export function listarMonitor() { return _cfg.monitor || {}; }

export function monitorDoGrupo(jid) { return (_cfg.monitor || {})[jid] || null; }

export function salvarMonitor(jid, dados = {}) {
  if (!jid) return null;
  if (!_cfg.monitor) _cfg.monitor = {};
  const anterior = _cfg.monitor[jid] || {};

  const lojas = Array.isArray(dados.lojas)
    ? dados.lojas.filter(l => LOJAS_MONITORAVEIS.includes(l))
    : (anterior.lojas || []);

  _cfg.monitor[jid] = {
    jid,
    lojas,
    inicio: dados.inicio !== undefined ? String(dados.inicio) : (anterior.inicio || '00:00'),
    fim:    dados.fim    !== undefined ? String(dados.fim)    : (anterior.fim    || '23:59'),
    dias:   dados.dias === 'uteis' ? 'uteis' : (dados.dias === 'todos' ? 'todos' : (anterior.dias || 'todos')),
    ativo:  dados.ativo !== undefined ? !!dados.ativo : (anterior.ativo !== false),
    atualizadoEm: new Date().toISOString(),
  };
  salvarRadarConfig({ monitor: _cfg.monitor });
  return _cfg.monitor[jid];
}

export function removerMonitor(jid) {
  if (!_cfg.monitor?.[jid]) return false;
  delete _cfg.monitor[jid];
  salvarRadarConfig({ monitor: _cfg.monitor });
  return true;
}

/**
 * Decide se um grupo pode capturar uma loja neste instante.
 * Devolve { ok, motivo } — o motivo alimenta o log, para um silencio no radar
 * sempre ter explicacao.
 */
export function podeCapturar(jid, loja, quando = new Date()) {
  const cfg = monitorDoGrupo(jid);
  if (!cfg)             return { ok: false, motivo: 'grupo sem cadastro de monitoramento' };
  if (cfg.ativo === false) return { ok: false, motivo: 'monitoramento desativado neste grupo' };
  if (!cfg.lojas?.length)  return { ok: false, motivo: 'nenhuma loja selecionada' };
  if (!cfg.lojas.includes(loja)) return { ok: false, motivo: loja + ' nao monitorada neste grupo' };

  const dia = diaSemanaSP(quando);
  if (cfg.dias === 'uteis' && (dia === 0 || dia === 6)) {
    return { ok: false, motivo: 'fora dos dias uteis' };
  }

  const agora  = minutosAgoraSP(quando);
  const inicio = paraMinutos(cfg.inicio, 0);
  const fim    = paraMinutos(cfg.fim, 23 * 60 + 59);
  if (agora < inicio || agora > fim) {
    return { ok: false, motivo: 'fora da janela ' + cfg.inicio + '-' + cfg.fim + ' (agora ' +
      String(Math.floor(agora / 60)).padStart(2, '0') + ':' + String(agora % 60).padStart(2, '0') + ' SP)' };
  }
  return { ok: true, motivo: 'dentro da janela' };
}

/**
 * Garante cadastro para todo grupo marcado como fonte. Sem isto, ativar a regra
 * "sem cadastro nao captura" desligaria em silencio os grupos ja configurados.
 * O cadastro semeado e permissivo e fica visivel no painel para ajuste.
 */
export function semearMonitorDasFontes() {
  const fontes = radarFontes();
  let novos = 0;
  for (const jid of fontes) {
    if (monitorDoGrupo(jid)) continue;
    salvarMonitor(jid, { lojas: [...LOJAS_MONITORAVEIS], inicio: '00:00', fim: '23:59', dias: 'todos', ativo: true });
    novos++;
  }
  if (novos) console.log('[MONITOR] ' + novos + ' grupo(s) fonte receberam cadastro inicial (todas as lojas, 24h).');
  return novos;
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
const CUPOM_VALIDADE_PADRAO_MS = 24 * 3600e3;

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
      // A validade padrao caiu de 48h para 24h: recalcula quem foi gravado com a
      // janela antiga, para a base nao ficar com dois criterios convivendo.
      let migrados = 0;
      for (const reg of Object.values(_cupons)) {
        const base = new Date(reg.capturadoEm).getTime();
        if (!isFinite(base)) continue;
        const alvo = base + CUPOM_VALIDADE_PADRAO_MS;
        if (new Date(reg.validadeAte).getTime() > alvo + 60e3) {
          reg.validadeAte = new Date(alvo).toISOString();
          migrados++;
        }
      }
      if (migrados) { salvarCuponsBase(); console.log('[CUPONS] ' + migrados + ' cupom(ns) migrado(s) para validade de 24h.'); }
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
    agendarPush('cupons_base.json');
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

/** Liga ou desliga de uma vez todos os cupons de uma loja. */
export function definirAtivoPorLoja(loja, ativo) {
  const alvo = normalizarTexto(loja);
  let n = 0;
  for (const reg of Object.values(_cupons)) {
    if (normalizarTexto(reg.loja) !== alvo) continue;
    if (reg.ativo === ativo) continue;
    reg.ativo = ativo;
    reg.atualizadoEm = new Date().toISOString();
    n++;
  }
  if (n) salvarCuponsBase();
  return n;
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

/** Busca um cupom da base pelo par (loja, codigo). Usado pela vitrine. */
export function cupomPorCodigo(loja, codigo) {
  const k = chaveCupom(loja, codigo);
  return k ? (_cupons[k] || null) : null;
}

// Mensagens que falam de cupom sem dar o codigo: "resgate cupom do anuncio",
// "com cupom", "aplique o cupom". Exige a palavra cupom — nao inferimos cupom a
// partir de "desconto" ou "promocao", que aparecem em qualquer oferta.
const REGEX_CUPOM_GENERICO = /\bcupom\b|\bcupons\b|\bcoupon\b/i;

/** Cupom vigente mais recente de uma loja, pela data de captura. */
export function ultimoCupomDaLoja(loja) {
  const alvo = normalizarTexto(loja);
  let recente = null;
  for (const reg of Object.values(_cupons)) {
    if (!cupomVigente(reg)) continue;
    if (normalizarTexto(reg.loja) !== alvo) continue;
    if (!recente || new Date(reg.capturadoEm) > new Date(recente.capturadoEm)) recente = reg;
  }
  return recente;
}

/**
 * Melhor cupom para (loja, preco), em duas etapas:
 *
 *   1. Codigo citado na mensagem — caminho preferencial. A base entra so para
 *      dar as regras (percentual, minimo, teto) que o texto raramente traz.
 *   2. Se a mensagem fala de cupom mas nao da o codigo ("resgate cupom do
 *      anuncio"), usa o ultimo cupom registrado para aquela loja.
 *
 * Fora esses dois casos nao aplica nada: cruzar um cupom qualquer com um produto
 * que nunca falou em cupom anunciaria um preco que nao existe no checkout.
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
  if (melhor) return melhor;

  // Etapa 2: mencao generica ao cupom, sem codigo.
  if (!REGEX_CUPOM_GENERICO.test(String(textoOriginal))) return null;
  const reg = ultimoCupomDaLoja(loja);
  if (!reg) return null;
  const desconto = calcularDesconto(reg, preco);
  if (desconto <= 0) return null;
  return { reg, desconto, citado: false, generico: true };
}

carregarCuponsBase();

// ── EXTRACAO DE ASIN ──────────────────────────────────────────────────────

const PADROES_ASIN = [
  /\/dp\/(?:product\/)?([A-Z0-9]{10})/i,
  /\/gp\/(?:product|aw\/d|offer-listing)\/([A-Z0-9]{10})/i,
  /\/product\/([A-Z0-9]{10})/i,
  /[?&]asin=([A-Z0-9]{10})/i,
];

// Dois formatos convivem nos grupos-fonte: link direto (amazon.com.br/dp/ASIN)
// e encurtador (amzn.to, a.co, link.amazon). O encurtador NAO carrega o ASIN no
// path — o codigo ali e do shortlink, nao do produto — entao precisa ser
// resolvido por redirect antes de virar consulta na API.
const REGEX_URL_AMAZON = /https?:\/\/(?:[\w-]+\.)*(?:amazon\.com\.br|amzn\.to|amzn\.eu|a\.co|link\.amazon(?:\.com)?)\/\S+/gi;

const UA_NAVEGADOR = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

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
        'User-Agent': UA_NAVEGADOR,
        'Accept-Language': 'pt-BR,pt;q=0.9',
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

// Nem todo encurtador entrega o destino por header Location: alguns respondem
// 200 com redirect via JS ou meta refresh, e ai a cadeia de redirects termina
// sem ASIN. Neste caso busca a pagina e le o ASIN do canonical.
// So aceita canonical/og:url/campo "asin" — nunca um /dp/ solto no corpo, que
// costuma ser produto recomendado e anunciaria o item errado.
async function asinPorHtml(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA_NAVEGADOR, 'Accept-Language': 'pt-BR,pt;q=0.9' },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, 300000);

    const canonical = html.match(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i);
    if (canonical) { const a = asinDeUrl(canonical[1]); if (a) return { asin: a, canonical: canonical[1] }; }

    const og = html.match(/<meta[^>]+property=["']og:url["'][^>]*content=["']([^"']+)["']/i);
    if (og) { const a = asinDeUrl(og[1]); if (a) return { asin: a, canonical: og[1] }; }

    const campo = html.match(/["']asin["']\s*:\s*["']([A-Z0-9]{10})["']/i);
    if (campo) return { asin: campo[1].toUpperCase(), canonical: null };

    return null;
  } catch (e) {
    console.warn('[MKT] Falha ao ler HTML de', url, '-', e.message);
    return null;
  }
}

export async function extrairAsins(texto) {
  if (!texto) return [];
  const urls = [...new Set(texto.match(REGEX_URL_AMAZON) || [])]
    .map(u => u.replace(/[)\]}.,;!]+$/, ''));
  const asins = new Set();
  for (const url of urls) {
    let asin = asinDeUrl(url);
    let destino = url;
    if (!asin) {
      try { destino = await resolverEncurtador(url); asin = asinDeUrl(destino); }
      catch (e) { console.warn('[MKT] Falha ao resolver', url, '-', e.message); }
    }
    if (!asin) { const r = await asinPorHtml(destino); asin = r?.asin || null; }
    if (asin) asins.add(asin);
    else console.warn('[MKT] Sem ASIN para', url, '— destino:', destino);
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
  'images.primary.medium',
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

/**
 * Sonda de diagnostico: pede recursos arbitrarios a Creators API e devolve o
 * JSON cru. Serve para descobrir o que a API expoe (ex.: promocao/cupom da
 * pagina) sem arriscar o pipeline com um recurso invalido.
 */
export async function sondarRecursos(asin, recursos) {
  const token = await getToken();
  const partnerTag = _cfg.partnerTag || process.env.AMZ_PARTNER_TAG;
  const res = await fetch(API_BASE + '/catalog/v1/getItems', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'x-marketplace': MARKETPLACE },
    body: JSON.stringify({
      itemIds: [asin], itemIdType: 'ASIN', marketplace: MARKETPLACE,
      partnerTag, partnerType: 'Associates', resources: recursos,
    }),
    signal: AbortSignal.timeout(20000),
  });
  const texto = await res.text();
  try { return { status: res.status, corpo: JSON.parse(texto) }; }
  catch (e) { return { status: res.status, corpo: texto.slice(0, 600) }; }
}

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
    imagemUrl: item?.images?.primary?.medium?.url || item?.images?.primary?.large?.url || null,
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
  const cupom = opcoes.cupom || null;
  const tpl   = opcoes.template || templateDaLoja(p.loja);
  const vars  = varsDoProduto(p, cupom);
  if (opcoes.gatilho ?? _cfg.gatilhoPadrao) vars.gatilho = opcoes.gatilho ?? _cfg.gatilhoPadrao;
  return renderTemplate(tpl?.corpo || TEMPLATE_PADRAO, vars);
}

// ── TEMPLATES POR LOJA ────────────────────────────────────────────────────
// O formato da mensagem deixa de ser codigo e passa a ser dado editavel. Cada
// loja tem o seu; quem nao tiver cai no '_padrao'. Sintaxe estilo Mustache:
//   {{var}}            insere o valor (vazio se ausente)
//   {{#var}}...{{/var}} so renderiza o bloco se var tiver valor
//   {{^var}}...{{/var}} so renderiza o bloco se var estiver vazia
// As condicionais existem porque sem elas a mensagem sai com "De: ~R$ ~" ou um
// selo de cupom orfao quando o campo nao veio da API.

const TEMPLATES_PATH = SESSAO_DIR + '/templates.json';

const TEMPLATE_PADRAO = [
  '*{{titulo_curto}}*',
  '',
  'De: ~R$ {{preco_de}}~',
  'Por: R$ {{preco}}',
  '',
  '\uD83C\uDFAB *CUPOM* {{cupom}}',
  '\u26A0\uFE0F *IMPORTANTE* {{alerta}}',
  '',
  '\uD83D\uDED2 *LOJA* {{loja_upper}}',
  '',
  '\uD83D\uDD17 *LINK* {{link}}',
  '',
  '`Convide seus amigos para entrar aqui no grupo:  ' + LINK_CONVITE_OFERTAS + '`',
].join('\n');

// Corpo da versao anterior, que exigia {{#var}}...{{/var}}. Serve so para
// reconhecer o padrao nao editado e migra-lo para a sintaxe simples — template
// que o operador ja customizou nao e tocado.
const TEMPLATE_PADRAO_LEGADO = [
  '*{{titulo_curto}}*', '', '{{#preco_de}}De: ~R$ {{preco_de}}~', '{{/preco_de}}Por: R$ {{preco}}',
  '{{#cupom}}', '\uD83C\uDFAB *CUPOM* {{cupom}}', '{{/cupom}}', '{{#alerta}}',
  '\u26A0\uFE0F *IMPORTANTE* {{alerta}}', '{{/alerta}}', '', '\uD83D\uDED2 *LOJA* {{loja_upper}}',
  '', '\uD83D\uDD17 *LINK* {{link}}', '',
  '`Convide seus amigos para entrar aqui no grupo:  ' + LINK_CONVITE_OFERTAS + '`',
].join('\n');

let _templates = {};

function chaveLoja(loja) {
  return (loja || '')
    .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '') || '_padrao';
}

export function carregarTemplates() {
  try {
    if (existsSync(TEMPLATES_PATH)) _templates = JSON.parse(readFileSync(TEMPLATES_PATH, 'utf-8'));
  } catch (e) { console.log('[TPL] Erro ao carregar templates:', e.message); _templates = {}; }
  // Semeia o padrao na primeira execucao para o operador ter de onde partir.
  if (!_templates._padrao) {
    _templates._padrao = { nome: 'Padrão', corpo: TEMPLATE_PADRAO, usarLinkPreview: true,
                           atualizadoEm: new Date().toISOString() };
    salvarTemplates();
  } else if ((_templates._padrao.corpo || '').trim() === TEMPLATE_PADRAO_LEGADO.trim()) {
    _templates._padrao.corpo = TEMPLATE_PADRAO;
    _templates._padrao.atualizadoEm = new Date().toISOString();
    salvarTemplates();
    console.log('[TPL] Padrao migrado para a sintaxe sem condicionais.');
  }
  console.log('[TPL] ' + Object.keys(_templates).length + ' template(s) carregado(s).');
  return _templates;
}

function salvarTemplates() {
  try { writeFileSync(TEMPLATES_PATH, JSON.stringify(_templates, null, 2), 'utf-8');
    agendarPush('templates.json'); }
  catch (e) { console.log('[TPL] Erro ao salvar templates:', e.message); }
}

export function listarTemplates() { return _templates; }

export function templateDaLoja(loja) {
  return _templates[chaveLoja(loja)] || _templates._padrao;
}

export function salvarTemplate(loja, dados = {}) {
  const k = chaveLoja(loja);
  const anterior = _templates[k] || {};
  _templates[k] = {
    nome: dados.nome || anterior.nome || loja || 'Padrão',
    corpo: dados.corpo !== undefined ? dados.corpo : (anterior.corpo || TEMPLATE_PADRAO),
    usarLinkPreview: dados.usarLinkPreview !== undefined
      ? !!dados.usarLinkPreview
      : (anterior.usarLinkPreview !== false),
    atualizadoEm: new Date().toISOString(),
  };
  salvarTemplates();
  return _templates[k];
}

export function removerTemplate(loja) {
  const k = chaveLoja(loja);
  if (k === '_padrao' || !_templates[k]) return false;   // o padrao nunca some
  delete _templates[k];
  salvarTemplates();
  return true;
}

export function renderTemplate(corpo, vars) {
  const vazio = v => v === null || v === undefined || v === '' || v === false;
  let out = String(corpo || '');

  // Condicionais explicitas seguem valendo para casos que a regra de linha nao
  // cobre (bloco de varias linhas, ou negacao com {{^var}}).
  out = out.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, k, dentro) => vazio(vars[k]) ? '' : dentro);
  out = out.replace(/\{\{\^(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, k, dentro) => vazio(vars[k]) ? dentro : '');

  // Omissao automatica: uma linha que so contem variaveis vazias nao tem o que
  // dizer, entao sai inteira. Assim "De: ~R$ {{preco_de}}~" desaparece sozinho
  // quando nao ha preco de lista, sem o operador escrever condicional nenhuma.
  // Linha sem variavel e texto fixo e nunca some; linha com pelo menos uma
  // variavel preenchida e mantida.
  out = out.split('\n').filter(linha => {
    const usadas = (linha.match(/\{\{(\w+)\}\}/g) || []).map(t => t.slice(2, -2));
    if (!usadas.length) return true;
    return usadas.some(k => !vazio(vars[k]));
  }).join('\n');

  out = out.replace(/\{\{(\w+)\}\}/g, (_, k) => vazio(vars[k]) ? '' : String(vars[k]));
  return out.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** Variaveis disponiveis no template, a partir do produto ja normalizado. */
export function varsDoProduto(p, cupom) {
  const precoFinal = cupom ? Math.max(0, p.preco - cupom.desconto) : p.preco;
  const riscado = cupom ? (p.precoDe || p.preco) : p.precoDe;
  const descTotal = (riscado && riscado > precoFinal)
    ? Math.round((1 - precoFinal / riscado) * 100)
    : p.desconto;

  const alertas = [];
  if (descTotal >= 40) alertas.push(descTotal + '% de desconto');
  if (p.dealTermina) {
    alertas.push('Oferta relâmpago, termina em ' + new Date(p.dealTermina).toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo',
    }));
  }

  return {
    titulo: p.titulo || '',
    titulo_curto: encurtarTitulo(p.titulo),
    preco: brl(precoFinal),
    preco_cheio: brl(p.preco),
    preco_de: (riscado && riscado > precoFinal) ? brl(riscado) : '',
    desconto: descTotal > 0 ? descTotal : '',
    economia: (riscado && riscado > precoFinal) ? brl(riscado - precoFinal) : '',
    cupom: cupom ? cupom.reg.codigo : '',
    cupom_desconto: cupom ? brl(cupom.desconto) : '',
    alerta: alertas.join('. '),
    link: p.link || '',
    loja: p.loja || '',
    loja_upper: (p.loja || '').toUpperCase(),
    vendedor: p.vendedor || '',
    asin: p.asin || '',
    avaliacao: p.nota ? String(p.nota).replace('.', ',') : '',
    avaliacoes: p.avaliacoes || '',
    marca: p.marca || '',
  };
}

/** Lista para a UI montar os botoes de insercao. */
export const VARIAVEIS_TEMPLATE = [
  { chave:'titulo_curto',  desc:'Título do produto, cortado em 80 caracteres' },
  { chave:'titulo',        desc:'Título completo do produto' },
  { chave:'preco',         desc:'Preço final, já com o cupom aplicado' },
  { chave:'preco_cheio',   desc:'Preço da API, sem o cupom' },
  { chave:'preco_de',      desc:'Preço de lista (vazio quando não há)' },
  { chave:'desconto',      desc:'Percentual total de desconto' },
  { chave:'economia',      desc:'Quanto o cliente economiza, em R$' },
  { chave:'cupom',         desc:'Código do cupom (vazio quando não há)' },
  { chave:'cupom_desconto',desc:'Valor do desconto do cupom, em R$' },
  { chave:'alerta',        desc:'Aviso de desconto alto ou oferta relâmpago' },
  { chave:'link',          desc:'Link do produto com a sua tag de afiliado' },
  { chave:'loja',          desc:'Nome da loja' },
  { chave:'loja_upper',    desc:'Nome da loja em maiúsculas' },
  { chave:'vendedor',      desc:'Vendedor do anúncio' },
  { chave:'marca',         desc:'Marca do produto' },
  { chave:'avaliacao',     desc:'Nota média (ex: 4,5)' },
  { chave:'avaliacoes',    desc:'Quantidade de avaliações' },
  { chave:'asin',          desc:'Código ASIN do produto' },
];

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
    // ignorarMinimo: montagem manual pelo gerador. Quando o operador cola o
    // link ele ja decidiu que quer aquele produto — o piso de desconto existe
    // para o radar automatico, que escolhe sozinho o que divulgar.
    if (p.desconto < (_cfg.descontoMinimo ?? 5) && !p.ehDeal && !opcoes.ignorarMinimo) {
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
        ' (-R$ ' + cupom.desconto.toFixed(2) + ')' +
        (cupom.citado ? ' [citado no texto]' : ' [ultimo da loja — texto cita cupom sem codigo]'));
    }
    saida.push({
      produto: p,
      cupom: cupom ? { codigo: cupom.reg.codigo, desconto: cupom.desconto, citado: cupom.citado,
                       generico: !!cupom.generico } : null,
      precoFinal: cupom ? Math.max(0, p.preco - cupom.desconto) : p.preco,
      mensagem: formatarOfertaAmazon(p, { ...opcoes, cupom }),
    });
    if (!opcoes.ignorarDedup) registrarVisto(p);
  }
  return saida;
}

carregarRadarConfig();
semearMonitorDasFontes();
carregarTemplates();

// ── VITRINE ───────────────────────────────────────────────────────────────
// Produtos que o operador quer manter a mao para disparar quando sair um cupom
// bom. Guarda so link, ASIN e nome: preco, estoque e desconto sao consultados
// no disparo, porque preco salvo envelhece e anunciar preco velho e o erro que
// esse pipeline inteiro existe para evitar.

const VITRINE_PATH = SESSAO_DIR + '/vitrine.json';
let _vitrine = {};

export function carregarVitrine() {
  try { if (existsSync(VITRINE_PATH)) _vitrine = JSON.parse(readFileSync(VITRINE_PATH, 'utf-8')); }
  catch (e) { console.log('[VITRINE] Erro ao carregar:', e.message); _vitrine = {}; }
  return _vitrine;
}
function salvarVitrine() {
  try { writeFileSync(VITRINE_PATH, JSON.stringify(_vitrine, null, 2), 'utf-8');
    agendarPush('vitrine.json'); }
  catch (e) { console.log('[VITRINE] Erro ao salvar:', e.message); }
}

// O slug da URL da Amazon ja traz o nome do produto
// (/Carrinho-Eletrico-Infantil-Maxi-Toys/dp/B0FPT9JLMX), entao da para gravar um
// nome legivel sem gastar uma chamada de API no cadastro.
function nomeDoSlug(url) {
  try {
    // Precisa ser o pathname: casar na URL inteira faria o host virar "nome"
    // em links no formato /dp/ASIN, que nao tem slug.
    const m = new URL(url).pathname.match(/^\/([^\/]+)\/dp\//i);
    if (!m) return '';
    return decodeURIComponent(m[1]).replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  } catch (e) { return ''; }
}

/**
 * Resolve uma linha colada pelo operador. Aceita "nome | link" ou so o link.
 * Faz apenas o trabalho de rede necessario para achar o ASIN (encurtador);
 * nao consulta a Creators API.
 */
export async function resolverLinhaVitrine(linha) {
  const bruto = String(linha || '').trim();
  if (!bruto) return null;

  let nomeManual = '', url = bruto;
  const sep = bruto.match(/^(.*?)\s*[|;]\s*(https?:\/\/\S+)$/);
  if (sep) { nomeManual = sep[1].trim(); url = sep[2].trim(); }
  else {
    const m = bruto.match(REGEX_URL_AMAZON);
    if (!m) return { erro: 'sem link da Amazon', linha: bruto };
    url = m[0].replace(/[)\]}.,;!]+$/, '');
    REGEX_URL_AMAZON.lastIndex = 0;
  }

  let asin = asinDeUrl(url), destino = url;
  if (!asin) {
    try { destino = await resolverEncurtador(url); asin = asinDeUrl(destino); }
    catch (e) { /* segue para o fallback por HTML */ }
  }
  if (!asin) {
    const r = await asinPorHtml(destino);
    if (r?.asin) { asin = r.asin; if (r.canonical) destino = r.canonical; }
  }
  if (!asin) return { erro: 'não foi possível identificar o produto', linha: bruto };

  const nome = nomeManual || nomeDoSlug(destino) || nomeDoSlug(url) || ('Produto ' + asin);
  return { asin, nome, url: destino, loja: 'Amazon' };
}

export function listarVitrine() {
  return Object.values(_vitrine).sort((a, b) => (a.nome || '').localeCompare(b.nome || '', 'pt-BR'));
}

const NOME_PROVISORIO = /^Produto [A-Z0-9]{10}$/;

export function salvarItemVitrine(item) {
  if (!item?.asin) return null;
  const anterior = _vitrine[item.asin];

  // Um nome provisorio nunca sobrescreve um nome bom: o mesmo produto colado por
  // dois formatos de link (um com slug, outro encurtado) perderia o nome legivel.
  let nome = item.nome !== undefined ? item.nome : (anterior?.nome || '');
  if (NOME_PROVISORIO.test(nome) && anterior?.nome && !NOME_PROVISORIO.test(anterior.nome)) {
    nome = anterior.nome;
  }

  _vitrine[item.asin] = {
    asin: item.asin,
    nome,
    url: item.url || anterior?.url || '',
    loja: item.loja || anterior?.loja || 'Amazon',
    // Shopee identifica o produto por (shopId, itemId), nao por um codigo unico
    // como o ASIN — os dois precisam sobreviver no cadastro.
    shopId: item.shopId || anterior?.shopId || null,
    itemId: item.itemId || anterior?.itemId || null,
    cupom: item.cupom !== undefined ? (item.cupom || null) : (anterior?.cupom || null),
    criadoEm: anterior?.criadoEm || new Date().toISOString(),
    atualizadoEm: new Date().toISOString(),
    ultimoDisparo: anterior?.ultimoDisparo || null,
  };
  salvarVitrine();
  return _vitrine[item.asin];
}

export function removerItemVitrine(asin) {
  if (!_vitrine[asin]) return false;
  delete _vitrine[asin];
  salvarVitrine();
  return true;
}

export function marcarDisparo(asin) {
  if (_vitrine[asin]) { _vitrine[asin].ultimoDisparo = new Date().toISOString(); salvarVitrine(); }
}

export function itemVitrine(asin) { return _vitrine[asin] || null; }

/**
 * Monta as mensagens de uma lista de ASINs no momento do disparo: consulta a
 * Creators API agora, aplica o cupom (o informado no disparo tem prioridade
 * sobre o vinculado ao produto) e renderiza o template da loja.
 * Devolve { prontos, descartados } — nada e enviado aqui.
 */
export async function montarOfertasVitrine(asins, codigoCupom = null) {
  const itens = await buscarProdutos(asins);
  const prontos = [], descartados = [];
  const achados = new Set();

  for (const item of itens) {
    const p = normalizar(item);
    achados.add(p.asin);
    const salvo = _vitrine[p.asin];
    // Link sem slug entra como "Produto ASIN"; o disparo e a primeira vez que
    // temos o titulo real, entao aproveita para gravar.
    let nome = salvo?.nome || p.titulo;
    if (salvo && NOME_PROVISORIO.test(nome) && p.titulo) {
      nome = p.titulo; salvarItemVitrine({ asin: p.asin, nome });
    }

    if (!p.preco)      { descartados.push({ asin:p.asin, nome, motivo:'sem preço disponível' }); continue; }
    if (!p.disponivel) { descartados.push({ asin:p.asin, nome, motivo:'produto esgotado' }); continue; }

    // Cupom do disparo vence o vinculado; sem nenhum dos dois, vai sem cupom.
    const codigo = codigoCupom || salvo?.cupom || null;
    let cupom = null, avisoCupom = null;
    if (codigo) {
      const reg = cupomPorCodigo(p.loja, codigo);
      if (!reg)                   avisoCupom = 'cupom ' + codigo + ' não está na base';
      else if (!cupomVigente(reg)) avisoCupom = 'cupom ' + codigo + ' expirado ou inativo';
      else {
        const desconto = calcularDesconto(reg, p.preco);
        if (desconto > 0) cupom = { reg, desconto, citado: true };
        else avisoCupom = 'cupom ' + codigo + ' não se aplica a R$ ' + brl(p.preco)
                        + (reg.minimo != null ? ' (mínimo R$ ' + brl(reg.minimo) + ')' : '');
      }
    }

    prontos.push({
      asin: p.asin, nome, produto: p,
      cupom: cupom ? { codigo: cupom.reg.codigo, desconto: cupom.desconto } : null,
      avisoCupom,
      precoFinal: cupom ? Math.max(0, p.preco - cupom.desconto) : p.preco,
      mensagem: formatarOfertaAmazon(p, { cupom }),
    });
  }

  for (const a of asins) {
    if (!achados.has(a)) {
      descartados.push({ asin:a, nome:_vitrine[a]?.nome || a, motivo:'produto não retornado pela API' });
    }
  }
  return { prontos, descartados };
}

carregarVitrine();
