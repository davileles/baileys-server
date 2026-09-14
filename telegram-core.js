// ── TRANSPORTE COMPARTILHADO DOS BOTS DO TELEGRAM ────────────────────────────
// Um servidor, varios bots. Cada bot tem token, admins e path de webhook
// proprios; o que eles compartilham e o encanamento: chamar a Bot API, montar
// teclado, escapar HTML, editar em vez de empilhar mensagem, registrar webhook.
//
// Nao ha regra de negocio aqui de proposito. Quem sabe o que e uma passagem ou
// uma oferta e o modulo do bot; este arquivo so sabe falar com o Telegram.
//
// O bot-tsp.js segue com a propria copia dessas funcoes — ele esta no ar e
// funcionando, e migra-lo agora misturaria uma mudanca de comportamento com
// uma de estrutura. Os bots NOVOS nascem aqui.

export function criarBot({ nome, token, secret, admins, urlBase }) {
  const TOKEN  = String(token || '');
  const TAG    = '[' + nome + ']';
  const ADMINS = new Set(
    String(admins || '').split(',').map(s => s.trim()).filter(Boolean)
  );
  const PATH = '/bot/' + secret;

  async function tg(metodo, body) {
    if (!TOKEN) return { ok: false, description: 'sem token' };
    try {
      const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${metodo}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (!d.ok) console.warn(`${TAG} ${metodo} falhou:`, d.description || r.status);
      return d;
    } catch (e) {
      console.warn(`${TAG} ${metodo} erro de rede:`, e.message);
      return { ok: false, description: e.message };
    }
  }

  // Escapa so o que o parse_mode HTML do Telegram trata como marcacao. Titulo
  // de oferta e post de grupo vem com & e < escritos por gente — sem isso o
  // Telegram RECUSA a mensagem inteira e o card simplesmente nao aparece.
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function teclado(linhas) {
    return {
      inline_keyboard: linhas.map(l => l.map(([texto, data]) => ({ text: texto, callback_data: data }))),
    };
  }

  // Uma unica funcao de saida: vindo de um botao, EDITA a mensagem em vez de
  // empilhar outra. O chat fica com um card so, que vai mudando de estado.
  async function falarHtml(chatId, texto, kb, editarMsgId) {
    const base = { chat_id: chatId, text: texto, parse_mode: 'HTML', disable_web_page_preview: true };
    if (kb) base.reply_markup = kb;
    if (editarMsgId) {
      const d = await tg('editMessageText', { ...base, message_id: editarMsgId });
      if (d.ok) return d.result;
      // "message is not modified" nao e falha: o card ja estava no estado certo.
      if (/not modified/i.test(d.description || '')) return null;
    }
    const d = await tg('sendMessage', base);
    return d.result || null;
  }

  // Sem parse_mode: usado para texto cru (erro, id do chat, lista de fila) em
  // que qualquer < do conteudo nao pode derrubar a mensagem.
  async function falarPlano(chatId, texto, kb, editarMsgId) {
    const base = { chat_id: chatId, text: texto, disable_web_page_preview: true };
    if (kb) base.reply_markup = kb;
    if (editarMsgId) {
      const d = await tg('editMessageText', { ...base, message_id: editarMsgId });
      if (d.ok) return d.result;
      if (/not modified/i.test(d.description || '')) return null;
    }
    const d = await tg('sendMessage', base);
    return d.result || null;
  }

  // O Telegram mostra o relogio no botao ate o callback ser respondido. Sem
  // isso o operador acha que o toque nao pegou e toca de novo.
  async function toast(callbackId, texto) {
    if (!callbackId) return;
    await tg('answerCallbackQuery', { callback_query_id: callbackId, text: texto || undefined });
  }

  const autorizado = (chatId) => ADMINS.has(String(chatId));

  // Manda o mesmo card para todos os admins. Um chat que falha nao pode
  // impedir a entrega nos outros.
  async function paraCadaAdmin(fn) {
    for (const chatId of ADMINS) {
      try { await fn(chatId); }
      catch (e) { console.warn(`${TAG} entrega em ${chatId} falhou: ${e.message}`); }
    }
  }

  async function bootWebhook(comandos) {
    if (!TOKEN) { console.log(`${TAG} token ausente — bot desligado.`); return false; }
    if (!ADMINS.size) console.warn(`${TAG} lista de admins vazia — o bot vai recusar todo mundo.`);

    const base = urlBase
      || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : '');
    if (!base) { console.warn(`${TAG} sem URL publica — webhook nao registrado.`); return false; }

    const url = base.replace(/\/$/, '') + PATH;
    const d = await tg('setWebhook', {
      url, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true,
    });
    console.log(d.ok ? `${TAG} webhook registrado em ${url}` : `${TAG} falha no webhook: ${d.description}`);
    if (comandos?.length) await tg('setMyCommands', { commands: comandos });
    return !!d.ok;
  }

  return {
    nome, TAG, ativo: !!TOKEN, path: PATH, admins: ADMINS,
    tg, esc, teclado, falarHtml, falarPlano, toast, autorizado, paraCadaAdmin, bootWebhook,
  };
}

// Corta texto longo sem partir uma entidade HTML ao meio: o corte e feito no
// texto CRU e o escape vem depois.
export function citacao(rotulo, texto, limite, compacto, esc) {
  let t = String(texto || '').trim();
  if (compacto) t = t.split('\n').filter(l => l.trim()).join('\n');
  if (!t) return '';
  const corte = t.length > limite ? t.slice(0, limite) + '\n[...]' : t;
  return '<b>' + rotulo + '</b>\n<blockquote>' + esc(corte) + '</blockquote>';
}
