// ── LEITURA DE PAGINA DA AMAZON PELA EXTENSAO (Captura Tica 2.15.0+) ─────────
// O servidor le a pagina do produto da Amazon (baixarPaginaProduto em
// radar-amazon.js) para o preco a vista e, desde 18/11/2026, para os cupons do
// bloco "promoPriceBlockMessage". Do IP do Railway a Amazon as vezes devolve a
// pagina intermediaria de robo (~4 KB, sem o produto). Quando isso acontece o
// radar pede a pagina AQUI: a extensao, em long-poll em /amazon/pagina/proximo,
// faz o fetch() com os cookies do Chrome do operador (sem abrir aba) e devolve
// em /amazon/pagina/resultado so os trechos uteis (titulo, preco e cupons).
//
// Mesma receita de paginas-ml.js, mais simples: sem tela de verificacao para
// esperar (a Amazon nao pede captcha a esse fetch) e sem teto por finalidade.
// Freios: uma pagina por vez, espacamento de 3-6 s na extensao, teto diario
// AMZ_PAGINA_TETO (300) e janela AMZ_PAGINA_JANELA (7-23). Extensao offline
// (sem long-poll ha 90 s), fora da janela, teto batido ou sem resposta em
// AMZ_PAGINA_ESPERA_MS (12 s) = null na hora, e o pipeline segue como antes
// (texto do post). AMZ_PAGINA_EXTENSAO=0 desliga.

const LIGADO     = String(process.env.AMZ_PAGINA_EXTENSAO ?? '1') !== '0';
const TETO_DIA   = Number(process.env.AMZ_PAGINA_TETO || 300);
const ESPERA_MS  = Number(process.env.AMZ_PAGINA_ESPERA_MS || 12000);
const ONLINE_MS  = 90000;
const HTML_MAX   = 1.5 * 1024 * 1024;
const [JAN_INI, JAN_FIM] = String(process.env.AMZ_PAGINA_JANELA || '7-23').split('-').map(Number);

let _seq = 0;
const _fila = [];        // [{ id, url, motivo, criadoEm, resolve, timer, entregueEm }]
const _esperando = [];   // long-polls: [{ res, timer }]
const _estado = { ultimoPollEm: 0, dia: null, hoje: 0, lidas: 0, semProduto: 0, falhas: 0, semResposta: 0,
                  ultimaUrl: null, ultimaEm: null, ultimoErro: null, porMotivo: {} };

function diaSp() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }); }
function horaSp() { return Number(new Date().toLocaleTimeString('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }).slice(0, 2)); }
function zerarDia() { const d = diaSp(); if (_estado.dia !== d) { _estado.dia = d; _estado.hoje = 0; _estado.porMotivo = {}; } }

export function extensaoPaginasAmazonOnline() {
  return Date.now() - _estado.ultimoPollEm < ONLINE_MS;
}

/** Por que um pedido agora nao iria a extensao (null = iria). */
export function motivoIndisponivelPaginasAmazon() {
  zerarDia();
  if (!LIGADO) return 'desligado';
  if (!extensaoPaginasAmazonOnline()) return 'extensao_offline';
  const h = horaSp();
  if (!(h >= JAN_INI && h < JAN_FIM)) return 'fora_da_janela';
  if (_estado.hoje >= TETO_DIA) return 'teto_do_dia';
  return null;
}

function entregar(pedido, esperando) {
  pedido.entregueEm = Date.now();
  clearTimeout(esperando.timer);
  try { esperando.res.json({ ok: true, pedido: { id: pedido.id, url: pedido.url, motivo: pedido.motivo } }); } catch (_) {}
}

function despachar() {
  while (_esperando.length) {
    const p = _fila.find(x => !x.entregueEm);
    if (!p) return;
    entregar(p, _esperando.shift());
  }
}

/**
 * Pede a pagina a extensao. Resolve com { html, url, status, semProduto } ou
 * null (indisponivel, sem resposta no prazo, falha na extensao). Nunca rejeita.
 */
export function pedirPaginaAmazon(url, { esperaMs = ESPERA_MS, motivo = 'leitura' } = {}) {
  const indisp = motivoIndisponivelPaginasAmazon();
  if (indisp) return Promise.resolve(null);
  return new Promise(resolve => {
    const id = 'az' + Date.now().toString(36) + (++_seq);
    const pedido = { id, url: String(url), motivo, criadoEm: Date.now(), entregueEm: 0, resolve, timer: null };
    pedido.timer = setTimeout(() => {
      const i = _fila.indexOf(pedido);
      if (i >= 0) _fila.splice(i, 1);
      _estado.semResposta++;
      resolve(null);
    }, esperaMs);
    _fila.push(pedido);
    despachar();
  });
}

/** GET /amazon/pagina/proximo?espera=25 — long-poll da extensao. */
export function atenderLongPollPaginasAmazon(req, res) {
  _estado.ultimoPollEm = Date.now();
  const p = _fila.find(x => !x.entregueEm);
  if (p) return entregar(p, { res, timer: null });
  const espera = Math.min(Math.max(Number(req.query?.espera) || 25, 1), 30) * 1000;
  const item = { res, timer: null };
  item.timer = setTimeout(() => {
    const i = _esperando.indexOf(item);
    if (i >= 0) _esperando.splice(i, 1);
    _estado.ultimoPollEm = Date.now();
    try { res.json({ ok: true, pedido: null }); } catch (_) {}
  }, espera);
  _esperando.push(item);
  req.on?.('close', () => {
    const i = _esperando.indexOf(item);
    if (i >= 0) { _esperando.splice(i, 1); clearTimeout(item.timer); }
  });
}

/**
 * POST /amazon/pagina/resultado — a extensao devolve a pagina. contarCupons(html)
 * (opcional) so serve para a linha de status do popup.
 */
export function registrarResultadoPaginaAmazon(corpo = {}, contarCupons = null) {
  _estado.ultimoPollEm = Date.now();
  const p = _fila.find(x => x.id === corpo.id);
  if (!p) return { ok: true, ignorado: 'pedido expirado ou desconhecido' };
  _fila.splice(_fila.indexOf(p), 1);
  clearTimeout(p.timer);
  zerarDia();
  _estado.hoje++;
  _estado.porMotivo[p.motivo] = (_estado.porMotivo[p.motivo] || 0) + 1;
  _estado.ultimaUrl = p.url; _estado.ultimaEm = new Date().toISOString();
  const html = String(corpo.html || '').slice(0, HTML_MAX);
  if (corpo.erro || !html) {
    _estado.falhas++; _estado.ultimoErro = corpo.erro || 'pagina vazia';
    p.resolve(null);
    return { ok: true, veredito: 'falha' };
  }
  if (corpo.semProduto) {
    _estado.semProduto++;
    p.resolve({ html, url: corpo.url || p.url, status: Number(corpo.status) || 0, semProduto: true });
    return { ok: true, veredito: 'sem_produto' };
  }
  _estado.lidas++;
  p.resolve({ html, url: corpo.url || p.url, status: Number(corpo.status) || 200, semProduto: false, cortado: !!corpo.cortado });
  let cupons = null;
  try { cupons = contarCupons ? contarCupons(html) : null; } catch (_) {}
  return { ok: true, veredito: 'lida', cupons };
}

export function estadoPaginasAmazon() {
  zerarDia();
  return {
    ligado: LIGADO, online: extensaoPaginasAmazonOnline(), motivo: motivoIndisponivelPaginasAmazon(),
    janela: [JAN_INI, JAN_FIM], teto: TETO_DIA, hoje: _estado.hoje, porMotivo: _estado.porMotivo,
    lidasDesdeBoot: _estado.lidas, semProdutoDesdeBoot: _estado.semProduto, falhasDesdeBoot: _estado.falhas,
    semRespostaDesdeBoot: _estado.semResposta, naFila: _fila.length,
    ultimaUrl: _estado.ultimaUrl, ultimaEm: _estado.ultimaEm, ultimoErro: _estado.ultimoErro,
    ultimoPollEm: _estado.ultimoPollEm ? new Date(_estado.ultimoPollEm).toISOString() : null,
  };
}
