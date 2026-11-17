// ── MEDIDOR DE MEMORIA ───────────────────────────────────────────────────────
// Criado em 17/11/2026: o baileys-server ficou com ~5 GB de RAM em media na
// semana (picos de 8–10 GB) e a memoria sobe ~0,15 GB/h entre um deploy e outro.
// No Railway a RAM virou o maior custo do servidor. Este modulo nao muda nada no
// funcionamento: so mede, para achar o que cresce.
//
//   - amostra a cada 10 min (48 h em memoria): rss, heap do JS, memoria fora do
//     heap (Buffers, sharp, sockets) e a tendencia em MB/h desde o boot;
//   - registrarMedidor(nome, fn): cada estrutura grande do servidor (Map, lista,
//     cache) diz quantos itens tem; com ?detalhe=1 tambem o tamanho aproximado
//     em MB (JSON das primeiras entradas, extrapolado — caro, so sob pedido).
//
// Leitura: rss alto com heapUsado baixo = a memoria esta fora do JS (imagens do
// sharp, Buffers de midia, fragmentacao); heapUsado subindo junto = alguma
// estrutura do codigo crescendo — os medidores mostram qual.

import v8 from 'node:v8';

const AMOSTRA_MS = 10 * 60000;
const AMOSTRAS_MAX = 288;            // 48 h
const _amostras = [];
const _medidores = new Map();        // nome -> fn
const _historicoItens = new Map();   // nome -> [{ em, itens }] (ultimas 48 h)
const _bootEm = Date.now();

const mb = b => Math.round((Number(b) || 0) / 1048576 * 10) / 10;

export function registrarMedidor(nome, fn) {
  if (typeof fn === 'function') _medidores.set(String(nome), fn);
}

function _lerMedidor(fn) {
  try {
    const v = fn();
    if (v == null) return null;
    if (typeof v === 'number') return { itens: v };
    if (v instanceof Map || v instanceof Set) return { itens: v.size, alvo: v };
    if (Array.isArray(v)) return { itens: v.length, alvo: v };
    if (typeof v === 'object') return v;     // { itens, mb?, alvo? }
    return null;
  } catch (e) { return { erro: e.message }; }
}

// Tamanho aproximado: serializa ate 300 entradas e extrapola. Buffer conta pelo
// tamanho real. Nunca serializa a estrutura inteira (pode ter centenas de MB).
function _mbAproximado(alvo, itens) {
  if (!alvo || !itens) return 0;
  let amostra = [];
  if (alvo instanceof Map) { for (const par of alvo) { amostra.push(par); if (amostra.length >= 300) break; } }
  else if (alvo instanceof Set) { for (const x of alvo) { amostra.push(x); if (amostra.length >= 300) break; } }
  else if (Array.isArray(alvo)) amostra = alvo.slice(-300);
  if (!amostra.length) return 0;
  let bytes = 0;
  const visto = new WeakSet();
  const medir = x => {
    if (x == null) return 4;
    if (Buffer.isBuffer(x)) return x.length;
    if (x instanceof Uint8Array) return x.byteLength;
    if (typeof x === 'string') return x.length * 2;
    if (typeof x !== 'object') return 8;
    if (visto.has(x)) return 0;
    visto.add(x);
    let binario = 0;
    try {
      const txt = JSON.stringify(x, (k, v) => {
        if (Buffer.isBuffer(v)) { binario += v.length; return 0; }
        if (v instanceof Uint8Array) { binario += v.byteLength; return 0; }
        if (v && v.type === 'Buffer' && Array.isArray(v.data)) { binario += v.data.length; return 0; }
        return v;
      }) || '';
      return Buffer.byteLength(txt) * 2 + binario;
    } catch { return binario; }
  };
  for (const x of amostra) bytes += Array.isArray(x) ? x.reduce((s, y) => s + medir(y), 0) : medir(x);
  return mb(bytes / amostra.length * itens);
}

function _amostrar() {
  const m = process.memoryUsage();
  _amostras.push({
    em: new Date().toISOString(),
    rss: mb(m.rss), heapUsado: mb(m.heapUsed), heapTotal: mb(m.heapTotal),
    foraDoHeap: mb(m.rss - m.heapTotal), externo: mb(m.external), arrayBuffers: mb(m.arrayBuffers),
  });
  if (_amostras.length > AMOSTRAS_MAX) _amostras.shift();
  const em = new Date().toISOString();
  for (const [nome, fn] of _medidores) {
    const r = _lerMedidor(fn);
    if (!r || r.erro || typeof r.itens !== 'number') continue;
    const h = _historicoItens.get(nome) || [];
    h.push({ em, itens: r.itens });
    if (h.length > AMOSTRAS_MAX) h.shift();
    _historicoItens.set(nome, h);
  }
}
setTimeout(_amostrar, 60000).unref?.();
setInterval(_amostrar, AMOSTRA_MS).unref?.();

function _porHora(a, b, campo) {
  if (!a || !b) return null;
  const h = (new Date(b.em) - new Date(a.em)) / 3600000;
  if (h < 0.5) return null;
  return Math.round((b[campo] - a[campo]) / h * 10) / 10;
}

export function estadoMemoria({ detalhe = false } = {}) {
  const m = process.memoryUsage();
  const agora = {
    rss: mb(m.rss), heapUsado: mb(m.heapUsed), heapTotal: mb(m.heapTotal),
    foraDoHeap: mb(m.rss - m.heapTotal), externo: mb(m.external), arrayBuffers: mb(m.arrayBuffers),
  };
  const h = v8.getHeapStatistics();
  const espacos = v8.getHeapSpaceStatistics()
    .map(s => ({ espaco: s.space_name, usadoMb: mb(s.space_used_size), totalMb: mb(s.space_size) }))
    .sort((a, b) => b.usadoMb - a.usadoMb);
  const prim = _amostras[0], ult = _amostras[_amostras.length - 1];
  const estruturas = [];
  for (const [nome, fn] of _medidores) {
    const r = _lerMedidor(fn);
    if (!r) continue;
    const hist = _historicoItens.get(nome) || [];
    const linha = { nome, itens: r.itens ?? null };
    if (r.erro) linha.erro = r.erro;
    if (hist.length >= 2) linha.itensNoInicio = hist[0].itens;
    if (typeof r.mb === 'number') linha.mb = r.mb;
    else if (detalhe && r.alvo) linha.mbAprox = _mbAproximado(r.alvo, r.itens);
    estruturas.push(linha);
  }
  const chave = x => (x.mb ?? x.mbAprox ?? 0) * 1e6 + (x.itens || 0);
  estruturas.sort((a, b) => chave(b) - chave(a));
  return {
    desdeBoot: new Date(_bootEm).toISOString(),
    horas: Math.round((Date.now() - _bootEm) / 360000) / 10,
    agoraMb: agora,
    limiteHeapMb: mb(h.heap_size_limit),
    tendenciaMbPorHora: { rss: _porHora(prim, ult, 'rss'), heapUsado: _porHora(prim, ult, 'heapUsado'),
                          foraDoHeap: _porHora(prim, ult, 'foraDoHeap') },
    leitura: agora.foraDoHeap > agora.heapTotal
      ? 'A maior parte da memoria esta FORA do heap do JS (Buffers, sharp, sockets ou fragmentacao).'
      : 'A maior parte da memoria esta no heap do JS: ver as estruturas que mais cresceram.',
    espacosDoHeap: espacos,
    estruturas,
    amostras: _amostras,
  };
}
