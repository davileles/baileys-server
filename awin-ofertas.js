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
import { varrerFeedComDesconto, listarAnunciantesComFeed, credenciaisFeedOk } from './awin-feed.js';

const OFERTADOS_PATH = './sessao/awin_ofertados.json';
const CONFIG_PATH    = './sessao/awin_config.json';

let _ofertados = {};   // chave (loja|produto) -> ISO do ultimo envio
let _cfg = null;       // config gravada pelo painel (null = ainda nao lida)

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
    maxDia:            n(process.env.AWIN_OFERTAS_MAX_DIA, 6),
    maxRodada:         n(process.env.AWIN_OFERTAS_MAX_RODADA, 2),
    maxLojaDia:        n(process.env.AWIN_OFERTAS_MAX_LOJA_DIA, 2),
    repetirDias:       n(process.env.AWIN_OFERTAS_REPETIR_DIAS, 30),
    intervaloHoras:    n(process.env.AWIN_VARREDURA_H, 6),
    maxFeedsPorRodada: n(process.env.AWIN_OFERTAS_MAX_FEEDS, 6),
    lojas: String(process.env.AWIN_OFERTAS_LOJAS || '').split(',').map(s => s.trim()).filter(Boolean),
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

// Faixas de validacao: um maxDia digitado como 600 no painel viraria spam, e um
// minPct de 5 encheria a fila com "promocao" de 5%.
const LIMITES = {
  minPct: [1, 99], minPreco: [0, 100000], maxPreco: [0, 1000000],
  maxDia: [0, 50], maxRodada: [0, 20], maxLojaDia: [0, 20],
  repetirDias: [1, 365], intervaloHoras: [1, 168], maxFeedsPorRodada: [1, 60],
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

// Rotacao entre lojas: sem isso, a loja com mais desconto (sempre a mesma)
// consumiria a cota diaria inteira e as outras nunca apareceriam.
let _ponteiroLoja = 0;

/**
 * Varre os feeds e devolve o que PODE ser ofertado hoje, ja dentro da cota.
 * Nao envia nada — quem envia e o server, que ainda aplica janela de horario,
 * espacamento e (se configurado) aprovacao manual.
 */
export async function buscarOfertasDosFeeds({ simular = false } = {}) {
  if (!credenciaisFeedOk()) return { ok: false, erro: 'AWIN_FEED_APIKEY nao configurada' };
  const cfg = configOfertasAwin();
  const uso = usoDeHoje();

  // Duas cotas, nao uma: o teto do dia impede excesso e o teto da RODADA impede
  // que o dia inteiro saia numa rajada de poucos minutos logo na primeira
  // varredura, deixando o grupo mudo o resto do dia.
  const vagasTotal = Math.min(
    Math.max(0, cfg.maxDia - uso.total),
    cfg.maxRodada > 0 ? cfg.maxRodada : cfg.maxDia,
  );
  if (!simular && vagasTotal <= 0) {
    return { ok: true, cota: 'esgotada', usoHoje: uso, candidatos: [] };
  }

  // Lojas a varrer: as configuradas, ou todas as que tem feed ativo.
  const ids = cfg.lojas.length
    ? cfg.lojas.map(Number).filter(Boolean)
    : listarAnunciantesComFeed();
  if (!ids.length) return { ok: false, erro: 'nenhum feed ativo — atualize a lista de feeds' };

  // Fatia da rodada, girando o ponto de partida a cada execucao.
  const quantos = Math.min(cfg.maxFeedsPorRodada, ids.length);
  const fatia = [];
  for (let i = 0; i < quantos; i++) fatia.push(ids[(_ponteiroLoja + i) % ids.length]);
  _ponteiroLoja = (_ponteiroLoja + quantos) % ids.length;

  const candidatos = [], porLojaExaminada = [];
  for (const id of fatia) {
    let achados = [];
    try {
      achados = await varrerFeedComDesconto(id, {
        minPct: cfg.minPct, minPreco: cfg.minPreco, maxPreco: cfg.maxPreco, limite: 100,
      });
    } catch (e) { console.log('[AWIN-OFERTAS] Falha na loja ' + id + ': ' + e.message); continue; }

    const nome = achados[0]?.anunciante || String(id);
    const novos = achados.filter(p => !jaOfertado(nome + '|' + p.chave, cfg.repetirDias));
    porLojaExaminada.push({ loja: nome, encontrados: achados.length, novos: novos.length });

    // Teto por loja: impede que uma unica loja tome a cota do dia inteira.
    const jaHoje = uso.porLoja[nome] || 0;
    const vagasLoja = Math.max(0, cfg.maxLojaDia - jaHoje);
    for (const p of novos.slice(0, simular ? cfg.maxLojaDia : vagasLoja)) {
      candidatos.push({ ...p, loja: nome, chaveHistorico: nome + '|' + p.chave });
    }
  }

  // Ranking final e corte pela cota do dia.
  candidatos.sort((a, b) => (b.desconto - a.desconto) || (b.preco - a.preco));
  const selecionados = candidatos.slice(0, simular ? cfg.maxDia : vagasTotal);

  return {
    ok: true,
    config: cfg,
    usoHoje: uso,
    vagasTotal,
    lojasExaminadas: porLojaExaminada,
    maxDia: cfg.maxDia,
    maxRodada: cfg.maxRodada,
    candidatos: selecionados,
    descartadosPorCota: Math.max(0, candidatos.length - selecionados.length),
  };
}
