// ═══════════════════════════════════════════════════════════════════════════
// insercao-ml-auto.js — insercao ESPACADA de cupons na conta do Mercado Livre
//
// Historico: meses de insercao imediata (na captura, varias seguidas, do IP do
// Railway) terminaram em set/2026 com a conta TSP proibida de inserir cupom,
// inclusive a mao. Depois disso a insercao virou assistida (/inserir no bot).
// Este modulo volta a automatizar, mas com um ritmo que nao parece robo:
//
//   - fila: o cupom capturado NAO e inserido na hora; entra na fila
//   - intervalo aleatorio entre insercoes (padrao 3–7 min), persistido, para
//     um redeploy nao gerar rajada
//   - janela de horario humana (padrao 8h–23h, horario de Brasilia)
//   - teto diario (padrao 8, para subir aos poucos); o excedente vai para o
//     /inserir manual
//   - disjuntor: 403, antibot, payload rejeitado, resposta estranha ou falhas
//     de rede seguidas desligam tudo, devolvem a fila ao /inserir e avisam.
//     So volta pelo /autoinserir no bot (estado persistido: redeploy nao religa)
//
// A resposta do input-code tambem VALIDA o cupom: esgotado/vencido/inexistente
// sai da base sem o operador precisar testar um a um.
//
// Variaveis (Railway):
//   CUPONS_ML_INSERCAO_AUTO=1        liga a fila (padrao desligada)
//   CUPONS_ML_AUTO_TETO_DIA=8        insercoes automaticas por dia
//   CUPONS_ML_AUTO_INTERVALO_MIN=3-7 intervalo aleatorio em minutos
//   CUPONS_ML_AUTO_JANELA=8-23       horas (inicio inclusive, fim exclusive)
// CUPONS_ML_PAUSADO continua valendo para sync e leitura de "Meus cupons": esta
// fila e o UNICO caminho que chama o input-code com a pausa ligada.
// ═══════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from 'fs';

const LIGADA = String(process.env.CUPONS_ML_INSERCAO_AUTO || '0') === '1';

function faixa(txt, padrao) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*$/.exec(String(txt || ''));
  if (!m) return padrao;
  const a = Number(m[1]), b = Number(m[2]);
  return a >= 0 && b >= a ? [a, b] : padrao;
}

const TETO_DIA = Math.max(0, parseInt(process.env.CUPONS_ML_AUTO_TETO_DIA || '8', 10) || 0);
const [INTERVALO_MIN, INTERVALO_MAX] = faixa(process.env.CUPONS_ML_AUTO_INTERVALO_MIN, [3, 7]);
const [JANELA_INI, JANELA_FIM] = faixa(process.env.CUPONS_ML_AUTO_JANELA, [8, 23]);

// Valores de insercaoMl usados aqui. O /inserir do bot lista null, MANUAL e
// CONFERIR; FILA fica fora dele (a automacao cuida).
const FILA = 'fila_auto';                  // esperando a vez na fila automatica
const MANUAL = 'manual';                   // devolvido ao operador (teto/disjuntor)
const CONFERIR = 'conferir';               // resposta ambigua: operador confere no celular
const FALHAS_REDE_MAX = 3;                 // timeouts/5xx seguidos que abrem o disjuntor
const INVALIDOS_SEGUIDOS_MAX = 3;          // "nao existe" em serie = canal suspeito
const CANAL_OK_VALIDADE_MS = 24 * 60 * 60 * 1000;
const RE_CODIGO = /^[A-Za-z0-9._-]{2,40}$/;

let dep = null;
let ESTADO_PATH = './sessao/insercao_ml_auto.json';
let _timer = null;
let _proximaEm = null;
let _rodando = false;

let estado = {
  dia: null,            // AAAA-MM-DD (Brasilia) do contador
  feitasHoje: 0,        // chamadas ao input-code hoje
  ultimaEm: 0,          // ms da ultima chamada — base do espacamento
  canalOkEm: 0,         // ultima resposta que provou o canal vivo (ok/ja tinha)
  invalidosSeguidos: 0,
  falhasRede: 0,
  tetoAvisadoEm: null,  // dia em que o excedente ja foi devolvido ao manual
  disjuntor: null,      // { em, motivo, codigo } — enquanto existir, nada roda
  resumo: [],           // desfechos do lote atual, para o card do Telegram
  ultimos: [],          // ultimos desfechos (para o /autoinserir)
};

// ── HORA DE BRASILIA ─────────────────────────────────────────────────────────
const FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
function agoraBr(ms = Date.now()) {
  const p = Object.fromEntries(FMT.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { dia: p.year + '-' + p.month + '-' + p.day, hora: Number(p.hour), min: Number(p.minute) };
}
function dentroDaJanela(ms = Date.now()) {
  const { hora } = agoraBr(ms);
  return hora >= JANELA_INI && hora < JANELA_FIM;
}
/** ms ate o proximo inicio de janela (aproximado ao minuto). */
function msAteJanela(ms = Date.now()) {
  const { hora, min } = agoraBr(ms);
  let horas = JANELA_INI - hora;
  if (horas <= 0) horas += 24;
  return Math.max(60000, (horas * 60 - min) * 60000);
}
function hhmm(ms) {
  if (!ms) return '—';
  const { hora, min } = agoraBr(ms);
  return String(hora).padStart(2, '0') + ':' + String(min).padStart(2, '0');
}

// ── PERSISTENCIA ─────────────────────────────────────────────────────────────
function carregar() {
  try {
    if (existsSync(ESTADO_PATH)) estado = { ...estado, ...JSON.parse(readFileSync(ESTADO_PATH, 'utf-8')) };
  } catch (e) { console.warn('[CUPONS-ML-AUTO] Estado ilegivel, comecando do zero:', e.message); }
}
function salvar() {
  try {
    const dir = ESTADO_PATH.replace(/\/[^/]+$/, '');
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = ESTADO_PATH + '.tmp';
    writeFileSync(tmp, JSON.stringify(estado), 'utf-8');
    renameSync(tmp, ESTADO_PATH);
  } catch (e) { console.warn('[CUPONS-ML-AUTO] Falha ao salvar estado:', e.message); }
}
function virarDia() {
  const { dia } = agoraBr();
  if (estado.dia !== dia) { estado.dia = dia; estado.feitasHoje = 0; salvar(); }
}

// ── BASE ─────────────────────────────────────────────────────────────────────
function ehMl(r) { return /mercado\s*livre/i.test(String(r && r.loja || '')); }
function inseriveis() {
  return (dep.listarCuponsBase() || []).filter(r => ehMl(r) && r.codigo && r.ativo !== false
    && RE_CODIGO.test(String(r.codigo)) && r.confirmadoNoMl !== true);
}
function naFila() {
  return inseriveis().filter(r => r.insercaoMl === FILA)
    .sort((a, b) => (Date.parse(a.validadeAte) || Infinity) - (Date.parse(b.validadeAte) || Infinity));
}
function marcar(reg, campos) {
  try { return dep.atualizarCupomBase(reg.chave, campos); }
  catch (e) { console.warn('[CUPONS-ML-AUTO] Falha ao atualizar ' + reg.codigo + ':', e.message); return null; }
}
/** Tira tudo da fila automatica e devolve ao /inserir (que avisa o operador). */
function devolverFilaAoManual() {
  const itens = naFila();
  for (const r of itens) marcar(r, { insercaoMl: MANUAL });
  if (itens.length) { try { dep.avisarManual(); } catch (e) {} }
  return itens.length;
}

function podeRodar() { return LIGADA && !estado.disjuntor; }
function tetoAtingido() { virarDia(); return estado.feitasHoje >= TETO_DIA; }

// ── AGENDAMENTO ──────────────────────────────────────────────────────────────
function intervaloMs() {
  const min = INTERVALO_MIN + Math.random() * (INTERVALO_MAX - INTERVALO_MIN);
  return Math.round(min * 60000);
}
function agendar(ms) {
  if (_timer) clearTimeout(_timer);
  _proximaEm = Date.now() + ms;
  _timer = setTimeout(() => { _timer = null; _proximaEm = null; passo().catch(e =>
    console.error('[CUPONS-ML-AUTO] Erro no passo:', e.message)); }, ms);
  _timer.unref?.();
}
/** Agenda a proxima insercao respeitando o espacamento desde a ultima. */
function agendarProxima() {
  if (!podeRodar()) return;
  const alvo = (estado.ultimaEm || 0) + intervaloMs();
  agendar(Math.max(15000, alvo - Date.now()));
}

// ── AVISOS ───────────────────────────────────────────────────────────────────
function registrarDesfecho(r, rotulo) {
  const linha = { codigo: r.codigo, rotulo, em: Date.now() };
  estado.resumo.push(linha);
  estado.ultimos = [linha, ...estado.ultimos].slice(0, 12);
}
async function enviarResumo(cabecalho) {
  if (!estado.resumo.length) return;
  const linhas = estado.resumo.map(x => x.rotulo + ' ' + x.codigo);
  estado.resumo = [];
  salvar();
  const texto = (cabecalho || '🤖 Inserção automática no ML — lote concluído') + '\n\n'
    + linhas.join('\n') + '\n\nHoje: ' + estado.feitasHoje + '/' + TETO_DIA + ' · /autoinserir para ver o estado';
  try { await dep.avisarTelegram(texto); } catch (e) {}
}

async function abrirDisjuntor(motivo, codigo) {
  if (estado.disjuntor) return;
  estado.disjuntor = { em: new Date().toISOString(), motivo, codigo: codigo || null };
  salvar();
  if (_timer) { clearTimeout(_timer); _timer = null; _proximaEm = null; }
  const devolvidos = devolverFilaAoManual();
  console.error('[CUPONS-ML-AUTO] DISJUNTOR ABERTO: ' + motivo + (codigo ? ' (' + codigo + ')' : ''));
  const texto = '🛑 Inserção automática de cupons no ML DESLIGADA\n\n'
    + 'Motivo: ' + motivo + (codigo ? '\nCupom: ' + codigo : '') + '\n'
    + (devolvidos ? devolvidos + ' cupom(ns) voltaram para o /inserir.\n' : '')
    + '\nNada mais será inserido automaticamente até você religar no bot (/autoinserir). '
    + 'Se for bloqueio de conta, espere 24–48h antes de religar ou de inserir à mão.';
  await enviarResumo('🤖 Inserção automática — o que saiu antes do desligamento');
  try { await dep.avisarTelegram(texto); } catch (e) {}
  try { await dep.avisarOperador(texto); } catch (e) {}
}

// ── PASSO: UMA INSERCAO ──────────────────────────────────────────────────────
async function passo() {
  if (_rodando || !podeRodar()) return;
  _rodando = true;
  try {
    if (!dentroDaJanela()) {
      const ms = msAteJanela() + Math.round(Math.random() * 10 * 60000);
      if (naFila().length) console.log('[CUPONS-ML-AUTO] Fora da janela ' + JANELA_INI + 'h–' + JANELA_FIM
        + 'h; retomo em ~' + Math.round(ms / 60000) + ' min.');
      return agendar(ms);
    }
    if (tetoAtingido()) {
      if (estado.tetoAvisadoEm !== estado.dia) {
        estado.tetoAvisadoEm = estado.dia; salvar();
        const n = devolverFilaAoManual();
        await enviarResumo('🤖 Inserção automática — teto do dia atingido (' + TETO_DIA + ')'
          + (n ? '. ' + n + ' cupom(ns) foram para o /inserir.' : '.'));
      }
      return agendar(msAteJanela() + Math.round(Math.random() * 10 * 60000));
    }
    const fila = naFila();
    if (!fila.length) { await enviarResumo(); return; }       // ocioso ate a proxima captura
    if (!dep.tokenAffOk()) {
      console.warn('[CUPONS-ML-AUTO] Token de afiliados fora do ar — tento de novo em 15 min.');
      return agendar(15 * 60000);
    }

    const reg = fila[0];
    const codigo = String(reg.codigo).trim().toUpperCase();
    estado.ultimaEm = Date.now();
    estado.feitasHoje++;
    salvar();

    let r = null, erro = null;
    try { r = await dep.ativarCupomMl(codigo, { permitirNaPausa: true }); }
    catch (e) { erro = e; }

    if (erro || (r && !r.rc && r.status >= 500)) {
      // Rede/timeout/5xx: nao diz nada sobre o cupom nem sobre a conta. Fica na
      // fila; so abre o disjuntor se repetir.
      estado.falhasRede++; salvar();
      const msg = erro ? erro.message : 'HTTP ' + r.status;
      console.warn('[CUPONS-ML-AUTO] Falha transitoria em ' + codigo + ': ' + msg);
      if (estado.falhasRede >= FALHAS_REDE_MAX) return abrirDisjuntor(FALHAS_REDE_MAX + ' falhas seguidas de rede/servidor (' + msg + ')', codigo);
      return agendarProxima();
    }
    estado.falhasRede = 0;

    if (r.ok || r.jaTinha) {
      estado.canalOkEm = Date.now(); estado.invalidosSeguidos = 0;
      marcar(reg, { confirmadoNoMl: true, insercaoMl: 'inserido_auto' });
      registrarDesfecho(reg, r.jaTinha ? '☑️ já estava' : '✅ inserido');
      console.log('[CUPONS-ML-AUTO] ' + codigo + (r.jaTinha ? ' ja estava na conta.' : ' inserido na conta.'));
    } else if (r.rc === 'SOLD_OUT' || r.rc === 'EXPIRED_ACTION') {
      // Codigos especificos do ML: veredito confiavel sobre o cupom.
      estado.canalOkEm = Date.now(); estado.invalidosSeguidos = 0;
      const campos = { ativo: false, insercaoMl: 'recusado',
        observacao: 'Recusado na inserção automática: ' + (r.mensagem || r.rc) };
      if (r.venceuEm) campos.validadeAte = r.venceuEm;
      marcar(reg, campos);
      registrarDesfecho(reg, r.rc === 'SOLD_OUT' ? '🗑 esgotado' : '🗑 vencido');
    } else if (r.rc === 'INVALID_1') {
      estado.invalidosSeguidos++;
      if (estado.invalidosSeguidos >= INVALIDOS_SEGUIDOS_MAX) {
        salvar();
        return abrirDisjuntor(INVALIDOS_SEGUIDOS_MAX + ' códigos seguidos recusados como inexistentes — '
          + 'o canal pode estar respondendo "inválido" para tudo', codigo);
      }
      if (Date.now() - (estado.canalOkEm || 0) < CANAL_OK_VALIDADE_MS) {
        marcar(reg, { ativo: false, insercaoMl: 'recusado',
          observacao: 'Código inexistente segundo o ML (inserção automática)' });
        registrarDesfecho(reg, '🗑 inexistente');
      } else {
        // Sem prova recente de que o canal responde de verdade, "invalido" nao
        // basta para desativar: o operador confere no celular.
        marcar(reg, { insercaoMl: CONFERIR });
        registrarDesfecho(reg, '👀 conferir à mão');
        try { dep.avisarManual(); } catch (e) {}
      }
    } else if (r.bloqueado) {
      salvar();
      return abrirDisjuntor('o ML bloqueou a chamada (HTTP ' + r.status + (r.mensagem ? ' — ' + r.mensagem : '') + ')', codigo);
    } else if (r.payloadRejeitado) {
      salvar();
      return abrirDisjuntor('o ML rejeitou o formato da chamada (INVALID_6) — o input-code mudou', codigo);
    } else {
      salvar();
      return abrirDisjuntor('resposta inesperada do ML (' + (r.rc || 'HTTP ' + r.status) + ': '
        + String(r.mensagem || '').slice(0, 120) + ')', codigo);
    }
    salvar();
    agendarProxima();
  } finally {
    _rodando = false;
  }
}

// ── API DO MODULO ────────────────────────────────────────────────────────────
export function insercaoMlAutoLigada() { return LIGADA; }

/**
 * Tenta colocar um cupom recem-capturado na fila automatica. Devolve false
 * quando nao da (desligada, disjuntor aberto, teto do dia) — o chamador segue
 * com a insercao manual (/inserir).
 */
export function enfileirarInsercaoMl(reg) {
  if (!dep || !podeRodar() || !reg || !reg.chave) return false;
  if (!ehMl(reg) || !reg.codigo || !RE_CODIGO.test(String(reg.codigo))) return false;
  if (reg.confirmadoNoMl === true) return true;
  if (tetoAtingido()) return false;
  if (reg.insercaoMl && reg.insercaoMl !== FILA) return false;   // ja decidido ou devolvido ao operador
  if (!marcar(reg, { insercaoMl: FILA })) return false;
  if (!_timer && !_rodando) agendarProxima();
  return true;
}

/**
 * Coloca na fila o que ja esta esperando no /inserir. No boot so adota o que
 * nunca passou por decisao nenhuma; ao religar, adota tambem o que o teto ou o
 * disjuntor devolveram. CONFERIR nunca e adotado: a resposta do ML foi ambigua
 * e repetir a chamada nao esclarece nada.
 */
function adotarPendentes({ incluirDevolvidos = false } = {}) {
  if (!podeRodar()) return 0;
  virarDia();
  let n = 0;
  const vagas = Math.max(0, TETO_DIA - estado.feitasHoje - naFila().length);
  const adotavel = x => !x.insercaoMl || (incluirDevolvidos && x.insercaoMl === MANUAL);
  const candidatos = inseriveis().filter(adotavel)
    .sort((a, b) => (Date.parse(a.validadeAte) || Infinity) - (Date.parse(b.validadeAte) || Infinity));
  for (const r of candidatos.slice(0, vagas)) {
    if (marcar(r, { insercaoMl: FILA })) n++;
  }
  return n;
}

export function estadoInsercaoMlAuto() {
  virarDia();
  return {
    ligada: LIGADA,
    disjuntor: estado.disjuntor,
    feitasHoje: estado.feitasHoje,
    tetoDia: TETO_DIA,
    intervaloMin: [INTERVALO_MIN, INTERVALO_MAX],
    janela: [JANELA_INI, JANELA_FIM],
    dentroDaJanela: dentroDaJanela(),
    naFila: dep ? naFila().map(r => r.codigo) : [],
    proximaEm: _proximaEm,
    proximaHora: hhmm(_proximaEm),
    ultimaHora: hhmm(estado.ultimaEm),
    ultimos: estado.ultimos,
  };
}

export async function religarInsercaoMlAuto() {
  if (!LIGADA) return { ok: false, erro: 'CUPONS_ML_INSERCAO_AUTO não está ligado no Railway' };
  estado.disjuntor = null; estado.falhasRede = 0; estado.invalidosSeguidos = 0;
  salvar();
  const adotados = adotarPendentes({ incluirDevolvidos: true });
  agendarProxima();
  console.log('[CUPONS-ML-AUTO] Religada pelo operador; ' + adotados + ' cupom(ns) adotados do /inserir.');
  return { ok: true, adotados };
}

export async function pausarInsercaoMlAuto(motivo = 'pausada pelo operador') {
  if (estado.disjuntor) return { ok: true };
  estado.disjuntor = { em: new Date().toISOString(), motivo, codigo: null };
  salvar();
  if (_timer) { clearTimeout(_timer); _timer = null; _proximaEm = null; }
  const devolvidos = devolverFilaAoManual();
  await enviarResumo();
  return { ok: true, devolvidos };
}

/**
 * deps: { listarCuponsBase, atualizarCupomBase, ativarCupomMl, tokenAffOk,
 *         avisarManual, avisarTelegram(texto), avisarOperador(texto), sessaoDir }
 */
export function iniciarInsercaoMlAuto(deps) {
  dep = deps;
  if (deps.sessaoDir) ESTADO_PATH = deps.sessaoDir.replace(/\/$/, '') + '/insercao_ml_auto.json';
  carregar();
  virarDia();
  if (!LIGADA) {
    // Desligada: nada pode ficar preso em fila_auto, invisivel no /inserir.
    const n = devolverFilaAoManual();
    if (n) console.log('[CUPONS-ML-AUTO] Desligada — ' + n + ' cupom(ns) devolvidos ao /inserir.');
    return;
  }
  if (estado.disjuntor) {
    const n = devolverFilaAoManual();
    console.warn('[CUPONS-ML-AUTO] Disjuntor aberto desde ' + estado.disjuntor.em + ' (' + estado.disjuntor.motivo
      + ') — nada sera inserido ate religar no bot.' + (n ? ' ' + n + ' devolvido(s) ao /inserir.' : ''));
    return;
  }
  const adotados = adotarPendentes();
  console.log('[CUPONS-ML-AUTO] Ligada: teto ' + TETO_DIA + '/dia, intervalo ' + INTERVALO_MIN + '–' + INTERVALO_MAX
    + ' min, janela ' + JANELA_INI + 'h–' + JANELA_FIM + 'h. Hoje: ' + estado.feitasHoje + '. Adotados: ' + adotados + '.');
  agendarProxima();
}
