// ═══════════════════════════════════════════════════════════════════════════
// egress.js — medidor de trafego de SAIDA do servidor, por destino.
//
// Por que existe: em nov/2026 o Railway cobrou 512 GB de egress do
// baileys-server num ciclo (US$ 25,59, metade da conta do projeto), enquanto o
// wa-envio, que manda as imagens dos ticos, fez 29 GB. Sem medidor nao da para
// saber quem gasta; com ele, GET /egress responde.
//
// Como mede:
//  - Conexoes que o servidor ABRE (fetch/undici, https, WebSocket do WhatsApp
//    e do Telegram): net.Socket.prototype.connect ganha um gancho que soma
//    socket.bytesWritten por host. Conexao longa (WebSocket) e somada a cada
//    minuto; as curtas, ao fechar.
//  - Respostas HTTP que o servidor DA (painéis, extensao, proxy): middleware
//    do express soma os bytes de res.write/res.end por rota (1º segmento).
//  - PUTs do sync-github: contados la, por arquivo (estadoSync().envios).
// Tudo em memoria, desde o boot. Nao muda nenhum comportamento.
//
// IMPORTANTE: tem de ser o PRIMEIRO import do server.js — os imports do ESM
// avaliam em ordem, e conexao aberta antes do gancho nao entra na conta.
// ═══════════════════════════════════════════════════════════════════════════
import net from 'net';

const BOOT = Date.now();
const _porHost = new Map();   // host -> { bytes, conexoes }
const _porRota = new Map();   // '/rota' -> { bytes, respostas }
const _vivos = new Set();

function hostDe(s) {
  const h = s.servername || s._host || s.remoteAddress || 'desconhecido';
  // Agrupa subdominios numerados (mmg.whatsapp.net, media-gru1-1.cdn...).
  if (net.isIP(String(h))) return String(h);
  return String(h).replace(/^[a-z0-9-]*\d[a-z0-9-]*\./i, '*.');
}

function contabilizar(s) {
  const eg = s.__eg;
  if (!eg) return;
  const total = Number(s.bytesWritten) || 0;
  const delta = total - eg.ultimo;
  if (delta <= 0) return;
  eg.ultimo = total;
  const h = hostDe(s);
  const r = _porHost.get(h) || { bytes: 0, conexoes: 0 };
  r.bytes += delta;
  _porHost.set(h, r);
}

const _connectOriginal = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  if (!this.__eg) {
    this.__eg = { ultimo: 0 };
    _vivos.add(this);
    this.once('connect', () => {
      const r = _porHost.get(hostDe(this)) || { bytes: 0, conexoes: 0 };
      r.conexoes += 1;
      _porHost.set(hostDe(this), r);
    });
    this.once('close', () => { contabilizar(this); _vivos.delete(this); });
  }
  return _connectOriginal.apply(this, args);
};

setInterval(() => { for (const s of _vivos) { try { contabilizar(s); } catch {} } }, 60000).unref();

function tamanho(chunk, enc) {
  if (!chunk) return 0;
  if (typeof chunk === 'string') return Buffer.byteLength(chunk, typeof enc === 'string' ? enc : 'utf8');
  return chunk.length || chunk.byteLength || 0;
}

/** Middleware do express: soma os bytes das respostas por rota. */
export function medirRespostas(req, res, next) {
  const rota = '/' + (String(req.path || '').split('/')[1] || '');
  let bytes = 0;
  const w = res.write, e = res.end;
  res.write = function (chunk, enc, cb) { bytes += tamanho(chunk, enc); return w.call(this, chunk, enc, cb); };
  res.end = function (chunk, enc, cb) { bytes += tamanho(chunk, enc); return e.call(this, chunk, enc, cb); };
  res.once('finish', () => {
    const r = _porRota.get(rota) || { bytes: 0, respostas: 0 };
    r.bytes += bytes; r.respostas += 1;
    _porRota.set(rota, r);
  });
  next();
}

const mb = b => Math.round(b / 1048576 * 10) / 10;
function ordenar(mapa, campoQtd) {
  return [...mapa.entries()]
    .map(([k, v]) => ({ destino: k, mb: mb(v.bytes), [campoQtd]: v[campoQtd] }))
    .sort((a, b) => b.mb - a.mb);
}

/** Resumo para GET /egress. `extras` recebe o detalhamento do sync-github. */
export function estadoEgress(extras = {}) {
  for (const s of _vivos) { try { contabilizar(s); } catch {} }
  const horas = (Date.now() - BOOT) / 3600e3;
  const saida = [..._porHost.values()].reduce((t, v) => t + v.bytes, 0);
  const respostas = [..._porRota.values()].reduce((t, v) => t + v.bytes, 0);
  const total = saida + respostas;
  return {
    desdeBoot: new Date(BOOT).toISOString(),
    horas: Math.round(horas * 10) / 10,
    totalMb: mb(total),
    projecaoGbDia: horas > 0 ? Math.round(total / 1073741824 / horas * 24 * 100) / 100 : null,
    conexoesAbertasPeloServidor: { totalMb: mb(saida), porHost: ordenar(_porHost, 'conexoes').slice(0, 40) },
    respostasHttp: { totalMb: mb(respostas), porRota: ordenar(_porRota, 'respostas').slice(0, 40) },
    ...extras,
  };
}
