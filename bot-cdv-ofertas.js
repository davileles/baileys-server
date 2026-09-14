// ── BOT DO TELEGRAM — OFERTAS GERAIS DE PONTOS E MILHAS ──────────────────────
// Fila unica, duas fontes: o radar de RSS do painel-cdv (coletar-radar.js, que
// roda por GitHub Action) e as capturas de grupo de plantao de milhas feitas
// pelo proprio servidor. As duas gravam no MESMO ofertas-pendentes.json, entao
// o bot nao precisa saber de onde veio nada: ele observa a fila do proxy.
//
// Por que um poller e nao um gatilho: o coletor de RSS roda no GitHub Actions,
// fora deste processo. Empurrar card de la exigiria o token do bot como secret
// do repositorio. Observar a fila cobre as duas fontes com um mecanismo so e
// mantem o token em um lugar unico.
//
// O bot nao monta mensagem: pede a previa pronta ao proxy
// (/ofertas/mensagem/:id) e aprova pelo mesmo caminho da tela. Se o template
// mudar, o card muda junto.
//
// Env:
//   TELEGRAM_BOT_OFERTAS_TOKEN    token do @BotFather (ausente = bot off)
//   TELEGRAM_BOT_OFERTAS_ADMINS   ids autorizados (default: TELEGRAM_BOT_ADMINS)
//   TELEGRAM_BOT_OFERTAS_SECRET   segredo do path do webhook (default: cdv-ofertas)
//   OFERTAS_POLL_MIN              intervalo do poller em minutos (default: 10)
//   CDV_PROXY_URL                 base do proxy CDV
//   BOT_TSP_URL                   URL publica do servico (default: RAILWAY_PUBLIC_DOMAIN)

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { criarBot, citacao } from './telegram-core.js';

const bot = criarBot({
  nome:    'BOT-OFERTAS',
  token:   process.env.TELEGRAM_BOT_OFERTAS_TOKEN || '',
  secret:  process.env.TELEGRAM_BOT_OFERTAS_SECRET || 'cdv-ofertas',
  admins:  process.env.TELEGRAM_BOT_OFERTAS_ADMINS || process.env.TELEGRAM_BOT_ADMINS || '',
  urlBase: process.env.BOT_TSP_URL || '',
});

const PROXY = (process.env.CDV_PROXY_URL || 'https://cdv-proxy-production.up.railway.app').replace(/\/$/, '');
const POLL_MS = Math.max(2, Number(process.env.OFERTAS_POLL_MIN) || 10) * 60 * 1000;

export const BOT_OFERTAS_PATH  = bot.path;
export const BOT_OFERTAS_ATIVO = bot.ativo;

let dep = null;
let ARQUIVO_VISTOS = './sessao/ofertas-cardadas.json';

// Memoria de quem ja virou card. Precisa sobreviver a redeploy: o Railway
// reinicia sozinho e, sem isso, a fila inteira viraria card de novo a cada
// boot — sessenta itens repetidos no chat.
let vistos = new Set();

function carregarVistos() {
  try {
    if (existsSync(ARQUIVO_VISTOS)) vistos = new Set(JSON.parse(readFileSync(ARQUIVO_VISTOS, 'utf-8')));
  } catch (e) { console.warn(bot.TAG + ' nao consegui ler ' + ARQUIVO_VISTOS + ': ' + e.message); }
}
function salvarVistos() {
  try {
    const dir = ARQUIVO_VISTOS.slice(0, ARQUIVO_VISTOS.lastIndexOf('/'));
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(ARQUIVO_VISTOS, JSON.stringify([...vistos].slice(-500)));
  } catch (e) { console.warn(bot.TAG + ' nao consegui gravar ' + ARQUIVO_VISTOS + ': ' + e.message); }
}

async function proxy(metodo, caminho, body) {
  try {
    const r = await fetch(PROXY + caminho, {
      method: metodo,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    return { ...d, http: r.status };
  } catch (err) {
    return { ok: false, erro: 'proxy inacessível: ' + err.message, http: 0 };
  }
}

// ── CARD ─────────────────────────────────────────────────────────────────────
const e = bot.esc;
const LIMITE_PREVIA   = 2400;
const LIMITE_ORIGINAL = 600;

const CATEGORIA_ROTULO = {
  transferencia:     'Transferência bonificada',
  compra:            'Compra de pontos',
  compra_bonificada: 'Compra bonificada',
  clube:             'Clube de fidelidade',
  cartao:            'Cartão de crédito',
  geral:             'Oferta',
};

function blocoFatos(o) {
  const l = [];
  const cat = CATEGORIA_ROTULO[o.categoria] || CATEGORIA_ROTULO.geral;
  l.push('🏷️ ' + e(cat) + (o.programa ? ' · ' + e(o.programa) : ''));
  if (o.bonus) l.push('🎁 Bônus: <b>' + e(o.bonus) + '</b>');
  if (o.prazo) l.push('📆 Prazo: ' + e(o.prazo));
  if (o.loja)  l.push('🛒 ' + e(o.loja));
  if (o.cupom) l.push('🏷️ Cupom: <code>' + e(o.cupom) + '</code>');
  return l.join('\n');
}

// Procedencia no card: capturado em grupo de WhatsApp nao tem artigo por tras,
// e isso muda o quanto o operador confere antes de aprovar.
function blocoFonte(o) {
  if (o.grupoNome) return '📥 Capturada em <i>' + e(o.grupoNome) + '</i>';
  if (o.fonte && o.fonte !== 'externa') return '📥 Fonte: ' + e(o.fonte);
  return '📥 Radar de conteúdo';
}

function corpoCard(o, mensagem, extra) {
  return [
    (o.emoji || '📰') + ' <b>' + e(o.titulo || 'Oferta') + '</b>  <code>#' + e(o.id) + '</code>',
    blocoFatos(o),
    o.resumo ? e(o.resumo) : '',
    blocoFonte(o),
    citacao('📱 Como sai no WhatsApp', mensagem, LIMITE_PREVIA, false, e),
    o.conteudoOriginal ? citacao('📄 Conteúdo original', o.conteudoOriginal, LIMITE_ORIGINAL, true, e) : '',
    extra ? '<b>' + e(extra) + '</b>' : '',
  ].filter(Boolean).join('\n\n');
}

// "Só Radar" publica no site sem mandar no WhatsApp — e o equivalente do botao
// que ja existe na tela, e o caso mais comum de oferta boa mas repetida.
function tecladoCard(id) {
  return bot.teclado([
    [['✅ Aprovar e enviar', 'o:enviar:' + id]],
    [['📡 Só Radar', 'o:radar:' + id], ['🗑️ Rejeitar', 'o:rejeitar:' + id]],
    [['🔄 Atualizar', 'o:ver:' + id], ['📋 Fila', 'o:fila:0']],
  ]);
}

function recibo(o, prefixo) {
  return e(prefixo + ' ' + (o.titulo || 'Oferta') + ' (#' + o.id + ')');
}

async function carregarOferta(id) {
  const r = await proxy('GET', '/ofertas/mensagem/' + encodeURIComponent(id));
  if (!r.ok) return null;
  return r;
}

async function enviarCardOferta(o, mensagem) {
  await bot.paraCadaAdmin(async (chatId) => {
    await bot.falarHtml(chatId, corpoCard(o, mensagem), tecladoCard(o.id));
  });
}

// ── POLLER ───────────────────────────────────────────────────────────────────
// Primeira volta depois de um boot limpo NAO manda card do que ja estava na
// fila: so marca como visto. O objetivo e avisar do que CHEGA, nao despejar o
// acumulado no chat.
let primeiraVolta = true;

async function varrerPendentes() {
  if (!bot.ativo || !bot.admins.size) return;
  const r = await proxy('GET', '/ofertas/pendentes');
  const itens = Array.isArray(r?.items) ? r.items : null;
  if (!itens) { console.warn(bot.TAG + ' fila de ofertas indisponível: ' + (r.erro || r.http)); return; }

  const novos = itens.filter(o => o?.id && !vistos.has(String(o.id)));
  for (const o of novos) vistos.add(String(o.id));
  if (novos.length) salvarVistos();

  if (primeiraVolta) {
    primeiraVolta = false;
    if (novos.length) console.log(bot.TAG + ' ' + novos.length + ' oferta(s) já na fila marcadas como vistas no boot.');
    return;
  }

  for (const o of novos) {
    try {
      const det = await carregarOferta(o.id);
      await enviarCardOferta(det?.oferta || o, det?.mensagem || '');
    } catch (err) {
      console.warn(bot.TAG + ' card da oferta ' + o.id + ' falhou: ' + err.message);
    }
  }
}

// ── FILA ─────────────────────────────────────────────────────────────────────
async function mostrarFila(chatId, msgId) {
  const r = await proxy('GET', '/ofertas/pendentes');
  const itens = Array.isArray(r?.items) ? r.items : null;
  if (!itens) return bot.falarPlano(chatId, '❌ Não consegui ler a fila: ' + (r.erro || r.http), null, msgId);
  if (!itens.length) {
    return bot.falarPlano(chatId, '📋 Nenhuma oferta esperando decisão.',
      bot.teclado([[['🔄 Atualizar', 'o:fila:0']]]), msgId);
  }
  const linhas = itens.slice(0, 8).map(o => [[
    ((o.emoji || '📰') + ' ' + String(o.titulo || '').slice(0, 42)), 'o:ver:' + o.id,
  ]]);
  linhas.push([['🔄 Atualizar', 'o:fila:0']]);
  const cabec = '📋 Ofertas esperando decisão: ' + itens.length
    + (itens.length > 8 ? ' (mostrando as 8 mais recentes)' : '');
  return bot.falarPlano(chatId, cabec, bot.teclado(linhas), msgId);
}

// ── ACOES ────────────────────────────────────────────────────────────────────
async function tratarAcao(chatId, msgId, partes, callbackId) {
  const acao = partes[1];
  const id   = partes.slice(2).join(':');

  if (acao === 'fila') return mostrarFila(chatId, msgId);

  // Sempre reler antes de agir: a oferta pode ter sido resolvida na tela desde
  // que o card foi desenhado.
  const det = await carregarOferta(id);
  if (!det) {
    return bot.falarHtml(chatId, '⚠️ <code>#' + e(id) + '</code> saiu da fila (resolvida em outro lugar ou expirada).', null, msgId);
  }
  const o = det.oferta;

  if (acao === 'ver') return bot.falarHtml(chatId, corpoCard(o, det.mensagem), tecladoCard(id), msgId);

  if (acao === 'enviar' || acao === 'radar') {
    const soRadar = acao === 'radar';
    // Botoes saem ANTES do await: aprovar leva segundos (commit no GitHub +
    // fila do WhatsApp) e um segundo toque duplicaria a publicacao.
    await bot.falarHtml(chatId, corpoCard(o, det.mensagem, soRadar ? '⏳ Publicando no Radar...' : '⏳ Aprovando e enfileirando...'), null, msgId);
    const r = soRadar
      ? await proxy('POST', '/ofertas/aprovar', { id })
      : await proxy('POST', '/ofertas/aprovar-e-enviar', { id });
    if (!r.ok) {
      return bot.falarHtml(chatId, corpoCard(o, det.mensagem, '❌ Falha: ' + (r.erro || r.http)), tecladoCard(id), msgId);
    }
    if (soRadar) return bot.falarHtml(chatId, recibo(o, '📡 Publicada no Radar (sem WhatsApp):'), null, msgId);
    const pos = r.posicao || 1, min = r.minutos || 0;
    const quando = (pos === 1 && min === 0) ? 'saindo agora' : 'na fila (pos. ' + pos + ', ~' + min + ' min)';
    return bot.falarHtml(chatId, recibo(o, '✅ Aprovada — ' + quando + ':'), null, msgId);
  }

  if (acao === 'rejeitar') {
    const r = await proxy('POST', '/ofertas/rejeitar', { id });
    if (!r.ok) {
      return bot.falarHtml(chatId, corpoCard(o, det.mensagem, '❌ Falha ao rejeitar: ' + (r.erro || r.http)), tecladoCard(id), msgId);
    }
    return bot.falarHtml(chatId, recibo(o, '🗑️ Rejeitada e bloqueada:'), null, msgId);
  }

  return bot.toast(callbackId, 'Ação desconhecida.');
}

// ── WEBHOOK ──────────────────────────────────────────────────────────────────
export async function tratarUpdateBotOfertas(update) {
  try {
    const cb = update?.callback_query;
    if (cb) {
      const chatId = cb.message?.chat?.id;
      const msgId  = cb.message?.message_id;
      if (!bot.autorizado(chatId)) return void await bot.toast(cb.id, 'Sem permissão.');
      await bot.toast(cb.id);
      const partes = String(cb.data || '').split(':');
      if (partes[0] === 'o') await tratarAcao(chatId, msgId, partes, cb.id);
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
      await bot.falarPlano(chatId, 'Este bot só mostra ofertas de pontos esperando decisão. Use /fila.',
        bot.teclado([[['📋 Fila', 'o:fila:0']]]));
    }
  } catch (err) {
    console.error(bot.TAG + ' erro no update: ' + err.message);
  }
}

export async function bootBotOfertas(deps) {
  dep = deps || {};
  if (dep.sessaoDir) ARQUIVO_VISTOS = dep.sessaoDir.replace(/\/$/, '') + '/ofertas-cardadas.json';
  carregarVistos();
  const ok = await bot.bootWebhook([
    { command: 'fila', description: 'Ofertas de pontos esperando decisão' },
  ]);
  if (!ok) return;
  // Atraso no primeiro tiro: o boot ja tem trabalho demais (WhatsApp, Telegram,
  // filas) e a varredura inicial so marca o que ja existe.
  setTimeout(() => { varrerPendentes().catch(err => console.warn(bot.TAG + ' varredura falhou: ' + err.message)); }, 30000);
  setInterval(() => { varrerPendentes().catch(err => console.warn(bot.TAG + ' varredura falhou: ' + err.message)); }, POLL_MS).unref?.();
  console.log(bot.TAG + ' poller da fila de ofertas a cada ' + Math.round(POLL_MS / 60000) + ' min.');
}
