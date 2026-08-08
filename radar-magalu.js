// ═══════════════════════════════════════════════════════════════════════════
// radar-magalu.js — Magazine Luiza (Parceiro Magalu / Magazine Você).
//
// DIFERENÇA IMPORTANTE em relacao a Amazon e Shopee: nao existe API de afiliado
// publica na Magalu, e o site bloqueia leitura a partir de IP de datacenter
// (403 no Railway, captcha no magazinevoce). Entao aqui:
//
//   - o LINK e convertido com seguranca (transformacao de URL, sem rede);
//   - preco e titulo vem do TEXTO do grupo, nao de uma fonte verificada.
//
// Isso quebra o principio "a API e a fonte da verdade" que vale nas outras
// lojas, e por isso as ofertas Magalu sao marcadas com precoDeReferencia:true —
// o painel avisa que aquele preco nao foi conferido. Quando houver uma fonte
// de dados confiavel, basta preencher buscarDadosMagalu() e o resto continua.
// ═══════════════════════════════════════════════════════════════════════════

import { melhorCupom, melhorCupomAplicavel, cupomPorCodigo, cupomVigente,
         calcularDesconto, templateDaLoja, renderTemplate, varsDoProduto } from './radar-amazon.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// Codigo da sua loja no Magazine Você. Sai do codigo para poder mudar sem deploy.
export function lojaMagalu() {
  return process.env.MAGALU_LOJA || 'magazinetudosobremilhas';
}

// Dominios proprios da Magalu e encurtadores que os divulgadores usam.
const REGEX_URL_MAGALU = /https?:\/\/(?:[\w-]+\.)*(?:magazineluiza\.com\.br|magazinevoce\.com\.br|magalu\.com|ofertou\.ai|magazineluiza\.onelink\.me)\/\S+/gi;

export function ehLinkMagalu(texto) {
  return new RegExp(REGEX_URL_MAGALU.source, 'i').test(String(texto || ''));
}

/** Extrai {slug, codigo, dep, sub} de uma URL de produto da Magalu. */
function partesDeUrl(url) {
  try {
    const p = new URL(url).pathname;
    // /{slug}/p/{codigo}/{departamento}/{subcategoria}/
    let m = p.match(/^\/(?:([^/]+)\/)?([^/]+)\/p\/([^/]+)\/([^/]+)\/([^/]+)\/?$/);
    if (m) {
      // Em magazinevoce.com.br o primeiro segmento e a loja do parceiro; em
      // magazineluiza.com.br ele ja e o slug do produto.
      const ehVoce = /magazinevoce/i.test(url);
      return ehVoce
        ? { slug: m[2], codigo: m[3], dep: m[4], sub: m[5] }
        : { slug: m[1] || m[2], codigo: m[3], dep: m[4], sub: m[5] };
    }
    m = p.match(/^\/([^/]+)\/p\/([^/]+)\/([^/]+)\/([^/]+)\/?$/);
    if (m) return { slug: m[1], codigo: m[2], dep: m[3], sub: m[4] };
    return null;
  } catch (e) { return null; }
}

/**
 * Segue redirects sem baixar a pagina. Usa redirect manual de proposito: o
 * destino final responde 403 a datacenter, mas o cabecalho Location do
 * encurtador vem normalmente — e e so dele que precisamos.
 */
async function resolverEncurtadorMagalu(url, tentativas = 6) {
  let atual = url;
  for (let i = 0; i < tentativas; i++) {
    if (partesDeUrl(atual)) return atual;
    const res = await fetch(atual, {
      method: 'GET', redirect: 'manual',
      headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9', 'Range': 'bytes=0-0' },
      signal: AbortSignal.timeout(12000),
    });
    const loc = res.headers.get('location');
    if (!loc) return atual;
    atual = new URL(loc, atual).href;
  }
  return atual;
}

/** Monta o link da sua loja preservando slug, codigo, departamento e subcategoria. */
export function montarLinkAfiliado(partes) {
  return 'https://www.magazinevoce.com.br/' + lojaMagalu() +
    '/' + partes.slug + '/p/' + partes.codigo + '/' + partes.dep + '/' + partes.sub + '/';
}

/** Resolve um link qualquer da Magalu para o link de afiliado desta conta. */
export async function converterLinkMagalu(url) {
  let partes = partesDeUrl(url);
  let destino = url;
  if (!partes) {
    try { destino = await resolverEncurtadorMagalu(url); partes = partesDeUrl(destino); }
    catch (e) { console.warn('[MAGALU] Falha ao resolver', url, '-', e.message); }
  }
  if (!partes) return null;
  return { partes, urlOriginal: destino, link: montarLinkAfiliado(partes) };
}

// ── DADOS VINDOS DO TEXTO ─────────────────────────────────────────────────
// Sem API, o texto do grupo e a unica fonte. Extracao conservadora: na duvida
// devolve vazio, e o template simplesmente omite a linha.

function precoDoTexto(texto) {
  // Pega o MENOR valor plausivel: o texto costuma trazer "de X por Y", e o
  // preco que interessa e o de venda.
  const achados = [...String(texto).matchAll(/R\$\s*([\d.]+,\d{2}|\d+)/gi)]
    .map(m => Number(m[1].replace(/\./g, '').replace(',', '.')))
    .filter(v => isFinite(v) && v > 0);
  if (!achados.length) return { preco: null, precoDe: null };
  const preco = Math.min(...achados);
  const maior = Math.max(...achados);
  return { preco, precoDe: maior > preco ? maior : null };
}

function tituloDoTexto(texto, slug) {
  const linha = String(texto).split('\n')
    .map(l => l.trim())
    .find(l => l && !/^https?:\/\//i.test(l) && !/^R\$/i.test(l) && l.length > 8);
  if (linha) return linha.replace(/^[*_~`]+|[*_~`]+$/g, '').slice(0, 140);
  // Sem linha util, o slug da URL ainda da um nome legivel.
  return (slug || '').replace(/[-_]+/g, ' ').trim().slice(0, 140) || 'Oferta Magazine Luiza';
}

export function formatarOfertaMagalu(p, opcoes = {}) {
  const tpl = opcoes.template || templateDaLoja('Magazine Luiza');
  return renderTemplate(tpl?.corpo || '', varsDoProduto(p, opcoes.cupom || null));
}

/**
 * Pipeline da Magalu: texto -> ofertas prontas.
 * Diferente das outras lojas, o preco NAO e verificado — vem do proprio texto.
 */
export async function processarTextoMagalu(texto) {
  const urls = [...new Set(String(texto || '').match(REGEX_URL_MAGALU) || [])]
    .map(u => u.replace(/[)\]}.,;!]+$/, ''));
  if (!urls.length) return [];

  const saida = [];
  const vistos = new Set();

  for (const url of urls) {
    let conv;
    try { conv = await converterLinkMagalu(url); }
    catch (e) { console.error('[MAGALU] Erro ao converter', url, '-', e.message); continue; }

    if (!conv) {
      saida.push({ produto: { loja: 'Magazine Luiza' },
                   descartadoPor: 'link sem código de produto (não dá para converter em link de afiliado)' });
      continue;
    }
    if (vistos.has(conv.partes.codigo)) continue;
    vistos.add(conv.partes.codigo);

    const { preco, precoDe } = precoDoTexto(texto);

    // A Magalu entra no radar so por causa do link, entao anuncio de CUPOM cai
    // aqui junto com oferta de produto. Sem preco de lista o template acaba
    // usando o proprio preco como valor riscado e inventa um 'De/Por' que nao
    // existe no checkout. Nesses casos e melhor nao publicar nada.
    const ehAnuncioDeCupom = /(^|\s)cupom|cupons/i.test(tituloDoTexto(texto, conv.partes.slug));
    if (ehAnuncioDeCupom && !precoDe) {
      saida.push({ produto: { loja: 'Magazine Luiza' },
                   descartadoPor: 'anúncio de cupom sem preço de produto (De/Por seria inventado)' });
      continue;
    }

    const p = {
      asin: conv.partes.codigo,
      codigo: conv.partes.codigo,
      titulo: tituloDoTexto(texto, conv.partes.slug),
      preco, precoDe,
      precoTexto: preco ? 'R$ ' + preco.toFixed(2).replace('.', ',') : null,
      precoDeTexto: precoDe ? 'R$ ' + precoDe.toFixed(2).replace('.', ',') : null,
      desconto: (preco && precoDe && precoDe > preco) ? Math.round((1 - preco / precoDe) * 100) : 0,
      disponivel: true,          // sem fonte para conferir estoque
      link: conv.link,
      imagemUrl: null,
      vendedor: null, marca: '', nota: null, avaliacoes: null,
      dealTermina: null, ehDeal: false,
      loja: 'Magazine Luiza',
      precoDeReferencia: true,   // sinaliza que o preco nao foi verificado
    };

    const cupom = preco ? melhorCupom('Magazine Luiza', preco, texto) : null;
    if (cupom) console.log('[MAGALU] ' + p.codigo + ' + cupom ' + cupom.reg.codigo);

    saida.push({
      produto: p,
      cupom: cupom ? { codigo: cupom.reg.codigo, desconto: cupom.desconto,
                       citado: cupom.citado, generico: !!cupom.generico } : null,
      precoFinal: cupom ? Math.max(0, preco - cupom.desconto) : preco,
      precoDeReferencia: true,
      mensagem: formatarOfertaMagalu(p, { cupom }),
    });
  }
  return saida;
}


// ── VITRINE — MAGAZINE LUIZA ──────────────────────────────────────────────
// A vitrine das outras lojas guarda so o identificador e consulta o preco no
// disparo. Aqui isso e impossivel: nao ha API de afiliado e a pagina responde
// 403 a IP de datacenter. O preco entao e informado pelo operador no cadastro e
// fica com data. No disparo o preco nao e reconferido — o que da para fazer e
// recusar preco velho, que e o risco real de uma vitrine (produto cadastrado
// hoje e disparado quando sai um cupom, semanas depois).

// Horas que um preco informado a mao continua valendo. Fora do codigo para o
// operador poder afrouxar ou apertar sem deploy.
export function ttlPrecoMagalu() {
  const h = Number(process.env.MAGALU_PRECO_TTL_H);
  return isFinite(h) && h > 0 ? h : 24;
}

/** Le "R$ 1.234,56", "1234,56" ou "1234.56" de um pedaco de texto. */
function precosDaLinha(resto) {
  const achados = [...String(resto).matchAll(/R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2}|\d+(?:[.,]\d{2})?)/gi)]
    .map(m => {
      const bruto = m[1];
      // 1.234,56 -> 1234.56 | 1234,56 -> 1234.56 | 1234.56 fica como esta
      const n = bruto.includes(',')
        ? Number(bruto.replace(/\./g, '').replace(',', '.'))
        : Number(bruto);
      return n;
    })
    .filter(v => isFinite(v) && v > 0);
  if (!achados.length) return { preco: null, precoDe: null };
  const preco = Math.min(...achados);
  const maior = Math.max(...achados);
  return { preco, precoDe: maior > preco ? maior : null };
}

/**
 * Resolve uma linha da vitrine para a Magalu. Formato aceito, em qualquer ordem
 * dos campos que nao sao o link:
 *   https://...                         (so o link — entra sem preco)
 *   Nome do produto | https://... | 1299,00
 *   https://... | 1299,00 | 1899,00     (o maior vira o "de")
 */
export async function resolverLinhaVitrineMagalu(linha) {
  const bruto = String(linha || '').trim();
  if (!bruto) return null;

  const m = bruto.match(new RegExp(REGEX_URL_MAGALU.source, 'i'));
  if (!m) return { erro: 'sem link da Magazine Luiza', linha: bruto };
  const url = m[0].replace(/[)\]}.,;!]+$/, '');

  // Tudo que nao e o link vira candidato a nome e preco.
  const resto = bruto.replace(m[0], ' ');
  const { preco, precoDe } = precosDaLinha(resto);

  let conv;
  try { conv = await converterLinkMagalu(url); }
  catch (e) { return { erro: 'falha ao converter o link: ' + e.message, linha: bruto }; }
  if (!conv) return { erro: 'link sem codigo de produto (nao da para gerar link de afiliado)', linha: bruto };

  // Nome: o que sobrou depois de tirar link, precos e separadores. Sem isso,
  // cai no slug da URL, que ja e legivel.
  let nome = resto
    .replace(/R?\$?\s*\d{1,3}(?:\.\d{3})*,\d{2}/gi, ' ')
    .replace(/R\$\s*\d+(?:[.,]\d{2})?/gi, ' ')
    .replace(/[|;]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
  if (!nome) nome = (conv.partes.slug || '').replace(/[-_]+/g, ' ').trim().slice(0, 140);
  if (!nome) nome = 'Produto ' + conv.partes.codigo;

  return {
    asin: 'MAGALU-' + conv.partes.codigo,
    nome,
    url: conv.link,               // ja e o link da nossa loja no Magazine Voce
    loja: 'Magazine Luiza',
    preco: preco ?? null,
    precoDe: precoDe ?? null,
  };
}

/**
 * Monta as mensagens da vitrine para itens da Magalu. Sem fonte para reconsultar
 * preco, o que se faz aqui e barrar o que nao pode ir ao ar: item sem preco e
 * item com preco vencido. As ofertas saem marcadas com precoDeReferencia.
 */
export async function montarOfertasMagaluVitrine(itens, codigoCupom = null) {
  const prontos = [], descartados = [];
  const ttlMs = ttlPrecoMagalu() * 3600 * 1000;

  for (const salvo of itens) {
    if (!salvo.preco) {
      descartados.push({ asin: salvo.asin, nome: salvo.nome,
        motivo: 'sem preco informado — a Magalu nao tem consulta automatica, edite o preco na vitrine' });
      continue;
    }
    const idade = salvo.precoEm ? Date.now() - new Date(salvo.precoEm).getTime() : Infinity;
    if (idade > ttlMs) {
      const horas = isFinite(idade) ? Math.round(idade / 3600000) : null;
      descartados.push({ asin: salvo.asin, nome: salvo.nome,
        motivo: 'preco informado ha ' + (horas != null ? horas + 'h' : 'tempo desconhecido')
              + ' (limite ' + ttlPrecoMagalu() + 'h) — reconfirme o preco antes de disparar' });
      continue;
    }

    const preco = Number(salvo.preco);
    const precoDe = salvo.precoDe && salvo.precoDe > preco ? Number(salvo.precoDe) : null;

    const p = {
      asin: salvo.asin,
      codigo: String(salvo.asin).replace(/^MAGALU-/, ''),
      titulo: salvo.nome || '',
      preco, precoDe,
      precoTexto: 'R$ ' + preco.toFixed(2).replace('.', ','),
      precoDeTexto: precoDe ? 'R$ ' + precoDe.toFixed(2).replace('.', ',') : null,
      desconto: precoDe ? Math.round((1 - preco / precoDe) * 100) : 0,
      disponivel: true,          // sem fonte para conferir estoque
      link: salvo.url,
      imagemUrl: null,
      vendedor: null, marca: '', nota: null, avaliacoes: null,
      dealTermina: null, ehDeal: false,
      loja: 'Magazine Luiza',
      precoDeReferencia: true,
    };

    const codigo = codigoCupom || salvo.cupom || null;
    let cupom = null, avisoCupom = null;
    if (codigo === 'auto') {
      const mc = melhorCupomAplicavel('Magazine Luiza', preco);
      if (mc) cupom = { reg: mc.reg, desconto: mc.desconto, citado: true };
      else avisoCupom = 'nenhum cupom da Magazine Luiza vigente se aplica a este preco';
    } else if (codigo) {
      const reg = cupomPorCodigo('Magazine Luiza', codigo);
      if (!reg)                    avisoCupom = 'cupom ' + codigo + ' nao esta na base (Magazine Luiza)';
      else if (!cupomVigente(reg)) avisoCupom = 'cupom ' + codigo + ' expirado ou inativo';
      else {
        const desconto = calcularDesconto(reg, preco);
        if (desconto > 0) cupom = { reg, desconto, citado: true };
        else avisoCupom = 'cupom ' + codigo + ' nao se aplica a este preco';
      }
    }

    prontos.push({
      asin: salvo.asin, nome: salvo.nome || p.titulo, produto: p,
      cupom: cupom ? { codigo: cupom.reg.codigo, desconto: cupom.desconto } : null,
      avisoCupom,
      precoFinal: cupom ? Math.max(0, preco - cupom.desconto) : preco,
      precoDeReferencia: true,
      mensagem: formatarOfertaMagalu(p, { cupom }),
    });
  }
  return { prontos, descartados };
}
