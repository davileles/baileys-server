// ── BOT DO TELEGRAM (criacao manual de cupom / oferta / mensagem) ────────────
// Interface conversacional com botoes para o operador cadastrar conteudo do
// celular, sem abrir o painel. NAO reimplementa regra de negocio: monta o
// objeto de dados e entrega para as MESMAS funcoes que o monitoramento usa
// (formatarCupomTSP, enfileirarCupomTSP, enviarCupomParaGrupos). Se o template
// do cupom mudar no painel, a mensagem do bot muda junto.
//
// Sem dependencia nova: fala com a Bot API por fetch puro.
//
// Env:
//   TELEGRAM_BOT_TOKEN   token do @BotFather (obrigatorio; ausente = bot off)
//   TELEGRAM_BOT_ADMINS  ids numericos autorizados, separados por virgula
//   TELEGRAM_BOT_SECRET  segredo do path do webhook (default: 'tsp')
//   BOT_TSP_URL          URL publica do servico (default: RAILWAY_PUBLIC_DOMAIN)

const TOKEN  = process.env.TELEGRAM_BOT_TOKEN || '';
const SECRET = process.env.TELEGRAM_BOT_SECRET || 'tsp';
const ADMINS = new Set(
  String(process.env.TELEGRAM_BOT_ADMINS || '')
    .split(',').map(s => s.trim()).filter(Boolean)
);

export const BOT_TSP_ATIVO = !!TOKEN;
export const BOT_TSP_PATH  = `/bot-tsp/webhook/${SECRET}`;

// Injetado pelo server.js no boot. Manter o bot ignorante das entranhas do
// servidor evita import circular e deixa claro qual e a superficie usada.
let dep = null;

// ── SESSOES DO ASSISTENTE ────────────────────────────────────────────────────
// Estado de wizard vive em memoria: dura minutos e se perde num redeploy do
// Railway (aceitavel — o operador so refaz o passo). Nada de valor persiste
// aqui: o cupom so vira dado depois de confirmado.
const sessoes = new Map();           // chatId → { fluxo, passo, dados, msgId, expiraEm }
const SESSAO_TTL_MS = 30 * 60 * 1000;

setInterval(() => {
  const agora = Date.now();
  for (const [k, s] of sessoes) if (s.expiraEm < agora) sessoes.delete(k);
}, 5 * 60 * 1000).unref?.();

function abrir(chatId, fluxo) {
  const s = { fluxo, passo: null, dados: {}, msgId: null, expiraEm: Date.now() + SESSAO_TTL_MS };
  sessoes.set(String(chatId), s);
  return s;
}
function sessao(chatId) {
  const s = sessoes.get(String(chatId));
  if (!s) return null;
  s.expiraEm = Date.now() + SESSAO_TTL_MS;
  return s;
}

// ── BOT API ──────────────────────────────────────────────────────────────────
async function tg(metodo, body) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${metodo}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if (!d.ok) console.warn(`[BOT-TSP] ${metodo} falhou:`, d.description || r.status);
  return d;
}

// Canal de alerta operacional independente do WhatsApp: manda `texto` (plain
// text, sem parse_mode — Markdown malformado faria o Telegram recusar o aviso)
// para todos os TELEGRAM_BOT_ADMINS. Usado pelo watchdog do server.js: se o
// sock do WhatsApp morrer por inteiro, este e o unico canal que ainda chega.
export async function notificarAdminsTelegram(texto) {
  if (!TOKEN || !ADMINS.size) return false;
  let algum = false;
  for (const chatId of ADMINS) {
    try {
      const d = await tg('sendMessage', { chat_id: chatId, text: texto });
      if (d && d.ok) algum = true;
    } catch (e) { console.warn('[BOT-TSP] Alerta a admin ' + chatId + ' falhou:', e.message); }
  }
  return algum;
}

function teclado(linhas) {
  return { inline_keyboard: linhas.map(l => l.map(([texto, data]) => ({ text: texto, callback_data: data }))) };
}

// Uma unica funcao de saida: quando veio de um botao, EDITA a mensagem em vez
// de empilhar outra. O chat fica com um card so, que vai mudando de passo.
async function falar(chatId, texto, kb, editarMsgId) {
  const base = { chat_id: chatId, text: texto, parse_mode: 'Markdown' };
  if (kb) base.reply_markup = kb;
  if (editarMsgId) {
    const d = await tg('editMessageText', { ...base, message_id: editarMsgId });
    if (d.ok) return d.result;
  }
  const d = await tg('sendMessage', base);
  return d.result || null;
}

// ── PARSE ────────────────────────────────────────────────────────────────────
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

// ── FLUXO CUPOM ──────────────────────────────────────────────────────────────
const LOJAS = ['Amazon', 'Mercado Livre', 'Shopee', 'Magazine Luiza', 'Zé Delivery'];

const PASSOS_CUPOM = ['loja', 'codigo', 'tipo', 'valor', 'minimo', 'limite', 'maximo', 'gatilho', 'preview'];

function proximoPassoCupom(s) {
  const i = PASSOS_CUPOM.indexOf(s.passo);
  for (let j = i + 1; j < PASSOS_CUPOM.length; j++) {
    // Teto de desconto so existe em cupom percentual.
    if (PASSOS_CUPOM[j] === 'limite' && s.dados.tipo !== 'pct') continue;
    return PASSOS_CUPOM[j];
  }
  return 'preview';
}

async function pedirPassoCupom(chatId, s, editar) {
  const d = s.dados;
  switch (s.passo) {
    case 'loja':
      return falar(chatId, '*Novo cupom* 🏷️\n\nQual a loja?', teclado([
        ...LOJAS.map(l => [[l, 'c:loja:' + l]]),
        [['✏️ Outra loja', 'c:loja:__outra'], ['❌ Cancelar', 'a:cancelar']],
      ]), editar);

    case 'codigo':
      return falar(chatId, `Loja: *${d.loja}*\n\nDigite o *código do cupom*.`, teclado([
        [['Sem código', 'c:codigo:__vazio']],
        [['❌ Cancelar', 'a:cancelar']],
      ]), editar);

    case 'tipo':
      return falar(chatId, 'O desconto é em *percentual* ou em *reais*?', teclado([
        [['% Percentual', 'c:tipo:pct'], ['R$ Valor fixo', 'c:tipo:reais']],
        [['❌ Cancelar', 'a:cancelar']],
      ]), editar);

    case 'valor':
      return falar(chatId, d.tipo === 'pct'
        ? 'Digite o *percentual* de desconto (ex: `15`).'
        : 'Digite o *valor* do desconto em reais (ex: `30`).',
        teclado([[['❌ Cancelar', 'a:cancelar']]]), editar);

    case 'minimo':
      // "Sem minimo" e uma AFIRMACAO que vai para a mensagem. "Nao informado"
      // faz o template mandar conferir na loja. Sao coisas diferentes e o
      // operador precisa escolher qual das duas — nunca inferir.
      return falar(chatId, 'Tem *valor mínimo de compra*?', teclado([
        [['Sem mínimo', 'c:minimo:__zero'], ['Não informado', 'c:minimo:__desconhecido']],
        [['✏️ Digitar valor', 'c:minimo:__digitar']],
        [['❌ Cancelar', 'a:cancelar']],
      ]), editar);

    case 'limite':
      return falar(chatId, 'Tem *teto de desconto* (limite em R$ que o cupom abate)?', teclado([
        [['Sem teto', 'c:limite:__vazio'], ['✏️ Digitar', 'c:limite:__digitar']],
        [['❌ Cancelar', 'a:cancelar']],
      ]), editar);

    case 'maximo':
      return falar(chatId, 'Vale só para *produtos até* um certo preço?\n\n_Isso é o teto do PRODUTO, não do desconto._', teclado([
        [['Não tem', 'c:maximo:__vazio'], ['✏️ Digitar', 'c:maximo:__digitar']],
        [['❌ Cancelar', 'a:cancelar']],
      ]), editar);

    case 'gatilho':
      return falar(chatId, 'Quer um *gatilho* no topo da mensagem?', teclado([
        [['Sem gatilho', 'c:gatilho:__vazio'], ['✏️ Digitar', 'c:gatilho:__digitar']],
        [['❌ Cancelar', 'a:cancelar']],
      ]), editar);

    case 'preview':
      return previewCupom(chatId, s, editar);
  }
}

function dadosCupom(s) {
  const d = s.dados;
  return {
    loja:    d.loja,
    tipo:    d.tipo === 'pct' ? 'pct' : 'reais',
    valor:   d.valor || 0,
    minimo:  d.minimo ?? null,
    maximo:  d.maximo ?? null,
    limite:  d.limite ?? null,
    codigo:  d.codigo || '',
    gatilho: d.gatilho || '',
    minimoDesconhecido: !!d.minimoDesconhecido,
  };
}

async function previewCupom(chatId, s, editar) {
  s.passo = 'preview';
  let msg;
  try { msg = dep.formatarCupomTSP(dadosCupom(s)); }
  catch (e) { return falar(chatId, '⚠️ Erro ao montar a mensagem: ' + e.message, null, editar); }
  s.dados.mensagem = msg;
  return falar(chatId,
    '*Prévia da mensagem* 👇\n\n- - - - - - - - - -\n' + msg + '\n- - - - - - - - - -',
    teclado([
      [['🚀 Enviar agora', 'a:enviar'], ['📋 Mandar pra fila', 'a:fila']],
      [['🔁 Refazer', 'a:refazer'], ['❌ Cancelar', 'a:cancelar']],
    ]), editar);
}

// ── FLUXO OFERTA ─────────────────────────────────────────────────────────────
// Um link basta: o pipeline do radar le preco, titulo e imagem, e o template da
// loja monta a mensagem — a mesma das ofertas automaticas.
async function montarOfertaPorLink(link, cupom) {
  const r = await fetch(`http://127.0.0.1:${dep.PORT}/mkt/montar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ link, cupom: cupom || '' }),
  });
  return r.json();
}

async function previewOferta(chatId, s, editar) {
  s.passo = 'preview';
  const d = s.dados;
  const r = await montarOfertaPorLink(d.link, d.codigoCupom);
  if (!r.ok) {
    s.passo = 'link';
    return falar(chatId, '⚠️ Não consegui ler esse produto:\n`' + (r.erro || 'erro desconhecido') + '`\n\nMande outro link.',
      teclado([[['❌ Cancelar', 'a:cancelar']]]), editar);
  }
  d.mensagem  = r.mensagem;
  d.imagemUrl = r.produto?.imagemUrl || null;

  const linhas = [[['🚀 Enviar agora', 'a:enviar'], ['❌ Cancelar', 'a:cancelar']]];
  // Cupons da base que realmente abatem NESTE preco viram botao. O cupom nunca
  // entra sozinho: quem escolhe e o operador.
  const aplicaveis = (r.cupons || []).slice(0, 3);
  if (aplicaveis.length && !d.codigoCupom) {
    linhas.unshift(aplicaveis.map(c => [`🏷️ ${c.codigo} (-R$${c.descontoAplicado})`, 'o:cupom:' + c.codigo]));
  }
  const aviso = r.avisoCupom ? `\n\n⚠️ _${r.avisoCupom}_` : '';
  return falar(chatId,
    '*Prévia da oferta* 👇\n\n- - - - - - - - - -\n' + r.mensagem + '\n- - - - - - - - - -' + aviso,
    teclado(linhas), editar);
}

// ── FLUXO MENSAGEM LIVRE ─────────────────────────────────────────────────────
async function previewMsg(chatId, s, editar) {
  s.passo = 'preview';
  return falar(chatId,
    '*Prévia* 👇\n\n- - - - - - - - - -\n' + s.dados.mensagem + '\n- - - - - - - - - -',
    teclado([
      [['🚀 Enviar agora', 'a:enviar']],
      [['🔁 Refazer', 'a:refazer'], ['❌ Cancelar', 'a:cancelar']],
    ]), editar);
}

// ── ENVIO ────────────────────────────────────────────────────────────────────
async function enviarParaDestinos(mensagem) {
  const alvos = dep.radarDestinos();
  let ok = 0;
  for (const jid of alvos) {
    try { await dep.enviarMensagem(jid, { text: mensagem }); ok++; }
    catch (e) { console.warn('[BOT-TSP] Falha em ' + jid + ':', e.message); }
  }
  return { ok, total: alvos.length };
}

async function confirmarEnvio(chatId, s, acao, editar) {
  const d = s.dados;

  if (s.fluxo === 'cupom') {
    const c = dadosCupom(s);
    const ctx = { origem: 'bot-telegram', textoOriginal: '[criado no bot]', somenteFila: true };
    let r;
    try { r = await dep.enfileirarCupomTSP(c, ctx); }
    catch (e) { return falar(chatId, '⚠️ Erro ao registrar o cupom: ' + e.message, null, editar); }

    if (r?.ignorado) {
      // Duplicata: o gate existe para o monitoramento, nao para o operador. Ele
      // decide se manda mesmo assim — mas precisa saber que ja saiu antes.
      return falar(chatId, '⚠️ Esse cupom já foi capturado recentemente (duplicata).\n\nEnviar mesmo assim?',
        teclado([[['🚀 Enviar assim mesmo', 'a:forcar'], ['❌ Cancelar', 'a:cancelar']]]), editar);
    }

    if (acao === 'fila') {
      sessoes.delete(String(chatId));
      return falar(chatId, `📋 Cupom *#${r.oferta.id}* na fila.\n\nAprove em: https://davileles.github.io/tudo-sobre-promos/`, null, editar);
    }

    const res = await dep.enviarCupomParaGrupos(d.mensagem, null);
    if (r.oferta) { r.oferta.status = 'aprovada'; dep.salvarFila(); }
    sessoes.delete(String(chatId));
    return falar(chatId, `✅ Cupom enviado em *${res?.enviados?.length ?? '?'}* grupo(s).`, null, editar);
  }

  // Oferta e mensagem livre vao direto para os destinos do radar.
  const res = await enviarParaDestinos(d.mensagem);
  sessoes.delete(String(chatId));
  return falar(chatId, `✅ Enviado em *${res.ok}/${res.total}* grupo(s).`, null, editar);
}

// ── STATUS PARA O TELEGRAM ───────────────────────────────────────────────────
// Le o retrato injetado por dep.status() e monta uma mensagem curta e legivel
// para o operador conferir a saude do servidor do celular, sem abrir /status.
function formatarStatusBot(st) {
  st = st || {};
  const wa = st.conectado ? '🟢 conectado'
    : (st.logout ? '🔴 logout — precisa parear' : '🔴 desconectado');
  const surdez = (st.surdezEstado && st.surdezEstado !== 'ok') ? ('⚠️ ' + st.surdezEstado) : '🟢 ok';
  const tg = st.telegramConectado ? '🟢' : '🔴';
  const partes = [
    '*TSP — status do servidor* 📟',
    '',
    'WhatsApp: ' + wa,
    'Inbound: ' + surdez + (st.minSemUpsert != null ? (' (última msg há ' + st.minSemUpsert + ' min)') : ''),
    'Telegram: ' + tg,
    'Publicações hoje: ' + (st.publicacoesHoje != null ? st.publicacoesHoje : '?'),
    'Fila: ' + (st.filaTotal != null ? st.filaTotal : '?') + ' item(ns)'
      + (st.filaPendentes != null ? (' — ' + st.filaPendentes + ' pendente(s)') : ''),
    (st.logout && st.logoutMin != null) ? ('⚠️ Logout há ' + st.logoutMin + ' min — /pair ou /qr') : null,
    'Uptime: ' + (st.uptimeMin != null ? (st.uptimeMin + ' min') : '?'),
    '',
    '_Comandos:_ /reconectar · /pair · /menu',
  ].filter(Boolean);
  return partes.join('\n');
}

// ── ROTEADOR ─────────────────────────────────────────────────────────────────
function autorizado(chatId) {
  return ADMINS.size === 0 ? false : ADMINS.has(String(chatId));
}

const MENU = '*TSP — criação rápida* 🤖\n\nO que você quer criar?';
const MENU_KB = () => teclado([
  [['🏷️ Cupom', 'a:novo:cupom'], ['🛍️ Oferta', 'a:novo:oferta']],
  [['📢 Mensagem livre', 'a:novo:msg']],
]);

async function tratarTexto(chatId, texto) {
  const t = texto.trim();

  if (/^\/(start|menu)/i.test(t)) { sessoes.delete(String(chatId)); return falar(chatId, MENU, MENU_KB()); }
  if (/^\/cancelar/i.test(t))     { sessoes.delete(String(chatId)); return falar(chatId, 'Cancelado.', MENU_KB()); }
  if (/^\/cupom/i.test(t))  { const s = abrir(chatId, 'cupom');  s.passo = 'loja'; return pedirPassoCupom(chatId, s); }
  if (/^\/oferta/i.test(t)) { const s = abrir(chatId, 'oferta'); s.passo = 'link';
    return falar(chatId, '*Nova oferta* 🛍️\n\nMande o *link do produto* (Amazon, Mercado Livre, Shopee ou Magalu).',
      teclado([[['❌ Cancelar', 'a:cancelar']]])); }
  if (/^\/msg/i.test(t))    { const s = abrir(chatId, 'msg'); s.passo = 'texto';
    return falar(chatId, '*Mensagem livre* 📢\n\nEscreva o texto que vai para os grupos.',
      teclado([[['❌ Cancelar', 'a:cancelar']]])); }

  if (/^\/status/i.test(t)) {
    const st = (dep && dep.status) ? dep.status() : {};
    return falar(chatId, formatarStatusBot(st));
  }
  if (/^\/reconectar/i.test(t)) {
    return falar(chatId,
      '🔄 *Reconectar WhatsApp?*\n\nIsso derruba e reabre o socket. A captura para por alguns segundos e volta sozinha.',
      teclado([[['✅ Confirmar', 'a:reconectar:go'], ['❌ Cancelar', 'a:cancelar']]]));
  }

  const s = sessao(chatId);
  if (!s) return falar(chatId, MENU, MENU_KB());

  // ── entrada de texto por passo ──
  if (s.fluxo === 'msg' && s.passo === 'texto') { s.dados.mensagem = t; return previewMsg(chatId, s); }

  if (s.fluxo === 'oferta') {
    if (s.passo === 'link') {
      if (!/^https?:\/\//i.test(t)) return falar(chatId, 'Isso não parece um link. Mande a URL do produto.');
      s.dados.link = t;
      await falar(chatId, '⏳ Lendo o produto...');
      return previewOferta(chatId, s);
    }
  }

  if (s.fluxo === 'cupom') {
    switch (s.passo) {
      case 'loja':   s.dados.loja = t; break;
      case 'codigo': s.dados.codigo = t.toUpperCase(); break;
      case 'valor': {
        const v = num(t);
        if (v === null || v <= 0) return falar(chatId, 'Valor inválido. Digite só o número (ex: `15`).');
        s.dados.valor = v; break;
      }
      case 'minimo': { const v = num(t); if (v === null) return falar(chatId, 'Valor inválido.'); s.dados.minimo = v; break; }
      case 'limite': { const v = num(t); if (v === null) return falar(chatId, 'Valor inválido.'); s.dados.limite = v; break; }
      case 'maximo': { const v = num(t); if (v === null) return falar(chatId, 'Valor inválido.'); s.dados.maximo = v; break; }
      case 'gatilho': s.dados.gatilho = t; break;
      default: return;
    }
    s.passo = proximoPassoCupom(s);
    return pedirPassoCupom(chatId, s);
  }
}

async function tratarBotao(chatId, msgId, data) {
  const s = sessao(chatId);
  const [ns, chave, valor] = data.split(':');

  if (ns === 'a') {
    if (chave === 'novo') {
      const s2 = abrir(chatId, valor);
      if (valor === 'cupom')  { s2.passo = 'loja'; return pedirPassoCupom(chatId, s2, msgId); }
      if (valor === 'oferta') { s2.passo = 'link'; return falar(chatId, '*Nova oferta* 🛍️\n\nMande o *link do produto*.', teclado([[['❌ Cancelar', 'a:cancelar']]]), msgId); }
      s2.passo = 'texto';     return falar(chatId, '*Mensagem livre* 📢\n\nEscreva o texto.', teclado([[['❌ Cancelar', 'a:cancelar']]]), msgId);
    }
    if (chave === 'cancelar') { sessoes.delete(String(chatId)); return falar(chatId, 'Cancelado.', MENU_KB(), msgId); }
    if (chave === 'reconectar' && valor === 'go') {
      try { if (dep && dep.forcarReconexao) dep.forcarReconexao('bot-telegram'); }
      catch (e) { return falar(chatId, '❌ Falha ao disparar reconexão: ' + e.message, null, msgId); }
      return falar(chatId, '🔄 Reconexão disparada. Aguarde ~10s e mande /status para conferir.', null, msgId);
    }
    if (!s) return falar(chatId, 'Essa sessão expirou.', MENU_KB(), msgId);
    if (chave === 'refazer') {
      if (s.fluxo === 'cupom') { const s2 = abrir(chatId, 'cupom'); s2.passo = 'loja'; return pedirPassoCupom(chatId, s2, msgId); }
      s.passo = s.fluxo === 'oferta' ? 'link' : 'texto';
      return falar(chatId, 'Manda de novo.', teclado([[['❌ Cancelar', 'a:cancelar']]]), msgId);
    }
    if (chave === 'enviar' || chave === 'fila') return confirmarEnvio(chatId, s, chave, msgId);
    if (chave === 'forcar') {
      const res = await dep.enviarCupomParaGrupos(s.dados.mensagem, null);
      sessoes.delete(String(chatId));
      return falar(chatId, `✅ Enviado em *${res?.enviados?.length ?? '?'}* grupo(s).`, null, msgId);
    }
    return;
  }

  if (!s) return falar(chatId, 'Essa sessão expirou.', MENU_KB(), msgId);

  if (ns === 'o' && chave === 'cupom') { s.dados.codigoCupom = valor; return previewOferta(chatId, s, msgId); }

  if (ns === 'c') {
    const d = s.dados;
    switch (chave) {
      case 'loja':
        if (valor === '__outra') { s.passo = 'loja'; return falar(chatId, 'Digite o *nome da loja*.', teclado([[['❌ Cancelar', 'a:cancelar']]]), msgId); }
        d.loja = valor; break;
      case 'codigo': d.codigo = ''; break;
      case 'tipo':   d.tipo = valor; break;
      case 'minimo':
        if (valor === '__digitar') { s.passo = 'minimo'; return falar(chatId, 'Digite o *valor mínimo* em reais.', teclado([[['❌ Cancelar', 'a:cancelar']]]), msgId); }
        // Nos dois casos nao ha numero de minimo; o que muda e a frase que o
        // template escolhe (afirmar "sem minimo" x mandar conferir na loja).
        d.minimo = null;
        d.minimoDesconhecido = valor === '__desconhecido';
        break;
      case 'limite':
        if (valor === '__digitar') { s.passo = 'limite'; return falar(chatId, 'Digite o *teto de desconto* em reais.', teclado([[['❌ Cancelar', 'a:cancelar']]]), msgId); }
        d.limite = null; break;
      case 'maximo':
        if (valor === '__digitar') { s.passo = 'maximo'; return falar(chatId, 'Digite o *preço máximo do produto* em reais.', teclado([[['❌ Cancelar', 'a:cancelar']]]), msgId); }
        d.maximo = null; break;
      case 'gatilho':
        if (valor === '__digitar') { s.passo = 'gatilho'; return falar(chatId, 'Digite o *gatilho*.', teclado([[['❌ Cancelar', 'a:cancelar']]]), msgId); }
        d.gatilho = ''; break;
      default: return;
    }
    s.passo = chave;                    // passo que acabou de ser respondido
    s.passo = proximoPassoCupom(s);     // avanca a partir dele
    return pedirPassoCupom(chatId, s, msgId);
  }
}

// ── ENTRADA DO WEBHOOK ───────────────────────────────────────────────────────
export async function tratarUpdateBotTsp(update) {
  if (!TOKEN) return;
  try {
    if (update.callback_query) {
      const cq = update.callback_query;
      await tg('answerCallbackQuery', { callback_query_id: cq.id });
      const chatId = cq.message?.chat?.id;
      if (!autorizado(chatId)) return;
      return await tratarBotao(chatId, cq.message.message_id, cq.data || '');
    }
    const m = update.message;
    if (!m) return;
    const chatId = m.chat?.id;
    if (!autorizado(chatId)) {
      // Sem lista configurada ninguem opera — bot exposto seria disparo aberto.
      console.warn(`[BOT-TSP] Mensagem de chat nao autorizado: ${chatId}`);
      return void await tg('sendMessage', { chat_id: chatId, text: `Sem permissão. Seu ID: ${chatId}` });
    }
    if (m.text) return await tratarTexto(chatId, m.text);
  } catch (e) {
    console.error('[BOT-TSP] Erro no update:', e.message);
  }
}

// ── BOOT ─────────────────────────────────────────────────────────────────────
export async function bootBotTsp(deps) {
  dep = deps;
  if (!TOKEN) { console.log('[BOT-TSP] TELEGRAM_BOT_TOKEN ausente — bot desligado.'); return; }
  if (!ADMINS.size) console.warn('[BOT-TSP] TELEGRAM_BOT_ADMINS vazio — o bot vai recusar todo mundo.');

  const base = process.env.BOT_TSP_URL
    || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : '');
  if (!base) { console.warn('[BOT-TSP] Sem URL publica — defina BOT_TSP_URL para registrar o webhook.'); return; }

  const url = base.replace(/\/$/, '') + BOT_TSP_PATH;
  const d = await tg('setWebhook', { url, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true });
  console.log(d.ok ? `[BOT-TSP] Webhook registrado em ${url}` : `[BOT-TSP] Falha ao registrar webhook: ${d.description}`);

  await tg('setMyCommands', { commands: [
    { command: 'menu',     description: 'Abrir o menu' },
    { command: 'cupom',    description: 'Criar um cupom' },
    { command: 'oferta',   description: 'Criar uma oferta a partir de um link' },
    { command: 'msg',      description: 'Mensagem livre para os grupos' },
    { command: 'status',   description: 'Ver a saúde do servidor (WhatsApp, fila, publicações)' },
    { command: 'reconectar', description: 'Reconectar o WhatsApp (com confirmação)' },
    { command: 'cancelar', description: 'Cancelar o que está em andamento' },
  ]});
}
