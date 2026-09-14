// ── BOT DO TELEGRAM — PASSAGENS NA FILA DE APROVACAO ─────────────────────────
// Toda emissao capturada que NAO passou no gate de auto-envio cai na fila do
// gestor e, agora, tambem chega aqui como card com botao. O motivo de ter
// parado (campo incompleto, sem historico, acima do teto, abaixo do piso) vem
// no topo do card: sem ele a decisao de aprovar pelo celular vira chute.
//
// Este modulo NAO reimplementa regra nenhuma. Aprovar chama o mesmo
// /painel/aprovar/:id que o botao da tela usa; rejeitar chama /painel/rejeitar.
// Se o template da mensagem mudar no servidor, o card muda junto.
//
// Env:
//   TELEGRAM_BOT_PASSAGENS_TOKEN    token do @BotFather (ausente = bot off)
//   TELEGRAM_BOT_PASSAGENS_ADMINS   ids autorizados (default: TELEGRAM_BOT_ADMINS)
//   TELEGRAM_BOT_PASSAGENS_SECRET   segredo do path do webhook (default: cdv-passagens)
//   BOT_TSP_URL                     URL publica do servico (default: RAILWAY_PUBLIC_DOMAIN)

import { criarBot, citacao } from './telegram-core.js';

const bot = criarBot({
  nome:    'BOT-PASSAGENS',
  token:   process.env.TELEGRAM_BOT_PASSAGENS_TOKEN || '',
  secret:  process.env.TELEGRAM_BOT_PASSAGENS_SECRET || 'cdv-passagens',
  admins:  process.env.TELEGRAM_BOT_PASSAGENS_ADMINS || process.env.TELEGRAM_BOT_ADMINS || '',
  urlBase: process.env.BOT_TSP_URL || '',
});

export const BOT_PASSAGENS_PATH  = bot.path;
export const BOT_PASSAGENS_ATIVO = bot.ativo;

let dep = null;

// chatId:msgId → ofertaId. Serve para o /limpar futuro e para nao perder de
// vista qual card aponta para qual item depois de uma edicao.
const cardsAbertos = new Map();
const msgDaFila    = new Map();

const LIMITE_PREVIA   = 2200;
const LIMITE_ORIGINAL = 700;

async function apiLocal(metodo, caminho, body) {
  const r = await fetch('http://127.0.0.1:' + dep.PORT + caminho, {
    method: metodo,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  return { ...d, http: r.status };
}

// ── CARD ─────────────────────────────────────────────────────────────────────
const e = bot.esc;
const nPts = (v) => (Number(v) || 0).toLocaleString('pt-BR');

function tituloCard(o) {
  const d = o.dados || {};
  const rota = (d.origem || '?') + ' → ' + (d.destino || '?');
  return '✈️ <b>' + e(rota) + '</b>  <code>#' + e(o.id) + '</code>';
}

function blocoVoo(o) {
  const d = o.dados || {};
  const linhas = [];
  linhas.push('💺 ' + e([d.cia, d.cabine].filter(Boolean).join(' · ') || 'cia/cabine não identificada'));
  linhas.push('🎯 <b>' + e(nPts(d.pontos)) + ' pts</b>' + (d.programa ? ' · ' + e(d.programa) : ''));
  if (d.datasIda)   linhas.push('📅 Ida: ' + e(d.datasIda));
  if (d.datasVolta) linhas.push('📅 Volta: ' + e(d.datasVolta));
  return linhas.join('\n');
}

// O numero que o gate usou. Sem ele o operador nao tem como julgar se 78 mil
// pontos naquela rota e achado ou erro de extracao.
function blocoHistorico(o) {
  const h = o.hist180;
  if (!h || !h.mediaPts) return '';
  const partes = ['📊 Média 180d: <b>' + e(nPts(h.mediaPts)) + '</b> pts (' + e(h.count || 0) + ' reg.)'];
  if (h.minPts) partes.push('menor: ' + e(nPts(h.minPts)));
  if (h.isMin)  partes.push('🏆 <b>é o menor da base</b>');
  return partes.join(' · ');
}

function blocoMotivo(o) {
  if (!o.motivoFila) return '';
  return '⚠️ <b>Por que parou aqui</b>\n' + e(o.motivoFila);
}

function corpoCard(o, extra) {
  const origem = o.grupoOrigemNome ? ' · ' + e(o.grupoOrigemNome) : '';
  return [
    tituloCard(o),
    blocoVoo(o),
    blocoHistorico(o),
    blocoMotivo(o),
    citacao('📱 Como sai no WhatsApp', o.mensagemFormatada, LIMITE_PREVIA, false, e),
    o.conteudoOriginal ? citacao('📥 Post original' + origem, o.conteudoOriginal, LIMITE_ORIGINAL, true, e) : '',
    extra ? '<b>' + e(extra) + '</b>' : '',
  ].filter(Boolean).join('\n\n');
}

// Decisao no topo e sozinha; Descartar longe do Enviar, para nao sair por
// toque errado no celular.
function tecladoCard(id) {
  return bot.teclado([
    [['🚀 Enviar agora', 'p:enviar:' + id]],
    [['🔄 Atualizar', 'p:ver:' + id], ['📋 Fila', 'p:fila:0'], ['🗑️ Descartar', 'p:descartar:' + id]],
  ]);
}

function recibo(o, prefixo) {
  const d = o.dados || {};
  return e(prefixo + ' ' + (d.origem || '?') + '→' + (d.destino || '?') + ' · '
    + nPts(d.pontos) + ' pts ' + (d.programa || '') + ' (#' + o.id + ')');
}

function registrarCard(chatId, msgId, ofertaId) {
  if (msgId) cardsAbertos.set(String(chatId) + ':' + msgId, String(ofertaId));
}

async function encerrarCard(chatId, msgId, texto) {
  cardsAbertos.delete(String(chatId) + ':' + msgId);
  return bot.falarHtml(chatId, texto, null, msgId);
}

/** Chamado pelo server.js quando uma passagem entra na fila de aprovacao. */
export async function enviarCardPassagem(oferta) {
  if (!bot.ativo || !bot.admins.size || !dep) return;
  const r = await apiLocal('GET', '/cdv/oferta/' + oferta.id);
  if (!r.ok) { console.warn(bot.TAG + ' passagem #' + oferta.id + ' sem card: ' + (r.erro || r.http)); return; }
  await bot.paraCadaAdmin(async (chatId) => {
    const m = await bot.falarHtml(chatId, corpoCard(r.oferta), tecladoCard(r.oferta.id));
    registrarCard(chatId, m?.message_id, r.oferta.id);
  });
}

// ── FILA ─────────────────────────────────────────────────────────────────────
function rotuloItemFila(i) {
  const rota = (i.origem || '?') + '→' + (i.destino || '?');
  return ['#' + i.id, rota, nPts(i.pontos) + ' pts', (i.programa || '').slice(0, 12)]
    .filter(Boolean).join(' · ');
}

async function mostrarFila(chatId, msgId) {
  const r = await apiLocal('GET', '/cdv/fila');
  if (!r.ok) return bot.falarPlano(chatId, '❌ Não consegui ler a fila: ' + (r.erro || r.http), null, msgId);
  const itens = r.itens || [];
  let res;
  if (!itens.length) {
    res = await bot.falarPlano(chatId, '📋 Nenhuma passagem esperando decisão.',
      bot.teclado([[['🔄 Atualizar', 'p:fila:0']]]), msgId);
  } else {
    const linhas = itens.map(i => [[rotuloItemFila(i), 'p:ver:' + i.id]]);
    linhas.push([['🔄 Atualizar', 'p:fila:0']]);
    const cabec = '📋 Passagens esperando decisão: ' + r.total
      + (r.total > itens.length ? ' (mostrando as ' + itens.length + ' mais recentes)' : '');
    res = await bot.falarPlano(chatId, cabec, bot.teclado(linhas), msgId);
  }
  const alvo = res?.message_id || msgId;
  if (alvo) msgDaFila.set(String(chatId), alvo);
  return res;
}

// ── ACOES ────────────────────────────────────────────────────────────────────
async function tratarAcao(chatId, msgId, partes, callbackId) {
  const acao = partes[1];
  const id   = partes[2];

  if (acao === 'fila') return mostrarFila(chatId, msgId);

  // Sempre reler antes de agir: o item pode ter sido aprovado na tela ou
  // varrido pela limpeza da fila desde que o card foi desenhado.
  const rr = await apiLocal('GET', '/cdv/oferta/' + id);
  if (!rr.ok) return encerrarCard(chatId, msgId, '⚠️ #' + e(id) + ' saiu da fila (resolvida em outro lugar ou expirada).');
  const o = rr.oferta;
  if (o.status !== 'pendente') {
    return encerrarCard(chatId, msgId, recibo(o, '✔️ Já resolvida (' + o.status + '):'));
  }

  if (acao === 'ver') {
    registrarCard(chatId, msgId, id);
    return bot.falarHtml(chatId, corpoCard(o), tecladoCard(id), msgId);
  }

  if (acao === 'enviar') {
    // Tira os botoes ANTES do await: o envio leva segundos e um segundo toque
    // duplicaria a mensagem no grupo.
    await bot.falarHtml(chatId, corpoCard(o, '⏳ Enviando...'), null, msgId);
    const env = await apiLocal('POST', '/painel/aprovar/' + id, { naoEsperar: true });
    if (!env.ok) {
      return bot.falarHtml(chatId, corpoCard(o, '❌ Falha no envio: ' + (env.erro || env.http)), tecladoCard(id), msgId);
    }
    if (env.naFila) {
      const min = Math.round((env.esperaSeg || 0) / 60);
      const quando = (env.esperaSeg || 0) < 90 ? 'em instantes' : 'em ~' + min + ' min';
      return encerrarCard(chatId, msgId, recibo(o, '🕒 Na fila de publicação (' + env.posicao + 'º, sai ' + quando + '):'));
    }
    return encerrarCard(chatId, msgId, recibo(o, '✅ Enviada em ' + (env.enviados ?? '?') + ' grupo(s):'));
  }

  if (acao === 'descartar') {
    const d = await apiLocal('POST', '/painel/rejeitar/' + id, {});
    // Falha mantem o card COM botoes: sem eles o item segue pendente e o
    // operador fica sem como tentar de novo pelo celular.
    if (!d.ok) {
      return bot.falarHtml(chatId, corpoCard(o, '❌ Falha ao descartar: ' + (d.erro || d.http)), tecladoCard(id), msgId);
    }
    return encerrarCard(chatId, msgId, recibo(o, '🗑️ Descartada:'));
  }

  return bot.toast(callbackId, 'Ação desconhecida.');
}

// ── WEBHOOK ──────────────────────────────────────────────────────────────────
export async function tratarUpdateBotPassagens(update) {
  try {
    const cb = update?.callback_query;
    if (cb) {
      const chatId = cb.message?.chat?.id;
      const msgId  = cb.message?.message_id;
      if (!bot.autorizado(chatId)) return void await bot.toast(cb.id, 'Sem permissão.');
      await bot.toast(cb.id);
      const partes = String(cb.data || '').split(':');
      if (partes[0] === 'p') await tratarAcao(chatId, msgId, partes, cb.id);
      return;
    }

    const m = update?.message;
    if (!m) return;
    const chatId = m.chat?.id;
    if (!bot.autorizado(chatId)) {
      console.warn(bot.TAG + ' mensagem de chat nao autorizado: ' + chatId);
      return void await bot.falarPlano(chatId, 'Sem permissão. Seu ID: ' + chatId);
    }
    const texto = String(m.text || '').trim().toLowerCase().split('@')[0];
    if (texto === '/fila' || texto === '/start' || texto === '/menu') return void await mostrarFila(chatId, null);
    if (texto) {
      await bot.falarPlano(chatId, 'Este bot só mostra passagens esperando decisão. Use /fila.',
        bot.teclado([[['📋 Fila', 'p:fila:0']]]));
    }
  } catch (err) {
    console.error(bot.TAG + ' erro no update: ' + err.message);
  }
}

export async function bootBotPassagens(deps) {
  dep = deps;
  await bot.bootWebhook([
    { command: 'fila', description: 'Passagens esperando decisão' },
  ]);
}
