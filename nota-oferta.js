// ── NOTA DA OFERTA (18/11/2026) ──────────────────────────────────────────────
// Nota de 0 a 100 para a oferta capturada em grupo-fonte/Telegram, calculada na
// hora da captura. NAO existe fila nem teto por hora (decisao do Davi: oferta
// boa sai no momento em que chega). A nota so decide SE a oferta sai em cada
// trilha, comparando com a nota minima daquela trilha.
//
// Sinais (comeca em 50):
//   desconto real (etiqueta ou preco final com cupom, o maior)   ate +25
//   menor preco em 90 dias (estrito, como o selo do monitor)       +15
//   abaixo da mediana de 30 dias                                    +7
//   acima da mediana de 30 dias                                    -10
//   mesmo produto postado por OUTRA fonte nas ultimas N horas      +8 por fonte, ate +16
//   idade do post na fonte (0 ate 10 min; -20 aos 45 min)          ate -20
//   produto que ja rendeu (EPC do ledger, 20+ cliques)             ate +10
//
// Modo 'sombra' (padrao): calcula, grava e nao barra nada. Modo 'ativo': oferta
// que ia sair sozinha so sai nas trilhas em que passou; se nao passou em
// nenhuma, e descartada com o motivo. Envio manual, card aprovado, cupom, lista,
// monitor de precos e Awin nunca passam por aqui.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { trilhas, chaveDedupProduto } from './radar-amazon.js';
import { sinaisParaNota } from './monitor-precos.js';

const SESSAO_DIR = './sessao';
const ARQ_CFG = SESSAO_DIR + '/nota_oferta.json';
const ARQ_REG = SESSAO_DIR + '/nota_oferta_registros.json';
const REG_MAX = 6000;           // ~7 dias de capturas que chegam ao gate
const REG_DIAS = 8;

export const NOTA_PADRAO = {
  modo: 'sombra',               // 'off' | 'sombra' | 'ativo'
  minGeral: 40,                 // trilha geral
  minGeralProdutoNicho: 75,     // produto de nicho confirmado entrando na trilha geral
  minNichoPadrao: 40,           // trilha de nicho sem valor proprio
  minNicho: {},                 // { <categoria>: nota }
  janelaFontesH: 6,             // janela para contar outras fontes com o mesmo produto
};

export const PESOS_NOTA = {
  base: 50,
  descontoMax: 25, descontoPctParaMax: 50,   // 50% de desconto = +25
  recorde: 15, abaixoMediana: 7, acimaMediana: -10,
  porFonte: 8, fontesMax: 16,
  idadeLivreMin: 10, idadeMaxMin: 45, idadeMax: -20,
  epcMax: 10, epcPeso: 8, epcCliquesMin: 20,
};

let _cfg = { ...NOTA_PADRAO, minNicho: {} };
let _reg = [];
let _salvarTimer = null;
const _capturas = new Map();   // chaveProduto -> [{ fonte, ts }]

function garantirDir() { try { if (!existsSync(SESSAO_DIR)) mkdirSync(SESSAO_DIR, { recursive: true }); } catch { /* */ } }
function gravarAtomico(arq, obj) {
  garantirDir();
  const tmp = arq + '.tmp';
  writeFileSync(tmp, JSON.stringify(obj));
  renameSync(tmp, arq);
}
function lerJson(arq, padrao) {
  try { return existsSync(arq) ? JSON.parse(readFileSync(arq, 'utf8')) : padrao; } catch { return padrao; }
}
const num = (v, min, max, pad) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : pad;
};

function normalizarCfg(b = {}, base = NOTA_PADRAO) {
  const out = { ...base, minNicho: { ...(base.minNicho || {}) } };
  if (['off', 'sombra', 'ativo'].includes(b.modo)) out.modo = b.modo;
  out.minGeral = num(b.minGeral, 0, 100, out.minGeral);
  out.minGeralProdutoNicho = num(b.minGeralProdutoNicho, 0, 100, out.minGeralProdutoNicho);
  out.minNichoPadrao = num(b.minNichoPadrao, 0, 100, out.minNichoPadrao);
  out.janelaFontesH = num(b.janelaFontesH, 1, 48, out.janelaFontesH);
  if (b.minNicho && typeof b.minNicho === 'object') {
    for (const [k, v] of Object.entries(b.minNicho)) {
      const cat = String(k || '').trim();
      if (!cat) continue;
      if (v === null || v === '') { delete out.minNicho[cat]; continue; }
      const n = Number(v);
      if (Number.isFinite(n)) out.minNicho[cat] = Math.max(0, Math.min(100, n));
    }
  }
  return out;
}

export function carregarNotaOferta() {
  _cfg = normalizarCfg(lerJson(ARQ_CFG, {}), NOTA_PADRAO);
  const r = lerJson(ARQ_REG, []);
  _reg = Array.isArray(r) ? r : [];
  podarRegistros();
  console.log('[NOTA] Config carregada: modo ' + _cfg.modo + ', geral ' + _cfg.minGeral
    + ', nicho ' + _cfg.minNichoPadrao + ' · ' + _reg.length + ' registro(s).');
}
export function configNotaOferta() { return { ..._cfg, minNicho: { ..._cfg.minNicho } }; }
export function salvarConfigNotaOferta(b = {}) {
  _cfg = normalizarCfg(b, _cfg);
  gravarAtomico(ARQ_CFG, _cfg);
  console.log('[NOTA] Config salva: ' + JSON.stringify(_cfg));
  return configNotaOferta();
}

function podarRegistros() {
  const corte = Date.now() - REG_DIAS * 86400000;
  _reg = _reg.filter(r => Date.parse(r.em) >= corte).slice(0, REG_MAX);
}
function agendarSalvarRegistros() {
  if (_salvarTimer) return;
  _salvarTimer = setTimeout(() => {
    _salvarTimer = null;
    try { podarRegistros(); gravarAtomico(ARQ_REG, _reg); }
    catch (e) { console.warn('[NOTA] Falha ao salvar registros:', e.message); }
  }, 120000);
  _salvarTimer.unref?.();
}

// ── CAPTURAS POR PRODUTO (para "varias fontes postaram") ────────────────────
// Registrada ANTES do dedup: a segunda fonte que posta um produto ja divulgado
// tambem conta, e a que posta um produto que ainda nao saiu (nota baixa na
// primeira vez) chega com a nota mais alta.
export function registrarCapturaFonte(p, fonte) {
  const k = chaveDedupProduto(p);
  const f = String(fonte || '').trim();
  if (!k || !f) return;
  const agora = Date.now();
  const janela = _cfg.janelaFontesH * 3600000;
  const lista = (_capturas.get(k) || []).filter(c => agora - c.ts <= janela && c.fonte !== f);
  lista.push({ fonte: f, ts: agora });
  _capturas.set(k, lista);
  if (_capturas.size > 20000) {
    for (const [ck, cl] of _capturas) {
      if (!cl.some(c => agora - c.ts <= janela)) _capturas.delete(ck);
    }
  }
}
function outrasFontes(p, fonte) {
  const k = chaveDedupProduto(p);
  if (!k) return [];
  const agora = Date.now();
  const janela = _cfg.janelaFontesH * 3600000;
  return [...new Set((_capturas.get(k) || [])
    .filter(c => c.fonte !== fonte && agora - c.ts <= janela).map(c => c.fonte))];
}

// ── CALCULO ─────────────────────────────────────────────────────────────────
export function calcularNota({ p, precoFinal, descontoPct, fonte, postadoEm }) {
  const W = PESOS_NOTA;
  const partes = [];
  let nota = W.base;
  const soma = (rotulo, v) => { if (!v) return; const r = Math.round(v * 10) / 10; nota += r; partes.push({ rotulo, pontos: r }); };

  const desc = Math.max(0, Number(descontoPct) || 0);
  if (desc > 0) soma('desconto ' + desc + '%', Math.min(W.descontoMax, desc * W.descontoMax / W.descontoPctParaMax));

  const preco = Number(precoFinal) > 0 ? Number(precoFinal) : Number(p?.preco);
  let sinais = null;
  try { sinais = sinaisParaNota(p?.asin, preco); } catch { sinais = null; }
  if (sinais && sinais.dias >= 2) {
    if (sinais.recorde) soma('menor preco em 90 dias', W.recorde);
    else if (Number.isFinite(sinais.mediana30) && preco < sinais.mediana30 * 0.98) soma('abaixo da mediana 30d', W.abaixoMediana);
    else if (Number.isFinite(sinais.mediana30) && preco > sinais.mediana30 * 1.02) soma('acima da mediana 30d', W.acimaMediana);
  }

  const outras = outrasFontes(p, fonte);
  if (outras.length) soma(outras.length + ' outra(s) fonte(s)', Math.min(W.fontesMax, outras.length * W.porFonte));

  const idadeMin = Number(postadoEm) > 0 ? Math.max(0, (Date.now() - Number(postadoEm)) / 60000) : null;
  if (idadeMin !== null && idadeMin > W.idadeLivreMin) {
    const frac = Math.min(1, (idadeMin - W.idadeLivreMin) / (W.idadeMaxMin - W.idadeLivreMin));
    soma('post com ' + Math.round(idadeMin) + ' min', W.idadeMax * frac);
  }

  if (sinais && Number.isFinite(sinais.epc) && sinais.cliquesEpc >= W.epcCliquesMin && sinais.epc > 0) {
    soma('EPC R$ ' + sinais.epc.toFixed(2), Math.min(W.epcMax, sinais.epc * W.epcPeso));
  }

  nota = Math.max(0, Math.min(100, Math.round(nota)));
  return { nota, partes, outrasFontes: outras.length, idadeMin: idadeMin === null ? null : Math.round(idadeMin),
           diasSerie: sinais?.dias ?? 0 };
}

function minimaDaTrilha(t, produtoDeNicho) {
  if (!t.categoria) return produtoDeNicho ? _cfg.minGeralProdutoNicho : _cfg.minGeral;
  const v = _cfg.minNicho[t.categoria];
  return Number.isFinite(v) ? v : _cfg.minNichoPadrao;
}

/**
 * Avalia a oferta na captura. rota = detalharRoteamento(...) (so as que entregam
 * contam). Devolve { nota, partes, modo, trilhas:[{id,nome,nicho,min,passa}],
 * trilhasBarradas, descartar, motivo }. Nunca lanca.
 */
export function avaliarNotaOferta({ oferta, p, precoFinal, descontoPct, fonte, postadoEm, rota, categoria, categoriaConfiavel, elegivel }) {
  try {
    if (_cfg.modo === 'off') return null;
    const calc = calcularNota({ p, precoFinal, descontoPct, fonte, postadoEm });
    const cat = String(categoria || '').trim();
    const produtoDeNicho = !!(categoriaConfiavel && cat && trilhas().some(t => t.categoria === cat));
    const porId = new Map(trilhas().map(t => [t.id, t]));
    const entregues = (rota || []).filter(t => t.entrega).map(t => porId.get(t.id)).filter(Boolean);
    const trs = entregues.map(t => {
      const min = minimaDaTrilha(t, produtoDeNicho);
      return { id: t.id, nome: t.nome, nicho: t.categoria || null, min, passa: calc.nota >= min };
    });
    const barradas = trs.filter(t => !t.passa).map(t => t.id);
    const ativo = _cfg.modo === 'ativo' && !!elegivel;
    const descartar = ativo && trs.length > 0 && barradas.length === trs.length;
    const res = {
      nota: calc.nota, partes: calc.partes, modo: _cfg.modo, outrasFontes: calc.outrasFontes,
      idadeMin: calc.idadeMin, diasSerie: calc.diasSerie, produtoDeNicho,
      trilhas: trs, trilhasBarradas: ativo ? barradas : [],
      descartar,
      motivo: descartar ? ('nota ' + calc.nota + ' abaixo da minima de todas as trilhas ('
        + trs.map(t => t.nome + ' ' + t.min).join(', ') + ')') : null,
    };
    _reg.unshift({
      em: new Date().toISOString(), id: oferta?.id || null, asin: p?.asin || null, loja: p?.loja || null,
      titulo: String(p?.titulo || '').slice(0, 90), preco: Number(precoFinal) || Number(p?.preco) || null,
      fonte: fonte || null, fonteNome: oferta?.grupoOrigemNome || null, categoria: cat || null,
      nota: calc.nota, partes: calc.partes, elegivel: !!elegivel, modo: _cfg.modo,
      trilhas: trs, decisao: !elegivel ? 'card' : descartar ? 'descartada' : (ativo && barradas.length ? 'parcial' : 'sai'),
    });
    if (_reg.length > REG_MAX) _reg.length = REG_MAX;
    agendarSalvarRegistros();
    return res;
  } catch (e) {
    console.warn('[NOTA] Falha ao avaliar #' + (oferta?.id || '?') + ': ' + e.message);
    return null;
  }
}

// ── RELATORIO (GET /mkt/notas) ──────────────────────────────────────────────
const CORTES = [30, 40, 50, 60, 70];
const diaSP = (iso) => new Date(Date.parse(iso) - 3 * 3600000).toISOString().slice(0, 10);
const exemplo = (r, t) => ({ em: r.em, id: r.id, titulo: r.titulo, loja: r.loja, preco: r.preco,
  fonte: r.fonteNome || r.fonte, nota: r.nota, minima: t.min, partes: r.partes });

export function relatorioNotas({ dias = 7 } = {}) {
  const corte = Date.now() - Math.max(1, Math.min(REG_DIAS, Number(dias) || 7)) * 86400000;
  const regs = _reg.filter(r => Date.parse(r.em) >= corte);
  const eleg = regs.filter(r => r.elegivel);
  const distribuicao = {};
  for (let f = 0; f <= 90; f += 10) distribuicao[f + '-' + (f === 90 ? 100 : f + 9)] = 0;
  for (const r of eleg) {
    const f = Math.min(90, Math.floor(r.nota / 10) * 10);
    distribuicao[f + '-' + (f === 90 ? 100 : f + 9)]++;
  }
  const porTrilha = new Map();
  for (const r of eleg) {
    for (const t of r.trilhas || []) {
      if (!porTrilha.has(t.id)) porTrilha.set(t.id, { id: t.id, nome: t.nome, nicho: t.nicho, minimaAtual: null,
        elegiveis: 0, passamComAtual: 0, barradasComAtual: 0, porCorte: {}, porDia: {}, barradas: [], pertoDoCorte: [] });
      const g = porTrilha.get(t.id);
      g.elegiveis++;
      if (t.passa) g.passamComAtual++; else g.barradasComAtual++;
      for (const c of CORTES) {
        g.porCorte[c] = g.porCorte[c] || { passam: 0, barradas: 0 };
        if (r.nota >= c) g.porCorte[c].passam++; else g.porCorte[c].barradas++;
      }
      const d = diaSP(r.em);
      g.porDia[d] = g.porDia[d] || { elegiveis: 0, passam: 0 };
      g.porDia[d].elegiveis++;
      if (t.passa) g.porDia[d].passam++;
      if (!t.passa && g.barradas.length < 10) g.barradas.push(exemplo(r, t));
      if (t.passa && r.nota < t.min + 10 && g.pertoDoCorte.length < 10) g.pertoDoCorte.push(exemplo(r, t));
    }
  }
  const porId = new Map(trilhas().map(t => [t.id, t]));
  const lista = [...porTrilha.values()].map(g => {
    const t = porId.get(g.id);
    g.minimaAtual = t ? minimaDaTrilha(t, false) : null;
    g.porDia = Object.entries(g.porDia).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([dia, v]) => ({ dia, ...v }));
    return g;
  }).sort((a, b) => b.elegiveis - a.elegiveis);
  return {
    dias: Number(dias) || 7, config: configNotaOferta(), pesos: PESOS_NOTA, cortes: CORTES,
    avaliadas: regs.length, elegiveis: eleg.length,
    porDecisao: regs.reduce((acc, r) => { acc[r.decisao] = (acc[r.decisao] || 0) + 1; return acc; }, {}),
    distribuicao, trilhas: lista,
    observacao: 'elegiveis = ofertas que sairiam sozinhas (as que iam para card nao contam). porCorte aplica o mesmo corte a todas as ofertas; passamComAtual usa a minima de cada trilha, inclusive a de produto de nicho na trilha geral.',
  };
}
