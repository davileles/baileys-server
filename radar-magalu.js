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

import { melhorCupom, templateDaLoja, renderTemplate, varsDoProduto } from './radar-amazon.js';

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
