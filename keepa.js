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
  vereditoLinhas, historicoDe, epcDe, avaliarAgoraAmazon, registrarReferenciaLonga,
} from './monitor-precos.js';
import { registrarOkFonte, registrarFalhaFonte, fonteFora, estadoFontes } from './saude-fontes.js';

// Saude (21/11/2026): queda do Keepa avisa o grupo do operador; as ofertas
// seguem saindo sem o historico dele (regra do Davi).
const NOME_FONTE = 'Keepa (histórico da Amazon)';
const EFEITO_QUEDA = 'só que produto novo da Amazon é julgado sem histórico de fora';
const falhaKeepa = (erro, grave = false) => registrarFalhaFonte('keepa', erro, { nome: NOME_FONTE, grave, efeito: EFEITO_QUEDA });

const BASE = 'https://api.keepa.com';
const DOMINIO_BR = 12;
const KEEPA_EPOCA_MIN = 21564000;
const SESSAO_DIR = './sessao';
const ARQ = SESSAO_DIR + '/keepa_estado.json';   // so no volume: estado do job, sem dado sensivel
const DIAS_HISTORICO = 120;
// Referencia longa (21/11/2026): o pedido traz 12 meses (mesmo custo de token:
// o Keepa cobra por produto, nao por dia). A serie diaria continua com 120 dias;
// dos 12 meses sai so a mediana e o preco de tabela (LISTPRICE, csv[4]).
const DIAS_REF_LONGA = 365;
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
  // Tokens que o import em lote deixa livres: a consulta na hora (produto novo
  // capturado) e o radar passam na frente do import (21/11/2026).
  reservaTokens: 60,
  consultaNaHora: { ativo: true, esperaMs: 3000 },
  // Radar (21/11/2026, decisao do Davi: ATIVO): o /deal aponta quedas por
  // categoria; cada ASIN novo ganha o historico do Keepa e passa pela mesma
  // avaliacao do monitor + linhas de preco (so imperdivel/boa). O candidato vai
  // para a fila do publicador do monitor (modo, janela, cota, roteamento).
  // Preco de vitrine (21/11/2026, decisao do Davi): dia de preco so entra no
  // historico se houve sinal de venda perto dele (ranking de vendas da Amazon
  // melhorou em ate 'janelaDias'). Meses parados num preco que ninguem pagava
  // nao viram "preco normal". Sem dado de ranking no Keepa = nao filtra.
  filtroVendas: { ativo: true, janelaDias: 7 },
  radar: {
    ativo: true, intervaloMin: 20, inicio: 8, fim: 21, periodo: 1, porCategoria: 20, dedupeHoras: 24,
    maxCandidatos: 5,   // teto de candidatos por rodada (21/11/2026)
    categorias: [
      { nome: 'Bebidas', id: 19778003011, deltaMinPct: 15 },
      { nome: 'Bebês', id: 17242603011, deltaMinPct: 20 },
      { nome: 'Ferramentas', id: 16957182011, deltaMinPct: 20 },
      { nome: 'Gerais', id: null, deltaMinPct: 30 },   // sem categoria, criterio mais duro; exclui as de cima
    ],
  },
};

let _e = carregar();
let _rodando = false;
let _parar = false;

function carregar() {
  try {
    if (existsSync(ARQ)) {
      const d = JSON.parse(readFileSync(ARQ, 'utf-8'));
      return { cfg: { ...CFG_PADRAO, ...(d.cfg || {}), quedas: { ...CFG_PADRAO.quedas, ...(d.cfg?.quedas || {}) },
                      consultaNaHora: { ...CFG_PADRAO.consultaNaHora, ...(d.cfg?.consultaNaHora || {}) },
                      radar: { ...CFG_PADRAO.radar, ...(d.cfg?.radar || {}) },
                      filtroVendas: { ...CFG_PADRAO.filtroVendas, ...(d.cfg?.filtroVendas || {}) } },
               fila: Array.isArray(d.fila) ? d.fila : [], job: d.job || null, tokens: d.tokens || null,
               resultados: d.resultados || {}, radar: d.radar || { vistos: {}, ultima: null, historico: [] },
               migracoes: d.migracoes || {} };
    }
  } catch (e) { console.warn('[KEEPA] Estado ilegivel, recomecando:', e.message); }
  return { cfg: { ...CFG_PADRAO, quedas: { ...CFG_PADRAO.quedas }, consultaNaHora: { ...CFG_PADRAO.consultaNaHora },
                 radar: { ...CFG_PADRAO.radar }, filtroVendas: { ...CFG_PADRAO.filtroVendas } },
           fila: [], job: null, tokens: null, resultados: {}, radar: { vistos: {}, ultima: null, historico: [] } };
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
  let res;
  try {
    res = await fetch(BASE + caminho + '?' + qs.toString(), {
      method: metodo,
      headers: corpo ? { 'Content-Type': 'application/json' } : undefined,
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout(60000),
    });
  } catch (e) {
    falhaKeepa(e.name === 'TimeoutError' ? 'sem resposta em 60 s' : e.message);
    throw e;
  }
  let dados = null;
  try { dados = await res.json(); } catch { dados = null; }
  // 429 = so o saldo de tokens acabou (o job espera a recarga): nao e queda.
  // 401/402/403 = chave ou assinatura recusada: nao volta sozinho, avisa ja.
  if (res.ok) registrarOkFonte('keepa', { nome: NOME_FONTE });
  else if ([401, 402, 403].includes(res.status)) falhaKeepa('HTTP ' + res.status + ' — ' + (dados?.error?.message || 'chave ou assinatura recusada'), true);
  else if (res.status >= 500 || !dados) falhaKeepa('HTTP ' + res.status);
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

// Dias com sinal de venda: o ranking de vendas (csv[3]) so MELHORA quando o
// produto vende; parado ou piorando por semanas = ninguem comprando.
function diasComVenda(csvRank, desdeTs) {
  if (!Array.isArray(csvRank) || csvRank.length < 4) return null;   // sem dado: nao julga
  const out = new Set();
  let ant = null;
  for (let i = 0; i + 1 < csvRank.length; i += 2) {
    const r = Number(csvRank[i + 1]);
    if (!(r > 0)) { ant = null; continue; }
    const ts = tsKeepa(csvRank[i]);
    if (ant !== null && r < ant && ts >= desdeTs - 14 * 86400000) out.add(diaSP(ts));
    ant = r;
  }
  return out;
}

function filtrarPorVendas(serie, vendas, janelaDias) {
  if (!vendas) return { serie, removidos: 0 };
  const lista = [...vendas].map(d => Date.parse(d + 'T12:00:00-03:00')).sort((a, b) => a - b);
  const jan = Math.max(1, Number(janelaDias) || 7) * 86400000;
  const corteRecente = diaSP(Date.now() - 2 * 86400000);   // os 2 ultimos dias ficam sempre
  const out = {};
  let removidos = 0;
  for (const [d, v] of Object.entries(serie)) {
    if (d >= corteRecente) { out[d] = v; continue; }
    const t = Date.parse(d + 'T12:00:00-03:00');
    if (lista.some(x => Math.abs(x - t) <= jan)) out[d] = v; else removidos++;
  }
  return { serie: out, removidos };
}

function serieDoProduto(prod, fonte, dias = DIAS_HISTORICO) {
  const desde = Date.now() - dias * 86400000;
  const amazon = minimoDiario(prod?.csv?.[0], desde);
  const novo = minimoDiario(prod?.csv?.[1], desde);
  let out;
  if (fonte === 'amazon') out = amazon;
  else if (fonte === 'novo') out = novo;
  else {
    out = { ...novo };
    for (const [d, v] of Object.entries(amazon)) out[d] = out[d] === undefined ? v : Math.min(out[d], v);
  }
  const fv = _e.cfg.filtroVendas || {};
  if (fv.ativo === false) return out;
  const r = filtrarPorVendas(out, diasComVenda(prod?.csv?.[3], desde), fv.janelaDias);
  serieDoProduto.ultimoRemovidos = r.removidos;
  return r.serie;
}

// Ultimo valor de um csv do Keepa (-1 = sem valor).
function ultimoValorCsv(csv) {
  if (!Array.isArray(csv) || csv.length < 2) return null;
  const v = Number(csv[csv.length - 1]);
  return v > 0 ? v / 100 : null;
}
function referenciaLonga(prod, fonte) {
  const serie = serieDoProduto(prod, fonte, DIAS_REF_LONGA);
  const hoje = diaSP(Date.now());
  const vals = Object.entries(serie).filter(([d]) => d < hoje).map(([, v]) => v).sort((a, b) => a - b);
  const n = vals.length;
  const m365 = n ? (n % 2 ? vals[(n - 1) / 2] : (vals[n / 2 - 1] + vals[n / 2]) / 2) : null;
  return { m365, n365: n, lista: ultimoValorCsv(prod?.csv?.[4]) };
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
  const d = await chamar('/product', { domain: String(DOMINIO_BR), asin: asins.join(','), days: String(DIAS_REF_LONGA) });
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
  const semVenda = serieDoProduto.ultimoRemovidos || 0;
  const n = gravarSerie ? importarSerieKeepa(asin, serie, { nome: prod.title || '' }) : dias;
  let ref = null;
  if (gravarSerie) {
    try { ref = referenciaLonga(prod, _e.cfg.fonte); registrarReferenciaLonga(asin, ref); }
    catch (e) { console.warn('[KEEPA] Referencia longa de ' + asin + ':', e.message); }
  }
  return { asin, ok: true, dias: n, diasSemVenda: semVenda, ref, ...c };
}

// ── JOB DE IMPORTACAO ───────────────────────────────────────────────────────
// Produto com clique no nosso link (ledger de EPC) vai primeiro: e o que a
// gente ja sabe que vende. Ordem estavel para o resto.
function cliquesDe(asin) { try { return epcDe(asin)?.cliques || 0; } catch { return 0; } }
function ordenarFilaPorCliques() {
  const pos = new Map(_e.fila.map((a, i) => [a, i]));
  _e.fila.sort((a, b) => (cliquesDe(b) - cliquesDe(a)) || (pos.get(a) - pos.get(b)));
}

let _shardTimer = null;
function agendarShards() {
  if (_shardTimer) return;
  _shardTimer = setTimeout(() => { _shardTimer = null; try { gravarShardsKeepa(); } catch (e) { console.warn('[KEEPA] Shards:', e.message); } }, 60000);
  if (_shardTimer.unref) _shardTimer.unref();
}

function registrarResultado(asin, r) {
  // v:2 = lido ja com o pedido de 12 meses (21/11/2026): recusado ou sem
  // historico nao volta para a fila a cada deploy so por faltar a referencia.
  _e.resultados[asin] = { ok: r.ok, motivo: r.motivo || null, dias: r.dias || 0, razao: r.razao ?? null, em: new Date().toISOString(), v: 2 };
  const i = _e.fila.indexOf(asin);
  if (i >= 0) _e.fila.splice(i, 1);
}
export function montarFila({ reimportar = false, limite = null } = {}) {
  const conhecidos = asinsAmazonConhecidos();
  const ja = new Set(_e.fila);
  // Sem referencia longa (importado antes de 21/11/2026) tambem entra: a fila
  // re-le o produto uma vez para trazer os 12 meses e o preco de tabela.
  let novos = conhecidos.filter(x => (reimportar || !x.importadoEm || (!x.refEm && _e.resultados[x.asin]?.v !== 2)) && !ja.has(x.asin)).map(x => x.asin);
  if (Number.isFinite(limite) && limite > 0) novos = novos.slice(0, limite);
  _e.fila.push(...novos);
  ordenarFilaPorCliques();
  salvar();
  return { adicionados: novos.length, naFila: _e.fila.length, conhecidos: conhecidos.length };
}

async function rodarFila() {
  if (_rodando) return;
  _rodando = true; _parar = false;
  const job = _e.job = { inicio: new Date().toISOString(), fim: null, ok: 0, falhas: 0, recusados: 0, erros: [], ultimoLote: null };
  ordenarFilaPorCliques();
  salvar();
  try {
    while (_e.fila.length && !_parar) {
      if (!chave()) { job.erros.push('chave removida'); break; }
      const disp = _e.tokens?.restantes;
      // Sem saldo conhecido: lote pequeno para descobrir. Saldo baixo: espera a recarga.
      const reserva = Math.max(0, Number(_e.cfg.reservaTokens) || 0);
      let tam = Number.isFinite(disp) ? Math.min(LOTE_MAX, Math.max(0, disp - reserva)) : 10;
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
        registrarResultado(p.asin, r);
        if (r.ok) job.ok++; else job.recusados++;
      }
      for (const a of lote) if (!vistos.has(a)) registrarResultado(a, { ok: false, motivo: 'Keepa nao devolveu' });
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

// ── CONSULTA NA HORA (21/11/2026) ───────────────────────────────────────────
// Produto da Amazon capturado num grupo-fonte sem historico do Keepa: busca o
// historico ANTES do filtro de disparo julgar (1 token). Espera no maximo
// esperaMs; passou disso, o filtro segue com o que tem e o historico chega
// para a proxima vez. Nunca lanca erro.
const _emVoo = new Map();
export async function consultarKeepaAgora(asin, esperaMs = null) {
  try {
    asin = String(asin || '').trim().toUpperCase();
    const cn = _e.cfg.consultaNaHora || {};
    if (!/^B[A-Z0-9]{9}$/.test(asin) || !chave() || cn.ativo === false) return { consultou: false, motivo: 'desligado' };
    if (fonteFora('keepa')) return { consultou: false, motivo: 'Keepa fora do ar (aviso no grupo do operador)' };
    const r0 = _e.resultados[asin];
    if (r0 && (r0.ok || (Date.now() - Date.parse(r0.em || 0)) < 7 * 86400000)) return { consultou: false, motivo: 'ja consultado', ok: !!r0.ok };
    if (Number.isFinite(_e.tokens?.restantes) && _e.tokens.restantes < 1
        && (Date.now() - Date.parse(_e.tokens.em || 0)) < 60000) return { consultou: false, motivo: 'sem token' };
    let p = _emVoo.get(asin);
    if (!p) {
      p = (async () => {
        const [prod] = await buscarProdutos([asin]);
        const r = prod ? aplicarProduto(prod) : { ok: false, motivo: 'Keepa nao devolveu' };
        registrarResultado(asin, r);
        agendarShards(); salvar();
        return r;
      })().catch(e => ({ ok: false, motivo: e.message })).finally(() => _emVoo.delete(asin));
      _emVoo.set(asin, p);
    }
    const lim = Number(esperaMs ?? cn.esperaMs) || 3000;
    const r = await Promise.race([p, dormir(lim).then(() => null)]);
    if (!r) return { consultou: true, motivo: 'demorou mais que ' + lim + ' ms (segue em segundo plano)' };
    return { consultou: true, ok: r.ok, dias: r.dias || 0, motivo: r.motivo || null };
  } catch (e) { return { consultou: false, motivo: e.message }; }
}

// ── RADAR (21/11/2026, ATIVO) ───────────────────────────────────────────────
let _radarRodando = false;
function horaSP() { return Number(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false })) % 24; }

async function dealsDaCategoria(cat, rc, excluir) {
  const selecao = {
    page: 0, domainId: DOMINIO_BR, priceTypes: [0],
    dateRange: [0, 1, 2, 3].includes(Number(rc.periodo)) ? Number(rc.periodo) : 1,
    deltaPercentRange: [Number(cat.deltaMinPct) || 20, 100],
    isRangeEnabled: true, isFilterEnabled: true, sortType: 4,
  };
  if (cat.id) selecao.includeCategories = [Number(cat.id)];
  else if (excluir.length) selecao.excludeCategories = excluir;
  const d = await chamar('/deal', {}, { metodo: 'POST', corpo: selecao });
  return (Array.isArray(d?.deals?.dr) ? d.deals.dr : []).map(x => {
    const cur = Array.isArray(x.current) ? x.current : [];
    return { asin: x.asin, titulo: x.title || '', preco: Number(cur[0]) > 0 ? cur[0] / 100 : null,
             quedaPct: Array.isArray(x.deltaPercent) ? x.deltaPercent : null };
  });
}

export async function rodarRadarKeepa({ manual = false } = {}) {
  const rc = _e.cfg.radar || {};
  if (_radarRodando) return { ok: false, erro: 'radar ja rodando' };
  if (!chave()) return { ok: false, erro: 'KEEPA_API_KEY nao configurada' };
  if (!manual && rc.ativo === false) return { ok: false, erro: 'radar desligado' };
  _radarRodando = true;
  const t0 = Date.now();
  const rel = { em: new Date().toISOString(), manual, porCategoria: {}, novos: 0, historicos: 0, avaliacao: null, erros: [] };
  try {
    const agora = Date.now();
    const ttl = (Number(rc.dedupeHoras) || 24) * 3600000;
    const vistos = _e.radar.vistos || (_e.radar.vistos = {});
    for (const [a, ts] of Object.entries(vistos)) if (agora - ts > ttl) delete vistos[a];
    const cats = Array.isArray(rc.categorias) ? rc.categorias : [];
    const excluir = cats.filter(x => x.id).map(x => Number(x.id));
    const escolhidos = new Map();
    for (const cat of cats) {
      try {
        const lista = await dealsDaCategoria(cat, rc, excluir);
        const novos = lista.filter(x => x.asin && x.preco && !vistos[x.asin] && !escolhidos.has(x.asin))
          .slice(0, Number(rc.porCategoria) || 20);
        for (const x of novos) escolhidos.set(x.asin, { ...x, categoria: cat.nome });
        rel.porCategoria[cat.nome] = { quedas: lista.length, novos: novos.length };
      } catch (e) {
        rel.porCategoria[cat.nome] = { erro: e.message };
        if (rel.erros.length < 10) rel.erros.push(cat.nome + ': ' + e.message);
      }
    }
    const itens = [...escolhidos.values()];
    rel.novos = itens.length;
    // Historico do Keepa para quem ainda nao tem (o radar pode usar a reserva).
    // Sempre rebusca: o historico precisa vir com o filtro de vendas e fresco.
    const semHist = itens.map(x => x.asin);
    for (let i = 0; i < semHist.length; i += LOTE_MAX) {
      const lote = semHist.slice(i, i + LOTE_MAX);
      try {
        const prods = await buscarProdutos(lote);
        for (const p of prods) { const r = aplicarProduto(p); registrarResultado(p.asin, r); if (r.ok) rel.historicos++; }
      } catch (e) { if (rel.erros.length < 10) rel.erros.push('historico: ' + e.message); }
    }
    if (semHist.length) agendarShards();
    for (const x of itens) vistos[x.asin] = agora;
    if (itens.length) {
      rel.avaliacao = await avaliarAgoraAmazon(itens.map(x => ({ asin: x.asin, nome: x.titulo })),
        { maxCandidatos: Number(rc.maxCandidatos) || null });
      const ok = new Set((rel.avaliacao.aprovados || []).map(a => a.asin));
      rel.candidatos = itens.filter(x => ok.has(x.asin)).map(x => ({ asin: x.asin, titulo: x.titulo.slice(0, 80), categoria: x.categoria,
        preco: x.preco, classe: (rel.avaliacao.aprovados.find(a => a.asin === x.asin) || {}).classe || null }));
    }
    rel.duracaoSeg = Math.round((Date.now() - t0) / 1000);
    rel.tokens = _e.tokens?.restantes ?? null;
    _e.radar.ultima = rel;
    _e.radar.historico = [{ em: rel.em, novos: rel.novos, candidatos: (rel.candidatos || []).length }, ...(_e.radar.historico || [])].slice(0, 200);
    salvar();
    console.log('[KEEPA] Radar — ' + rel.novos + ' queda(s) nova(s), ' + (rel.candidatos || []).length + ' candidato(s) para o publicador'
      + Object.entries(rel.porCategoria).map(([k, v]) => ' · ' + k + ' ' + (v.erro ? 'erro' : v.novos + '/' + v.quedas)).join(''));
    return { ok: true, ...rel };
  } finally { _radarRodando = false; }
}

let _radarTimer = null;
function iniciarRadar() {
  if (_radarTimer) return;
  _radarTimer = setInterval(() => {
    const rc = _e.cfg.radar || {};
    if (!chave() || rc.ativo === false || _radarRodando) return;
    const h = horaSP();
    if (h < (Number(rc.inicio) || 0) || h >= (Number(rc.fim) || 24)) return;
    const ult = Date.parse(_e.radar?.ultima?.em || 0) || 0;
    if (Date.now() - ult < (Number(rc.intervaloMin) || 20) * 60000) return;
    rodarRadarKeepa().catch(e => console.warn('[KEEPA] Radar falhou:', e.message));
  }, 60000);
  if (_radarTimer.unref) _radarTimer.unref();
}

// ── ROTAS ───────────────────────────────────────────────────────────────────
export function registrarRotasKeepa(app, { exigeRaiz = null } = {}) {
  // Toda rota do Keepa gasta token da assinatura (ou mostra o estado dela):
  // so a raiz logada usa. Sem a funcao de checagem, nada abre.
  const soRaiz = h => (req, res) => {
    if (typeof exigeRaiz !== 'function' || !exigeRaiz(req)) return res.status(403).json({ ok: false, erro: 'somente o administrador autenticado' });
    return h(req, res);
  };
  // ASIN novo na vigilancia de captura -> fila do import (so com chave e config ligada).
  definirGanchoCaptura((asin, loja) => {
    if (loja !== 'Amazon' || !chave() || !_e.cfg.capturaNaHora) return;
    if (_e.resultados[asin]?.ok || _e.fila.includes(asin)) return;
    _e.fila.push(asin);
    salvar();
    if (!_rodando) setTimeout(() => rodarFila().catch(e => console.warn('[KEEPA] Fila falhou:', e.message)), 5000);
  });

  app.get('/keepa', soRaiz((req, res) => {
    const r = Object.values(_e.resultados);
    res.json({ ok: true, configurado: keepaConfigurado(), rodando: _rodando, cfg: _e.cfg, tokens: _e.tokens,
               saude: estadoFontes().keepa || null,
               naFila: _e.fila.length, job: _e.job,
               radar: { rodando: _radarRodando, ultima: _e.radar?.ultima || null, historico: (_e.radar?.historico || []).slice(0, 30),
                        vistos24h: Object.keys(_e.radar?.vistos || {}).length },
               resultados: { total: r.length, ok: r.filter(x => x.ok).length, recusados: r.filter(x => !x.ok).length,
                             exemplosRecusados: Object.entries(_e.resultados).filter(([, x]) => !x.ok).slice(0, 15)
                               .map(([asin, x]) => ({ asin, motivo: x.motivo })) } });
  }));

  app.post('/keepa/config', soRaiz((req, res) => {
    const b = req.body || {};
    if (['menor', 'amazon', 'novo'].includes(b.fonte)) _e.cfg.fonte = b.fonte;
    if (typeof b.capturaNaHora === 'boolean') _e.cfg.capturaNaHora = b.capturaNaHora;
    if (Number.isFinite(Number(b.divergenciaMax)) && b.divergenciaMax > 0 && b.divergenciaMax < 5) _e.cfg.divergenciaMax = Number(b.divergenciaMax);
    if (b.quedas && typeof b.quedas === 'object') {
      if (Array.isArray(b.quedas.categorias)) _e.cfg.quedas.categorias = b.quedas.categorias.map(Number).filter(Boolean);
      if (Number.isFinite(Number(b.quedas.deltaMinPct))) _e.cfg.quedas.deltaMinPct = Number(b.quedas.deltaMinPct);
      if ([0, 1, 2, 3].includes(Number(b.quedas.periodo))) _e.cfg.quedas.periodo = Number(b.quedas.periodo);
    }
    if (Number.isFinite(Number(b.reservaTokens)) && b.reservaTokens >= 0 && b.reservaTokens <= 1000) _e.cfg.reservaTokens = Number(b.reservaTokens);
    if (b.consultaNaHora && typeof b.consultaNaHora === 'object') {
      if (typeof b.consultaNaHora.ativo === 'boolean') _e.cfg.consultaNaHora.ativo = b.consultaNaHora.ativo;
      const em = Number(b.consultaNaHora.esperaMs);
      if (Number.isFinite(em) && em >= 500 && em <= 15000) _e.cfg.consultaNaHora.esperaMs = em;
    }
    if (b.filtroVendas && typeof b.filtroVendas === 'object') {
      if (typeof b.filtroVendas.ativo === 'boolean') _e.cfg.filtroVendas.ativo = b.filtroVendas.ativo;
      const j = Number(b.filtroVendas.janelaDias);
      if (Number.isFinite(j) && j >= 1 && j <= 60) _e.cfg.filtroVendas.janelaDias = j;
    }
    if (b.radar && typeof b.radar === 'object') {
      const r = _e.cfg.radar;
      if (typeof b.radar.ativo === 'boolean') r.ativo = b.radar.ativo;
      for (const k of ['intervaloMin', 'inicio', 'fim', 'periodo', 'porCategoria', 'dedupeHoras', 'maxCandidatos']) {
        const v = Number(b.radar[k]);
        if (b.radar[k] !== undefined && Number.isFinite(v) && v >= 0 && v <= 1440) r[k] = v;
      }
      if (Array.isArray(b.radar.categorias)) {
        r.categorias = b.radar.categorias.filter(x => x && x.nome).map(x => ({ nome: String(x.nome).slice(0, 40),
          id: x.id ? Number(x.id) : null, deltaMinPct: Number(x.deltaMinPct) || 20 }));
      }
    }
    salvar();
    res.json({ ok: true, cfg: _e.cfg });
  }));

  // Teste com 1 ASIN: mostra a serie lida e a conferencia, SEM gravar nada.
  app.post('/keepa/teste', soRaiz(async (req, res) => {
    try {
      const asin = String(req.body?.asin || req.query.asin || '').trim().toUpperCase();
      if (!/^B[A-Z0-9]{9}$/.test(asin)) return res.status(400).json({ ok: false, erro: 'asin invalido' });
      const [p] = await buscarProdutos([asin]);
      if (!p) return res.json({ ok: false, erro: 'Keepa nao devolveu o produto', tokens: _e.tokens });
      const serie = serieDoProduto(p, _e.cfg.fonte);
      const c = conferir(asin, serie);
      const dias = Object.keys(serie).sort();
      res.json({ ok: true, asin, titulo: p.title || null, fonte: _e.cfg.fonte, dias: dias.length,
                 referenciaLonga: referenciaLonga(p, _e.cfg.fonte),
                 ultimos: dias.slice(-15).map(d => ({ d, v: serie[d] })), conferencia: c, tokens: _e.tokens });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message, tokens: _e.tokens }); }
  }));

  app.post('/keepa/importar', soRaiz((req, res) => {
    if (!chave()) return res.status(400).json({ ok: false, erro: 'KEEPA_API_KEY nao configurada' });
    const f = montarFila({ reimportar: req.body?.reimportar === true, limite: Number(req.body?.limite) || null });
    if (!_rodando) rodarFila().catch(e => console.warn('[KEEPA] Import falhou:', e.message));
    res.json({ ok: true, ...f, rodando: true });
  }));

  app.post('/keepa/radar/rodar', soRaiz(async (req, res) => {
    try { res.json(await rodarRadarKeepa({ manual: true })); }
    catch (e) { res.status(500).json({ ok: false, erro: e.message, tokens: _e.tokens }); }
  }));

  app.post('/keepa/parar', soRaiz((req, res) => { _parar = true; res.json({ ok: true, naFila: _e.fila.length }); }));

  app.get('/keepa/quedas', soRaiz(async (req, res) => {
    try { res.json({ ok: true, ...(await quedasPorCategoria({ categoria: req.query.categoria || null,
      deltaMinPct: req.query.min ?? null, periodo: req.query.periodo ?? null, pagina: req.query.pagina || 0 })) }); }
    catch (e) { res.status(500).json({ ok: false, erro: e.message, tokens: _e.tokens }); }
  }));

  // Busca de categoria (para achar o id de Bebidas, Ferramentas...).
  app.get('/keepa/categorias', soRaiz(async (req, res) => {
    try {
      const termo = String(req.query.termo || '').trim();
      if (!termo) return res.status(400).json({ ok: false, erro: 'informe ?termo=' });
      const d = await chamar('/search', { domain: String(DOMINIO_BR), type: 'category', term: termo });
      const cats = Object.values(d?.categories || {}).map(c => ({ id: c.catId, nome: c.name, pai: c.parent ?? null, produtos: c.productCount ?? null }));
      res.json({ ok: true, categorias: cats, tokens: _e.tokens });
    } catch (e) { res.status(500).json({ ok: false, erro: e.message, tokens: _e.tokens }); }
  }));

  // Uma vez (21/11/2026): o historico importado antes do filtro de vendas e
  // rebuscado para tirar o preco de vitrine. Vai para o fim da fila.
  if (chave() && !(_e.migracoes || {}).filtroVendas) {
    try {
      const r = montarFila({ reimportar: true });
      _e.migracoes = { ...(_e.migracoes || {}), filtroVendas: new Date().toISOString() };
      salvar();
      console.log('[KEEPA] Reimport com filtro de vendas — ' + r.adicionados + ' ASIN(s) na fila (' + r.naFila + ' no total).');
    } catch (e) { console.warn('[KEEPA] Reimport com filtro de vendas falhou:', e.message); }
  }
  // Fila que ficou de um boot anterior volta a rodar sozinha (so com chave).
  // Desde 21/11/2026 o boot tambem enfileira quem ainda nao tem a referencia
  // longa (12 meses + tabela): uma passada so, ordenada por cliques, deixando
  // a reserva de tokens para a consulta na hora e o radar.
  if (chave()) setTimeout(() => {
    try {
      const f = montarFila();
      if (f.adicionados) console.log('[KEEPA] Referencia longa — ' + f.adicionados + ' produto(s) na fila para reler 12 meses.');
    } catch (e) { console.warn('[KEEPA] Fila da referencia longa:', e.message); }
    if (_e.fila.length && !_rodando) rodarFila().catch(() => {});
  }, 90000);
  iniciarRadar();
}
