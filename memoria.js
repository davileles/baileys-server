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
import * as _fs from 'node:fs';
const { readFileSync } = _fs;

// ── Memoria vista pelo sistema (20/11/2026) ──────────────────────────────────
// process.memoryUsage() so mostra o processo. O Railway cobra pelo contêiner
// (cgroup), que tambem conta o cache de arquivos do volume. Aqui separamos:
//   - processo: RssAnon (malloc/nativo) x RssFile (arquivos mapeados);
//   - cgroup: anon x file (cache de disco) x kernel/sock — o que o Railway soma;
//   - alocador: se o jemalloc esta carregado (LD_PRELOAD) e o MALLOC_ARENA_MAX.
function _kbLinha(txt, chave) {
  const m = new RegExp('^' + chave + ':\\s+(\\d+)\\s*kB', 'm').exec(txt || '');
  return m ? Math.round(Number(m[1]) / 1024 * 10) / 10 : null;
}
function _ler(caminho) { try { return readFileSync(caminho, 'utf8'); } catch { return null; } }
export function memoriaDoSistema() {
  const st = _ler('/proc/self/status');
  const processo = st ? {
    rss: _kbLinha(st, 'VmRSS'), picoRss: _kbLinha(st, 'VmHWM'),
    anon: _kbLinha(st, 'RssAnon'), arquivos: _kbLinha(st, 'RssFile'), shmem: _kbLinha(st, 'RssShmem'),
    threads: Number((/^Threads:\s+(\d+)/m.exec(st) || [])[1]) || null,
  } : null;
  let cgroup = null;
  const v2 = _ler('/sys/fs/cgroup/memory.stat');
  const v1 = v2 ? null : _ler('/sys/fs/cgroup/memory/memory.stat');
  const stat = v2 || v1;
  if (stat) {
    const val = k => { const m = new RegExp('^' + k + ' (\\d+)$', 'm').exec(stat); return m ? Math.round(Number(m[1]) / 1048576 * 10) / 10 : null; };
    const atual = Number((_ler(v2 ? '/sys/fs/cgroup/memory.current' : '/sys/fs/cgroup/memory/memory.usage_in_bytes') || '').trim()) || 0;
    cgroup = v2
      ? { total: Math.round(atual / 1048576 * 10) / 10, anon: val('anon'), cacheArquivos: val('file'),
          kernel: val('kernel'), sock: val('sock'), shmem: val('shmem'), arquivoSujo: val('file_dirty') }
      : { total: Math.round(atual / 1048576 * 10) / 10, anon: val('total_rss'), cacheArquivos: val('total_cache') };
    // 21/11/2026: em 20/11 o total (1,89 GB) passava ~0,9 GB da soma anon + file + kernel.
    // detalhe = todas as linhas do memory.stat em MB (slab, percpu, pagetables, zswap,
    // active/inactive_file...); semClassificacao = total - (anon + file + kernel).
    const det = {};
    for (const linha of stat.split('\n')) {
      const m = /^(\w+) (\d+)$/.exec(linha.trim());
      if (!m) continue;
      const v = Number(m[2]);
      if (/^(pg|thp_|workingset_|numa_|hierarchical_)/.test(m[1])) { if (v) det[m[1]] = v; continue; }
      det[m[1]] = Math.round(v / 1048576 * 10) / 10;
    }
    cgroup.detalhe = det;
    const kern = v2 ? (det.kernel ?? ((det.slab || 0) + (det.percpu || 0) + (det.kernel_stack || 0) + (det.pagetables || 0))) : 0;
    cgroup.semClassificacao = Math.round((cgroup.total - (cgroup.anon || 0) - (cgroup.cacheArquivos || 0) - (kern || 0)) * 10) / 10;
    if (v2) {
      const pico = Number((_ler('/sys/fs/cgroup/memory.peak') || '').trim());
      if (pico) cgroup.pico = Math.round(pico / 1048576 * 10) / 10;
      const ev = _ler('/sys/fs/cgroup/memory.events');
      if (ev) cgroup.eventos = Object.fromEntries(ev.trim().split('\n').map(l => l.split(' ')).map(([k, v]) => [k, Number(v)]));
      const sw = Number((_ler('/sys/fs/cgroup/memory.swap.current') || '').trim());
      if (sw) cgroup.swap = Math.round(sw / 1048576 * 10) / 10;
    }
  }
  // Outros processos no conteiner (ffmpeg, filhos do sharp, npm...): nome e RSS.
  let outrosProcessos = null;
  try {
    outrosProcessos = _fs.readdirSync('/proc').filter(n => /^\d+$/.test(n) && Number(n) !== process.pid).map(pid => {
      const s = _ler('/proc/' + pid + '/status');
      if (!s) return null;
      return { pid: Number(pid), nome: (/^Name:\s+(.+)$/m.exec(s) || [])[1] || '?', rss: _kbLinha(s, 'VmRSS') || 0 };
    }).filter(x => x && x.rss > 0).sort((a, b) => b.rss - a.rss).slice(0, 10);
  } catch {}
  const maps = _ler('/proc/self/maps') || '';
  return {
    processo, cgroup, outrosProcessos,
    alocador: { jemalloc: /jemalloc/.test(maps), ldPreload: process.env.LD_PRELOAD || null,
                mallocArenaMax: process.env.MALLOC_ARENA_MAX || null },
  };
}

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
  let sis = null;
  try { sis = memoriaDoSistema(); } catch {}
  _amostras.push({
    em: new Date().toISOString(),
    rss: mb(m.rss), heapUsado: mb(m.heapUsed), heapTotal: mb(m.heapTotal),
    foraDoHeap: mb(m.rss - m.heapTotal), externo: mb(m.external), arrayBuffers: mb(m.arrayBuffers),
    anon: sis?.processo?.anon ?? null, cgroup: sis?.cgroup?.total ?? null,
    cacheArquivos: sis?.cgroup?.cacheArquivos ?? null,
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
    sistema: (() => { try { return memoriaDoSistema(); } catch (e) { return { erro: e.message }; } })(),
    espacosDoHeap: espacos,
    estruturas,
    amostras: _amostras,
  };
}
