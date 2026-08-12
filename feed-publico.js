// ═══════════════════════════════════════════════════════════════════════════
// feed-publico.js — vitrine publica das ofertas e cupons que sairam no grupo.
//
// O site publico (tudosobrepromos.com) e estatico: nao consulta o Railway, le
// dois JSON servidos pelo GitHub Pages. Este modulo e quem mantem esses dois
// arquivos atualizados no repositorio publico.
//
//   sessao/publicadas.json   estado local — historico do que foi enviado
//   <repo publico>/dados/feed.json     ofertas de marketplace enviadas
//   <repo publico>/dados/cupons.json   cupons vigentes da base
//
// Por que repositorio publico e nao endpoint: o site fica de pe mesmo com o
// Baileys fora, nao gasta banda do Railway e o CDN do Pages absorve o trafego.
// O Pages responde com Access-Control-Allow-Origin: *, entao qualquer dominio
// consome os dois arquivos.
//
// Variaveis no Railway (todas opcionais — os padroes ja valem):
//   GITHUB_TOKEN          mesmo PAT do sync-github.js
//   GITHUB_REPO_PUBLICO   padrao davileles/tudo-sobre-promos
//   TSP_LINK_GRUPO        padrao https://grupo.tudosobrepromos.com/groups
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { listarCuponsBase, cupomVigente } from './radar-amazon.js';

const SESSAO_DIR = './sessao';
const ARQ_LOCAL  = SESSAO_DIR + '/publicadas.json';

// Retencao do feed. Oferta de marketplace envelhece rapido: preco muda, estoque
// acaba. Sete dias e o limite em que ainda vale mostrar, e o teto por quantidade
// impede que um dia de pico deixe a pagina pesada no celular.
const RETENCAO_MS = 7 * 24 * 3600e3;
const MAX_ITENS   = 120;

// Debounce longo de proposito: cada push vira commit e rebuild do Pages. Dez
// minutos de atraso na vitrine nao muda nada para quem navega, e evita dezenas
// de commits por dia.
const DEBOUNCE_MS  = 10 * 60 * 1000;
// Varredura periodica: cupom expira sozinho, sem nenhuma oferta nova acontecer.
// Sem isso a aba Cupons mostraria codigo vencido ate o proximo envio.
const INTERVALO_MS = 30 * 60 * 1000;

function repoPublico() { return process.env.GITHUB_REPO_PUBLICO || 'davileles/tudo-sobre-promos'; }
function linkGrupo()   { return process.env.TSP_LINK_GRUPO || 'https://grupo.tudosobrepromos.com/groups'; }
function ativo()       { return !!process.env.GITHUB_TOKEN; }

let _publicadas = [];
let _timer = null;
let _ultimoErro = null;
let _ultimaPublicacao = null;

// ── ESTADO LOCAL ─────────────────────────────────────────────────────────────

export function carregarPublicadas() {
  try {
    if (existsSync(ARQ_LOCAL)) {
      const d = JSON.parse(readFileSync(ARQ_LOCAL, 'utf-8'));
      _publicadas = Array.isArray(d) ? d : [];
      console.log('[FEED] ' + _publicadas.length + ' publicacao(oes) carregada(s).');
    }
  } catch (e) {
    console.warn('[FEED] Erro ao carregar publicadas:', e.message);
    _publicadas = [];
  }
  return _publicadas;
}

function salvarPublicadas() {
  try {
    if (!existsSync(SESSAO_DIR)) mkdirSync(SESSAO_DIR, { recursive: true });
    writeFileSync(ARQ_LOCAL, JSON.stringify(_publicadas), 'utf-8');
  } catch (e) { console.warn('[FEED] Erro ao salvar publicadas:', e.message); }
}

function podar() {
  const corte = Date.now() - RETENCAO_MS;
  _publicadas = _publicadas
    .filter(o => new Date(o.enviadoEm).getTime() > corte)
    .slice(0, MAX_ITENS);
}

function num(v) {
  const n = Number(v);
  return isFinite(n) && n > 0 ? n : null;
}

/**
 * Registra uma oferta de marketplace que acabou de sair nos grupos.
 * Nao lanca: falha aqui nunca pode derrubar um envio que ja aconteceu.
 *
 * @param {object} oferta  item da fila, com dadosExtraidos preenchido
 * @param {number} grupos  em quantos grupos entrou (so para log)
 */
export function registrarPublicacao(oferta, grupos = 0) {
  try {
    const d = oferta?.dadosExtraidos;
    // Sem link nao ha o que publicar: o card da vitrine e o proprio link.
    if (!d?.link || !d?.titulo) return null;

    const item = {
      id:         String(oferta.id || ''),
      loja:       d.loja || '',
      titulo:     String(d.titulo).slice(0, 180),
      link:       d.link,
      imagem:     d.imagemUrl || null,
      preco:      num(d.precoFinal ?? d.preco),
      precoDe:    num(d.precoDe),
      desconto:   num(d.desconto),
      cupom:      d.cupom?.codigo || (typeof d.cupom === 'string' ? d.cupom : null),
      enviadoEm:  oferta.enviadoEm || new Date().toISOString(),
    };

    // Mesmo produto reofertado: o card antigo sai e o novo assume o topo, senao
    // a vitrine mostraria o mesmo item com dois precos diferentes.
    _publicadas = _publicadas.filter(o => o.link !== item.link);
    _publicadas.unshift(item);
    podar();
    salvarPublicadas();
    agendarPublicacao();
    console.log('[FEED] Registrado no feed publico: ' + item.titulo.slice(0, 50)
      + (grupos ? ' (' + grupos + ' grupo(s))' : ''));
    return item;
  } catch (e) {
    console.warn('[FEED] Falha ao registrar publicacao:', e.message);
    return null;
  }
}

// ── MONTAGEM DOS ARQUIVOS PUBLICOS ───────────────────────────────────────────

function montarFeed() {
  podar();
  return {
    atualizadoEm: new Date().toISOString(),
    grupoUrl: linkGrupo(),
    ofertas: _publicadas,
  };
}

// 'observacao' guarda tanto nota util ao cliente quanto rotulo de origem posto
// pelo coletor. Rotulo de origem nao diz nada a quem vai usar o cupom.
const OBS_INTERNAS = new Set(['awin', 'ml', 'mercado livre', 'meli', 'manual', 'telegram', 'shopee']);
function obsPublica(obs) {
  const t = String(obs || '').trim();
  return t && !OBS_INTERNAS.has(t.toLowerCase()) ? t : null;
}

function montarCupons() {
  const itens = listarCuponsBase()
    .filter(cupomVigente)
    .map(c => ({
      codigo:     c.codigo,
      loja:       c.loja,
      tipo:       c.tipo,               // 'pct' | 'reais'
      valor:      c.valor,
      minimo:     c.minimo ?? null,     // piso do pedido
      maximo:     c.maximo ?? null,     // teto do produto elegivel
      limite:     c.limite ?? null,     // teto do desconto (so em percentual)
      observacao: obsPublica(c.observacao),
      validadeAte: c.validadeAte,
    }))
    // Maior desconto primeiro dentro de cada loja, lojas em ordem alfabetica.
    .sort((a, b) => a.loja.localeCompare(b.loja, 'pt-BR') || b.valor - a.valor);

  return {
    atualizadoEm: new Date().toISOString(),
    grupoUrl: linkGrupo(),
    cupons: itens,
  };
}

// ── PUBLICACAO NO REPOSITORIO ────────────────────────────────────────────────

async function api(caminho, opcoes = {}) {
  return fetch('https://api.github.com/repos/' + repoPublico() + '/contents/' + caminho, {
    ...opcoes,
    headers: {
      'Authorization': 'Bearer ' + process.env.GITHUB_TOKEN,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      ...(opcoes.headers || {}),
    },
    signal: AbortSignal.timeout(20000),
  });
}

// Compara ignorando 'atualizadoEm': sem isso todo ciclo geraria commit, porque
// o carimbo de hora sempre muda mesmo quando nada mudou de fato.
function mesmoConteudo(remotoTexto, novo) {
  try {
    const { atualizadoEm: _a, ...r } = JSON.parse(remotoTexto);
    const { atualizadoEm: _b, ...n } = novo;
    return JSON.stringify(r) === JSON.stringify(n);
  } catch { return false; }
}

async function enviarArquivo(caminho, objeto) {
  const conteudo = JSON.stringify(objeto, null, 2);

  // SHA sempre fresco imediatamente antes do PUT: o repositorio recebe commits
  // de outros processos e um SHA reaproveitado falha com 409.
  let sha = null;
  const atual = await api(caminho);
  if (atual.ok) {
    const d = await atual.json();
    sha = d.sha;
    if (mesmoConteudo(Buffer.from(d.content, 'base64').toString('utf-8'), objeto)) return false;
  } else if (atual.status !== 404) {
    throw new Error('leitura de ' + caminho + ': HTTP ' + atual.status);
  }

  const res = await api(caminho, {
    method: 'PUT',
    body: JSON.stringify({
      message: 'chore(site): atualiza ' + caminho,
      content: Buffer.from(conteudo, 'utf-8').toString('base64'),
      ...(sha ? { sha } : {}),
    }),
  });
  if (!res.ok) throw new Error('PUT ' + caminho + ': HTTP ' + res.status + ' ' + (await res.text()).slice(0, 160));
  return true;
}

/** Publica os dois arquivos agora, sem esperar o debounce. */
export async function publicarAgora() {
  if (!ativo()) return { ok: false, erro: 'GITHUB_TOKEN ausente.' };
  try {
    const feed   = await enviarArquivo('dados/feed.json', montarFeed());
    const cupons = await enviarArquivo('dados/cupons.json', montarCupons());
    _ultimoErro = null;
    if (feed || cupons) {
      _ultimaPublicacao = new Date().toISOString();
      console.log('[FEED] Publicado — ' + (feed ? 'feed ' : '') + (cupons ? 'cupons' : '') + '.');
    }
    return { ok: true, feed, cupons };
  } catch (e) {
    _ultimoErro = e.message;
    console.error('[FEED] Falha ao publicar:', e.message);
    return { ok: false, erro: e.message };
  }
}

/** Agenda a publicacao. Chamadas repetidas na janela reiniciam o timer. */
export function agendarPublicacao() {
  if (!ativo()) return;
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(() => {
    _timer = null;
    publicarAgora().catch(e => console.error('[FEED] Erro inesperado:', e.message));
  }, DEBOUNCE_MS);
}

/** Liga a varredura periodica. Chamado uma vez no boot. */
export function iniciarFeedPublico() {
  carregarPublicadas();
  if (!ativo()) {
    console.log('[FEED] GITHUB_TOKEN ausente — vitrine publica desligada.');
    return;
  }
  setInterval(() => {
    publicarAgora().catch(() => {});
  }, INTERVALO_MS);
  // Primeira publicacao 1min apos o boot, ja com a base de cupons carregada.
  setTimeout(() => publicarAgora().catch(() => {}), 60e3);
  console.log('[FEED] Vitrine publica ativa — ' + repoPublico() + '/dados/');
}

export function estadoFeedPublico() {
  return {
    ativo: ativo(),
    repo: repoPublico(),
    ofertas: _publicadas.length,
    cupons: montarCupons().cupons.length,
    ultimaPublicacao: _ultimaPublicacao,
    ultimoErro: _ultimoErro,
    grupoUrl: linkGrupo(),
  };
}
