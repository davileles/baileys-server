// ── BOT DO TELEGRAM — PASSAGENS NA FILA DE APROVACAO ─────────────────────────
// Toda emissao capturada que NAO passou no gate de auto-envio cai na fila do
// gestor e tambem chega aqui como card com botao. O motivo de ter parado
// (campo incompleto, sem historico, acima do teto, abaixo do piso) vem no topo
// do card: sem ele a decisao de aprovar pelo celular vira chute.
//
// Este modulo NAO reimplementa regra nenhuma. Aprovar chama o mesmo
// /painel/aprovar/:id que o botao da tela usa; rejeitar chama /painel/rejeitar;
// editar chama /painel/reformatar/:id, que aplica os campos, recalcula o
// historico 180d e remonta a mensagem pelo MESMO formatador da captura. Por
// isso a edicao aqui nunca deixa mensagem enviada e registro em passagens.json
// divergirem — e por isso tambem nao existe "editar a mensagem inteira": texto
// livre quebraria esse casamento.
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

const cardsAbertos = new Map();
const msgDaFila    = new Map();

const LIMITE_PREVIA   = 2200;
const LIMITE_ORIGINAL = 700;

// ── SESSAO DE EDICAO ─────────────────────────────────────────────────────────
// Estado de "estou esperando um valor" vive em memoria: dura segundos e se
// perde num redeploy (aceitavel — o operador toca no campo de novo). Nada de
// valor mora aqui: o campo editado vai direto para a fila do servidor.
const sessoes = new Map();          // chatId -> { campo, ofertaId, msgId, expiraEm }
const SESSAO_TTL_MS = 15 * 60 * 1000;

setInterval(() => {
  const agora = Date.now();
  for (const [k, s] of sessoes) if (s.expiraEm < agora) sessoes.delete(k);
}, 5 * 60 * 1000).unref?.();

function abrirSessao(chatId, campo, ofertaId, msgId) {
  sessoes.set(String(chatId), { campo, ofertaId, msgId, expiraEm: Date.now() + SESSAO_TTL_MS });
}

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
    [['✏️ Editar', 'p:editar:' + id], ['🔄 Atualizar', 'p:ver:' + id]],
    [['📋 Fila', 'p:fila:0'], ['🗑️ Descartar', 'p:descartar:' + id]],
  ]);
}

// ── EDICAO ───────────────────────────────────────────────────────────────────
// Mesma lista de CAMPOS_EDITAVEIS_ALERTA do server.js. tipoVoo fica de fora do
// menu: na pratica sai das datas e nunca foi a causa de um card parado.
const CAMPOS = {
  origem:     'Origem',
  destino:    'Destino',
  cia:        'Cia aérea',
  programa:   'Programa',
  pontos:     'Pontos',
  cabine:     'Cabine',
  datasIda:   'Datas de ida',
  datasVolta: 'Datas de volta',
};

// Cabine sai por botao, nao por digitacao: e o campo que mais erra na extracao
// e o unico com valores fechados. O texto tem de bater com o canonico do
// servidor ("Economica" sem acento), senao a dedup e o registro em
// passagens.json comparam strings diferentes para a mesma cabine.
const CABINES = ['Economica', 'Premium Economica', 'Executiva', 'Primeira Classe'];

function tecladoEdicao(o) {
  const d = o.dados || {};
  const id = o.id;
  const bt = (k) => [CAMPOS[k] + (d[k] ? '' : ' ⚠️'), 'p:campo:' + k + ':' + id];
  return bot.teclado([
    [bt('origem'), bt('destino')],
    [bt('cia'), bt('programa')],
    [bt('pontos'), bt('cabine')],
    [bt('datasIda'), bt('datasVolta')],
    [['↩️ Voltar ao card', 'p:ver:' + id]],
  ]);
}

function telaEdicao(o) {
  const d = o.dados || {};
  const linhas = Object.keys(CAMPOS).map(k =>
    '• <b>' + e(CAMPOS[k]) + '</b>: ' + (d[k] ? e(String(d[k])) : '<i>vazio</i>'));
  return '✏️ <b>Editar #' + e(o.id) + '</b>\nToque no campo que quer corrigir — '
    + 'a mensagem é remontada na hora.\n\n' + linhas.join('\n');
}

function tecladoCabine(id) {
  return bot.teclado([
    ...CABINES.map(c => [[c === 'Economica' ? 'Econômica' : c, 'p:cab:' + c + ':' + id]]),
    [['↩️ Voltar', 'p:editar:' + id]],
  ]);
}

// Aplica um campo e redesenha o card. O servidor devolve a mensagem ja
// remontada, entao nao ha versao do texto montada aqui.
async function aplicarCampo(chatId, msgId, id, campo, valor) {
  const r = await apiLocal('POST', '/painel/reformatar/' + id, { dados: { [campo]: valor } });
  const atual = await apiLocal('GET', '/cdv/oferta/' + id);
  if (!atual.ok) {
    return bot.falarHtml(chatId, '⚠️ #' + e(id) + ' saiu da fila enquanto você editava.', null, msgId);
  }
  // parcial: o campo foi gravado, mas a mensagem so e remontada quando origem,
  // destino e programa estiverem os tres preenchidos. Card incompleto cai aqui
  // nas primeiras correcoes, e tratar isso como erro faria o operador achar que
  // a edicao nao pegou.
  const nota = r.ok
    ? '✏️ ' + CAMPOS[campo] + ' atualizado.'
    : r.parcial
      ? '✏️ ' + CAMPOS[campo] + ' gravado. Faltam origem, destino e programa para remontar a mensagem.'
      : '❌ Não consegui aplicar: ' + (r.erro || r.http);
  return bot.falarHtml(chatId, corpoCard(atual.oferta, nota), tecladoCard(id), msgId);
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
  sessoes.delete(String(chatId));
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
  // 'campo' e 'cab' carregam um argumento a mais antes do id.
  const arg = (acao === 'campo' || acao === 'cab') ? partes[2] : null;
  const id  = arg ? partes[3] : partes[2];

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
    sessoes.delete(String(chatId));
    registrarCard(chatId, msgId, id);
    return bot.falarHtml(chatId, corpoCard(o), tecladoCard(id), msgId);
  }

  if (acao === 'editar') {
    sessoes.delete(String(chatId));
    registrarCard(chatId, msgId, id);
    return bot.falarHtml(chatId, telaEdicao(o), tecladoEdicao(o), msgId);
  }

  if (acao === 'cab') return aplicarCampo(chatId, msgId, id, 'cabine', arg);

  if (acao === 'campo') {
    const campo = arg;
    if (!CAMPOS[campo]) return bot.toast(callbackId, 'Campo desconhecido.');
    if (campo === 'cabine') {
      return bot.falarHtml(chatId, '💺 <b>Cabine de #' + e(id) + '</b>\nHoje: '
        + e((o.dados || {}).cabine || 'vazio'), tecladoCabine(id), msgId);
    }
    abrirSessao(chatId, campo, id, msgId);
    const atualVal = (o.dados || {})[campo];
    const dica = campo === 'pontos' ? '\n<i>Só o número, ex: 75000</i>'
      : (campo === 'datasIda' || campo === 'datasVolta')
        ? '\n<i>Ex: Out/26: 08; Jan/27: 22, 29</i>' : '';
    return bot.falarHtml(chatId,
      '✏️ <b>' + e(CAMPOS[campo]) + '</b> de #' + e(id)
      + '\nHoje: ' + (atualVal ? e(String(atualVal)) : '<i>vazio</i>')
      + dica + '\n\nMande o novo valor por mensagem.',
      bot.teclado([[['↩️ Cancelar', 'p:editar:' + id]]]), msgId);
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

// Texto digitado enquanto um campo esta aberto. Edita o CARD (msgId da sessao)
// e apaga o que o operador digitou: senao o chat vira um rastro de valores
// soltos entre os cards.
async function tratarTexto(chatId, texto, msgIdDigitado) {
  const s = sessoes.get(String(chatId));
  if (!s) return false;
  sessoes.delete(String(chatId));

  let valor = String(texto).trim();
  if (s.campo === 'pontos') {
    const n = Number(valor.replace(/[^\d]/g, ''));
    if (!Number.isFinite(n) || n <= 0) {
      await bot.falarPlano(chatId, '❌ Pontos inválidos. Toque no campo de novo e mande só o número.');
      return true;
    }
    valor = String(n);
  }

  await aplicarCampo(chatId, s.msgId, s.ofertaId, s.campo, valor);
  if (msgIdDigitado) await bot.tg('deleteMessage', { chat_id: chatId, message_id: msgIdDigitado });
  return true;
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
    const bruto = String(m.text || '').trim();
    const texto = bruto.toLowerCase().split('@')[0];
    if (texto === '/cancelar') {
      sessoes.delete(String(chatId));
      return void await bot.falarPlano(chatId, 'Edição cancelada.');
    }
    if (texto === '/fila' || texto === '/start' || texto === '/menu') {
      sessoes.delete(String(chatId));
      return void await mostrarFila(chatId, null);
    }
    // Valor de campo tem prioridade sobre a mensagem de ajuda.
    if (await tratarTexto(chatId, bruto, m.message_id)) return;
    if (bruto) {
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
    { command: 'fila',     description: 'Passagens esperando decisão' },
    { command: 'cancelar', description: 'Cancelar a edição em andamento' },
  ]);
}
