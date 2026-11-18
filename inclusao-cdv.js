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

const MS_MIN = 60e3, MS_H = 3600e3;
const CONVERSA_TTL = 48 * MS_H;
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
    const conv = e.conversas[jid];
    const ativa = conv && conv.etapa !== 'fim' && Date.now() - (conv.atualizadoEm || 0) < CONVERSA_TTL;
    const gatilho = RE_GATILHO.test(norm(texto));
    if (!gatilho && !ativa) return false;
    tratar(apelido, sock, msg, jid, texto, gatilho).catch(err => console.warn('[INCLUSAO] Conversa: ' + err.message));
    return true;
  } catch (err) { console.warn('[INCLUSAO] ' + err.message); return false; }
}

async function responder(conv, texto) {
  try { await _d.enviar(conv.conta, conv.jid, texto); conv.ultimaRespostaEm = Date.now(); }
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
    } else if (conv.etapa === 'aguardando_equipe') {
      if (Date.now() - (conv.ultimaRespostaEm || 0) > 2 * MS_H) await responder(conv, 'A equipe já foi avisada e vai te responder por aqui. Se quiser tentar com outro e-mail, mande o e-mail da compra.');
      if (RE_EMAIL.test(texto)) { conv.etapa = 'email'; await etapaEmail(conv, texto); }
    }
  } finally { gravar(); }
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
  const inicio = atualizado ? 'Pronto, atualizei seu cadastro com este número.' : 'Oi' + (pn ? ', ' + pn : '') + '! Encontrei seu acesso.';
  if (!conv.fixos.length && !conv.estadosDisp.length) {
    conv.etapa = 'fim';
    registrar(conv, 'ja_esta_em_todos');
    await responder(conv, inicio + ' Você já está em todos os grupos a que tem direito 👍' + (notaBalcao ? '\n\n' + notaBalcao : ''));
    return;
  }
  conv.etapa = 'salvo';
  conv.tentativas = 0;
  const partes = [inicio];
  if (conv.fixos.length) partes.push('Vou te adicionar nestes grupos:\n' + lista(conv.fixos.map(g => g.nome)));
  if (conv.estadosDisp.length) partes.push((conv.fixos.length ? 'E' : 'Você') + ' também pode entrar nos grupos de emissões por estado (vou perguntar quais logo depois).');
  partes.push('⚠️ *Só conseguimos te adicionar depois que você salvar este número na sua agenda.*\n\nSalvou? Responda *SIM*.');
  await responder(conv, partes.join('\n\n'));
}

function balcaoNota(conv) {
  const b = conv.balcao;
  if (!b || b.verificado || b.jaEsta) return '';
  if (b.pendente) return 'Sobre o Balcão: sua verificação está em análise. Assim que for aprovada, você entra no grupo.';
  return 'Sobre o Balcão: para entrar nele é preciso antes preencher o formulário de verificação' + (b.formulario ? ': ' + b.formulario : '') + '. Depois da aprovação, você entra no grupo.';
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

// ── Fila lenta ───────────────────────────────────────────────────────────────
async function ciclo() {
  if (_rodando) return;
  _rodando = true;
  try {
    const e = E();
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
