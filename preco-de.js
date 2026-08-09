// ═══════════════════════════════════════════════════════════════════════════
// preco-de.js — camada unica de resolucao do "preco de" (o valor riscado).
//
// Ate aqui cada loja resolvia o preco cheio do seu jeito, com regras de
// sanidade duplicadas e criterios diferentes. O resultado eram ofertas saindo
// sem o "De:" mesmo quando a pagina exibia o valor — a linha some sozinha no
// renderTemplate quando a variavel vem vazia, entao a falha era silenciosa.
//
// A regra passa a ser uma so, em cascata, da fonte mais confiavel para a menos:
//
//   1. api     — API oficial da loja (PA-API, /items/{id}/prices, feed Awin)
//   2. ldjson  — JSON-LD da propria pagina (highPrice / priceSpecification)
//   3. estado  — JSON embutido no HTML (__PRELOADED_STATE__, "original_price")
//   4. dom     — classe CSS do bloco de preco riscado (ultimo recurso)
//   5. manual  — valor digitado pelo operador (Magalu) — NAO verificado
//   6. texto   — valor lido do texto do grupo — NAO verificado
//
// Toda candidata passa pelas mesmas travas antes de virar "De:":
//   - maior que o preco atual;
//   - no maximo 5x o preco atual (acima disso o desconto sai absurdo);
//   - desconto resultante de no maximo 90%;
//   - se a pagina declara o percentual ("28% OFF"), o desconto calculado tem
//     que bater com ele (tolerancia de 2 p.p.) — mesma logica de conferencia
//     cruzada usada nos cupons TSP.
//
// Candidata reprovada nao derruba o processo: cai para a proxima fonte. Se
// nenhuma passar, devolve null e a linha do "De:" simplesmente nao sai — que
// e o comportamento seguro (melhor sem "De" do que com um numero chutado).
// ═══════════════════════════════════════════════════════════════════════════

export const FONTE_API    = 'api';
export const FONTE_LDJSON = 'ldjson';
export const FONTE_ESTADO = 'estado';
export const FONTE_DOM    = 'dom';
export const FONTE_FEED   = 'feed';
export const FONTE_MANUAL = 'manual';
export const FONTE_TEXTO  = 'texto';

// Fontes cuja origem e verificavel. As demais (manual/texto) continuam
// marcando a oferta com precoDeReferencia — o painel avisa o operador.
const FONTES_VERIFICADAS = new Set([FONTE_API, FONTE_FEED, FONTE_LDJSON, FONTE_ESTADO, FONTE_DOM]);

export function fonteVerificada(fonte) {
  return FONTES_VERIFICADAS.has(String(fonte || ''));
}

export const LIMITES_PRECO_DE = {
  fatorMax: 5,        // precoDe nunca maior que 5x o preco atual
  descontoMax: 90,    // desconto resultante nunca acima de 90%
  toleranciaPp: 2,    // folga na conferencia contra o percentual declarado
};

// ── NUMEROS ────────────────────────────────────────────────────────────────
// JSON usa ponto como separador DECIMAL ("original_price": 33.61) e texto de
// pagina usa ponto como separador de MILHAR ("R$ 1.299,90"). Tratar os dois do
// mesmo jeito e o que transformava 33.61 em 3361 — numero que a trava de 5x
// descartava, deixando a oferta sem "De:" com o valor na cara na pagina.

/** Numero vindo de JSON: ponto e decimal, sem separador de milhar. */
export function numeroJson(v) {
  if (v === null || v === undefined) return null;
  const n = Number(String(v).trim());
  return isFinite(n) && n > 0 ? n : null;
}

/** Numero vindo de texto pt-BR: ponto e milhar, virgula e decimal. */
export function numeroBr(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(/[^\d.,]/g, '');
  if (!s) return null;
  const n = Number(s.replace(/\./g, '').replace(',', '.'));
  return isFinite(n) && n > 0 ? n : null;
}

/** Junta parte inteira e centavos do DOM: ("1.299", "90") -> 1299.9 */
export function numeroPartes(inteiro, centavos) {
  const base = numeroBr(inteiro);
  if (base === null) return null;
  const c = centavos === null || centavos === undefined ? null : String(centavos).replace(/\D/g, '');
  if (!c) return base;
  return Number((base + Number(c.slice(0, 2)) / 100).toFixed(2));
}

// ── VALIDACAO ──────────────────────────────────────────────────────────────

/**
 * Aplica as travas a uma candidata.
 * @returns {{ok:boolean, precoDe:number|null, desconto:number, motivo:string|null}}
 */
export function validarPrecoDe(candidato, preco, opcoes = {}) {
  const lim = { ...LIMITES_PRECO_DE, ...(opcoes.limites || {}) };
  const de = Number(candidato);
  const p  = Number(preco);

  if (!isFinite(de) || de <= 0) return { ok: false, precoDe: null, desconto: 0, motivo: 'valor ausente ou nao numerico' };
  if (!isFinite(p)  || p  <= 0) return { ok: false, precoDe: null, desconto: 0, motivo: 'sem preco atual para comparar' };
  if (de <= p) return { ok: false, precoDe: null, desconto: 0, motivo: 'preco de menor ou igual ao preco atual' };
  if (de > p * lim.fatorMax) {
    return { ok: false, precoDe: null, desconto: 0,
             motivo: 'preco de implausivel (' + de + ' e mais de ' + lim.fatorMax + 'x ' + p + ')' };
  }

  const desconto = Math.round((1 - p / de) * 100);
  if (desconto > lim.descontoMax) {
    return { ok: false, precoDe: null, desconto, motivo: 'desconto de ' + desconto + '% acima do teto de ' + lim.descontoMax + '%' };
  }

  // Conferencia cruzada: a pagina declara "28% OFF"? Entao o calculo tem que
  // chegar perto disso. Divergencia grande denuncia valor pescado do bloco
  // errado (recomendados, parcelamento, outro anuncio).
  const declarado = Number(opcoes.descontoDeclarado);
  if (isFinite(declarado) && declarado > 0 && Math.abs(desconto - declarado) > lim.toleranciaPp) {
    return { ok: false, precoDe: null, desconto,
             motivo: 'desconto calculado (' + desconto + '%) diverge do declarado na pagina (' + declarado + '%)' };
  }

  return { ok: true, precoDe: de, desconto, motivo: null };
}

/**
 * Percorre as candidatas na ordem recebida e devolve a primeira aprovada.
 * @param {{preco:number, candidatos:Array<{fonte:string, valor:*}>, descontoDeclarado?:number, rotulo?:string}} ctx
 * @returns {{precoDe:number|null, fonte:string|null, desconto:number, verificado:boolean, descartes:Array}}
 */
export function resolverPrecoDe(ctx = {}) {
  const preco = Number(ctx.preco);
  const lista = (ctx.candidatos || []).filter(c => c && c.valor !== null && c.valor !== undefined && c.valor !== '');
  const descartes = [];
  const rotulo = ctx.rotulo ? '[' + ctx.rotulo + '] ' : '';

  for (const c of lista) {
    const r = validarPrecoDe(c.valor, preco, { descontoDeclarado: ctx.descontoDeclarado, limites: ctx.limites });
    if (r.ok) {
      if (descartes.length) {
        console.log('[PRECO-DE] ' + rotulo + 'aprovado pela fonte "' + c.fonte + '" apos ' +
                    descartes.length + ' descarte(s).');
      }
      return { precoDe: r.precoDe, fonte: c.fonte, desconto: r.desconto,
               verificado: fonteVerificada(c.fonte), descartes };
    }
    descartes.push({ fonte: c.fonte, valor: c.valor, motivo: r.motivo });
  }

  if (descartes.length) {
    console.warn('[PRECO-DE] ' + rotulo + 'nenhuma fonte aprovada: ' +
                 descartes.map(d => d.fonte + '=' + d.valor + ' (' + d.motivo + ')').join('; '));
  }
  return { precoDe: null, fonte: null, desconto: 0, verificado: false, descartes };
}

// ── EXTRATORES GENERICOS ───────────────────────────────────────────────────
// Servem para qualquer loja que entregue HTML: ML, Magalu, parceiros Awin.

/** JSON-LD: highPrice do offers, ou priceSpecification de tipo lista/riscado. */
export function precoDeDoLd(ld) {
  if (!ld) return null;
  const ofertas = ld.offers ? (Array.isArray(ld.offers) ? ld.offers : [ld.offers]) : [];
  for (const of of ofertas) {
    if (!of) continue;
    // Numa AggregateOffer com varias variacoes (900 mL x 3 L), o highPrice e o
    // preco da variacao mais cara — nao o preco cheio desta aqui. Usar isso
    // como "De" anunciaria um desconto que nao existe.
    const varias = /AggregateOffer/i.test(String(of['@type'] || '')) && Number(of.offerCount) > 1;
    const alto = varias ? null : numeroJson(of.highPrice);
    const baixo = numeroJson(of.lowPrice ?? of.price);
    if (alto && (!baixo || alto > baixo)) return alto;

    const specs = of.priceSpecification
      ? (Array.isArray(of.priceSpecification) ? of.priceSpecification : [of.priceSpecification])
      : [];
    for (const s of specs) {
      const tipo = String(s?.priceType || s?.['@type'] || '');
      if (!/ListPrice|StrikethroughPrice|RegularPrice|OriginalPrice/i.test(tipo)) continue;
      const v = numeroJson(s.price ?? s.maxPrice);
      if (v) return v;
    }
  }
  return null;
}

// Chaves de JSON embutido no HTML. Valor com ponto decimal — numeroJson.
const CHAVES_ESTADO = [
  'original_price', 'originalPrice', 'regular_amount', 'regularPrice',
  'list_price', 'listPrice', 'previous_price', 'previousPrice',
  'price_before', 'priceBefore', 'strikethrough_price', 'strikethroughPrice',
  // Nomes que aparecem nas lojas da rede Awin (VTEX, Magento, Shopify e afins).
  'oldPrice', 'old_price', 'priceFrom', 'price_from', 'fromPrice',
  'specialPrice', 'special_price', 'rrp', 'rrp_price', 'msrp',
  'comparePrice', 'compare_at_price', 'ListPrice', 'PriceWithoutDiscount',
];

// Marcacoes semanticas do proprio HTML, fora do JSON embutido. Ficam junto do
// extrator de estado porque a origem e a mesma pagina.
const REGEX_MICRODADOS = [
  /itemprop=["'](?:listPrice|highPrice)["'][^>]*content=["']([\d.,]+)/i,
  /data-field=["']specialPrice["'][^>]*>\s*R\$\s*([\d.,]+)/i,
  /data-(?:old|list|regular)-price=["']([\d.,]+)/i,
];

/** Varre o JSON embutido na pagina atras do preco cheio. */
/**
 * Um valor cru pode chegar como numero de JSON (33.61) ou como texto de
 * exibicao ("1.299,90"). A virgula e o que distingue os dois.
 */
function numeroCru(bruto) {
  const t = String(bruto || '').replace(/[.,]+$/, '');
  if (!t) return null;
  return t.includes(',') ? numeroBr(t) : numeroJson(t);
}

export function precoDeDoEstado(html) {
  const texto = String(html || '');
  for (const chave of CHAVES_ESTADO) {
    const m = texto.match(new RegExp('"' + chave + '"\\s*:\\s*"?([\\d.,]{1,16})', 'i'));
    const v = m ? numeroCru(m[1]) : null;
    if (v) return v;
  }
  for (const re of REGEX_MICRODADOS) {
    const m = texto.match(re);
    const v = m ? numeroCru(m[1]) : null;
    if (v) return v;
  }
  return null;
}

/**
 * Bloco de preco riscado no DOM. Le parte inteira E centavos — pegar so a
 * fracao arredondava R$ 33,61 para R$ 33,00.
 */
export function precoDeDoDom(html) {
  const texto = String(html || '');

  // Bloco "--previous" (padrao Andes, usado no ML). A fracao e os centavos vem
  // em spans irmaos, entao nao da para parar no primeiro </span>: a janela vai
  // ate o fechamento do <s> ou, na falta dele, 400 caracteres a frente.
  const inicio = texto.search(/money-amount--previous/i);
  if (inicio >= 0) {
    const resto = texto.slice(inicio, inicio + 800);
    const fim = resto.search(/<\/s>/i);
    const dentro = resto.slice(0, fim >= 0 ? fim : 400);
    const frac = dentro.match(/money-amount__fraction[^>]*>\s*([\d.]+)/i);
    if (frac) {
      const depois = dentro.slice(dentro.indexOf(frac[0]) + frac[0].length, dentro.length);
      const cent = depois.slice(0, 200).match(/money-amount__cents[^>]*>\s*(\d{1,2})/i);
      const v = numeroPartes(frac[1], cent ? cent[1] : null);
      if (v) return v;
    }
    // Sem as classes internas: tenta o texto cru do proprio bloco.
    const cru = dentro.replace(/<[^>]*>/g, ' ').match(/R\$\s*([\d.]+(?:,\d{2})?)/i);
    if (cru) return numeroBr(cru[1]);
  }

  // Generico: qualquer <s>…R$ …</s> (riscado semantico).
  const riscado = texto.match(/<s[\s>][\s\S]{0,400}?<\/s>/i);
  if (riscado) {
    const cru = riscado[0].replace(/<[^>]*>/g, ' ').match(/R\$\s*([\d.]+(?:,\d{2})?)/i);
    if (cru) return numeroBr(cru[1]);
  }

  return null;
}

/** Percentual de desconto declarado na pagina ("28% OFF"), para conferencia. */
export function descontoDeclaradoNoHtml(html) {
  const texto = String(html || '');
  const porJson = texto.match(/"discount(?:_percentage|_value|Percentage)?"\s*:\s*"?(\d{1,2})"?/i);
  if (porJson) {
    const n = Number(porJson[1]);
    if (n > 0 && n < 100) return n;
  }
  const porTexto = texto.replace(/<[^>]*>/g, ' ').match(/(\d{1,2})\s*%\s*OFF/i);
  if (porTexto) {
    const n = Number(porTexto[1]);
    if (n > 0 && n < 100) return n;
  }
  return null;
}
