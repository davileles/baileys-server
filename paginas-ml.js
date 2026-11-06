// ── LEITURA DE PAGINA DO ML PELA EXTENSAO (Captura Tica) ─────────────────────
// Desde 11/10/2026 a pagina publica de produto do Mercado Livre responde ao
// IP do Railway com a tela /captcha/wall — bloqueio por reputacao de IP de
// datacenter, nao por conta (o perfil social, /cupons e o linkbuilder seguem
// abrindo do mesmo IP com o mesmo cookie). O que a pagina dava e a API oficial
// nao da: preco de anuncio classico (/items/{id} responde 403), cupom que o
// proprio anuncio declara (cuponsPagina) e o "De" com mais fidelidade.
//
// Mesma receita da insercao de cupons (27/09/2026): quem toca a pagina e o
// Chrome do operador, por um fetch() do service worker da extensao — IP
// residencial, TLS de navegador, sem aba. Desde 05/11/2026 (extensao 2.10.0)
// o fetch vai COM os cookies do Chrome do operador: sem cookie, cada busca era
// um "aparelho novo" para o ML e ele passou a responder com /captcha/wall e
// /gz/account-verification a todas.
// Este modulo e so a fila: o server pede uma pagina, a extensao (em long-poll
// em /ml/pagina/proximo) busca e devolve o HTML em /ml/pagina/resultado; quem
// interpreta o HTML e o radar-ml.js, com o que ja existia.
//
// Freios, para a leitura nao virar o mesmo padrao que derrubou o Railway:
//   - so na janela (ML_PAGINA_JANELA, 8-23) e com teto diario (ML_PAGINA_TETO);
//   - espacamento entre paginas e da extensao (4-8 s); aqui, uma por vez;
//   - 1a tela de verificacao -> PARA tudo e avisa o operador no WhatsApp com o
//     link do anuncio; ele abre no Chrome dele e resolve o captcha (pessoa, nao
//     robo). Continuar batendo depois do bloqueio so o endurece. A leitura so
//     volta quando um teste (a cada ML_PAGINA_TESTE_MIN, ou "Ja resolvi" no
//     popup da extensao) abrir a pagina normalmente. Sobrevive a restart.
//   - pedido sem extensao online (sem long-poll nos ultimos 90 s) devolve null
//     na hora: nada fica esperando, o pipeline segue pelo caminho da API.
// Estado em memoria (contadores zeram no boot; o teto conta por dia civil).

import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs';

function escreverAtomico(caminho, dados) {
  const tmp = caminho + '.tmp';
  writeFileSync(tmp, dados, 'utf-8');
  renameSync(tmp, caminho);
}

const LIGADO     = String(process.env.ML_PAGINA_EXTENSAO ?? '1') !== '0';
const TETO_DIA   = Number(process.env.ML_PAGINA_TETO || 200);
const ESPERA_MS  = Number(process.env.ML_PAGINA_ESPERA_MS || 20000);   // quanto o pipeline espera a pagina
const TESTE_MS   = Number(process.env.ML_PAGINA_TESTE_MIN || 15) * 60000; // teste enquanto espera a verificacao
const ONLINE_MS  = 90000;                                              // long-poll visto ha menos = extensao online
const HTML_MAX   = 2.5 * 1024 * 1024;
const [JAN_INI, JAN_FIM] = String(process.env.ML_PAGINA_JANELA || '8-23').split('-').map(Number);
// Cota por finalidade (06/11/2026): a releitura de hora em hora do monitor de
// precos pedia pagina para cada anuncio classico e /up/ da vitrine (~500 itens
// que a API nao cobre) e queimava as 200 paginas do dia antes das 9h — o resto
// (disparos, Catalogo, alertas de preco, clique manual) ficava sem leitura.
// Agora o monitor tem teto proprio e pequeno, e uma reserva do teto geral so
// pode ser usada por quem vai publicar ou foi pedido pelo operador.
const TETO_MONITOR = Number(process.env.ML_PAGINA_TETO_MONITOR ?? 30);
const RESERVA      = Number(process.env.ML_PAGINA_RESERVA ?? 50);
// motivos que podem usar a reserva (quem publica ou responde a um pedido)
const USA_RESERVA  = new Set(['leitura', 'catalogo', 'avisos', 'manual', 'teste']);

let _seq = 0;
const _fila = [];               // [{ id, url, criadoEm, resolve, timer, entregueEm }]
const _esperando = [];          // long-polls da extensao: [{ res, timer }]
let _estado = {
  ultimoPollEm: 0, lidas: 0, walls: 0,
  dia: null, hoje: 0, ultimaUrl: null, ultimaEm: null, ultimoErro: null, semResposta: 0,
  // { desde, url, ultimoTesteEm, testes } enquanto o ML espera a verificacao manual
  verificacao: null,
  porMotivo: {},                // { motivo: paginas entregues hoje }
};
let _aoPedirVerificacao = null;  // (url) => Promise — aviso no WhatsApp (server.js)
let _aoLiberar = null;           // (verificacao) => Promise
let _arquivo = null;            // caminho do json com o contador do dia (sobrevive a restart)

function diaSp() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }); }
function horaSp() { return Number(new Date().toLocaleTimeString('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }).slice(0, 2)); }
function naJanela() { const h = horaSp(); return h >= JAN_INI && h < JAN_FIM; }
function zerarDia() {
  const d = diaSp();
  if (_estado.dia !== d) { _estado.dia = d; _estado.hoje = 0; _estado.porMotivo = {}; gravar(); }
}
function gravar() {
  if (!_arquivo) return;
  try { escreverAtomico(_arquivo, JSON.stringify({ dia: _estado.dia, hoje: _estado.hoje, porMotivo: _estado.porMotivo, verificacao: _estado.verificacao })); } catch (e) {}
}

/** Chamado no boot pelo server com o diretorio da sessao. */
export function iniciarPaginasMl(sessaoDir) {
  _arquivo = sessaoDir + '/ml_paginas_dia.json';
  try {
    if (existsSync(_arquivo)) {
      const m = JSON.parse(readFileSync(_arquivo, 'utf-8'));
      if (m?.dia === diaSp()) { _estado.dia = m.dia; _estado.hoje = Number(m.hoje) || 0; _estado.porMotivo = (m.porMotivo && typeof m.porMotivo === 'object') ? m.porMotivo : {}; }
      if (m?.verificacao?.url) _estado.verificacao = m.verificacao;
    }
  } catch (e) {}
  zerarDia();
  setInterval(() => { testarVerificacaoMl(false).catch(() => {}); }, 60000).unref?.();
}

/** server.js registra quem avisa o operador (bloqueio) e quem registra a volta. */
export function configurarAvisosPaginasMl({ aoPedirVerificacao, aoLiberar } = {}) {
  _aoPedirVerificacao = aoPedirVerificacao || null;
  _aoLiberar = aoLiberar || null;
}

/**
 * Enquanto o ML espera a verificacao, testa UMA pagina (a que bloqueou) para
 * saber se o operador ja resolveu. agora=true: pedido do popup ("Ja resolvi").
 */
export async function testarVerificacaoMl(agora) {
  const v = _estado.verificacao;
  if (!v || !LIGADO || !extensaoPaginasOnline()) return { ok: false, motivo: v ? 'extensao_offline' : 'sem_verificacao_pendente' };
  if (!agora && (!naJanela() || Date.now() - (v.ultimoTesteEm || v.desde || 0) < TESTE_MS)) return { ok: false, motivo: 'ainda_nao' };
  if (_fila.some(p => p.forcar)) return { ok: true, motivo: 'teste_em_andamento' };
  v.ultimoTesteEm = Date.now(); v.testes = (v.testes || 0) + 1; gravar();
  const r = await pedirPaginaMl(v.url, { motivo: 'teste', forcar: true, esperaMs: 40000 });
  if (!r) return { ok: false, motivo: 'sem_resposta' };
  return { ok: true, liberada: !r.bloqueada };
}

export function extensaoPaginasOnline() {
  return LIGADO && Date.now() - _estado.ultimoPollEm < ONLINE_MS;
}

/**
 * Por que um pedido nao seria atendido agora (null = pode).
 * Sem motivo: a pergunta geral do painel (teto do dia inteiro).
 */
export function motivoIndisponivelPaginasMl(motivo = null) {
  if (!LIGADO) return 'desligada';
  if (!extensaoPaginasOnline()) return 'extensao_offline';
  if (_estado.verificacao) return 'aguardando_verificacao';
  if (!naJanela()) return 'fora_da_janela';
  zerarDia();
  if (motivo === 'manual') return null;   // clique do operador: uma pagina, fura o teto
  if (_estado.hoje >= TETO_DIA) return 'teto';
  if (motivo && !USA_RESERVA.has(motivo) && _estado.hoje >= TETO_DIA - RESERVA) return 'reserva';
  if (motivo === 'monitor' && (_estado.porMotivo.monitor || 0) >= TETO_MONITOR) return 'teto_monitor';
  return null;
}

/**
 * Pede o HTML de uma pagina ao Chrome do operador.
 * @returns {Promise<{html:string, url:string, status:number}|null>}
 *   null = extensao indisponivel, freio ativo ou sem resposta no prazo.
 */
export function pedirPaginaMl(url, { esperaMs = ESPERA_MS, motivo = 'leitura', forcar = false } = {}) {
  // forcar: so o teste da verificacao passa por cima do freio (precisa da extensao online)
  const porque = forcar ? (LIGADO && extensaoPaginasOnline() ? null : 'extensao_offline') : motivoIndisponivelPaginasMl(motivo);
  if (porque) { _estado.recusas = _estado.recusas || {}; const k = motivo + ':' + porque; _estado.recusas[k] = (_estado.recusas[k] || 0) + 1; return Promise.resolve(null); }
  // A mesma URL pedida duas vezes seguidas (dois grupos-fonte publicando junto)
  // vai uma vez so: o segundo pedido pega carona no primeiro.
  const igual = !forcar && _fila.find(p => p.url === url && !p.entregueEm && !p.forcar);
  if (igual) return new Promise(res => igual.caronas.push(res));
  return new Promise(resolve => {
    const p = { id: ++_seq, url, motivo, forcar, criadoEm: Date.now(), entregueEm: 0, resolve, caronas: [], timer: null };
    p.timer = setTimeout(() => concluir(p, null, 'sem resposta no prazo'), esperaMs);
    _fila.push(p);
    acordarExtensao();
  });
}

function concluir(p, resultado, erro) {
  const i = _fila.indexOf(p);
  if (i >= 0) _fila.splice(i, 1);
  clearTimeout(p.timer);
  if (erro) { _estado.semResposta++; _estado.ultimoErro = erro; }
  p.resolve(resultado);
  for (const c of p.caronas) c(resultado);
}

// ── Lado da extensao ─────────────────────────────────────────────────────────
function proximoParaEntregar() {
  if (motivoIndisponivelPaginasMl() && !extensaoPaginasOnline()) return null;
  // Uma por vez: so entrega a proxima quando a anterior foi respondida ou
  // passou do prazo (a extensao espaca 4-8 s entre as buscas).
  if (_fila.some(p => p.entregueEm && Date.now() - p.entregueEm < ESPERA_MS)) return null;
  // O teste da verificacao vai na frente e ignora o freio; o resto espera.
  // Manual primeiro (o operador esta olhando a tela); depois o resto, cada um
  // conferido contra a cota da sua finalidade.
  const p = _fila.find(p => !p.entregueEm && p.forcar)
    || _fila.find(p => !p.entregueEm && !p.forcar && p.motivo === 'manual' && !motivoIndisponivelPaginasMl('manual'))
    || _fila.find(p => !p.entregueEm && !p.forcar && !motivoIndisponivelPaginasMl(p.motivo));
  if (!p) return null;
  p.entregueEm = Date.now();
  return { id: p.id, url: p.url, motivo: p.motivo };
}

function acordarExtensao() {
  while (_esperando.length) {
    const item = proximoParaEntregar();
    if (!item) return;
    const w = _esperando.shift();
    clearTimeout(w.timer);
    try { w.res.json({ ok: true, pedido: item }); } catch (e) {}
  }
}

/**
 * GET /ml/pagina/proximo?espera=25 — long-poll da extensao. Segura a resposta
 * ate ter pedido ou ate o prazo; a extensao chama de novo em seguida.
 */
export function atenderLongPollPaginasMl(req, res) {
  _estado.ultimoPollEm = Date.now();
  const item = proximoParaEntregar();
  if (item) return res.json({ ok: true, pedido: item });
  const espera = Math.min(Math.max(Number(req.query.espera) || 0, 0), 28) * 1000;
  if (!espera) return res.json({ ok: true, pedido: null, motivo: motivoIndisponivelPaginasMl() });
  const w = { res, timer: null };
  w.timer = setTimeout(() => {
    const i = _esperando.indexOf(w);
    if (i >= 0) _esperando.splice(i, 1);
    _estado.ultimoPollEm = Date.now();
    try { res.json({ ok: true, pedido: null, motivo: motivoIndisponivelPaginasMl() }); } catch (e) {}
  }, espera);
  _esperando.push(w);
  req.on('close', () => { const i = _esperando.indexOf(w); if (i >= 0) { _esperando.splice(i, 1); clearTimeout(w.timer); } });
}

/**
 * POST /ml/pagina/resultado — { id, url, status, html, erro? }.
 * @param {function} bloqueadaFn  (urlFinal, html) => boolean — decide se veio a
 *   tela antibot; fica com o radar-ml, que conhece as duas variantes.
 */
export function registrarResultadoPaginaMl(corpo, bloqueadaFn) {
  _estado.ultimoPollEm = Date.now();
  const p = _fila.find(x => x.id === Number(corpo?.id));
  if (!p) return { ok: false, motivo: 'pedido desconhecido ou expirado' };
  const html = typeof corpo.html === 'string' ? corpo.html.slice(0, HTML_MAX) : '';
  const urlFinal = String(corpo.url || p.url);
  const status = Number(corpo.status) || 0;
  zerarDia();
  _estado.hoje++; _estado.ultimaUrl = p.url; _estado.ultimaEm = new Date().toISOString();
  _estado.porMotivo[p.motivo || 'leitura'] = (_estado.porMotivo[p.motivo || 'leitura'] || 0) + 1;
  gravar();
  if (corpo.erro || !html) {
    _estado.ultimoErro = String(corpo.erro || 'HTML vazio');
    concluir(p, null, _estado.ultimoErro);
    acordarExtensao();
    return { ok: true, veredito: 'erro' };
  }
  const bloqueada = !!bloqueadaFn(urlFinal, html, status);
  if (bloqueada) {
    _estado.walls++;
    if (!_estado.verificacao) {
      // Primeira tela de verificacao: para na hora e chama o operador.
      _estado.verificacao = { desde: Date.now(), url: p.url, ultimoTesteEm: Date.now(), testes: 0 };
      gravar();
      console.warn('[ML] Pagina pela extensao: ML pediu verificacao — leitura parada ate o operador resolver (' + p.url + ')');
      if (_aoPedirVerificacao) Promise.resolve(_aoPedirVerificacao(p.url)).catch(e => console.error('[ML] Falha ao avisar verificacao:', e.message));
    }
  } else {
    _estado.lidas++;
    if (_estado.verificacao) {
      const v = _estado.verificacao;
      _estado.verificacao = null;
      gravar();
      console.log('[ML] Pagina pela extensao voltou a abrir — verificacao resolvida, leitura retomada.');
      if (_aoLiberar) Promise.resolve(_aoLiberar(v)).catch(() => {});
    }
  }
  concluir(p, { html, url: urlFinal, status, bloqueada });
  acordarExtensao();
  return { ok: true, veredito: bloqueada ? 'bloqueada' : 'ok' };
}

export function estadoPaginasMl() {
  zerarDia();
  return {
    ligada: LIGADO, online: extensaoPaginasOnline(), motivo: motivoIndisponivelPaginasMl(),
    ultimoPollEm: _estado.ultimoPollEm ? new Date(_estado.ultimoPollEm).toISOString() : null,
    naFila: _fila.length, pollsEsperando: _esperando.length,
    hoje: _estado.hoje, teto: TETO_DIA, janela: JAN_INI + '-' + JAN_FIM,
    porMotivo: _estado.porMotivo, tetoMonitor: TETO_MONITOR, reserva: RESERVA,
    recusasDesdeBoot: _estado.recusas || {},
    lidas: _estado.lidas, walls: _estado.walls,
    verificacao: _estado.verificacao ? {
      desde: new Date(_estado.verificacao.desde).toISOString(), url: _estado.verificacao.url, testes: _estado.verificacao.testes || 0,
      ultimoTesteEm: _estado.verificacao.ultimoTesteEm ? new Date(_estado.verificacao.ultimoTesteEm).toISOString() : null,
      proximoTesteEm: new Date((_estado.verificacao.ultimoTesteEm || _estado.verificacao.desde) + TESTE_MS).toISOString(),
    } : null,
    semResposta: _estado.semResposta, ultimaUrl: _estado.ultimaUrl, ultimaEm: _estado.ultimaEm, ultimoErro: _estado.ultimoErro,
  };
}
