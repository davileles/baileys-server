// ═══════════════════════════════════════════════════════════════════════════
// categorizador.js — Classificacao de categoria do produto para o radar TSP
//
// Por que existe: grupos de nicho (bebidas, eletronicos, ...) so fazem sentido
// se o pipeline souber, na hora da captura, em que prateleira o produto cai.
// A classificacao entra no objeto `oferta` e passa a valer para o roteamento
// de destinos, para a vitrine publica e para relatorio.
//
// Cascata (do mais confiavel para o menos):
//   1. Breadcrumb da Amazon em cache (asin -> trilha de categoria)  conf 0.95
//   2. Palavras-chave no titulo do produto                          conf 0.85
//   3. Indefinido (categoria null) — nunca chuta
//
// O caminho critico NAO faz rede: buscar a pagina da Amazon no meio do envio
// custaria segundos e convida bloqueio. O enriquecimento do cache roda em
// background (enriquecerAmazon) e beneficia as proximas capturas do mesmo ASIN.
//
// Taxonomia editavel em tsp/categorias.json (cdv-tsp-dados) — mexer nela nao
// exige deploy, so /sync/pull.
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { agendarPush } from './sync-github.js';

const SESSAO_DIR   = './sessao';
const ARQ_TAXO     = SESSAO_DIR + '/categorias.json';
const ARQ_CACHE    = SESSAO_DIR + '/categorias_cache.json';

// Teto de leituras de pagina por rodada de enriquecimento. A pagina da Amazon
// e lida so para descobrir a trilha; nao ha pressa nenhuma nisso.
const ENRIQ_MAX_FILA   = 200;
const ENRIQ_PAUSA_MS   = 4000;

const TAXO_PADRAO = { versao: 0, limiarConfianca: 0.7, espelhoOperador: [], categorias: {} };

let _taxo  = { ...TAXO_PADRAO };
let _cache = {};                 // asin -> { categoria, caminho, fonte, visto }
let _filaEnriq = [];
let _enriqRodando = false;

// ── Normalizacao ─────────────────────────────────────────────────────────────
// Sem acento, minusculo, pontuacao virando espaco. O titulo de marketplace vem
// com virgula, hifen e caixa alta em qualquer combinacao.
function norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Plural do portugues, versao pobre de proposito: so o suficiente para que
// "Fraldas" case com a keyword "fralda". Aplicada nos DOIS lados da comparacao,
// entao um erro de reducao (tenis -> tenil) e inofensivo: os dois lados erram
// igual e o casamento continua valendo.
function desplural(p) {
  if (p.length <= 3) return p;
  if (p.endsWith('oes') || p.endsWith('aes')) return p.slice(0, -3) + 'ao';
  if (p.endsWith('ns')) return p.slice(0, -2) + 'm';
  if (p.endsWith('is') && p.length > 4) return p.slice(0, -2) + 'l';
  if (p.endsWith('es') && p.length > 4) return p.slice(0, -2);
  if (p.endsWith('s')) return p.slice(0, -1);
  return p;
}

// Normalizacao + reducao de plural palavra a palavra.
function normSing(s) {
  return norm(s).split(' ').filter(Boolean).map(desplural).join(' ');
}

// Casamento por palavra inteira: sem isto "gin" acha "original" e "engine",
// e o grupo de bebidas recebe cabo HDMI. O texto ja chega despluralizado por
// normSing; o termo passa pela mesma reducao aqui.
function contemTermo(textoNorm, termo) {
  const t = normSing(termo);
  if (!t) return false;
  return (' ' + textoNorm + ' ').includes(' ' + t + ' ');
}

// ── Carga / persistencia ─────────────────────────────────────────────────────
export function carregarCategorias() {
  try {
    if (existsSync(ARQ_TAXO)) {
      const lido = JSON.parse(readFileSync(ARQ_TAXO, 'utf-8'));
      _taxo = { ...TAXO_PADRAO, ...lido };
      console.log('[CAT] Taxonomia carregada — ' + Object.keys(_taxo.categorias).length + ' categoria(s).');
    } else {
      console.log('[CAT] Sem tsp/categorias.json em disco — classificacao desligada ate o proximo /sync/pull.');
    }
  } catch (e) {
    console.log('[CAT] Erro ao carregar taxonomia:', e.message);
  }
  try {
    if (existsSync(ARQ_CACHE)) {
      _cache = JSON.parse(readFileSync(ARQ_CACHE, 'utf-8')) || {};
      console.log('[CAT] Cache de trilhas — ' + Object.keys(_cache).length + ' ASIN.');
    }
  } catch (e) {
    console.log('[CAT] Erro ao carregar cache:', e.message);
    _cache = {};
  }
  return _taxo;
}

export function categoriasConfig() { return _taxo; }

export function salvarCategorias(novo = {}) {
  _taxo = { ..._taxo, ...novo, atualizadoEm: new Date().toISOString() };
  try {
    writeFileSync(ARQ_TAXO, JSON.stringify(_taxo, null, 2), 'utf-8');
    agendarPush('categorias.json');
  } catch (e) {
    console.log('[CAT] Erro ao salvar taxonomia:', e.message);
  }
  return _taxo;
}

function salvarCache() {
  try {
    // Teto de guarda: o cache e conveniencia, nao ledger. Mantem os mais
    // recentes e descarta o resto — reler uma pagina custa menos que carregar
    // um arquivo gigante em todo boot.
    const chaves = Object.keys(_cache);
    if (chaves.length > 5000) {
      const ordenadas = chaves.sort((a, b) => String(_cache[b].visto || '').localeCompare(String(_cache[a].visto || '')));
      const podado = {};
      for (const k of ordenadas.slice(0, 4000)) podado[k] = _cache[k];
      _cache = podado;
    }
    writeFileSync(ARQ_CACHE, JSON.stringify(_cache), 'utf-8');
    agendarPush('categorias_cache.json');
  } catch (e) {
    console.log('[CAT] Erro ao salvar cache:', e.message);
  }
}

// Semeia o cache com um mapa externo (asin -> { categoria, caminho }).
// Serve para aproveitar tsp/categorias-amazon.json, que o relatorio de
// desempenho ja alimenta por outro caminho.
export function semearCacheTrilhas(mapa = {}) {
  let novos = 0;
  for (const [asin, v] of Object.entries(mapa)) {
    if (!asin || _cache[asin]) continue;
    _cache[asin] = { categoria: v.categoria || '', caminho: v.caminho || v.categoria || '',
                     fonte: v.fonte || 'externo', visto: v.visto || new Date().toISOString().slice(0, 10) };
    novos++;
  }
  if (novos) { salvarCache(); console.log('[CAT] ' + novos + ' trilha(s) semeada(s) no cache.'); }
  return novos;
}

// ── Classificacao por trilha (breadcrumb) ────────────────────────────────────
// A trilha e comparada segmento a segmento, nunca por substring solta: o
// caminho "Cozinha > Organizacao > Garrafas Termicas > Recipientes Termicos
// para Bebidas" contem a palavra "Bebidas" e e uma caneca.
function porTrilha(caminho) {
  if (!caminho) return null;
  const segmentos = String(caminho).split('>').map(s => normSing(s)).filter(Boolean);
  if (!segmentos.length) return null;

  for (const [id, def] of Object.entries(_taxo.categorias || {})) {
    const bloqueios = (def.segmentosBloqueio || []).map(normSing);
    if (segmentos.some(s => bloqueios.includes(s))) continue;
    const alvos = (def.segmentosAmazon || []).map(normSing);
    if (!alvos.length) continue;
    const bateu = segmentos.find(s => alvos.includes(s));
    if (bateu) return { categoria: id, confianca: 0.95, sinal: 'trilha:' + bateu };
  }
  return null;
}

// ── Classificacao por titulo ─────────────────────────────────────────────────
// Bloqueio vence positiva: "Taca de Vinho Cristal" tem "vinho" e nao e bebida.
// Quando isso acontece a categoria fica indefinida de proposito — ir para a
// fila de aprovacao e o comportamento certo, chutar nao e.
function porTitulo(titulo) {
  const t = normSing(titulo);
  if (!t) return null;

  let melhor = null;
  for (const [id, def] of Object.entries(_taxo.categorias || {})) {
    // Marca e um sinal mais forte que palavra solta: "Mustela" so aparece em
    // produto infantil, enquanto "hidratante" aparece em qualquer prateleira.
    const marcas    = (def.marcas || []).filter(k => contemTermo(t, k));
    const positivas = (def.keywords || []).filter(k => contemTermo(t, k));
    if (!positivas.length && !marcas.length) continue;
    const bloqueada = (def.bloqueio || []).find(b => contemTermo(t, b));
    if (bloqueada) {
      if (!melhor) melhor = { categoria: null, confianca: 0.3, _p: -1, _n: -1,
        sinal: 'bloqueio:' + normSing(bloqueada) + ' vs ' + normSing(marcas[0] || positivas[0]) };
      continue;
    }
    const cand = {
      categoria: id,
      confianca: marcas.length ? 0.9 : 0.85,
      sinal: (marcas.length ? 'marca:' : 'titulo:') + normSing(marcas[0] || positivas[0]),
      // Prioridade resolve a sobreposicao legitima entre prateleiras: uma
      // sandalia infantil e as duas coisas, e quem decide qual grupo recebe e a
      // taxonomia, nao a contagem de palavras. Marca conta em dobro no empate.
      _p: Number(def.prioridade) || 0,
      _n: positivas.length + marcas.length * 2,
    };
    if (!melhor || melhor.categoria === null
        || cand._p > melhor._p
        || (cand._p === melhor._p && cand._n > melhor._n)) melhor = cand;
  }
  if (melhor) { delete melhor._n; delete melhor._p; }
  return melhor;
}

/**
 * Classifica um produto. Nunca lanca e nunca faz rede.
 * @returns {{categoria: string|null, confianca: number, sinal: string, nome: string|null}}
 */
export function classificarProduto({ titulo, asin, loja } = {}) {
  const vazio = { categoria: null, confianca: 0, sinal: 'sem-taxonomia', nome: null };
  if (!_taxo.categorias || !Object.keys(_taxo.categorias).length) return vazio;

  try {
    // 1. Trilha em cache — a fonte mais confiavel que existe hoje.
    if (asin && _cache[asin]) {
      const r = porTrilha(_cache[asin].caminho);
      if (r) return { ...r, nome: _taxo.categorias[r.categoria]?.nome || r.categoria };
    }

    // 2. Titulo.
    const t = porTitulo(titulo);
    if (t) {
      // ASIN sem trilha conhecida entra na fila de enriquecimento: da proxima
      // vez a decisao vem do breadcrumb e nao das palavras.
      if (asin && !_cache[asin] && /^B[A-Z0-9]{9}$/.test(String(asin))) enfileirarEnriquecimento(asin);
      return { ...t, nome: t.categoria ? (_taxo.categorias[t.categoria]?.nome || t.categoria) : null };
    }

    if (asin && !_cache[asin] && /^B[A-Z0-9]{9}$/.test(String(asin))) enfileirarEnriquecimento(asin);
    return { categoria: null, confianca: 0, sinal: 'sem-sinal', nome: null };
  } catch (e) {
    console.warn('[CAT] Falha ao classificar "' + String(titulo).slice(0, 60) + '":', e.message);
    return vazio;
  }
}

/** A categoria e confiavel o bastante para decidir roteamento sozinha? */
export function categoriaConfiavel(cls) {
  return !!(cls && cls.categoria && cls.confianca >= (_taxo.limiarConfianca ?? 0.7));
}

/** Categorias que devem ser espelhadas no grupo do operador (modo observacao). */
export function espelhaNoOperador(cls) {
  const lista = _taxo.espelhoOperador || [];
  return !!(cls && cls.categoria && lista.includes(cls.categoria));
}

// ── Enriquecimento em background ─────────────────────────────────────────────
const UA_NAV = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
             + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function enfileirarEnriquecimento(asin) {
  if (_filaEnriq.includes(asin) || _filaEnriq.length >= ENRIQ_MAX_FILA) return;
  _filaEnriq.push(asin);
  if (!_enriqRodando) { _enriqRodando = true; setTimeout(rodarEnriquecimento, ENRIQ_PAUSA_MS); }
}

async function rodarEnriquecimento() {
  while (_filaEnriq.length) {
    const asin = _filaEnriq.shift();
    try {
      const achado = await trilhaDaPaginaAmazon(asin);
      if (achado) {
        _cache[asin] = { ...achado, fonte: 'pagina', visto: new Date().toISOString().slice(0, 10) };
        salvarCache();
        console.log('[CAT] ' + asin + ' -> ' + achado.caminho);
      }
    } catch (e) {
      console.warn('[CAT] Enriquecimento de ' + asin + ' falhou:', e.message);
    }
    await new Promise(r => setTimeout(r, ENRIQ_PAUSA_MS));
  }
  _enriqRodando = false;
}

// Mesma leitura de breadcrumb usada no relatorio de desempenho: bloco
// wayfinding-breadcrumbs, com o title da pagina como segunda tentativa.
export async function trilhaDaPaginaAmazon(asin) {
  const res = await fetch('https://www.amazon.com.br/dp/' + asin, {
    headers: {
      'User-Agent': UA_NAV,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) return null;
  const html = await res.text();

  const bloco = html.match(/wayfinding-breadcrumbs_feature_div([\s\S]{0,4000}?)<\/ul>/);
  if (bloco) {
    const trilha = [...bloco[1].matchAll(/>\s*([^<>]{2,60}?)\s*</g)]
      .map(m => m[1].trim())
      .filter(t => t && t !== '\u203a' && !/^&\w+;$/.test(t));
    if (trilha.length) return { categoria: trilha[0], caminho: trilha.slice(0, 5).join(' > ') };
  }
  const titulo = (html.match(/<title>([\s\S]{0,200}?)<\/title>/) || [, ''])[1].trim();
  const dep = (titulo.match(/Amazon\.com\.br\s*:\s*([^:|]{3,60})\s*$/) || [])[1];
  if (dep) return { categoria: dep.trim(), caminho: dep.trim() };
  return null;
}

// Diagnostico legivel para o grupo do operador: mostra o que decidiu, nao so
// o rotulo. Sem isso, avaliar acerto do classificador vira adivinhacao.
export function explicarClassificacao(cls) {
  if (!cls || !cls.categoria) {
    return 'indefinida' + (cls?.sinal ? ' (' + cls.sinal + ')' : '');
  }
  return (cls.nome || cls.categoria)
    + ' — confianca ' + Math.round((cls.confianca || 0) * 100) + '%'
    + ' (' + cls.sinal + ')';
}
