// ═══════════════════════════════════════════════════════════════════════════
// monitor-precos.js — Monitor de queda de preco da vitrine (Shopee e ML).
//
// Problema que resolve: hoje a operacao depende de alguem (ou de outro grupo)
// achar a oferta. Aqui a vitrine deixa de ser so um catalogo de disparo manual
// e vira uma lista VIGIADA: o servidor le o preco de cada produto de tempos em
// tempos, guarda a serie e dispara sozinho quando o preco cai de verdade.
//
// Decisao central: o gatilho NAO usa o "% de desconto" que a loja anuncia. Esse
// numero e inflado — o "de R$ 299" costuma ser ficcao e postar em cima dele
// queima o grupo. O gatilho usa a serie que o proprio servidor construiu:
//   queda = 1 - preco_atual / mediana_dos_ultimos_30_dias
// e, opcionalmente, exige que o preco esteja no menor patamar dos ultimos 90
// dias. Enquanto a serie nao amadurece (maturidadeMinDias) o produto nao
// dispara: e a diferenca entre "esta barato" e "parece barato".
//
// Duas engrenagens separadas, de proposito:
//   1. VARREDURA  le precos e empilha candidatos numa fila com score.
//   2. PUBLICADOR consome a fila com cadencia, cota e janela de horario.
// Separar as duas e o que da ritmo constante: numa terca sem queda nenhuma a
// fila esvazia devagar, e numa Black Friday nao saem 6 ofertas em 10 minutos.
//
// Tudo configuravel em tela (/monitor-precos/config) — nada de decisao de
// operacao em constante de codigo ou variavel de ambiente.
//
// Dependencias injetadas por iniciarMonitorPrecos(): o modulo nao importa nada
// do server.js para nao criar ciclo com um arquivo de meio milhao de bytes.
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { agendarPush } from './sync-github.js';
import { listarVitrine, itemVitrine, salvarItemVitrine, melhorCupomAplicavel, marcarDisparo,
         buscarProdutos as buscarProdutosAmazon, normalizar as normalizarAmazon } from './radar-amazon.js';
import { credencialTsp } from './config-tsp.js';
import { classificarProduto, categoriaConfiavel } from './categorizador.js';
import { buscarProdutoShopee, normalizarShopee, credenciaisShopeeOk } from './radar-shopee.js';
import { buscarDadosProdutoMl, tokenAffOk } from './radar-ml.js';

const SESSAO_DIR = './sessao';
const ARQ_CFG    = 'monitor_precos_config.json';
const ARQ_HIST   = 'precos_hist.json';
const ARQ_ESTADO = 'monitor_precos_estado.json';
// Escrito pelo coletor (GitHub Actions), somente LIDO aqui.
const ARQ_EPC    = 'epc-produtos.json';

const TZ_SP = 'America/Sao_Paulo';

// Retencao da serie. 90 dias e o horizonte do "menor preco recente" — mais que
// isso comeca a comparar com precos de outra realidade de mercado.
const DIAS_RETENCAO = 120;

// Lojas com leitura de preco por API oficial. Magalu e Awin ficam de fora: nao
// ha leitura confiavel de preco fora do momento do disparo, e monitorar preco
// que so se conhece na hora de enviar nao e monitorar coisa nenhuma.
//
// A Amazon le em LOTE de 10 ASINs por chamada (getItems da Creators API), o que
// a torna a loja mais barata de vigiar das tres — 250 produtos custam 25
// chamadas, contra 250 na Shopee e no ML, que so aceitam um item por vez.
export const LOJAS_MONITORAVEIS_PRECO = ['Amazon', 'Shopee', 'Mercado Livre'];

// ASIN sintetico de outra rede que mora na mesma vitrine. Nao e produto Amazon
// e nao pode ir para o getItems.
const RE_ASIN_AMAZON = /^B[A-Z0-9]{9}$/;

function ehItemAmazon(item) {
  return item?.loja === 'Amazon' && RE_ASIN_AMAZON.test(String(item.asin || ''));
}

function credenciaisAmazonOk() {
  return !!(credencialTsp('AMZ_CLIENT_ID') && credencialTsp('AMZ_CLIENT_SECRET'));
}

// Itens da vitrine efetivamente sob monitoramento. Ponto unico de verdade:
// varredura, tabela do painel e simulacao precisam enxergar exatamente o mesmo
// conjunto, senao o painel promete vigiar produto que a varredura ignora.
// O filtro por ASIN valido barra o que mora na mesma vitrine mas nao e produto
// Amazon (itens AWIN- herdam a loja padrao no cadastro).
function itensMonitorados() {
  return listarVitrine().filter(i =>
    _cfg.varredura.lojas.includes(i.loja) && (i.loja !== 'Amazon' || ehItemAmazon(i)));
}

// ── CONFIG PADRAO ────────────────────────────────────────────────────────────
// Comeca DESLIGADA e em modo sombra: subir esta versao nao muda nada no grupo.
// O operador liga em tela depois de ver a fila enchendo com coisa que ele
// aprovaria.
const CFG_PADRAO = {
  ativo: false,
  // 'off'    nao avalia nada
  // 'sombra' avalia, pontua e enfileira — mas nunca envia (a fila vira relatorio)
  // 'on'     envia respeitando janela, cota e intervalo
  modo: 'sombra',

  varredura: {
    intervaloMin: 60,      // de quanto em quanto tempo relê a vitrine inteira
    lote: 20,              // produtos por rodada antes da pausa
    pausaMs: 1500,         // respiro entre lotes (rate limit das APIs)
    lojas: ['Amazon', 'Shopee', 'Mercado Livre'],
  },

  publicacao: {
    janelas: [{ inicio: '08:00', fim: '21:00' }],
    intervaloMin: 45,      // espacamento minimo entre duas ofertas do monitor
    // Cota DIARIA por loja. O pedido inicial e 10 por loja; sobe em tela sem
    // deploy quando o volume convencional der espaco.
    cotaPorLoja: { 'Amazon': 10, 'Shopee': 10, 'Mercado Livre': 10 },
    // Cota DIARIA por nicho (soma das lojas). Sem isto o dia inteiro vira o
    // nicho que tiver mais produto cadastrado.
    cotaPorNicho: { geral: 18, bebidas: 6, infantil: 6 },
    // Nicho e a categoria do classificador; 'geral' = sem categoria confiavel.
    aplicarCupom: true,    // pede o melhor cupom aplicavel no disparo
  },

  // ── DESEMPENHO REAL (ganho por clique) ──
  // O ledger epc-produtos.json diz quanto cada ASIN pagou por clique gasto nos
  // ultimos 90 dias. Duas funcoes aqui:
  //   semear  cadastra na vitrine, sozinho, o que ja provou que converte
  //   score   sobe na fila quem paga bem e VETA quem so consome clique
  // Sem o arquivo (coletor nunca rodou) tudo isto fica inerte e o monitor se
  // comporta exatamente como antes.
  desempenho: {
    semear: {
      ativo: false,          // liga o cadastro automatico na vitrine
      epcMin: 0.80,          // R$ por clique para o produto merecer ser vigiado
      cliquesMin: 10,        // amostra minima — EPC de 3 cliques nao e sinal
      maximo: 150,           // teto de produtos semeados no total
      porRodada: 25,         // teto por rodada, para nao inundar a vitrine de uma vez
    },
    score: {
      // Bonus no score = epc * pesoEpc. Com peso 8, um produto de R$ 0,90/clique
      // ganha ~7 pontos, na mesma ordem de grandeza do bonus de recorde (10).
      pesoEpc: 8,
      // Veto: produto com amostra suficiente e EPC pifio nao dispara, por mais
      // fundo que esteja o desconto. E o caso do iPad e da calca jeans: muito
      // clique, quase nenhum ganho.
      epcVeto: 0.30,
      cliquesParaVeto: 60,
    },
  },

  // Regra padrao + sobrescrita por nicho. Nicho sem entrada em porNicho herda
  // integralmente o padrao.
  regras: {
    padrao: {
      quedaMinPct: 12,        // queda minima contra a mediana de 30 dias
      quedaMinReais: 15,      // e tambem em valor absoluto (30% de R$ 40 nao move ninguem)
      exigirMinimo90d: true,  // so dispara no menor patamar recente
      toleranciaMinimoPct: 2, // "empatar" com o minimo conta como minimo
      maturidadeMinDias: 5,   // dias distintos de serie antes de poder disparar
      precoMin: 25,
      precoMax: 3000,
      reenvioMinDias: 10,     // cooldown por produto
      exigirDisponivel: true,
    },
    porNicho: {},
  },
};

// ── ESTADO EM MEMORIA ────────────────────────────────────────────────────────
let _cfg    = clonar(CFG_PADRAO);
let _hist   = {};    // asin -> { n, loja, dias: { 'YYYY-MM-DD': min }, ult: {preco, precoDe, em, disponivel} }
let _epc    = { produtos: {} };   // ledger somente-leitura escrito pelo coletor
let _estado = {      // fila de candidatos + contadores do dia
  fila: [],          // [{ asin, nome, loja, nicho, preco, mediana30, min90, quedaPct, quedaRs, score, recorde, em }]
  cotas: { dia: null, porLoja: {}, porNicho: {} },
  ultimoEnvioEm: 0,
  ultimaVarredura: null,
  historicoDisparos: [],   // ultimos 200 disparos do monitor (auditoria em tela)
};

let _deps = null;          // injetadas no boot
let _varrendo = false;
let _publicando = false;
let _timerVarredura = null;

function clonar(o) { return JSON.parse(JSON.stringify(o)); }

// ── DATA / FUSO ──────────────────────────────────────────────────────────────
function diaSP(ts = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ_SP }).format(new Date(ts));
}
function minutosSP(ts = Date.now()) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: TZ_SP, hour: '2-digit', minute: '2-digit', hour12: false })
    .format(new Date(ts)).split(':');
  return (+p[0]) * 60 + (+p[1]);
}
function hhmmParaMin(s) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(s || '').trim());
  return m ? (+m[1]) * 60 + (+m[2]) : null;
}

// ── PERSISTENCIA ─────────────────────────────────────────────────────────────
function caminho(nome) { return SESSAO_DIR + '/' + nome; }

function ler(nome, padrao) {
  try {
    if (existsSync(caminho(nome))) return JSON.parse(readFileSync(caminho(nome), 'utf-8'));
  } catch (e) {
    console.log('[PRECOS] Falha ao ler ' + nome + ':', e.message);
  }
  return clonar(padrao);
}

function gravar(nome, dados, push = true) {
  try {
    if (!existsSync(SESSAO_DIR)) mkdirSync(SESSAO_DIR, { recursive: true });
    writeFileSync(caminho(nome), JSON.stringify(dados, null, nome === ARQ_HIST ? 0 : 2));
    if (push) agendarPush(nome);
  } catch (e) {
    console.error('[PRECOS] Falha ao gravar ' + nome + ':', e.message);
  }
}

export function carregarMonitorPrecos() {
  _cfg    = estruturarCfg(ler(ARQ_CFG, {}));
  _hist   = ler(ARQ_HIST, {});
  _epc    = ler(ARQ_EPC, { produtos: {} });
  _estado = { ..._estado, ...ler(ARQ_ESTADO, {}) };
  if (!Array.isArray(_estado.fila)) _estado.fila = [];
  if (!Array.isArray(_estado.historicoDisparos)) _estado.historicoDisparos = [];
  if (!_estado.cotas || typeof _estado.cotas !== 'object') _estado.cotas = { dia: null, porLoja: {}, porNicho: {} };
  console.log('[PRECOS] Monitor carregado — ' + Object.keys(_hist).length + ' produto(s) com serie, '
    + _estado.fila.length + ' na fila, modo ' + _cfg.modo + (_cfg.ativo ? '' : ' (desligado)') + '.');
  return _cfg;
}

// Merge por secao com validacao: config gravada por uma versao anterior nunca
// derruba um campo novo, e valor torto vindo do painel cai no padrao em vez de
// virar excecao no meio de um envio.
function estruturarCfg(bruto) {
  const b = (bruto && typeof bruto === 'object') ? bruto : {};
  const out = clonar(CFG_PADRAO);

  out.ativo = b.ativo === true;
  out.modo  = ['off', 'sombra', 'on'].includes(b.modo) ? b.modo : CFG_PADRAO.modo;

  const v = b.varredura || {};
  out.varredura.intervaloMin = limitar(v.intervaloMin, 15, 720, CFG_PADRAO.varredura.intervaloMin);
  out.varredura.lote         = limitar(v.lote, 1, 100, CFG_PADRAO.varredura.lote);
  out.varredura.pausaMs      = limitar(v.pausaMs, 200, 20000, CFG_PADRAO.varredura.pausaMs);
  out.varredura.lojas = Array.isArray(v.lojas)
    ? v.lojas.filter(l => LOJAS_MONITORAVEIS_PRECO.includes(l))
    : CFG_PADRAO.varredura.lojas.slice();

  const p = b.publicacao || {};
  const jan = Array.isArray(p.janelas)
    ? p.janelas.filter(j => hhmmParaMin(j?.inicio) !== null && hhmmParaMin(j?.fim) !== null)
               .map(j => ({ inicio: j.inicio, fim: j.fim }))
    : [];
  out.publicacao.janelas = jan.length ? jan : clonar(CFG_PADRAO.publicacao.janelas);
  out.publicacao.intervaloMin = limitar(p.intervaloMin, 1, 1440, CFG_PADRAO.publicacao.intervaloMin);
  out.publicacao.aplicarCupom = p.aplicarCupom !== false;
  out.publicacao.cotaPorLoja  = mapaNumerico(p.cotaPorLoja,  CFG_PADRAO.publicacao.cotaPorLoja,  0, 500);
  out.publicacao.cotaPorNicho = mapaNumerico(p.cotaPorNicho, CFG_PADRAO.publicacao.cotaPorNicho, 0, 500);

  const dz = b.desempenho || {};
  const sem = dz.semear || {}, sc = dz.score || {};
  out.desempenho.semear.ativo      = sem.ativo === true;
  out.desempenho.semear.epcMin     = limitar(sem.epcMin, 0, 1000, CFG_PADRAO.desempenho.semear.epcMin);
  out.desempenho.semear.cliquesMin = limitar(sem.cliquesMin, 1, 100000, CFG_PADRAO.desempenho.semear.cliquesMin);
  out.desempenho.semear.maximo     = limitar(sem.maximo, 0, 5000, CFG_PADRAO.desempenho.semear.maximo);
  out.desempenho.semear.porRodada  = limitar(sem.porRodada, 1, 500, CFG_PADRAO.desempenho.semear.porRodada);
  out.desempenho.score.pesoEpc         = limitar(sc.pesoEpc, 0, 100, CFG_PADRAO.desempenho.score.pesoEpc);
  out.desempenho.score.epcVeto         = limitar(sc.epcVeto, 0, 1000, CFG_PADRAO.desempenho.score.epcVeto);
  out.desempenho.score.cliquesParaVeto = limitar(sc.cliquesParaVeto, 0, 100000, CFG_PADRAO.desempenho.score.cliquesParaVeto);

  const r = b.regras || {};
  out.regras.padrao = estruturarRegra(r.padrao, CFG_PADRAO.regras.padrao);
  out.regras.porNicho = {};
  if (r.porNicho && typeof r.porNicho === 'object') {
    for (const [nicho, regra] of Object.entries(r.porNicho)) {
      const id = String(nicho || '').trim();
      if (!id) continue;
      // Sobrescrita PARCIAL: o painel manda so o que o operador mexeu, e o resto
      // continua herdando o padrao mesmo depois que o padrao mudar.
      const parcial = {};
      for (const k of Object.keys(CFG_PADRAO.regras.padrao)) {
        if (regra && regra[k] !== undefined && regra[k] !== null && regra[k] !== '') parcial[k] = regra[k];
      }
      if (Object.keys(parcial).length) out.regras.porNicho[id] = estruturarRegra(parcial, {}, true);
    }
  }
  return out;
}

function estruturarRegra(bruto, base, parcial = false) {
  const b = (bruto && typeof bruto === 'object') ? bruto : {};
  const out = parcial ? {} : { ...base };
  const num = (k, min, max) => {
    if (b[k] === undefined || b[k] === null || b[k] === '') return;
    const n = Number(b[k]);
    if (Number.isFinite(n)) out[k] = Math.min(max, Math.max(min, n));
  };
  num('quedaMinPct', 0, 95);
  num('quedaMinReais', 0, 100000);
  num('toleranciaMinimoPct', 0, 30);
  num('maturidadeMinDias', 0, 365);
  num('precoMin', 0, 1000000);
  num('precoMax', 0, 1000000);
  num('reenvioMinDias', 0, 365);
  if (b.exigirMinimo90d !== undefined) out.exigirMinimo90d = b.exigirMinimo90d === true;
  if (b.exigirDisponivel !== undefined) out.exigirDisponivel = b.exigirDisponivel === true;
  return out;
}

function limitar(v, min, max, padrao) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : padrao;
}

function mapaNumerico(bruto, padrao, min, max) {
  if (!bruto || typeof bruto !== 'object') return clonar(padrao);
  const out = {};
  for (const [k, v] of Object.entries(bruto)) {
    const chave = String(k || '').trim();
    if (!chave) continue;
    const n = Number(v);
    if (Number.isFinite(n)) out[chave] = Math.min(max, Math.max(min, Math.round(n)));
  }
  return Object.keys(out).length ? out : clonar(padrao);
}

export function configMonitorPrecos() { return _cfg; }

export function salvarConfigMonitorPrecos(parcial = {}) {
  const antes = _cfg;
  _cfg = estruturarCfg({ ..._cfg, ...parcial });
  gravar(ARQ_CFG, _cfg);
  if (antes.varredura.intervaloMin !== _cfg.varredura.intervaloMin || antes.ativo !== _cfg.ativo) {
    reprogramarVarredura();
  }
  console.log('[PRECOS] Config salva — modo ' + _cfg.modo + ', ativo=' + _cfg.ativo
    + ', varredura a cada ' + _cfg.varredura.intervaloMin + ' min.');
  return _cfg;
}

// ── SERIE DE PRECOS ──────────────────────────────────────────────────────────
// Um ponto por DIA por produto (o menor visto no dia), nao um por leitura. Com
// 8 leituras/dia e 200 produtos, guardar tudo daria ~2 MB de serie em 90 dias
// e a Contents API para de devolver arquivo acima de ~1 MB — a restauracao
// pos-deploy morreria em silencio. O minimo diario e o que o gatilho usa.
function registrarPreco(asin, { nome, loja, preco, precoDe, disponivel }) {
  if (!Number.isFinite(preco) || preco <= 0) return null;
  const dia = diaSP();
  const h = _hist[asin] || { n: '', loja: '', dias: {}, ult: null };
  h.n = nome || h.n;
  h.loja = loja || h.loja;
  h.dias[dia] = (h.dias[dia] === undefined) ? preco : Math.min(h.dias[dia], preco);
  h.ult = { preco, precoDe: precoDe ?? null, disponivel: disponivel !== false, em: new Date().toISOString() };

  // Poda: dias fora do horizonte saem do arquivo.
  const corte = diaSP(Date.now() - DIAS_RETENCAO * 86400000);
  for (const d of Object.keys(h.dias)) if (d < corte) delete h.dias[d];

  _hist[asin] = h;
  return h;
}

/** Estatisticas da serie de um produto. Base de toda decisao de disparo. */
export function estatisticas(asin) {
  const h = _hist[asin];
  if (!h || !h.dias) return null;
  const hoje = Date.now();
  const corte30 = diaSP(hoje - 30 * 86400000);
  const corte90 = diaSP(hoje - 90 * 86400000);

  const pares = Object.entries(h.dias).sort((a, b) => a[0] < b[0] ? -1 : 1);
  const v30 = pares.filter(([d]) => d >= corte30).map(([, v]) => v);
  const v90 = pares.filter(([d]) => d >= corte90).map(([, v]) => v);
  if (!v90.length) return null;

  const ord = [...v30].sort((a, b) => a - b);
  const mediana30 = ord.length
    ? (ord.length % 2 ? ord[(ord.length - 1) / 2] : (ord[ord.length / 2 - 1] + ord[ord.length / 2]) / 2)
    : null;

  return {
    dias: pares.length,
    diasRecentes: v90.length,
    min90: Math.min(...v90),
    max90: Math.max(...v90),
    mediana30,
    ultimo: h.ult?.preco ?? null,
    ultimoEm: h.ult?.em ?? null,
    primeiroDia: pares[0]?.[0] || null,
  };
}

export function historicoDe(asin) {
  const h = _hist[asin];
  if (!h) return null;
  return { asin, nome: h.n, loja: h.loja, ult: h.ult,
           serie: Object.entries(h.dias).sort((a, b) => a[0] < b[0] ? -1 : 1).map(([d, v]) => ({ d, v })),
           stats: estatisticas(asin) };
}

// ── NICHO ────────────────────────────────────────────────────────────────────
// 'geral' e a ausencia de categoria confiavel, nao uma categoria de verdade —
// e o mesmo criterio que o roteamento por trilha ja usa.
function nichoDoProduto(item, titulo) {
  const cls = classificarProduto({ titulo: titulo || item.nome, asin: item.asin, loja: item.loja });
  return {
    nicho: categoriaConfiavel(cls) ? cls.categoria : 'geral',
    classificacao: cls,
    confiavel: categoriaConfiavel(cls),
  };
}

export function regraDoNicho(nicho) {
  return { ..._cfg.regras.padrao, ...(_cfg.regras.porNicho?.[nicho] || {}) };
}

// ── LEITURA DE PRECO POR LOJA ────────────────────────────────────────────────
// Leitura BARATA de proposito: so preco, sem gerar link de afiliado. O link (e
// o rastreio) so e gerado no disparo, para nao queimar cota de API criando
// shortlink de produto que nao vai sair.
async function lerPreco(item) {
  if (item.loja === 'Shopee') {
    if (!credenciaisShopeeOk()) throw new Error('Shopee nao configurada');
    const node = await buscarProdutoShopee({ shopId: item.shopId, itemId: item.itemId });
    if (!node) throw new Error('fora do catalogo de afiliados');
    const p = normalizarShopee(node);
    return { preco: p.preco, precoDe: p.precoDe, disponivel: p.disponivel, titulo: p.titulo };
  }
  if (item.loja === 'Mercado Livre') {
    if (!tokenAffOk()) throw new Error('Mercado Livre nao configurado (ML_AFF_TOKEN)');
    const d = await buscarDadosProdutoMl(item.url || ('https://www.mercadolivre.com.br/p/' + item.asin));
    return { preco: d.preco, precoDe: d.precoDe, disponivel: d.disponivel !== false, titulo: d.titulo };
  }
  if (ehItemAmazon(item)) {
    // Caminho de UM item: usado so pela releitura avulsa. A varredura passa por
    // lerPrecosAmazon, que agrupa de 10 em 10.
    const p = (await lerPrecosAmazon([item])).get(item.asin);
    if (!p) throw new Error('ASIN nao retornado pela API da Amazon');
    return p;
  }
  throw new Error('loja sem leitura de preco: ' + item.loja);
}

/**
 * Leitura em LOTE da Amazon: getItems aceita 10 ASINs por chamada, entao ler um
 * a um seria gastar 10x a cota para o mesmo resultado. Devolve um Map
 * asin -> leitura; ASIN ausente do Map e ASIN que a API nao devolveu (fora do
 * catalogo, retirado do ar ou sem oferta ativa) — quem chama trata como falha
 * daquele item, nunca do lote inteiro.
 */
async function lerPrecosAmazon(itens) {
  const out = new Map();
  if (!itens.length) return out;
  if (!credenciaisAmazonOk()) throw new Error('Amazon nao configurada (AMZ_CLIENT_ID / AMZ_CLIENT_SECRET)');

  const brutos = await buscarProdutosAmazon(itens.map(i => i.asin));
  for (const bruto of brutos) {
    const p = normalizarAmazon(bruto);
    if (!p?.asin) continue;
    out.set(p.asin, { preco: p.preco, precoDe: p.precoDe, disponivel: p.disponivel, titulo: p.titulo });
  }
  return out;
}

// ── DESEMPENHO REAL ──────────────────────────────────────────────────────────
// O ledger e por ASIN da Amazon: e a unica das tres lojas que entrega ganho por
// clique por produto. Shopee e ML devolvem null e seguem sem bonus nem veto —
// ausencia de dado nunca vira penalidade.
export function epcDe(asin) {
  const p = _epc?.produtos?.[asin];
  if (!p || !p.cliques) return null;
  return { epc: p.epc ?? 0, cliques: p.cliques, pedidos: p.pedidos ?? 0,
           comissao: p.comissao ?? 0, conversao: p.conversao ?? null,
           ticket: p.ticket ?? 0, nome: p.nome || '', categoria: p.categoria || '' };
}

/** Estado do ledger para o painel (e para saber se o coletor ja rodou). */
export function estadoEpc() {
  const prods = Object.values(_epc?.produtos || {}).filter(p => p.cliques > 0);
  return {
    disponivel: prods.length > 0,
    atualizadoEm: _epc?.atualizadoEm || null,
    janelaDias: _epc?.janelaDias || null,
    produtos: prods.length,
    totais: _epc?.totais || null,
  };
}

// ── AVALIACAO ────────────────────────────────────────────────────────────────
/**
 * Decide se o preco lido merece virar oferta. Devolve sempre um objeto com
 * `passou` e `motivo` — o motivo alimenta o modo sombra, que e onde o operador
 * calibra as regras antes de ligar o envio.
 */
export function avaliar(item, leitura, stats, nicho) {
  const r = regraDoNicho(nicho);
  const preco = leitura.preco;
  const base = { asin: item.asin, nome: item.nome, loja: item.loja, nicho, preco };

  if (!Number.isFinite(preco) || preco <= 0)  return { ...base, passou: false, motivo: 'sem preco' };
  if (r.exigirDisponivel && leitura.disponivel === false)
                                              return { ...base, passou: false, motivo: 'indisponivel' };
  if (!stats)                                 return { ...base, passou: false, motivo: 'sem serie' };
  if (stats.dias < r.maturidadeMinDias)
    return { ...base, passou: false, motivo: 'serie imatura (' + stats.dias + '/' + r.maturidadeMinDias + ' dias)' };
  if (preco < r.precoMin)                     return { ...base, passou: false, motivo: 'abaixo do preco minimo' };
  if (preco > r.precoMax)                     return { ...base, passou: false, motivo: 'acima do preco maximo' };

  const ref = stats.mediana30 ?? stats.min90;
  if (!Number.isFinite(ref) || ref <= 0)      return { ...base, passou: false, motivo: 'sem referencia' };

  const quedaPct = Math.round((1 - preco / ref) * 1000) / 10;
  const quedaRs  = Math.round((ref - preco) * 100) / 100;
  const limiar   = stats.min90 * (1 + (r.toleranciaMinimoPct || 0) / 100);
  const recorde  = preco <= limiar;

  const detalhe = { ...base, mediana30: stats.mediana30, min90: stats.min90,
                    quedaPct, quedaRs, recorde, diasSerie: stats.dias };

  if (quedaPct < r.quedaMinPct)
    return { ...detalhe, passou: false, motivo: 'queda de ' + quedaPct + '% < ' + r.quedaMinPct + '%' };
  if (quedaRs < r.quedaMinReais)
    return { ...detalhe, passou: false, motivo: 'queda de R$ ' + quedaRs.toFixed(2) + ' < R$ ' + r.quedaMinReais };
  if (r.exigirMinimo90d && !recorde)
    return { ...detalhe, passou: false, motivo: 'nao esta no menor patamar de 90 dias' };

  // Cooldown por produto: vale tanto para disparo do monitor quanto para
  // disparo manual/lista, porque quem recebe e o mesmo grupo.
  const ultimo = item.ultimoDisparo ? Date.parse(item.ultimoDisparo) : 0;
  const diasDesde = ultimo ? (Date.now() - ultimo) / 86400000 : 999;
  if (diasDesde < r.reenvioMinDias)
    return { ...detalhe, passou: false, motivo: 'enviado ha ' + Math.floor(diasDesde) + 'd (minimo ' + r.reenvioMinDias + 'd)' };

  // Veto por desempenho: produto com amostra suficiente que so consome clique
  // nao sai, por mais fundo que esteja o desconto. Sem dado no ledger nao ha
  // veto — ausencia de informacao nao pode virar condenacao.
  const d = epcDe(item.asin);
  const sc = _cfg.desempenho.score;
  if (d && d.cliques >= sc.cliquesParaVeto && d.epc < sc.epcVeto) {
    return { ...detalhe, passou: false, epc: d.epc, cliquesEpc: d.cliques,
             motivo: 'EPC de R$ ' + d.epc.toFixed(2) + ' em ' + d.cliques + ' cliques (minimo R$ '
               + sc.epcVeto.toFixed(2) + ')' };
  }

  // Score: a queda e o corpo da nota; recorde, cupom e desempenho sao bonus. O
  // que ordena a fila continua sendo a profundidade real do desconto — o EPC
  // desempata entre dois descontos parecidos, e e assim que produto que paga
  // bem passa na frente de produto que so tem numero bonito.
  let score = quedaPct;
  if (recorde) score += 10;
  let cupom = null;
  if (_cfg.publicacao.aplicarCupom) {
    try { cupom = melhorCupomAplicavel(item.loja, preco) || null; } catch (e) { cupom = null; }
    if (cupom) score += 5;
  }
  if (d) score += d.epc * sc.pesoEpc;

  return { ...detalhe, passou: true, motivo: 'ok', score: Math.round(score * 10) / 10,
           cupom: cupom?.codigo || null,
           epc: d?.epc ?? null, cliquesEpc: d?.cliques ?? null };
}

// ── SEMEADURA DA VITRINE PELO DESEMPENHO ─────────────────────────────────────
/**
 * Cadastra na vitrine, sozinho, o ASIN que ja provou que converte.
 *
 * A curadoria manual tem um teto obvio: ninguem cola 150 links por semana. E o
 * ledger sabe de coisa que a curadoria nao sabe — conversao acima de 100%
 * significa que a pessoa entrou por um link nosso e comprou AQUILO sem que
 * aquilo tivesse sido divulgado. Esse produto nunca apareceria numa lista feita
 * a mao, porque ninguem sabia que ele existia na cabeca do publico.
 *
 * Só cadastra: o produto entra na vitrine e passa a ser vigiado como qualquer
 * outro, sujeito a mesma regra de disparo. Semear nao e publicar.
 */
export function semearVitrinePorDesempenho({ simular: apenasSimular = false } = {}) {
  const cfg = _cfg.desempenho.semear;
  const prods = Object.values(_epc?.produtos || {});
  const saida = { candidatos: 0, cadastrados: [], ignorados: {}, jaNaVitrine: 0, tetoAtingido: false };

  if (!prods.length) { saida.erro = 'ledger de EPC vazio — o coletor ainda nao rodou'; return saida; }

  const naVitrine = new Set(listarVitrine().map(i => String(i.asin)));
  // Teto conta so o que ESTE mecanismo cadastrou: produto colado a mao nao
  // pode consumir a cota do automatico, nem o contrario.
  const jaSemeados = listarVitrine().filter(i => i.origemSemeadura === 'epc').length;
  let vagas = Math.max(0, cfg.maximo - jaSemeados);

  const elegiveis = prods
    .filter(p => {
      if (!/^B[A-Z0-9]{9}$/.test(String(p.asin || ''))) return false;
      if (naVitrine.has(p.asin)) { saida.jaNaVitrine++; return false; }
      saida.candidatos++;
      if (p.cliques < cfg.cliquesMin) {
        saida.ignorados['amostra pequena (< ' + cfg.cliquesMin + ' cliques)'] =
          (saida.ignorados['amostra pequena (< ' + cfg.cliquesMin + ' cliques)'] || 0) + 1;
        return false;
      }
      if ((p.epc || 0) < cfg.epcMin) {
        saida.ignorados['EPC abaixo de R$ ' + cfg.epcMin.toFixed(2)] =
          (saida.ignorados['EPC abaixo de R$ ' + cfg.epcMin.toFixed(2)] || 0) + 1;
        return false;
      }
      if (!p.nome) {
        saida.ignorados['sem titulo no ledger'] = (saida.ignorados['sem titulo no ledger'] || 0) + 1;
        return false;
      }
      return true;
    })
    // Ordem por comissao total, nao por EPC: entre dois produtos que passam no
    // corte, entra primeiro o que move mais dinheiro de verdade.
    .sort((a, b) => (b.comissao || 0) - (a.comissao || 0));

  for (const p of elegiveis) {
    if (vagas <= 0) { saida.tetoAtingido = true; break; }
    if (saida.cadastrados.length >= cfg.porRodada) break;
    if (!apenasSimular) {
      salvarItemVitrine({
        asin: p.asin, loja: 'Amazon', nome: p.nome,
        url: 'https://www.amazon.com.br/dp/' + p.asin,
        origemSemeadura: 'epc',
      });
    }
    saida.cadastrados.push({ asin: p.asin, nome: p.nome, epc: p.epc, cliques: p.cliques,
                             comissao: p.comissao, conversao: p.conversao });
    vagas--;
  }

  if (!apenasSimular && saida.cadastrados.length) {
    console.log('[PRECOS] Semeadura por desempenho — ' + saida.cadastrados.length
      + ' produto(s) cadastrado(s) na vitrine (EPC >= R$ ' + cfg.epcMin + ').');
  }
  return saida;
}

// ── VARREDURA ────────────────────────────────────────────────────────────────
export async function varrer({ manual = false } = {}) {
  if (_varrendo) return { ok: false, erro: 'varredura ja em andamento' };
  if (!manual && (!_cfg.ativo || _cfg.modo === 'off')) return { ok: false, erro: 'monitor desligado' };

  _varrendo = true;
  const t0 = Date.now();
  const resumo = { lidos: 0, falhas: 0, candidatos: 0, porMotivo: {}, erros: [] };

  // Grava a leitura na serie e decide se vira candidato. Compartilhado pelos
  // dois caminhos de leitura (lote da Amazon e item a item das outras lojas)
  // para que a REGRA seja uma so — duplicar isso seria criar duas verdades.
  const processar = (item, leitura) => {
    registrarPreco(item.asin, {
      nome: leitura.titulo || item.nome, loja: item.loja,
      preco: leitura.preco, precoDe: leitura.precoDe, disponivel: leitura.disponivel,
    });
    resumo.lidos++;

    const stats = estatisticas(item.asin);
    const { nicho } = nichoDoProduto(item, leitura.titulo);
    const av = avaliar(item, leitura, stats, nicho);
    resumo.porMotivo[av.motivo] = (resumo.porMotivo[av.motivo] || 0) + 1;
    if (av.passou) { enfileirar(av); resumo.candidatos++; }
  };

  const falhar = (item, msg) => {
    resumo.falhas++;
    if (resumo.erros.length < 15) resumo.erros.push({ asin: item.asin, nome: item.nome, erro: msg });
  };

  try {
    const itens = itensMonitorados();
    // A Amazon le de 10 em 10; as outras, uma por vez. Separar aqui e o que
    // permite cada API ser usada do jeito mais barato que ela oferece.
    const amazon = itens.filter(ehItemAmazon);
    const outros = itens.filter(i => !ehItemAmazon(i));
    console.log('[PRECOS] Varredura iniciada — ' + itens.length + ' produto(s) ('
      + amazon.length + ' Amazon em lote, ' + outros.length + ' individuais).');

    // ── Amazon, em lotes de 10 ──
    for (let i = 0; i < amazon.length; i += 10) {
      const lote = amazon.slice(i, i + 10);
      try {
        const mapa = await lerPrecosAmazon(lote);
        for (const item of lote) {
          const leitura = mapa.get(item.asin);
          // ASIN que a API nao devolveu e falha DAQUELE item: produto retirado,
          // sem oferta ativa ou fora do catalogo. O lote segue.
          if (!leitura) { falhar(item, 'ASIN nao retornado pela API da Amazon'); continue; }
          try { processar(item, leitura); }
          catch (e) { falhar(item, e.message); }
        }
      } catch (e) {
        // Falha de credencial ou da chamada inteira: o lote todo cai, mas a
        // varredura continua nas demais lojas.
        for (const item of lote) falhar(item, e.message);
      }
      if (i + 10 < amazon.length) await new Promise(r => setTimeout(r, _cfg.varredura.pausaMs));
    }

    // ── Shopee e Mercado Livre, item a item ──
    for (let i = 0; i < outros.length; i++) {
      const item = outros[i];
      try { processar(item, await lerPreco(item)); }
      catch (e) { falhar(item, e.message); }
      // Pausa a cada lote: as APIs limitam por janela curta e nao adianta
      // correr — a varredura tem uma hora inteira para terminar.
      if ((i + 1) % _cfg.varredura.lote === 0) {
        await new Promise(r => setTimeout(r, _cfg.varredura.pausaMs));
      }
    }

    // Semeadura antes de fechar a rodada: produto novo entra na vitrine agora e
    // ja comeca a acumular serie na varredura seguinte.
    if (_cfg.desempenho.semear.ativo) {
      try {
        const s = semearVitrinePorDesempenho();
        resumo.semeados = s.cadastrados.length;
      } catch (e) { console.warn('[PRECOS] Semeadura falhou:', e.message); }
    }

    podarFila();
    _estado.ultimaVarredura = {
      em: new Date().toISOString(), duracaoSeg: Math.round((Date.now() - t0) / 1000),
      ...resumo,
    };
    gravar(ARQ_HIST, _hist);
    gravar(ARQ_ESTADO, _estado);
    console.log('[PRECOS] Varredura concluida em ' + Math.round((Date.now() - t0) / 1000) + 's — '
      + resumo.lidos + ' lido(s), ' + resumo.candidatos + ' candidato(s), ' + resumo.falhas + ' falha(s).');
    return { ok: true, ..._estado.ultimaVarredura, fila: _estado.fila.length };
  } finally {
    _varrendo = false;
  }
}

// Candidato repetido substitui o anterior: o preco de agora vale mais do que o
// preco de tres horas atras, e a fila nao pode crescer com o mesmo produto.
function enfileirar(av) {
  const idx = _estado.fila.findIndex(f => f.asin === av.asin);
  const reg = { ...av, em: new Date().toISOString() };
  if (idx >= 0) _estado.fila[idx] = reg;
  else _estado.fila.push(reg);
}

// Candidato velho e candidato mentiroso: o preco pode ter voltado. Vale ate a
// proxima varredura mais uma folga; passou disso, sai.
function podarFila() {
  const validadeMs = (_cfg.varredura.intervaloMin * 2 + 30) * 60000;
  const agora = Date.now();
  _estado.fila = _estado.fila
    .filter(f => (agora - Date.parse(f.em || 0)) < validadeMs)
    .sort((a, b) => (b.score || 0) - (a.score || 0));
}

// ── COTAS ────────────────────────────────────────────────────────────────────
function garantirCotasDoDia() {
  const dia = diaSP();
  if (_estado.cotas.dia !== dia) {
    _estado.cotas = { dia, porLoja: {}, porNicho: {} };
  }
  return _estado.cotas;
}

function cotaDisponivel(loja, nicho) {
  const c = garantirCotasDoDia();
  const limLoja  = _cfg.publicacao.cotaPorLoja?.[loja];
  const limNicho = _cfg.publicacao.cotaPorNicho?.[nicho];
  if (limLoja !== undefined && (c.porLoja[loja] || 0) >= limLoja)
    return { ok: false, motivo: 'cota diaria de ' + loja + ' esgotada (' + limLoja + ')' };
  if (limNicho !== undefined && (c.porNicho[nicho] || 0) >= limNicho)
    return { ok: false, motivo: 'cota diaria do nicho ' + nicho + ' esgotada (' + limNicho + ')' };
  return { ok: true };
}

function consumirCota(loja, nicho) {
  const c = garantirCotasDoDia();
  c.porLoja[loja]   = (c.porLoja[loja] || 0) + 1;
  c.porNicho[nicho] = (c.porNicho[nicho] || 0) + 1;
}

function dentroDaJanela(ts = Date.now()) {
  const agora = minutosSP(ts);
  for (const j of _cfg.publicacao.janelas) {
    const ini = hhmmParaMin(j.inicio), fim = hhmmParaMin(j.fim);
    if (ini === null || fim === null) continue;
    const dentro = ini <= fim ? (agora >= ini && agora <= fim) : (agora >= ini || agora <= fim);
    if (dentro) return true;
  }
  return false;
}

// ── PUBLICADOR ───────────────────────────────────────────────────────────────
/**
 * Acorda a cada minuto e, no maximo, publica UM item. Toda a decisao de "pode
 * agora?" mora aqui: modo, janela, espacamento, cota, WhatsApp conectado.
 *
 * A revalidacao do preco NAO e opcional: entre a varredura e o disparo podem
 * ter passado 40 minutos, e anunciar preco que nao existe mais e exatamente o
 * erro que este pipeline existe para evitar. Quem revalida e o proprio
 * montarOfertas*Vitrine, que consulta a API de novo no momento do envio.
 */
async function tentarPublicar() {
  if (_publicando) return;
  if (!_cfg.ativo || _cfg.modo !== 'on') return;
  if (!_deps) return;
  if (!dentroDaJanela()) return;
  if (Date.now() - (_estado.ultimoEnvioEm || 0) < _cfg.publicacao.intervaloMin * 60000) return;
  if (!_deps.whatsappPronto()) return;

  podarFila();
  if (!_estado.fila.length) return;

  _publicando = true;
  try {
    // Primeiro item da fila (ja ordenada por score) que ainda tem cota.
    let escolhido = null, bloqueios = [];
    for (const f of _estado.fila) {
      const c = cotaDisponivel(f.loja, f.nicho);
      if (c.ok) { escolhido = f; break; }
      bloqueios.push(c.motivo);
    }
    if (!escolhido) {
      if (bloqueios.length) console.log('[PRECOS] Fila travada por cota — ' + [...new Set(bloqueios)].join('; '));
      return;
    }

    const item = itemVitrine(escolhido.asin);
    if (!item) { removerDaFila(escolhido.asin); return; }

    const r = await dispararMonitorado(item, escolhido);
    removerDaFila(escolhido.asin);

    if (r.ok) {
      consumirCota(escolhido.loja, escolhido.nicho);
      _estado.ultimoEnvioEm = Date.now();
      registrarDisparo({ ...escolhido, precoEnviado: r.preco, grupos: r.grupos, cupom: r.cupom, ok: true });
      console.log('[PRECOS] Enviado: ' + (r.nome || escolhido.nome) + ' — R$ ' + r.preco
        + ' (' + escolhido.quedaPct + '% abaixo da mediana, nicho ' + escolhido.nicho + ', '
        + r.grupos + ' grupo(s)).');
    } else {
      registrarDisparo({ ...escolhido, ok: false, motivo: r.motivo });
      console.log('[PRECOS] Descartado no disparo: ' + escolhido.nome + ' — ' + r.motivo);
    }
    gravar(ARQ_ESTADO, _estado);
  } catch (e) {
    console.error('[PRECOS] Erro no publicador:', e.message);
  } finally {
    _publicando = false;
  }
}

function removerDaFila(asin) {
  _estado.fila = _estado.fila.filter(f => f.asin !== asin);
}

function registrarDisparo(reg) {
  _estado.historicoDisparos.unshift({ ...reg, em: new Date().toISOString() });
  _estado.historicoDisparos = _estado.historicoDisparos.slice(0, 200);
}

/**
 * Monta e envia a oferta de um produto monitorado.
 *
 * Difere do disparo de lista num ponto que importa: a oferta sai COM categoria
 * classificada, e e isso que permite o roteamento por trilha mandar bebida para
 * o grupo de bebidas em vez de jogar tudo no geral.
 */
export async function dispararMonitorado(item, candidato = {}) {
  const codigoCupom = _cfg.publicacao.aplicarCupom ? 'auto' : null;

  let montado;
  if (item.loja === 'Shopee') {
    if (!credenciaisShopeeOk()) return { ok: false, motivo: 'Shopee nao configurada' };
    montado = await _deps.montarShopee([item], codigoCupom);
  } else if (item.loja === 'Mercado Livre') {
    if (!tokenAffOk()) return { ok: false, motivo: 'Mercado Livre nao configurado (ML_AFF_TOKEN)' };
    montado = await _deps.montarMl([item], codigoCupom);
  } else if (ehItemAmazon(item)) {
    if (!credenciaisAmazonOk()) return { ok: false, motivo: 'Amazon nao configurada' };
    // A montagem da Amazon recebe ASINs, nao o objeto do item — e a unica das
    // tres com essa assinatura.
    montado = await _deps.montarAmazon([item.asin], codigoCupom);
  } else {
    return { ok: false, motivo: 'loja fora do monitor: ' + item.loja };
  }

  const o = montado?.prontos?.[0];
  if (!o) return { ok: false, motivo: montado?.descartados?.[0]?.motivo || 'produto descartado' };

  // Segunda trava de preco: se entre a varredura e agora o preco subiu de volta,
  // a oferta morre aqui em vez de sair com desconto que nao existe mais.
  const precoAgora = o.produto?.preco;
  if (Number.isFinite(candidato.preco) && Number.isFinite(precoAgora)) {
    const subiu = (precoAgora - candidato.preco) / candidato.preco;
    if (subiu > 0.03) {
      return { ok: false, motivo: 'preco subiu de R$ ' + candidato.preco.toFixed(2)
        + ' para R$ ' + precoAgora.toFixed(2) + ' entre a varredura e o disparo' };
    }
  }

  const cls = classificarProduto({ titulo: o.produto?.titulo || item.nome, asin: item.asin, loja: item.loja });

  const oferta = {
    id: _deps.gerarId(),
    origem: 'monitor-precos',
    tipoConteudo: item.loja === 'Shopee' ? 'oferta_shopee'
                : item.loja === 'Mercado Livre' ? 'oferta_ml' : 'oferta_amazon',
    mensagemFormatada: o.mensagem,
    dadosExtraidos: {
      loja: o.produto.loja || item.loja, asin: o.asin, titulo: o.produto.titulo,
      preco: o.produto.preco, precoDe: o.produto.precoDe, desconto: o.produto.desconto,
      link: o.produto.link, cupom: o.cupom, precoFinal: o.precoFinal,
      precoDeReferencia: !!o.precoDeReferencia,
      imagemUrl: o.produto.imagemUrl || null,
      // Roteamento por trilha de nicho depende destes dois campos.
      categoria: cls.categoria || null,
      categoriaConfianca: cls.confianca || 0,
      // Rastro do porque esta oferta saiu — aparece no historico do painel.
      monitor: { quedaPct: candidato.quedaPct ?? null, mediana30: candidato.mediana30 ?? null,
                 min90: candidato.min90 ?? null, recorde: !!candidato.recorde },
    },
    imagens: [],
  };

  try {
    const img = await _deps.baixarImagem(o.produto.imagemUrl);
    if (img) oferta.imagens = [img];
  } catch (e) {}

  const env = await _deps.enviarOferta(o.mensagem, null, oferta);
  marcarDisparo(item.asin);
  return { ok: true, nome: o.nome, preco: o.produto.preco, grupos: env.enviados.length,
           cupom: o.cupom?.codigo || null };
}

// ── SIMULACAO (modo sombra em tela) ──────────────────────────────────────────
/**
 * Roda a avaliacao sobre a serie ja gravada, sem tocar em rede. Serve para o
 * operador mexer nas regras e ver na hora quantos produtos passariam — que e a
 * unica forma honesta de calibrar limiar sem cobaia no grupo.
 */
export function simular(regrasParciais = null) {
  const cfgAntes = _cfg;
  if (regrasParciais) _cfg = estruturarCfg({ ..._cfg, regras: regrasParciais });
  try {
    const saida = { passaram: [], reprovados: {}, total: 0 };
    for (const item of itensMonitorados()) {
      const h = _hist[item.asin];
      if (!h?.ult) continue;
      saida.total++;
      const stats = estatisticas(item.asin);
      const { nicho } = nichoDoProduto(item, h.n);
      const av = avaliar(item, { preco: h.ult.preco, precoDe: h.ult.precoDe, disponivel: h.ult.disponivel }, stats, nicho);
      if (av.passou) saida.passaram.push(av);
      else saida.reprovados[av.motivo] = (saida.reprovados[av.motivo] || 0) + 1;
    }
    saida.passaram.sort((a, b) => (b.score || 0) - (a.score || 0));
    return saida;
  } finally {
    _cfg = cfgAntes;
  }
}

// ── ESTADO PARA O PAINEL ─────────────────────────────────────────────────────
export function estadoMonitorPrecos() {
  garantirCotasDoDia();
  podarFila();
  const itens = itensMonitorados();
  const comSerie = itens.filter(i => _hist[i.asin]?.ult).length;
  const maduros = itens.filter(i => {
    const s = estatisticas(i.asin);
    return s && s.dias >= regraDoNicho('geral').maturidadeMinDias;
  }).length;

  return {
    config: _cfg,
    varrendo: _varrendo,
    ultimaVarredura: _estado.ultimaVarredura,
    monitorados: itens.length,
    comSerie,
    maduros,
    fila: _estado.fila,
    cotas: _estado.cotas,
    limites: { porLoja: _cfg.publicacao.cotaPorLoja, porNicho: _cfg.publicacao.cotaPorNicho },
    ultimoEnvioEm: _estado.ultimoEnvioEm || null,
    proximoEnvioLiberadoEm: (_estado.ultimoEnvioEm || 0) + _cfg.publicacao.intervaloMin * 60000,
    dentroDaJanela: dentroDaJanela(),
    historicoDisparos: _estado.historicoDisparos.slice(0, 50),
    lojasDisponiveis: LOJAS_MONITORAVEIS_PRECO,
    epc: estadoEpc(),
    semeados: listarVitrine().filter(i => i.origemSemeadura === 'epc').length,
  };
}

/** Lista de monitorados com estatistica — a tabela principal da aba. */
export function listarMonitorados() {
  return itensMonitorados()
    .map(i => {
      const s = estatisticas(i.asin);
      const h = _hist[i.asin];
      const { nicho } = nichoDoProduto(i, h?.n);
      return {
        asin: i.asin, nome: h?.n || i.nome, loja: i.loja, nicho,
        precoAtual: h?.ult?.preco ?? null,
        lidoEm: h?.ult?.em ?? null,
        disponivel: h?.ult?.disponivel ?? null,
        dias: s?.dias || 0,
        min90: s?.min90 ?? null,
        max90: s?.max90 ?? null,
        mediana30: s?.mediana30 ?? null,
        quedaPct: (s?.mediana30 && h?.ult?.preco)
          ? Math.round((1 - h.ult.preco / s.mediana30) * 1000) / 10 : null,
        ultimoDisparo: i.ultimoDisparo || null,
      };
    })
    .sort((a, b) => (b.quedaPct ?? -999) - (a.quedaPct ?? -999));
}

/**
 * Ranking do ledger para o painel: o que paga por clique e o que so consome.
 * `naVitrine` diz se o produto ja esta sendo vigiado — e a lista de compras da
 * curadoria manual para o que ainda nao esta.
 */
export function rankingEpc({ limite = 100 } = {}) {
  const naVitrine = new Set(listarVitrine().map(i => String(i.asin)));
  const sc = _cfg.desempenho.score;
  return Object.values(_epc?.produtos || {})
    .filter(p => p.cliques > 0)
    .sort((a, b) => (b.comissao || 0) - (a.comissao || 0))
    .slice(0, limite)
    .map(p => ({
      asin: p.asin, nome: p.nome, categoria: p.categoria || '',
      cliques: p.cliques, pedidos: p.pedidos, comissao: p.comissao,
      epc: p.epc, conversao: p.conversao, ticket: p.ticket,
      naVitrine: naVitrine.has(p.asin),
      vetado: p.cliques >= sc.cliquesParaVeto && p.epc < sc.epcVeto,
      // Conversao acima de 100% e venda indireta: comprado sem ter sido
      // divulgado. E o sinal mais forte de demanda que este relatorio da.
      indireta: (p.conversao ?? 0) > 100,
    }));
}

/** Descarta um candidato manualmente (o operador viu e nao quer). */
export function descartarCandidato(asin) {
  const antes = _estado.fila.length;
  removerDaFila(asin);
  gravar(ARQ_ESTADO, _estado);
  return antes !== _estado.fila.length;
}

/** Publica um candidato AGORA, ignorando janela e espacamento (nao a cota). */
export async function publicarAgora(asin) {
  const cand = _estado.fila.find(f => f.asin === asin);
  const item = itemVitrine(asin);
  if (!item) return { ok: false, motivo: 'produto nao esta na vitrine' };
  if (!_deps) return { ok: false, motivo: 'monitor nao inicializado' };
  if (!_deps.whatsappPronto()) return { ok: false, motivo: 'WhatsApp nao conectado' };

  const r = await dispararMonitorado(item, cand || {});
  removerDaFila(asin);
  if (r.ok) {
    const nicho = cand?.nicho || nichoDoProduto(item, _hist[asin]?.n).nicho;
    consumirCota(item.loja, nicho);
    _estado.ultimoEnvioEm = Date.now();
    registrarDisparo({ ...(cand || { asin, nome: item.nome, loja: item.loja }), manual: true,
                       precoEnviado: r.preco, grupos: r.grupos, cupom: r.cupom, ok: true });
  } else {
    registrarDisparo({ ...(cand || { asin, nome: item.nome, loja: item.loja }), manual: true, ok: false, motivo: r.motivo });
  }
  gravar(ARQ_ESTADO, _estado);
  return r;
}

// ── BOOT ─────────────────────────────────────────────────────────────────────
function reprogramarVarredura() {
  if (_timerVarredura) clearInterval(_timerVarredura);
  _timerVarredura = null;
  if (!_cfg.ativo || _cfg.modo === 'off') return;
  _timerVarredura = setInterval(() => {
    varrer().catch(e => console.error('[PRECOS] Varredura falhou:', e.message));
  }, _cfg.varredura.intervaloMin * 60000);
}

/**
 * deps: { enviarOferta, montarShopee, montarMl, montarAmazon, baixarImagem,
 *         gerarId, whatsappPronto }
 * Injecao em vez de import para nao criar ciclo com server.js.
 */
export function iniciarMonitorPrecos(deps) {
  _deps = deps;
  carregarMonitorPrecos();
  reprogramarVarredura();
  // Publicador roda sempre: e ele que respeita o modo, entao ligar/desligar em
  // tela tem efeito imediato sem reprogramar timer.
  setInterval(() => { tentarPublicar().catch(e => console.error('[PRECOS] Publicador:', e.message)); }, 60000);
  // Primeira varredura 2 min depois do boot: o WhatsApp e as credenciais ainda
  // estao subindo no instante zero.
  if (_cfg.ativo && _cfg.modo !== 'off') {
    setTimeout(() => { varrer().catch(() => {}); }, 120000);
  }
  console.log('[PRECOS] Monitor de precos inicializado.');
}
