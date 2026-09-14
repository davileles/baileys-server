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
// O bot nao monta mensagem: pede a previa pronta ao proxy e aprova pelo mesmo
// caminho da tela. A edicao segue o modelo que o gestor ja usa — os campos
// corrigidos viajam como `edits` na hora de aprovar, em vez de reescreverem a
// fila a cada toque. Um commit no GitHub por campo editado deixaria a edicao
// lenta no celular e encheria o historico do repo de ruido.
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

// Campos corrigidos no celular, por oferta, ate a aprovacao. Em memoria de
// proposito (ver cabecalho). Redeploy no meio da edicao perde os campos; o
// card avisa quando ha edicao pendente para o caso nao passar despercebido.
const edicoes = new Map();          // ofertaId -> { campo: valor }

// "Estou esperando um valor" — uma sessao por chat.
const sessoes = new Map();          // chatId -> { campo, ofertaId, msgId, expiraEm }
const SESSAO_TTL_MS = 15 * 60 * 1000;

setInterval(() => {
  const agora = Date.now();
  for (const [k, s] of sessoes) if (s.expiraEm < agora) sessoes.delete(k);
}, 5 * 60 * 1000).unref?.();

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

// Duas rotas diferentes: a fila de ofertas vive no proxy CDV, mas a analise por
// IA roda neste servidor (e quem tem a chave da API e o pipeline de captura).
async function proxyLocal(metodo, caminho, body) {
  try {
    const r = await fetch('http://127.0.0.1:' + (dep?.PORT || process.env.PORT || 3000) + caminho, {
      method: metodo,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });
    const d = await r.json().catch(() => ({}));
    return { ...d, http: r.status };
  } catch (err) {
    return { ok: false, erro: 'servidor não respondeu: ' + err.message, http: 0 };
  }
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

// Campos que fazem diferenca na mensagem que vai ao grupo. Categoria, programa
// e origem/destino ficam de fora: mexer neles muda o roteamento e o historico
// de transferencias, e isso e decisao de tela, nao de celular.
const CAMPOS = {
  titulo:     'Título',
  resumo:     'Resumo',
  bonus:      'Bônus',
  prazo:      'Prazo',
  loja:       'Loja',
  cupom:      'Cupom',
  link:       'Link',
  importante: 'Importante',
};

function edicoesDe(id) { return edicoes.get(String(id)) || {}; }

function comEdicoes(o) { return { ...o, ...edicoesDe(o.id) }; }

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

function blocoEdicoes(id) {
  const ed = edicoesDe(id);
  const ks = Object.keys(ed);
  if (!ks.length) return '';
  return '✏️ <b>Editado (ainda não salvo):</b> ' + e(ks.map(k => CAMPOS[k] || k).join(', '));
}

function corpoCard(o, mensagem, extra) {
  const v = comEdicoes(o);
  return [
    (v.emoji || '📰') + ' <b>' + e(v.titulo || 'Oferta') + '</b>  <code>#' + e(o.id) + '</code>',
    blocoFatos(v),
    v.resumo ? e(v.resumo) : '',
    blocoFonte(v),
    blocoEdicoes(o.id),
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
    [['✏️ Editar', 'o:editar:' + id], ['🔄 Atualizar', 'o:ver:' + id], ['📋 Fila', 'o:fila:0']],
  ]);
}

function tecladoEdicao(o) {
  const v = comEdicoes(o);
  const id = o.id;
  const bt = (k) => [CAMPOS[k] + (v[k] ? '' : ' ⚠️'), 'o:campo:' + k + ':' + id];
  const linhas = [
    [bt('titulo'), bt('resumo')],
    [bt('bonus'), bt('prazo')],
    [bt('loja'), bt('cupom')],
    [bt('link'), bt('importante')],
  ];
  if (Object.keys(edicoesDe(id)).length) linhas.push([['♻️ Descartar edições', 'o:limpar:' + id]]);
  linhas.push([['↩️ Voltar ao card', 'o:ver:' + id]]);
  return bot.teclado(linhas);
}

function telaEdicao(o) {
  const v = comEdicoes(o);
  const ed = edicoesDe(o.id);
  const linhas = Object.keys(CAMPOS).map(k => {
    const marca = ed[k] !== undefined ? ' ✏️' : '';
    const val = v[k] ? e(String(v[k]).slice(0, 90)) : '<i>vazio</i>';
    return '• <b>' + e(CAMPOS[k]) + '</b>' + marca + ': ' + val;
  });
  return '✏️ <b>Editar #' + e(o.id) + '</b>\nToque no campo que quer corrigir. '
    + 'As correções entram na oferta quando você aprovar.\n\n' + linhas.join('\n');
}

function recibo(o, prefixo) {
  const v = comEdicoes(o);
  return e(prefixo + ' ' + (v.titulo || 'Oferta') + ' (#' + o.id + ')');
}

// Previa sempre com os campos editados aplicados: aprovar um texto diferente
// do que estava na tela e o tipo de surpresa que faz o operador parar de
// confiar no bot.
async function carregarOferta(id) {
  const ed = edicoesDe(id);
  const r = Object.keys(ed).length
    ? await proxy('POST', '/ofertas/mensagem/' + encodeURIComponent(id), { edits: ed })
    : await proxy('GET',  '/ofertas/mensagem/' + encodeURIComponent(id));
  if (!r.ok) return null;
  return r;
}

async function redesenhar(chatId, msgId, id, nota) {
  const det = await carregarOferta(id);
  if (!det) return bot.falarHtml(chatId, '⚠️ <code>#' + e(id) + '</code> saiu da fila.', null, msgId);
  return bot.falarHtml(chatId, corpoCard(det.oferta, det.mensagem, nota), tecladoCard(id), msgId);
}

async function enviarCardOferta(o, mensagem) {
  await bot.paraCadaAdmin(async (chatId) => {
    await bot.falarHtml(chatId, corpoCard(o, mensagem), tecladoCard(o.id));
  });
}

// ── CRIAR OFERTA A PARTIR DE LINK, TEXTO OU ARQUIVO ──────────────────────────
// Toda a analise mora no servidor (/cdv/oferta-ia), no mesmo pipeline das
// capturas de grupo: mesmo prompt, mesma dedup, mesma fila. O bot so entrega o
// material e mostra o card que voltou.
async function criarOferta(chatId, payload, rotulo) {
  const aviso = await bot.falarPlano(chatId, '⏳ Analisando ' + rotulo + '...');
  const r = await proxyLocal('POST', '/cdv/oferta-ia', payload);
  if (!r.ok) {
    return bot.falarPlano(chatId, '❌ ' + (r.erro || 'não consegui montar a oferta'), null, aviso?.message_id);
  }
  if (r.duplicada) {
    return bot.falarPlano(chatId, '♻️ Essa oferta já passou pela fila antes — não criei outra.', null, aviso?.message_id);
  }

  // Marca como vista para o poller nao mandar o mesmo card de novo daqui a
  // pouco, e desenha na hora: quem acabou de colar o link quer ver o resultado
  // agora, nao no proximo ciclo de 10 min.
  vistos.add(String(r.id));
  salvarVistos();
  if (aviso?.message_id) await bot.tg('deleteMessage', { chat_id: chatId, message_id: aviso.message_id });

  const det = await carregarOferta(r.id);
  if (!det) return bot.falarPlano(chatId, '✅ Oferta criada (#' + r.id + '), mas não consegui desenhar o card. Use /fila.');
  return bot.falarHtml(chatId, corpoCard(det.oferta, det.mensagem, '🆕 Criada agora a partir de ' + rotulo + '.'), tecladoCard(r.id));
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
  const arg  = acao === 'campo' ? partes[2] : null;
  const id   = arg ? partes.slice(3).join(':') : partes.slice(2).join(':');

  if (acao === 'fila') return mostrarFila(chatId, msgId);

  // Sempre reler antes de agir: a oferta pode ter sido resolvida na tela desde
  // que o card foi desenhado.
  const det = await carregarOferta(id);
  if (!det) {
    edicoes.delete(String(id));
    return bot.falarHtml(chatId, '⚠️ <code>#' + e(id) + '</code> saiu da fila (resolvida em outro lugar ou expirada).', null, msgId);
  }
  const o = det.oferta;

  if (acao === 'ver') {
    sessoes.delete(String(chatId));
    return bot.falarHtml(chatId, corpoCard(o, det.mensagem), tecladoCard(id), msgId);
  }

  if (acao === 'editar') {
    sessoes.delete(String(chatId));
    return bot.falarHtml(chatId, telaEdicao(o), tecladoEdicao(o), msgId);
  }

  if (acao === 'limpar') {
    edicoes.delete(String(id));
    return redesenhar(chatId, msgId, id, '♻️ Edições descartadas.');
  }

  if (acao === 'campo') {
    const campo = arg;
    if (!CAMPOS[campo]) return bot.toast(callbackId, 'Campo desconhecido.');
    sessoes.set(String(chatId), { campo, ofertaId: id, msgId, expiraEm: Date.now() + SESSAO_TTL_MS });
    const atualVal = comEdicoes(o)[campo];
    return bot.falarHtml(chatId,
      '✏️ <b>' + e(CAMPOS[campo]) + '</b> de #' + e(id)
      + '\nHoje: ' + (atualVal ? e(String(atualVal)) : '<i>vazio</i>')
      + '\n\nMande o novo valor por mensagem. Para deixar o campo vazio, mande <code>-</code>.',
      bot.teclado([[['↩️ Cancelar', 'o:editar:' + id]]]), msgId);
  }

  if (acao === 'enviar' || acao === 'radar') {
    const soRadar = acao === 'radar';
    const ed = edicoesDe(id);
    const temEd = Object.keys(ed).length ? ed : undefined;
    // Botoes saem ANTES do await: aprovar leva segundos (commit no GitHub +
    // fila do WhatsApp) e um segundo toque duplicaria a publicacao.
    await bot.falarHtml(chatId, corpoCard(o, det.mensagem, soRadar ? '⏳ Publicando no Radar...' : '⏳ Aprovando e enfileirando...'), null, msgId);
    const r = soRadar
      ? await proxy('POST', '/ofertas/aprovar', { id, edits: temEd })
      : await proxy('POST', '/ofertas/aprovar-e-enviar', { id, edits: temEd });
    if (!r.ok) {
      return bot.falarHtml(chatId, corpoCard(o, det.mensagem, '❌ Falha: ' + (r.erro || r.http)), tecladoCard(id), msgId);
    }
    edicoes.delete(String(id));
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
    edicoes.delete(String(id));
    return bot.falarHtml(chatId, recibo(o, '🗑️ Rejeitada e bloqueada:'), null, msgId);
  }

  return bot.toast(callbackId, 'Ação desconhecida.');
}

// Texto digitado com um campo aberto: guarda a correcao, redesenha o CARD com a
// previa ja atualizada e apaga o que foi digitado, para o chat nao virar um
// rastro de valores soltos.
async function tratarTexto(chatId, texto, msgIdDigitado) {
  const s = sessoes.get(String(chatId));
  if (!s) return false;
  sessoes.delete(String(chatId));

  const valor = String(texto).trim() === '-' ? '' : String(texto).trim();
  const atual = edicoes.get(String(s.ofertaId)) || {};
  atual[s.campo] = valor;
  edicoes.set(String(s.ofertaId), atual);

  await redesenhar(chatId, s.msgId, s.ofertaId, '✏️ ' + CAMPOS[s.campo] + ' atualizado — aprove para salvar.');
  if (msgIdDigitado) await bot.tg('deleteMessage', { chat_id: chatId, message_id: msgIdDigitado });
  return true;
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
    // Arquivo vira oferta nova. Vem antes do texto porque a legenda chega no
    // mesmo update, em m.caption.
    const legenda = String(m.caption || '').trim();
    const doc = m.document;
    const ehImagemDoc = doc && /^image\//i.test(doc.mime_type || '');
    const ehPdf = doc && /pdf/i.test(doc.mime_type || doc.file_name || '');
    if (m.photo?.length || ehImagemDoc || ehPdf) {
      sessoes.delete(String(chatId));
      const fileId = (m.photo?.length && !doc) ? m.photo[m.photo.length - 1].file_id : doc.file_id;
      try {
        const arq = await bot.baixarArquivo(fileId);
        const payload = ehPdf
          ? { texto: legenda, pdfs: [arq.base64] }
          : { texto: legenda, imagens: [arq.base64] };
        return void await criarOferta(chatId, payload, ehPdf ? 'o PDF' : 'a imagem');
      } catch (err) {
        return void await bot.falarPlano(chatId, '❌ Não consegui baixar o arquivo: ' + err.message);
      }
    }
    if (doc) {
      return void await bot.falarPlano(chatId, 'Esse tipo de arquivo eu não leio. Mande imagem, PDF, um link ou o texto.');
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
    if (texto === '/nova') {
      sessoes.delete(String(chatId));
      return void await bot.falarPlano(chatId,
        'Mande o link da promoção, o texto, um print ou o PDF. Eu leio, monto a oferta e devolvo o card aqui.');
    }
    if (await tratarTexto(chatId, bruto, m.message_id)) return;

    // Mensagem que e so um link vai pelo caminho de link (o servidor busca a
    // pagina); qualquer outro texto com corpo vai como conteudo bruto.
    const soLink = bruto.match(/^https?:\/\/\S+$/i);
    if (soLink) return void await criarOferta(chatId, { link: bruto }, 'o link');
    if (bruto.length >= 15) return void await criarOferta(chatId, { texto: bruto }, 'o texto');
    if (bruto) {
      await bot.falarPlano(chatId, 'Mande um link, texto, print ou PDF da promoção — ou use /fila para ver o que está esperando decisão.',
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
    { command: 'fila',     description: 'Ofertas de pontos esperando decisão' },
    { command: 'nova',     description: 'Criar oferta a partir de link, texto ou arquivo' },
    { command: 'cancelar', description: 'Cancelar a edição em andamento' },
  ]);
  if (!ok) return;
  // Atraso no primeiro tiro: o boot ja tem trabalho demais (WhatsApp, Telegram,
  // filas) e a varredura inicial so marca o que ja existe.
  setTimeout(() => { varrerPendentes().catch(err => console.warn(bot.TAG + ' varredura falhou: ' + err.message)); }, 30000);
  setInterval(() => { varrerPendentes().catch(err => console.warn(bot.TAG + ' varredura falhou: ' + err.message)); }, POLL_MS).unref?.();
  console.log(bot.TAG + ' poller da fila de ofertas a cada ' + Math.round(POLL_MS / 60000) + ' min.');
}
