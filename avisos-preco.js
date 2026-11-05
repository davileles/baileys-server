// ═══════════════════════════════════════════════════════════════════════════
// avisos-preco.js — Avisos de preço no privado para clientes do Tica Promos.
//
// O cliente cola o link de um produto que quer comprar na página
// ticapromos.com.br/avisos/, diz o preço que espera pagar e ativa os avisos
// mandando uma mensagem pronta (com o número do pedido) para o número dos
// avisos. A partir daí o servidor lê o preço de tempos em tempos e manda uma
// mensagem no privado quando ele cai — principalmente quando chega no alvo.
//
// Regras que não podem quebrar:
//   1. Ninguém recebe mensagem antes de falar com a gente primeiro. O pedido
//      nasce "aguardando" e só vira "ativo" quando chega a mensagem do cliente
//      no número dos avisos. Sem número configurado, nada sai.
//   2. O número dos avisos é exclusivo (apelido aviso-*): DM em volume é o que
//      derruba número, e nenhum número que dispara grupo pode correr esse risco.
//   3. "SAIR" cancela tudo daquele contato, na hora.
//   4. Uma mensagem de aviso por pessoa por dia, só dentro da janela.
//   5. O preço é relido na montagem da mensagem: se não confirmar, não sai.
//
// Lojas com leitura de preço: Amazon, Mercado Livre e Shopee (as mesmas do
// monitor de preços). A leitura usa lerPrecoProduto do monitor-precos.js, sem
// gravar na série dele.
//
// Dados (telefones) em sessao/avisos_preco.json, sincronizado com
// davileles/dados/tsp/ (repo privado). Nunca em repo público.
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { createHash } from 'crypto';
import { agendarPush } from './sync-github.js';
import { lerPrecoProduto, lerPrecosAmazonEmLote, estatisticas as estatisticasMonitor } from './monitor-precos.js';
import { resolverLinhaVitrine, buscarProdutos as buscarProdutosAmazon, normalizar as normalizarAmazon } from './radar-amazon.js';
import { ehLinkShopee, extrairIdsShopee, buscarProdutoShopee, normalizarShopee, credenciaisShopeeOk } from './radar-shopee.js';
import { ehLinkMl, resolverLinhaVitrineMl, buscarDadosProdutoMl, tokenAffOk } from './radar-ml.js';

const SESSAO_DIR = './sessao';
const ARQ = 'avisos_preco.json';
const TZ_SP = 'America/Sao_Paulo';
const MS_H = 3600000, MS_DIA = 86400000;

const CFG_PADRAO = {
  ativo: true,
  // Apelido da conta que manda os avisos e recebe as ativações. Vazio = a
  // página aceita pedidos e mostra "ativação em breve"; nada é enviado.
  conta: '',
  // Número que aparece na página e no link wa.me (só dígitos, com 55).
  // Vazio = o servidor tenta ler da própria conta conectada.
  numeroPublico: '',
  limitePorCliente: 5,
  janelaIni: 9,          // hora SP (inclusive)
  janelaFim: 21,         // hora SP (exclusive)
  avisosPorDia: 1,       // por pessoa
  ativacaoDias: 7,       // pedido aguardando ativação expira depois disso
  validadeDias: 90,      // pedido ativo encerra sozinho depois disso
  // Sem preço desejado: avisa quando cair pelo menos isto contra o preço do pedido.
  quedaSemAlvoPct: 10,
  // Com preço desejado ainda não alcançado: avisa uma queda parcial deste tamanho.
  avisarQuedaParcial: true,
  quedaParcialPct: 10,
  // Depois de um aviso, o próximo só sai se cair mais isto contra o avisado.
  novaQuedaPct: 3,
  // De quanto em quanto tempo cada loja é relida (horas).
  intervaloHoras: { 'Amazon': 3, 'Shopee': 3, 'Mercado Livre': 4 },
  // Espaço entre duas mensagens de aviso (segundos), para não sair em rajada.
  espacoEntreEnviosS: [25, 50],
};

const RE_ATIVAR = /pedido\s*n?[ºo°.]?\s*#?\s*(\d{4,6})/i;
const RE_SAIR = /^\s*(sair|parar|pare|cancelar|cancela|stop|descadastrar)\s*[.!]?\s*$/i;
// SAIR 2: para só o alerta 2 da lista que o MEUS ALERTAS mostrou.
const RE_SAIR_UM = /^\s*(?:sair|parar|pare|cancelar|cancela|stop)\s*#?\s*(\d{1,2})\s*[.!]?\s*$/i;
const RE_MEUS = /^\s*(?:meus|minhas|ver)?\s*(?:alertas?|avisos?|lista)(?:\s+de\s+pre[cç]os?)?\s*[.!?]?\s*$/i;
const RE_URL = /https?:\/\/[^\s<>"']+/i;
const RE_OK = /^\s*(ok|okay|sim|pode|isso|beleza|blz|fechado|confirmo|confirmar|quero)\s*[.!]*\s*$/i;
const RE_SEM_ALVO = /^\s*(qualquer|qualquer\s+queda|sem\s+pre[cç]o|tanto\s+faz)\s*[.!]*\s*$/i;
const SITE_ALERTAS = 'ticapromos.com.br/avisos';
const RE_PCT = /^\s*(?:-\s*)?(\d{1,2}(?:[.,]\d+)?)\s*%\s*(?:abaixo|de\s+desconto|off|a\s+menos)?\s*[.!]?\s*$/i;

let _estado = null;
let _deps = {};
let _timerGravar = null;
const _filaEnvio = [];
let _enviando = false;
let _ultimoEnvioEm = 0;
const _ultimaRespostaPorJid = new Map();
const _previaCache = new Map();
const _limiteIp = new Map();
let _varrendo = false;
let _ultimaVarredura = null;

// ── Persistência ─────────────────────────────────────────────────────────────
function caminho() { return SESSAO_DIR + '/' + ARQ; }
function clonar(o) { return JSON.parse(JSON.stringify(o)); }

function estruturar(bruto) {
  const e = bruto && typeof bruto === 'object' ? bruto : {};
  const cfg = { ...clonar(CFG_PADRAO), ...(e.config || {}) };
  cfg.intervaloHoras = { ...CFG_PADRAO.intervaloHoras, ...((e.config || {}).intervaloHoras || {}) };
  return {
    config: cfg,
    seq: Number(e.seq) || 0,
    pedidos: Array.isArray(e.pedidos) ? e.pedidos : [],
    produtos: e.produtos && typeof e.produtos === 'object' ? e.produtos : {},
    contatos: Array.isArray(e.contatos) ? e.contatos : [],
    envios: Array.isArray(e.envios) ? e.envios : [],
  };
}

export function carregarAvisosPreco() {
  try {
    _estado = estruturar(existsSync(caminho()) ? JSON.parse(readFileSync(caminho(), 'utf-8')) : null);
  } catch (e) {
    console.warn('[AVISOS] Falha ao ler ' + ARQ + ': ' + e.message);
    if (!_estado) _estado = estruturar(null);
  }
  return _estado;
}

function E() { if (!_estado) carregarAvisosPreco(); return _estado; }

function gravar() {
  clearTimeout(_timerGravar);
  _timerGravar = setTimeout(() => {
    try {
      if (!existsSync(SESSAO_DIR)) mkdirSync(SESSAO_DIR, { recursive: true });
      const tmp = caminho() + '.tmp';
      writeFileSync(tmp, JSON.stringify(E(), null, 1));
      renameSync(tmp, caminho());
      agendarPush(ARQ);
    } catch (e) { console.error('[AVISOS] Falha ao gravar: ' + e.message); }
  }, 1500);
}

// ── Utilitários ──────────────────────────────────────────────────────────────
function horaSP(ts = Date.now()) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ_SP, hour: '2-digit', hour12: false }).format(ts)) % 24;
}
function diaSP(ts = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ_SP }).format(ts);
}
function brl(v) {
  const n = Number(v);
  return Number.isFinite(n) ? 'R$ ' + n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
}
function arred(v) { return Math.round(Number(v) * 100) / 100; }
function dentroDaJanela(ts = Date.now()) {
  const c = E().config, h = horaSP(ts);
  return h >= c.janelaIni && h < c.janelaFim;
}
function ehFinal(st) { return st === 'cancelado' || st === 'expirado' || st === 'encerrado' || st === 'removido'; }

// Telefone brasileiro em dígitos com 55. Devolve null se não parecer telefone.
export function normalizarTelefone(t) {
  let d = String(t || '').replace(/\D+/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 10 || d.length === 11) d = '55' + d;
  if (!/^55\d{10,11}$/.test(d)) return null;
  return d;
}
// O 9º dígito some em algumas contas antigas: compara as duas formas.
function variantesTelefone(d) {
  const s = String(d || '').replace(/\D+/g, '');
  const out = new Set();
  if (!s) return out;
  out.add(s);
  if (/^55\d{2}9\d{8}$/.test(s)) out.add(s.slice(0, 4) + s.slice(5));
  if (/^55\d{2}\d{8}$/.test(s)) out.add(s.slice(0, 4) + '9' + s.slice(4));
  return out;
}
function digitosDeJid(v) {
  const s = String(v || '');
  if (!s || s.endsWith('@lid') || s.endsWith('@g.us')) return null;
  const d = s.split('@')[0].split(':')[0].replace(/\D+/g, '');
  return d.length >= 10 ? d : null;
}
function mascarar(d) {
  const s = String(d || '');
  return s.length >= 8 ? s.slice(0, 4) + '•••••' + s.slice(-3) : s;
}
function hashIp(ip) { return createHash('sha256').update(String(ip || '')).digest('hex').slice(0, 16); }

function textoDaMensagem(msg) {
  const m = msg?.message || {};
  const em = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m;
  return String(em.conversation || em.extendedTextMessage?.text || em.imageMessage?.caption || '').trim();
}

function novoCodigo() {
  const usados = new Set(E().pedidos.filter(p => !ehFinal(p.status)).map(p => p.codigo));
  for (let i = 0; i < 200; i++) {
    const n = String(1000 + Math.floor(Math.random() * 9000));
    if (!usados.has(n)) return n;
  }
  for (let i = 0; i < 200; i++) {
    const n = String(10000 + Math.floor(Math.random() * 90000));
    if (!usados.has(n)) return n;
  }
  throw new Error('sem código livre');
}

// ── Contatos ativados ────────────────────────────────────────────────────────
// Um contato é quem já mandou mensagem para o número dos avisos. Guardamos o
// JID da conversa (para onde responder) e os números conhecidos dele (para
// reconhecer um pedido novo do mesmo telefone sem pedir nova ativação).
function contatoPorJid(jid) { return E().contatos.find(c => c.jid === jid) || null; }
function contatoPorTelefone(tel) {
  const vs = variantesTelefone(tel);
  if (!vs.size) return null;
  return E().contatos.find(c => !c.saiuEm && (c.numeros || []).some(n => vs.has(n))) || null;
}
function registrarContato(jid, numeros, nome) {
  let c = contatoPorJid(jid);
  if (!c) {
    for (const n of numeros) { c = contatoPorTelefone(n); if (c) break; }
  }
  if (!c) { c = { jid, numeros: [], criadoEm: new Date().toISOString() }; E().contatos.push(c); }
  c.jid = jid;
  for (const n of numeros) for (const v of variantesTelefone(n)) if (!c.numeros.includes(v)) c.numeros.push(v);
  if (nome && !c.nome) c.nome = String(nome).slice(0, 60);
  c.ultimaMensagemEm = new Date().toISOString();
  c.saiuEm = null;
  return c;
}

function pedidosDoContato(c) {
  if (!c) return [];
  return E().pedidos.filter(p => p.jid === c.jid
    || (p.status === 'aguardando' && (c.numeros || []).some(n => variantesTelefone(p.telefone).has(n))));
}

// ── Produtos ─────────────────────────────────────────────────────────────────
function chaveDoItem(item) { return item.asin; }

function guardarProduto(item, leitura) {
  const k = chaveDoItem(item);
  const p = E().produtos[k] || { criadoEm: new Date().toISOString(), dias: {} };
  p.asin = item.asin; p.loja = item.loja; p.url = item.url || p.url || '';
  if (item.shopId) p.shopId = String(item.shopId);
  if (item.itemId) p.itemId = String(item.itemId);
  if (leitura?.titulo || item.nome) p.titulo = String(leitura?.titulo || item.nome || p.titulo || '').slice(0, 200);
  if (leitura?.imagem) p.imagem = leitura.imagem;
  if (leitura && Number.isFinite(Number(leitura.preco)) && Number(leitura.preco) > 0) {
    registrarLeitura(p, leitura);
  }
  E().produtos[k] = p;
  return p;
}

function registrarLeitura(p, leitura) {
  const preco = arred(leitura.preco);
  p.ult = { preco, precoDe: leitura.precoDe ? arred(leitura.precoDe) : null, em: new Date().toISOString(), disponivel: leitura.disponivel !== false };
  const d = diaSP();
  p.dias = p.dias || {};
  if (!(d in p.dias) || preco < p.dias[d]) p.dias[d] = preco;
  const corte = diaSP(Date.now() - 95 * MS_DIA);
  for (const k of Object.keys(p.dias)) if (k < corte) delete p.dias[k];
  // Leituras recentes (para a régua da página antes de juntar dias): entra
  // quando o preço muda ou passou 3 h da última; guarda as 60 últimas.
  p.leituras = Array.isArray(p.leituras) ? p.leituras : [];
  const ul = p.leituras[p.leituras.length - 1];
  if (!ul || ul.p !== preco || Date.now() - Date.parse(ul.em) >= 3 * MS_H) {
    p.leituras.push({ em: p.ult.em, p: preco });
    if (p.leituras.length > 60) p.leituras = p.leituras.slice(-60);
  }
  p.lidoEm = p.ult.em;
  p.falhas = 0; p.falhaMotivo = null;
}

function itemDoProduto(p) {
  return { asin: p.asin, loja: p.loja, url: p.url, shopId: p.shopId || null, itemId: p.itemId || null, nome: p.titulo || '' };
}

// Histórico de preço para a sugestão realista: série do monitor (se o produto
// já está vigiado) + a nossa própria série de avisos.
function historicoParaSugestao(asin) {
  const out = { min90: null, mediana30: null, dias: 0, fonte: null };
  try {
    const st = estatisticasMonitor(asin);
    if (st && st.dias >= 7) {
      out.min90 = st.min90; out.mediana30 = st.mediana30; out.dias = st.dias; out.fonte = 'monitor';
    }
  } catch (e) {}
  const p = E().produtos[asin];
  if (p?.dias) {
    const corte = diaSP(Date.now() - 90 * MS_DIA);
    const v = Object.entries(p.dias).filter(([d]) => d >= corte).map(([, x]) => x);
    if (v.length >= 7 && (!out.dias || v.length > out.dias)) {
      out.min90 = Math.min(...v); out.dias = v.length; out.fonte = 'avisos';
    }
  }
  return out;
}

export function sugestaoDePreco(precoAtual, hist) {
  const atual = Number(precoAtual);
  if (!(atual > 0)) return null;
  // Menor preço recente, se for uma queda plausível (até 30% abaixo do atual).
  if (hist?.min90 && hist.min90 < atual && hist.min90 >= atual * 0.7) {
    return { valor: arred(Math.floor(hist.min90)), motivo: 'menor preço dos últimos ' + Math.min(90, hist.dias) + ' dias' };
  }
  return { valor: arred(Math.floor(atual * 0.9)), motivo: '10% abaixo do preço atual' };
}

// ── Leitura do link (prévia da página) ──────────────────────────────────────
async function resolverLink(url) {
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) return { erro: 'Cole o link completo do produto (começando com https://).' };

  if (ehLinkShopee(u)) {
    if (!credenciaisShopeeOk()) return { erro: 'Ainda não conseguimos ler produtos da Shopee. Tente mais tarde.' };
    const ids = await extrairIdsShopee(u);
    if (!ids.length) return { erro: 'Esse link da Shopee não é de um produto. Abra o produto e copie o link de novo.' };
    const node = await buscarProdutoShopee(ids[0]);
    if (!node) return { erro: 'Não encontramos esse produto da Shopee. Ele pode estar indisponível.' };
    const p = normalizarShopee(node);
    const item = { asin: 'SHOPEE-' + ids[0].shopId + '-' + ids[0].itemId, loja: 'Shopee',
                   shopId: String(ids[0].shopId), itemId: String(ids[0].itemId),
                   url: node.productLink || node.offerLink || u, nome: p.titulo };
    return { item, leitura: { preco: p.preco, precoDe: p.precoDe, disponivel: p.disponivel, titulo: p.titulo, imagem: p.imagemUrl || null } };
  }

  if (ehLinkMl(u)) {
    if (!tokenAffOk()) return { erro: 'Ainda não conseguimos ler produtos do Mercado Livre. Tente mais tarde.' };
    const r = await resolverLinhaVitrineMl(u);
    if (!r || r.erro) return { erro: 'Não conseguimos identificar esse produto do Mercado Livre. Abra o produto e copie o link de novo.' };
    // O título do card do perfil social vem com o preço colado no fim ("… - R$ 56,09").
    const nomeMl = String(r.nome || '').replace(/\s*[-–|]\s*R\$\s*[\d.,]+\s*$/, '').trim();
    const item = { asin: r.asin, loja: 'Mercado Livre', url: r.url, nome: nomeMl };
    let leitura = null;
    try {
      const l = await lerPrecoProduto(item);
      leitura = { preco: l.preco, precoDe: l.precoDe, disponivel: l.disponivel, titulo: l.titulo || nomeMl };
    } catch (e) { console.warn('[AVISOS] Prévia ML sem preço (' + r.asin + '): ' + e.message); }
    try {
      const d = await buscarDadosProdutoMl(r.url, { id: r.asin });
      if (d?.imagem) leitura = { ...(leitura || {}), imagem: d.imagem };
      if (!leitura?.preco && d?.preco) leitura = { ...(leitura || {}), preco: d.preco, precoDe: d.precoDe, titulo: d.titulo || nomeMl, disponivel: d.disponivel !== false };
    } catch (e) {}
    return { item, leitura };
  }

  // Mesmos domínios do REGEX_URL_AMAZON do radar: inclui os encurtadores
  // amzn.to, amzn.eu, a.co e link.amazon (este último ficava de fora).
  if (/(?:^|\/\/|\.)(?:amazon\.com(?:\.br)?|amzn\.to|amzn\.eu|a\.co|link\.amazon(?:\.com)?)\//i.test(u)) {
    const r = await resolverLinhaVitrine(u);
    if (!r || r.erro) return { erro: 'Não conseguimos identificar esse produto da Amazon. Abra o produto e copie o link de novo.' };
    const brutos = await buscarProdutosAmazon([r.asin]);
    const p = brutos?.[0] ? normalizarAmazon(brutos[0]) : null;
    if (!p) return { erro: 'Esse produto da Amazon não está disponível para acompanhamento.' };
    const item = { asin: r.asin, loja: 'Amazon', url: r.url, nome: p.titulo || r.nome };
    return { item, leitura: { preco: p.preco, precoDe: p.precoDe, disponivel: p.disponivel, titulo: p.titulo, imagem: p.imagemUrl || null } };
  }

  return { erro: 'Por enquanto acompanhamos produtos da Amazon, do Mercado Livre e da Shopee.' };
}

function limitarIp(ip, chave, max, janelaMs) {
  const k = chave + ':' + hashIp(ip);
  const agora = Date.now();
  const v = (_limiteIp.get(k) || []).filter(t => agora - t < janelaMs);
  if (v.length >= max) { _limiteIp.set(k, v); return false; }
  v.push(agora); _limiteIp.set(k, v);
  if (_limiteIp.size > 5000) { const primeira = _limiteIp.keys().next().value; _limiteIp.delete(primeira); }
  return true;
}

export async function previaDoLink(url, ip) {
  if (!E().config.ativo) return { ok: false, erro: 'Os avisos de preço estão pausados no momento.' };
  if (!limitarIp(ip, 'previa', 30, MS_H)) return { ok: false, erro: 'Muitas consultas seguidas. Espere alguns minutos e tente de novo.' };
  const chaveCache = String(url || '').trim();
  const c = _previaCache.get(chaveCache);
  if (c && Date.now() - c.em < 20 * 60000) return c.resp;

  let r;
  try { r = await resolverLink(url); }
  catch (e) {
    console.warn('[AVISOS] Prévia falhou: ' + e.message);
    return { ok: false, erro: 'Não conseguimos ler esse link agora. Tente de novo em instantes.' };
  }
  if (r.erro) return { ok: false, erro: r.erro };
  const { item, leitura } = r;
  const preco = Number(leitura?.preco);
  const hist = historicoParaSugestao(item.asin);
  const resp = {
    ok: true,
    produto: {
      chave: item.asin, loja: item.loja,
      titulo: String(leitura?.titulo || item.nome || '').slice(0, 200),
      imagem: leitura?.imagem || null,
      preco: preco > 0 ? arred(preco) : null,
      disponivel: leitura?.disponivel !== false && preco > 0,
    },
    historico: hist.dias ? { min90: hist.min90, dias: hist.dias } : null,
    sugestao: preco > 0 ? sugestaoDePreco(preco, hist) : null,
  };
  // Guarda o item resolvido para o pedido não precisar ler o link de novo.
  _previaCache.set(chaveCache, { em: Date.now(), resp, item, leitura });
  if (_previaCache.size > 300) _previaCache.delete(_previaCache.keys().next().value);
  return resp;
}

// ── Número dos avisos ────────────────────────────────────────────────────────
export function numeroDosAvisos() {
  const c = E().config;
  if (!c.conta) return null;
  const fixo = normalizarTelefone(c.numeroPublico);
  if (fixo) return fixo;
  try { return normalizarTelefone(_deps.numeroDaConta?.(c.conta)) || null; } catch (e) { return null; }
}

function linkAtivacao(codigo) {
  const n = numeroDosAvisos();
  if (!n) return null;
  // Sem emoji: o wa.me troca caractere fora do plano básico por "�". Igual ao da página.
  const texto = 'Oi, Tico! Quero receber os alertas de preço do Tica Promos (pedido ' + codigo + ')';
  return 'https://wa.me/' + n + '?text=' + encodeURIComponent(texto);
}

export function infoPublica() {
  const c = E().config;
  const n = numeroDosAvisos();
  return {
    ok: true, ativo: !!c.ativo, ativacaoDisponivel: !!n,
    numero: n, numeroFormatado: n ? formatarTelefone(n) : null,
    limitePorCliente: c.limitePorCliente,
  };
}

function formatarTelefone(d) {
  const s = String(d || '');
  const m = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(s);
  return m ? '(' + m[1] + ') ' + m[2] + '-' + m[3] : s;
}

// ── Pedido (formulário) ─────────────────────────────────────────────────────
export async function criarPedido(body, ip) {
  const c = E().config;
  if (!c.ativo) return { ok: false, erro: 'Os avisos de preço estão pausados no momento.' };
  if (body?.site) return { ok: true, codigo: '0000' };   // honeypot: robô preenche
  if (!limitarIp(ip, 'pedido', 12, MS_DIA)) return { ok: false, erro: 'Você já fez muitos pedidos hoje. Tente amanhã.' };

  const nome = String(body?.nome || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  const telefone = normalizarTelefone(body?.telefone);
  const url = String(body?.url || '').trim();
  if (!nome) return { ok: false, erro: 'Diga seu nome.' };
  if (!telefone) return { ok: false, erro: 'Confira o WhatsApp: DDD + número, só números.' };
  if (body?.aceite !== true) return { ok: false, erro: 'Marque que aceita receber os avisos no WhatsApp.' };

  const vsTel = variantesTelefone(telefone);
  const abertos = E().pedidos.filter(p => !ehFinal(p.status) && [...variantesTelefone(p.telefone)].some(v => vsTel.has(v)));
  if (abertos.length >= c.limitePorCliente) {
    return { ok: false, erro: 'Você já acompanha ' + abertos.length + ' produtos, o máximo por pessoa. Para trocar, mande SAIR no WhatsApp e peça de novo.' };
  }
  if (E().pedidos.filter(p => p.status === 'aguardando').length > 2000) {
    return { ok: false, erro: 'Muitos pedidos no momento. Tente de novo mais tarde.' };
  }

  // Pedido pelo NOME: sem link, ou com link que não deu para ler. Fica para
  // avaliação no painel (vincular o link certo depois); não é monitorado até lá.
  const produtoTexto = String(body?.produtoTexto || '').trim().replace(/\s+/g, ' ').slice(0, 200);
  let cache = null;
  if (url) {
    cache = _previaCache.get(url);
    if (!cache || Date.now() - cache.em > 30 * 60000) {
      const prev = await previaDoLink(url, ip);
      if (!prev.ok && !produtoTexto) return prev;
      cache = prev.ok ? _previaCache.get(url) : null;
    }
  }
  const { item, leitura } = cache || {};
  if (!item) {
    if (produtoTexto.length < 3) return { ok: false, erro: url ? 'Não conseguimos ler esse link. Escreva o nome do produto que a gente procura.' : 'Escreva o nome do produto.' };
    return criarPedidoPorNome({ nome, telefone, produtoTexto, url, body, ip, abertos });
  }

  if (abertos.some(p => p.produto === item.asin)) {
    return { ok: false, erro: 'Você já pediu aviso desse produto.' };
  }

  const precoAtual = Number(leitura?.preco) > 0 ? arred(leitura.preco) : null;
  let alvo = body?.precoAlvo === '' || body?.precoAlvo == null ? null : Number(String(body.precoAlvo).replace(/\./g, '').replace(',', '.'));
  if (alvo != null && !(alvo > 0)) alvo = null;
  if (alvo != null && precoAtual && alvo >= precoAtual) alvo = null;   // alvo acima do atual não faz sentido

  guardarProduto(item, leitura);

  const contato = contatoPorTelefone(telefone);
  const codigo = novoCodigo();
  const agora = new Date().toISOString();
  const pedido = {
    id: 'AV' + (++E().seq),
    codigo, nome, telefone,
    produto: item.asin, loja: item.loja,
    titulo: String(leitura?.titulo || item.nome || '').slice(0, 200),
    precoInicial: precoAtual, precoAlvo: alvo != null ? arred(alvo) : null,
    status: contato ? 'ativo' : 'aguardando',
    jid: contato ? contato.jid : null,
    criadoEm: agora, ativadoEm: contato ? agora : null,
    expiraEm: new Date(Date.now() + (contato ? c.validadeDias : c.ativacaoDias) * MS_DIA).toISOString(),
    avisos: [], ultimoAvisoPreco: null, ultimoAvisoEm: null,
    origem: { ipHash: hashIp(ip), utm: String(body?.origem || '').slice(0, 40) || null },
  };
  E().pedidos.push(pedido);
  gravar();
  console.log('[AVISOS] Pedido ' + pedido.id + ' (' + pedido.loja + ' ' + pedido.produto + ', alvo ' + (pedido.precoAlvo ?? '—') + ') — ' + pedido.status + '.');

  if (contato) {
    enfileirarEnvio(contato.jid, 'Pronto! Também vou te avisar quando o preço de *' + encurtar(pedido.titulo, 80) + '* cair'
      + (pedido.precoAlvo ? ' (seu preço: ' + brl(pedido.precoAlvo) + ')' : '') + '. 🔔\n\nPara parar os avisos, responda SAIR.', { resposta: true });
  }

  return respostaAtivacao(pedido, contato);
}

function lerAlvo(body) {
  const v = body?.precoAlvo === '' || body?.precoAlvo == null ? null : Number(String(body.precoAlvo).replace(/\./g, '').replace(',', '.'));
  return v != null && v > 0 ? arred(v) : null;
}

function respostaAtivacao(pedido, contato) {
  const c = E().config;
  return {
    ok: true, id: pedido.id, codigo: pedido.codigo, status: pedido.status,
    porNome: !!pedido.porNome,
    jaAtivo: !!contato,
    ativacao: contato ? null : {
      disponivel: !!numeroDosAvisos(),
      numero: numeroDosAvisos(),
      numeroFormatado: numeroDosAvisos() ? formatarTelefone(numeroDosAvisos()) : null,
      link: linkAtivacao(pedido.codigo),
      expiraDias: c.ativacaoDias,
    },
  };
}

function criarPedidoPorNome({ nome, telefone, produtoTexto, url, body, ip, abertos }) {
  const c = E().config;
  const chave = produtoTexto.toLowerCase();
  if (abertos.some(p => p.porNome && String(p.titulo || '').toLowerCase() === chave)) {
    return { ok: false, erro: 'Você já pediu aviso desse produto.' };
  }
  const contato = contatoPorTelefone(telefone);
  const agora = new Date().toISOString();
  const pedido = {
    id: 'AV' + (++E().seq),
    codigo: novoCodigo(), nome, telefone,
    produto: null, loja: null, porNome: true,
    titulo: produtoTexto, linkInformado: url || null,
    precoInicial: null, precoAlvo: lerAlvo(body),
    status: contato ? 'ativo' : 'aguardando',
    jid: contato ? contato.jid : null,
    criadoEm: agora, ativadoEm: contato ? agora : null,
    expiraEm: new Date(Date.now() + (contato ? c.validadeDias : c.ativacaoDias) * MS_DIA).toISOString(),
    avisos: [], ultimoAvisoPreco: null, ultimoAvisoEm: null,
    origem: { ipHash: hashIp(ip), utm: String(body?.origem || '').slice(0, 40) || null },
  };
  E().pedidos.push(pedido);
  gravar();
  console.log('[AVISOS] Pedido por nome ' + pedido.id + ' ("' + encurtar(produtoTexto, 60) + '"' + (url ? ', link não lido' : '') + ') — ' + pedido.status + '.');
  if (contato) {
    enfileirarEnvio(contato.jid, 'Anotei: *' + encurtar(produtoTexto, 80) + '*' + (pedido.precoAlvo ? ' (seu preço: ' + brl(pedido.precoAlvo) + ')' : '')
      + '. Vou procurar o produto e te aviso por aqui quando aparecer uma boa oferta. 🔔\n\nPara parar os avisos, responda SAIR.', { resposta: true });
  }
  return respostaAtivacao(pedido, contato);
}

// Painel: liga um pedido feito pelo nome (ou com link não lido) a um link de
// produto. A partir daí ele é monitorado como qualquer outro.
export async function vincularLinkPedido(id, url) {
  const p = E().pedidos.find(x => x.id === id);
  if (!p) return { ok: false, erro: 'pedido não encontrado' };
  let r;
  try { r = await resolverLink(url); } catch (e) { return { ok: false, erro: 'falha ao ler o link: ' + e.message }; }
  if (r.erro) return { ok: false, erro: r.erro };
  const prod = guardarProduto(r.item, r.leitura);
  p.produto = r.item.asin; p.loja = r.item.loja;
  if (!p.textoOriginal) p.textoOriginal = p.titulo;
  p.titulo = String(r.leitura?.titulo || r.item.nome || p.titulo).slice(0, 200);
  p.precoInicial = Number(r.leitura?.preco) > 0 ? arred(r.leitura.preco) : null;
  if (p.precoAlvo && p.precoInicial && p.precoAlvo >= p.precoInicial) p.precoAlvo = null;
  p.porNome = false; p.vinculadoEm = new Date().toISOString();
  gravar();
  console.log('[AVISOS] Pedido ' + id + ' vinculado a ' + p.loja + ' ' + p.produto + '.');
  return { ok: true, titulo: p.titulo, loja: p.loja, preco: prod.ult?.preco ?? null };
}

function encurtar(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; }

// ── Mensagens recebidas no número dos avisos ────────────────────────────────
// Chamado do messages.upsert de TODA conta (principal e extras). Só age quando
// a conta é a configurada para os avisos e a conversa é privada.
export function observarMensagemAvisos(apelido, msg) {
  try {
    const c = E().config;
    if (!c.conta || apelido !== c.conta) return;
    const k = msg?.key;
    if (!k || k.fromMe || !msg.message) return;
    const jid = String(k.remoteJid || '');
    if (!jid || jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) return;
    const ts = Number(msg.messageTimestamp?.low ?? msg.messageTimestamp ?? 0) * 1000;
    if (ts && Date.now() - ts > 6 * MS_H) return;   // histórico antigo sincronizado na conexão
    const texto = textoDaMensagem(msg);
    if (!texto) return;

    const numeros = [jid, k.remoteJidAlt, k.senderPn].map(digitosDeJid).filter(Boolean);

    if (RE_SAIR.test(texto)) { tratarSair(jid, numeros); return; }
    const mSairUm = RE_SAIR_UM.exec(texto);
    if (mSairUm) { tratarSairUm(jid, numeros, Number(mSairUm[1])); return; }

    const mCod = RE_ATIVAR.exec(texto);
    const contatoExistente = contatoPorJid(jid) || numeros.map(contatoPorTelefone).find(Boolean) || null;
    let pedidos = [];
    if (mCod) {
      pedidos = E().pedidos.filter(p => p.codigo === mCod[1] && p.status === 'aguardando');
    }
    // Sem código (ou código errado), mas o número bate com pedidos aguardando.
    if (!pedidos.length && numeros.length) {
      const vs = new Set(numeros.flatMap(n => [...variantesTelefone(n)]));
      pedidos = E().pedidos.filter(p => p.status === 'aguardando' && [...variantesTelefone(p.telefone)].some(v => vs.has(v)));
    }
    if (!pedidos.length) {
      if (mCod && !contatoExistente) {
        responder(jid, 'Oi! Não encontrei o pedido ' + mCod[1] + '. Ele pode ter expirado. Faça um novo pedido em ' + SITE_ALERTAS + ' 🙂');
        return;
      }
      // Sem ativação pendente: comandos da conversa (lista, criar por link, ajuda).
      tratarConversa(jid, numeros, texto, msg.pushName, contatoExistente)
        .catch(e => console.warn('[AVISOS] Conversa: ' + e.message));
      return;
    }

    const contato = registrarContato(jid, numeros, pedidos[0].nome);
    // Junta outros pedidos aguardando do mesmo telefone informado.
    const telefones = new Set(pedidos.flatMap(p => [...variantesTelefone(p.telefone)]));
    for (const p of E().pedidos) {
      if (p.status === 'aguardando' && [...variantesTelefone(p.telefone)].some(v => telefones.has(v)) && !pedidos.includes(p)) pedidos.push(p);
    }
    for (const n of telefones) if (!contato.numeros.includes(n)) contato.numeros.push(n);
    const agora = new Date().toISOString();
    for (const p of pedidos) {
      p.status = 'ativo'; p.jid = jid; p.ativadoEm = agora;
      p.expiraEm = new Date(Date.now() + c.validadeDias * MS_DIA).toISOString();
    }
    gravar();
    console.log('[AVISOS] Ativado(s) ' + pedidos.map(p => p.id).join(', ') + ' por ' + mascarar(numeros[0] || jid) + '.');

    const lista = pedidos.map(p => '• ' + encurtar(p.titulo, 70) + (p.precoAlvo ? ' — seu preço: ' + brl(p.precoAlvo) : '')).join('\n');
    responder(jid, 'Pronto! 🔔 Vou te avisar por aqui quando o preço cair:\n\n' + lista
      + '\n\nSalve este número como *Tico — Tica Promos* para não perder nenhum aviso.'
      + '\n\nPor aqui você pode:\n• mandar *MEUS ALERTAS* para ver sua lista;\n• colar o link de outro produto para criar um alerta;\n• responder *SAIR* para parar todos.');
  } catch (e) { console.warn('[AVISOS] Mensagem recebida: ' + e.message); }
}

function tratarSair(jid, numeros) {
  const c = contatoPorJid(jid) || numeros.map(contatoPorTelefone).find(Boolean) || null;
  const vs = new Set(numeros.flatMap(n => [...variantesTelefone(n)]));
  const alvo = E().pedidos.filter(p => !ehFinal(p.status)
    && (p.jid === jid || [...variantesTelefone(p.telefone)].some(v => vs.has(v))));
  if (!c && !alvo.length) return;
  const agora = new Date().toISOString();
  for (const p of alvo) { p.status = 'cancelado'; p.canceladoEm = agora; p.motivoFim = 'cliente mandou SAIR'; }
  if (c) c.saiuEm = agora;
  // Tira a mensagem da fila: quem saiu não recebe mais nada pendente.
  for (let i = _filaEnvio.length - 1; i >= 0; i--) if (_filaEnvio[i].jid === jid && !_filaEnvio[i].resposta) _filaEnvio.splice(i, 1);
  gravar();
  console.log('[AVISOS] SAIR de ' + mascarar(numeros[0] || jid) + ' — ' + alvo.length + ' pedido(s) cancelado(s).');
  responder(jid, 'Feito, todos os seus alertas de preço foram cancelados. Quando quiser voltar, é só colar aqui o link de um produto ou pedir em ' + SITE_ALERTAS + ' 👋', true);
}

// ── Conversa com o Tico (sem IA: comandos fixos) ────────────────────────────
// MEUS ALERTAS → lista numerada; SAIR n → para só aquele; link de produto →
// cria alerta (o Tico pergunta o preço); qualquer outra coisa → ajuda.
const _criacaoPendente = new Map();   // jid → { item, leitura, sugestao, em }
const _respostasPorJid = new Map();   // jid → [ts] (trava contra laço com outro robô)
const _ajudaPorJid = new Map();       // jid → ts da última ajuda a quem não é cliente

function podeConversar(jid) {
  const agora = Date.now();
  const v = (_respostasPorJid.get(jid) || []).filter(t => agora - t < MS_H);
  if (v.length >= 20) { _respostasPorJid.set(jid, v); return false; }
  v.push(agora); _respostasPorJid.set(jid, v);
  if (_respostasPorJid.size > 3000) _respostasPorJid.delete(_respostasPorJid.keys().next().value);
  return true;
}
function falar(jid, texto) { if (podeConversar(jid)) enfileirarEnvio(jid, texto, { resposta: true }); }

// Alertas em aberto de uma pessoa, na ordem em que foram criados (a numeração
// do MEUS ALERTAS e do SAIR n é esta).
function pedidosAbertosDe(jid, numeros, contato) {
  const vs = new Set([...(numeros || []), ...((contato && contato.numeros) || [])].flatMap(n => [...variantesTelefone(n)]));
  return E().pedidos
    .filter(p => !ehFinal(p.status) && ((jid && p.jid === jid) || (contato?.jid && p.jid === contato.jid) || [...variantesTelefone(p.telefone)].some(v => vs.has(v))))
    .sort((a, b) => String(a.criadoEm).localeCompare(String(b.criadoEm)));
}

function linhaDoPedido(p, i) {
  const prod = E().produtos[p.produto] || {};
  const atual = prod.ult?.preco;
  let l = (i + 1) + '. *' + encurtar(p.titulo, 70) + '*' + (p.loja ? ' (' + p.loja + ')' : '');
  const det = [];
  if (p.status === 'aguardando') det.push('aguardando ativação');
  if (p.pausado) det.push('pausado');
  if (p.porNome) det.push('vamos procurar o produto');
  if (atual) det.push('agora ' + brl(atual));
  if (p.precoAlvo) {
    if (atual && atual <= p.precoAlvo) det.push('seu preço ' + brl(p.precoAlvo) + ' ✅');
    else det.push('seu preço ' + brl(p.precoAlvo) + (atual ? ' (faltam ' + brl(atual - p.precoAlvo) + ')' : ''));
  } else if (!p.porNome) det.push('aviso em quedas de ' + E().config.quedaSemAlvoPct + '%');
  if (det.length) l += '\n   ' + det.join(' · ');
  return l;
}

function textoAjuda(temAlertas) {
  return 'Oi! Eu sou o Tico, do Tica Promos 🐦\n\n'
    + 'Por aqui eu entendo só estes pedidos:\n'
    + '• *cole o link* de um produto (Amazon, Mercado Livre ou Shopee) para criar um alerta de preço;\n'
    + (temAlertas ? '• *MEUS ALERTAS* para ver sua lista numerada;\n• *SAIR* + o número do alerta para parar só aquele (ex.: *SAIR 1* para o primeiro da lista);\n• *SAIR* sozinho para parar todos.\n' : '')
    + '\nVocê também pode criar e ver seus alertas em ' + SITE_ALERTAS + '\n'
    + 'Não consigo responder outras perguntas por aqui.';
}

function textoLista(abertos) {
  if (!abertos.length) {
    return 'Você não tem alertas de preço ativos no momento.\n\nPara criar um, cole aqui o link do produto (Amazon, Mercado Livre ou Shopee) ou use ' + SITE_ALERTAS;
  }
  return '🔔 *Seus alertas de preço*\n\n' + abertos.map(linhaDoPedido).join('\n\n')
    + '\n\nPara parar um alerta, responda *SAIR* + o número dele na lista acima (ex.: *SAIR 1*). *SAIR* sozinho para todos.'
    + '\nPara criar outro, cole aqui o link do produto.'
    + '\nVeja a régua de preços de cada um em ' + SITE_ALERTAS;
}

function lerValor(t) {
  let s = String(t || '').trim().replace(/^r\$\s*/i, '').replace(/\s*(reais|conto|pila)\s*$/i, '');
  if (!/^\d[\d.,]*$/.test(s)) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/\.\d{3}$/.test(s)) s = s.replace(/\./g, '');
  const n = Number(s);
  return n > 0 ? arred(n) : null;
}

async function tratarConversa(jid, numeros, texto, pushName, contato) {
  const abertos = pedidosAbertosDe(jid, numeros, contato);
  const ehCliente = !!contato || abertos.length > 0;

  if (RE_MEUS.test(texto)) {
    if (!ehCliente) { falar(jid, textoAjuda(false)); return; }
    falar(jid, textoLista(abertos));
    return;
  }

  // Resposta à pergunta de preço de um alerta que está sendo criado.
  // Mesma linguagem da página: valor em reais, % abaixo do preço de agora,
  // o preço sugerido (OK) ou qualquer queda boa.
  const pend = _criacaoPendente.get(jid);
  if (pend && Date.now() - pend.em > 30 * 60000) _criacaoPendente.delete(jid);
  if (pend && _criacaoPendente.has(jid) && !RE_URL.test(texto)) {
    const atual = Number(pend.leitura?.preco) > 0 ? Number(pend.leitura.preco) : null;
    const exemplo = atual ? String(Math.floor(atual * 0.85)) : '150';
    let alvo;
    if (RE_OK.test(texto) && pend.sugestao) alvo = pend.sugestao.valor;
    else if (RE_SEM_ALVO.test(texto)) alvo = null;
    else {
      const mPct = RE_PCT.exec(texto);
      if (mPct) {
        const pct = Number(mPct[1].replace(',', '.'));
        if (!atual) { falar(jid, 'Como ainda não consegui ler o preço desse anúncio, mande o valor em reais (ex.: ' + exemplo + '), ou *QUALQUER* para ser avisado de qualquer queda boa.'); return; }
        if (!(pct > 0 && pct < 90)) { falar(jid, 'Mande um desconto entre 1% e 89% (ex.: 15%), um valor em reais (ex.: ' + exemplo + ') ou *QUALQUER*.'); return; }
        alvo = arred(Math.floor(atual * (1 - pct / 100) * 100) / 100);
      } else {
        alvo = lerValor(texto);
        if (alvo == null) {
          falar(jid, 'Não entendi. Responda com o valor que você quer pagar (ex.: ' + exemplo + ')'
            + (atual ? ', o desconto em % (ex.: 15%)' : '')
            + (pend.sugestao ? ', *OK* para ' + brl(pend.sugestao.valor) : '')
            + ' ou *QUALQUER* para ser avisado de qualquer queda boa.');
          return;
        }
      }
      if (atual && alvo >= atual) {
        falar(jid, 'Esse valor já é igual ou maior que o preço de agora (' + brl(atual) + '). Mande um valor abaixo disso, ou *QUALQUER* para ser avisado de qualquer queda boa.');
        return;
      }
    }
    _criacaoPendente.delete(jid);
    const r = criarPedidoDaConversa({ jid, numeros, contato, pushName, item: pend.item, leitura: pend.leitura, alvo });
    falar(jid, r.texto);
    return;
  }

  const mUrl = RE_URL.exec(texto);
  if (mUrl) {
    const c = E().config;
    if (!c.ativo) { falar(jid, 'Os alertas de preço estão pausados no momento. Tente de novo mais tarde.'); return; }
    if (abertos.length >= c.limitePorCliente) {
      falar(jid, 'Você já acompanha ' + abertos.length + ' produtos, o máximo por pessoa.\n\n' + textoLista(abertos));
      return;
    }
    if (!limitarIp('wa:' + jid, 'previa-wa', 10, MS_H)) { falar(jid, 'Muitos links seguidos. Espere alguns minutos e tente de novo.'); return; }
    let r;
    try { r = await resolverLink(mUrl[0].replace(/[).,!?]+$/, '')); }
    catch (e) { r = { erro: 'Não consegui ler esse link agora. Tente de novo em instantes.' }; }
    if (r.erro) { falar(jid, r.erro + '\n\nSe preferir, faça o pedido em ' + SITE_ALERTAS); return; }
    if (abertos.some(p => p.produto === r.item.asin)) {
      falar(jid, 'Você já tem alerta para esse produto. Mande *MEUS ALERTAS* para ver sua lista.');
      return;
    }
    const preco = Number(r.leitura?.preco) > 0 ? arred(r.leitura.preco) : null;
    const titulo = String(r.leitura?.titulo || r.item.nome || '').slice(0, 200);
    const sug = preco ? sugestaoDePreco(preco, historicoParaSugestao(r.item.asin)) : null;
    _criacaoPendente.set(jid, { item: r.item, leitura: r.leitura, sugestao: sug, em: Date.now() });
    if (_criacaoPendente.size > 2000) _criacaoPendente.delete(_criacaoPendente.keys().next().value);
    falar(jid, textoPerguntaAlvo(r.item, titulo, preco, sug));
    return;
  }

  // Ajuda: cliente sempre (com trava de laço); quem nunca pediu, no máximo 1x/dia
  // — o número também dispara em grupos e recebe conversa que não é para o Tico.
  if (!ehCliente) {
    const ult = _ajudaPorJid.get(jid) || 0;
    if (Date.now() - ult < MS_DIA) return;
    _ajudaPorJid.set(jid, Date.now());
    if (_ajudaPorJid.size > 5000) _ajudaPorJid.delete(_ajudaPorJid.keys().next().value);
  }
  falar(jid, textoAjuda(ehCliente));
}

// Pergunta do preço desejado, com a mesma régua da página: até 20% abaixo é
// queda comum, 20–30% acontece às vezes, acima de 30% dificilmente chega.
function textoPerguntaAlvo(item, titulo, preco, sug) {
  const l = ['Achei: *' + encurtar(titulo, 100) + '* (' + item.loja + ')'];
  if (preco) {
    l.push('💰 Preço de agora: *' + brl(preco) + '*');
    const h = historicoParaSugestao(item.asin);
    if (h.min90) {
      l.push(h.min90 < preco
        ? '📉 Nos últimos ' + Math.min(90, h.dias) + ' dias o menor preço foi ' + brl(h.min90) + ' (' + Math.round((1 - h.min90 / preco) * 100) + '% abaixo de agora).'
        : '📉 Nos últimos ' + Math.min(90, h.dias) + ' dias ele não ficou mais barato que agora.');
    } else l.push('📉 Ainda não temos histórico de preço deste produto: use a régua abaixo como guia.');
    l.push('');
    l.push('*Quanto você quer pagar?* Responda com:');
    l.push('• o valor (ex.: ' + Math.floor(preco * 0.85) + '), ou');
    l.push('• o desconto sobre o preço de agora (ex.: 15%)' + (sug ? ', ou' : ''));
    if (sug) l.push('• *OK* para ' + brl(sug.valor) + ' (' + sug.motivo + ')');
    l.push('• ou *QUALQUER* para ser avisado de qualquer queda boa (' + E().config.quedaSemAlvoPct + '% ou mais).');
    l.push('');
    l.push('_Régua: até 20% abaixo é queda comum · 20 a 30% acontece às vezes · acima de 30% dificilmente chega._');
  } else {
    l.push('Ainda não consegui ler o preço deste anúncio por aqui, mas vou acompanhar.');
    l.push('');
    l.push('*Quanto você quer pagar?* Olhe o preço na loja e responda com o valor (ex.: 150), ou *QUALQUER* para ser avisado de qualquer queda boa.');
  }
  return l.join('\n');
}

function criarPedidoDaConversa({ jid, numeros, contato, pushName, item, leitura, alvo }) {
  const c = E().config;
  const ct = contato || registrarContato(jid, numeros, pushName);
  if (contato) registrarContato(jid, numeros, pushName);
  guardarProduto(item, leitura);
  const precoAtual = Number(leitura?.preco) > 0 ? arred(leitura.preco) : null;
  const agora = new Date().toISOString();
  const pedido = {
    id: 'AV' + (++E().seq),
    codigo: novoCodigo(), nome: String(ct.nome || pushName || 'Cliente WhatsApp').slice(0, 60),
    telefone: (ct.numeros || [])[0] || numeros[0] || '',
    produto: item.asin, loja: item.loja,
    titulo: String(leitura?.titulo || item.nome || '').slice(0, 200),
    precoInicial: precoAtual, precoAlvo: alvo != null && (!precoAtual || alvo < precoAtual) ? arred(alvo) : null,
    status: 'ativo', jid,
    criadoEm: agora, ativadoEm: agora,
    expiraEm: new Date(Date.now() + c.validadeDias * MS_DIA).toISOString(),
    avisos: [], ultimoAvisoPreco: null, ultimoAvisoEm: null,
    origem: { canal: 'whatsapp' },
  };
  E().pedidos.push(pedido);
  gravar();
  console.log('[AVISOS] Pedido ' + pedido.id + ' pelo WhatsApp (' + pedido.loja + ' ' + pedido.produto + ', alvo ' + (pedido.precoAlvo ?? '—') + ').');
  return {
    pedido,
    texto: textoConfirmacao(pedido, c),
  };
}

function textoConfirmacao(pedido, c) {
  const l = ['Pronto! 🔔 Alerta criado para *' + encurtar(pedido.titulo, 80) + '*', ''];
  const ini = pedido.precoInicial;
  if (pedido.precoAlvo) {
    l.push('🎯 Seu preço: *' + brl(pedido.precoAlvo) + '*' + (ini ? ' (' + Math.round((1 - pedido.precoAlvo / ini) * 100) + '% abaixo de agora)' : ''));
    l.push('Te aviso quando chegar lá' + (c.avisarQuedaParcial ? ' e também se cair ' + c.quedaParcialPct + '% ou mais no caminho.' : '.'));
    if (ini && 1 - pedido.precoAlvo / ini > 0.3) l.push('_Acima de 30% de desconto o preço dificilmente chega. Se quiser ajustar, mande SAIR + o número dele na lista e crie de novo._');
  } else {
    l.push('Te aviso quando o preço cair ' + c.quedaSemAlvoPct + '% ou mais.');
  }
  l.push('');
  l.push('Mande *MEUS ALERTAS* para ver sua lista ou *SAIR* para parar todos.');
  return l.join('\n');
}

function tratarSairUm(jid, numeros, n) {
  const contato = contatoPorJid(jid) || numeros.map(contatoPorTelefone).find(Boolean) || null;
  const abertos = pedidosAbertosDe(jid, numeros, contato);
  if (!abertos.length) { if (contato) falar(jid, 'Você não tem alertas ativos no momento.'); return; }
  const p = abertos[n - 1];
  if (!p) { falar(jid, 'Não achei o alerta ' + n + '.\n\n' + textoLista(abertos)); return; }
  p.status = 'cancelado'; p.canceladoEm = new Date().toISOString(); p.motivoFim = 'cliente mandou SAIR ' + n;
  gravar();
  console.log('[AVISOS] SAIR ' + n + ' de ' + mascarar(numeros[0] || jid) + ' — ' + p.id + ' cancelado.');
  const resto = abertos.filter(x => x !== p);
  falar(jid, 'Feito, parei o alerta de *' + encurtar(p.titulo, 80) + '*.'
    + (resto.length ? '\n\n' + textoLista(resto) : '\n\nVocê não tem mais alertas ativos. Para criar um, cole aqui o link do produto.'));
}

// ── Consulta pela página (código no WhatsApp) ───────────────────────────────
// A pessoa digita o número na página, o Tico manda um código de 6 dígitos
// nesse WhatsApp e só com o código a lista aparece. Só vai código para quem já
// falou com o número dos alertas (regra de não mandar mensagem a quem não pediu).
const _codigosConsulta = new Map();   // telefone → { codigo, exp, tentativas }
const _sessoesConsulta = new Map();   // token → { numeros, jid, exp }

export function pedirCodigoConsulta(telefoneBruto, ip) {
  const tel = normalizarTelefone(telefoneBruto);
  if (!tel) return { ok: false, erro: 'Confira o WhatsApp: DDD + número, só números.' };
  if (!limitarIp(ip, 'consulta-codigo', 8, MS_H)) return { ok: false, erro: 'Muitas tentativas. Espere alguns minutos.' };
  if (!limitarIp('tel:' + tel, 'consulta-codigo-tel', 4, MS_H)) return { ok: false, erro: 'Já mandamos vários códigos para esse número. Espere alguns minutos.' };
  const cfg = E().config;
  const generico = { ok: true, mensagem: 'Se esse número já ativou alertas com o Tico, o código chega no WhatsApp em instantes.' };
  const contato = contatoPorTelefone(tel);
  if (!contato || !contato.jid) {
    const aguardando = E().pedidos.some(p => p.status === 'aguardando' && [...variantesTelefone(p.telefone)].some(v => variantesTelefone(tel).has(v)));
    if (aguardando) return { ok: false, erro: 'Seus alertas ainda não foram ativados. Mande a mensagem de ativação para o Tico no WhatsApp e tente de novo.' };
    return generico;
  }
  if (!cfg.conta || !_deps.contaConectada?.(cfg.conta)) return { ok: false, erro: 'O WhatsApp do Tico está fora do ar agora. Tente de novo em alguns minutos.' };
  const codigo = String(100000 + Math.floor(Math.random() * 900000));
  _codigosConsulta.set(tel, { codigo, exp: Date.now() + 10 * 60000, tentativas: 0 });
  enfileirarEnvio(contato.jid, 'Seu código para ver seus alertas no site: *' + codigo + '*\n\nVale por 10 minutos. Se não foi você que pediu, é só ignorar.', { resposta: true });
  console.log('[AVISOS] Código de consulta para ' + mascarar(tel) + '.');
  return generico;
}

export function entrarConsulta(telefoneBruto, codigoBruto, ip) {
  const tel = normalizarTelefone(telefoneBruto);
  const cod = String(codigoBruto || '').replace(/\D+/g, '');
  if (!tel || cod.length !== 6) return { ok: false, erro: 'Confira o número e o código de 6 dígitos.' };
  if (!limitarIp(ip, 'consulta-entrar', 20, MS_H)) return { ok: false, erro: 'Muitas tentativas. Espere alguns minutos.' };
  const reg = _codigosConsulta.get(tel);
  if (!reg || Date.now() > reg.exp) return { ok: false, erro: 'Código vencido. Peça um novo.' };
  if (reg.codigo !== cod) {
    reg.tentativas++;
    if (reg.tentativas >= 5) _codigosConsulta.delete(tel);
    return { ok: false, erro: 'Código errado. Confira a mensagem do Tico.' };
  }
  _codigosConsulta.delete(tel);
  const contato = contatoPorTelefone(tel);
  const token = createHash('sha256').update(tel + ':' + Date.now() + ':' + Math.random()).digest('hex').slice(0, 40);
  _sessoesConsulta.set(token, { tel, jid: contato?.jid || null, exp: Date.now() + 30 * 60000 });
  if (_sessoesConsulta.size > 2000) _sessoesConsulta.delete(_sessoesConsulta.keys().next().value);
  return { ok: true, token, ...listaConsulta(token) };
}

function sessaoConsulta(token) {
  const s = _sessoesConsulta.get(String(token || ''));
  if (!s || Date.now() > s.exp) { _sessoesConsulta.delete(String(token || '')); return null; }
  return s;
}

function serieDoProduto(prod) {
  const dias = Object.entries(prod?.dias || {}).sort(([a], [b]) => a.localeCompare(b)).map(([d, p]) => ({ d, p }));
  const leituras = (prod?.leituras || []).map(x => ({ em: x.em, p: x.p }));
  const todos = [...dias.map(x => x.p), ...leituras.map(x => x.p)];
  return {
    dias, leituras,
    min: todos.length ? Math.min(...todos) : null,
    max: todos.length ? Math.max(...todos) : null,
  };
}

export function listaConsulta(token) {
  const s = sessaoConsulta(token);
  if (!s) return { ok: false, erro: 'Sua sessão venceu. Peça um código novo.', sessao: false };
  const contato = s.jid ? contatoPorJid(s.jid) : contatoPorTelefone(s.tel);
  const abertos = pedidosAbertosDe(s.jid, [s.tel], contato);
  return {
    ok: true,
    nome: contato?.nome || abertos[0]?.nome || '',
    limite: E().config.limitePorCliente,
    quedaSemAlvoPct: E().config.quedaSemAlvoPct,
    alertas: abertos.map((p, i) => {
      const prod = E().produtos[p.produto] || {};
      return {
        id: p.id, n: i + 1, titulo: p.titulo, loja: p.loja, imagem: prod.imagem || null,
        status: p.status, pausado: !!p.pausado, porNome: !!p.porNome,
        precoInicial: p.precoInicial, precoAlvo: p.precoAlvo,
        precoAtual: prod.ult?.preco ?? null, disponivel: prod.ult ? prod.ult.disponivel !== false : null,
        lidoEm: prod.lidoEm || null, criadoEm: p.criadoEm, expiraEm: p.expiraEm,
        avisos: (p.avisos || []).map(a => ({ em: a.em, preco: a.preco, tipo: a.tipo })),
        serie: serieDoProduto(prod),
      };
    }),
  };
}

export function pararPelaConsulta(token, id) {
  const s = sessaoConsulta(token);
  if (!s) return { ok: false, erro: 'Sua sessão venceu. Peça um código novo.', sessao: false };
  const contato = s.jid ? contatoPorJid(s.jid) : contatoPorTelefone(s.tel);
  const p = pedidosAbertosDe(s.jid, [s.tel], contato).find(x => x.id === id);
  if (!p) return { ok: false, erro: 'Alerta não encontrado.' };
  p.status = 'cancelado'; p.canceladoEm = new Date().toISOString(); p.motivoFim = 'cliente parou pelo site';
  gravar();
  console.log('[AVISOS] ' + p.id + ' parado pelo site (' + mascarar(s.tel) + ').');
  return listaConsulta(token);
}

function responder(jid, texto, forcar = false) {
  const ult = _ultimaRespostaPorJid.get(jid) || 0;
  if (!forcar && Date.now() - ult < 30000) return;
  _ultimaRespostaPorJid.set(jid, Date.now());
  enfileirarEnvio(jid, texto, { resposta: true });
}

// ── Fila de envio (uma mensagem por vez, espaçadas) ─────────────────────────
function enfileirarEnvio(jid, texto, meta = {}) {
  const item = { jid, texto, ...meta, em: Date.now() };
  // Resposta a quem acabou de falar com a gente vai na frente.
  if (meta.resposta) _filaEnvio.unshift(item); else _filaEnvio.push(item);
  processarFila();
}

async function processarFila() {
  if (_enviando) return;
  _enviando = true;
  try {
    while (_filaEnvio.length) {
      const c = E().config;
      if (!c.conta || !_deps.contaConectada?.(c.conta)) {
        console.warn('[AVISOS] Conta dos avisos (' + (c.conta || 'nenhuma') + ') desconectada — ' + _filaEnvio.length + ' mensagem(ns) esperando.');
        break;
      }
      const item = _filaEnvio[0];
      if (!item.resposta) {
        const [a, b] = c.espacoEntreEnviosS;
        const espera = (a + Math.random() * Math.max(0, b - a)) * 1000 - (Date.now() - _ultimoEnvioEm);
        if (espera > 0) await new Promise(r => setTimeout(r, espera));
      }
      _filaEnvio.shift();
      try {
        await _deps.enviarDm(c.conta, item.jid, item.texto);
        _ultimoEnvioEm = Date.now();
        if (item.aoEnviar) { try { item.aoEnviar(); } catch (e) {} }
      } catch (e) {
        console.warn('[AVISOS] Envio para ' + mascarar(digitosDeJid(item.jid) || item.jid) + ' falhou: ' + e.message);
        if (item.aoFalhar) { try { item.aoFalhar(e); } catch (e2) {} }
      }
      if (item.resposta) await new Promise(r => setTimeout(r, 2500));
    }
  } finally { _enviando = false; }
}

// ── Varredura de preços ─────────────────────────────────────────────────────
function produtosVigiados() {
  const chaves = new Set(E().pedidos.filter(p => p.status === 'ativo' && p.produto).map(p => p.produto));
  return [...chaves].map(k => E().produtos[k]).filter(Boolean);
}

function vencidos(p) {
  const h = Number(E().config.intervaloHoras[p.loja]) || 4;
  return !p.lidoEm || Date.now() - Date.parse(p.lidoEm) >= h * MS_H - 5 * 60000;
}

async function lerProdutos(lista) {
  const amazon = lista.filter(p => p.loja === 'Amazon');
  const outros = lista.filter(p => p.loja !== 'Amazon');
  let lidos = 0;
  for (let i = 0; i < amazon.length; i += 10) {
    const lote = amazon.slice(i, i + 10);
    try {
      const mapa = await lerPrecosAmazonEmLote(lote.map(itemDoProduto));
      for (const p of lote) {
        const l = mapa.get(p.asin);
        if (l && l.preco > 0) { registrarLeitura(p, l); lidos++; }
        else { p.falhas = (p.falhas || 0) + 1; p.falhaMotivo = 'sem preço na Amazon'; p.lidoEm = new Date().toISOString(); }
      }
    } catch (e) {
      console.warn('[AVISOS] Leitura Amazon falhou: ' + e.message);
      break;
    }
  }
  for (const p of outros) {
    try {
      const l = await lerPrecoProduto(itemDoProduto(p));
      if (l && l.preco > 0) { registrarLeitura(p, l); lidos++; }
      else { p.falhas = (p.falhas || 0) + 1; p.falhaMotivo = 'sem oferta na loja'; p.lidoEm = new Date().toISOString(); }
    } catch (e) {
      p.falhas = (p.falhas || 0) + 1; p.falhaMotivo = String(e.message || e).slice(0, 120); p.lidoEm = new Date().toISOString();
    }
    await new Promise(r => setTimeout(r, 1500 + Math.random() * 1500));
  }
  return lidos;
}

// O que o pedido merece agora, dado o preço lido. null = nada a avisar.
export function avaliarPedido(pedido, preco, cfg = E().config) {
  if (!(preco > 0)) return null;
  const ref = pedido.ultimoAvisoPreco;
  if (ref && preco > ref * (1 - cfg.novaQuedaPct / 100)) return null;
  const ini = pedido.precoInicial;
  if (pedido.precoAlvo) {
    if (preco <= pedido.precoAlvo) return { tipo: 'alvo' };
    if (cfg.avisarQuedaParcial && ini && preco <= ini * (1 - cfg.quedaParcialPct / 100)) return { tipo: 'parcial' };
    return null;
  }
  if (ini && preco <= ini * (1 - cfg.quedaSemAlvoPct / 100)) return { tipo: 'queda' };
  return null;
}

function avisosHoje(jid) {
  const hoje = diaSP();
  return E().envios.filter(e => e.jid === jid && e.dia === hoje).length;
}

async function montarLink(p) {
  const item = itemDoProduto(p);
  let montado = null;
  if (p.loja === 'Amazon') montado = await _deps.montarAmazon([p.asin], 'nenhum');
  else if (p.loja === 'Shopee') montado = await _deps.montarShopee([item], 'nenhum');
  else if (p.loja === 'Mercado Livre') montado = await _deps.montarMl([item], 'nenhum');
  const o = montado?.prontos?.[0];
  if (!o?.produto?.link) return null;
  const preco = Number(o.precoFinal ?? o.produto.preco);
  return { link: o.produto.link, preco: preco > 0 ? arred(preco) : null, titulo: o.produto.titulo || p.titulo };
}

function textoDoAviso(pedido, preco, tipo, link) {
  const linhas = [];
  if (tipo === 'alvo') linhas.push('🔔 *Chegou no seu preço!*');
  else linhas.push('🔔 *Baixou o preço!*');
  linhas.push('');
  linhas.push(encurtar(pedido.titulo, 120));
  linhas.push('');
  linhas.push('💰 Agora: *' + brl(preco) + '*' + (pedido.precoInicial ? ' (era ' + brl(pedido.precoInicial) + ' quando você pediu)' : ''));
  if (pedido.precoAlvo) {
    if (preco <= pedido.precoAlvo) linhas.push('🎯 Seu preço: ' + brl(pedido.precoAlvo) + ' ✅');
    else linhas.push('🎯 Seu preço: ' + brl(pedido.precoAlvo) + ' (faltam ' + brl(preco - pedido.precoAlvo) + ')');
  }
  linhas.push('');
  linhas.push('👉 ' + link);
  linhas.push('');
  linhas.push('_Preço de agora, pode mudar a qualquer momento. Para parar os avisos, responda SAIR._');
  return linhas.join('\n');
}

export async function varrerAvisos({ manual = false } = {}) {
  if (_varrendo) return { ok: false, erro: 'varredura em andamento' };
  const cfg = E().config;
  if (!cfg.ativo && !manual) return { ok: true, pulado: 'desligado' };
  _varrendo = true;
  const res = { lidos: 0, avisos: 0, expirados: 0, em: new Date().toISOString() };
  try {
    // 1. Validade.
    const agora = Date.now();
    for (const p of E().pedidos) {
      // Sem número de ativação no ar o prazo não corre: o cliente não teve como ativar.
      if (p.status === 'aguardando' && numeroDosAvisos() && Date.parse(p.expiraEm) < agora) { p.status = 'expirado'; p.motivoFim = 'não ativou no WhatsApp'; res.expirados++; }
      else if (p.status === 'ativo' && Date.parse(p.expiraEm) < agora) { p.status = 'encerrado'; p.motivoFim = 'validade de ' + cfg.validadeDias + ' dias'; res.expirados++; }
    }
    // 2. Leitura (só das 7h às 23h; fora disso a loja nem precisa ser incomodada).
    const h = horaSP();
    if (manual || (h >= 7 && h < 23)) {
      const devidos = produtosVigiados().filter(vencidos);
      if (devidos.length) res.lidos = await lerProdutos(devidos);
    }
    // 3. Avisos, só na janela e com a conta conectada.
    if (cfg.conta && dentroDaJanela() && _deps.contaConectada?.(cfg.conta)) {
      const jaNaFila = new Set(_filaEnvio.filter(f => f.pedidoId).map(f => f.pedidoId));
      for (const pedido of E().pedidos) {
        if (pedido.status !== 'ativo' || !pedido.jid || pedido.pausado || jaNaFila.has(pedido.id)) continue;
        const prod = E().produtos[pedido.produto];
        if (!prod?.ult?.preco || !prod.ult.disponivel) continue;
        // Criado sem preço lido (anúncio que a loja não mostrou na hora): a
        // primeira leitura vira a referência das quedas.
        if (!pedido.precoInicial) {
          pedido.precoInicial = prod.ult.preco;
          if (pedido.precoAlvo && pedido.precoAlvo >= pedido.precoInicial) pedido.precoAlvo = null;
          continue;
        }
        if (Date.now() - Date.parse(prod.ult.em) > 8 * MS_H) continue;
        const av = avaliarPedido(pedido, prod.ult.preco, cfg);
        if (!av) continue;
        if (avisosHoje(pedido.jid) + _filaEnvio.filter(f => f.jid === pedido.jid && f.pedidoId).length >= cfg.avisosPorDia) continue;
        // Confirma o preço na hora de montar o link (releitura da loja).
        let m = null;
        try { m = await montarLink(prod); } catch (e) { console.warn('[AVISOS] Montagem falhou (' + prod.asin + '): ' + e.message); }
        if (!m?.link || !m.preco) continue;
        const conf = avaliarPedido(pedido, m.preco, cfg);
        if (!conf) { registrarLeitura(prod, { preco: m.preco, disponivel: true }); continue; }
        const texto = textoDoAviso(pedido, m.preco, conf.tipo, m.link);
        const precoEnviado = m.preco;
        enfileirarEnvio(pedido.jid, texto, {
          pedidoId: pedido.id,
          aoEnviar: () => {
            const em = new Date().toISOString();
            pedido.ultimoAvisoPreco = precoEnviado; pedido.ultimoAvisoEm = em;
            pedido.avisos.push({ em, preco: precoEnviado, tipo: conf.tipo });
            if (pedido.avisos.length > 30) pedido.avisos = pedido.avisos.slice(-30);
            if (conf.tipo === 'alvo' && !pedido.alvoAtingidoEm) pedido.alvoAtingidoEm = em;
            E().envios.push({ jid: pedido.jid, dia: diaSP(), em, pedido: pedido.id, preco: precoEnviado, tipo: conf.tipo });
            const corte = diaSP(Date.now() - 60 * MS_DIA);
            E().envios = E().envios.filter(e => e.dia >= corte);
            gravar();
            console.log('[AVISOS] Aviso ' + conf.tipo + ' enviado — ' + pedido.id + ' a ' + brl(precoEnviado) + '.');
          },
        });
        res.avisos++;
      }
    }
    gravar();
  } catch (e) {
    console.error('[AVISOS] Varredura: ' + e.message);
    res.erro = e.message;
  } finally {
    _varrendo = false;
    _ultimaVarredura = res;
  }
  return { ok: true, ...res };
}

// ── Painel ───────────────────────────────────────────────────────────────────
export function estadoAvisos() {
  const st = E();
  const porStatus = {};
  for (const p of st.pedidos) porStatus[p.status] = (porStatus[p.status] || 0) + 1;
  const hoje = diaSP();
  return {
    ok: true,
    config: st.config,
    numero: numeroDosAvisos(),
    contaConectada: st.config.conta ? !!_deps.contaConectada?.(st.config.conta) : false,
    contasDisponiveis: (_deps.listarContas?.() || []).sort((a, b) => a.apelido.localeCompare(b.apelido, 'pt-BR')),
    resumo: {
      porStatus,
      contatos: st.contatos.filter(c => !c.saiuEm).length,
      produtos: produtosVigiados().length,
      avisosHoje: st.envios.filter(e => e.dia === hoje).length,
      avisos7d: st.envios.filter(e => e.dia >= diaSP(Date.now() - 7 * MS_DIA)).length,
      filaEnvio: _filaEnvio.length,
    },
    ultimaVarredura: _ultimaVarredura,
    pedidos: st.pedidos.slice().reverse().slice(0, 500).map(p => {
      const prod = st.produtos[p.produto] || {};
      return {
        id: p.id, codigo: p.codigo, nome: p.nome, telefone: mascarar(p.telefone),
        status: p.status, pausado: !!p.pausado, loja: p.loja, titulo: p.titulo, url: prod.url || '',
        precoInicial: p.precoInicial, precoAlvo: p.precoAlvo,
        precoAtual: prod.ult?.preco ?? null, lidoEm: prod.lidoEm || null, falhaMotivo: prod.falhas ? prod.falhaMotivo : null,
        criadoEm: p.criadoEm, ativadoEm: p.ativadoEm, expiraEm: p.expiraEm,
        avisos: p.avisos.length, ultimoAvisoEm: p.ultimoAvisoEm, ultimoAvisoPreco: p.ultimoAvisoPreco,
        alvoAtingidoEm: p.alvoAtingidoEm || null, motivoFim: p.motivoFim || null,
        porNome: !!p.porNome, linkInformado: p.linkInformado || null, textoOriginal: p.textoOriginal || null,
      };
    }),
  };
}

export function salvarConfigAvisos(parcial = {}) {
  const c = E().config;
  const num = (v, min, max, padrao) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : padrao; };
  if ('ativo' in parcial) c.ativo = !!parcial.ativo;
  if ('conta' in parcial) {
    const antes = c.conta;
    c.conta = String(parcial.conta || '').trim();
    // Número entrando no ar agora: quem pediu antes ganha o prazo inteiro para ativar.
    if (!antes && c.conta) {
      const prazo = new Date(Date.now() + c.ativacaoDias * MS_DIA).toISOString();
      for (const p of E().pedidos) if (p.status === 'aguardando') p.expiraEm = prazo;
    }
  }
  if ('numeroPublico' in parcial) c.numeroPublico = normalizarTelefone(parcial.numeroPublico) || '';
  if ('limitePorCliente' in parcial) c.limitePorCliente = Math.round(num(parcial.limitePorCliente, 1, 50, c.limitePorCliente));
  if ('janelaIni' in parcial) c.janelaIni = Math.round(num(parcial.janelaIni, 0, 23, c.janelaIni));
  if ('janelaFim' in parcial) c.janelaFim = Math.round(num(parcial.janelaFim, 1, 24, c.janelaFim));
  if ('avisosPorDia' in parcial) c.avisosPorDia = Math.round(num(parcial.avisosPorDia, 1, 10, c.avisosPorDia));
  if ('ativacaoDias' in parcial) c.ativacaoDias = Math.round(num(parcial.ativacaoDias, 1, 60, c.ativacaoDias));
  if ('validadeDias' in parcial) c.validadeDias = Math.round(num(parcial.validadeDias, 7, 365, c.validadeDias));
  if ('quedaSemAlvoPct' in parcial) c.quedaSemAlvoPct = num(parcial.quedaSemAlvoPct, 1, 80, c.quedaSemAlvoPct);
  if ('quedaParcialPct' in parcial) c.quedaParcialPct = num(parcial.quedaParcialPct, 1, 80, c.quedaParcialPct);
  if ('avisarQuedaParcial' in parcial) c.avisarQuedaParcial = !!parcial.avisarQuedaParcial;
  if ('novaQuedaPct' in parcial) c.novaQuedaPct = num(parcial.novaQuedaPct, 0, 50, c.novaQuedaPct);
  if (c.janelaFim <= c.janelaIni) c.janelaFim = Math.min(24, c.janelaIni + 1);
  gravar();
  if (c.conta) processarFila();
  return c;
}

export function acaoPedido(id, acao) {
  const p = E().pedidos.find(x => x.id === id);
  if (!p) return { ok: false, erro: 'pedido não encontrado' };
  if (acao === 'pausar') p.pausado = true;
  else if (acao === 'retomar') p.pausado = false;
  else if (acao === 'remover') { p.status = 'removido'; p.motivoFim = 'removido no painel'; p.removidoEm = new Date().toISOString(); }
  else return { ok: false, erro: 'ação inválida' };
  gravar();
  return { ok: true, status: p.status, pausado: !!p.pausado };
}

// ── Início ───────────────────────────────────────────────────────────────────
export function iniciarAvisosPreco(deps) {
  _deps = deps || {};
  carregarAvisosPreco();
  // A cada 10 min: cada produto só é relido quando vence o intervalo da loja.
  setInterval(() => { varrerAvisos().catch(() => {}); }, 10 * 60000);
  setTimeout(() => { varrerAvisos().catch(() => {}); }, 4 * 60000);
  // Fila parada por conta desconectada: tenta de novo a cada 2 min.
  setInterval(() => { if (_filaEnvio.length) processarFila(); }, 2 * 60000);
  console.log('[AVISOS] Avisos de preço inicializados (' + E().pedidos.filter(p => p.status === 'ativo').length + ' pedido(s) ativo(s)).');
}
