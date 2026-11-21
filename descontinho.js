// ═════════════════════════════════════════════════════════════════════════════
// descontinho.js — historico de preco da Shopee vindo do Descontinho
// (descontinho.app), 21/11/2026.
//
// Problema (Davi): muito produto aparece pela primeira vez num grupo-fonte e a
// gente nao tem serie para julgar a oferta. Para a Amazon o Keepa resolve; para
// a Shopee, o Descontinho guarda a serie de precos que le da API de afiliados
// da Shopee (API publica, gratuita, sem chave; 60 req/min por IP). Teste de
// 21/11: 123 das 138 ofertas da Shopee do feed tinham historico la, 80 com a
// janela cheia de 30 dias.
//
// Como entra:
//   1. NA HORA da captura (server.js): produto da Shopee sem consulta recente
//      e consultado antes do filtro de disparo, esperando no maximo
//      cfg.esperaMs. Estourou o prazo, deu erro ou a fonte esta fora: a oferta
//      segue SEM esse historico (nada trava) e o resultado, se chegar depois,
//      ainda fica gravado para a proxima.
//   2. EM SEGUNDO PLANO: todo produto da Shopee que conhecemos (vitrine,
//      captura, serie) visto nos ultimos 45 dias e consultado e reconsultado a
//      cada cfg.revisitarDias.
// A serie entra em h.diasK do monitor (fonte 'descontinho', arquivos
// precos_descontinho_AAAA-MM.json): o dia que temos vence, o do Descontinho
// preenche o buraco — igual ao Keepa.
//
// Fonte de terceiros: pode sair do ar. Queda vira aviso no grupo do operador
// (saude-fontes.js); as ofertas continuam saindo.
// ═════════════════════════════════════════════════════════════════════════════
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { importarSerieExterna, gravarShardsExternos, produtosConhecidosDaLoja, historicoDe } from './monitor-precos.js';
import { registrarOkFonte, registrarFalhaFonte, fonteFora, comPrazo, estadoFontes } from './saude-fontes.js';

const BASE = 'https://descontinho.app/api/v1';
const FONTE = 'descontinho';
const NOME = 'Descontinho (histórico da Shopee)';
const EFEITO = 'só que produto novo da Shopee é julgado sem histórico de fora';
const SESSAO_DIR = './sessao';
const ARQ = SESSAO_DIR + '/descontinho_estado.json';   // so no volume: estado do job, sem dado sensivel
const INTERVALO_MS = 1100;                             // 60 req/min por IP -> folga
const RE_ITEM_SHOPEE = /^\d{6,}$/;

const CFG_PADRAO = {
  ativo: true,
  esperaMs: 2500,        // quanto a captura espera a consulta antes de seguir sem ela
  revisitarDias: 3,      // reconsulta do mesmo produto
  vistoDias: 45,         // segundo plano: so produto visto nos ultimos N dias
  divergenciaMax: 0.5,   // preco atual de la x nossa ultima leitura (recente)
};

let _e = carregar();
let _proximaVez = 0;
const _emVoo = new Map();
let _rodando = false;
let _parar = false;
let _gravarTimer = null;

function carregar() {
  try {
    if (existsSync(ARQ)) {
      const d = JSON.parse(readFileSync(ARQ, 'utf-8'));
      return { cfg: { ...CFG_PADRAO, ...(d.cfg || {}) }, consultas: d.consultas || {}, job: d.job || null };
    }
  } catch (e) { console.warn('[DESCONTINHO] Estado ilegivel, recomecando:', e.message); }
  return { cfg: { ...CFG_PADRAO }, consultas: {}, job: null };
}
let _salvarTimer = null;
function salvar() {
  if (_salvarTimer) return;
  _salvarTimer = setTimeout(() => {
    _salvarTimer = null;
    try {
      if (!existsSync(SESSAO_DIR)) mkdirSync(SESSAO_DIR, { recursive: true });
      writeFileSync(ARQ, JSON.stringify(_e));
    } catch (e) { console.warn('[DESCONTINHO] Falha ao gravar estado:', e.message); }
  }, 5000);
  if (_salvarTimer.unref) _salvarTimer.unref();
}
function agendarGravarSerie() {
  if (_gravarTimer) return;
  _gravarTimer = setTimeout(() => {
    _gravarTimer = null;
    try { gravarShardsExternos(FONTE); } catch (e) { console.warn('[DESCONTINHO] Falha ao gravar serie:', e.message); }
  }, 60000);
  if (_gravarTimer.unref) _gravarTimer.unref();
}

const dormir = ms => new Promise(r => setTimeout(r, ms));
// Formatador unico (21/11/2026): criar um por chamada estourava a memoria nativa.
const _FMT_DIA_SP = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' });
const diaSP = ts => _FMT_DIA_SP.format(new Date(ts));

// Um pedido por vez a cada INTERVALO_MS (o que vem da captura so espera a vez).
async function vez() {
  const agora = Date.now();
  const espera = Math.max(0, _proximaVez - agora);
  _proximaVez = Math.max(agora, _proximaVez) + INTERVALO_MS;
  if (espera) await dormir(espera);
}

// ── SERIE → MINIMO DIARIO ───────────────────────────────────────────────────
// priceHistory = pontos de mudanca: o preco vale do observedAt ate o proximo
// ponto (o ultimo, ate lastReadAt). A janela observada e os observedDays antes
// do lastReadAt — o primeiro ponto pode vir de antes dela (preco carregado).
export function minimoDiarioDescontinho(p) {
  const out = {};
  const fim = Date.parse(p?.lastReadAt || '') || Date.now();
  const dias = Number(p?.observedDays);
  const ev = (Array.isArray(p?.priceHistory) ? p.priceHistory : [])
    .map(x => ({ t: Date.parse(x.observedAt || ''), v: Number(x.price) }))
    .filter(x => Number.isFinite(x.t) && x.v > 0)
    .sort((a, b) => a.t - b.t);
  const atual = Number(p?.price);
  const desde = Date.parse(p?.priceSince || '');
  if (atual > 0 && Number.isFinite(desde) && (!ev.length || ev[ev.length - 1].v !== atual) && desde >= (ev[ev.length - 1]?.t || 0)) {
    ev.push({ t: desde, v: atual });
  }
  if (!ev.length) return out;
  const ini = Number.isFinite(dias) && dias > 0 ? fim - dias * 86400000 : ev[0].t;
  for (let i = 0; i < ev.length; i++) {
    const a = Math.max(ev[i].t, ini);
    let b = i + 1 < ev.length ? ev[i + 1].t : fim;
    // Leitura unica (lastReadAt = observedAt): vale so aquele dia.
    if (b <= a) { if (i + 1 < ev.length || ev[i].t < ini) continue; b = a + 1; }
    let d = diaSP(a);
    const dFim = diaSP(b - 1);
    for (let g = 0; g < 400; g++) {
      out[d] = out[d] === undefined ? ev[i].v : Math.min(out[d], ev[i].v);
      if (d >= dFim) break;
      d = diaSP(Date.parse(d + 'T12:00:00-03:00') + 86400000);
    }
  }
  return out;
}

function conferir(id, atual) {
  let ult = null;
  try { ult = historicoDe(id)?.ult || null; } catch { ult = null; }
  const nosso = ult?.preco;
  const recente = ult?.em && Date.now() - Date.parse(ult.em) < 3 * 86400000;
  if (!Number.isFinite(atual) || !Number.isFinite(nosso) || nosso <= 0 || !recente) return { ok: true, atual, nosso: nosso ?? null, razao: null };
  const razao = Math.round((atual / nosso) * 1000) / 1000;
  const lim = _e.cfg.divergenciaMax;
  return { ok: razao >= 1 - lim && razao <= 1 + lim * 2, atual, nosso, razao };
}

// ── CONSULTA ────────────────────────────────────────────────────────────────
async function buscar(id) {
  await vez();
  let res;
  try {
    res = await fetch(BASE + '/products/' + encodeURIComponent(id), {
      headers: { Accept: 'application/json', 'User-Agent': 'TicaPromos/1.0 (+https://ticapromos.com.br)' },
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    registrarFalhaFonte(FONTE, e.name === 'TimeoutError' ? 'sem resposta em 8 s' : e.message, { nome: NOME, efeito: EFEITO });
    throw e;
  }
  if (res.status === 404) { registrarOkFonte(FONTE, { nome: NOME }); return null; }
  if (!res.ok) {
    const erro = 'HTTP ' + res.status;
    if (res.status >= 500 || res.status === 429 || res.status === 403) registrarFalhaFonte(FONTE, erro, { nome: NOME, efeito: EFEITO });
    else registrarOkFonte(FONTE, { nome: NOME });
    const e = new Error('Descontinho: ' + erro);
    e.status = res.status;
    throw e;
  }
  let dados;
  try { dados = await res.json(); }
  catch (e) { registrarFalhaFonte(FONTE, 'resposta ilegivel', { nome: NOME, efeito: EFEITO }); throw e; }
  registrarOkFonte(FONTE, { nome: NOME });
  return dados?.data || null;
}

/**
 * Consulta um produto e grava a serie. Nunca lanca.
 * @returns {{ok, motivo?, dias?, razao?}}
 */
async function consultar(id, { gravarSerie = true } = {}) {
  id = String(id || '');
  if (!RE_ITEM_SHOPEE.test(id)) return { ok: false, motivo: 'id invalido' };
  if (_emVoo.has(id)) return _emVoo.get(id);
  const p = (async () => {
    let reg;
    try {
      const prod = await buscar(id);
      if (!prod) reg = { ok: false, motivo: 'sem historico no Descontinho' };
      else {
        const serie = minimoDiarioDescontinho(prod);
        const nDias = Object.keys(serie).length;
        const c = conferir(id, Number(prod.price));
        if (!nDias) reg = { ok: false, motivo: 'serie vazia' };
        else if (!c.ok) reg = { ok: false, motivo: 'divergente (Descontinho R$ ' + c.atual + ' x nosso R$ ' + c.nosso + ')', razao: c.razao };
        else {
          const n = gravarSerie ? importarSerieExterna(id, serie, { nome: prod.title || '', loja: 'Shopee', fonte: FONTE }) : nDias;
          reg = { ok: true, dias: n, observados: prod.observedDays ?? null, razao: c.razao };
          if (gravarSerie && n) agendarGravarSerie();
        }
      }
    } catch (e) {
      reg = { ok: false, motivo: 'falha: ' + e.message, erro: true };
    }
    if (gravarSerie) { _e.consultas[id] = { ...reg, em: new Date().toISOString() }; salvar(); }
    return reg;
  })();
  _emVoo.set(id, p);
  try { return await p; } finally { _emVoo.delete(id); }
}

function consultadoHaPouco(id) {
  const c = _e.consultas[id];
  if (!c?.em) return false;
  // Falha de rede nao conta como consulta: tenta de novo na proxima captura.
  if (c.erro) return Date.now() - Date.parse(c.em) < 30 * 60000;
  return Date.now() - Date.parse(c.em) < _e.cfg.revisitarDias * 86400000;
}

/**
 * Chamado na captura, antes do filtro de disparo. Espera no maximo
 * cfg.esperaMs; nunca lanca e nunca segura a oferta alem disso.
 */
export async function historicoShopeeNaHora(id) {
  id = String(id || '');
  if (!_e.cfg.ativo || !RE_ITEM_SHOPEE.test(id) || consultadoHaPouco(id)) return { usado: false };
  // Fonte fora: nao espera. Uma tentativa em segundo plano serve de sonda.
  if (fonteFora(FONTE)) { consultar(id).catch(() => {}); return { usado: false, motivo: 'fonte fora' }; }
  const r = await comPrazo(consultar(id), _e.cfg.esperaMs, { ok: false, motivo: 'prazo estourado' });
  return { usado: !!r?.ok, ...r };
}

// ── SEGUNDO PLANO ───────────────────────────────────────────────────────────
function devidos() {
  const corte = Date.now() - _e.cfg.vistoDias * 86400000;
  return produtosConhecidosDaLoja('Shopee')
    .filter(x => RE_ITEM_SHOPEE.test(x.id) && !consultadoHaPouco(x.id))
    .filter(x => !x.vistoEm || Date.parse(x.vistoEm.length === 10 ? x.vistoEm + 'T12:00:00-03:00' : x.vistoEm) >= corte)
    .map(x => x.id);
}

async function rodarSegundoPlano() {
  if (_rodando || !_e.cfg.ativo) return;
  _rodando = true; _parar = false;
  const fila = devidos();
  const job = _e.job = { inicio: new Date().toISOString(), fim: null, total: fila.length, ok: 0, semHistorico: 0, falhas: 0 };
  try {
    for (let i = 0; i < fila.length && !_parar; i++) {
      // Fonte fora: uma sonda a cada 10 min em vez de martelar; o produto da
      // sonda que falhou fica para a proxima tentativa.
      if (fonteFora(FONTE)) await dormir(10 * 60000);
      if (_parar) break;
      const r = await consultar(fila[i]);
      if (r.erro && fonteFora(FONTE)) { job.falhas++; i--; continue; }
      if (r.ok) job.ok++; else if (r.erro) job.falhas++; else job.semHistorico++;
    }
  } finally {
    job.fim = new Date().toISOString();
    _rodando = false;
    salvar();
    if (job.ok) agendarGravarSerie();
    if (job.total) console.log('[DESCONTINHO] Segundo plano: ' + job.ok + ' com historico, ' + job.semHistorico
      + ' sem, ' + job.falhas + ' falha(s), de ' + job.total + '.');
  }
}

function podarConsultas() {
  const corte = Date.now() - 60 * 86400000;
  for (const [id, c] of Object.entries(_e.consultas)) if (!c?.em || Date.parse(c.em) < corte) delete _e.consultas[id];
}

// ── ROTAS ───────────────────────────────────────────────────────────────────
export function registrarRotasDescontinho(app, { exigeRaiz = null } = {}) {
  const soRaiz = h => (req, res) => {
    if (typeof exigeRaiz !== 'function' || !exigeRaiz(req)) return res.status(403).json({ ok: false, erro: 'somente o administrador autenticado' });
    return h(req, res);
  };

  app.get('/descontinho', soRaiz((req, res) => {
    const c = Object.values(_e.consultas);
    res.json({ ok: true, cfg: _e.cfg, rodando: _rodando, job: _e.job, saude: estadoFontes()[FONTE] || null,
               consultas: { total: c.length, comHistorico: c.filter(x => x.ok).length,
                            semHistorico: c.filter(x => !x.ok && !x.erro).length, falhas: c.filter(x => x.erro).length },
               devidosAgora: devidos().length });
  }));

  app.post('/descontinho/config', soRaiz((req, res) => {
    const b = req.body || {};
    if (typeof b.ativo === 'boolean') _e.cfg.ativo = b.ativo;
    const num = (v, min, max) => Number.isFinite(Number(v)) && Number(v) >= min && Number(v) <= max ? Number(v) : null;
    if (num(b.esperaMs, 0, 10000) !== null) _e.cfg.esperaMs = num(b.esperaMs, 0, 10000);
    if (num(b.revisitarDias, 0.5, 30) !== null) _e.cfg.revisitarDias = num(b.revisitarDias, 0.5, 30);
    if (num(b.vistoDias, 1, 120) !== null) _e.cfg.vistoDias = num(b.vistoDias, 1, 120);
    if (num(b.divergenciaMax, 0.05, 5) !== null) _e.cfg.divergenciaMax = num(b.divergenciaMax, 0.05, 5);
    salvar();
    res.json({ ok: true, cfg: _e.cfg });
  }));

  // Teste com 1 produto: mostra a serie lida e a conferencia, SEM gravar nada.
  app.post('/descontinho/teste', soRaiz(async (req, res) => {
    const id = String(req.body?.itemId || req.query.itemId || '').trim();
    if (!RE_ITEM_SHOPEE.test(id)) return res.status(400).json({ ok: false, erro: 'itemId invalido' });
    try {
      const prod = await buscar(id);
      if (!prod) return res.json({ ok: false, erro: 'sem historico no Descontinho' });
      const serie = minimoDiarioDescontinho(prod);
      const dias = Object.keys(serie).sort();
      res.json({ ok: true, itemId: id, titulo: prod.title || null, precoAtual: prod.price ?? null, dias: dias.length,
                 ultimos: dias.slice(-15).map(d => ({ d, v: serie[d] })), conferencia: conferir(id, Number(prod.price)),
                 pagina: prod.pageUrl || null });
    } catch (e) { res.status(502).json({ ok: false, erro: e.message }); }
  }));

  app.post('/descontinho/importar', soRaiz((req, res) => {
    const n = devidos().length;
    if (!_rodando) rodarSegundoPlano().catch(e => console.warn('[DESCONTINHO] Segundo plano falhou:', e.message));
    res.json({ ok: true, devidos: n, rodando: true });
  }));

  app.post('/descontinho/parar', soRaiz((req, res) => { _parar = true; res.json({ ok: true }); }));

  // Segundo plano: 3 min depois do boot (shards ja restaurados) e a cada 6 h.
  podarConsultas();
  const t1 = setTimeout(() => rodarSegundoPlano().catch(() => {}), 3 * 60000);
  const t2 = setInterval(() => { podarConsultas(); rodarSegundoPlano().catch(() => {}); }, 6 * 3600000);
  if (t1.unref) t1.unref();
  if (t2.unref) t2.unref();
}
