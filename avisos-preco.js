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
import { resolverLinhaVitrine, buscarProdutos as buscarProdutosAmazon, normalizar as normalizarAmazon, buscarAmazonPorTermo, listarCuponsBase, cupomVigente } from './radar-amazon.js';
import { ehLinkShopee, extrairIdsShopee, buscarProdutoShopee, normalizarShopee, credenciaisShopeeOk, buscarShopeePorTermo } from './radar-shopee.js';
import { ehLinkMl, resolverLinhaVitrineMl, buscarDadosProdutoMl, tokenAffOk, cupomDaPaginaParaCatalogoMl } from './radar-ml.js';

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
  // Alerta que chega no alvo (ou queda sem alvo) vira card no bot para ir aos grupos.
  cardGrupos: true,
};

const RE_ATIVAR = /pedido\s*n?[ºo°.]?\s*#?\s*(\d{4,6})/i;
const RE_SAIR = /^\s*(sair|parar|pare|cancelar|cancela|stop|descadastrar)\s*[.!]?\s*$/i;
// SAIR 2: para só o alerta 2 da lista que o MEUS ALERTAS mostrou.
const RE_SAIR_UM = /^\s*(?:sair|parar|pare|cancelar|cancela|stop)\s*#?\s*(\d{1,2})\s*[.!]?\s*$/i;
const RE_MEUS = /^\s*(?:meus|minhas|ver)?\s*(?:alertas?|avisos?|lista)(?:\s+de\s+pre[cç]os?)?\s*[.!?]?\s*$/i;
// Cumprimento sozinho ("oi", "bom dia", "olá tico"): resposta fixa, sem IA.
const RE_OI = /^\s*(oi+|ol[aá]|e\s*a[ií]|opa|eae|hey|hello|bom\s+dia|boa\s+tarde|boa\s+noite|tudo\s+bem\??|tudo\s+bom\??)(\s+tico)?\s*[!.?,]*\s*(tudo\s+(bem|bom)\s*\??)?\s*[!.?]*\s*$/i;
const RE_CANCELAR = /^\s*(cancelar|cancela|desisto|deixa\s+pra\s+l[aá]|esquece)\s*[.!]?\s*$/i;
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
    cuponsMlVistos: Array.isArray(e.cuponsMlVistos) ? e.cuponsMlVistos : [],
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
    rastrear(jid, 'recebida', texto);

    const numeros = [jid, k.remoteJidAlt, k.senderPn].map(digitosDeJid).filter(Boolean);

    if (RE_CANCELAR.test(texto) && _criacaoPendente.has(jid)) {
      tratarConversa(jid, numeros, texto, msg.pushName, null).catch(e => console.warn('[AVISOS] Conversa: ' + e.message));
      return;
    }
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
  const tinhaPendente = _criacaoPendente.delete(jid);
  const c = contatoPorJid(jid) || numeros.map(contatoPorTelefone).find(Boolean) || null;
  const vs = new Set(numeros.flatMap(n => [...variantesTelefone(n)]));
  const alvo = E().pedidos.filter(p => !ehFinal(p.status)
    && (p.jid === jid || [...variantesTelefone(p.telefone)].some(v => vs.has(v))));
  if (!c && !alvo.length) {
    if (tinhaPendente) responder(jid, 'Tudo bem, deixei esse alerta de lado. Quando quiser, é só colar aqui o link de um produto. 🙂', true);
    return;
  }
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

// Trava contra laço (outro robô respondendo o Tico): 40 respostas/h por
// conversa. Ao bater, avisa UMA vez em vez de sumir em silêncio.
const _avisoTravaPorJid = new Map();
function podeConversar(jid) {
  const agora = Date.now();
  const v = (_respostasPorJid.get(jid) || []).filter(t => agora - t < MS_H);
  if (v.length >= 40) {
    _respostasPorJid.set(jid, v);
    rastrear(jid, 'trava', 'limite de 40 respostas/h');
    if (agora - (_avisoTravaPorJid.get(jid) || 0) > MS_H) {
      _avisoTravaPorJid.set(jid, agora);
      enfileirarEnvio(jid, 'Recebi muitas mensagens seguidas 😅 Vou dar uma pausa de alguns minutos e já volto a responder.', { resposta: true });
    }
    return false;
  }
  v.push(agora); _respostasPorJid.set(jid, v);
  if (_respostasPorJid.size > 3000) _respostasPorJid.delete(_respostasPorJid.keys().next().value);
  return true;
}
function falar(jid, texto) { if (podeConversar(jid)) { anotarConversa(jid, 'tico', texto); rastrear(jid, 'resposta', texto); enfileirarEnvio(jid, texto, { resposta: true }); } }

// ── Rastro das conversas (diagnóstico no painel) ────────────────────────────
// Últimos 300 eventos em memória: mensagem recebida, caminho tomado, resposta,
// trava, falha de envio. GET /avisos-preco/conversas (só raiz).
const _rastro = [];
function rastrear(jid, tipo, detalhe) {
  _rastro.push({ em: new Date().toISOString(), jid, tipo, detalhe: String(detalhe == null ? '' : detalhe).replace(/\s+/g, ' ').slice(0, 240) });
  if (_rastro.length > 300) _rastro.splice(0, _rastro.length - 300);
}
export function rastroConversas({ tel = '', n = 80 } = {}) {
  const vs = tel ? variantesTelefone(normalizarTelefone(tel) || String(tel).replace(/\D+/g, '')) : null;
  const jidsDoTel = new Set();
  if (vs && vs.size) {
    for (const c of E().contatos) if ((c.numeros || []).some(x => vs.has(x))) jidsDoTel.add(c.jid);
    for (const v of vs) jidsDoTel.add(v + '@s.whatsapp.net');
  }
  const ev = _rastro.filter(e => !vs || jidsDoTel.has(e.jid) || [...(vs || [])].some(v => String(e.jid).startsWith(v)));
  return {
    ok: true, conta: E().config.conta || null, contaConectada: E().config.conta ? !!_deps.contaConectada?.(E().config.conta) : false,
    filaEnvio: _filaEnvio.length, iaLigada: !!_deps.ia,
    eventos: ev.slice(-Math.min(300, Math.max(1, Number(n) || 80))),
  };
}

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
  const mo = prod.asin ? melhorOferta(prod) : null;
  const atual = mo?.preco ?? prod.ult?.preco;
  const l = [(i + 1) + '. *' + encurtar(p.titulo, 70) + '*' + (p.loja ? ' (' + p.loja + ')' : '')];
  if (p.status === 'aguardando') l.push('⏳ Aguardando ativação');
  if (p.pausado) l.push('⏸️ Pausado');
  if (p.porNome) l.push('🔎 Ainda estamos procurando o produto');
  if (atual) l.push('💰 Hoje: ' + brl(atual) + (mo && mo.prod.loja !== p.loja ? ' na ' + mo.prod.loja : '') + (mo?.cupom ? ' com o cupom ' + mo.cupom : ''));
  if (p.precoAlvo) {
    if (atual && atual <= p.precoAlvo) l.push('🎯 Seu preço: ' + brl(p.precoAlvo) + ' ✅ chegou!');
    else l.push('🎯 Seu preço: ' + brl(p.precoAlvo) + (atual ? ' (faltam ' + brl(atual - p.precoAlvo) + ')' : ''));
  } else if (!p.porNome) l.push('🎯 Te aviso em qualquer queda de ' + E().config.quedaSemAlvoPct + '% ou mais');
  return l.join('\n');
}

function textoBoasVindas(temAlertas) {
  return 'Oi! 👋 Sou o Tico e tô aqui para te avisar quando seu produto cai de preço.\n\n'
    + 'É só colar aqui o link dele (Amazon, Mercado Livre ou Shopee) e me dizer quanto você quer pagar.'
    + (temAlertas ? '\n\nPara ver os alertas que você já tem, mande *MEUS ALERTAS*.' : '');
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
    return 'Você não tem nenhum alerta de preço ativo agora.\n\nQuer criar um? É só colar aqui o link do produto (Amazon, Mercado Livre ou Shopee) ou usar ' + SITE_ALERTAS;
  }
  return '🔔 *Seus alertas de preço*\n\n' + abertos.map(linhaDoPedido).join('\n\n')
    + '\n\n———\n\n'
    + 'Para parar um alerta, responda *SAIR* + o número dele (ex.: *SAIR 1*). *SAIR* sozinho para todos.\n\n'
    + 'Para criar outro, é só colar aqui o link do produto.\n\n'
    + '📈 O histórico de preço de cada um fica em ' + SITE_ALERTAS;
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
  anotarConversa(jid, 'cliente', texto);
  const abertos = pedidosAbertosDe(jid, numeros, contato);

  // CANCELAR desiste do alerta em criação (sem tocar nos que já existem).
  if (RE_CANCELAR.test(texto) && pendenteDe(jid)) {
    _criacaoPendente.delete(jid);
    falar(jid, 'Tudo bem, deixei esse alerta de lado. Quando quiser, é só colar o link de outro produto aqui. 🙂');
    return;
  }
  const ehCliente = !!contato || abertos.length > 0;

  if (RE_OI.test(texto) && !pendenteDe(jid)) {
    falar(jid, textoBoasVindas(ehCliente));
    return;
  }

  if (RE_MEUS.test(texto)) {
    if (!ehCliente) { falar(jid, textoAjuda(false)); return; }
    falar(jid, textoLista(abertos));
    return;
  }

  // Resposta à pergunta de preço de um alerta que está sendo criado. O que
  // dá para ler sem dúvida (valor, %, OK, QUALQUER) vai direto; o resto passa
  // pela IA, que também pode desistir da criação ou mudar de assunto.
  const pend = pendenteDe(jid);
  if (pend && !RE_URL.test(texto)) {
    const resp = lerRespostaAlvo(texto);
    if (resp) { aplicarAlvoPendente({ jid, numeros, contato, pushName, pend, resp }); return; }
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
    rastrear(jid, 'link', mUrl[0]);
    // Mercado Livre pode levar até ~20 s (página lida pela extensão): avisa que está olhando.
    const espera = setTimeout(() => falar(jid, 'Só um instante, estou olhando esse produto 🔎'), 4000);
    let r;
    try { r = await resolverLink(mUrl[0].replace(/[).,!?]+$/, '')); }
    catch (e) { rastrear(jid, 'erro', 'leitura do link: ' + e.message); r = { erro: 'Não consegui ler esse link agora. Tente de novo em instantes.' }; }
    finally { clearTimeout(espera); }
    if (r.erro) rastrear(jid, 'link-erro', r.erro);
    if (r.erro) { falar(jid, r.erro + '\n\nSe preferir, faça o pedido em ' + SITE_ALERTAS); return; }
    if (abertos.some(p => p.produto === r.item.asin)) {
      falar(jid, 'Você já tem alerta para esse produto. Mande *MEUS ALERTAS* para ver sua lista.');
      return;
    }
    const preco = Number(r.leitura?.preco) > 0 ? arred(r.leitura.preco) : null;
    const titulo = String(r.leitura?.titulo || r.item.nome || '').slice(0, 200);
    const sug = preco ? sugestaoDePreco(preco, historicoParaSugestao(r.item.asin)) : null;
    _criacaoPendente.set(jid, { item: r.item, leitura: r.leitura, sugestao: sug, titulo, em: Date.now() });
    if (_criacaoPendente.size > 2000) _criacaoPendente.delete(_criacaoPendente.keys().next().value);
    falar(jid, textoPerguntaAlvo(r.item, titulo, preco, sug));
    return;
  }

  // Fora dos comandos: a IA entende o pedido e o código executa.
  if (await conversarComIa({ jid, numeros, contato, pushName, texto, abertos, ehCliente })) return;

  // Sem IA (falhou ou desligada): pergunta pendente ganha uma nova chance e
  // depois é largada — ninguém fica preso nela.
  const pend2 = pendenteDe(jid);
  if (pend2) {
    pend2.erros = (pend2.erros || 0) + 1;
    if (pend2.erros >= 2) {
      _criacaoPendente.delete(jid);
      falar(jid, 'Deixei esse alerta de lado por enquanto.\n\n' + textoAjuda(ehCliente).replace(/^Oi! /, ''));
      return;
    }
    falar(jid, textoNaoEntendiAlvo(pend2) + '\n\nSe mudou de ideia, mande *CANCELAR*.');
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

// ── Pergunta de preço pendente ──────────────────────────────────────────────
function pendenteDe(jid) {
  const p = _criacaoPendente.get(jid);
  if (p && Date.now() - p.em > 30 * 60000) { _criacaoPendente.delete(jid); return null; }
  return p || null;
}

// Lê sem IA: OK, QUALQUER, valor em reais ou desconto em %.
function lerRespostaAlvo(texto) {
  if (RE_OK.test(texto)) return { tipo: 'ok' };
  if (RE_SEM_ALVO.test(texto)) return { tipo: 'qualquer' };
  const mPct = RE_PCT.exec(texto);
  if (mPct) return { tipo: 'pct', valor: Number(mPct[1].replace(',', '.')) };
  const v = lerValor(texto);
  if (v != null) return { tipo: 'valor', valor: v };
  return null;
}

function textoNaoEntendiAlvo(pend) {
  const atual = Number(pend.leitura?.preco) > 0 ? Number(pend.leitura.preco) : null;
  const exemplo = atual ? String(Math.floor(atual * 0.85)) : '150';
  return 'Para criar o alerta de *' + encurtar(pend.titulo || pend.item?.nome || 'produto', 60) + '*, responda com o valor que você quer pagar (ex.: ' + exemplo + ')'
    + (atual ? ', o desconto em % (ex.: 15%)' : '')
    + (pend.sugestao ? ', *OK* para ' + brl(pend.sugestao.valor) : '')
    + ' ou *QUALQUER* para ser avisado de qualquer queda boa.';
}

// Valida e cria. Devolve true se criou.
function aplicarAlvoPendente({ jid, numeros, contato, pushName, pend, resp }) {
  const atual = Number(pend.leitura?.preco) > 0 ? Number(pend.leitura.preco) : null;
  const exemplo = atual ? String(Math.floor(atual * 0.85)) : '150';
  let alvo = null;
  if (resp.tipo === 'ok') {
    if (!pend.sugestao) { falar(jid, textoNaoEntendiAlvo(pend)); return false; }
    alvo = pend.sugestao.valor;
  } else if (resp.tipo === 'pct') {
    if (!atual) { falar(jid, 'Como ainda não consegui ler o preço desse anúncio, mande o valor em reais (ex.: ' + exemplo + '), ou *QUALQUER* para ser avisado de qualquer queda boa.'); return false; }
    if (!(resp.valor > 0 && resp.valor < 90)) { falar(jid, 'Mande um desconto entre 1% e 89% (ex.: 15%), um valor em reais (ex.: ' + exemplo + ') ou *QUALQUER*.'); return false; }
    alvo = arred(Math.floor(atual * (1 - resp.valor / 100) * 100) / 100);
  } else if (resp.tipo === 'valor') {
    alvo = arred(resp.valor);
    if (!(alvo > 0)) { falar(jid, textoNaoEntendiAlvo(pend)); return false; }
    if (atual && alvo >= atual) {
      falar(jid, 'Esse valor já é igual ou maior que o preço de agora (' + brl(atual) + '). Mande um valor abaixo disso, ou *QUALQUER* para ser avisado de qualquer queda boa.');
      return false;
    }
  }
  _criacaoPendente.delete(jid);
  const r = criarPedidoDaConversa({ jid, numeros, contato, pushName, item: pend.item, leitura: pend.leitura, alvo });
  falar(jid, r.texto);
  return true;
}

// ── IA: entende a mensagem livre, o código executa ──────────────────────────
// A IA nunca inventa preço nem produto: ela devolve uma intenção (e, quando é
// conversa, uma resposta curta); números e ações saem sempre do nosso estado.
const _historicoConversa = new Map();   // jid → [{ de: 'cliente'|'tico', t, em }]
const _iaPorJid = new Map();            // jid → [ts] (teto diário de chamadas)

function anotarConversa(jid, de, t) {
  const v = (_historicoConversa.get(jid) || []).filter(x => Date.now() - x.em < 6 * MS_H);
  v.push({ de, t: String(t || '').slice(0, 700), em: Date.now() });
  _historicoConversa.set(jid, v.slice(-10));
  if (_historicoConversa.size > 3000) _historicoConversa.delete(_historicoConversa.keys().next().value);
}

function podeChamarIa(jid) {
  const agora = Date.now();
  const v = (_iaPorJid.get(jid) || []).filter(t => agora - t < MS_DIA);
  if (v.length >= 40) { _iaPorJid.set(jid, v); return false; }
  v.push(agora); _iaPorJid.set(jid, v);
  if (_iaPorJid.size > 3000) _iaPorJid.delete(_iaPorJid.keys().next().value);
  return true;
}

const IA_SISTEMA = `Você é o Tico, o assistente de WhatsApp do Tica Promos (site de ofertas e grupos de promoções no WhatsApp). Fale em português do Brasil correto, de um jeito simpático, direto e curto (no máximo 4 linhas), como uma pessoa no WhatsApp: pode usar \"tô\" e \"pra\", mas sem gíria forçada, sem imperativo de gíria (\"cola o link\", \"diz aí\") e sem comer artigo (\"quando o produto cai\", nunca \"quando produto cai\"). Para pedir o link, diga \"é só colar aqui o link do produto\". Pode usar *negrito* do WhatsApp e no máximo 1 emoji. Jeito de se apresentar, quando precisar: \"Sou o Tico e tô aqui para te avisar quando seu produto cai de preço.\"

O que você faz por aqui: alertas de preço. A pessoa cola o link de um produto da Amazon, Mercado Livre ou Shopee, diz quanto quer pagar e você avisa quando o preço chegar lá (ou cair bem). Comandos que a pessoa pode usar: MEUS ALERTAS (lista numerada), SAIR + número (para um alerta), SAIR (para todos), CANCELAR (desiste do alerta que está sendo criado). Também dá para criar e ver os alertas em ticapromos.com.br/avisos.

Outros caminhos que você pode indicar: ofertas do dia em ticapromos.com.br; grupos de promoções em ir.ticapromos.com.br/geral. Você NÃO tem acesso a pedidos, entregas, trocas ou atendimento das lojas (isso é com a loja), nem lista cupons por aqui (cupons saem nos grupos e no site).

Regras:
- Nunca invente preço, desconto, produto, cupom ou prazo. Os dados que você tem estão no CONTEXTO.
- Não prometa que o preço vai cair.
- Se a pessoa quiser criar um alerta e não mandou link, peça o link do produto.
- Se não entender, diga com naturalidade o que você consegue fazer.

Responda SÓ com um JSON, sem texto fora dele:
{"acao": "...", "valor": null, "pct": null, "n": null, "resposta": "..."}

Ações:
- "responder": só conversa; escreva a resposta em "resposta".
- "definir_alvo": a pessoa disse quanto quer pagar no alerta em criação; use "valor" (reais) ou "pct" (desconto em %).
- "aceitar_sugestao": aceitou o preço sugerido do alerta em criação.
- "qualquer_queda": quer ser avisada de qualquer queda boa (sem preço definido) no alerta em criação.
- "cancelar_criacao": desistiu do alerta em criação.
- "listar": quer ver os alertas dela.
- "parar": quer parar UM alerta; "n" = número dele na lista do CONTEXTO.
- "parar_todos": quer parar TODOS os alertas.
- "mudar_alvo": quer trocar o preço desejado de um alerta existente; "n" = número na lista, e "valor" ou "pct".
Em todas as ações, "resposta" pode ficar vazia (o sistema escreve a confirmação), exceto em "responder".`;

function contextoParaIa(jid, abertos, pend) {
  const l = [];
  if (pend) {
    const atual = Number(pend.leitura?.preco) > 0 ? brl(pend.leitura.preco) : 'ainda não lido';
    l.push('ALERTA EM CRIAÇÃO (o Tico perguntou quanto a pessoa quer pagar): ' + encurtar(pend.titulo || pend.item?.nome || '', 80)
      + ' · preço de agora: ' + atual + (pend.sugestao ? ' · preço sugerido: ' + brl(pend.sugestao.valor) : ''));
  } else l.push('ALERTA EM CRIAÇÃO: nenhum.');
  if (abertos.length) {
    l.push('ALERTAS DA PESSOA:');
    abertos.forEach((p, i) => {
      const prod = E().produtos[p.produto] || {};
      l.push((i + 1) + '. ' + encurtar(p.titulo, 70) + ' · agora ' + (prod.ult?.preco ? brl(prod.ult.preco) : 'sem leitura')
        + ' · seu preço ' + (p.precoAlvo ? brl(p.precoAlvo) : 'qualquer queda boa'));
    });
  } else l.push('ALERTAS DA PESSOA: nenhum.');
  const h = (_historicoConversa.get(jid) || []).slice(0, -1);
  if (h.length) {
    l.push('CONVERSA RECENTE:');
    for (const x of h.slice(-6)) l.push((x.de === 'tico' ? 'Tico: ' : 'Pessoa: ') + x.t.replace(/\s+/g, ' ').slice(0, 300));
  }
  return l.join('\n');
}

async function conversarComIa({ jid, numeros, contato, pushName, texto, abertos, ehCliente }) {
  if (!_deps.ia || !podeChamarIa(jid)) return false;
  const pend = pendenteDe(jid);
  let r = null;
  try {
    r = await _deps.ia(IA_SISTEMA, 'CONTEXTO:\n' + contextoParaIa(jid, abertos, pend) + '\n\nMENSAGEM DA PESSOA: ' + String(texto).slice(0, 800), 400);
  } catch (e) { console.warn('[AVISOS] IA falhou: ' + e.message); }
  if (!r || typeof r !== 'object' || !r.acao) return false;
  const resposta = String(r.resposta || '').trim().slice(0, 700);
  const n = Number(r.n);
  const valor = Number(r.valor), pct = Number(r.pct);
  console.log('[AVISOS] IA: ' + r.acao + ' (' + mascarar(numeros[0] || jid) + ').');
  rastrear(jid, 'ia', r.acao + (resposta ? ' · ' + resposta : ''));

  switch (r.acao) {
    case 'definir_alvo':
    case 'aceitar_sugestao':
    case 'qualquer_queda': {
      if (!pend) break;
      const resp = r.acao === 'aceitar_sugestao' ? { tipo: 'ok' }
        : r.acao === 'qualquer_queda' ? { tipo: 'qualquer' }
        : pct > 0 ? { tipo: 'pct', valor: pct }
        : valor > 0 ? { tipo: 'valor', valor } : null;
      if (!resp) break;
      aplicarAlvoPendente({ jid, numeros, contato, pushName, pend, resp });
      return true;
    }
    case 'cancelar_criacao':
      if (!pend) break;
      _criacaoPendente.delete(jid);
      falar(jid, resposta || 'Tudo bem, deixei esse alerta de lado. Quando quiser, é só colar o link de outro produto aqui. 🙂');
      return true;
    case 'listar':
      falar(jid, textoLista(abertos));
      return true;
    case 'parar':
      if (!(n >= 1)) break;
      tratarSairUm(jid, numeros, n);
      return true;
    case 'parar_todos':
      tratarSair(jid, numeros);
      return true;
    case 'mudar_alvo': {
      const p = abertos[n - 1];
      if (!p) break;
      const prod = E().produtos[p.produto] || {};
      const atual = prod.ult?.preco || p.precoInicial || null;
      let novo = pct > 0 && atual ? arred(Math.floor(atual * (1 - pct / 100) * 100) / 100) : (valor > 0 ? arred(valor) : null);
      if (!novo) break;
      if (atual && novo >= atual) { falar(jid, 'Esse valor já é igual ou maior que o preço de agora (' + brl(atual) + '). Mande um valor abaixo disso.'); return true; }
      p.precoAlvo = novo; p.ultimoAvisoPreco = null;
      gravar();
      console.log('[AVISOS] ' + p.id + ' alvo trocado para ' + novo + ' pela conversa.');
      falar(jid, 'Pronto! 🎯 Novo preço para *' + encurtar(p.titulo, 70) + '*: *' + brl(novo) + '*' + (atual ? ' (' + Math.round((1 - novo / atual) * 100) + '% abaixo de agora)' : '') + '. Te aviso quando chegar lá.');
      return true;
    }
  }
  // "responder" ou ação que não fechou: vale a resposta da IA, se houver.
  if (!resposta) return false;
  falar(jid, resposta + (pend ? '\n\n' + textoNaoEntendiAlvo(pend) : ''));
  return true;
}

// Pergunta do preço desejado, com a mesma régua da página: até 20% abaixo é
// queda comum, 20–30% acontece às vezes, acima de 30% dificilmente chega.
function textoPerguntaAlvo(item, titulo, preco, sug) {
  const l = ['Achei! 👇', '*' + encurtar(titulo, 100) + '* (' + item.loja + ')', ''];
  if (!preco) {
    l.push('Ainda não consegui ver o preço desse anúncio por aqui, mas vou ficar de olho nele. 👀');
    l.push('');
    l.push('Quanto você gostaria de pagar? Dá uma olhada no preço na loja e me manda um valor, tipo *R$ 150*.');
    l.push('');
    l.push('Se preferir, responda *QUALQUER* que eu te aviso de qualquer queda boa.');
    return l.join('\n');
  }
  const queda = E().config.quedaSemAlvoPct;
  l.push('💰 Hoje ele está por *' + brl(preco) + '*.');
  const h = historicoParaSugestao(item.asin);
  if (h.min90 && h.min90 < preco) {
    l.push('📉 Nos últimos ' + Math.min(90, h.dias) + ' dias, o menor preço que vi foi ' + brl(h.min90) + ' (' + Math.round((1 - h.min90 / preco) * 100) + '% abaixo de hoje).');
  } else if (h.min90) {
    l.push('📉 Nos últimos ' + Math.min(90, h.dias) + ' dias ele não ficou mais barato que isso.');
  } else {
    l.push('📉 Ainda não tenho o histórico de preço dele, então começo a acompanhar a partir de agora.');
  }
  l.push('');
  l.push('Quanto você gostaria de pagar? Pode me mandar do jeito que for mais fácil:');
  l.push('');
  l.push('• um valor, tipo *R$ ' + Math.floor(preco * 0.85) + '*');
  l.push('• um desconto, tipo *15%*');
  if (sug) {
    const porque = /^menor/i.test(sug.motivo || '') ? 'o ' + sug.motivo : Math.round((1 - sug.valor / preco) * 100) + '% abaixo de hoje';
    l.push('• *OK* para eu usar ' + brl(sug.valor) + ' (' + porque + ')');
  }
  l.push('• *QUALQUER* para eu te avisar de qualquer queda boa (' + queda + '% ou mais)');
  l.push('');
  l.push('💡 *Dica do Tico:* quedas de até 20% são as mais comuns. Entre 20% e 30% acontecem de vez em quando, e acima de 30% é bem raro.');
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
  const l = ['Prontinho! 🔔 Já estou de olho em *' + encurtar(pedido.titulo, 80) + '*.', ''];
  const ini = pedido.precoInicial;
  if (pedido.precoAlvo) {
    l.push('🎯 Seu preço: *' + brl(pedido.precoAlvo) + '*' + (ini ? ' (' + Math.round((1 - pedido.precoAlvo / ini) * 100) + '% abaixo de hoje)' : ''));
    l.push('');
    l.push('Quando chegar lá, eu te aviso por aqui.' + (c.avisarQuedaParcial ? ' E se ele cair ' + c.quedaParcialPct + '% ou mais no caminho, também te conto.' : ''));
    if (ini && 1 - pedido.precoAlvo / ini > 0.3) {
      l.push('');
      l.push('💡 *Dica do Tico:* acima de 30% de desconto é bem raro chegar. Se quiser ajustar, é só me dizer o novo valor.');
    }
  } else {
    l.push('Assim que o preço cair ' + c.quedaSemAlvoPct + '% ou mais, eu te aviso por aqui.');
  }
  l.push('');
  l.push('Quer ver seus alertas? É só mandar *MEUS ALERTAS*. Para parar, mande *SAIR*.');
  return l.join('\n');
}
function tratarSairUm(jid, numeros, n) {
  _criacaoPendente.delete(jid);
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
        melhor: (() => { const mo = prod.asin ? melhorOferta(prod) : null; return mo ? { preco: mo.preco, loja: mo.prod.loja, cupom: mo.cupom || null } : null; })(),
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
  if (!forcar && Date.now() - ult < 30000) { rastrear(jid, 'resposta-suprimida', texto); return; }
  _ultimaRespostaPorJid.set(jid, Date.now());
  anotarConversa(jid, 'tico', texto);
  rastrear(jid, 'resposta', texto);
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
        rastrear(_filaEnvio[0]?.jid || '', 'conta-desconectada', c.conta || 'nenhuma');
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
        rastrear(item.jid, 'envio-falhou', e.message);
        if (item.aoFalhar) { try { item.aoFalhar(e); } catch (e2) {} }
      }
      if (item.resposta) await new Promise(r => setTimeout(r, 2500));
    }
  } finally { _enviando = false; }
}

// ── Varredura de preços ─────────────────────────────────────────────────────
function produtosBase() {
  const chaves = new Set(E().pedidos.filter(p => p.status === 'ativo' && p.produto && !p.porNome).map(p => p.produto));
  return [...chaves].map(k => E().produtos[k]).filter(Boolean);
}
// Base + o mesmo produto nas outras lojas (equivalentes ativos).
function produtosVigiados() {
  const out = new Map();
  for (const p of produtosBase()) {
    out.set(p.asin, p);
    for (const eq of p.equivalentes || []) {
      if (eq.ativo === false) continue;
      const q = E().produtos[eq.chave];
      if (q) out.set(q.asin, q);
    }
  }
  return [...out.values()];
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

async function montarLink(p, cupom = null) {
  const item = itemDoProduto(p);
  let montado = null;
  if (p.loja === 'Amazon') montado = await _deps.montarAmazon([p.asin], 'nenhum');
  else if (p.loja === 'Shopee') montado = await _deps.montarShopee([item], 'nenhum');
  else if (p.loja === 'Mercado Livre') montado = await _deps.montarMl([item], cupom || 'nenhum');
  const o = montado?.prontos?.[0];
  if (!o?.produto?.link) return null;
  const preco = Number(o.precoFinal ?? o.produto.preco);
  return { link: o.produto.link, preco: preco > 0 ? arred(preco) : null, titulo: o.produto.titulo || p.titulo };
}

function textoDoAviso(pedido, preco, tipo, link, extra = {}) {
  const linhas = [];
  const outraLoja = extra.loja && pedido.loja && extra.loja !== pedido.loja;
  if (tipo === 'alvo') linhas.push('🔔 *Chegou no seu preço!*');
  else if (outraLoja) linhas.push('🔔 *Achei mais barato!*');
  else linhas.push('🔔 *Baixou o preço!*');
  linhas.push('');
  linhas.push(encurtar(pedido.titulo, 120));
  linhas.push('');
  if (outraLoja) { linhas.push('🏪 Mesmo produto, agora na *' + extra.loja + '*'); }
  linhas.push('💰 Agora: *' + brl(preco) + '*' + (pedido.precoInicial ? ' (era ' + brl(pedido.precoInicial) + ' quando você pediu)' : ''));
  if (extra.cupom) linhas.push('🎟️ Usando o cupom *' + extra.cupom + '* (aparece no anúncio)');
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
      const paraGrupos = new Map();   // produto da loja → { item, cupom, tipo, clientes, preco, alvo }
      for (const pedido of E().pedidos) {
        if (pedido.status !== 'ativo' || !pedido.jid || pedido.pausado || jaNaFila.has(pedido.id)) continue;
        const prod = E().produtos[pedido.produto];
        if (!prod) continue;
        // Criado sem preço lido (anúncio que a loja não mostrou na hora): a
        // primeira leitura vira a referência das quedas.
        if (!pedido.precoInicial) {
          if (!prod.ult?.preco || !prod.ult.disponivel) continue;
          pedido.precoInicial = prod.ult.preco;
          if (pedido.precoAlvo && pedido.precoAlvo >= pedido.precoInicial) pedido.precoAlvo = null;
          continue;
        }
        // Menor preço entre a loja pedida e as equivalentes (com cupom do ML).
        const mo = melhorOferta(prod, { maxIdadeMs: 8 * MS_H });
        if (!mo) continue;
        const av = avaliarPedido(pedido, mo.preco, cfg);
        if (!av) continue;
        if (avisosHoje(pedido.jid) + _filaEnvio.filter(f => f.jid === pedido.jid && f.pedidoId).length >= cfg.avisosPorDia) continue;
        // Confirma o preço na hora de montar o link (releitura da loja).
        let m = null;
        try { m = await montarLink(mo.prod, mo.cupom); } catch (e) { console.warn('[AVISOS] Montagem falhou (' + mo.prod.asin + '): ' + e.message); }
        if (!m?.link || !m.preco) continue;
        const conf = avaliarPedido(pedido, m.preco, cfg);
        if (!conf) { if (!mo.cupom) registrarLeitura(mo.prod, { preco: m.preco, disponivel: true }); continue; }
        const texto = textoDoAviso(pedido, m.preco, conf.tipo, m.link, { loja: mo.prod.loja, cupom: mo.cupom });
        const precoEnviado = m.preco;
        enfileirarEnvio(pedido.jid, texto, {
          pedidoId: pedido.id,
          aoEnviar: () => {
            const em = new Date().toISOString();
            pedido.ultimoAvisoPreco = precoEnviado; pedido.ultimoAvisoEm = em;
            pedido.avisos.push({ em, preco: precoEnviado, tipo: conf.tipo, loja: mo.prod.loja, cupom: mo.cupom || null });
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
        // Também para os grupos (card de revisão no bot), só alvo ou queda de verdade.
        if (conf.tipo === 'alvo' || conf.tipo === 'queda') {
          const g = paraGrupos.get(mo.prod.asin);
          if (g) { g.clientes++; if (conf.tipo === 'alvo') g.tipo = 'alvo'; }
          else paraGrupos.set(mo.prod.asin, { prod: mo.prod, cupom: mo.cupom || null, tipo: conf.tipo, clientes: 1, preco: m.preco, alvo: pedido.precoAlvo || null });
        }
      }
      for (const g of paraGrupos.values()) await cardParaGrupos(g, res);
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


// ── OUTRAS LOJAS E CUPOM DO ML (05/11/2026) ─────────────────────────────────
// O mesmo produto pode estar mais barato em outra loja, ou sair mais barato no
// ML com o cupom que o anúncio oferece. Tudo aqui roda em segundo plano (nunca
// na conversa): um trabalho a cada 15 min procura o produto nas outras lojas
// (Amazon e Shopee têm busca; o ML não deixa buscar, então só entra à mão pelo
// painel), confere com IA se é o MESMO produto e passa a vigiar o achado junto.
// O aviso sai pelo menor preço entre as lojas, com o link da loja mais barata.
// Cupom do ML: só o que está NA PÁGINA do anúncio e vigente na base (mesma
// regra do Catálogo — o sistema nunca escolhe cupom por conta própria).
const EQUIV_CONFIANCA_MIN = 85;
const EQUIV_REBUSCA_DIAS = 7;
const CUPOM_ML_RECHECA_H = 12;
let _ultimaBuscaEquiv = null;
const _errosBusca = {};
let _trabalhando = false;

function precoEfetivo(p, maxIdadeMs = Infinity) {
  if (!p?.ult?.preco || p.ult.disponivel === false) return null;
  if (Date.now() - Date.parse(p.ult.em) > maxIdadeMs) return null;
  let preco = p.ult.preco, cupom = null;
  const c = p.cupomMl;
  // O desconto foi lido para um preço; com o preço mudando mais de 5% ele
  // pode não valer igual — espera a próxima conferência.
  if (c?.estado === 'ok' && c.codigo && c.desconto > 0 && c.precoRef
      && Math.abs(preco - c.precoRef) / c.precoRef <= 0.05
      && Date.now() - Date.parse(c.em) < 24 * MS_H) {
    preco = arred(Math.max(0.01, preco - c.desconto)); cupom = c.codigo;
  }
  return { preco, cupom };
}

function melhorOferta(prod, { maxIdadeMs = Infinity } = {}) {
  const cands = [prod];
  for (const eq of prod.equivalentes || []) {
    if (eq.ativo === false) continue;
    const q = E().produtos[eq.chave];
    if (q) cands.push(q);
  }
  let melhor = null;
  for (const q of cands) {
    const ef = precoEfetivo(q, maxIdadeMs);
    if (!ef) continue;
    if (!melhor || ef.preco < melhor.preco - 0.009) melhor = { prod: q, preco: ef.preco, cupom: ef.cupom };
  }
  return melhor;
}

function painelDoProduto(prod) {
  const mo = melhorOferta(prod);
  const ofertaPainel = q => ({
    chave: q.asin, loja: q.loja, titulo: q.titulo || '', url: q.url || '',
    preco: q.ult?.preco ?? null, disponivel: q.ult ? q.ult.disponivel !== false : null, lidoEm: q.lidoEm || null,
    falha: q.falhas ? q.falhaMotivo : null,
    cupomMl: q.loja === 'Mercado Livre' ? (q.cupomMl || null) : undefined,
  });
  return {
    ...ofertaPainel(prod),
    melhor: mo ? { chave: mo.prod.asin, loja: mo.prod.loja, preco: mo.preco, cupom: mo.cupom || null } : null,
    equivalentes: (prod.equivalentes || []).map(eq => {
      const q = E().produtos[eq.chave] || { asin: eq.chave, loja: eq.loja, titulo: eq.titulo };
      return { ...ofertaPainel(q), confianca: eq.confianca ?? null, origem: eq.origem, motivo: eq.motivo || '',
               ativo: eq.ativo !== false, em: eq.em, removidoEm: eq.removidoEm || null };
    }),
    busca: prod.equivBusca || null,
    cardGrupo: (() => { const qs = [prod, ...(prod.equivalentes || []).map(e => E().produtos[e.chave]).filter(Boolean)].map(q => q.cardGrupo).filter(Boolean);
                         return qs.sort((a, b) => String(b.em).localeCompare(String(a.em)))[0] || null; })(),
  };
}

// ── Cupom do ML ──
function codigosMlVigentes() {
  try {
    return listarCuponsBase().filter(r => r.loja === 'Mercado Livre' && cupomVigente(r) && r.codigo).map(r => String(r.codigo).toUpperCase()).sort();
  } catch (e) { return []; }
}

function marcarCuponsNovosMl() {
  const atuais = codigosMlVigentes();
  const vistos = new Set(E().cuponsMlVistos || []);
  const novos = atuais.filter(c => !vistos.has(c));
  E().cuponsMlVistos = atuais;
  if (novos.length && vistos.size) {
    for (const p of Object.values(E().produtos)) if (p.loja === 'Mercado Livre') p.cupomMlRechecar = true;
    console.log('[AVISOS] Cupom novo do ML na base (' + novos.slice(0, 5).join(', ') + '): reconferindo os produtos dos alertas.');
  }
  return novos.length;
}

function precisaConferirCupom(p) {
  if (p.loja !== 'Mercado Livre' || !p.url || !p.ult?.preco) return false;
  if (p.cupomMlTentativaEm && Date.now() - Date.parse(p.cupomMlTentativaEm) < MS_H) return false;
  const c = p.cupomMl;
  if (!c || p.cupomMlRechecar) return true;
  if (Date.now() - Date.parse(c.em) >= CUPOM_ML_RECHECA_H * MS_H) return true;
  return c.precoRef && Math.abs(p.ult.preco - c.precoRef) / c.precoRef > 0.05;
}

async function conferirCupomMl(p) {
  p.cupomMlTentativaEm = new Date().toISOString();
  let r = null;
  try { r = await cupomDaPaginaParaCatalogoMl(p.url, p.ult?.preco || null); } catch (e) { r = { estado: 'indisponivel', motivo: e.message }; }
  if (!r || r.estado === 'indisponivel') return r;   // fica o que já havia; tenta de novo em 1 h
  p.cupomMl = { estado: r.estado, codigo: r.codigo || null, desconto: r.desconto ? arred(r.desconto) : null,
                precoRef: r.preco ? arred(r.preco) : (p.ult?.preco || null), em: new Date().toISOString() };
  p.cupomMlRechecar = false;
  if (r.estado === 'ok') console.log('[AVISOS] Cupom ' + r.codigo + ' vale para ' + p.asin + ' (−' + brl(r.desconto) + ').');
  return r;
}

// ── Mesmo produto em outras lojas ──
function termoDeBusca(titulo) {
  return String(titulo || '')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/[^\p{L}\p{N}\s.,-]/gu, ' ')
    .split(/\s+/).filter(Boolean).slice(0, 10).join(' ');
}

async function candidatosNaLoja(loja, termo) {
  if (loja === 'Amazon') {
    const brutos = await buscarAmazonPorTermo(termo, 10);
    return brutos.map(b => { try { return normalizarAmazon(b); } catch (e) { return null; } }).filter(x => x && x.asin && x.preco > 0)
      .map(x => ({ loja, item: { asin: x.asin, loja, url: 'https://www.amazon.com.br/dp/' + x.asin, nome: x.titulo },
                   leitura: { preco: x.preco, precoDe: x.precoDe, disponivel: x.disponivel !== false, titulo: x.titulo, imagem: x.imagemUrl || null } }));
  }
  if (loja === 'Shopee') {
    if (!credenciaisShopeeOk()) return [];
    const nodes = await buscarShopeePorTermo(termo, 10);
    return nodes.map(n => { const x = normalizarShopee(n); return { n, x }; }).filter(({ x }) => x.preco > 0)
      .map(({ n, x }) => ({ loja, item: { asin: 'SHOPEE-' + n.shopId + '-' + n.itemId, loja, shopId: String(n.shopId), itemId: String(n.itemId), url: n.productLink || n.offerLink || '', nome: x.titulo },
                             leitura: { preco: x.preco, precoDe: x.precoDe, disponivel: true, titulo: x.titulo, imagem: x.imagemUrl || null } }));
  }
  return [];
}

const IA_EQUIV = `Você compara anúncios de lojas online brasileiras. Recebe o PRODUTO ORIGINAL e uma lista numerada de CANDIDATOS de outras lojas. Diga quais candidatos são EXATAMENTE o mesmo produto: mesma marca, mesmo modelo/linha, mesma versão (tamanho, capacidade, volume, voltagem, cor quando faz diferença) e mesma quantidade de unidades no pacote. NÃO é o mesmo: kit ou pack com quantidade diferente, acessório, refil, capa, peça, modelo parecido ou de outra geração, produto genérico "compatível". Na dúvida, deixe de fora.
Responda só com JSON, sem texto fora dele: {"iguais":[{"i":<número do candidato>,"confianca":<0 a 100>,"motivo":"<até 12 palavras>"}]}. Liste só os que você acha iguais com confiança de 70 ou mais.`;

export async function buscarEquivalentesDe(prod, { manual = false } = {}) {
  const busca = { em: new Date().toISOString(), termo: termoDeBusca(prod.titulo), lojas: {}, achados: 0 };
  prod.equivBusca = busca;
  prod.equivalentes = Array.isArray(prod.equivalentes) ? prod.equivalentes : [];
  if (!busca.termo || !_deps.ia) { busca.erro = !busca.termo ? 'produto sem título' : 'IA indisponível'; return busca; }
  const lojas = ['Amazon', 'Shopee'].filter(l => l !== prod.loja);
  const cands = [];
  for (const loja of lojas) {
    // Loja com link escolhido à mão no painel fica como está.
    if (prod.equivalentes.some(eq => eq.loja === loja && eq.origem === 'manual' && eq.ativo !== false)) { busca.lojas[loja] = 'manual'; continue; }
    try {
      const lista = (await candidatosNaLoja(loja, busca.termo))
        .filter(c => c.item.asin !== prod.asin && !prod.equivalentes.some(eq => eq.chave === c.item.asin && eq.ativo === false))
        .slice(0, 8);
      busca.lojas[loja] = lista.length + ' candidato(s)';
      cands.push(...lista);
      delete _errosBusca[loja];
    } catch (e) {
      busca.lojas[loja] = 'erro: ' + String(e.message || e).slice(0, 140);
      _errosBusca[loja] = { em: busca.em, erro: busca.lojas[loja] };
      console.warn('[AVISOS] Busca na ' + loja + ' falhou: ' + e.message);
    }
  }
  if (!cands.length) { gravar(); return busca; }
  const texto = 'PRODUTO ORIGINAL (' + prod.loja + '): ' + prod.titulo + (prod.ult?.preco ? ' — ' + brl(prod.ult.preco) : '')
    + '\n\nCANDIDATOS:\n' + cands.map((c, i) => (i + 1) + '. [' + c.loja + '] ' + String(c.leitura.titulo || '').slice(0, 220) + ' — ' + brl(c.leitura.preco)).join('\n');
  let r = null;
  try { r = await _deps.ia(IA_EQUIV, texto, 600, 'claude-sonnet-4-6'); } catch (e) { busca.erro = 'IA: ' + e.message; }
  const iguais = Array.isArray(r?.iguais) ? r.iguais : [];
  const ref = prod.ult?.preco || null;
  const porLoja = {};
  for (const g of iguais) {
    const c = cands[Number(g.i) - 1];
    const conf = Number(g.confianca) || 0;
    if (!c || conf < EQUIV_CONFIANCA_MIN) continue;
    // Preço muito fora (metade ou o dobro) costuma ser outra versão ou kit.
    if (ref && (c.leitura.preco < ref * 0.5 || c.leitura.preco > ref * 2)) continue;
    const atual = porLoja[c.loja];
    if (!atual || conf > atual.conf || (conf === atual.conf && c.leitura.preco < atual.c.leitura.preco)) porLoja[c.loja] = { c, conf, motivo: String(g.motivo || '').slice(0, 120) };
  }
  for (const [loja, { c, conf, motivo }] of Object.entries(porLoja)) {
    const q = guardarProduto(c.item, c.leitura);
    // Troca o automático anterior da mesma loja; o manual nunca é trocado.
    prod.equivalentes = prod.equivalentes.filter(eq => !(eq.loja === loja && eq.origem === 'auto' && eq.ativo !== false && eq.chave !== q.asin));
    const ja = prod.equivalentes.find(eq => eq.chave === q.asin);
    if (ja) { ja.confianca = conf; ja.motivo = motivo; ja.em = busca.em; }
    else prod.equivalentes.push({ chave: q.asin, loja, origem: 'auto', confianca: conf, motivo, titulo: q.titulo, em: busca.em, ativo: true });
    busca.achados++;
  }
  console.log('[AVISOS] Outras lojas de ' + prod.asin + ': ' + busca.achados + ' equivalente(s) (' + cands.length + ' candidato(s)).');
  gravar();
  return busca;
}

function precisaBuscarEquiv(p) {
  if (!p.titulo) return false;
  const b = p.equivBusca;
  if (!b) return true;
  return Date.now() - Date.parse(b.em) >= EQUIV_REBUSCA_DIAS * MS_DIA;
}

export async function trabalhoOutrasLojas() {
  if (_trabalhando) return { ok: false, erro: 'em andamento' };
  const h = horaSP();
  if (h < 8 || h >= 23) return { ok: true, pulado: 'fora do horário' };
  _trabalhando = true;
  const res = { em: new Date().toISOString(), buscas: 0, cupons: 0 };
  try {
    // 1. Mesmo produto em outras lojas: 2 por rodada, os nunca buscados primeiro.
    const fila = produtosBase().filter(precisaBuscarEquiv)
      .sort((a, b) => (a.equivBusca ? Date.parse(a.equivBusca.em) : 0) - (b.equivBusca ? Date.parse(b.equivBusca.em) : 0));
    for (const p of fila.slice(0, 2)) { await buscarEquivalentesDe(p); res.buscas++; }
    // 2. Cupom da página do ML (pela extensão, uma página por vez).
    res.cuponsNovos = marcarCuponsNovosMl();
    const ml = produtosVigiados().filter(precisaConferirCupom);
    for (const p of ml.slice(0, 4)) { await conferirCupomMl(p); res.cupons++; }
    gravar();
  } finally {
    _trabalhando = false;
    _ultimaBuscaEquiv = res;
  }
  return { ok: true, ...res };
}

// Painel: remover / trocar / adicionar link de outra loja, ou buscar de novo.
export async function acaoEquivalente({ produto, acao, chave, url } = {}) {
  const prod = E().produtos[produto];
  if (!prod) return { ok: false, erro: 'produto não encontrado' };
  prod.equivalentes = Array.isArray(prod.equivalentes) ? prod.equivalentes : [];
  if (acao === 'buscar') {
    const b = await buscarEquivalentesDe(prod, { manual: true });
    return { ok: true, busca: b, produto: painelDoProduto(prod) };
  }
  if (acao === 'cupom') {
    const alvo = chave ? E().produtos[chave] : prod;
    if (!alvo || alvo.loja !== 'Mercado Livre') return { ok: false, erro: 'só produtos do Mercado Livre têm cupom de página' };
    const r = await conferirCupomMl(alvo); gravar();
    return { ok: true, cupom: r, produto: painelDoProduto(prod) };
  }
  if (acao === 'remover' || acao === 'trocar') {
    const eq = prod.equivalentes.find(e => e.chave === chave && e.ativo !== false);
    if (!eq) return { ok: false, erro: 'link não encontrado' };
    // Fica na lista como removido: a busca automática não traz de volta.
    eq.ativo = false; eq.removidoEm = new Date().toISOString();
    if (acao === 'remover') { gravar(); return { ok: true, produto: painelDoProduto(prod) }; }
  }
  if (acao === 'trocar' || acao === 'adicionar') {
    const r = await resolverLink(url);
    if (!r || r.erro) { gravar(); return { ok: false, erro: r?.erro || 'não consegui ler o link' }; }
    if (r.item.asin === prod.asin) return { ok: false, erro: 'esse link é o próprio produto do pedido' };
    const q = guardarProduto(r.item, r.leitura);
    // Um link manual por loja: o anterior dessa loja sai.
    for (const e of prod.equivalentes) if (e.loja === q.loja && e.ativo !== false && e.chave !== q.asin) { e.ativo = false; e.removidoEm = new Date().toISOString(); }
    const ja = prod.equivalentes.find(e => e.chave === q.asin);
    if (ja) Object.assign(ja, { ativo: true, removidoEm: null, origem: 'manual', confianca: 100, em: new Date().toISOString() });
    else prod.equivalentes.push({ chave: q.asin, loja: q.loja, origem: 'manual', confianca: 100, titulo: q.titulo, em: new Date().toISOString(), ativo: true });
    gravar();
    return { ok: true, produto: painelDoProduto(prod) };
  }
  return { ok: false, erro: 'ação inválida' };
}

// ── Card para os grupos (05/11/2026) ──
// Link só no privado, com poucos cliques, arrisca a comissão; a mesma oferta
// vira card no @ticopromosbot (marcado como alerta de cliente) para o operador
// mandar também aos grupos. Um card por produto a cada 24 h, salvo nova queda de 3%.
async function cardParaGrupos(g, res) {
  if (!_deps.cardGrupos || E().config.cardGrupos === false) return;
  const p = g.prod;
  const ult = p.cardGrupo;
  if (ult && Date.now() - Date.parse(ult.em) < 24 * MS_H && !(g.preco < ult.preco * 0.97)) return;
  try {
    const r = await _deps.cardGrupos({ item: itemDoProduto(p), cupom: g.cupom, tipo: g.tipo, clientes: g.clientes, precoAviso: g.preco, alvo: g.alvo });
    if (r?.ok) { p.cardGrupo = { em: new Date().toISOString(), preco: g.preco, id: r.id }; res.cards = (res.cards || 0) + 1; }
    else if (r?.jaEnviado || r?.duplicado) p.cardGrupo = { em: new Date().toISOString(), preco: g.preco, pulado: r.jaEnviado ? 'já enviado nos grupos em 15 dias' : 'card pendente' };
    else console.warn('[AVISOS] Card para os grupos não criado (' + p.asin + '): ' + (r?.erro || '?'));
  } catch (e) { console.warn('[AVISOS] Card para os grupos falhou (' + p.asin + '): ' + e.message); }
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
        produto: p.produto || null,
      };
    }),
    produtos: Object.fromEntries(produtosBase().map(prod => [prod.asin, painelDoProduto(prod)])),
    buscaOutrasLojas: { ultima: _ultimaBuscaEquiv, erros: _errosBusca },
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
  if ('cardGrupos' in parcial) c.cardGrupos = !!parcial.cardGrupos;
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
  // Outras lojas + cupom do ML: em segundo plano, separado da conversa.
  setInterval(() => { trabalhoOutrasLojas().catch(e => console.warn('[AVISOS] Outras lojas: ' + e.message)); }, 15 * 60000);
  setTimeout(() => { trabalhoOutrasLojas().catch(() => {}); }, 7 * 60000);
  // Fila parada por conta desconectada: tenta de novo a cada 2 min.
  setInterval(() => { if (_filaEnvio.length) processarFila(); }, 2 * 60000);
  console.log('[AVISOS] Avisos de preço inicializados (' + E().pedidos.filter(p => p.status === 'ativo').length + ' pedido(s) ativo(s)).');
}
