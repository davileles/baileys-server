// ═════════════════════════════════════════════════════════════════════════════
// keepa.js — historico de preco da Amazon vindo do Keepa (20/11/2026).
//
// Uso planejado (decisao do Davi): assinar a API do Keepa por UM mes para
//   1. importar o historico de todos os ASINs da Amazon que conhecemos
//      (vitrine, vigilancia de captura, serie) — o filtro de disparo passa a
//      julgar produto que hoje chega "sem serie";
//   2. puxar na hora o historico de ASIN novo que aparecer num grupo-fonte;
//   3. consultar as quedas recentes por categoria (endpoint /deal da API —
//      nunca a pagina do site, que e de uso pessoal).
// Depois do mes a chave sai do Railway e tudo aqui fica inerte; o historico
// importado continua nos arquivos precos_keepa_AAAA-MM.json.
//
// Chave: variavel de ambiente KEEPA_API_KEY (nunca em codigo/arquivo).
// Moeda: precos do Keepa vem em centavos; -1 = sem oferta.
// Tempo: "minutos Keepa" = minutos desde 2011-01-01 (unix_ms = (t + 21564000) * 60000).
// Dominio 12 = amazon.com.br.
// ═════════════════════════════════════════════════════════════════════════════
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import {
  importarSerieKeepa, gravarShardsKeepa, asinsAmazonConhecidos, definirGanchoCaptura,
  vereditoLinhas, historicoDe,
} from './monitor-precos.js';

const BASE = 'https://api.keepa.com';
const DOMINIO_BR = 12;
const KEEPA_EPOCA_MIN = 21564000;
const SESSAO_DIR = './sessao';
const ARQ = SESSAO_DIR + '/keepa_estado.json';   // so no volume: estado do job, sem dado sensivel
const DIAS_HISTORICO = 120;
const LOTE_MAX = 100;

const CFG_PADRAO = {
  // Fonte do minimo diario: 'menor' = menor entre vendido pela Amazon e novo de
  // terceiros (o mais proximo do preco em destaque que a nossa leitura pega),
  // 'amazon' = so vendido pela Amazon, 'novo' = so terceiros.
  fonte: 'menor',
  capturaNaHora: true,      // ASIN novo da captura vai para a fila do import
  // Quedas por categoria (endpoint /deal). Ids de categoria da amazon.com.br.
  quedas: { categorias: [], deltaMinPct: 20, periodo: 0 },
  // Divergencia tolerada entre o preco atual do Keepa e a nossa ultima leitura
  // antes de recusar o historico do produto (unidade errada, variacao trocada).
  divergenciaMax: 0.5,
};

let _e = carregar();
let _rodando = false;
let _parar = false;

function carregar() {
  try {
    if (existsSync(ARQ)) {
      const d = JSON.parse(readFileSync(ARQ, 'utf-8'));
      return { cfg: { ...CFG_PADRAO, ...(d.cfg || {}), quedas: { ...CFG_PADRAO.quedas, ...(d.cfg?.quedas || {}) } },
               fila: Array.isArray(d.fila) ? d.fila : [], job: d.job || null, tokens: d.tokens || null,
               resultados: d.resultados || {} };
    }
  } catch (e) { console.warn('[KEEPA] Estado ilegivel, recomecando:', e.message); }
  return { cfg: { ...CFG_PADRAO, quedas: { ...CFG_PADRAO.quedas } }, fila: [], job: null, tokens: null, resultados: {} };
}
function salvar() {
  try {
    if (!existsSync(SESSAO_DIR)) mkdirSync(SESSAO_DIR, { recursive: true });
    writeFileSync(ARQ, JSON.stringify(_e));
  } catch (e) { console.warn('[KEEPA] Falha ao gravar estado:', e.message); }
}

function chave() { return String(process.env.KEEPA_API_KEY || '').trim(); }
export function keepaConfigurado() { return !!chave(); }

const dormir = ms => new Promise(r => setTimeout(r, ms));
const diaSP = ts => new Date(ts).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
const tsKeepa = t => (Number(t) + KEEPA_EPOCA_MIN) * 60000;

async function chamar(caminho, params = {}, { metodo = 'GET', corpo = null } = {}) {
  const k = chave();
  if (!k) throw new Error('KEEPA_API_KEY nao configurada no Railway');
  const qs = new URLSearchParams({ key: k, ...params });
  const res = await fetch(BASE + caminho + '?' + qs.toString(), {
    method: metodo,
    headers: corpo ? { 'Content-Type': 'application/json' } : undefined,
    body: corpo ? JSON.stringify(corpo) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  let dados = null;
  try { dados = await res.json(); } catch { dados = null; }
  if (dados && Number.isFinite(dados.tokensLeft)) {
    _e.tokens = { restantes: dados.tokensLeft, recargaEmMs: dados.refillIn ?? null,
                  porMinuto: dados.refillRate ?? null, consumidos: dados.tokensConsumed ?? null,
                  em: new Date().toISOString() };
  }
  if (!res.ok) {
    const msg = dados?.error?.message || dados?.error?.type || ('HTTP ' + res.status);
    const e = new Error('Keepa: ' + msg);
    e.status = res.status;
    throw e;
  }
  return dados;
}

// ── HISTORICO → MINIMO DIARIO ───────────────────────────────────────────────
// O csv do Keepa e uma lista de eventos [t0, p0, t1, p1, ...]: o preco p_i vale
// de t_i ate t_{i+1}. O minimo do dia e o menor preco que esteve ativo naquele
// dia, inclusive o que veio carregado do evento anterior.
function minimoDiario(csv, desdeTs) {
  const out = {};
  if (!Array.isArray(csv) || csv.length < 2) return out;
  const agora = Date.now();
  for (let i = 0; i + 1 < csv.length; i += 2) {
    const ini = tsKeepa(csv[i]);
    const fim = i + 2 < csv.length ? tsKeepa(csv[i + 2]) : agora;
    const p = Number(csv[i + 1]);
    if (!(p > 0) || fim < desdeTs) continue;
    let t = Math.max(ini, desdeTs);
    let d = diaSP(t);
    const dFim = diaSP(Math.max(t, fim - 1));
    for (let g = 0; g < 400; g++) {
      const v = p / 100;
      out[d] = out[d] === undefined ? v : Math.min(out[d], v);
      if (d >= dFim) break;
      t = Date.parse(d + 'T12:00:00-03:00') + 86400000;
      d = diaSP(t);
    }
  }
  return out;
}

function serieDoProduto(prod, fonte) {
  const desde = Date.now() - DIAS_HISTORICO * 86400000;
  const amazon = minimoDiario(prod?.csv?.[0], desde);
  const novo = minimoDiario(prod?.csv?.[1], desde);
  if (fonte === 'amazon') return amazon;
  if (fonte === 'novo') return novo;
  const out = { ...novo };
  for (const [d, v] of Object.entries(amazon)) out[d] = out[d] === undefined ? v : Math.min(out[d], v);
  return out;
}

function precoAtualKeepa(serie) {
  const dias = Object.keys(serie).sort();
  return dias.length ? serie[dias[dias.length - 1]] : null;
}

// Confere o historico contra a nossa ultima leitura: unidade errada ou
// variacao trocada aparecem aqui como razao absurda.
function conferir(asin, serie) {
  const atual = precoAtualKeepa(serie);
  let nosso = null;
  try { nosso = historicoDe(asin)?.ult?.preco ?? null; } catch { nosso = null; }
  if (!Number.isFinite(atual) || !Number.isFinite(nosso) || nosso <= 0) return { ok: true, atual, nosso, razao: null };
  const razao = Math.round((atual / nosso) * 1000) / 1000;
  const lim = _e.cfg.divergenciaMax;
  return { ok: razao >= 1 - lim && razao <= 1 + lim * 2, atual, nosso, razao };
}

async function buscarProdutos(asins) {
  const d = await chamar('/product', { domain: String(DOMINIO_BR), asin: asins.join(','), days: String(DIAS_HISTORICO) });
  return Array.isArray(d?.products) ? d.products : [];
}

function aplicarProduto(prod, { gravarSerie = true } = {}) {
  const asin = prod?.asin;
  if (!asin) return { asin: null, ok: false, motivo: 'sem asin' };
  const serie = serieDoProduto(prod, _e.cfg.fonte);
  const dias = Object.keys(serie).length;
  if (!dias) return { asin, ok: false, motivo: 'sem historico de preco no Keepa' };
  const c = conferir(asin, serie);
  if (!c.ok) return { asin, ok: false, motivo: 'divergente (Keepa R$ ' + c.atual + ' x nosso R$ ' + c.nosso + ')', ...c, dias };
  const n = gravarSerie ? importarSerieKeepa(asin, serie, { nome: prod.title || '' }) : dias;
  return { asin, ok: true, dias: n, ...c };
}

// ── JOB DE IMPORTACAO ───────────────────────────────────────────────────────
export function montarFila({ reimportar = false, limite = null } = {}) {
  const conhecidos = asinsAmazonConhecidos();
  const ja = new Set(_e.fila);
  let novos = conhecidos.filter(x => (reimportar || !x.importadoEm) && !ja.has(x.asin)).map(x => x.asin);
  if (Number.isFinite(limite) && limite > 0) novos = novos.slice(0, limite);
  _e.fila.push(...novos);
  salvar();
  return { adicionados: novos.length, naFila: _e.fila.length, conhecidos: conhecidos.length };
}

async function rodarFila() {
  if (_rodando) return;
  _rodando = true; _parar = false;
  const job = _e.job = { inicio: new Date().toISOString(), fim: null, ok: 0, falhas: 0, recusados: 0, erros: [], ultimoLote: null };
  salvar();
  try {
    while (_e.fila.length && !_parar) {
      if (!chave()) { job.erros.push('chave removida'); break; }
      const disp = _e.tokens?.restantes;
      // Sem saldo conhecido: lote pequeno para descobrir. Saldo baixo: espera a recarga.
      let tam = Number.isFinite(disp) ? Math.min(LOTE_MAX, Math.max(0, disp)) : 10;
      if (tam < 1) { await dormir(Math.min(Math.max(_e.tokens?.recargaEmMs || 60000, 5000), 120000)); _e.tokens.restantes = null; continue; }
      const lote = _e.fila.slice(0, tam);
      let prods;
      try { prods = await buscarProdutos(lote); }
      catch (e) {
        if (e.status === 429) { await dormir(60000); continue; }
        job.falhas++;
        if (job.erros.length < 20) job.erros.push(e.message);
        if (job.falhas >= 5) break;
        await dormir(30000);
        continue;
      }
      const vistos = new Set();
      for (const p of prods) {
        vistos.add(p.asin);
        const r = aplicarProduto(p);
        _e.resultados[p.asin] = { ok: r.ok, motivo: r.motivo || null, dias: r.dias || 0, razao: r.razao ?? null, em: new Date().toISOString() };
        if (r.ok) job.ok++; else job.recusados++;
      }
      for (const a of lote) if (!vistos.has(a)) _e.resultados[a] = { ok: false, motivo: 'Keepa nao devolveu', em: new Date().toISOString() };
      _e.fila.splice(0, lote.length);
      job.ultimoLote = { em: new Date().toISOString(), tamanho: lote.length, devolvidos: prods.length };
      gravarShardsKeepa();
      salvar();
      await dormir(1500);
    }
  } finally {
    job.fim = new Date().toISOString();
    _rodando = false;
    salvar();
    console.log('[KEEPA] Import ' + (_parar ? 'parado' : 'concluido') + ' — ' + job.ok + ' ok, ' + job.recusados
      + ' recusado(s), ' + job.falhas + ' falha(s), ' + _e.fila.length + ' na fila.');
  }
}

// ── QUEDAS POR CATEGORIA (endpoint /deal) ───────────────────────────────────
// So LEITURA: devolve a lista com o veredito das nossas linhas ao lado. O
// disparo continua passando pelo radar da Amazon (link de afiliado, preco
// relido na Creators API, filtro, nota) — nada sai daqui direto para grupo.
export async function quedasPorCategoria({ categoria = null, deltaMinPct = null, periodo = null, pagina = 0 } = {}) {
  const q = _e.cfg.quedas;
  const cats = categoria ? [Number(categoria)] : (q.categorias || []).map(Number).filter(Boolean);
  const selecao = {
    page: Number(pagina) || 0,
    domainId: DOMINIO_BR,
    priceTypes: [0],
    dateRange: Number.isFinite(Number(periodo)) && periodo !== null ? Number(periodo) : q.periodo,
    deltaPercentRange: [Number(deltaMinPct ?? q.deltaMinPct) || 20, 100],
    isRangeEnabled: true,
    isFilterEnabled: true,
    sortType: 4,
  };
  if (cats.length) selecao.includeCategories = cats;
  const d = await chamar('/deal', {}, { metodo: 'POST', corpo: selecao });
  const lista = Array.isArray(d?.deals?.dr) ? d.deals.dr : [];
  return {
    selecao, tokens: _e.tokens, total: lista.length,
    itens: lista.map(x => {
      const cur = Array.isArray(x.current) ? x.current : [];
      const preco = [cur[0], cur[1]].filter(v => Number(v) > 0).map(v => v / 100).sort((a, b) => a - b)[0] ?? null;
      let linhas = null;
      try { linhas = preco ? vereditoLinhas(x.asin, preco) : null; } catch { linhas = null; }
      return { asin: x.asin, titulo: x.title || '', preco, quedaPct: Array.isArray(x.deltaPercent) ? x.deltaPercent : null,
               categorias: x.categories || null, link: 'https://www.amazon.com.br/dp/' + x.asin,
               linhas: linhas ? { classe: linhas.classe, motivo: linhas.motivo, descontoRealPct: linhas.descontoRealPct ?? null } : null };
    }),
  };
}

// ── ROTAS ───────────────────────────────────────────────────────────────────
export function registrarRotasKeepa(app) {
  // ASIN novo na vigilancia de captura -> fila do import (so com chave e config ligada).
  definirGanchoCaptura((asin, loja) => {
    if (loja !== 'Amazon' || !chave() || !_e.cfg.capturaNaHora) return;
    if (_e.resultados[asin]?.ok || _e.fila.includes(asin)) return;
    _e.fila.push(asin);
    salvar();
    if (!_rodando) setTimeout(() => rodarFila().catch(e => console.warn('[KEEPA] Fila falhou:', e.message)), 5000);
  });

  app.get('/keepa', (req, res) => {
    const r = Object.values(_e.resultados);
    res.json({ ok: true, configurado: keepaConfigurado(), rodando: _rodando, cfg: _e.cfg, tokens: _e.tokens,
               naFila: _e.fila.length, job: _e.job,
               resultados: { total: r.length, ok: r.filter(x => x.ok).length, recusados: r.filter(x => !x.ok).length,
                             exemplosRecusados: Object.entries(_e.resultados).filter(([, x]) => !x.ok).slice(0, 15)
                               .map(([asin, x]) => ({ asin, motivo: x.motivo })) } });
  });

  app.post('/keepa/config', (req, res) => {
    const b = req.body || {};
    if (['menor', 'amazon', 'novo'].includes(b.fonte)) _e.cfg.fonte = b.fonte;
    if (typeof b.capturaNaHora === 'boolean') _e.cfg.capturaNaHora = b.capturaNaHora;
    if (Number.isFinite(Number(b.divergenciaMax)) && b.divergenciaMax > 0 && b.divergenciaMax < 5) _e.cfg.divergenciaMax = Number(b.divergenciaMax);
    if (b.quedas && typeof b.quedas === 'object') {
      if (Array.isArray(b.quedas.categorias)) _e.cfg.quedas.categorias = b.quedas.categorias.map(Number).filter(Boolean);
      if (Number.isFinite(Number(b.quedas.deltaMinPct))) _e.cfg.quedas.deltaMinPct = Number(b.quedas.deltaMinPct);
      if ([0, 1, 2, 3].includes(Number(b.quedas.periodo))) _e.cfg.quedas.periodo = Number(b.quedas.periodo);
    }
    salvar();
    res.json({ ok: true, cfg: _e.cfg });
  });

  // Teste com 1 ASIN: mostra a serie lida e a conferencia, SEM gravar nada.
  app.post('/keepa/teste', async (req, res) => {
    try {
      const asin = String(req.body?.asin || req.query.asin || '').trim().toUpperCase();
      if (!/^B[A-Z0-9]{9}$/.test(asin)) return res.status(400).json({ ok: false, erro: 'asin invalido' });
      const [p] = await buscarProdutos([asin]);
      if (!p) return res.json({ ok: false, erro: 'Keepa nao devolveu o produto', tokens: _e.tokens });
      const serie = serieDoProduto(p, _e.cfg.fonte);
      const c = conferir(asin, serie);
      const dias = Object.keys(serie).sort();
      res.json({ ok: true, asin, titulo: p.title || null, fonte: _e.cfg.fonte, dias: dias.length,
                 ultimos: dias.slice(-15).map(d => ({ d, v: serie[d] })), conferencia: c, tokens: _e.tokens });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message, tokens: _e.tokens }); }
  });

  app.post('/keepa/importar', (req, res) => {
    if (!chave()) return res.status(400).json({ ok: false, erro: 'KEEPA_API_KEY nao configurada' });
    const f = montarFila({ reimportar: req.body?.reimportar === true, limite: Number(req.body?.limite) || null });
    if (!_rodando) rodarFila().catch(e => console.warn('[KEEPA] Import falhou:', e.message));
    res.json({ ok: true, ...f, rodando: true });
  });

  app.post('/keepa/parar', (req, res) => { _parar = true; res.json({ ok: true, naFila: _e.fila.length }); });

  app.get('/keepa/quedas', async (req, res) => {
    try { res.json({ ok: true, ...(await quedasPorCategoria({ categoria: req.query.categoria || null,
      deltaMinPct: req.query.min ?? null, periodo: req.query.periodo ?? null, pagina: req.query.pagina || 0 })) }); }
    catch (e) { res.status(500).json({ ok: false, erro: e.message, tokens: _e.tokens }); }
  });

  // Busca de categoria (para achar o id de Bebidas, Ferramentas...).
  app.get('/keepa/categorias', async (req, res) => {
    try {
      const termo = String(req.query.termo || '').trim();
      if (!termo) return res.status(400).json({ ok: false, erro: 'informe ?termo=' });
      const d = await chamar('/search', { domain: String(DOMINIO_BR), type: 'category', term: termo });
      const cats = Object.values(d?.categories || {}).map(c => ({ id: c.catId, nome: c.name, pai: c.parent ?? null, produtos: c.productCount ?? null }));
      res.json({ ok: true, categorias: cats, tokens: _e.tokens });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message, tokens: _e.tokens }); }
  });

  // Fila que ficou de um boot anterior volta a rodar sozinha (so com chave).
  if (chave() && _e.fila.length) setTimeout(() => rodarFila().catch(() => {}), 90000);
}
