// ════════════════════════════════════════════════════════════════════════════
// seats-alertas.js — e-mails de alerta do seats.aero → grupo de WhatsApp
//
// O Davi nao acompanha o e-mail com frequencia e o assunto do seats.aero
// ("More flights found for your alert from CDG to GRU") nao diz qual alerta
// disparou nem por quantos pontos. Um Apps Script na conta Gmail dele
// (apps-script/seats-alertas.gs) le os e-mails de alerts@seats.aero a cada
// 5 min e manda para POST /seats-alertas/email. Aqui:
//
//   1. le o e-mail (regex sobre o HTML convertido em texto; IA so de reserva,
//      porque o layout do seats.aero e estavel mas pode mudar sem aviso)
//   2. descarta o que ja foi avisado: mesmo e-mail (id do Gmail) ou mesmo
//      alerta/rota/data/cabine/programa/voos/pontos nas ultimas 24 h
//   3. monta um bloco resumido por alerta e envia ao grupo "Alertas Seats.aero"
//      na hora (fora da fila de ofertas e da janela 8h-21h), por uma conta de
//      disparo — a principal fica de reserva
//
// O estado (ids e chaves avisados) so e gravado DEPOIS do envio dar certo: se o
// WhatsApp falhar, o Apps Script recebe erro, nao marca o e-mail e tenta de
// novo na rodada seguinte.
//
// Variaveis (Railway):
//   SEATS_ALERTA_SEGREDO   segredo que o Apps Script manda no header
//                          X-Seats-Segredo (obrigatorio; sem ele a rota da 503)
//   SEATS_ALERTA_GRUPO     JID do grupo (padrao: "Alertas Seats.aero")
// ════════════════════════════════════════════════════════════════════════════
import fs from 'fs';
import crypto from 'crypto';

const ARQ_ESTADO        = './sessao/seats_alertas.json';
const GRUPO_PADRAO      = '120363413135474473@g.us';   // "Alertas Seats.aero"
const TTL_CHAVE_MS      = 24 * 60 * 60 * 1000;
const MAX_IDS           = 600;
const BLOCOS_POR_MSG    = 5;
const TZ                = 'America/Sao_Paulo';

const CABINES = {
  economy: 'Econômica', 'premium economy': 'Premium Economy', premium: 'Premium Economy',
  business: 'Executiva', first: 'Primeira Classe',
};
// Nome do programa como o seats.aero escreve → como o CDV escreve.
const PROGRAMAS = {
  'gol smiles': 'Smiles', smiles: 'Smiles',
  'azul tudoazul': 'Azul Fidelidade', 'azul fidelidade': 'Azul Fidelidade', tudoazul: 'Azul Fidelidade',
  'latam pass': 'LATAM Pass', 'tap miles&go': 'TAP Miles&Go', 'tap miles & go': 'TAP Miles&Go',
};
const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

// ── Estado persistido ───────────────────────────────────────────────────────
let estado = { ids: [], chaves: {}, ultimo: null, contagem: { recebidos: 0, enviados: 0, duplicados: 0, ia: 0, semLeitura: 0 } };
try {
  const lido = JSON.parse(fs.readFileSync(ARQ_ESTADO, 'utf-8'));
  if (lido && typeof lido === 'object') estado = { ...estado, ...lido, contagem: { ...estado.contagem, ...(lido.contagem || {}) } };
} catch { /* primeiro uso */ }

function gravarEstado() {
  try {
    const tmp = ARQ_ESTADO + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(estado));
    fs.renameSync(tmp, ARQ_ESTADO);
  } catch (e) { console.error('[SEATS-ALERTA] Falha ao gravar estado:', e.message); }
}

function limparChavesVencidas(agora = Date.now()) {
  for (const [k, ts] of Object.entries(estado.chaves)) if (agora - ts > TTL_CHAVE_MS) delete estado.chaves[k];
}

export function grupoSeatsAlertas() {
  return String(process.env.SEATS_ALERTA_GRUPO || '').trim() || GRUPO_PADRAO;
}

export function segredoSeatsOk(recebido) {
  const esperado = String(process.env.SEATS_ALERTA_SEGREDO || '').trim();
  const r = String(recebido || '').trim();
  if (!esperado || !r) return false;
  const a = Buffer.from(esperado), b = Buffer.from(r);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
export function seatsAlertasConfigurado() { return !!String(process.env.SEATS_ALERTA_SEGREDO || '').trim(); }

// ── Leitura do e-mail ───────────────────────────────────────────────────────
function decodificarEntidades(s) {
  return s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

export function htmlParaTexto(html) {
  return decodificarEntidades(String(html || '')
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[​-‍﻿]/g, '')
    .replace(/\s+/g, ' ').trim();
}

function linkDoAlerta(html, texto) {
  const h = String(html || '');
  const m = h.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>(?:(?!<\/a>)[\s\S]){0,400}?View on seats\.aero/i);
  if (m) return decodificarEntidades(m[1]);
  const urls = (String(texto || '') + ' ' + h).match(/https?:\/\/[^\s"'<>)]+/g) || [];
  return urls.find(u => /seats\.aero/i.test(u) && !/unsubscribe|optout|preferences/i.test(u)) || null;
}

function numero(s) {
  const n = parseInt(String(s || '').replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

// Le o e-mail pelo texto fixo do seats.aero:
//   ...your alert "NOME" with GOL Smiles in business class for CDG to GRU on 2027-03-24...
//   AF454 [Flight] CDG/GRU [Routing] Business (O9), 527,000 points [+ taxa] [Fare]
export function lerAlertaPorRegex(texto) {
  const t = String(texto || '').replace(/\s+/g, ' ');
  const cab = t.match(/alert\s+["“]([^"”]+)["”]\s+with\s+(.+?)\s+in\s+([a-z ]+?)\s+class\s+for\s+([A-Z]{3})\s+to\s+([A-Z]{3})\s+on\s+(\d{4}-\d{2}-\d{2})/i);
  if (!cab) return null;
  const voos = [];
  const re = /\b([A-Z0-9]{2}\d{1,4}(?:\s*[,/+]\s*[A-Z0-9]{2}\d{1,4})*)\s+(?:Flight\s+)?([A-Z]{3}(?:\s*\/\s*[A-Z]{3})+)\s+(?:Routing\s+)?([A-Za-z][A-Za-z ]{1,30}?)\s*(?:\(([A-Z0-9]{1,3})\))?\s*,\s*([\d.,]+)\s*(?:points|miles|pts)\b(?:\s*\+\s*((?:[A-Z]{3}|[$€£R]{1,2})\s?[\d.,]+|[\d.,]+\s?[A-Z]{3}))?/g;
  let m;
  while ((m = re.exec(t))) {
    voos.push({
      voo: m[1].replace(/\s+/g, ''), rota: m[2].replace(/\s+/g, ''),
      classe: m[3].trim(), tarifa: m[4] || null, pontos: numero(m[5]), taxas: m[6] || null,
    });
  }
  return {
    alerta: cab[1].trim(), programa: cab[2].trim(), cabine: cab[3].trim().toLowerCase(),
    origem: cab[4].toUpperCase(), destino: cab[5].toUpperCase(), data: cab[6], voos,
  };
}

const PROMPT_IA = `Você lê e-mails de alerta do seats.aero (disponibilidade de passagens com milhas).
Responda SOMENTE JSON válido, sem markdown:
{"ehAlerta": true/false,
 "alerta": "nome do alerta entre aspas no e-mail" | null,
 "programa": "programa de fidelidade como aparece (ex.: GOL Smiles, Aeroplan)" | null,
 "cabine": "economy" | "premium economy" | "business" | "first" | null,
 "origem": "IATA" | null, "destino": "IATA" | null,
 "data": "AAAA-MM-DD" | null,
 "voos": [{"voo": "AF454", "rota": "CDG/GRU", "classe": "Business", "tarifa": "O9" | null, "pontos": 527000, "taxas": "texto" | null}]}
Se o e-mail não for um alerta de disponibilidade, devolva {"ehAlerta": false}. Não invente valores.`;

// ── Formatação ──────────────────────────────────────────────────────────────
function nomeLocal(iata, cidades) {
  const c = cidades?.[iata];
  return c ? c + ' (' + iata + ')' : iata;
}
function dataBR(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso || '';
  const dia = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)).getUTCDay();
  return m[3] + '/' + m[2] + '/' + m[1] + ' (' + DIAS[dia] + ')';
}
function horaSP(quando) {
  const d = new Date(quando || Date.now());
  if (isNaN(d)) return '';
  return d.toLocaleString('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(',', '');
}
function nomePrograma(p) { return PROGRAMAS[String(p || '').toLowerCase()] || p || '—'; }
function nomeCabine(c) { return CABINES[String(c || '').toLowerCase()] || c || '—'; }
function pts(n) { return Number.isFinite(n) ? n.toLocaleString('pt-BR') + ' pts' : '—'; }

function blocoAlerta(a, { link, recebidoEm, cidades }) {
  const linhas = [];
  if (a.alerta) linhas.push('📌 *' + a.alerta + '*');
  linhas.push('✈️ ' + nomeLocal(a.origem, cidades) + ' → ' + nomeLocal(a.destino, cidades));
  linhas.push('💺 ' + nomeCabine(a.cabine) + ' · 🎟️ ' + nomePrograma(a.programa));
  linhas.push('📅 ' + dataBR(a.data));
  const voos = [...(a.voos || [])].sort((x, y) => (x.pontos ?? Infinity) - (y.pontos ?? Infinity));
  for (const v of voos) {
    const rotaExtra = v.rota && v.rota !== a.origem + '/' + a.destino ? ' · ' + v.rota.replace(/\//g, '→') : '';
    linhas.push('• ' + v.voo + rotaExtra + (v.tarifa ? ' · ' + v.tarifa : '') + ' · *' + pts(v.pontos) + '*'
      + (v.taxas ? ' + ' + v.taxas : ''));
  }
  if (!voos.length) linhas.push('• (voos não listados no e-mail)');
  if (link) linhas.push('🔗 ' + link);
  if (recebidoEm) linhas.push('🕒 Recebido ' + horaSP(recebidoEm));
  return linhas.join('\n');
}

function blocoSemLeitura(e, link) {
  return ['❓ *' + (e.assunto || 'E-mail do seats.aero') + '*',
    'Não consegui ler os detalhes deste e-mail — abra no Gmail.',
    link ? '🔗 ' + link : null,
    e.data ? '🕒 Recebido ' + horaSP(e.data) : null].filter(Boolean).join('\n');
}

function chaveAlerta(a) {
  const voos = (a.voos || []).map(v => v.voo + ':' + (v.pontos ?? '')).sort().join(',');
  return [a.alerta, a.origem, a.destino, a.data, String(a.cabine).toLowerCase(), nomePrograma(a.programa), voos]
    .map(x => String(x ?? '').toLowerCase()).join('|');
}

// ── Processamento de um lote vindo do Apps Script ───────────────────────────
// deps: { enviar(texto) → Promise, extrairIA(system, texto) → Promise<obj|null>, cidades }
export async function processarEmailsSeats(emails, deps) {
  const lista = Array.isArray(emails) ? emails.slice(0, 30) : [];
  const agora = Date.now();
  limparChavesVencidas(agora);
  const idsVistos = new Set(estado.ids);
  const chavesLote = new Set();
  const processados = [], blocos = [], novasChaves = [];
  let duplicados = 0, viaIA = 0, semLeitura = 0;

  for (const e of lista) {
    const id = String(e?.id || '').slice(0, 64);
    if (!id) continue;
    if (idsVistos.has(id)) { processados.push(id); duplicados++; continue; }

    const texto = htmlParaTexto(e.html) || String(e.texto || '').replace(/\s+/g, ' ');
    const link  = linkDoAlerta(e.html, e.texto);
    let a = lerAlertaPorRegex(texto) || lerAlertaPorRegex(e.texto);

    if ((!a || !a.voos.length) && deps.extrairIA) {
      try {
        const r = await deps.extrairIA(PROMPT_IA, 'Assunto: ' + (e.assunto || '') + '\n\n' + texto.slice(0, 8000));
        if (r && r.ehAlerta && r.origem && r.destino) {
          a = { alerta: r.alerta, programa: r.programa, cabine: r.cabine, origem: String(r.origem).toUpperCase(),
                destino: String(r.destino).toUpperCase(), data: r.data,
                voos: (Array.isArray(r.voos) ? r.voos : []).map(v => ({ ...v, pontos: numero(v.pontos) })) };
          viaIA++;
        } else if (r && r.ehAlerta === false) {
          a = null;
        }
      } catch (err) { console.warn('[SEATS-ALERTA] IA falhou:', err.message); }
    }

    processados.push(id);
    if (!a) {
      semLeitura++;
      blocos.push(blocoSemLeitura(e, link));
      continue;
    }
    const chave = chaveAlerta(a);
    if (estado.chaves[chave] || chavesLote.has(chave)) { duplicados++; continue; }
    chavesLote.add(chave);
    novasChaves.push(chave);
    blocos.push(blocoAlerta(a, { link, recebidoEm: e.data, cidades: deps.cidades }));
  }

  // Envio: cabecalho uma vez por mensagem, ate BLOCOS_POR_MSG alertas cada.
  let mensagens = 0;
  for (let i = 0; i < blocos.length; i += BLOCOS_POR_MSG) {
    const parte = blocos.slice(i, i + BLOCOS_POR_MSG);
    const titulo = '🔔 *Alerta Seats.aero*' + (blocos.length > 1 ? ' · ' + blocos.length + ' novidades' : '');
    await deps.enviar(titulo + '\n\n' + parte.join('\n\n'));   // erro sobe: nada e gravado
    mensagens++;
  }

  // So aqui, com tudo enviado, o lote vira "ja avisado".
  for (const k of novasChaves) estado.chaves[k] = agora;
  estado.ids = [...estado.ids, ...processados.filter(id => !idsVistos.has(id))].slice(-MAX_IDS);
  estado.ultimo = { em: new Date(agora).toISOString(), recebidos: lista.length, enviados: blocos.length, duplicados, mensagens };
  estado.contagem.recebidos += lista.length;
  estado.contagem.enviados  += blocos.length;
  estado.contagem.duplicados += duplicados;
  estado.contagem.ia += viaIA;
  estado.contagem.semLeitura += semLeitura;
  gravarEstado();

  return { processados, enviados: blocos.length, duplicados, mensagens, viaIA, semLeitura };
}

export function estadoSeatsAlertas() {
  limparChavesVencidas();
  return {
    configurado: seatsAlertasConfigurado(),
    grupo: grupoSeatsAlertas(),
    ultimo: estado.ultimo,
    contagem: estado.contagem,
    chavesAtivas: Object.keys(estado.chaves).length,
    idsGuardados: estado.ids.length,
  };
}
