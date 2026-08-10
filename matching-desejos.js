// ══════════════════════════════════════════════════════════════════════════════
//  MATCHING DE DESEJOS × OFERTAS
//  Cruza as ofertas de marketplace capturadas pelo radar com os desejos de
//  compra registrados em desejos.json (proxy CDV, repo privado de dados).
//
//  MATCH_DESEJOS (env do Railway):
//    'off'   — desligado (PADRAO). Nao faz nenhuma chamada, nao gasta nada.
//    'aviso' — avisa o OPERADOR no WhatsApp quando uma oferta casa com um desejo.
//    'on'    — reservado para o disparo direto ao cliente (fase 3, ainda nao
//              implementado aqui: cai no comportamento de 'aviso').
//
//  Nada neste modulo envia mensagem para o cliente final. O envio direto so
//  entra depois que o numero dedicado existir e o opt-in estiver registrado.
// ══════════════════════════════════════════════════════════════════════════════
const CDV_PROXY = 'https://cdv-proxy-production.up.railway.app';
const MODO = String(process.env.MATCH_DESEJOS || 'off').toLowerCase();
const CACHE_TTL_MS = 10 * 60 * 1000;   // desejos mudam devagar; 10 min basta
const MAX_MATCHES_POR_OFERTA = 5;      // trava de seguranca contra termo generico

let _cache = { em: 0, itens: [] };

function norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

function ativo() { return MODO === 'aviso' || MODO === 'on'; }

// ── Carga dos desejos abertos (com cache) ────────────────────────────────────
async function carregarDesejos(forcar = false) {
  if (!forcar && Date.now() - _cache.em < CACHE_TTL_MS) return _cache.itens;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 12000);
    const r = await fetch(CDV_PROXY + '/compras/desejos?status=aberto&t=' + Date.now(),
      { signal: ctl.signal });
    clearTimeout(t);
    const d = await r.json();
    if (!d || !d.ok) throw new Error(d && d.erro ? d.erro : 'resposta invalida');
    _cache = { em: Date.now(), itens: Array.isArray(d.data) ? d.data : [] };
    return _cache.itens;
  } catch (e) {
    console.warn('[DESEJOS] Falha ao carregar desejos:', e.message);
    // Mantem o cache anterior: uma falha de rede nao pode derrubar o radar.
    return _cache.itens;
  }
}

// ── Chave estavel da oferta (para o ledger de avisos) ────────────────────────
function chaveOferta(oferta) {
  const d = (oferta && oferta.dadosExtraidos) || {};
  return String(d.asin || d.link || oferta.id || '').slice(0, 200);
}

// ── Um termo casa se TODAS as suas palavras (>=3 letras) estao no titulo ─────
function termoCasa(termo, tituloNorm) {
  const palavras = norm(termo).split(' ').filter(p => p.length >= 3);
  if (!palavras.length) return false;
  return palavras.every(p => tituloNorm.includes(p));
}

// ── Avaliacao de um desejo contra uma oferta ─────────────────────────────────
// Filtro barato e deterministico: nao chama IA. Se o volume de falso-positivo
// crescer, o passo seguinte e um julgamento Haiku SO nos candidatos que passarem
// aqui — nunca na base inteira.
function avaliar(desejo, oferta) {
  const d = (oferta && oferta.dadosExtraidos) || {};
  const tituloNorm = norm(d.titulo);
  if (!tituloNorm) return null;

  // 1. Loja
  const lojas = Array.isArray(desejo.lojas) ? desejo.lojas.filter(Boolean) : [];
  if (lojas.length && !lojas.some(l => norm(l) === norm(d.loja))) return null;

  // 2. Termos (cai para o proprio nome do produto se termos estiver vazio)
  const termos = (Array.isArray(desejo.termos) && desejo.termos.length)
    ? desejo.termos : [desejo.produto];
  const termoBatido = termos.find(t => termoCasa(t, tituloNorm));
  if (!termoBatido) return null;

  // 3. Preco
  const preco = Number(d.precoFinal != null ? d.precoFinal : d.preco);
  const precoMax = Number(desejo.precoMax);
  if (precoMax > 0 && preco > 0 && preco > precoMax) return null;

  const precoAlvo = Number(desejo.precoAlvo);
  const abaixoDoAlvo = precoAlvo > 0 && preco > 0 && preco <= precoAlvo;

  return { termo: termoBatido, preco, abaixoDoAlvo };
}

// ── Ledger anti-duplicata ────────────────────────────────────────────────────
function jaAvisado(desejo, chave) {
  const avisos = Array.isArray(desejo.avisos) ? desejo.avisos : [];
  return avisos.some(a => a && a.ofertaId === chave);
}

async function registrarAviso(desejoId, chave) {
  try {
    const r = await fetch(CDV_PROXY + '/compras/desejos/aviso', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: desejoId, ofertaId: chave, canal: 'operador' })
    });
    const d = await r.json();
    if (!d.ok) throw new Error(d.erro || 'falha');
    return true;
  } catch (e) {
    console.warn('[DESEJOS] Falha ao registrar aviso de ' + desejoId + ':', e.message);
    return false;
  }
}

function brl(v) {
  const n = Number(v);
  return n > 0 ? 'R$ ' + n.toFixed(2).replace('.', ',') : '—';
}

function telefoneMascarado(t) {
  const s = String(t || '').replace(/\D+/g, '');
  return s.length >= 6 ? s.slice(0, 4) + '****' + s.slice(-4) : (s || '—');
}

function montarAviso(oferta, matches) {
  const d = (oferta && oferta.dadosExtraidos) || {};
  const linhas = matches.map(m =>
    '• ' + (m.desejo.nome || telefoneMascarado(m.desejo.telefone))
    + ' — "' + (m.desejo.produto || m.info.termo) + '"'
    + (m.info.abaixoDoAlvo ? '  ✅ abaixo do alvo (' + brl(m.desejo.precoAlvo) + ')' : '')
    + (Number(m.desejo.precoMax) > 0 && !m.info.abaixoDoAlvo
        ? '  (teto ' + brl(m.desejo.precoMax) + ')' : '')
  );

  return '🎯 *Oferta casou com desejo de cliente*\n\n'
    + '*Produto* ' + (d.titulo || '—') + '\n'
    + '*Loja* ' + (d.loja || '—') + '\n'
    + '*Preço* ' + brl(d.precoFinal != null ? d.precoFinal : d.preco)
    + (d.desconto ? '  (' + d.desconto + '% off)' : '') + '\n'
    + (d.link ? '*Link* ' + d.link + '\n' : '')
    + '\n*Quem estava esperando:*\n' + linhas.join('\n')
    + '\n\nOferta #' + oferta.id + ' na fila do painel.';
}

// ── Entrada publica ──────────────────────────────────────────────────────────
// Chamada em fire-and-forget pelo radar. NUNCA lanca: qualquer erro aqui e
// registrado e engolido, porque isto e acessorio ao pipeline de ofertas.
async function casarDesejosComOferta(oferta, { enviarAviso } = {}) {
  try {
    if (!ativo()) return { matches: 0 };
    const d = (oferta && oferta.dadosExtraidos) || {};
    if (!d.titulo) return { matches: 0 };

    const desejos = await carregarDesejos();
    if (!desejos.length) return { matches: 0 };

    const chave = chaveOferta(oferta);
    const matches = [];
    for (const desejo of desejos) {
      if (jaAvisado(desejo, chave)) continue;
      const info = avaliar(desejo, oferta);
      if (info) matches.push({ desejo, info });
      if (matches.length >= MAX_MATCHES_POR_OFERTA) break;
    }
    if (!matches.length) return { matches: 0 };

    console.log('[DESEJOS] Oferta #' + oferta.id + ' casou com '
      + matches.length + ' desejo(s): ' + matches.map(m => m.desejo.id).join(', '));

    if (typeof enviarAviso === 'function') {
      await enviarAviso(montarAviso(oferta, matches));
    }

    // Só marca no ledger depois do aviso sair — se o envio falhar, a próxima
    // oferta igual tenta de novo em vez de silenciar para sempre.
    for (const m of matches) {
      const ok = await registrarAviso(m.desejo.id, chave);
      if (ok) {
        m.desejo.avisos = Array.isArray(m.desejo.avisos) ? m.desejo.avisos : [];
        m.desejo.avisos.push({ ofertaId: chave, canal: 'operador', em: new Date().toISOString() });
      }
    }

    return { matches: matches.length };
  } catch (e) {
    console.error('[DESEJOS] Erro no matching:', e.message);
    return { matches: 0, erro: e.message };
  }
}

export { casarDesejosComOferta, carregarDesejos, MODO as MODO_DESEJOS };
