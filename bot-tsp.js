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

const PASSOS_CUPOM = ['loja', 'codigo', 'tipo', 'valor', 'minimo', 'limite', 'maximo', 'restrito', 'gatilho', 'preview'];

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

    case 'restrito':
      // Cupom restrito nao pode entrar em oferta generica: o desconto anunciado
      // nao existiria no checkout do produto errado. O operador precisa dizer —
      // inferir pelo texto e exatamente o que da errado no radar.
      return falar(chatId, 'Esse cupom vale em *qualquer produto* da loja ou só numa *seleção específica*?', teclado([
        [['🛒 Qualquer produto', 'c:restrito:__nao']],
        [['🎯 Só produtos específicos', 'c:restrito:__sim']],
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
    restrito: d.restrito === true,
  };
}

async function previewCupom(chatId, s, editar) {
  s.passo = 'preview';
  let msg;
  try { msg = dep.formatarCupomTSP(dadosCupom(s)); }
  catch (e) { return falar(chatId, '⚠️ Erro ao montar a mensagem: ' + e.message, null, editar); }
  s.dados.mensagem = msg;
  const selo = s.dados.restrito === true
    ? '\n\n🎯 _Marcado como só produtos específicos: fica na base, mas fora da escolha automática, do combo “Cupons ativos” e do site público._'
    : '';
  return falar(chatId,
    '*Prévia da mensagem* 👇\n\n- - - - - - - - - -\n' + msg + '\n- - - - - - - - - -' + selo,
    teclado([
      [['🚀 Enviar agora', 'a:enviar'], ['📋 Mandar pra fila', 'a:fila']],
      [['🗂 Só cadastrar na base', 'a:base']],
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

// ── CUPONS DA BASE NOS BOTOES ────────────────────────────────────────────────
// Todos os cupons ATIVOS da loja viram botao, inclusive os que nao abatem o
// preco atual — filtrar por criterio escondia do operador cupom que existe na
// base, e ele so descobria abrindo o painel. Quem nao se aplica vem marcado no
// proprio rotulo; a escolha continua sendo sempre dele.
// Telegram aguenta teclado grande, mas 50+ botoes viram rolagem sem fim no
// celular. O corte fica em 30 e o que sobra continua alcancavel pelo passo
// "Digitar codigo" — nenhum cupom da base fica inacessivel por causa do limite.
const MAX_BOTOES_CUPOM = 30;

function valorCupomTxt(c) {
  return c.tipo === 'pct' ? (c.valor + '%') : ('R$ ' + c.valor);
}

function rotuloCupomBotao(c, escolhido) {
  const igual = escolhido && String(escolhido).toUpperCase() === String(c.codigo).toUpperCase();
  const detalhe = c.aplicavel === false
    ? ' · ' + valorCupomTxt(c) + (c.motivo ? ' (' + c.motivo + ')' : '')
    : ' (-R$ ' + c.descontoAplicado + ')';
  return (igual ? '✅ ' : '🏷️ ') + (c.restrito ? '🎯 ' : '') + c.codigo + detalhe;
}

function emLinhas(botoes, porLinha) {
  const linhas = [];
  for (let i = 0; i < botoes.length; i += porLinha) linhas.push(botoes.slice(i, i + porLinha));
  return linhas;
}

// Rotulo com motivo fica longo e o Telegram trunca sem aviso: quando ha algum
// cupom que nao abate, os botoes vao um por linha.
function linhasDeCupons(cupons, escolhido, prefixo) {
  const porLinha = cupons.some(c => c.aplicavel === false) ? 1 : 2;
  // QUEM entra no teclado ja foi decidido por desconto, la em cuponsAtivosDaLoja
  // (o corte precisa premiar o que abate mais). A ORDEM em que aparecem e outra
  // conversa: o operador procura pelo codigo que viu na loja, e varrer nomes
  // fora de ordem e mais lento do que ler um desconto ordenado. Alfabetica aqui,
  // como em todo select do ecossistema.
  const emOrdem = cupons.slice().sort((a, b) =>
    String(a.codigo).localeCompare(String(b.codigo), 'pt-BR', { numeric: true, sensitivity: 'base' }));
  return emLinhas(emOrdem.map(c => [rotuloCupomBotao(c, escolhido), prefixo + c.codigo]), porLinha);
}

// Recebe a lista COMPLETA da loja e quantos viraram botao: contar so os
// exibidos dizia "20 cupons ativos" quando havia 52 na base, e o operador
// concluia que o cupom que ele procurava nao tinha sido capturado.
function resumoCupons(cupons, mostrados) {
  if (!cupons.length) return 'Nenhum cupom ativo na base para esta loja.';
  const abatem  = cupons.filter(c => c.aplicavel !== false).length;
  const exibidos = mostrados == null ? cupons.length : mostrados;
  const ocultos = cupons.length - exibidos;
  return 'Cupons ativos na base para esta loja: *' + cupons.length + '*'
    + ' — ' + abatem + ' abate(m) este preço.'
    + (ocultos > 0
        ? '\nBotões: os *' + exibidos + '* de maior desconto. Os outros *' + ocultos
          + '* estão na base e entram por *🔎 Digitar código*.'
        : '');
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

  // Todos os cupons ativos da loja viram botao — os que nao abatem este preco
  // inclusive, marcados no rotulo. O cupom nunca entra sozinho: quem escolhe e
  // o operador, e ele pode trocar ou tirar a qualquer momento.
  const todos  = r.cuponsBase || r.cupons || [];
  const daBase = todos.slice(0, MAX_BOTOES_CUPOM);
  const linhas = daBase.length ? linhasDeCupons(daBase, d.codigoCupom, 'o:cupom:') : [];
  // Digitar codigo sempre disponivel: alcanca o cupom que ficou fora do corte e
  // tambem o que o operador viu na loja e ainda nao foi capturado.
  const extras = [['🔎 Digitar código', 'o:cupom:__digitar']];
  if (d.codigoCupom) extras.push(['🚫 Sem cupom', 'o:cupom:']);
  linhas.push(extras);
  linhas.push([['🚀 Enviar agora', 'a:enviar'], ['❌ Cancelar', 'a:cancelar']]);

  const aviso = r.avisoCupom ? `\n\n⚠️ _${r.avisoCupom}_` : '';
  return falar(chatId,
    '*Prévia da oferta* 👇\n\n- - - - - - - - - -\n' + r.mensagem + '\n- - - - - - - - - -' + aviso
    + '\n\n' + resumoCupons(todos, daBase.length),
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

    // "So cadastrar" nao passa pelo dedup nem marca o cupom como visto. O gate
    // de duplicata existe para impedir DISPARO repetido; aqui nao ha disparo, e
    // marcar como visto silenciaria uma captura futura do mesmo codigo num
    // grupo monitorado — o cupom ficaria na base sem nunca ter sido publicado.
    if (acao === 'base') {
      let reg;
      try { reg = await dep.cadastrarCupomBase(c); }
      catch (e) { return falar(chatId, '⚠️ Erro ao gravar na base: ' + e.message, null, editar); }
      sessoes.delete(String(chatId));
      return falar(chatId,
        '🗂 Cupom *' + (reg?.codigo || c.codigo || 'sem código') + '* gravado na base — '
        + 'não foi enviado e não entrou na fila.\n\n'
        + 'Loja: *' + c.loja + '*\n'
        + 'Vale até: ' + (reg?.validadeAte ? new Date(reg.validadeAte).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '24h')
        + (c.restrito ? '\n🎯 Só produtos específicos — não entra em oferta automática.' : ''),
        null, editar);
    }

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

// ── CARD DE REVISAO DE OFERTA DO RADAR ───────────────────────────────────────
// Oferta capturada de grupo monitorado chega aqui com a mensagem EXATA que
// sairia. Os botoes editam o ITEM DA FILA (persistido em disco pelo servidor),
// nunca a sessao: um redeploy do Railway no meio da revisao nao pode perder o
// ajuste, e o mesmo item continua valendo no painel web. A sessao so guarda
// "estou esperando o texto do campo X da oferta #N".

async function apiLocal(metodo, caminho, body) {
  const r = await fetch('http://127.0.0.1:' + dep.PORT + caminho, {
    method: metodo,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  return { ...d, http: r.status };
}

// Sem parse_mode: titulo de produto vem com *, _, [ e ~ escritos pelo vendedor,
// e Markdown malformado faz o Telegram RECUSAR a mensagem inteira — o card
// simplesmente nao apareceria, que e pior do que aparecer sem negrito.
async function falarPlano(chatId, texto, kb, editarMsgId) {
  const base = { chat_id: chatId, text: texto, disable_web_page_preview: true };
  if (kb) base.reply_markup = kb;
  if (editarMsgId) {
    const d = await tg('editMessageText', { ...base, message_id: editarMsgId });
    if (d.ok) return d.result;
  }
  const d = await tg('sendMessage', base);
  return d.result || null;
}

// Toast do Telegram: a confirmacao aparece sobre a tela e some sozinha. Antes o
// desfecho virava mensagem no chat, e a fileira de recibos ("enviada",
// "descartada", "na fila de publicacao") acabava competindo com os cards que
// ainda esperavam decisao — que e exatamente o que o operador rola para achar.
// O toast so vale nos ~15s seguintes ao toque; passou disso, some em silencio,
// e o card ter sumido ja e a confirmacao.
// Ultima mensagem de LISTA da fila, por chat. Serve para o desfecho saber se o
// card que esta encerrando nasceu de um push (mensagem propria, some) ou da
// lista (mensagem compartilhada, volta a ser lista).
const msgDaFila = new Map();

// Qual oferta cada mensagem de card esta mostrando: 'chatId:msgId' -> ofertaId.
// A limpeza usa isso para nao apagar card de item que ainda espera decisao.
// Memoria mesmo — reinicio esvazia, e ai a limpeza so poupa o que ela consegue
// provar que esta pendente. Nada se perde: o item continua na fila do servidor
// e volta ao chat pelo /fila.
const cardsAbertos = new Map();
const LIMITE_CARDS_ABERTOS = 400;

function registrarCard(chatId, msgId, ofertaId) {
  if (!chatId || !msgId || !ofertaId) return;
  cardsAbertos.set(String(chatId) + ':' + msgId, String(ofertaId));
  // Teto simples: Map preserva ordem de insercao, entao o primeiro e o mais
  // velho. Sem isso o mapa cresceria para sempre num processo de meses.
  while (cardsAbertos.size > LIMITE_CARDS_ABERTOS) {
    cardsAbertos.delete(cardsAbertos.keys().next().value);
  }
}

function contextoCallback(cqId) {
  return {
    cqId, respondido: false,
    async toast(texto) {
      if (this.respondido || !this.cqId) return;
      this.respondido = true;
      const p = { callback_query_id: this.cqId };
      // O Telegram corta em 200 caracteres e recusa o que passar disso.
      if (texto) { p.text = String(texto).slice(0, 190); p.show_alert = false; }
      try { await tg('answerCallbackQuery', p); } catch (e) { /* toast e cosmetico */ }
    },
  };
}

// Card resolvido sai do chat sem deixar rastro: o que sobra na conversa e so o
// que ainda espera decisao. O desfecho vai no toast; o historico completo, com
// status de cada item, continua na fila e no painel.
// deleteMessage so vale para mensagem com menos de 48h; card mais velho cai no
// fallback de editar no lugar, que ao menos tira os botoes e encolhe o card
// para uma linha.
async function encerrarCard(chatId, msgId, desfecho, ctx) {
  if (ctx) await ctx.toast(desfecho);
  if (!msgId) return null;
  // Card aberto A PARTIR da lista reusa a mensagem da lista: apagar levaria
  // junto a fila que o operador esta percorrendo e o proximo item exigiria
  // /fila de novo. Ali a mensagem volta a ser a lista, ja sem o item resolvido.
  if (msgDaFila.get(String(chatId)) === msgId) return mostrarFila(chatId, msgId);
  const d = await tg('deleteMessage', { chat_id: chatId, message_id: msgId });
  if (d.ok) return null;
  return falarPlano(chatId, desfecho, null, msgId);
}

// A bolha com o valor que o operador digitou ("38,68") perde todo o contexto no
// instante em que o card e remontado: o card volta editado no lugar de sempre e
// o numero solto fica no historico, sobrevivendo ate ao descarte da oferta. Some
// assim que o valor e consumido. Em chat privado o bot pode apagar mensagem
// RECEBIDA; falhar aqui e irrelevante — no maximo a bolha continua ali e o
// /limpar leva depois.
async function apagarEntrada(chatId, msgId) {
  if (!msgId) return;
  try { await tg('deleteMessage', { chat_id: chatId, message_id: msgId }); }
  catch (e) { /* apagar a entrada e cosmetico */ }
}

// Id, preco e um pedaco do titulo bastam para reconhecer o item depois. O card
// inteiro nao volta: quem quiser o detalhe abre a fila.
function reciboCard(o, desfecho) {
  const d = (o && o.dados) || {};
  const partes = ['#' + (o && o.id), brlCurto(d.precoFinal ?? d.preco), String(d.titulo || '').slice(0, 40)];
  return desfecho + ' ' + partes.filter(Boolean).join(' · ');
}

// sendMessage corta em 4096. O card agora carrega DUAS mensagens (a nossa e a
// do grupo-fonte), entao cada uma tem teto proprio e a soma com o cabecalho
// fica com folga abaixo do limite — estourar faz o Telegram recusar o card
// inteiro, que e pior do que truncar.
const LIMITE_PREVIA   = 2200;
const LIMITE_ORIGINAL = 800;

function cabecalhoCard(o) {
  const d = o.dados || {};
  const linha = ['🛍️ #' + o.id, d.loja || '?'];
  if (o.grupoOrigemNome) linha.push('via ' + o.grupoOrigemNome);

  // Os mesmos motivos que seguram a oferta na fila aparecem no card: sem eles o
  // operador aprovaria pelo celular sem saber por que ela nao auto-enviou.
  const avisos = [];
  // Por que parou aqui vem antes de tudo: e a pergunta que o operador faz ao
  // abrir o card. Os detalhes abaixo explicam; esta linha responde.
  // Com o auto-envio de oferta em 'off' TODA captura para na fila pelo mesmo
  // motivo: a linha viraria carimbo em 100% dos cards e nao informaria nada.
  // Os motivos que sao excecao — falha no envio, cupom fora da base, preco
  // divergente — continuam aparecendo, porque ali o operador precisa saber.
  if (o.motivoFila && !/auto-envio desligado/i.test(o.motivoFila)) {
    avisos.push('🛑 Retida: ' + o.motivoFila);
  }
  if (o.cupomForaDaBase)   avisos.push('⚠️ o post cita cupom que nao esta na base');
  if (o.cupomAmbiguo)      avisos.push('⚠️ o post cita cupons de outro bloco');
  if (o.precoDivergente)   avisos.push('⚠️ o post anuncia R$ ' + o.precoDivergente.declarado
                                     + ' e calculamos R$ ' + o.precoDivergente.calculado);
  if (d.precoDeReferencia) avisos.push('⚠️ preco veio do TEXTO do grupo, nao da loja');
  if (o.ajustes)           avisos.push('✏️ ajustado: ' + Object.keys(o.ajustes).join(', '));
  // De/por explicitos no topo: a mensagem formatada abaixo mostra os dois, mas
  // misturados com emoji e template — aqui o operador confere de relance.
  const dePor = [d.precoDe ? 'de ' + brlCurto(d.precoDe) : null,
                 d.preco   ? 'por ' + brlCurto(d.preco)  : null,
                 // Cupom que nao abate — porque o PRECO POR foi digitado a mao e ja
                 // e o valor final — repetiria o mesmo numero do 'por'. Ali vale
                 // mostrar o codigo e dizer que o valor esta fechado.
                 d.cupom?.codigo
                   ? (Number(d.precoFinal) < Number(d.preco)
                       ? 'c/ cupom ' + brlCurto(d.precoFinal)
                       : 'cupom ' + d.cupom.codigo + ' (preço já final)')
                   : null].filter(Boolean);
  if (dePor.length) avisos.push('💲 ' + dePor.join(' · ') + (d.desconto ? '  (-' + d.desconto + '%)' : ''));
  return linha.join(' · ') + (avisos.length ? '\n' + avisos.join('\n') : '');
}

// Post exatamente como chegou no grupo monitorado. Vem depois da nossa versao
// de proposito: o que vai ao ar e a primeira coisa a conferir; o original e a
// referencia para decidir se a traducao ficou fiel.
function blocoOriginal(o) {
  const t = String(o.conteudoOriginal || '').trim();
  if (!t) return '';
  const corte = t.length > LIMITE_ORIGINAL ? t.slice(0, LIMITE_ORIGINAL) + '\n[...]' : t;
  return '\n\n📥 Post original'
    + (o.grupoOrigemNome ? ' · ' + o.grupoOrigemNome : '')
    + '\n- - - - - - - - - -\n' + corte + '\n- - - - - - - - - -';
}

function corpoCard(o, extra) {
  const msg = String(o.mensagemFormatada || '');
  const previa = msg.length > LIMITE_PREVIA ? msg.slice(0, LIMITE_PREVIA) + '\n[...]' : msg;
  return cabecalhoCard(o) + '\n\n- - - - - - - - - -\n' + previa + '\n- - - - - - - - - -'
    + blocoOriginal(o)
    + (extra ? '\n\n' + extra : '');
}

function tecladoCard(id) {
  return teclado([
    [['🚀 Enviar agora', 'r:enviar:' + id]],
    [['💲 Preço por', 'r:preco:' + id], ['🔖 Preço de', 'r:precode:' + id]],
    [['✏️ Título', 'r:titulo:' + id], ['🏷️ Cupom', 'r:cupom:' + id]],
    [['🔝 Topo', 'r:topo:' + id], ['⚠️ Importante', 'r:importante:' + id]],
    [['🔄 Atualizar', 'r:ver:' + id], ['🗑️ Descartar', 'r:descartar:' + id]],
    [['📋 Voltar à fila', 'r:fila:0']],
  ]);
}

function brlCurto(v) {
  return v == null ? '' : 'R$ ' + Number(v).toFixed(2).replace('.', ',');
}

// Rotulo do botao: o Telegram trunca sem aviso, entao o que importa (id e
// preco) vem antes do titulo.
function rotuloItemFila(i) {
  const partes = ['#' + i.id, brlCurto(i.precoFinal), String(i.titulo || '').slice(0, 30)];
  return partes.filter(Boolean).join(' · ')
    + (i.falhou ? ' 🛑' : i.aviso ? ' ⚠️' : '') + (i.ajustado ? ' ✏️' : '');
}

async function mostrarFila(chatId, msgId) {
  const r = await apiLocal('GET', '/mkt/fila');
  if (!r.ok) return falarPlano(chatId, '❌ Não consegui ler a fila: ' + (r.erro || r.http), null, msgId);
  const itens = r.itens || [];
  let res;
  if (!itens.length) {
    res = await falarPlano(chatId, '📋 Nenhuma oferta de produto pendente na fila.',
      teclado([[['🔄 Atualizar', 'r:fila:0']]]), msgId);
  } else {
    const linhas = itens.map(i => [[rotuloItemFila(i), 'r:ver:' + i.id]]);
    linhas.push([['🔄 Atualizar', 'r:fila:0']]);
    const cabec = '📋 Ofertas de produto pendentes: ' + r.total
      + (r.total > itens.length ? ' (mostrando as ' + itens.length + ' mais recentes)' : '')
      + '\n🛑 = envio falhou · ⚠️ = exige atenção · ✏️ = já ajustada';
    res = await falarPlano(chatId, cabec, teclado(linhas), msgId);
  }
  const alvo = res?.message_id || msgId;
  if (alvo) msgDaFila.set(String(chatId), alvo);
  return res;
}

// ── LIMPEZA DO CHAT ──────────────────────────────────────────────────────────
// O Telegram nao deixa um bot LER o historico do proprio chat: nao ha como
// perguntar "quais mensagens ainda estao ai". So da para apagar por id. Entao a
// limpeza varre para tras a partir do id da mensagem de confirmacao e manda
// apagar em bloco — o Telegram pula sozinho o que nao existe mais ou nao pode
// apagar (a API so remove mensagem com menos de 48h).
//
// O que escapa da varredura: a lista da fila em uso e os cards de ofertas que
// AINDA estao pendentes. O resto — recibos de enviada/descartada, previews,
// menus, comandos digitados — some.
const LIMPEZA_ALCANCE = 500;   // mensagens para tras
const LIMPEZA_LOTE    = 100;   // teto do deleteMessages

async function limparChat(chatId, msgId, ctx) {
  const r = await apiLocal('GET', '/mkt/fila');
  const pendentes = new Set((r.itens || []).map(i => String(i.id)));

  const preservar = new Set();
  const daFila = msgDaFila.get(String(chatId));
  if (daFila) preservar.add(Number(daFila));
  for (const [chave, ofertaId] of cardsAbertos) {
    const corte = chave.lastIndexOf(':');
    if (chave.slice(0, corte) !== String(chatId)) continue;
    if (pendentes.has(ofertaId)) preservar.add(Number(chave.slice(corte + 1)));
  }

  const ids = [];
  const piso = Math.max(1, msgId - LIMPEZA_ALCANCE);
  for (let i = msgId; i >= piso; i--) if (!preservar.has(i)) ids.push(i);

  let lotesOk = 0, individual = false;
  for (let i = 0; i < ids.length; i += LIMPEZA_LOTE) {
    const lote = ids.slice(i, i + LIMPEZA_LOTE);
    const d = await tg('deleteMessages', { chat_id: chatId, message_ids: lote });
    if (d.ok) { lotesOk++; continue; }
    // deleteMessages e da Bot API 7.0. Se este servidor falar com uma API mais
    // velha, o um-a-um cobre pelo menos o passado recente, que e o que enche a
    // tela. Sem isso a limpeza falharia inteira e em silencio.
    individual = true;
    for (const id of lote.slice(0, 60)) {
      await tg('deleteMessage', { chat_id: chatId, message_id: id });
    }
    // Um lote a um por vez ja custa 60 chamadas e segura o webhook. O passado
    // recente e o que enche a tela; o resto fica para um segundo /limpar.
    break;
  }

  const nota = preservar.size
    ? '🧹 Chat limpo. Mantive ' + preservar.size + ' mensagem(ns) do que ainda espera decisão.'
    : '🧹 Chat limpo.';
  if (ctx) await ctx.toast(nota);
  // Sem lote nenhum aceito e sem fallback: o silencio pareceria sucesso.
  if (!lotesOk && !individual) {
    return falarPlano(chatId, '⚠️ Não consegui apagar nada. O Telegram só deixa o bot remover mensagens com menos de 48h — as mais antigas precisam do "Limpar histórico" do próprio app.',
      teclado([[['📋 Fila', 'r:fila:0']]]));
  }
  return null;
}

/** Chamado pelo server.js quando uma oferta de produto entra na fila. */
export async function enviarCardRevisaoTelegram(oferta) {
  if (!TOKEN || !ADMINS.size || !dep) return;
  const r = await apiLocal('GET', '/mkt/oferta/' + oferta.id);
  if (!r.ok) { console.warn('[BOT-TSP] Oferta #' + oferta.id + ' sem card: ' + (r.erro || r.http)); return; }
  for (const chatId of ADMINS) {
    try {
      const m = await falarPlano(chatId, corpoCard(r.oferta), tecladoCard(r.oferta.id));
      registrarCard(chatId, m?.message_id, r.oferta.id);
    }
    catch (e) { console.warn('[BOT-TSP] Card #' + oferta.id + ' nao chegou em ' + chatId + ': ' + e.message); }
  }
}

async function aplicarAjuste(chatId, msgId, id, ov) {
  registrarCard(chatId, msgId, id);
  const r = await apiLocal('POST', '/mkt/remontar/' + id, ov);
  if (!r.ok) {
    const atual = await apiLocal('GET', '/mkt/oferta/' + id);
    return falarPlano(chatId,
      (atual.ok ? corpoCard(atual.oferta) + '\n\n' : '') + '❌ ' + (r.erro || 'falha ao remontar'),
      atual.ok ? tecladoCard(id) : null, msgId);
  }
  return falarPlano(chatId, corpoCard(r.oferta, r.aviso ? '⚠️ ' + r.aviso : ''), tecladoCard(id), msgId);
}

async function tratarRevisao(chatId, msgId, partes, ctx) {
  const acao = partes[1];
  const id   = partes[2];

  // Unica acao da familia 'r:' que nao age sobre um item: sai antes da leitura.
  if (acao === 'fila') return mostrarFila(chatId, msgId);

  // Sempre reler antes de agir: o item pode ter sido aprovado no painel web ou
  // varrido pela limpeza da fila desde que o card foi desenhado.
  const rr = await apiLocal('GET', '/mkt/oferta/' + id);
  if (!rr.ok) return encerrarCard(chatId, msgId, '⚠️ #' + id + ' saiu da fila (resolvida em outro lugar ou expirada).', ctx);
  const o = rr.oferta;
  if (o.status !== 'pendente') {
    return encerrarCard(chatId, msgId, reciboCard(o, '✔️ Já resolvida (' + o.status + '):'), ctx);
  }

  if (acao === 'ver') { registrarCard(chatId, msgId, id); return falarPlano(chatId, corpoCard(o), tecladoCard(id), msgId); }

  if (acao === 'enviar') {
    // Tira os botoes ANTES do await: o envio com espacamento entre grupos leva
    // segundos, e um segundo toque duplicaria a mensagem nos grupos.
    await falarPlano(chatId, corpoCard(o, '⏳ Enviando...'), null, msgId);
    // naoEsperar: aprovar cinco seguidas nao pode pendurar cinco requisicoes ate
    // o portao liberar cada uma. Com fila, o servidor confirma na hora e publica
    // depois; o toque em 🔄 Atualizar mostra o desfecho.
    const env = await apiLocal('POST', '/painel/aprovar/' + id, { naoEsperar: true });
    if (!env.ok) return falarPlano(chatId, corpoCard(o, '❌ Falha no envio: ' + (env.erro || env.http)), tecladoCard(id), msgId);
    if (env.naFila) {
      const min = Math.round((env.esperaSeg || 0) / 60);
      const quando = (env.esperaSeg || 0) < 90 ? 'em instantes' : 'em ~' + min + ' min';
      // Aprovada e aprovada: o card sai do chat mesmo esperando o portao, senao
      // com o ritmo ligado quase nada some — o que torna a limpeza inutil.
      // Quem quiser acompanhar o desfecho abre /fila; deixar um botao para isso
      // devolvia ao chat a linha que a limpeza acabou de tirar.
      return encerrarCard(chatId, msgId,
        reciboCard(o, '🕒 Na fila de publicação (' + env.posicao + 'º, sai ' + quando + '):'), ctx);
    }
    return encerrarCard(chatId, msgId, reciboCard(o, '✅ Enviada em ' + (env.enviados ?? '?') + ' grupo(s):'), ctx);
  }

  if (acao === 'descartar') {
    const d = await apiLocal('POST', '/painel/rejeitar/' + id, {});
    // Falha mantem o card COM botoes: sem eles o item segue pendente na fila e
    // o operador fica sem forma de tentar de novo pelo celular.
    if (!d.ok) return falarPlano(chatId, corpoCard(o, '❌ Falha ao descartar: ' + (d.erro || d.http)), tecladoCard(id), msgId);
    return encerrarCard(chatId, msgId, reciboCard(o, '🗑️ Descartada:'), ctx);
  }

  if (acao === 'preco' || acao === 'precode' || acao === 'titulo' || acao === 'topo' || acao === 'importante') {
    const s = abrir(chatId, 'revisao');
    s.passo = acao; s.ofertaId = id; s.msgId = msgId;
    // O valor atual vai junto da pergunta: sem ele o operador digita no escuro
    // e nao percebe que ja estava certo.
    const d = o.dados || {};
    const pergunta = acao === 'preco'
        ? 'Digite o PREÇO POR — o valor com desconto, o que o cliente paga.\nHoje: ' + (brlCurto(d.preco) || 'sem preço') + '\n(só o número, ex: 149,90)'
      : acao === 'precode'
        ? 'Digite o PREÇO DE — o valor cheio, que sai riscado.\nHoje: ' + (brlCurto(d.precoDe) || 'sem preço de') + '\n(só o número, ex: 249,90)'
      : acao === 'titulo' ? 'Digite o novo TÍTULO do produto.'
      : acao === 'importante'
        ? 'Digite o texto da linha *IMPORTANTE*.\nHoje: ' + ((d.importante || '').trim() || 'vazia (a linha não sai)')
          + '\n(é escrita por você — não é calculada)'
                          : 'Digite a MENSAGEM DE TOPO (a chamada que abre a oferta).';
    const linhas = [];
    if (acao === 'topo')    linhas.push([['Sem topo', 'r:semtopo:' + id]]);
    if (acao === 'importante') linhas.push([['Sem importante', 'r:semimport:' + id]]);
    if (acao === 'precode') linhas.push([['Sem preço de', 'r:sempde:' + id]]);
    linhas.push([['⬅️ Voltar', 'r:ver:' + id]]);
    return falarPlano(chatId, cabecalhoCard(o) + '\n\n' + pergunta, teclado(linhas), msgId);
  }

  if (acao === 'semtopo') {
    sessoes.delete(String(chatId));
    return aplicarAjuste(chatId, msgId, id, { gatilho: '' });
  }

  if (acao === 'semimport') {
    sessoes.delete(String(chatId));
    return aplicarAjuste(chatId, msgId, id, { importante: '' });
  }

  if (acao === 'sempde') {
    sessoes.delete(String(chatId));
    return aplicarAjuste(chatId, msgId, id, { precoDe: '' });
  }

  if (acao === 'cupom') {
    const cupons = rr.cupons || [];
    const atual  = o.dados?.cupom?.codigo || '';
    // Mesmo corte da previa por link: viram botao os de maior desconto, e o
    // resumo conta a lista INTEIRA. Quem fica de fora — inclusive o cupom que
    // nao abate ESTE preco, que a ordenacao joga para o fim — segue alcancavel
    // por "Digitar codigo", entao nenhum cupom da base fica inacessivel aqui.
    const daBase = cupons.slice(0, MAX_BOTOES_CUPOM);
    const linhas = daBase.length ? linhasDeCupons(daBase, atual, 'r:cup:' + id + ':') : [];
    linhas.push([['🔎 Digitar código', 'r:cupdig:' + id]]);
    linhas.push([['🚫 Sem cupom', 'r:cup:' + id + ':'], ['⬅️ Voltar', 'r:ver:' + id]]);
    return falarPlano(chatId, cabecalhoCard(o) + '\n\n' + resumoCupons(cupons, daBase.length),
      teclado(linhas), msgId);
  }

  if (acao === 'cupdig') {
    const s = abrir(chatId, 'revisao');
    s.passo = 'cupomcodigo'; s.ofertaId = id; s.msgId = msgId;
    return falarPlano(chatId, cabecalhoCard(o)
      + '\n\nDigite o *CÓDIGO* do cupom.\nHoje: ' + ((o.dados?.cupom?.codigo || '').trim() || 'sem cupom')
      + '\n(vale qualquer cupom da base, inclusive os que não abatem este preço — o aviso aparece na remontagem)',
      teclado([[['⬅️ Voltar', 'r:cupom:' + id]]]), msgId);
  }

  if (acao === 'cup') {
    // Codigo com ':' e improvavel, mas o join evita truncar em silencio.
    return aplicarAjuste(chatId, msgId, id, { cupom: partes.slice(3).join(':') });
  }
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
    'Entregas hoje: ' + (st.publicacoesHoje != null ? st.publicacoesHoje : '?') + ' msg em grupos'
      + (st.despachosHoje != null ? (' · ' + st.despachosHoje + ' despacho(s)') : ''),
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
  [['📋 Fila de aprovação', 'r:fila:0']],
]);

async function tratarTexto(chatId, texto, msgEntrada) {
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

  if (/^\/fila/i.test(t)) { sessoes.delete(String(chatId)); return mostrarFila(chatId); }

  if (/^\/limpar/i.test(t)) {
    sessoes.delete(String(chatId));
    return falar(chatId,
      '*Limpar a conversa?* 🧹\n\nApaga as mensagens já resolvidas — recibos, prévias, menus e comandos.\n\n'
      + 'Os cards de ofertas que ainda esperam decisão ficam. Se algum sumir, ele volta em */fila* — nada sai da fila do servidor.\n\n'
      + '_O Telegram só deixa apagar mensagem com menos de 48h._',
      teclado([[['🧹 Limpar', 'a:limpar:go'], ['❌ Cancelar', 'a:cancelar']]]));
  }

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
  if (s.fluxo === 'revisao') {
    let ov = null;
    if (s.passo === 'preco') {
      const v = num(t);
      if (v === null || v <= 0) return falar(chatId, 'Preço inválido. Digite só o número (ex: `149,90`).');
      ov = { preco: v };
    } else if (s.passo === 'precode') {
      const v = num(t);
      if (v === null || v < 0) return falar(chatId, 'Preço inválido. Digite só o número (ex: `249,90`) ou toque em *Sem preço de*.');
      ov = { precoDe: v };
    } else if (s.passo === 'titulo') ov = { titulo: t };
    else if (s.passo === 'topo')     ov = { gatilho: t };
    else if (s.passo === 'importante') ov = { importante: t };
    else if (s.passo === 'cupomcodigo') {
      // Validacao de existencia/vigencia fica no /mkt/remontar, que devolve
      // aviso para codigo fora da base, vencido ou que nao abate este preco.
      // Aqui so barra o que nem parece codigo. Mesma regra da previa por link.
      const cod = t.trim().toUpperCase().replace(/\s+/g, '');
      if (!/^[A-Z0-9._-]{2,40}$/.test(cod)) {
        return falar(chatId, 'Código inválido. Mande só o código, sem espaços (ex: `DESCONTAO`).');
      }
      ov = { cupom: cod };
    }
    if (!ov) return;
    const { ofertaId, msgId } = s;
    sessoes.delete(String(chatId));
    // Antes de remontar: o remontar leva alguns segundos e a bolha ficaria na
    // tela todo esse tempo. Valor recusado acima nao chega aqui — ali a bolha
    // fica de proposito, ao lado do aviso de invalido.
    await apagarEntrada(chatId, msgEntrada);
    return aplicarAjuste(chatId, msgId, ofertaId, ov);
  }

  if (s.fluxo === 'msg' && s.passo === 'texto') { s.dados.mensagem = t; return previewMsg(chatId, s); }

  if (s.fluxo === 'oferta') {
    if (s.passo === 'link') {
      if (!/^https?:\/\//i.test(t)) return falar(chatId, 'Isso não parece um link. Mande a URL do produto.');
      s.dados.link = t;
      await falar(chatId, '⏳ Lendo o produto...');
      return previewOferta(chatId, s);
    }
    // Codigo na mao: a validacao fica no /mkt/montar, que ja devolve avisoCupom
    // para codigo fora da base, vencido ou que nao abate este preco. A previa
    // mostra o aviso e o operador decide — mesma regra dos botoes.
    if (s.passo === 'cupomcodigo') {
      const cod = t.trim().toUpperCase().replace(/\s+/g, '');
      if (!/^[A-Z0-9._-]{2,40}$/.test(cod)) {
        return falar(chatId, 'Código inválido. Mande só o código, sem espaços (ex: `MELIMAISPOSDD`).');
      }
      s.dados.codigoCupom = cod;
      await falar(chatId, '⏳ Remontando a oferta...');
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

async function tratarBotao(chatId, msgId, data, ctx) {
  const partes = data.split(':');
  // Revisao de oferta da fila: ancorada no id do item, nao na sessao — o card
  // continua funcionando depois de um redeploy ou dias depois.
  if (partes[0] === 'r') return tratarRevisao(chatId, msgId, partes, ctx);

  const s = sessao(chatId);
  const [ns, chave, valor] = partes;

  if (ns === 'a') {
    if (chave === 'novo') {
      const s2 = abrir(chatId, valor);
      if (valor === 'cupom')  { s2.passo = 'loja'; return pedirPassoCupom(chatId, s2, msgId); }
      if (valor === 'oferta') { s2.passo = 'link'; return falar(chatId, '*Nova oferta* 🛍️\n\nMande o *link do produto*.', teclado([[['❌ Cancelar', 'a:cancelar']]]), msgId); }
      s2.passo = 'texto';     return falar(chatId, '*Mensagem livre* 📢\n\nEscreva o texto.', teclado([[['❌ Cancelar', 'a:cancelar']]]), msgId);
    }
    if (chave === 'cancelar') { sessoes.delete(String(chatId)); return falar(chatId, 'Cancelado.', MENU_KB(), msgId); }
    if (chave === 'limpar' && valor === 'go') return limparChat(chatId, msgId, ctx);
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
    if (chave === 'enviar' || chave === 'fila' || chave === 'base') return confirmarEnvio(chatId, s, chave, msgId);
    if (chave === 'forcar') {
      const res = await dep.enviarCupomParaGrupos(s.dados.mensagem, null);
      sessoes.delete(String(chatId));
      return falar(chatId, `✅ Enviado em *${res?.enviados?.length ?? '?'}* grupo(s).`, null, msgId);
    }
    return;
  }

  if (!s) return falar(chatId, 'Essa sessão expirou.', MENU_KB(), msgId);

  if (ns === 'o' && chave === 'cupom') {
    if (valor === '__digitar') {
      s.passo = 'cupomcodigo';
      return falar(chatId,
        'Digite o *código do cupom*.\n\nVale qualquer cupom vigente da base desta loja — inclusive os que não couberam nos botões.',
        teclado([[['❌ Cancelar', 'a:cancelar']]]), msgId);
    }
    s.dados.codigoCupom = valor;
    return previewOferta(chatId, s, msgId);
  }

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
      case 'restrito':
        d.restrito = valor === '__sim'; break;
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
      const ctx = contextoCallback(cq.id);
      const chatId = cq.message?.chat?.id;
      if (!autorizado(chatId)) return void await ctx.toast();
      // Toque que resolve o item guarda a resposta para o fim: e nela que vai o
      // desfecho. Os demais respondem ja, senao o botao fica girando enquanto o
      // servidor remonta a mensagem.
      if (!/^(r:(enviar|descartar):|a:limpar:go)/.test(cq.data || '')) await ctx.toast();
      try {
        return await tratarBotao(chatId, cq.message.message_id, cq.data || '', ctx);
      } finally {
        // Rede de seguranca: caminho que nao encerrou card nenhum ainda precisa
        // desligar o relogio do botao.
        await ctx.toast();
      }
    }
    const m = update.message;
    if (!m) return;
    const chatId = m.chat?.id;
    if (!autorizado(chatId)) {
      // Sem lista configurada ninguem opera — bot exposto seria disparo aberto.
      console.warn(`[BOT-TSP] Mensagem de chat nao autorizado: ${chatId}`);
      return void await tg('sendMessage', { chat_id: chatId, text: `Sem permissão. Seu ID: ${chatId}` });
    }
    if (m.text) return await tratarTexto(chatId, m.text, m.message_id);
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
    { command: 'fila',     description: 'Ofertas de produto esperando decisão' },
    { command: 'limpar',   description: 'Apagar do chat o que já foi aprovado ou descartado' },
    { command: 'status',   description: 'Ver a saúde do servidor (WhatsApp, fila, publicações)' },
    { command: 'reconectar', description: 'Reconectar o WhatsApp (com confirmação)' },
    { command: 'cancelar', description: 'Cancelar o que está em andamento' },
  ]});
}
