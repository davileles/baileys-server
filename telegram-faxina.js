// ── FAXINA DIARIA DOS CHATS DOS BOTS DO TELEGRAM ─────────────────────────────
// Quando o dia vira (fuso de SP), tudo o que foi trocado no chat ate a meia-
// noite some: cards, recibos, previas, menus e o que o operador digitou. O que
// ainda espera decisao continua na fila do servidor e volta com /fila.
//
// A Bot API nao lista o historico de um chat, mas em chat privado o message_id
// e sequencial e compartilhado pelos dois lados. Por isso basta guardar, por
// dia, o MAIOR id visto em cada chat: na virada, apaga-se a faixa entre o fim
// da ultima faxina e o maior id de antes da meia-noite. Nada de lista de
// mensagens em disco.
//
// Regras:
// - espera o chat ficar 15 min parado antes de apagar — edicao ou wizard
//   aberto as 23:59 nao some no meio do uso;
// - o maior id por dia vai para disco em ./sessao, entao servidor fora do ar
//   na meia-noite faz a faxina atrasada no boot, sem apagar nada do dia novo;
// - o Telegram so apaga mensagem com menos de 48h. A faxina roda todo dia,
//   entao o que ela alcanca e sempre recente; lote recusado cai no um-a-um.
//
// Env: TG_FAXINA_DIARIA=off desliga (default: ligada).

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';

const LIGADA        = String(process.env.TG_FAXINA_DIARIA || 'on').toLowerCase() !== 'off';
const TZ            = 'America/Sao_Paulo';
const OCIOSO_MS     = 15 * 60 * 1000;
const TICK_MS       = 5 * 60 * 1000;
const LOTE          = 100;           // teto do deleteMessages
const ALCANCE_MAX   = 1000;          // ids por faxina — protege contra faixa absurda
const ALCANCE_1A    = 300;           // primeira faxina de um chat: nao se sabe onde o dia comecou
const DIAS_GUARDADOS = 3;
const DIR           = './sessao';

const fmtDia = new Intl.DateTimeFormat('en-CA', { timeZone: TZ });
const diaSP  = (ms = Date.now()) => fmtDia.format(new Date(ms));

export function criarFaxina({ nome, tg }) {
  const TAG     = '[FAXINA-' + nome + ']';
  const arquivo = DIR + '/tg-faxina-' + String(nome).toLowerCase() + '.json';

  // chatId -> { porDia: { 'YYYY-MM-DD': maiorId }, ultimoEm, limpoAte }
  let chats = {};
  let ultima = null;   // { em, chats, apagadas } — para o diagnostico

  try {
    if (existsSync(arquivo)) chats = JSON.parse(readFileSync(arquivo, 'utf-8')).chats || {};
  } catch (e) { console.warn(TAG + ' nao consegui ler ' + arquivo + ': ' + e.message); }

  let gravacao = null;
  function gravar() {
    if (gravacao) return;
    gravacao = setTimeout(() => {
      gravacao = null;
      try {
        if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
        writeFileSync(arquivo, JSON.stringify({ chats }));
      } catch (e) { console.warn(TAG + ' nao consegui gravar ' + arquivo + ': ' + e.message); }
    }, 5000);
    gravacao.unref?.();
  }

  // O dia e o de QUANDO o id foi visto, nao o `date` da mensagem: edicao
  // devolve a mensagem antiga, mas o id dela nunca supera o maior do dia.
  function anotar(chatId, msgId) {
    const id = Number(msgId);
    if (!LIGADA || !chatId || !Number.isFinite(id) || id <= 0) return;
    const k = String(chatId);
    const c = chats[k] || (chats[k] = { porDia: {}, ultimoEm: 0, limpoAte: 0 });
    const dia = diaSP();
    if (!c.porDia[dia] || id > c.porDia[dia]) c.porDia[dia] = id;
    c.ultimoEm = Date.now();
    gravar();
  }

  // Resultado de qualquer chamada da Bot API que devolva mensagem.
  function anotarResultado(d) {
    const r = d && d.ok && d.result;
    if (r && r.message_id && r.chat && r.chat.id) anotar(r.chat.id, r.message_id);
  }

  // Update recebido no webhook: mensagem digitada ou toque em botao.
  function anotarUpdate(update) {
    const m = update?.message || update?.callback_query?.message;
    if (m && m.chat) anotar(m.chat.id, m.message_id);
  }

  async function apagarFaixa(chatId, ids) {
    let apagadas = 0;
    for (let i = 0; i < ids.length; i += LOTE) {
      const lote = ids.slice(i, i + LOTE);
      const d = await tg('deleteMessages', { chat_id: chatId, message_ids: lote });
      if (d && d.ok) { apagadas += lote.length; continue; }
      // Lote recusado inteiro (ex.: um id acima de 48h no meio): um a um salva
      // o resto. Falha individual e irrelevante — id inexistente ou velho.
      for (const id of lote) {
        const u = await tg('deleteMessage', { chat_id: chatId, message_id: id });
        if (u && u.ok) apagadas++;
      }
    }
    return apagadas;
  }

  let rodando = false;
  async function faxinar() {
    if (!LIGADA || rodando) return;
    rodando = true;
    try {
      const hoje = diaSP();
      let tocados = 0, apagadas = 0;
      for (const [chatId, c] of Object.entries(chats)) {
        const diasVelhos = Object.keys(c.porDia).filter(d => d < hoje);
        if (!diasVelhos.length) continue;
        const marco = Math.max(...diasVelhos.map(d => c.porDia[d]));
        if (marco <= (c.limpoAte || 0)) { podar(c, hoje); continue; }
        if (Date.now() - (c.ultimoEm || 0) < OCIOSO_MS) continue;   // chat em uso: tenta no proximo tick

        const inicio = c.limpoAte
          ? Math.max(c.limpoAte + 1, marco - ALCANCE_MAX + 1)
          : Math.max(1, marco - ALCANCE_1A + 1);
        const ids = [];
        for (let id = inicio; id <= marco; id++) ids.push(id);
        apagadas += await apagarFaixa(chatId, ids);
        c.limpoAte = marco;
        podar(c, hoje);
        tocados++;
      }
      if (tocados) {
        // deleteMessages pula id inexistente sem avisar: o numero e da faixa
        // aceita, nao de mensagens que existiam.
        ultima = { em: new Date().toISOString(), chats: tocados, idsLimpos: apagadas };
        console.log(TAG + ' virada do dia: faixa de ' + apagadas + ' id(s) limpa em ' + tocados + ' chat(s).');
        gravar();
      }
    } catch (e) {
      console.warn(TAG + ' erro na faxina: ' + e.message);
    } finally {
      rodando = false;
    }
  }

  function podar(c, hoje) {
    const limite = diaSP(Date.now() - DIAS_GUARDADOS * 86400000);
    for (const d of Object.keys(c.porDia)) if (d < limite || (d < hoje && c.porDia[d] <= c.limpoAte)) delete c.porDia[d];
  }

  let timer = null;
  function iniciar() {
    if (!LIGADA || timer) return;
    timer = setInterval(faxinar, TICK_MS);
    timer.unref?.();
    // Faxina atrasada: servidor que estava fora na meia-noite.
    setTimeout(faxinar, 60 * 1000).unref?.();
  }

  const estado = () => ({ ligada: LIGADA, chats: Object.keys(chats).length, ultimaFaxina: ultima });

  return { anotar, anotarResultado, anotarUpdate, iniciar, faxinar, estado };
}
