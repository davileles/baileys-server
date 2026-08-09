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
import { resolverPrecoDe, FONTE_API } from './preco-de.js';
import {
  melhorCupom, cupomPorCodigo, cupomVigente, calcularDesconto,
  templateDaLoja, renderTemplate, varsDoProduto, melhorCupomAplicavel,
} from './radar-amazon.js';

const API_URL = 'https://open-api.affiliate.shopee.com.br/graphql';

export function credenciaisShopeeOk() {
  return !!(process.env.SHOPEE_APP_ID && process.env.SHOPEE_SECRET);
}

/**
 * Executa uma operacao GraphQL assinada.
 * O corpo e montado UMA vez e reusado na assinatura e no envio.
 */
async function chamarShopee(query, variables = null) {
  const appId  = process.env.SHOPEE_APP_ID;
  const secret = process.env.SHOPEE_SECRET;
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

/** Extrai os pares {shopId,itemId} de todos os links Shopee de um texto. */
export async function extrairIdsShopee(texto) {
  if (!texto) return [];
  const urls = [...new Set(String(texto).match(REGEX_URL_SHOPEE) || [])]
    .map(u => u.replace(/[)\]}.,;!]+$/, ''));
  const achados = [];
  const vistos = new Set();

  for (const url of urls) {
    let ids = idsDeUrl(url);
    if (!ids) {
      try { ids = idsDeUrl(await resolverEncurtadorShopee(url)); }
      catch (e) { console.warn('[SHOPEE] Falha ao resolver', url, '-', e.message); }
    }
    if (!ids) { console.warn('[SHOPEE] Sem itemId para', url); continue; }
    const chave = ids.shopId + ':' + ids.itemId;
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    achados.push(ids);
  }
  return achados;
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
  const ids = await extrairIdsShopee(texto);
  if (!ids.length) return [];

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
    if (!p.link)  { saida.push({ produto: p, descartadoPor: 'sem link de afiliado' }); continue; }

    const cupom = melhorCupom('Shopee', p.preco, texto);
    if (cupom) {
      console.log('[SHOPEE] ' + p.itemId + ' + cupom ' + cupom.reg.codigo +
        ' (-R$ ' + cupom.desconto.toFixed(2) + ')');
    }
    saida.push({
      produto: p,
      cupom: cupom ? { codigo: cupom.reg.codigo, desconto: cupom.desconto, citado: cupom.citado } : null,
      precoFinal: cupom ? Math.max(0, p.preco - cupom.desconto) : p.preco,
      mensagem: formatarOfertaShopee(p, { ...opcoes, cupom }),
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

    const codigo = codigoCupom || salvo.cupom || null;
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
