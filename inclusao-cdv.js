// ── INCLUSÃO DE EX-ALUNOS NOS GRUPOS DO CDV PELO WHATSAPP (desde 18/11/2026) ──
// Quem saiu (ou foi removido) dos grupos do Clube do Viajante não consegue voltar
// pelo link: o WhatsApp só deixa voltar por inclusão de admin. O Davi deixa um
// link wa.me para o número do CDV (tico-02, `config.conta`) com a mensagem pronta
// "Quero entrar nos grupos do Clube do Viajante". A frase abre esta conversa:
//
//  1. o telefone que está conversando é o que entra nos grupos. O proxy
//     (`POST /cdv/inclusao/consultar`) diz a que grupos ele tem direito, com as
//     mesmas regras da auditoria/remoção (oferta → grupos, exceções, concierge);
//  2. telefone fora da base: pede o e-mail da compra e avisa o grupo do operador.
//     E-mail com compra → código de 6 dígitos no e-mail (`/cdv/inclusao/codigo`);
//     código certo → o proxy grava o telefone como Ajuste de cadastro
//     (`/cdv/inclusao/confirmar`) e o fluxo segue com esse telefone;
//  3. só os grupos em que a pessoa AINDA NÃO está; se já está em todos, encerra;
//  4. só inclui depois de ela salvar o número na agenda e responder SIM;
//  5. Premium: pergunta quais grupos de emissões por estado ela quer;
//  6. Balcão só com a verificação aprovada (senão manda o formulário);
//  7. a inclusão entra numa fila lenta: uma pessoa por vez, ~3 min entre grupos,
//     no máximo `maxPessoasDia` por dia, das 9h às 21h. Grupo suspenso ou conta
//     que cai no meio = fila pausada + alerta grave ao operador.
//
// A inclusão em si é a tarefa de participante da gestão de grupos do server.js
// (trava da mensagem prévia, só a conta que recebeu a mensagem inclui, convite
// particular quando a privacidade da pessoa não deixa incluir direto).
// A IA (Haiku) só interpreta respostas soltas (e-mail ditado, estados por
// extenso); quem decide e escreve as mensagens é o código.

import { existsSync, readFileSync } from 'fs';
import { ultimaRelacaoAvisos, observarMensagemAvisos } from './avisos-preco.js';

const MS_MIN = 60e3, MS_H = 3600e3;
const CONVERSA_TTL = 48 * MS_H;
// Depois que a conversa termina, a pessoa continua sendo "do CDV" no tico-02
// por 30 dias para agradecimento (7 dias) e problema com grupo/link; o resto
// segue para os avisos de preço (18/11/2026 —
// uma ex-aluna respondeu "muito obrigada" à inclusão e o Tico respondeu
// falando de alerta de preço). Conversa solta (ex.: falar de uma oferta dias
// depois) continua indo para o Tico dos alertas.
const POS_CONVERSA_MS = 30 * 24 * MS_H;
const POS_AGRADECE_MS = 7 * 24 * MS_H;
const RE_INTENCAO_AVISOS = /(amazon|amzn|mercadoli|meli\.la|shopee|shope\.ee|magalu|magazineluiza)|\balertas?\b|\bavisos? de preco|^\s*(sair|parar|cancelar)\b|\bcomprei\b|\bpedido\s*n?\W*\d{4}/;
const RE_AGRADECE = /^(muit[oa]\s+)?(obrigad|obg|brigad|valeu|vlw|grat[oa]|gratidao|show|top|perfeito|otimo|maravilh|beleza|blz|ok\b|okay|certo|combinado|amem|deus\s+(te\s+)?abenc|tmj|joia|legal|massa|entendi|ta\s+bom|tudo\s+certo|consegui|deu\s+certo|que\s+bom|oba)/;
// Quem está no cadastro do CDV e fala de grupo/link/acesso: é inclusão (21/11/2026).
const RE_QUER_GRUPOS = /\bgrupos?\b|\blinks?\b|convite|\bentrar\b|\bacesso\b|removid|adicion/;
const RE_MENU_1 = /^\s*(1|um|op[cç][aã]o\s*1|1\s*[-–.)])\s*[.!]*\s*$/i;
const RE_MENU_2 = /^\s*(2|dois|op[cç][aã]o\s*2|2\s*[-–.)])\s*[.!]*\s*$/i;
const RE_MENU_ALERTA = /alerta|pre[cç]o|produto|monitor/;
const MENU_RESPOSTA_MS = 2 * MS_H;
const MENU_REPETE_MS = 24 * MS_H;
const RE_GATILHO = /\bentrar\b.{0,20}\bgrupos?\b.{0,40}\bclube\s+do\s+viajante\b/;
const RE_SIM = /^\s*(sim|s|salvei|ja salvei|já salvei|pronto|ok|okay|feito|salvo|isso|claro|positivo)\b/i;
const RE_EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const UFS = {
  AC: 'acre', AL: 'alagoas', AP: 'amapa', AM: 'amazonas', BA: 'bahia', CE: 'ceara', DF: 'distrito federal',
  ES: 'espirito santo', GO: 'goias', MA: 'maranhao', MT: 'mato grosso', MS: 'mato grosso do sul', MG: 'minas gerais',
  PA: 'para', PB: 'paraiba', PR: 'parana', PE: 'pernambuco', PI: 'piaui', RJ: 'rio de janeiro', RN: 'rio grande do norte',
  RS: 'rio grande do sul', RO: 'rondonia', RR: 'roraima', SC: 'santa catarina', SP: 'sao paulo', SE: 'sergipe', TO: 'tocantins',
};
const CONFIG_PADRAO = {
  ativo: true,
  conta: 'tico-02',
  maxPessoasDia: 10,
  pausaGrupoMs: [150000, 210000],   // ~3 min entre um grupo e outro
  janelaIni: 9, janelaFim: 21,
};

let _d = {};
let _E = null;
let _timerGravar = null;
let _rodando = false;

function E() {
  if (_E) return _E;
  _E = { config: { ...CONFIG_PADRAO }, conversas: {}, fila: [], atual: null, pausado: null, hoje: { dia: null, pessoas: [] }, historico: [] };
  try {
    if (_d.caminho && existsSync(_d.caminho)) {
      const l = JSON.parse(readFileSync(_d.caminho, 'utf-8'));
      Object.assign(_E, l || {});
      _E.config = { ...CONFIG_PADRAO, ...((l && l.config) || {}) };
    }
  } catch (e) { console.warn('[INCLUSAO] Não li o estado: ' + e.message); }
  return _E;
}
function gravar() {
  clearTimeout(_timerGravar);
  _timerGravar = setTimeout(() => {
    try {
      const e = E();
      const corte = Date.now() - CONVERSA_TTL;
      for (const [k, c] of Object.entries(e.conversas)) if ((c.atualizadoEm || 0) < corte && c.etapa !== 'na_fila') delete e.conversas[k];
      e.historico = (e.historico || []).slice(-200);
      for (const [t, em] of Object.entries(e.bvEnviadas || {})) if (Date.now() - em > 7 * 24 * MS_H) delete e.bvEnviadas[t];
      for (const [t, em] of Object.entries(e.posCdv || {})) if (Date.now() - em > POS_CONVERSA_MS) delete e.posCdv[t];
      _d.escreverAtomico(_d.caminho, JSON.stringify(e), 'utf-8');
    } catch (err) { console.warn('[INCLUSAO] Não gravei o estado: ' + err.message); }
  }, 1500);
  if (_timerGravar.unref) _timerGravar.unref();
}

function norm(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim(); }
function diaSP(ms = Date.now()) { return new Date(ms - 3 * MS_H).toISOString().slice(0, 10); }
function horaSP(ms = Date.now()) { return new Date(ms - 3 * MS_H).getUTCHours(); }
function primeiroNome(n) { const p = String(n || '').trim().split(/\s+/)[0]; return p ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : ''; }
function lista(nomes) { return nomes.map(n => '• ' + n).join('\n'); }
// Grupos a que a pessoa tem direito e em que já está (ordem alfabética), para a
// mensagem mostrar o acesso inteiro e não só o que falta (22/11/2026). Checagem
// falhou (presentes null) = lista vazia: melhor não mostrar do que mostrar errado.
function nomesJaEsta(liberados, presentes) {
  if (!presentes) return [];
  return liberados.filter(g => presentes.has(g.jid)).map(g => g.nome)
    .sort((a, b) => String(a).localeCompare(String(b), 'pt-BR'));
}
function blocoJaEsta(nomes) { return nomes.length ? '✅ *Você já está em:*\n' + lista(nomes) : ''; }
function textoDe(msg) {
  const m = msg?.message || {};
  return String(m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.ephemeralMessage?.message?.conversation
    || m.ephemeralMessage?.message?.extendedTextMessage?.text || '').trim();
}
function hojeE() {
  const e = E(), d = diaSP();
  if (!e.hoje || e.hoje.dia !== d) e.hoje = { dia: d, pessoas: [] };
  return e.hoje;
}

export function configInclusaoCdv() { return { ...E().config }; }

// Chamado pelo server.js para TODA mensagem recebida pelas contas. Devolve true
// quando a mensagem pertence a este fluxo (o chamador então não a repassa aos
// avisos de preço, que dividem o número com o CDV).
export function observarInclusaoCdv(apelido, sock, msg) {
  try {
    const e = E();
    if (!e.config.ativo || apelido !== e.config.conta) return false;
    const k = msg?.key;
    if (!k || k.fromMe || !msg.message) return false;
    const jid = String(k.remoteJid || '');
    if (!jid || jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) return false;
    const ts = Number(msg.messageTimestamp?.low ?? msg.messageTimestamp ?? 0) * 1000;
    if (ts && Date.now() - ts > 6 * MS_H) return false;   // histórico sincronizado na conexão
    const texto = textoDe(msg);
    let conv = e.conversas[jid];
    // A boas-vindas sai para o JID do telefone; a resposta pode chegar pelo LID.
    // Acha a conversa pelo telefone que vem junto na chave e passa a usar o JID novo.
    if (!conv) {
      const tel = [k.senderPn, k.remoteJidAlt, k.remoteJid].map(v => String(v || ''))
        .find(v => v.endsWith('@s.whatsapp.net'));
      const d8 = tel ? tel.split('@')[0].replace(/\D/g, '').slice(-8) : '';
      if (d8) {
        const [k0, c0] = Object.entries(e.conversas).find(([, c]) => String(c.telefone || '').slice(-8) === d8) || [];
        if (c0) { delete e.conversas[k0]; c0.jid = jid; e.conversas[jid] = c0; conv = c0; }
      }
    }
    const ativa = conv && conv.etapa !== 'fim' && Date.now() - (conv.atualizadoEm || 0) < CONVERSA_TTL;
    const gatilho = RE_GATILHO.test(norm(texto));
    if (!gatilho && !ativa) {
      // Conversa já encerrada (ou de até 30 dias atrás): segue sendo do CDV,
      // salvo pedido claro de alerta de preço ou alerta mais recente que o CDV.
      const telJid = [k.senderPn, k.remoteJidAlt, k.remoteJid].map(v => String(v || '')).find(v => v.endsWith('@s.whatsapp.net'));
      const d8 = telJid ? telJid.split('@')[0].replace(/\D/g, '').slice(-8) : String((conv && conv.telefone) || '').slice(-8);
      // Resposta ao menu do CDV (1 = grupos, 2 = alerta de preço).
      const menu = (e.menuCdv || {})[jid];
      if (menu && Date.now() - (menu.em || 0) < MENU_RESPOSTA_MS) {
        const t = norm(texto);
        if (RE_MENU_1.test(texto) || RE_QUER_GRUPOS.test(t)) {
          delete e.menuCdv[jid]; gravar();
          tratar(apelido, sock, msg, jid, texto, true).catch(err => console.warn('[INCLUSAO] Conversa: ' + err.message));
          return true;
        }
        if (RE_MENU_2.test(texto) || RE_MENU_ALERTA.test(t)) {
          menu.em = 0; gravar();   // não reabre a escolha; o 24 h segue pelo menuVistoEm
          observarMensagemAvisos(apelido, msg, { membroCdv: { nome: menu.nome || '' }, pedirLink: !RE_URL_LOJA.test(texto) });
          return true;
        }
      }
      const pc = e.posCdv || {};
      const desde = Math.max(conv ? (conv.ultimaRespostaEm || conv.atualizadoEm || 0) : 0, pc['j:' + jid] || 0, d8 ? (pc['t:' + d8] || 0) : 0);
      if (RE_INTENCAO_AVISOS.test(norm(texto))) return false;
      if (!desde || Date.now() - desde > POS_CONVERSA_MS) return rotearPorCadastro(apelido, sock, msg, jid, texto);
      const jids = [k.remoteJid, k.remoteJidAlt, k.senderPn].map(v => String(v || '')).filter(Boolean);
      if (ultimaRelacaoAvisos(jids, telJid ? telJid.split('@')[0] : '') > desde) return false;
      // Só fica com o CDV o que é claramente dele: agradecimento/emoji (7 dias)
      // ou problema com grupo/link (30 dias). O resto passa pelo cadastro.
      const tipo = tipoPosConversa(texto);
      if (!tipo || (tipo === 'agradece' && Date.now() - desde > POS_AGRADECE_MS)) return rotearPorCadastro(apelido, sock, msg, jid, texto);
      posConversa(apelido, sock, msg, jid, texto, conv).catch(err => console.warn('[INCLUSAO] Pós-conversa: ' + err.message));
      return true;
    }
    tratar(apelido, sock, msg, jid, texto, gatilho).catch(err => console.warn('[INCLUSAO] Conversa: ' + err.message));
    return true;
  } catch (err) { console.warn('[INCLUSAO] ' + err.message); return false; }
}

// ── Quem está falando? (21/11/2026) ─────────────────────────────────────────
// O tico-02 é do CDV (inclusão) e do Tico (alertas de preço). Mensagem solta,
// sem a frase de entrar nos grupos: o telefone é conferido no cadastro do
// próprio CDV (proxy /cdv/inclusao/consultar, que lê as assinaturas e as
// exceções já gravadas — nenhuma chamada à Hubla). Cliente do CDV:
//  - fala de grupo/link/acesso → inclusão;
//  - mexeu com alerta de preço nas últimas 24 h → Tico (sabendo que é aluno);
//  - resto → menu "1 grupos · 2 alerta de preço" (1×/24 h; depois, Tico).
// Fora do cadastro, ou consulta falhou → Tico, como antes.
const RE_URL_LOJA = /https?:\/\/\S+/i;
const _cacheMembro = new Map();   // telefone → { em, r }
async function clienteCdv(telefone) {
  const c = _cacheMembro.get(telefone);
  if (c && Date.now() - c.em < 6 * MS_H) return c.r;
  const d = await _d.proxy('/cdv/inclusao/consultar', { telefone });
  const r = d && (d.encontrado || (Array.isArray(d.grupos) && d.grupos.some(g => g.direito))) ? { telefone, nome: d.nome || '' } : null;
  _cacheMembro.set(telefone, { em: Date.now(), r });
  if (_cacheMembro.size > 3000) _cacheMembro.delete(_cacheMembro.keys().next().value);
  return r;
}
function textoMenuCdv(nome) {
  const pn = primeiroNome(nome);
  return 'Oi' + (pn ? ', ' + pn : '') + '! 👋 Aqui é do Clube do Viajante. Como posso te ajudar?\n\n'
    + '*1* — Entrar nos grupos do Clube do Viajante\n'
    + '*2* — Criar um alerta de preço de um produto (Amazon, Mercado Livre ou Shopee)\n\n'
    + 'É só responder *1* ou *2*.';
}
function rotearPorCadastro(apelido, sock, msg, jid, texto) {
  const k = msg.key || {};
  const jids = [k.remoteJid, k.remoteJidAlt, k.senderPn].map(v => String(v || '')).filter(Boolean);
  const telJid = jids.find(v => v.endsWith('@s.whatsapp.net'));
  const telDireto = telJid ? telJid.split('@')[0].replace(/\D/g, '') : '';
  const relAvisos = ultimaRelacaoAvisos(jids, telDireto);
  // Alerta em criação (pergunta de preço aberta): é do Tico, sem consulta.
  if (Date.now() - relAvisos < 60e3 || !_d.proxy) return false;
  (async () => {
    let cli = null;
    try {
      const telefone = telDireto || await _d.telefoneDe(sock, msg);
      if (telefone) cli = await clienteCdv(telefone);
    } catch (err) { console.warn('[INCLUSAO] Consulta do cadastro falhou (' + err.message + '); segue para o Tico.'); }
    if (!cli) { observarMensagemAvisos(apelido, msg); return; }
    const ctx = { membroCdv: { nome: cli.nome } };
    if (RE_QUER_GRUPOS.test(norm(texto))) { await tratar(apelido, sock, msg, jid, texto, true); return; }
    const e = E();
    e.menuCdv = e.menuCdv || {};
    const m = e.menuCdv[jid];
    if (Date.now() - relAvisos < 24 * MS_H || (m && Date.now() - (m.vistoEm || 0) < MENU_REPETE_MS)) { observarMensagemAvisos(apelido, msg, ctx); return; }
    e.menuCdv[jid] = { em: Date.now(), vistoEm: Date.now(), nome: cli.nome };
    for (const [j, x] of Object.entries(e.menuCdv)) if (Date.now() - (x.vistoEm || 0) > 7 * 24 * MS_H) delete e.menuCdv[j];
    gravar();
    try { await _d.enviar(apelido, jid, textoMenuCdv(cli.nome)); }
    catch (err) { console.warn('[INCLUSAO] Menu não saiu para ' + cli.telefone + ': ' + err.message); }
    E().historico.push({ em: new Date().toISOString(), telefone: cli.telefone, evento: 'menu', detalhe: null });
  })().catch(err => console.warn('[INCLUSAO] Roteamento: ' + err.message));
  return true;
}

function marcarPosCdv(conv) {
  const e = E();
  e.posCdv = e.posCdv || {};
  if (conv.jid) e.posCdv['j:' + conv.jid] = Date.now();
  const d8 = String(conv.telefone || '').slice(-8);
  if (d8) e.posCdv['t:' + d8] = Date.now();
}
async function responder(conv, texto) {
  try { await _d.enviar(conv.conta, conv.jid, texto); conv.ultimaRespostaEm = Date.now(); marcarPosCdv(conv); gravar(); }
  catch (e) { console.warn('[INCLUSAO] Resposta não saiu para ' + conv.telefone + ': ' + e.message); }
}
async function avisarOperador(texto) {
  try { await _d.avisarOperador(texto); } catch (e) { console.warn('[INCLUSAO] Aviso ao operador falhou: ' + e.message); }
}
function rotuloPessoa(conv) { return '+' + conv.telefone + (conv.nome ? ' (' + conv.nome + ')' : conv.pushName ? ' (' + conv.pushName + ')' : ''); }
function registrar(conv, evento, detalhe) {
  E().historico.push({ em: new Date().toISOString(), telefone: conv.telefone, evento, detalhe: detalhe || null });
}

async function tratar(apelido, sock, msg, jid, texto, gatilho) {
  const e = E();
  let conv = e.conversas[jid];
  if (gatilho && conv && conv.etapa === 'na_fila') {
    const pos = e.fila.findIndex(f => f.jid === jid);
    if (pos >= 0 || (e.atual && e.atual.jid === jid)) {
      await responder(conv, 'Seu pedido já está na fila de inclusão' + (pos >= 0 ? ' (posição ' + (pos + 1) + ')' : ', e estou te adicionando agora') + '. Te aviso aqui quando terminar.');
      return;
    }
  }
  if (gatilho || !conv) {
    const telefone = await _d.telefoneDe(sock, msg);
    if (!telefone) { console.warn('[INCLUSAO] Não descobri o telefone de ' + jid); return; }
    conv = e.conversas[jid] = { jid, conta: apelido, telefone, pushName: msg.pushName || '', etapa: 'inicio', tentativas: 0,
      criadoEm: Date.now(), atualizadoEm: Date.now() };
    registrar(conv, 'pedido');
    gravar();
    await consultarPorTelefone(conv);
    return;
  }
  conv.atualizadoEm = Date.now();
  if (conv.pushName !== msg.pushName && msg.pushName) conv.pushName = msg.pushName;
  try {
    if (conv.etapa === 'email') await etapaEmail(conv, texto);
    else if (conv.etapa === 'codigo') await etapaCodigo(conv, texto);
    else if (conv.etapa === 'salvo') await etapaSalvo(conv, texto);
    else if (conv.etapa === 'estados') await etapaEstados(conv, texto);
    else if (conv.etapa === 'na_fila') {
      if (Date.now() - (conv.ultimaRespostaEm || 0) > 30 * MS_MIN) {
        const pos = e.fila.findIndex(f => f.jid === conv.jid);
        await responder(conv, pos >= 0 ? 'Seu pedido está na fila de inclusão (posição ' + (pos + 1) + '). Adicionamos com calma, um grupo de cada vez, para proteger os grupos. Te aviso aqui quando terminar.'
          : 'Estou te adicionando nos grupos agora, um de cada vez. Te aviso aqui quando terminar.');
      }
    } else if (conv.etapa === 'boas_vindas') {
      // Recebeu os links na boas-vindas. Falou de grupo/link/não conseguir →
      // segue o fluxo normal de inclusão (só os grupos que ainda faltam).
      if (/grupo|link|entrar|consegu|abr[eiu]|erro|\bnao\b|ajuda/.test(norm(texto))) await consultarPorTelefone(conv);
    } else if (conv.etapa === 'aguardando_equipe') {
      if (Date.now() - (conv.ultimaRespostaEm || 0) > 2 * MS_H) await responder(conv, 'A equipe já foi avisada e vai te responder por aqui. Se quiser tentar com outro e-mail, mande o e-mail da compra.');
      if (RE_EMAIL.test(texto)) { conv.etapa = 'email'; await etapaEmail(conv, texto); }
    }
  } finally { gravar(); }
}

// Mensagem de quem já passou pela inclusão (conversa encerrada). Só dois tipos
// ficam com o CDV; o resto segue para os avisos de preço, como antes:
//  - 'agradece': agradecimento/emoji (até 7 dias) → resposta curta do CDV, 1×/24 h;
//  - 'problema': problema com grupo/link (até 30 dias) → reabre a inclusão.
function tipoPosConversa(texto) {
  const t = norm(texto);
  if (!t) return null;
  const problema = /\bnao\b|erro|problema|ajuda|\bsai\b|saiu|removid|nao abre|nao consig/.test(t);
  if (problema) return /grupo|link|convite|entrar|adicion/.test(t) ? 'problema' : null;
  const soEmoji = !t.replace(/[^a-z0-9]/g, '');
  return (RE_AGRADECE.test(t) || soEmoji) ? 'agradece' : null;
}
async function posConversa(apelido, sock, msg, jid, texto, conv) {
  const e = E();
  if (tipoPosConversa(texto) === 'problema') { await tratar(apelido, sock, msg, jid, texto, true); return; }
  e.posResp = e.posResp || {};
  if (Date.now() - (e.posResp[jid] || 0) < 24 * MS_H) return;
  e.posResp[jid] = Date.now();
  for (const [j, em] of Object.entries(e.posResp)) if (Date.now() - em > 7 * 24 * MS_H) delete e.posResp[j];
  const telefone = (conv && conv.telefone) || await _d.telefoneDe(sock, msg);
  if (!telefone) return;
  const c = conv || { jid, conta: apelido, telefone };
  c.jid = jid; c.conta = c.conta || apelido;
  await responder(c, 'Por nada! 😊 Aproveite os grupos do Clube do Viajante. Boas viagens! ✈️');
}

async function consultarPorTelefone(conv) {
  let d;
  try { d = await _d.proxy('/cdv/inclusao/consultar', { telefone: conv.telefone }); }
  catch (err) {
    conv.etapa = 'aguardando_equipe';
    await responder(conv, 'Oi! Recebi seu pedido para entrar nos grupos do Clube do Viajante, mas não consegui consultar seu cadastro agora. Já avisei a equipe, que vai te responder por aqui.');
    await avisarOperador('*Inclusão nos grupos — erro na consulta* ⚠️\n\n' + rotuloPessoa(conv) + ' pediu para entrar nos grupos e a consulta ao proxy falhou: ' + err.message);
    return;
  }
  conv.nome = d.nome || conv.nome || '';
  if (d.grupos && d.grupos.some(g => g.direito)) { await seguirComDireito(conv, d, false); return; }
  conv.etapa = 'email';
  conv.tentativas = 0;
  const pn = primeiroNome(conv.nome || conv.pushName);
  if (d.encontrado) {
    await responder(conv, 'Oi' + (pn ? ', ' + pn : '') + '! Encontrei este número no nosso cadastro, mas não achei uma assinatura ativa que dê acesso aos grupos.\n\n'
      + 'Se você renovou ou comprou com outro e-mail, me mande aqui *o e-mail que usou na compra*.');
    registrar(conv, 'sem_direito', d.situacao);
  } else {
    await responder(conv, 'Oi' + (pn ? ', ' + pn : '') + '! Não encontrei este número no nosso cadastro. Pode me mandar *o e-mail que você usou na compra*?');
    registrar(conv, 'fora_da_base');
  }
  await avisarOperador('*Pendente de inclusão nos grupos* ⏳\n\n' + rotuloPessoa(conv) + ' pediu para entrar nos grupos e '
    + (d.encontrado ? 'não tem assinatura ativa com acesso a grupos (situação: ' + (d.situacao || '?') + ')' : 'o número não está na base')
    + '. Pedi o e-mail da compra; te aviso o que ela responder.');
}

async function extrairEmail(texto) {
  const m = RE_EMAIL.exec(String(texto || '').replace(/\s+@\s+/g, '@'));
  if (m) return m[0].toLowerCase();
  if (!_d.ia || String(texto || '').length > 300) return null;
  try {
    const r = await _d.ia('Você extrai um endereço de e-mail de uma mensagem de WhatsApp em português, que pode ter sido ditada por voz ("joao ponto silva arroba gmail ponto com"). '
      + 'Responda só JSON: {"email": "<e-mail em minúsculas>"} ou {"email": null} se não houver e-mail.', String(texto));
    const em = r && typeof r.email === 'string' ? r.email.trim().toLowerCase() : '';
    return RE_EMAIL.test(em) ? RE_EMAIL.exec(em)[0] : null;
  } catch (e) { return null; }
}

async function etapaEmail(conv, texto) {
  const email = await extrairEmail(texto);
  if (!email) {
    conv.tentativas = (conv.tentativas || 0) + 1;
    if (conv.tentativas >= 3) {
      conv.etapa = 'aguardando_equipe';
      await responder(conv, 'Não consegui ler o e-mail. Já avisei a equipe, que vai te responder por aqui.');
      await avisarOperador('*Pendente de inclusão nos grupos* ⏳\n\n' + rotuloPessoa(conv) + ' não conseguiu informar o e-mail da compra pela conversa. Última mensagem: "' + String(texto).slice(0, 200) + '"');
      return;
    }
    await responder(conv, 'Não consegui ler o e-mail. Mande só o e-mail da compra, sem outras palavras na mensagem.');
    return;
  }
  conv.email = email;
  let r;
  try { r = await _d.proxy('/cdv/inclusao/codigo', { telefone: conv.telefone, email }); }
  catch (err) {
    conv.etapa = 'aguardando_equipe';
    await responder(conv, 'Não consegui conferir esse e-mail agora. Já avisei a equipe, que vai te responder por aqui.');
    await avisarOperador('*Pendente de inclusão nos grupos* ⏳\n\n' + rotuloPessoa(conv) + ' informou o e-mail ' + email + ' e a consulta falhou: ' + err.message);
    return;
  }
  conv.nome = r.nome || conv.nome || '';
  if (!r.encontrado) {
    conv.etapa = 'aguardando_equipe';
    registrar(conv, 'email_fora_da_base');
    await responder(conv, 'Não encontrei compra com o e-mail ' + email + '. Já avisei a equipe, que vai conferir e te responder por aqui. Se tiver outro e-mail, pode mandar.');
    await avisarOperador('*Pendente de inclusão nos grupos* ⏳\n\n' + rotuloPessoa(conv) + ' informou o e-mail ' + email + ', que não tem compra na Hubla. Precisa da sua análise.');
    return;
  }
  if (r.semDireito) {
    conv.etapa = 'aguardando_equipe';
    registrar(conv, 'email_sem_direito', r.situacao);
    await responder(conv, 'Encontrei sua compra, mas hoje ela não dá acesso aos grupos (a assinatura não está ativa). Já avisei a equipe, que vai te responder por aqui.');
    await avisarOperador('*Pendente de inclusão nos grupos* ⏳\n\n' + rotuloPessoa(conv) + ' informou o e-mail ' + email + ': tem compra, mas sem direito a grupos agora (situação: ' + (r.situacao || '?') + ').');
    return;
  }
  if (r.semEmail) {
    conv.etapa = 'aguardando_equipe';
    registrar(conv, 'email_sem_envio');
    await responder(conv, 'Encontrei sua compra. Para trocar o número do cadastro preciso de uma confirmação da equipe, que já foi avisada e vai te responder por aqui.');
    await avisarOperador('*Pendente de inclusão nos grupos* ⏳\n\n' + rotuloPessoa(conv) + ' informou o e-mail ' + email + ', que tem compra com direito a grupos, mas o código de confirmação não pôde ser enviado (falta a variável EMAIL_REMETENTE no proxy). '
      + 'Se for a pessoa certa, inclua o telefone em Exceções → Ajustes de cadastro e peça para ela mandar a mensagem de novo.');
    return;
  }
  conv.etapa = 'codigo';
  conv.tentativas = 0;
  await responder(conv, 'Encontrei sua compra! Para confirmar que o e-mail é seu, mandei um código de 6 dígitos para ' + (r.emailMascarado || email) + '.\n\n'
    + 'Me responda aqui com o código (vale 15 minutos). Se não chegar, olhe a caixa de spam.');
}

async function etapaCodigo(conv, texto) {
  if (RE_EMAIL.test(texto)) { conv.etapa = 'email'; await etapaEmail(conv, texto); return; }
  const codigo = (String(texto).match(/\d[\d\s.-]{4,}\d/) || [''])[0].replace(/\D/g, '');
  if (codigo.length !== 6) { await responder(conv, 'Me mande só o código de 6 dígitos que chegou no seu e-mail.'); return; }
  let r;
  try { r = await _d.proxy('/cdv/inclusao/confirmar', { telefone: conv.telefone, email: conv.email, codigo }); }
  catch (err) { await responder(conv, 'Não consegui conferir o código agora. Tente de novo em alguns minutos.'); return; }
  if (!r.ok) {
    if (r.motivo === 'errado') { await responder(conv, 'Esse código não confere. Você ainda tem ' + r.restam + ' tentativa(s).'); return; }
    conv.etapa = 'email';
    await responder(conv, 'O código expirou. Mande o e-mail da compra de novo para eu gerar outro.');
    return;
  }
  registrar(conv, 'telefone_atualizado', conv.email);
  conv.nome = r.nome || conv.nome || '';
  await avisarOperador('*Inclusão nos grupos — telefone atualizado* ✅\n\n' + rotuloPessoa(conv) + ' confirmou o código do e-mail ' + conv.email
    + '. O número entrou como Ajuste de cadastro' + (r.telefoneAnterior ? ' (no lugar de +' + r.telefoneAnterior + ')' : '') + '.');
  await seguirComDireito(conv, r, true);
}

async function seguirComDireito(conv, d, atualizado) {
  const pn = primeiroNome(conv.nome || conv.pushName);
  const comDireito = (d.grupos || []).filter(g => g.direito);
  const balcao = comDireito.find(g => g.balcao) || null;
  const liberados = comDireito.filter(g => !g.balcao || g.verificado);
  let presentes = null;
  try { presentes = await _d.jaEsta(conv.telefone, liberados.map(g => g.jid)); } catch (e) { presentes = null; }
  const faltam = liberados.filter(g => !(presentes && presentes.has(g.jid)));
  const ufPorJid = new Map((_d.estadosCdv() || []).map(x => [x.jid, x.uf]));
  conv.fixos = faltam.filter(g => !ufPorJid.has(g.jid)).map(g => ({ jid: g.jid, nome: g.nome }));
  conv.estadosDisp = faltam.filter(g => ufPorJid.has(g.jid)).map(g => ({ jid: g.jid, nome: g.nome, uf: ufPorJid.get(g.jid) }))
    .sort((a, b) => a.uf.localeCompare(b.uf));
  conv.balcao = balcao ? { verificado: !!balcao.verificado, pendente: !!balcao.verificacaoPendente, jaEsta: !!(presentes && presentes.has(balcao.jid)),
    formulario: d.formularioBalcao || '' } : null;
  const notaBalcao = balcaoNota(conv);
  const jaEsta = blocoJaEsta(nomesJaEsta(liberados, presentes));
  const inicio = atualizado ? 'Pronto, atualizei seu cadastro com este número.' : 'Oi' + (pn ? ', ' + pn : '') + '! Encontrei seu acesso.';
  if (!conv.fixos.length && !conv.estadosDisp.length) {
    conv.etapa = 'fim';
    registrar(conv, 'ja_esta_em_todos');
    await responder(conv, [inicio + ' Você já está em todos os grupos a que tem direito 👍', jaEsta, notaBalcao].filter(Boolean).join('\n\n'));
    return;
  }
  conv.etapa = 'salvo';
  conv.tentativas = 0;
  const partes = [inicio];
  if (jaEsta) partes.push(jaEsta);
  if (conv.fixos.length) partes.push('👉 *Vou te adicionar em:*\n' + lista(conv.fixos.map(g => g.nome)));
  if (conv.estadosDisp.length) partes.push('📍 *Grupos de emissões por estado:* cada um recebe as passagens com saída daquele estado. Pergunto quais você quer logo depois.');
  partes.push('⚠️ *Só conseguimos te adicionar depois que você salvar este número na sua agenda.*\n\nSalvou? Responda *SIM*.');
  await responder(conv, partes.join('\n\n'));
}

function balcaoNota(conv) {
  const b = conv.balcao;
  if (!b || b.verificado || b.jaEsta) return '';
  if (b.pendente) return '🤝 *Balcão:* sua verificação está em análise. Assim que for aprovada, você entra no grupo.';
  return '🤝 *Balcão:* para entrar é preciso antes preencher o formulário de verificação' + (b.formulario ? ': ' + b.formulario : '') + '. Depois da aprovação, você entra no grupo.';
}

async function etapaSalvo(conv, texto) {
  if (!RE_SIM.test(norm(texto))) {
    conv.tentativas = (conv.tentativas || 0) + 1;
    if (conv.tentativas <= 3) await responder(conv, 'Para eu te adicionar, salve este número na sua agenda e responda *SIM*. Sem o número salvo o WhatsApp não deixa a inclusão.');
    return;
  }
  if (conv.estadosDisp && conv.estadosDisp.length) {
    conv.etapa = 'estados';
    conv.tentativas = 0;
    await responder(conv, 'Ótimo! Quais grupos de emissões por estado você quer? Cada um recebe as passagens com saída daquele estado.\n\n'
      + 'Disponíveis: ' + conv.estadosDisp.map(g => g.uf).join(', ') + '\n\n'
      + 'Responda com as siglas (ex.: *MG, SP*), *TODOS* ou *NENHUM*.');
    return;
  }
  await enfileirar(conv, []);
}

async function lerEstados(conv, texto) {
  const disp = conv.estadosDisp || [];
  const t = norm(texto);
  if (/\b(todos|todas|tudo)\b/.test(t)) return disp.map(g => g.uf);
  const achadas = new Set();
  // Siglas: as escritas em maiúscula; em minúscula só se a mensagem for só siglas
  // ("mg, sp e rj") — "se" e "es" são palavras comuns.
  for (const m of String(texto).matchAll(/\b([A-Z]{2})\b/g)) if (disp.some(g => g.uf === m[1])) achadas.add(m[1]);
  const tokens = t.split(/[^a-z]+/).filter(Boolean);
  if (!achadas.size && tokens.length && tokens.every(x => x.length === 2 || x === 'e')) {
    for (const x of tokens) { const uf = x.toUpperCase(); if (disp.some(g => g.uf === uf)) achadas.add(uf); }
  }
  // nomes por extenso (os mais longos primeiro: "mato grosso do sul" antes de "mato grosso")
  let resto = ' ' + t.replace(/[^a-z ]/g, ' ') + ' ';
  for (const [uf, nome] of Object.entries(UFS).sort((a, b) => b[1].length - a[1].length)) {
    if (resto.includes(' ' + nome + ' ')) { if (disp.some(g => g.uf === uf)) achadas.add(uf); resto = resto.replace(' ' + nome + ' ', ' '); }
  }
  if (achadas.size) return [...achadas];
  if (/\b(nenhum|nenhuma|nao quero|nao|n)\b/.test(t) && t.length < 40) return [];
  if (!_d.ia) return null;
  try {
    const r = await _d.ia('Você interpreta a resposta de uma pessoa no WhatsApp sobre quais estados brasileiros ela quer. Estados disponíveis (siglas): '
      + disp.map(g => g.uf).join(', ') + '. Responda só JSON: {"ufs": ["MG", ...]} com as siglas escolhidas dentre as disponíveis, '
      + '{"ufs": []} se ela não quer nenhum, ou {"ufs": null} se não deu para entender.', String(texto).slice(0, 300));
    if (!r || !Array.isArray(r.ufs)) return null;
    return r.ufs.map(x => String(x).toUpperCase()).filter(uf => disp.some(g => g.uf === uf));
  } catch (e) { return null; }
}

async function etapaEstados(conv, texto) {
  const ufs = await lerEstados(conv, texto);
  if (ufs === null) {
    conv.tentativas = (conv.tentativas || 0) + 1;
    if (conv.tentativas >= 3) { await enfileirar(conv, []); return; }
    await responder(conv, 'Não entendi. Responda com as siglas dos estados (ex.: *MG, SP*), *TODOS* ou *NENHUM*.\nDisponíveis: ' + conv.estadosDisp.map(g => g.uf).join(', '));
    return;
  }
  await enfileirar(conv, ufs);
}

async function enfileirar(conv, ufs) {
  const e = E();
  const estados = (conv.estadosDisp || []).filter(g => ufs.includes(g.uf));
  const grupos = [...(conv.fixos || []), ...estados];
  const nota = balcaoNota(conv);
  if (!grupos.length) {
    conv.etapa = 'fim';
    await responder(conv, 'Tudo bem! Você já está nos grupos que escolheu.' + (nota ? '\n\n' + nota : ''));
    return;
  }
  e.fila = e.fila.filter(f => f.jid !== conv.jid);
  e.fila.push({ id: 'inc-' + Date.now().toString(36), jid: conv.jid, conta: conv.conta, telefone: conv.telefone, nome: conv.nome || conv.pushName || '',
    grupos, criadoEm: new Date().toISOString() });
  conv.etapa = 'na_fila';
  registrar(conv, 'na_fila', grupos.map(g => g.nome).join(', '));
  const pos = e.fila.length;
  await responder(conv, 'Combinado! Seu pedido entrou na fila de inclusão' + (pos > 1 ? ' (posição ' + pos + ')' : '') + '.\n\n'
    + 'Para proteger os grupos, adicionamos com calma, um grupo de cada vez (das 9h às 21h), então pode levar um tempo. Te aviso aqui quando terminar.'
    + (nota ? '\n\n' + nota : ''));
  gravar();
  setTimeout(() => ciclo().catch(() => {}), 5000);
}

// ── Boas-vindas de quem acabou de assinar (desde 18/11/2026) ─────────────────
// O webhook da Hubla (customer.member_added) agenda; 2 min depois (tempo de o
// proxy gravar a assinatura) o tico-02 manda o texto de boas-vindas e, numa
// segunda mensagem, os grupos: link de convite para quem nunca foi removido,
// inclusão pela fila (com SIM depois de salvar o número) para quem um admin
// removeu (o link não abre para essa pessoa), grupos por estado perguntados ao
// Premium, Balcão só com o formulário. Sem direito a grupo ainda: tenta de novo
// em 10 min e, se seguir sem, manda só a boas-vindas com a frase do fluxo.
const BV_ATRASO_MS = 2 * MS_MIN;
const BV_RETENTATIVA_MS = 10 * MS_MIN;
const LINK_AREA_MEMBROS = 'https://app.hub.la/m/5aPVHUjfhTa79XR2bWqC';

export function textoBoasVindasCdv(nome, premium) {
  const n = primeiroNome(nome);
  return 'Olá' + (n ? ', ' + n : '') + '! Que alegria ter você no *Clube do Viajante' + (premium ? ' Premium' : '') + '*! ✈️\n\n'
    + 'A partir de agora você tem acesso aos nossos conteúdos, grupos e oportunidades para acumular e usar melhor seus pontos e milhas.\n\n'
    + 'Meu conselho para o *primeiro passo*: entre na área de membros e *assista*, pelo menos, ao *módulo de boas-vindas*. '
    + 'Lá eu explico como aproveitar os conteúdos, como funcionam os grupos, onde encontrar cada informação e quais são os próximos passos.\n\n'
    + 'E tem mais: *você já está participando do desafio 100 em 3*. Quem assistir a todas as aulas em até 3 meses ganha um kit de viagens personalizado. '
    + 'Os detalhes também estão no módulo de boas-vindas.\n\n'
    + 'Que bom ter você aqui! 🚀\n\n'
    + 'Área de membros: ' + LINK_AREA_MEMBROS + '\n\n'
    + 'Davi Leles';
}

export function agendarBoasVindasCdv({ telefone, nome, premium }) {
  const e = E();
  let tel = String(telefone || '').replace(/\D/g, '');
  if (tel.length <= 11) tel = '55' + tel;
  if (tel.length < 12) return { ok: false, erro: 'telefone inválido' };
  e.boasVindas = e.boasVindas || [];
  e.bvEnviadas = e.bvEnviadas || {};
  if (Date.now() - (e.bvEnviadas[tel] || 0) < 24 * MS_H) return { ok: true, repetida: true };
  if (e.boasVindas.some(b => b.telefone === tel)) return { ok: true, jaNaFila: true };
  e.boasVindas.push({ telefone: tel, nome: nome || '', premium: !!premium, quando: Date.now() + BV_ATRASO_MS, tentativas: 0 });
  gravar();
  return { ok: true, agendada: true };
}

async function processarBoasVindas() {
  const e = E();
  const fila = e.boasVindas || [];
  const i = fila.findIndex(b => b.quando <= Date.now());
  if (i < 0) return;
  const b = fila[i];
  const conta = e.config.conta;
  if (!_d.contaConectada(conta)) {
    b.tentativas++;
    if (b.tentativas < 12) { b.quando = Date.now() + 5 * MS_MIN; gravar(); return; }
    // conta fora do ar há 1 h: a boas-vindas sai pela principal, com a frase do fluxo
    fila.splice(i, 1);
    try {
      await _d.enviarPrincipal(b.telefone, textoBoasVindasCdv(b.nome, b.premium) + '\n\nPara entrar nos grupos, chame o nosso número dos grupos'
        + (_d.numeroDaConta(conta) ? ' (' + _d.numeroDaConta(conta) + ')' : '') + ' e mande: *Quero entrar nos grupos do Clube do Viajante*');
    } catch (err) { console.warn('[INCLUSAO] Boas-vindas pela principal falhou: ' + err.message); }
    (e.bvEnviadas || (e.bvEnviadas = {}))[b.telefone] = Date.now();
    gravar();
    return;
  }
  let d = null;
  try { d = await _d.proxy('/cdv/inclusao/consultar', { telefone: b.telefone }); } catch (err) { console.warn('[INCLUSAO] Boas-vindas: consulta falhou: ' + err.message); }
  const temDireito = !!(d && (d.grupos || []).some(g => g.direito));
  if (!temDireito && b.tentativas === 0) { b.tentativas = 1; b.quando = Date.now() + BV_RETENTATIVA_MS; gravar(); return; }
  fila.splice(i, 1);
  (e.bvEnviadas || (e.bvEnviadas = {}))[b.telefone] = Date.now();
  const jid = await _d.jidDoTelefone(b.telefone);
  const conv = { jid, conta, telefone: b.telefone, nome: (d && d.nome) || b.nome || '', etapa: 'boas_vindas', tentativas: 0,
    criadoEm: Date.now(), atualizadoEm: Date.now(), origem: 'boas-vindas' };
  e.conversas[jid] = conv;
  await responder(conv, textoBoasVindasCdv(b.nome || conv.nome, b.premium));
  registrar(conv, 'boas_vindas');
  if (!temDireito) {
    await new Promise(r => setTimeout(r, 4000));
    await responder(conv, 'Assim que o seu acesso aos grupos estiver liberado, é só me mandar aqui: *Quero entrar nos grupos do Clube do Viajante*');
    conv.etapa = 'fim';
    gravar();
    return;
  }
  const comDireito = d.grupos.filter(g => g.direito);
  const balcao = comDireito.find(g => g.balcao) || null;
  const liberados = comDireito.filter(g => !g.balcao || g.verificado);
  let presentes = null;
  try { presentes = await _d.jaEsta(b.telefone, liberados.map(g => g.jid)); } catch (err) {}
  const faltam = liberados.filter(g => !(presentes && presentes.has(g.jid)));
  const ufPorJid = new Map((_d.estadosCdv() || []).map(x => [x.jid, x.uf]));
  const links = [], adicionar = [];
  for (const g of faltam.filter(x => !ufPorJid.has(x.jid))) {
    let removido = !!(g.removidoPeloTico || g.exAluno);
    if (!removido) { try { removido = await _d.removidoPorAdmin(b.telefone, g.jid); } catch (err) {} }
    let link = null;
    if (!removido) { try { link = await _d.linkConvite(g.jid); } catch (err) { link = null; } }
    if (link) links.push({ nome: g.nome, link }); else adicionar.push({ jid: g.jid, nome: g.nome });
  }
  conv.fixos = adicionar;
  conv.estadosDisp = faltam.filter(g => ufPorJid.has(g.jid)).map(g => ({ jid: g.jid, nome: g.nome, uf: ufPorJid.get(g.jid) }))
    .sort((a, b2) => a.uf.localeCompare(b2.uf));
  conv.balcao = balcao ? { verificado: !!balcao.verificado, pendente: !!balcao.verificacaoPendente, jaEsta: !!(presentes && presentes.has(balcao.jid)),
    formulario: d.formularioBalcao || '' } : null;
  const nomesPresentes = nomesJaEsta(liberados, presentes);
  const partes = ['*Seus grupos do Clube do Viajante' + (b.premium ? ' Premium' : '') + '* ✈️'];
  if (nomesPresentes.length) partes.push(blocoJaEsta(nomesPresentes));
  if (links.length) partes.push('👉 *Falta entrar* — é só tocar:\n' + links.map(l => '• ' + l.nome + ': ' + l.link).join('\n'));
  if (adicionar.length || conv.estadosDisp.length) {
    const quais = [];
    if (adicionar.length) quais.push('👉 *Eu mesmo te adiciono em:*\n' + lista(adicionar.map(g => g.nome)));
    if (conv.estadosDisp.length) quais.push('📍 *Grupos de emissões por estado:* cada um recebe as passagens com saída daquele estado. Pergunto quais você quer logo depois.');
    partes.push(quais.join('\n\n') + '\n\n⚠️ *Só conseguimos te adicionar depois que você salvar este número na sua agenda.* Salvou? Responda *SIM*.');
    conv.etapa = 'salvo';
  }
  if (!links.length && !adicionar.length && !conv.estadosDisp.length) partes.push('Você já está em todos os grupos a que tem direito 👍');
  const nota = balcaoNota(conv);
  if (nota) partes.push(nota);
  if (links.length) partes.push('Se algum link não abrir, me responda aqui que eu te ajudo.');
  await new Promise(r => setTimeout(r, 4000));
  await responder(conv, partes.join('\n\n'));
  registrar(conv, 'boas_vindas_grupos', 'links ' + links.length + ', adicionar ' + adicionar.length + ', estados ' + conv.estadosDisp.length);
  gravar();
}

// ── Balcão: aviso de aprovação e de retirada (desde 18/11/2026) ──────────────
// O proxy chama quando o Davi aprova uma verificação no gestor (balcao.js) e
// quando o Tico tira alguém do grupo do Balcão por falta de verificação
// (index.js do painel-cdv). Mensagens saem da conta da inclusão (tico-02).
// Aprovado: já está no grupo → só a confirmação; nunca saiu → link de convite;
// saiu/foi removido (o link não abre) → "salve o número e responda SIM" e a
// inclusão segue pela fila lenta, como no fluxo normal.
const _balcaoAvisados = new Map();   // tipo|telefone → ms (contra clique duplo / rodada repetida)

function _balcaoRepetido(tipo, tel, janelaMs) {
  const k = tipo + '|' + String(tel).slice(-8);
  if (Date.now() - (_balcaoAvisados.get(k) || 0) < janelaMs) return true;
  _balcaoAvisados.set(k, Date.now());
  return false;
}
function _telNorm(t) { let d = String(t || '').replace(/\D/g, ''); if (d.length === 10 || d.length === 11) d = '55' + d; return d.length >= 12 ? d : ''; }

export function avisarBalcaoAprovadoCdv({ telefones, nome }) {
  const e = E();
  const tels = [...new Set((telefones || []).map(_telNorm).filter(Boolean))];
  if (!tels.length) return { ok: false, erro: 'telefone inválido' };
  const conta = e.config.conta;
  if (!e.config.ativo) return { ok: false, erro: 'inclusão pelo WhatsApp desligada (/cdv/inclusao/config)' };
  if (!_d.contaConectada || !_d.contaConectada(conta)) {
    avisarOperador('*Balcão — aprovação sem aviso* ⚠️\n\n' + (nome || '+' + tels[0]) + ' foi aprovado(a) no Balcão, mas o ' + conta
      + ' está desconectado. Avise a pessoa e inclua no grupo manualmente.');
    return { ok: false, erro: conta + ' desconectado: avisei o grupo do operador' };
  }
  if (_balcaoRepetido('aprovado', tels[0], 10 * MS_MIN)) return { ok: true, repetido: true };
  _avisarAprovado(tels, nome || '').catch(err => {
    console.warn('[INCLUSAO] Balcão aprovado: ' + err.message);
    avisarOperador('*Balcão — aprovação sem aviso* ⚠️\n\n' + (nome || '+' + tels[0]) + ': ' + err.message);
  });
  return { ok: true, agendado: true, conta, telefone: tels[0] };
}

async function _avisarAprovado(tels, nome) {
  const e = E();
  // Primeiro telefone com direito ao grupo do Balcão; senão, o primeiro que respondeu.
  let escolhido = null, primeiro = null, ultimoErro = null;
  for (const tel of tels) {
    let d;
    try { d = await _d.proxy('/cdv/inclusao/consultar', { telefone: tel }); } catch (err) { ultimoErro = err; continue; }
    const g = (d.grupos || []).find(x => x.balcao) || null;
    if (!primeiro) primeiro = { tel, d, g };
    if (g && g.direito) { escolhido = { tel, d, g }; break; }
  }
  if (!primeiro) throw new Error('consulta ao proxy falhou' + (ultimoErro ? ': ' + ultimoErro.message : ''));
  const { tel, d, g } = escolhido || primeiro;
  const pn = primeiroNome(d.nome || nome);
  const jid = await _d.jidDoTelefone(tel);
  const abertura = 'Oi' + (pn ? ', ' + pn : '') + '! Sua verificação do *Balcão do Clube do Viajante* foi aprovada ✅';
  const existente = e.conversas[jid];
  const conv = (existente && existente.etapa !== 'fim') ? existente
    : { jid, conta: e.config.conta, telefone: tel, nome: d.nome || nome, etapa: 'fim', tentativas: 0, criadoEm: Date.now(), atualizadoEm: Date.now(), origem: 'balcao-aprovado' };
  conv.atualizadoEm = Date.now();
  if (!g || !g.direito) {
    conv.etapa = 'fim';
    e.conversas[jid] = conv;
    await responder(conv, abertura + '\n\nPara entrar no grupo do Balcão você precisa estar com a assinatura do Clube ativa. Assim que estiver, é só me mandar aqui: *Quero entrar nos grupos do Clube do Viajante*');
    registrar(conv, 'balcao_aprovado_sem_direito', d.situacao || null);
    await avisarOperador('*Balcão — aprovado sem assinatura que dá o grupo* ⚠️\n\n' + rotuloPessoa(conv) + ' teve a verificação aprovada, mas hoje não tem direito ao grupo do Balcão (situação: '
      + ((g && g.situacao) || d.situacao || '?') + '). Mandei a aprovação e pedi para chamar quando a assinatura estiver ativa.');
    gravar();
    return;
  }
  let presentes = null;
  try { presentes = await _d.jaEsta(tel, [g.jid]); } catch (err) { presentes = null; }
  if (presentes && presentes.has(g.jid)) {
    if (conv.etapa === 'fim') e.conversas[jid] = conv;
    await responder(conv, abertura + '\n\nVocê já está no grupo do Balcão, então está tudo certo 👍');
    registrar(conv, 'balcao_aprovado_ja_esta');
    gravar();
    return;
  }
  // Já está na fila de inclusão por outro pedido: o Balcão entra junto.
  const naFila = e.fila.find(f => f.jid === jid);
  if (naFila) {
    if (!naFila.grupos.some(x => x.jid === g.jid)) naFila.grupos.push({ jid: g.jid, nome: g.nome });
    await responder(conv, abertura + '\n\nVocê já está na fila de inclusão; coloquei o grupo do Balcão junto. Te aviso aqui quando terminar.');
    registrar(conv, 'balcao_aprovado_na_fila');
    gravar();
    return;
  }
  let removido = !!(g.removidoPeloTico || g.exAluno);
  if (!removido) { try { removido = await _d.removidoPorAdmin(tel, g.jid); } catch (err) {} }
  let link = null;
  if (!removido) { try { link = await _d.linkConvite(g.jid); } catch (err) { link = null; } }
  if (link) {
    conv.etapa = 'boas_vindas';   // "o link não abre" → segue para a inclusão normal
    e.conversas[jid] = conv;
    await responder(conv, abertura + '\n\nAgora é só tocar no link para entrar no grupo do Balcão:\n' + link + '\n\nSe o link não abrir, me responda aqui que eu te ajudo.');
    registrar(conv, 'balcao_aprovado_link');
    gravar();
    return;
  }
  conv.etapa = 'salvo';
  conv.tentativas = 0;
  conv.fixos = [{ jid: g.jid, nome: g.nome }];
  conv.estadosDisp = [];
  conv.balcao = { verificado: true, pendente: false, jaEsta: false, formulario: '' };
  e.conversas[jid] = conv;
  await responder(conv, abertura + '\n\n' + (removido
      ? 'Como você já tinha saído do grupo do Balcão antes, o WhatsApp não deixa voltar pelo link, então eu mesmo te adiciono.'
      : 'Eu mesmo te adiciono no grupo do Balcão.')
    + '\n\n⚠️ *Só conseguimos te adicionar depois que você salvar este número na sua agenda.*\n\nSalvou? Responda *SIM*.');
  registrar(conv, 'balcao_aprovado_inclusao', removido ? 'removido antes' : 'sem link');
  gravar();
}

export function avisarBalcaoRemovidoCdv({ telefone, nome, grupo, formulario }) {
  const e = E();
  const tel = _telNorm(telefone);
  if (!tel) return { ok: false, erro: 'telefone inválido' };
  const conta = e.config.conta;
  if (!_d.contaConectada || !_d.contaConectada(conta)) return { ok: false, erro: conta + ' desconectado' };
  if (_balcaoRepetido('removido', tel, 24 * MS_H)) return { ok: true, repetido: true };
  (async () => {
    const jid = await _d.jidDoTelefone(tel);
    const pn = primeiroNome(nome);
    const conv = e.conversas[jid] && e.conversas[jid].etapa !== 'fim' ? e.conversas[jid]
      : { jid, conta, telefone: tel, nome: nome || '', etapa: 'fim', tentativas: 0, criadoEm: Date.now(), atualizadoEm: Date.now(), origem: 'balcao-removido' };
    await responder(conv, 'Oi' + (pn ? ', ' + pn : '') + '! Você foi retirado(a) do grupo ' + (grupo ? '*' + grupo + '*' : 'do *Balcão*')
      + ' porque ainda não encontramos a sua verificação do Balcão aprovada. O Balcão é só para membros verificados, para a segurança de todos nas negociações.\n\n'
      + '*Para voltar:*\n'
      + '1️⃣ Preencha o formulário de verificação' + (formulario ? ': ' + formulario : ' (me peça o link por aqui)') + '\n'
      + '2️⃣ Aguarde a análise (até 5 dias úteis)\n'
      + '3️⃣ Assim que for aprovada, eu te aviso aqui e te coloco de volta no grupo\n\n'
      + '⚠️ Já deixe este número salvo na sua agenda: sem isso o WhatsApp não deixa eu te adicionar.\n\n'
      + 'Se você já preencheu o formulário, é só aguardar a análise.');
    registrar(conv, 'balcao_removido_aviso', grupo || null);
    gravar();
  })().catch(err => console.warn('[INCLUSAO] Aviso de retirada do Balcão: ' + err.message));
  return { ok: true, agendado: true };
}

// ── Fila lenta ───────────────────────────────────────────────────────────────
async function ciclo() {
  if (_rodando) return;
  _rodando = true;
  try {
    const e = E();
    try { await processarBoasVindas(); } catch (err) { console.warn('[INCLUSAO] Boas-vindas: ' + err.message); }
    if (e.atual) { await acompanhar(); return; }
    if (!e.config.ativo || e.pausado || !e.fila.length) return;
    const h = horaSP();
    if (h < e.config.janelaIni || h >= e.config.janelaFim) return;
    const hoje = hojeE();
    if (hoje.pessoas.length >= e.config.maxPessoasDia) return;
    const item = e.fila[0];
    const r = await _d.criarTarefa(item.telefone, item.grupos.map(g => g.jid), e.config.pausaGrupoMs);
    if (r.status === 202 && r.body && r.body.jobId) {
      e.fila.shift();
      e.atual = { ...item, jobId: r.body.jobId, iniciadoEm: new Date().toISOString() };
      hoje.pessoas.push(item.telefone);
      gravar();
      return;
    }
    const cod = r.body && r.body.codigo;
    if (r.status === 409 || r.status === 503 || r.status === 429) return;   // outra tarefa, conta fora ou limite: tenta depois
    e.fila.shift();
    const conv = e.conversas[item.jid];
    if (conv) conv.etapa = 'aguardando_equipe';
    E().historico.push({ em: new Date().toISOString(), telefone: item.telefone, evento: 'nao_iniciou', detalhe: (r.body && r.body.erro) || String(r.status) });
    gravar();
    await avisarOperador('*Inclusão nos grupos não começou* ⚠️\n\n+' + item.telefone + (item.nome ? ' (' + item.nome + ')' : '') + ': '
      + ((r.body && r.body.erro) || 'status ' + r.status) + (cod === 'sem-mensagem' ? '\n\nA conversa passou de 3 dias: a pessoa precisa mandar a mensagem de novo.' : ''));
  } catch (err) { console.warn('[INCLUSAO] Ciclo: ' + err.message); }
  finally { _rodando = false; }
}

async function acompanhar() {
  const e = E();
  const a = e.atual;
  const j = _d.tarefa(a.jobId);
  if (!j) {   // tarefa sumiu (deploy no meio): devolve para a frente da fila
    e.fila.unshift({ id: a.id, jid: a.jid, conta: a.conta, telefone: a.telefone, nome: a.nome, grupos: a.grupos, criadoEm: a.criadoEm });
    e.atual = null; gravar(); return;
  }
  if (j.estado === 'rodando') return;
  e.atual = null;
  const res = j.resultados || [];
  const ok = res.filter(x => x.estado === 'ok' || x.estado === 'pulado').map(x => x.nome);
  const convites = res.filter(x => x.estado === 'convite-enviado').map(x => x.nome);
  const falhas = res.filter(x => !['ok', 'pulado', 'convite-enviado'].includes(x.estado));
  const tudo = res.map(x => String(x.detalhe || '')).join(' ') + ' ' + String(j.erro || '');
  const suspenso = /\blocked\b|suspen|banid|banned/i.test(tudo);
  const caiu = /caiu/i.test(String(j.erro || ''));
  if (suspenso || caiu) {
    e.pausado = { em: new Date().toISOString(), motivo: suspenso ? 'grupo suspenso' : 'conta caiu no meio da inclusão' };
    await avisarOperador('*Inclusão nos grupos PAUSADA* 🚨\n\n' + (suspenso ? 'Um grupo apareceu suspenso' : 'A conta caiu') + ' durante a inclusão de +' + a.telefone
      + (a.nome ? ' (' + a.nome + ')' : '') + '.\n' + (j.erro ? 'Erro: ' + j.erro + '\n' : '')
      + falhas.map(f => '• ' + f.nome + ': ' + (f.detalhe || f.estado)).join('\n')
      + '\n\nNinguém mais é incluído até retomar (POST /cdv/inclusao/retomar ou na tela de gestão).');
  }
  const conv = e.conversas[a.jid] || { jid: a.jid, conta: a.conta, telefone: a.telefone };
  conv.etapa = 'fim';
  conv.atualizadoEm = Date.now();
  const partes = [];
  if (ok.length) partes.push('Pronto! Você está nestes grupos:\n' + lista(ok));
  if (convites.length) partes.push('Para estes, o WhatsApp pediu um convite: mandei aqui na conversa, é só tocar em *Entrar no grupo*:\n' + lista(convites));
  if (falhas.length) partes.push('Não consegui te adicionar em:\n' + lista(falhas.map(f => f.nome)) + '\nA equipe já foi avisada e vai resolver.');
  const nota = balcaoNota(conv);
  if (nota) partes.push(nota);
  if (partes.length) await responder(conv, partes.join('\n\n'));
  E().historico.push({ em: new Date().toISOString(), telefone: a.telefone, evento: 'concluido',
    detalhe: 'ok ' + ok.length + ', convites ' + convites.length + ', falhas ' + falhas.length });
  if (falhas.length && !suspenso && !caiu) {
    await avisarOperador('*Inclusão nos grupos com falha* ⚠️\n\n+' + a.telefone + (a.nome ? ' (' + a.nome + ')' : '') + ':\n'
      + falhas.map(f => '• ' + f.nome + ': ' + (f.detalhe || f.estado)).join('\n'));
  }
  gravar();
}

// ── Operação (rotas do server.js) ────────────────────────────────────────────
export function estadoInclusaoCdv() {
  const e = E();
  const conversas = Object.values(e.conversas).sort((a, b) => (b.atualizadoEm || 0) - (a.atualizadoEm || 0)).slice(0, 100)
    .map(c => ({ telefone: c.telefone, nome: c.nome || c.pushName || '', etapa: c.etapa, email: c.email || null,
      atualizadoEm: c.atualizadoEm ? new Date(c.atualizadoEm).toISOString() : null }));
  return { config: { ...e.config }, pausado: e.pausado, atual: e.atual, fila: e.fila, hoje: hojeE(), conversas,
    boasVindasAgendadas: (e.boasVindas || []).map(b => ({ telefone: b.telefone, nome: b.nome, premium: b.premium,
      quando: new Date(b.quando).toISOString(), tentativas: b.tentativas })),
    historico: (e.historico || []).slice(-50).reverse(), mensagemGatilho: 'Quero entrar nos grupos do Clube do Viajante' };
}
export function configurarInclusaoCdv(p) {
  const e = E();
  const c = { ...e.config };
  if (typeof p.ativo === 'boolean') c.ativo = p.ativo;
  if (p.conta) c.conta = String(p.conta).trim();
  if (Number.isFinite(Number(p.maxPessoasDia))) c.maxPessoasDia = Math.max(1, Math.min(30, Math.round(Number(p.maxPessoasDia))));
  if (Array.isArray(p.pausaGrupoMs) && p.pausaGrupoMs.length === 2) {
    const [a, b] = p.pausaGrupoMs.map(Number);
    if (a >= 45000 && b >= a && b <= 900000) c.pausaGrupoMs = [a, b];
  }
  e.config = c; gravar();
  return { ...c };
}
export function retomarInclusaoCdv() { E().pausado = null; gravar(); setTimeout(() => ciclo().catch(() => {}), 2000); }
export function pausarInclusaoCdv(motivo) { E().pausado = { em: new Date().toISOString(), motivo: motivo || 'manual' }; gravar(); }
export function removerDaFilaInclusaoCdv(id) {
  const e = E(); const antes = e.fila.length;
  e.fila = e.fila.filter(f => f.id !== id);
  gravar();
  return antes !== e.fila.length;
}
export function reiniciarConversaInclusaoCdv(telefone) {
  const d = String(telefone || '').replace(/\D/g, '');
  const e = E(); let n = 0;
  for (const [k, c] of Object.entries(e.conversas)) if (c.telefone && (c.telefone.endsWith(d.slice(-8)))) { delete e.conversas[k]; n++; }
  gravar();
  return n;
}

export function iniciarInclusaoCdv(deps) {
  _d = deps || {};
  _E = null;
  E();
  setInterval(() => { ciclo().catch(() => {}); }, 60e3).unref?.();
  setTimeout(() => { ciclo().catch(() => {}); }, 3 * 60e3).unref?.();
  console.log('[INCLUSAO] Inclusão nos grupos do CDV pelo WhatsApp: ' + (E().config.ativo ? 'ligada' : 'desligada') + ' na conta ' + E().config.conta
    + ' (' + E().fila.length + ' na fila).');
}
