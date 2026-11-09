// ═══════════════════════════════════════════════════════════════════════════
// radar-shopee.js — Integracao com a Shopee Affiliate Open API (GraphQL).
//
// Mesmo papel que o radar-amazon.js cumpre para a Amazon: dado um link vindo de
// um grupo-fonte, descobre o produto, consulta preco na API oficial e devolve a
// mensagem pronta usando o template da loja e a base de cupons compartilhada.
//
// Endpoint BR: open-api.affiliate.shopee.com.br/graphql
// Autenticacao: header Authorization com assinatura
//   SHA256(appId + timestamp + payload + secret)
// onde 'payload' e a STRING JSON exatamente como vai no corpo — serializar duas
// vezes gera assinaturas diferentes e a API responde 10020 Invalid Signature.
//
// Requisitos no Railway:
//   SHOPEE_APP_ID      App ID do painel de afiliado
//   SHOPEE_SECRET      Secret do painel de afiliado
// ═══════════════════════════════════════════════════════════════════════════

import { createHash } from 'crypto';
import { credencialTsp } from './config-tsp.js';
import { resolverPrecoDe, FONTE_API } from './preco-de.js';
import {
  melhorCupom, cupomPorCodigo, cupomVigente, calcularDesconto,
  templateDaLoja, renderTemplate, varsDoProduto, melhorCupomAplicavel,
  refDoDisparo, aplicarRefNoLink, blocoDoLink,
} from './radar-amazon.js';

const API_URL = 'https://open-api.affiliate.shopee.com.br/graphql';

export function credenciaisShopeeOk() {
  return !!(credencialTsp('SHOPEE_APP_ID') && credencialTsp('SHOPEE_SECRET'));
}

/**
 * Executa uma operacao GraphQL assinada.
 * O corpo e montado UMA vez e reusado na assinatura e no envio.
 *
 * Exportada para a sonda de diagnostico (/shopee/sonda): a Shopee muda o schema
 * sem aviso, e descobrir isso com uma query de introspeccao e mais barato do que
 * descobrir com o radar quebrado em producao.
 */
export async function chamarShopee(query, variables = null) {
  const appId  = credencialTsp('SHOPEE_APP_ID');
  const secret = credencialTsp('SHOPEE_SECRET');
  if (!appId || !secret) throw new Error('SHOPEE_APP_ID / SHOPEE_SECRET nao configurados.');

  // A Shopee rejeita Int64 passado por variavel ("wrong type"); os exemplos
  // oficiais montam os valores inline na query. Só envia 'variables' quando
  // houver de fato, para nao mandar um objeto vazio junto.
  const payload = JSON.stringify(variables ? { query, variables } : { query });
  const timestamp = Math.floor(Date.now() / 1000);
  const assinatura = createHash('sha256').update(appId + timestamp + payload + secret).digest('hex');

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `SHA256 Credential=${appId}, Timestamp=${timestamp}, Signature=${assinatura}`,
    },
    body: payload,
    signal: AbortSignal.timeout(20000),
  });

  const texto = await res.text();
  let dados;
  try { dados = JSON.parse(texto); }
  catch (e) { throw new Error('resposta nao-JSON da Shopee (' + res.status + '): ' + texto.slice(0, 200)); }

  if (dados.errors?.length) {
    const err = dados.errors[0];
    const codigo = err.extensions?.code;
    // 10035 nao e erro de codigo: e a conta sem acesso liberado ao Open API.
    if (codigo === 10035) throw new Error('conta sem acesso liberado ao Open API da Shopee (erro 10035)');
    if (codigo === 10020) throw new Error('assinatura ou credencial invalida (erro 10020)');
    if (codigo === 10030) throw new Error('limite de requisicoes excedido (erro 10030)');
    throw new Error('Shopee: ' + (err.message || 'erro desconhecido'));
  }
  return dados.data;
}

// ── LINKS ─────────────────────────────────────────────────────────────────
// Formato canonico: .../nome-do-produto-i.{shopId}.{itemId}
// Encurtadores (s.shopee.com.br, shope.ee) precisam de redirect antes.

const REGEX_URL_SHOPEE = /https?:\/\/(?:[\w-]+\.)*(?:shopee\.com\.br|shope\.ee|s\.shopee\.com\.br)\/\S+/gi;

export function ehLinkShopee(texto) {
  const r = new RegExp(REGEX_URL_SHOPEE.source, 'i');
  return r.test(String(texto || ''));
}

// A Shopee expoe o mesmo produto em tres formatos de URL, e o encurtador
// resolve para qualquer um deles dependendo da origem do link:
//   1. canonico  .../Nome-Do-Produto-i.{shopId}.{itemId}
//   2. classico  .../product/{shopId}/{itemId}
//   3. afiliado  .../opaanlp/{shopId}/{itemId}   (landing de campanha)
// O fallback pega prefixos novos que sigam o mesmo par shopId/itemId no path,
// exigindo 6+ digitos em cada um para nao confundir com paginacao ou categoria.
function idsDeUrl(url) {
  const s = String(url || '');
  const padroes = [
    /-i\.(\d+)\.(\d+)/,
    /\/(?:product|opaanlp)\/(\d+)\/(\d+)/i,
    /\/(\d{6,})\/(\d{6,})(?:[/?#]|$)/,
  ];
  for (const re of padroes) {
    const m = s.match(re);
    if (m) return { shopId: Number(m[1]), itemId: Number(m[2]) };
  }
  return null;
}

export async function resolverEncurtadorShopee(url, tentativas = 5) {
  let atual = url;
  for (let i = 0; i < tentativas; i++) {
    const res = await fetch(atual, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        'Accept-Language': 'pt-BR,pt;q=0.9',
      },
      signal: AbortSignal.timeout(10000),
    });
    const loc = res.headers.get('location');
    if (!loc) return res.url || atual;
    atual = new URL(loc, atual).href;
    if (idsDeUrl(atual)) return atual;
  }
  return atual;
}

/**
 * Resolve cada link Shopee do texto UMA vez: produto ({ids}) ou outra pagina
 * ({final}: campanha, cupom, loja). O link que nao e produto deixou de ser so
 * descartado — e nele que mora o resgate do cupom (ver CUPOM DE RESGATE).
 */
async function resolverLinksShopee(texto) {
  if (!texto) return [];
  const urls = [...new Set(String(texto).match(REGEX_URL_SHOPEE) || [])]
    .map(u => u.replace(/[)\]}.,;!*_~]+$/, ''));
  const saida = [];
  for (const url of urls) {
    let ids = idsDeUrl(url);
    let final = null;
    if (!ids) {
      try {
        final = await resolverEncurtadorShopee(url);
        ids = idsDeUrl(final);
      } catch (e) { console.warn('[SHOPEE] Falha ao resolver', url, '-', e.message); }
    }
    saida.push({ url, ids: ids || null, final: ids ? null : final });
  }
  return saida;
}

function idsUnicos(links) {
  const achados = [];
  const vistos = new Set();
  for (const l of links) {
    if (!l.ids) { console.warn('[SHOPEE] Sem itemId para', l.url); continue; }
    const chave = l.ids.shopId + ':' + l.ids.itemId;
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    achados.push(l.ids);
  }
  return achados;
}

/** Extrai os pares {shopId,itemId} de todos os links Shopee de um texto. */
export async function extrairIdsShopee(texto) {
  return idsUnicos(await resolverLinksShopee(texto));
}

// ── CUPOM DE RESGATE (09/11/2026) ─────────────────────────────────────────
// Na Shopee o desconto do cupom quase sempre exige RESGATAR o cupom numa
// pagina de campanha antes de comprar ("Use o cupom R$100 Off, resgate o cupom
// aqui: <link>"). Nao ha codigo para a base casar, entao a oferta saia pelo
// preco cheio, sem a linha do cupom e sem o link de resgate. Agora o link que
// nao e produto e que o post apresenta como resgate de cupom vira o NOSSO link
// de afiliado (generateShortLink sobre a pagina, sem os parametros de rastreio
// do afiliado de origem), o valor lido do post abate do preco e a mensagem
// leva os dois links: o do cupom na linha CUPOM e o do produto no LINK.
// Regra de sempre do TSP mantida: o cupom so entra porque o POST o citou.

// Parametros de rastreio de quem postou. Os demais ficam: pagina de cupom pode
// precisar de promotionId/evcode/signature para abrir o cupom certo.
const RE_PARAM_TERCEIRO = /^(?:mmp_pid|uls_\w+|utm_\w+|af_\w+|pid|c|is_retargeting|exp_group|sub_id\d*|smtt|deep_and_deferred|gads_t_sig|share_channel_code|xptdk|__mobile__)$/i;

export function limparLinkResgate(url) {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) if (RE_PARAM_TERCEIRO.test(k)) u.searchParams.delete(k);
    u.hash = '';
    return u.toString();
  } catch { return null; }
}

const VALOR_RS = '(\\d{1,3}(?:\\.\\d{3})+(?:,\\d{1,2})?|\\d+(?:,\\d{1,2})?)';
const numBr = s => Number(String(s).replace(/\./g, '').replace(',', '.'));
const rsCurto = v => 'R$ ' + (Number.isInteger(v) ? String(v) : v.toFixed(2).replace('.', ','));

/**
 * Le o cupom que o post manda resgatar: "cupom R$100 Off", "R$ 20 de desconto",
 * "cupom de 10%", "15% OFF ate R$ 30", "acima de R$ 99". Texto em letras
 * estilizadas (𝐫𝐞𝐬𝐠𝐚𝐭𝐞) e normalizado antes (NFKC). null quando o trecho
 * nao fala de cupom ou nao da um valor.
 */
export function lerCupomResgate(trecho) {
  const t = String(trecho || '').normalize('NFKC')
    .replace(/https?:\/\/\S+/g, ' ').replace(/[*_~`]/g, '')
    .toLowerCase().replace(/[ \t]+/g, ' ');
  if (!/cupo[mn]|resgat|voucher/.test(t)) return null;
  let tipo = null, valor = null, m;
  m = t.match(new RegExp('r\\$ ?' + VALOR_RS + ' ?(?:reais )?(?:de )?(?:off|desconto)\\b'))
   || t.match(new RegExp('cupo[mn]s? ?:? ?(?:de desconto )?(?:de )?:? ?r\\$ ?' + VALOR_RS))
   || t.match(new RegExp(VALOR_RS + ' ?reais (?:de )?(?:off|desconto)\\b'));
  if (m) { tipo = 'valor'; valor = numBr(m[1]); }
  else {
    m = t.match(/(\d{1,2}) ?% ?(?:de )?(?:off|desconto)\b/) || t.match(/cupo[mn]s? ?:? ?(?:de desconto )?(?:de )?:? ?(\d{1,2}) ?%/);
    if (m) { tipo = 'pct'; valor = Number(m[1]); }
  }
  if (!(valor > 0) || (tipo === 'pct' && valor > 90)) return null;
  const mMin = t.match(new RegExp('(?:acima de|a partir de|m[ií]nim[oa](?: de)?|compras? (?:acima )?de) ?:? ?r\\$ ?' + VALOR_RS));
  const minimo = mMin ? numBr(mMin[1]) : null;
  let teto = null;
  if (tipo === 'pct') {
    const mTeto = t.match(new RegExp('(?:at[eé]|limite(?: de)?|m[aá]ximo(?: de)?) ?r\\$ ?' + VALOR_RS));
    teto = mTeto ? numBr(mTeto[1]) : null;
  }
  const rotulo = (tipo === 'valor' ? rsCurto(valor) + ' OFF' : valor + '% OFF')
    + (teto ? ' (até ' + rsCurto(teto) + ')' : '')
    + (minimo ? ' acima de ' + rsCurto(minimo) : '');
  return { tipo, valor, minimo, teto, rotulo };
}

/** Quanto o cupom de resgate abate deste preco (0 quando nao atinge o minimo). */
export function descontoCupomResgate(info, preco) {
  const pr = Number(preco);
  if (!info || !(pr > 0)) return 0;
  if (info.minimo && pr < info.minimo) return 0;
  let d = info.tipo === 'pct' ? pr * info.valor / 100 : Number(info.valor);
  if (info.tipo === 'pct' && info.teto) d = Math.min(d, info.teto);
  d = Math.min(d, pr);
  return Math.round(d * 100) / 100;
}

/** Links do post que nao sao produto e que o texto apresenta como resgate de cupom. */
function linksDeResgate(texto, links) {
  const outros = links.filter(l => !l.ids && l.final && /shopee\.com\.br/i.test(l.final));
  const saida = [];
  for (const l of outros) {
    const bloco = blocoDoLink(texto, l.url) || '';
    let info = lerCupomResgate(bloco);
    // O valor as vezes vem depois do link ("Resgate aqui: <link> / R$ 20 OFF").
    // Com um so link de resgate, o post inteiro fala dele.
    if (!info && outros.length === 1) info = lerCupomResgate(texto);
    const fala = /cupo[mn]|resgat|voucher/.test(String(bloco).normalize('NFKC').toLowerCase());
    if (!info && !fala) continue;
    saida.push({ url: l.url, final: l.final, limpa: limparLinkResgate(l.final), info });
  }
  return saida;
}

// ── CONSULTA DE PRODUTO ───────────────────────────────────────────────────

const CAMPOS_PRODUTO = `itemId shopId productName imageUrl productLink offerLink
      priceMin priceMax priceDiscountRate ratingStar sales
      shopName commissionRate commission`;

/** Gera o link curto de afiliado. Usado so quando offerLink nao vem na oferta. */
export async function gerarLinkAfiliado(originUrl, subIds = ['cdv']) {
  // JSON.stringify escapa aspas da URL, que entra literal na query.
  const listaSubIds = (subIds || []).map(s => JSON.stringify(String(s))).join(',');
  const mutation = `mutation {
    generateShortLink(input: { originUrl: ${JSON.stringify(originUrl)}, subIds: [${listaSubIds}] }) {
      shortLink
    }
  }`;
  const d = await chamarShopee(mutation);
  return d?.generateShortLink?.shortLink || null;
}

export async function buscarProdutoShopee({ shopId, itemId }) {
  const sid = Number(shopId), iid = Number(itemId);
  if (!Number.isFinite(sid) || !Number.isFinite(iid)) throw new Error('shopId/itemId invalidos');
  const query = `{
    productOfferV2(shopId: ${sid}, itemId: ${iid}, limit: 1) {
      nodes { ${CAMPOS_PRODUTO} }
    }
  }`;
  const d = await chamarShopee(query);
  return d?.productOfferV2?.nodes?.[0] || null;
}

// Busca por palavra-chave (avisos de preco: achar o mesmo produto na Shopee).
// sortType 1 = relevancia.
export async function buscarShopeePorTermo(termo, n = 10) {
  const q = String(termo || '').trim().slice(0, 120);
  if (!q) return [];
  const query = `{
    productOfferV2(keyword: ${JSON.stringify(q)}, sortType: 1, page: 1, limit: ${Math.min(20, Math.max(1, Number(n) || 10))}) {
      nodes { ${CAMPOS_PRODUTO} }
    }
  }`;
  const d = await chamarShopee(query);
  return d?.productOfferV2?.nodes || [];
}

/**
 * Converte a resposta da Shopee no mesmo formato do produto normalizado da
 * Amazon, para o template e o calculo de cupom funcionarem sem saber de qual
 * loja veio.
 *
 * A Shopee nao devolve preco de tabela: devolve priceDiscountRate. O preco
 * "de" e derivado dai — com desconto de 20%, preco atual = 80% do original.
 */
export function normalizarShopee(n) {
  const preco = Number(n.priceMin);
  const taxa  = Number(n.priceDiscountRate) || 0;
  const derivado = (taxa > 0 && taxa < 100 && isFinite(preco))
    ? Math.round((preco / (1 - taxa / 100)) * 100) / 100
    : null;
  // O valor e derivado da taxa, entao a conferencia cruzada sempre bate — o que
  // as travas pegam aqui e taxa absurda (95% vira um "de" de 20x o preco).
  const resolvido = resolverPrecoDe({
    preco,
    descontoDeclarado: taxa || null,
    rotulo: 'Shopee ' + (n.itemId || ''),
    candidatos: [{ fonte: FONTE_API, valor: derivado }],
  });
  const precoDe = resolvido.precoDe;

  return {
    asin: String(n.itemId),          // o template usa 'asin' como id generico
    itemId: String(n.itemId),
    shopId: String(n.shopId),
    titulo: n.productName || '',
    marca: '',
    // A imagem cheia da Shopee passa de 350KB e estoura o limite do
    // jpegThumbnail do WhatsApp (~100KB), o que derruba o preview. O sufixo
    // _tn devolve a mesma imagem em ~34KB.
    imagemUrl: n.imageUrl ? n.imageUrl.replace(/(_tn)?$/, '_tn') : null,
    imagemUrlCheia: n.imageUrl || null,
    link: n.offerLink || n.productLink || '',
    preco: isFinite(preco) ? preco : null,
    precoTexto: isFinite(preco) ? 'R$ ' + preco.toFixed(2).replace('.', ',') : null,
    precoDe,
    precoDeFonte: resolvido.fonte,
    precoDeTexto: precoDe ? 'R$ ' + precoDe.toFixed(2).replace('.', ',') : null,
    desconto: precoDe ? resolvido.desconto : 0,
    // A Shopee nao expoe estoque nesta query; uma oferta listada e considerada
    // ativa. Preco ausente continua barrando o envio.
    disponivel: isFinite(preco) && preco > 0,
    vendedor: n.shopName || null,
    ehDeal: false,
    dealTermina: null,
    nota: n.ratingStar ? Number(n.ratingStar) : null,
    avaliacoes: null,
    vendas: n.sales ?? null,
    comissao: n.commissionRate ? Math.round(Number(n.commissionRate) * 1000) / 10 : null,
    loja: 'Shopee',
  };
}

// ── RASTREIO ──────────────────────────────────────────────────────────────
// Registra o produto no ledger (ref deterministico por itemId) e troca o link
// por um shortlink gerado JA com o subId embutido — e o subId passado ao
// generateShortLink que reaparece no utmContent do conversionReport e no
// relatorio de cliques. Query param acrescentado a um shortlink pronto pode se
// perder no redirect, entao so serve de ultimo recurso quando a geracao falha:
// rastreio pior, mesmo afiliado. Sem este passo a oferta sai sem marcacao
// nenhuma — era o furo que deixava o ledger sem refs da Shopee.
async function marcarRastreio(p, node) {
  try {
    const ref = refDoDisparo(p);
    if (!ref) return;
    const marcado = await gerarLinkAfiliado(node?.productLink || p.link, [ref]).catch(() => null);
    p.link = marcado || aplicarRefNoLink(p.link, 'shopee', ref);
  } catch (e) {
    console.log('[SHOPEE] rastreio falhou (oferta segue sem marcação):', e.message);
  }
}

export function formatarOfertaShopee(p, opcoes = {}) {
  const tpl  = opcoes.template || templateDaLoja('Shopee');
  const vars = varsDoProduto(p, opcoes.cupom || null);
  vars.vendas = p.vendas || '';
  vars.comissao = p.comissao != null ? String(p.comissao).replace('.', ',') : '';
  return renderTemplate(tpl?.corpo || '', vars);
}

/**
 * Pipeline equivalente ao da Amazon: texto -> ofertas prontas.
 * A API e a fonte da verdade do preco; o cupom vem da base e so e aplicado se
 * o codigo aparecer no texto original.
 */
export async function processarTextoShopee(texto, opcoes = {}) {
  const links = await resolverLinksShopee(texto);
  const ids = idsUnicos(links);
  if (!ids.length) return [];
  // Cupom de resgate so vale em post de UM produto: numa lista, o post nao diz
  // a qual item o cupom serve e o comportamento antigo (sem cupom) continua.
  const resgates = (!opcoes.leitura && ids.length === 1) ? linksDeResgate(texto, links) : [];

  const saida = [];
  for (const par of ids) {
    let node;
    try { node = await buscarProdutoShopee(par); }
    catch (e) {
      console.error('[SHOPEE] Falha ao consultar item ' + par.itemId + ':', e.message);
      continue;
    }
    if (!node) {
      saida.push({ produto: { itemId: String(par.itemId), loja: 'Shopee' },
                   descartadoPor: 'produto não encontrado na API de afiliados' });
      continue;
    }

    const p = normalizarShopee(node);
    if (!p.preco) { saida.push({ produto: p, descartadoPor: 'sem preço disponível' }); continue; }

    // ── MODO LEITURA ──────────────────────────────────────────────────────
    // Para ANTES de marcarRastreio, e isso e obrigatorio, nao economia: aquele
    // caminho passa por refDoDisparo(), que GRAVA uma atribuicao no ledger.
    // Uma leitura de madrugada geraria atribuicao para produto que nunca foi
    // divulgado, e o coletor de comissoes passaria a casar receita com um
    // disparo que nao existiu. Tambem nao gera link de afiliado nem resolve
    // cupom: leitura so precisa de preco.
    // A checagem de p.link fica depois daqui de proposito — produto sem link
    // de afiliado ainda tem preco valido para a serie.
    if (opcoes.leitura) {
      saida.push({ produto: {
        asin: p.asin || String(p.itemId), itemId: p.itemId, shopId: p.shopId,
        titulo: p.titulo || '', loja: 'Shopee',
        preco: p.preco, precoDe: p.precoDe ?? null,
        disponivel: p.disponivel !== false, link: p.link || '',
      }, leitura: true });
      if (ids.length > 1) await new Promise(r => setTimeout(r, 400));
      continue;
    }

    if (!p.link)  { saida.push({ produto: p, descartadoPor: 'sem link de afiliado' }); continue; }

    await marcarRastreio(p, node);

    let cupom = melhorCupom('Shopee', p.preco, texto);
    if (cupom) {
      console.log('[SHOPEE] ' + p.itemId + ' + cupom ' + cupom.reg.codigo +
        ' (-R$ ' + cupom.desconto.toFixed(2) + ')');
    }

    // ── CUPOM DE RESGATE ────────────────────────────────────────────────
    // Cupom com codigo citado no post vence (e o que a regra sempre fez). Sem
    // ele, o link de resgate do post vira o nosso. Qualquer coisa que impeca
    // montar o cupom certo (valor ilegivel, preco abaixo do minimo, link nosso
    // que nao saiu) segura a oferta para revisao: sair pelo preco cheio com o
    // post prometendo cupom e o que esta regra existe para evitar.
    let cupomResgatePendente = null;
    if (!cupom && resgates.length) {
      const rg = resgates.length === 1 ? resgates[0] : null;
      if (!rg) {
        cupomResgatePendente = { motivo: 'post traz ' + resgates.length + ' links de resgate de cupom' };
      } else if (!rg.info) {
        cupomResgatePendente = { motivo: 'post pede para resgatar um cupom mas não deu para ler o valor', origem: rg.url };
      } else {
        const desconto = descontoCupomResgate(rg.info, p.preco);
        if (!(desconto > 0)) {
          cupomResgatePendente = { motivo: 'cupom ' + rg.info.rotulo + ' não se aplica ao preço da loja (R$ '
            + p.preco.toFixed(2).replace('.', ',') + ')', origem: rg.url };
        } else {
          let linkNosso = null;
          try {
            const ref = refDoDisparo(p);
            linkNosso = rg.limpa ? await gerarLinkAfiliado(rg.limpa, [ref || 'tsp']) : null;
          } catch (e) { console.warn('[SHOPEE] link de resgate do cupom falhou:', e.message); }
          if (!linkNosso) {
            cupomResgatePendente = { motivo: 'não deu para gerar o nosso link de resgate do cupom', origem: rg.url };
          } else {
            cupom = { desconto, citado: true, resgate: {
              link: linkNosso, rotulo: rg.info.rotulo, tipo: rg.info.tipo, valor: rg.info.valor,
              minimo: rg.info.minimo, teto: rg.info.teto, pagina: rg.limpa, origem: rg.url,
            } };
            console.log('[SHOPEE] ' + p.itemId + ' + cupom de resgate ' + rg.info.rotulo
              + ' (-R$ ' + desconto.toFixed(2) + ') ' + rg.limpa + ' -> ' + linkNosso);
          }
        }
      }
      if (cupomResgatePendente) console.log('[SHOPEE] ' + p.itemId + ' cupom de resgate pendente: ' + cupomResgatePendente.motivo);
    }

    saida.push({
      produto: p,
      cupom: cupom
        ? (cupom.resgate
            ? { codigo: '', desconto: cupom.desconto, citado: true, resgate: cupom.resgate }
            : { codigo: cupom.reg.codigo, desconto: cupom.desconto, citado: cupom.citado })
        : null,
      precoFinal: cupom ? Math.max(0, p.preco - cupom.desconto) : p.preco,
      mensagem: formatarOfertaShopee(p, { ...opcoes, cupom }),
      // Links do post que sao do cupom, nao do produto: o gate do preco do post
      // nao pode conta-los como "mais de um produto".
      linksResgate: resgates.map(r => r.url),
      cupomResgatePendente,
    });
    // Espacamento leve entre itens do mesmo lote para nao bater no rate limit.
    if (ids.length > 1) await new Promise(r => setTimeout(r, 400));
  }
  return saida;
}

// ── VALIDACAO DE ATRIBUICAO ───────────────────────────────────────────────
// Tres provas independentes de que o link rende comissao para ESTA conta:
//   1. Procedencia: o offerLink vem de uma chamada assinada com o seu appId —
//      a API so devolve link de afiliado da conta autenticada.
//   2. Parametros de tracking: expandindo o shortlink, utm_campaign carrega o
//      affiliate id e utm_medium fica como 'affiliates'.
//   3. Sub ID: o valor injetado aqui reaparece no campo utmContent do
//      conversionReport, ligando a venda a este disparo especifico.

const CAMPOS_TRACKING = [
  'utm_campaign', 'utm_source', 'utm_medium', 'utm_content', 'utm_term',
  'af_siteid', 'af_click_lookback', 'pid', 'c', 'is_retargeting', 'af_sub1',
];

/** Segue os redirects de um shortlink ate a URL final, sem baixar a pagina. */
async function expandirLink(url, tentativas = 6) {
  let atual = url;
  for (let i = 0; i < tentativas; i++) {
    const res = await fetch(atual, {
      method: 'GET', redirect: 'manual',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        'Accept-Language': 'pt-BR,pt;q=0.9', 'Range': 'bytes=0-0',
      },
      signal: AbortSignal.timeout(10000),
    });
    const loc = res.headers.get('location');
    if (!loc) return atual;
    atual = new URL(loc, atual).href;
  }
  return atual;
}

/**
 * Valida a atribuicao de um link Shopee.
 * @param {string} url      link do produto (qualquer formato)
 * @param {string} subId    sub id a injetar, para conferir depois no relatorio
 */
export async function validarAtribuicao(url, subId = null) {
  const ids = await extrairIdsShopee(url);
  if (!ids.length) return { ok: false, erro: 'não foi possível identificar o produto no link' };

  const node = await buscarProdutoShopee(ids[0]);
  if (!node) return { ok: false, erro: 'produto não encontrado na API de afiliados' };

  const offerLink = node.offerLink || null;
  const marcado = subId
    ? await gerarLinkAfiliado(node.productLink || url, [subId]).catch(e => null)
    : null;

  const alvo = marcado || offerLink;
  let expandido = null, parametros = {}, erroExpansao = null;
  if (alvo) {
    try {
      expandido = await expandirLink(alvo);
      const qs = new URL(expandido).searchParams;
      for (const c of CAMPOS_TRACKING) { const v = qs.get(c); if (v) parametros[c] = v; }
    } catch (e) { erroExpansao = e.message; }
  }

  // O affiliate id costuma vir embutido em utm_campaign no formato id_XXXXX.
  const campanha = parametros.utm_campaign || '';
  const affiliateId = (campanha.match(/id_(\w+)/) || [])[1] || null;

  return {
    ok: true,
    produto: { itemId: String(node.itemId), shopId: String(node.shopId), nome: node.productName },
    // A comissao so vem preenchida para ofertas elegiveis a esta conta: valor
    // presente e mais uma confirmacao de que o item rende para voce.
    comissao: {
      taxa: node.commissionRate ? Math.round(Number(node.commissionRate) * 1000) / 10 + '%' : null,
      valorEstimado: node.commission || null,
    },
    linkOriginal: node.productLink || null,
    offerLink,
    linkComSubId: marcado,
    linkExpandido: expandido,
    parametros,
    affiliateId,
    subIdEnviado: subId,
    erroExpansao,
    veredito: {
      offerLinkVeioDaApi: !!offerLink,
      temParametrosDeAfiliado: !!(parametros.utm_medium || parametros.utm_campaign || parametros.af_siteid),
      subIdPresenteNoLink: !!(subId && expandido && expandido.includes(subId)),
    },
  };
}

/** Monta ofertas da vitrine para itens Shopee, com preco consultado agora. */
export async function montarOfertasShopeeVitrine(itens, codigoCupom = null) {
  const prontos = [], descartados = [];

  for (const salvo of itens) {
    const par = { shopId: Number(salvo.shopId), itemId: Number(salvo.itemId) };
    let node;
    try { node = await buscarProdutoShopee(par); }
    catch (e) { descartados.push({ asin: salvo.asin, nome: salvo.nome, motivo: 'API: ' + e.message }); continue; }
    if (!node) { descartados.push({ asin: salvo.asin, nome: salvo.nome, motivo: 'produto não encontrado' }); continue; }

    const p = normalizarShopee(node);
    if (!p.preco) { descartados.push({ asin: salvo.asin, nome: salvo.nome, motivo: 'sem preço disponível' }); continue; }
    // A serie de precos do monitor e indexada pela chave da vitrine
    // (SHOPEE-<loja>-<item>), nao pelo itemId que fica em p.asin. Sem isto o
    // selo "Menor preço dos últimos X dias" nunca achava a serie na Shopee.
    p.chaveSerie = salvo.asin;
    if (p.link) await marcarRastreio(p, node);

    // 'auto' e escolha automatica, nao ordem: o cupom que o operador vinculou ao
    // produto vence o automatico. Cupom fixo do disparo vence tudo; 'nenhum' sai
    // sem cupom mesmo quando o item tem vinculo.
    const semCupom = codigoCupom === 'nenhum';
    const codigo = semCupom ? null
                 : (codigoCupom && codigoCupom !== 'auto') ? codigoCupom
                 : (salvo.cupom || codigoCupom);
    let cupom = null, avisoCupom = null;
    // 'auto': o melhor cupom Shopee vigente que atenda o preco deste produto.
    if (codigo === 'auto') {
      const m = melhorCupomAplicavel('Shopee', p.preco);
      if (m) cupom = { reg: m.reg, desconto: m.desconto, citado: true };
      else avisoCupom = 'nenhum cupom Shopee vigente se aplica a este preço';
    } else if (codigo) {
      const reg = cupomPorCodigo('Shopee', codigo);
      if (!reg)                    avisoCupom = 'cupom ' + codigo + ' não está na base (Shopee)';
      else if (!cupomVigente(reg)) avisoCupom = 'cupom ' + codigo + ' expirado ou inativo';
      else {
        const desconto = calcularDesconto(reg, p.preco);
        if (desconto > 0) cupom = { reg, desconto, citado: true };
        else avisoCupom = 'cupom ' + codigo + ' não se aplica a este preço';
      }
    }

    prontos.push({
      asin: salvo.asin, nome: salvo.nome || p.titulo, produto: p,
      cupom: cupom ? { codigo: cupom.reg.codigo, desconto: cupom.desconto } : null,
      avisoCupom,
      precoFinal: cupom ? Math.max(0, p.preco - cupom.desconto) : p.preco,
      mensagem: formatarOfertaShopee(p, { cupom }),
    });
    await new Promise(r => setTimeout(r, 400));
  }
  return { prontos, descartados };
}
