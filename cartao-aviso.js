// ── IMAGEM DO AVISO DE PREÇO (05/11/2026) ────────────────────────────────────
// O aviso no privado sai com imagem e o texto como legenda. Dois modos
// (config `imagemAviso` em avisos-preco.js):
//   'cartao' — foto oficial do produto (a que a API da loja devolve) com uma
//              faixa da marca embaixo: o tipo do aviso, "De" riscado, o preço de
//              agora em destaque, o preço desejado e quando/onde o preço foi lido.
//              Serve de comprovante sem print da página da loja (print fica fora
//              da regra de afiliados da Amazon e o Railway é barrado nas lojas).
//   'foto'   — só a foto do produto.
// Qualquer falha devolve null e o aviso sai só em texto — a imagem nunca segura
// nem derruba o envio.
//
// O texto é desenhado com os glifos de glifos-aviso.js (path vetorial), não com
// <text>: sem fonte no container o <text> sai invisível (ver MARCA D'AGUA no
// server.js).
import { GLIFOS, GLIFOS_EM } from './glifos-aviso.js';

const L = 800, ALT_FOTO = 600, ALT = 1000;
const COR = { navy: '#2E3348', coral: '#FA5150', slate: '#9AA1B5', cinza: '#D4D7E2', branco: '#FFFFFF', verde: '#3DD68C' };

let _sharp = null;
async function sharpOu() {
  if (_sharp === false) return null;
  if (_sharp) return _sharp;
  try { _sharp = (await import('sharp')).default; return _sharp; }
  catch (e) { _sharp = false; console.warn('[AVISOS] sharp indisponível — avisos sem imagem: ' + e.message); return null; }
}

function brl(v) {
  return 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Foto em tamanho bom: a Amazon devolve miniatura (_SL160_) e o ML às vezes http.
function urlFotoGrande(url) {
  let u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) return '';
  u = u.replace(/^http:\/\//i, 'https://');
  if (/media-amazon\.com|images-amazon\.com/i.test(u)) u = u.replace(/\._[^/]*?_\.(jpg|jpeg|png|webp)$/i, '._SL800_.$1');
  return u;
}

async function baixarFoto(url) {
  const u = urlFotoGrande(url);
  if (!u) return null;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch(u, { signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return null;
    const b = Buffer.from(await r.arrayBuffer());
    return b.length > 500 ? b : null;
  } catch (e) { return null; }
  finally { clearTimeout(t); }
}

// Largura de um texto em px no tamanho dado.
function largura(txt, tam) {
  let w = 0;
  for (const ch of String(txt)) w += (GLIFOS[ch] || GLIFOS[' '])[0];
  return w * tam / GLIFOS_EM;
}
// Texto como paths. align: 'esq' | 'centro' | 'dir'. Encolhe para caber em maxL.
function texto(txt, x, yBase, tam, cor, { align = 'esq', maxL = 0 } = {}) {
  txt = String(txt);
  if (maxL && largura(txt, tam) > maxL) tam = tam * maxL / largura(txt, tam);
  const w = largura(txt, tam);
  let cx = align === 'centro' ? x - w / 2 : align === 'dir' ? x - w : x;
  const s = tam / GLIFOS_EM;
  let out = '';
  for (const ch of txt) {
    const g = GLIFOS[ch] || GLIFOS[' '];
    if (g[1]) out += '<path transform="translate(' + cx.toFixed(1) + ' ' + yBase.toFixed(1) + ') scale(' + s.toFixed(5) + ')" d="' + g[1] + '"/>';
    cx += g[0] * s;
  }
  return { svg: '<g fill="' + cor + '">' + out + '</g>', w, tam };
}

function horaLeitura(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (isNaN(d)) return '';
  const p = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  const v = k => (p.find(x => x.type === k) || {}).value || '';
  return v('hour') + 'h' + v('minute') + ' de ' + v('day') + '/' + v('month');
}

// Foto do produto centralizada num quadro branco L × alt.
async function quadroFoto(sharp, foto, alt) {
  const img = await sharp(foto).resize(L - 60, alt - 60, { fit: 'contain', background: '#ffffff' }).flatten({ background: '#ffffff' }).png().toBuffer();
  return sharp({ create: { width: L, height: alt, channels: 3, background: '#ffffff' } })
    .composite([{ input: img, gravity: 'center' }]).png().toBuffer();
}

/**
 * Imagem do aviso. Devolve Buffer JPEG ou null (aviso sai só em texto).
 * @param {object} o { modo:'cartao'|'foto', imagemUrl, tipo:'alvo'|'parcial'|'queda',
 *                     outraLoja, preco, precoDe, alvo, loja, lidoEm, cupom }
 */
export async function gerarImagemAviso(o = {}) {
  try {
    if (!o.modo || o.modo === 'texto') return null;
    const sharp = await sharpOu();
    if (!sharp) return null;
    const foto = await baixarFoto(o.imagemUrl);
    if (!foto) return null;

    if (o.modo === 'foto') {
      const q = await quadroFoto(sharp, foto, L);
      return await sharp(q).jpeg({ quality: 85 }).toBuffer();
    }

    const q = await quadroFoto(sharp, foto, ALT_FOTO);
    const partes = [];
    // Selo no canto da foto.
    const selo = texto('ALERTA DE PREÇO', 0, 0, 22, COR.branco);
    partes.push('<rect x="24" y="24" rx="18" width="' + (selo.w + 36).toFixed(0) + '" height="40" fill="' + COR.coral + '"/>');
    partes.push(texto('ALERTA DE PREÇO', 42, 52, 22, COR.branco).svg);
    // Faixa da marca.
    partes.push('<rect x="0" y="' + ALT_FOTO + '" width="' + L + '" height="' + (ALT - ALT_FOTO) + '" fill="' + COR.navy + '"/>');
    const titulo = o.tipo === 'alvo' ? 'CHEGOU NO SEU PREÇO!' : o.outraLoja ? 'ACHEI MAIS BARATO!' : 'BAIXOU O PREÇO!';
    partes.push(texto(titulo, L / 2, ALT_FOTO + 62, 36, COR.coral, { align: 'centro', maxL: L - 80 }).svg);
    let y = ALT_FOTO + 62;
    if (o.precoDe && o.precoDe > o.preco * 1.01) {
      y += 50;
      const de = texto('De ' + brl(o.precoDe), L / 2, y, 30, COR.slate, { align: 'centro' });
      partes.push(de.svg);
      partes.push('<rect x="' + (L / 2 - de.w / 2 - 4).toFixed(1) + '" y="' + (y - 11) + '" width="' + (de.w + 8).toFixed(1) + '" height="3" fill="' + COR.slate + '"/>');
    }
    y += 112;
    partes.push(texto(brl(o.preco), L / 2, y, 104, COR.branco, { align: 'centro', maxL: L - 80 }).svg);
    if (o.cupom) {
      y += 46;
      partes.push(texto('com o cupom ' + o.cupom, L / 2, y, 28, COR.cinza, { align: 'centro', maxL: L - 80 }).svg);
    }
    if (o.alvo) {
      y += 52;
      const ok = o.preco <= o.alvo;
      partes.push(texto('Seu preço: ' + brl(o.alvo) + (ok ? '  ✓' : ''), L / 2, y, 32, ok ? COR.verde : COR.cinza, { align: 'centro', maxL: L - 80 }).svg);
    }
    const rodY = ALT - 34;
    partes.push('<rect x="40" y="' + (rodY - 40) + '" width="' + (L - 80) + '" height="1.5" fill="#4A5170"/>');
    const lido = 'Preço lido' + (o.loja ? ' na ' + o.loja : '') + (o.lidoEm ? ' às ' + horaLeitura(o.lidoEm) : '');
    partes.push(texto(lido, 40, rodY, 21, COR.slate, { maxL: L - 300 }).svg);
    partes.push(texto('@TICAPROMOS', L - 40, rodY, 21, COR.coral, { align: 'dir' }).svg);

    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + L + '" height="' + ALT + '">' + partes.join('') + '</svg>';
    const base = await sharp({ create: { width: L, height: ALT, channels: 3, background: COR.navy } })
      .composite([{ input: q, top: 0, left: 0 }, { input: Buffer.from(svg), top: 0, left: 0 }])
      .jpeg({ quality: 88 }).toBuffer();
    return base;
  } catch (e) {
    console.warn('[AVISOS] Imagem do aviso falhou: ' + e.message);
    return null;
  }
}
