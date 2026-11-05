// ═══════════════════════════════════════════════════════════════════════════
// awin-ofertas.js — Descoberta automatica de ofertas nos feeds da Awin.
//
// O problema que este arquivo resolve nao e ACHAR oferta: e achar POUCAS.
// Medicao real dos feeds BR (agosto/2026), so produtos acima de R$ 100:
//
//   Dafiti      308.904 produtos -> 7.783 com 60%+  -> 1.545 com 70%+
//   Posthaus     56.816 produtos ->   673 com 60%+  ->    62 com 70%+
//   Nike          5.760 produtos ->    44 com 60%+  ->     0 com 70%+
//   C&A / ASICS / Fut Fanatics   -> ZERO (nao informam preco de lista)
//
// Ou seja: o volume vem de uma ou duas lojas de moda onde preco riscado e
// estrutural, nao promocao. Filtro de percentual sozinho nao segura nada — o
// que segura e COTA. Nada e enviado sem passar por um teto diario, um teto por
// loja e um bloqueio de repeticao do mesmo produto.
//
// Ordem de corte: percentual -> preco -> dedup por variacao (feed de moda
// repete a mesma peca por tamanho/cor) -> ja ofertado -> ranking -> cota.
// ═══════════════════════════════════════════════════════════════════════════

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import {
  varrerFeedComDesconto, listarAnunciantesComFeed, credenciaisFeedOk, atualizarFeedList,
} from './awin-feed.js';

const OFERTADOS_PATH = './sessao/awin_ofertados.json';
const CONFIG_PATH    = './sessao/awin_config.json';

let _ofertados = {};   // chave (loja|produto) -> ISO do ultimo envio
let _cfg = null;       // config gravada pelo painel (null = ainda nao lida)

// ── LOJAS LIBERADAS E REGRAS POR LOJA (05/11/2026) ──
// Com regrasLojas preenchido, so essas lojas sao varridas e cada uma tem o
// proprio corte: um minPct unico de 60% travava a Wine (vinho raramente passa
// de 40%) e deixava a Dafiti passar demais (preco riscado o ano todo).
// Chave = advertiserId da Awin. maxDia = teto de ofertas da loja por dia.
// Ficam de fora: C&A (feed sem preco "De"), Posthaus e Vivara (publico/ticket
// fora do que o grupo compra). Lojas sem feed (Under Armour, PUMA, Decathlon,
// farmacias, Evino, grupo SBF de calcados) so entram pelos cupons.
export const REGRAS_LOJAS_PADRAO = {
  '17806': { nome: 'Centauro',      minPct: 50, minPreco: 80,  maxDia: 4 },
  '17652': { nome: 'Nike',          minPct: 50, minPreco: 100, maxDia: 3 },
  '17697': { nome: 'Dafiti',        minPct: 70, minPreco: 100, maxDia: 2 },
  '17770': { nome: 'Wine',          minPct: 35, minPreco: 60,  maxDia: 2 },
  '17698': { nome: 'Olympikus',     minPct: 50, minPreco: 80,  maxDia: 2 },
  '23659': { nome: 'ASICS',         minPct: 50, minPreco: 150, maxDia: 2 },
  '51271': { nome: 'Mizuno',        minPct: 50, minPreco: 150, maxDia: 2 },
  '17893': { nome: 'Fut Fanatics',  minPct: 50, minPreco: 80,  maxDia: 2 },
  '29407': { nome: 'Beleza na Web', minPct: 50, minPreco: 50,  maxDia: 2 },
};

// Cupons da Awin: so lojas que fazem sentido para o grupo e desconto que
// chame atencao. As lojas das ofertas entram sozinhas; aqui vao as que so
// tem cupom (sem feed de produtos).
export const CUPONS_FILTRO_PADRAO = {
  ativo: true,
  lojas: ['17648', '17658', '17659', '17818', '17919', '18864', '19296',
          '28773', '28775', '28777', '32675', '64086'],
  minPct: 15,          // cupom de % abaixo disso nao vira card
  minReais: 30,        // cupom de R$ abaixo disso nao vira card
  maxMinimoVezes: 8,   // cupom de R$ com compra minima > 8x o valor e fraco
};

// Padrao usado quando nao ha nada gravado. As variaveis de ambiente continuam
// valendo como valor inicial — o que o painel gravar passa a mandar, para o
// operador poder calibrar sem redeploy.
function padraoDaConfig() {
  const n = (v, padrao) => { const x = Number(v); return isFinite(x) && x >= 0 ? x : padrao; };
  return {
    modo:              (process.env.AWIN_OFERTAS || 'off').toLowerCase(),  // off | fila | on
    minPct:            n(process.env.AWIN_OFERTAS_MIN_PCT, 60),
    minPreco:          n(process.env.AWIN_OFERTAS_MIN_PRECO, 100),
    maxPreco:          Number(process.env.AWIN_OFERTAS_MAX_PRECO) || null,
    maxDia:            n(process.env.AWIN_OFERTAS_MAX_DIA, 24),
    maxRodada:         n(process.env.AWIN_OFERTAS_MAX_RODADA, 1),
    maxLojaDia:        n(process.env.AWIN_OFERTAS_MAX_LOJA_DIA, 4),
    repetirDias:       n(process.env.AWIN_OFERTAS_REPETIR_DIAS, 30),
    // Publicacao de meia em meia hora; varredura dos feeds a cada 6h.
    intervaloMin:      n(process.env.AWIN_OFERTAS_INTERVALO_MIN, 30),
    varreduraMin:      n(process.env.AWIN_VARREDURA_MIN, 360),
    horaInicio:        process.env.AWIN_OFERTAS_INICIO || '08:00',
    horaFim:           process.env.AWIN_OFERTAS_FIM    || '20:00',
    candidatoTtlHoras: n(process.env.AWIN_CANDIDATO_TTL_H, 12),
    maxFeedsPorRodada: n(process.env.AWIN_OFERTAS_MAX_FEEDS, 6),
    lojas: String(process.env.AWIN_OFERTAS_LOJAS || '').split(',').map(s => s.trim()).filter(Boolean),
    regrasLojas:       REGRAS_LOJAS_PADRAO,
    // No modo 'on', so sai sozinha a oferta com preco confirmado na pagina da
    // loja; a que ficou so com o preco do feed vira card para aprovacao.
    exigirConfirmacao: true,
    cuponsFiltro:      CUPONS_FILTRO_PADRAO,
    // Cupons da Offers API: mesmo lugar, para a Awin ter uma config so.
    cupons:        (process.env.AWIN_CUPONS || 'off').toLowerCase(),       // off | fila | on
    cupomPollMin:  n(process.env.AWIN_POLL_MIN, 20),
    precoTtlHoras: n(process.env.AWIN_PRECO_TTL_H, 24),
    feedTtlHoras:  n(process.env.AWIN_FEED_TTL_H, 12),
  };
}

export function carregarConfigOfertasAwin() {
  try {
    if (existsSync(CONFIG_PATH)) _cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) || {};
  } catch (e) { console.log('[AWIN-OFERTAS] Erro ao ler config:', e.message); _cfg = {}; }
  return configOfertasAwin();
}

export function configOfertasAwin() {
  return { ...padraoDaConfig(), ...(_cfg || {}) };
}

function temRegras(cfg) {
  return !!(cfg.regrasLojas && typeof cfg.regrasLojas === 'object' && Object.keys(cfg.regrasLojas).length);
}

/** Loja liberada? Sem regras gravadas, toda loja vale (comportamento antigo). */
export function lojaLiberadaAwin(advertiserId, cfg = configOfertasAwin()) {
  if (!temRegras(cfg)) return true;
  return !!cfg.regrasLojas[String(advertiserId)];
}

/** Corte efetivo da loja: regra propria, senao o geral. */
export function regraDaLojaAwin(advertiserId, cfg = configOfertasAwin()) {
  const r = (temRegras(cfg) && cfg.regrasLojas[String(advertiserId)]) || {};
  const num = (v, padrao) => (v === undefined || v === null || !isFinite(Number(v))) ? padrao : Number(v);
  return {
    minPct:   num(r.minPct, cfg.minPct),
    minPreco: num(r.minPreco, cfg.minPreco),
    maxDia:   num(r.maxDia, cfg.maxLojaDia),
  };
}

/**
 * Cupom da Awin vale virar card? Loja precisa estar nas lojas das ofertas ou
 * na lista propria dos cupons, e o desconto precisa ser relevante.
 */
export function cupomAwinPassaFiltro(cupom, advertiserId, cfg = configOfertasAwin()) {
  const f = cfg.cuponsFiltro || {};
  if (f.ativo === false) return { ok: true };
  const id = String(advertiserId || '');
  const lojas = new Set([...(f.lojas || []).map(String),
                         ...(temRegras(cfg) ? Object.keys(cfg.regrasLojas) : [])]);
  if (lojas.size && !lojas.has(id)) return { ok: false, motivo: 'loja fora da lista dos cupons' };
  const valor = Number(cupom?.valor) || 0;
  if (cupom?.tipo === 'pct' && valor < (Number(f.minPct) || 0)) {
    return { ok: false, motivo: valor + '% abaixo do minimo de ' + f.minPct + '%' };
  }
  if (cupom?.tipo === 'reais') {
    if (valor < (Number(f.minReais) || 0)) return { ok: false, motivo: 'R$ ' + valor + ' abaixo do minimo de R$ ' + f.minReais };
    const minimo = Number(cupom?.minimo) || 0;
    if (f.maxMinimoVezes && minimo > valor * Number(f.maxMinimoVezes)) {
      return { ok: false, motivo: 'compra minima de R$ ' + minimo + ' alta demais para R$ ' + valor + ' de desconto' };
    }
  }
  return { ok: true };
}

// Faixas de validacao: um maxDia digitado como 600 no painel viraria spam, e um
// minPct de 5 encheria a fila com "promocao" de 5%.
const LIMITES = {
  minPct: [1, 99], minPreco: [0, 100000], maxPreco: [0, 1000000],
  maxDia: [0, 100], maxRodada: [0, 20], maxLojaDia: [0, 40],
  repetirDias: [1, 365], intervaloMin: [5, 1440], varreduraMin: [30, 10080],
  candidatoTtlHoras: [1, 168], maxFeedsPorRodada: [1, 60],
  cupomPollMin: [5, 1440], precoTtlHoras: [1, 720], feedTtlHoras: [1, 168],
};

export function salvarConfigOfertasAwin(dados = {}) {
  const atual = configOfertasAwin();
  const nova = { ...atual };

  for (const [campo, [min, max]] of Object.entries(LIMITES)) {
    if (dados[campo] === undefined) continue;
    if (dados[campo] === null && campo === 'maxPreco') { nova.maxPreco = null; continue; }
    const v = Number(dados[campo]);
    if (!isFinite(v)) throw new Error(campo + ' precisa ser numero');
    if (v < min || v > max) throw new Error(campo + ' fora da faixa permitida (' + min + '-' + max + ')');
    nova[campo] = v;
  }
  for (const campo of ['modo', 'cupons']) {
    if (dados[campo] === undefined) continue;
    const v = String(dados[campo]).toLowerCase();
    if (!['off', 'fila', 'on'].includes(v)) throw new Error(campo + ' deve ser off, fila ou on');
    nova[campo] = v;
  }
  for (const campo of ['horaInicio', 'horaFim']) {
    if (dados[campo] === undefined) continue;
    const v = String(dados[campo]).trim();
    // Horario invalido cairia no padrao silenciosamente e o operador nunca
    // saberia por que a janela nao mudou.
    if (!/^\d{1,2}:\d{2}$/.test(v)) throw new Error(campo + ' deve estar no formato HH:MM');
    const [h, m] = v.split(':').map(Number);
    if (h > 23 || m > 59) throw new Error(campo + ' tem horario invalido');
    nova[campo] = v.padStart(5, '0');
  }
  if (dados.exigirConfirmacao !== undefined) nova.exigirConfirmacao = !!dados.exigirConfirmacao;
  if (dados.regrasLojas !== undefined) {
    if (!dados.regrasLojas || typeof dados.regrasLojas !== 'object') throw new Error('regrasLojas precisa ser objeto');
    const limpas = {};
    for (const [id, r] of Object.entries(dados.regrasLojas)) {
      if (!/^\d+$/.test(String(id))) throw new Error('regrasLojas: chave ' + id + ' nao e advertiserId');
      const item = { nome: String(r?.nome || '').slice(0, 60) };
      for (const [campo, [min, max]] of [['minPct', [1, 99]], ['minPreco', [0, 100000]], ['maxDia', [0, 40]]]) {
        if (r?.[campo] === undefined) continue;
        const v = Number(r[campo]);
        if (!isFinite(v) || v < min || v > max) throw new Error('regrasLojas.' + id + '.' + campo + ' fora da faixa (' + min + '-' + max + ')');
        item[campo] = v;
      }
      limpas[String(id)] = item;
    }
    nova.regrasLojas = limpas;
  }
  if (dados.cuponsFiltro !== undefined) {
    const f = dados.cuponsFiltro || {};
    nova.cuponsFiltro = {
      ativo: f.ativo !== false,
      lojas: (Array.isArray(f.lojas) ? f.lojas : String(f.lojas || '').split(',')).map(x => String(x).trim()).filter(Boolean),
      minPct: Math.max(0, Math.min(99, Number(f.minPct) || 0)),
      minReais: Math.max(0, Number(f.minReais) || 0),
      maxMinimoVezes: Math.max(0, Number(f.maxMinimoVezes) || 0),
    };
  }
  if (dados.lojas !== undefined) {
    nova.lojas = (Array.isArray(dados.lojas) ? dados.lojas : String(dados.lojas).split(','))
      .map(x => String(x).trim()).filter(Boolean);
  }

  _cfg = nova;
  try {
    if (!existsSync('./sessao')) mkdirSync('./sessao', { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(nova, null, 2));
  } catch (e) { console.log('[AWIN-OFERTAS] Falha ao gravar config:', e.message); }
  return nova;
}

export function carregarOfertadosAwin() {
  try {
    if (existsSync(OFERTADOS_PATH)) _ofertados = JSON.parse(readFileSync(OFERTADOS_PATH, 'utf-8')) || {};
  } catch { _ofertados = {}; }
  return _ofertados;
}

function salvarOfertados() {
  const cfg = configOfertasAwin();
  const limite = Date.now() - Math.max(cfg.repetirDias, 1) * 24 * 3600 * 1000;
  for (const [k, v] of Object.entries(_ofertados)) {
    const t = new Date(v).getTime();
    if (isFinite(t) && t < limite) delete _ofertados[k];
  }
  try {
    if (!existsSync('./sessao')) mkdirSync('./sessao', { recursive: true });
    writeFileSync(OFERTADOS_PATH, JSON.stringify(_ofertados));
  } catch (e) { console.log('[AWIN-OFERTAS] Falha ao gravar historico:', e.message); }
}

export function marcarOfertado(chave) {
  _ofertados[chave] = new Date().toISOString();
  salvarOfertados();
}

function jaOfertado(chave, repetirDias) {
  const quando = _ofertados[chave];
  if (!quando) return false;
  const t = new Date(quando).getTime();
  if (!isFinite(t)) return false;
  return Date.now() - t < repetirDias * 24 * 3600 * 1000;
}

/** Quantas ofertas ja sairam hoje, no total e por loja. */
export function usoDeHoje() {
  const hoje = new Date().toISOString().slice(0, 10);
  const porLoja = {};
  let total = 0;
  for (const [chave, quando] of Object.entries(_ofertados)) {
    if (String(quando).slice(0, 10) !== hoje) continue;
    total++;
    const loja = chave.split('|')[0];
    porLoja[loja] = (porLoja[loja] || 0) + 1;
  }
  return { total, porLoja };
}

// ── FILA DE CANDIDATOS ───────────────────────────────────────────────────────
// Varrer os feeds e caro: o da Dafiti sozinho tem 308 mil linhas. Fazer isso a
// cada publicacao (de meia em meia hora) seria desperdicio puro. As duas etapas
// ficam separadas: a varredura roda de poucas em poucas horas e enche uma fila
// rankeada; a publicacao so tira o proximo da fila.

const CANDIDATOS_PATH = './sessao/awin_candidatos.json';
let _candidatos = [];
let _candidatosEm = 0;
let _ponteiroLoja = 0;   // rotacao entre lojas a cada varredura

export function carregarCandidatosAwin() {
  try {
    if (existsSync(CANDIDATOS_PATH)) {
      const b = JSON.parse(readFileSync(CANDIDATOS_PATH, 'utf-8'));
      _candidatos = Array.isArray(b.lista) ? b.lista : [];
      _candidatosEm = Number(b.em) || 0;
    }
  } catch { _candidatos = []; }
  return _candidatos;
}

function salvarCandidatos() {
  try {
    if (!existsSync('./sessao')) mkdirSync('./sessao', { recursive: true });
    writeFileSync(CANDIDATOS_PATH, JSON.stringify({ em: _candidatosEm, lista: _candidatos }));
  } catch (e) { console.log('[AWIN-OFERTAS] Falha ao gravar candidatos:', e.message); }
}

export function estadoCandidatos() {
  const cfg = configOfertasAwin();
  const porLoja = {};
  for (const c of _candidatos) porLoja[c.loja] = (porLoja[c.loja] || 0) + 1;
  return {
    total: _candidatos.length,
    porLoja,
    coletadoEm: _candidatosEm ? new Date(_candidatosEm).toISOString() : null,
    idadeHoras: _candidatosEm ? Math.round((Date.now() - _candidatosEm) / 360000) / 10 : null,
    validadeHoras: cfg.candidatoTtlHoras,
  };
}

/**
 * Varre uma fatia dos feeds e reabastece a fila de candidatos.
 * Nao envia nada e nao consome cota — so descobre o que existe.
 */
export async function reabastecerCandidatosAwin({ forcar = false } = {}) {
  if (!credenciaisFeedOk()) return { ok: false, erro: 'AWIN_FEED_APIKEY nao configurada' };
  const cfg = configOfertasAwin();

  // A lista de feeds so e baixada no boot. Credencial colada pelo painel depois
  // disso deixava o indice vazio e a varredura falhava pedindo uma "atualizacao"
  // que o operador nao tinha como disparar — agora ela se resolve sozinha.
  // Regras por loja mandam na lista; sem elas vale o filtro antigo (lojas) e,
  // sem nada, todos os anunciantes com feed.
  const lojasDaConfig = () => temRegras(cfg)
    ? Object.keys(cfg.regrasLojas).map(Number).filter(Boolean)
    : (cfg.lojas.length ? cfg.lojas.map(Number).filter(Boolean) : null);
  const comFeed = () => {
    const todos = listarAnunciantesComFeed();
    const alvo = lojasDaConfig();
    if (!alvo) return todos;
    const temFeed = new Set(todos.map(Number));
    return alvo.filter(id => temFeed.has(id));
  };
  let ids = comFeed();
  if (!ids.length) {
    try {
      await atualizarFeedList(true);
      ids = comFeed();
    } catch (e) {
      return { ok: false, erro: 'nao foi possivel baixar a lista de feeds: ' + e.message };
    }
  }
  if (!ids.length) {
    return { ok: false, erro: 'a Awin nao devolveu nenhum catalogo para esta conta — confira a API key dos feeds' };
  }

  // Fatia rotativa: varrer 50 feeds de uma vez estouraria o tempo da rodada, e
  // sem rotacao as ultimas lojas da lista nunca seriam olhadas.
  const quantos = Math.min(cfg.maxFeedsPorRodada, ids.length);
  const fatia = [];
  for (let i = 0; i < quantos; i++) fatia.push(ids[(_ponteiroLoja + i) % ids.length]);
  _ponteiroLoja = (_ponteiroLoja + quantos) % ids.length;

  const examinadas = [];
  const novos = [];
  for (const id of fatia) {
    let achados = [];
    try {
      const regra = regraDaLojaAwin(id, cfg);
      achados = await varrerFeedComDesconto(id, {
        minPct: regra.minPct, minPreco: regra.minPreco, maxPreco: cfg.maxPreco, limite: 60,
      });
    } catch (e) { console.log('[AWIN-OFERTAS] Falha na loja ' + id + ': ' + e.message); continue; }

    const nomeCru = achados[0]?.anunciante || String(id);
    const loja = nomeCru.replace(/\s*\(?(BR(\s*&\s*LATAM)?|LATAM|Global)\)?\s*$/i, '').trim();
    const aproveitados = achados
      .filter(p => !jaOfertado(loja + '|' + p.chave, cfg.repetirDias))
      .map(p => ({ ...p, loja, chaveHistorico: loja + '|' + p.chave }));
    examinadas.push({ loja, encontrados: achados.length, novos: aproveitados.length });
    novos.push(...aproveitados);
  }

  // Junta com o que ja havia, sem duplicar, e mantem os melhores no topo.
  const porChave = new Map();
  if (!forcar) for (const c of _candidatos) porChave.set(c.chaveHistorico, c);
  for (const c of novos) porChave.set(c.chaveHistorico, c);

  _candidatos = [...porChave.values()]
    .filter(c => !jaOfertado(c.chaveHistorico, cfg.repetirDias))
    .sort((a, b) => (b.desconto - a.desconto) || (b.preco - a.preco))
    .slice(0, 500);
  _candidatosEm = Date.now();
  salvarCandidatos();

  console.log('[AWIN-OFERTAS] Varredura — ' + examinadas.length + ' loja(s), fila com '
    + _candidatos.length + ' candidato(s).');
  return { ok: true, examinadas, naFila: _candidatos.length };
}

/**
 * Fila inteira, ja ranqueada (desconto desc, depois preco desc), com o motivo
 * de cada bloqueio anexado. O painel precisa VER a fila para o operador poder
 * escolher — a simulacao mostra so o que sai na proxima rodada (maxRodada),
 * o que dava a impressao de haver um candidato quando ha centenas.
 *
 * O bloqueio nao impede nada: escolha manual passa por cima das cotas. Ele
 * existe para o operador saber que aquele item nao sairia sozinho hoje.
 */
export function candidatosRanqueados({ limite = 150 } = {}) {
  const cfg = configOfertasAwin();
  const uso = usoDeHoje();
  const usados = { ...uso.porLoja };
  const vencida = _candidatosEm
    && (Date.now() - _candidatosEm) > cfg.candidatoTtlHoras * 3600 * 1000;

  return _candidatos.slice(0, limite).map((c, i) => {
    // Conta acumulada: o 5o item da Nike ja estoura um teto de 4/dia mesmo que
    // nenhum tenha saido ainda, porque os anteriores da lista sairiam antes.
    const tetoLoja = regraDaLojaAwin(c.advertiserId, cfg).maxDia;
    const liberada = lojaLiberadaAwin(c.advertiserId, cfg);
    const noTeto = (usados[c.loja] || 0) >= tetoLoja;
    usados[c.loja] = (usados[c.loja] || 0) + 1;
    return {
      posicao: i + 1,
      chaveHistorico: c.chaveHistorico,
      loja: c.loja,
      advertiserId: c.advertiserId,
      titulo: c.titulo || '',
      preco: c.preco,
      precoDe: c.precoDe,
      desconto: c.desconto,
      imagem: c.imagem || null,
      marca: c.marca || '',
      urlLoja: c.urlLoja || '',
      linkAfiliado: c.linkAfiliado || '',
      bloqueio: vencida ? 'preço pode estar vencido — varra os catálogos'
              : !liberada ? 'loja fora da lista liberada'
              : (noTeto ? 'loja já no teto de hoje (' + tetoLoja + '/dia)' : null),
    };
  });
}

/**
 * Tira candidatos da fila pelo chaveHistorico e devolve os retirados.
 * Usado quando o operador manda o produto para a vitrine: sem isto o
 * publicador automatico mandaria o mesmo item de novo por conta propria.
 */
export function retirarCandidatos(chaves = []) {
  const fora = new Set(chaves);
  const escolhidos = _candidatos.filter(c => fora.has(c.chaveHistorico));
  if (escolhidos.length) {
    _candidatos = _candidatos.filter(c => !fora.has(c.chaveHistorico));
    salvarCandidatos();
  }
  return escolhidos;
}

/** Vagas disponiveis agora, considerando cota do dia, da rodada e da loja. */
export function vagasAgora() {
  const cfg = configOfertasAwin();
  const uso = usoDeHoje();
  const doDia = Math.max(0, cfg.maxDia - uso.total);
  const daRodada = cfg.maxRodada > 0 ? cfg.maxRodada : cfg.maxDia;
  return { cfg, uso, vagas: Math.min(doDia, daRodada) };
}

/** Janela de publicacao propria da Awin — independente da janela dos cupons. */
export function dentroDaJanelaAwin(quando = new Date()) {
  const cfg = configOfertasAwin();
  const emSp = new Date(quando.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const minutos = emSp.getHours() * 60 + emSp.getMinutes();
  const paraMin = (hhmm, padrao) => {
    const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return padrao;
    return Number(m[1]) * 60 + Number(m[2]);
  };
  const ini = paraMin(cfg.horaInicio, 8 * 60);
  const fim = paraMin(cfg.horaFim, 20 * 60);
  if (minutos < ini || minutos >= fim) {
    return { ok: false, motivo: 'fora da janela de ofertas (' + cfg.horaInicio + '-' + cfg.horaFim + ')' };
  }
  return { ok: true };
}

/**
 * Retira da fila os proximos candidatos publicaveis agora.
 * `simular` nao remove nada da fila nem gasta cota.
 */
export function proximosCandidatos({ simular = false } = {}) {
  const { cfg, uso, vagas } = vagasAgora();
  if (!simular && vagas <= 0) return { vagas: 0, escolhidos: [], motivo: 'cota do dia esgotada' };

  // Candidato velho tem preco velho: melhor deixar vencer e esperar a proxima
  // varredura do que anunciar valor que ja mudou na loja.
  const limite = Date.now() - cfg.candidatoTtlHoras * 3600 * 1000;
  if (_candidatosEm && _candidatosEm < limite) {
    return { vagas, escolhidos: [], motivo: 'fila vencida — aguardando nova varredura' };
  }

  const escolhidos = [];
  const usadosLoja = { ...uso.porLoja };
  const quantos = simular ? (cfg.maxRodada || 1) : vagas;

  for (const c of _candidatos) {
    if (escolhidos.length >= quantos) break;
    if (!lojaLiberadaAwin(c.advertiserId, cfg)) continue;
    if ((usadosLoja[c.loja] || 0) >= regraDaLojaAwin(c.advertiserId, cfg).maxDia) continue;
    if (jaOfertado(c.chaveHistorico, cfg.repetirDias)) continue;
    escolhidos.push(c);
    usadosLoja[c.loja] = (usadosLoja[c.loja] || 0) + 1;
  }

  if (!simular && escolhidos.length) {
    const fora = new Set(escolhidos.map(c => c.chaveHistorico));
    _candidatos = _candidatos.filter(c => !fora.has(c.chaveHistorico));
    salvarCandidatos();
  }

  return {
    vagas, escolhidos,
    motivo: escolhidos.length ? null
      : (_candidatos.length ? 'nenhum candidato dentro do limite por loja' : 'fila vazia'),
  };
}
