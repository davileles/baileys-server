// ═══════════════════════════════════════════════════════════════════════════
// insercao-ml-auto.js — ORQUESTRADOR da insercao de cupons na conta do ML
//
// Historico: meses de insercao imediata a partir do Railway terminaram em
// set/2026 com a conta TSP proibida de inserir cupom. A primeira volta da
// automacao (22/09) espacava as chamadas, mas ainda saiam do Railway: IP de
// datacenter, TLS do Node com User-Agent de Chrome, POST sem navegacao. Ritmo
// nao esconde identidade — por isso este modulo NAO chama mais o ML.
//
// Quem insere e a extensao Captura Tica, no Chrome do operador (IP residencial,
// sessao logada de verdade, pagina aberta, digitacao e clique). Aqui fica so o
// cerebro:
//
//   - fila (modo enxuto, 28/09/2026): cupom capturado entra na fila; quando o
//     mais antigo completa AGRUPAR_MIN (10 min), a fila INTEIRA vai para a
//     extensao, que insere em sequencia (~15 s por cupom, como a mao)
//   - janela diurna e uma trava diaria alta (seguranca, nao ritmo)
//   - disjuntor: erro de conta, pagina mudada, login caido ou respostas
//     estranhas desligam tudo, devolvem a fila ao /inserir e avisam. So volta
//     pelo /autoinserir (estado persistido: redeploy nao religa)
//   - visita sem atividade por 7 min volta para a fila (a extensao retoma)
//   - extensao ausente: cupom parado alem do limite volta ao /inserir
//
// Variaveis (Railway):
//   CUPONS_ML_INSERCAO_AUTO=1          liga a fila (padrao desligada)
//   CUPONS_ML_EXTENSAO_TOKEN=...       token que a extensao manda (obrigatorio)
//   CUPONS_ML_AUTO_AGRUPAR_MIN=10      espera para juntar um pacote (0 = na hora)
//   CUPONS_ML_AUTO_TETO=100            trava diaria de seguranca
//   CUPONS_ML_AUTO_JANELA=8-23         horas (inicio inclusive, fim exclusive)
//   CUPONS_ML_AUTO_ESPERA_MAX_MIN=180  cupom parado na fila alem disso → /inserir
//   CUPONS_ML_AUTO_SELETORES={...}     JSON que sobrepoe os seletores da pagina
// CUPONS_ML_PAUSADO continua valendo para sync e leitura de "Meus cupons";
// este modulo nunca chama o input-code.
// ═══════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from 'fs';
import { randomBytes, timingSafeEqual } from 'crypto';

const LIGADA = String(process.env.CUPONS_ML_INSERCAO_AUTO || '0') === '1';

function faixa(txt, padrao) {
  const s = String(txt || '').trim();
  const m = /^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/.exec(s);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    return a >= 0 && b >= a ? [a, b] : padrao;
  }
  const n = Number(s);
  return s && isFinite(n) && n >= 0 ? [n, n] : padrao;
}
function sortear([a, b]) { return a + Math.random() * (b - a); }
function sortearInt([a, b]) { return Math.round(sortear([a, b])); }

// 28/09/2026 — modo ENXUTO (decisao do Davi): o cupom entra na fila e, no
// maximo AGRUPAR_MIN depois, a fila INTEIRA e inserida em sequencia, no ritmo
// de quem insere a mao. Sem lote sorteado, sem pausa longa entre visitas, sem
// teto sorteado e sem dia de folga. As variaveis antigas
// (CUPONS_ML_AUTO_{TETO_DIA,ATRASO_MIN,LOTE,PAUSA_MIN,FOLGA_PCT}) sao ignoradas.
const AGRUPAR_MIN = Math.max(0, Number(process.env.CUPONS_ML_AUTO_AGRUPAR_MIN ?? 10) || 0);
const TETO_FIXO = Math.max(1, Number(process.env.CUPONS_ML_AUTO_TETO) || 100);   // trava de seguranca, nao ritmo
const TETO_DIA = [TETO_FIXO, TETO_FIXO];
const [JANELA_INI, JANELA_FIM] = faixa(process.env.CUPONS_ML_AUTO_JANELA, [8, 23]);
const LOTE_MAX = 40;
const LOTE = [1, LOTE_MAX];
const PAUSA_MIN = [1, 1];        // so um respiro entre uma visita e a proxima
const FOLGA_PCT = 0;
const ESPERA_MAX_MS = Math.max(30, Number(process.env.CUPONS_ML_AUTO_ESPERA_MAX_MIN) || 180) * 60000;

// Seletores da pagina de cupons do ML (lidos em 27/09/2026). Vao para a
// extensao a cada lote: se o ML mudar a pagina, corrige-se aqui (ou na env),
// sem republicar a extensao.
const SELETORES_PADRAO = {
  url: 'https://www.mercadolivre.com.br/cupons',
  abrir: '.input-code-modal__action-button',        // botao "Inserir codigo"
  campo: '#inputcode-textfield-with-link',          // input do modal (maxlength 23)
  // 28/09/2026: o ML esta migrando o Andes para o prefixo andes-ui-* (o botao
  // antigo sumiu). Listas com as duas geracoes + [role=dialog]: querySelector
  // pega o primeiro que existir.
  botao: '.andes-modal__scroll button.andes-button--loud, .andes-ui-modal button.andes-ui-button--loud, [role=dialog] button.andes-ui-button--loud, [role=dialog] button.andes-button--loud',  // "Inserir" (desabilitado ate digitar)
  fechar: '.andes-modal__close-button, .andes-ui-modal__close-button, [role=dialog] button[aria-label*="echar"]',
  modal: '.andes-modal__scroll, .andes-ui-modal__scroll, .andes-ui-modal, [role=dialog]',
  apiInputCode: '/cupons/api/input-code',           // a resposta e o veredito confiavel
};
function seletores() {
  try {
    const extra = process.env.CUPONS_ML_AUTO_SELETORES ? JSON.parse(process.env.CUPONS_ML_AUTO_SELETORES) : null;
    return extra && typeof extra === 'object' ? { ...SELETORES_PADRAO, ...extra } : SELETORES_PADRAO;
  } catch (e) { return SELETORES_PADRAO; }
}
// Tempos que a extensao usa dentro da visita (segundos / ms). Sorteados la.
const TEMPOS = {
  antesDoPrimeiroS: [1, 3],      // pagina aberta → primeiro cupom
  entreCuponsS: [4, 9],          // entre um cupom e o outro (~15 s por cupom no total, como a mao)
  digitacaoMs: [60, 160],        // por caractere
  pausaDigitacaoMs: [200, 500],  // pausa maior ocasional entre caracteres
  aposClicarS: [1, 3],           // espera a resposta antes de ler o resultado
  antesDeFecharS: [1, 3],        // fica um pouco na pagina antes de fechar a aba
};

// Valores de insercaoMl usados aqui. O /inserir do bot lista null, MANUAL e
// CONFERIR; FILA e VISITA ficam fora dele (a automacao cuida).
const FILA = 'fila_auto';                  // esperando a vez
const VISITA = 'em_visita';                // entregue a extensao, aguardando resultado
const MANUAL = 'manual';                   // devolvido ao operador (teto/folga/disjuntor)
const CONFERIR = 'conferir';               // resposta ambigua: operador confere no celular
const FALHAS_MAX = 3;                      // erros seguidos da extensao que abrem o disjuntor
const PROBLEMAS_MAX = 2;                   // "Tivemos um problema" seguidos = conta restrita
const INVALIDOS_SEGUIDOS_MAX = 3;          // "nao existe" em serie = canal suspeito
const PAGINA_MUDOU_MAX = 2;                // seletor ausente em visitas SEGUIDAS = pagina mudou mesmo
const CANAL_OK_VALIDADE_MS = 24 * 60 * 60 * 1000;
// 07/10/2026 — REVERIFICACAO: cupom confirmado na conta que a leitura de "Meus
// cupons" nao encontrou (venceu, esgotou, foi usado ou e card sem codigo
// digitavel) pega carona na proxima visita de insercao: a extensao "insere" o
// codigo de novo e a resposta do ML (ja tinha / vencido / esgotado) atualiza a
// base. So vai junto quando ja existe cupom NOVO para inserir — nenhuma visita
// e aberta so para reverificar.
const REVERIF_POR_VISITA = 10;             // no maximo tantos por visita
const REVERIF_INTERVALO_MS = 24 * 60 * 60 * 1000;  // o mesmo cupom no maximo 1x por dia
const VISITA_EXPIRA_MS = 7 * 60000;        // visita SEM ATIVIDADE ha tanto: lote volta para a fila
const EXTENSAO_AUSENTE_MS = 30 * 60000;    // sem contato ha tanto = extensao fora do ar
const RE_CODIGO = /^[A-Za-z0-9._-]{2,23}$/;  // 23 = maxlength do campo do ML
const VEREDITOS = new Set(['inserido', 'ja_tinha', 'esgotado', 'vencido', 'inexistente', 'indisponivel', 'problema', 'sem_login', 'pagina_mudou', 'erro']);
const INDISPONIVEL = 'indisponivel';       // o ML disse que o cupom nao esta disponivel PARA ESTA CONTA
// 01/10/2026: "INVALID_5: O cupom não está disponível" (HTTP 200) chegou como
// "problema" e abriu o disjuntor como se fosse restricao da conta. Resposta
// com codigo INVALID_n e texto especifico e o ML julgando O CUPOM (exclusivo
// de outro publico, campanha encerrada para a conta) — o canal esta vivo.
// INVALID_6 fica fora: e payload que o ML nao entendeu, nao diz nada do cupom.
// 05/10/2026: "NOT_IN_TARGET_AUDIENCE: Este cupom não se aplica a você" (HTTP
// 200) abriu o disjuntor em 03/10 — e o mesmo caso: cupom restrito a outro
// publico, canal vivo.
const RE_INDISPONIVEL = /\bINVALID_(?![16]\b)\d+\b|n[ãa]o est[áa] dispon[íi]vel|\bNOT_IN_TARGET_AUDIENCE\b|n[ãa]o se aplica a voc[êe]/i;

let dep = null;
let ESTADO_PATH = './sessao/insercao_ml_auto.json';
let _vigia = null;

let estado = {
  dia: null,            // AAAA-MM-DD (Brasilia) do contador
  tetoHoje: 0,          // sorteado em TETO_DIA a cada dia
  folgaHoje: false,     // dia sem insercao (sorteado)
  feitasHoje: 0,        // tentativas hoje (cada cupom que a extensao tentou)
  ultimaVisitaEm: 0,
  proximaVisitaEm: 0,   // antes disso a extensao recebe "aguarde"
  ultimoContatoExt: 0,  // ultima chamada da extensao (qualquer)
  canalOkEm: 0,         // ultima resposta que provou o canal vivo (ok/ja tinha)
  invalidosSeguidos: 0,
  problemasSeguidos: 0,
  paginaMudouSeguidos: 0,  // 29/09/2026: 1 falha de seletor = tropeco; so 2 seguidas desligam
  paginaMudouCodigos: [],  // 01/10/2026: cupons da serie de falhas de seletor (mesmo cupom = culpa do cupom)
  falhas: 0,
  liberaEm: {},         // chave → ms em que o cupom fica elegivel
  entrouEm: {},         // chave → ms em que entrou na fila (limite de espera)
  visita: null,         // { id, chaves, reverificar, iniciadaEm } — lote em andamento
  reverificar: {},      // chave → ms: confirmado na conta mas ausente da ultima leitura de "Meus cupons"
  reverificadoEm: {},   // chave → ms da ultima reverificacao (resposta do ML)
  tetoAvisadoEm: null,  // dia em que o excedente ja foi devolvido ao manual
  folgaAvisadaEm: null,
  ausenteAvisadaEm: null,
  disjuntor: null,      // { em, motivo, codigo } — enquanto existir, nada roda
  resumo: [],           // desfechos da visita atual, para o card do Telegram
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
    if (!estado.liberaEm || typeof estado.liberaEm !== 'object') estado.liberaEm = {};
    if (!estado.entrouEm || typeof estado.entrouEm !== 'object') estado.entrouEm = {};
    if (!estado.reverificar || typeof estado.reverificar !== 'object') estado.reverificar = {};
    if (!estado.reverificadoEm || typeof estado.reverificadoEm !== 'object') estado.reverificadoEm = {};
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
/** Sorteia teto e folga do dia; zera contadores. Idempotente dentro do dia. */
function virarDia() {
  const { dia } = agoraBr();
  // Estado gravado pela versao anterior (sem tetoHoje) ja trazia o dia de hoje:
  // sem esta guarda o teto ficava 0 e nada entrava na fila.
  if (estado.dia === dia && estado.tetoHoje > 0) {
    // Estado de hoje veio do modo antigo (teto sorteado 15–30): vale a trava nova.
    if (estado.tetoHoje !== TETO_FIXO || estado.folgaHoje) { estado.tetoHoje = TETO_FIXO; estado.folgaHoje = false; salvar(); }
    return;
  }
  estado.dia = dia;
  estado.feitasHoje = 0;
  estado.tetoHoje = sortearInt(TETO_DIA);
  estado.folgaHoje = Math.random() * 100 < FOLGA_PCT;
  estado.proximaVisitaEm = 0;
  salvar();
  console.log('[CUPONS-ML-AUTO] Dia ' + dia + ': teto ' + estado.tetoHoje + (estado.folgaHoje ? ' (FOLGA — nada sera inserido)' : ''));
}

// ── BASE ─────────────────────────────────────────────────────────────────────
function ehMl(r) { return /mercado\s*livre/i.test(String(r && r.loja || '')); }
function inseriveis() {
  return (dep.listarCuponsBase() || []).filter(r => ehMl(r) && r.codigo && r.ativo !== false
    && RE_CODIGO.test(String(r.codigo)) && r.confirmadoNoMl !== true);
}
function porValidade(a, b) { return (Date.parse(a.validadeAte) || Infinity) - (Date.parse(b.validadeAte) || Infinity); }
function naFila() { return inseriveis().filter(r => r.insercaoMl === FILA).sort(porValidade); }
function emVisita() { return inseriveis().filter(r => r.insercaoMl === VISITA); }
function elegiveis(agora = Date.now()) {
  return naFila().filter(r => (estado.liberaEm[r.chave] || 0) <= agora);
}
/** Confirmados na conta, ativos, ausentes da ultima leitura e nao reverificados hoje. */
function paraReverificar(agora = Date.now()) {
  const base = dep.listarCuponsBase() || [];
  const out = [];
  for (const chave of Object.keys(estado.reverificar || {})) {
    const r = base.find(x => x.chave === chave);
    if (!r || !ehMl(r) || !r.codigo || r.ativo === false || r.confirmadoNoMl !== true
        || !RE_CODIGO.test(String(r.codigo))) { delete estado.reverificar[chave]; continue; }
    if (agora - (estado.reverificadoEm[chave] || 0) < REVERIF_INTERVALO_MS) continue;
    out.push(r);
  }
  // Quem esta ha mais tempo sem prova vai primeiro.
  return out.sort((a, b) => (estado.reverificadoEm[a.chave] || 0) - (estado.reverificadoEm[b.chave] || 0));
}
function marcar(reg, campos) {
  try { return dep.atualizarCupomBase(reg.chave, campos); }
  catch (e) { console.warn('[CUPONS-ML-AUTO] Falha ao atualizar ' + reg.codigo + ':', e.message); return null; }
}
/** Tira tudo da fila (e de visita) e devolve ao /inserir, que avisa o operador. */
function devolverFilaAoManual() {
  const itens = [...naFila(), ...emVisita()];
  for (const r of itens) marcar(r, { insercaoMl: MANUAL });
  estado.visita = null;
  if (itens.length) { try { dep.avisarManual(); } catch (e) {} }
  return itens.length;
}
/** Cupom novo na fila: marca a entrada e sorteia o atraso ate ficar elegivel. */
function agendarLiberacao(chave, { ja = false } = {}) {
  const agora = Date.now();
  if (!estado.entrouEm[chave]) estado.entrouEm[chave] = agora;
  if (!estado.liberaEm[chave]) estado.liberaEm[chave] = ja ? agora : agora + Math.round(AGRUPAR_MIN * 60000);
}
/** Ultima atividade da visita (entrega ou resultado): a expiracao conta daqui. */
function visitaParada(agora = Date.now()) {
  return !!estado.visita && agora - (estado.visita.ativoEm || estado.visita.iniciadaEm) > VISITA_EXPIRA_MS;
}
/**
 * Cupom marcado "em visita" sem visita ativa que o contenha (redeploy no meio
 * da visita com a base ainda chegando do GitHub, 28/09/2026): volta para a
 * fila, liberado na hora. Sem isto ele ficava invisivel para sempre.
 */
function resgatarOrfaos() {
  const ativas = new Set(estado.visita ? estado.visita.chaves : []);
  let n = 0;
  for (const r of emVisita()) {
    if (ativas.has(r.chave)) continue;
    if (marcar(r, { insercaoMl: FILA })) { estado.liberaEm[r.chave] = Date.now(); if (!estado.entrouEm[r.chave]) estado.entrouEm[r.chave] = Date.now(); n++; }
  }
  if (n) console.log('[CUPONS-ML-AUTO] ' + n + ' cupom(ns) presos "em visita" voltaram para a fila.');
  return n;
}
/** Limpa os mapas de cupons que ja sairam da fila. */
function podarLiberaEm() {
  const vivas = new Set(naFila().map(r => r.chave));
  for (const k of Object.keys(estado.liberaEm)) if (!vivas.has(k)) delete estado.liberaEm[k];
  for (const k of Object.keys(estado.entrouEm)) if (!vivas.has(k)) delete estado.entrouEm[k];
}

function podeRodar() { return LIGADA && !estado.disjuntor; }
function tetoAtingido() { virarDia(); return estado.feitasHoje >= estado.tetoHoje; }

// ── RITMO ────────────────────────────────────────────────────────────────────
/** Proxima visita: pausa longa aleatoria; de manha a pausa e 50% maior. */
function sortearProximaVisita(agora = Date.now()) {
  const min = sortear(PAUSA_MIN);
  estado.proximaVisitaEm = agora + Math.round(min * 60000);
  salvar();
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
  const texto = (cabecalho || '🧩 Inserção pela extensão — visita concluída') + '\n\n'
    + linhas.join('\n') + '\n\nHoje: ' + estado.feitasHoje + '/' + estado.tetoHoje + ' · /autoinserir para ver o estado';
  try { await dep.avisarTelegram(texto); } catch (e) {}
}

async function abrirDisjuntor(motivo, codigo) {
  if (estado.disjuntor) return;
  estado.disjuntor = { em: new Date().toISOString(), motivo, codigo: codigo || null };
  salvar();
  const devolvidos = devolverFilaAoManual();
  salvar();
  console.error('[CUPONS-ML-AUTO] DISJUNTOR ABERTO: ' + motivo + (codigo ? ' (' + codigo + ')' : ''));
  const texto = '🛑 Inserção automática de cupons no ML DESLIGADA\n\n'
    + 'Motivo: ' + motivo + (codigo ? '\nCupom: ' + codigo : '') + '\n'
    + (devolvidos ? devolvidos + ' cupom(ns) voltaram para o /inserir.\n' : '')
    + '\nNada mais será inserido pela extensão até você religar no bot (/autoinserir). '
    + 'Se for bloqueio de conta, espere 24–48h antes de religar ou de inserir à mão.';
  await enviarResumo('🧩 Inserção pela extensão — o que saiu antes do desligamento');
  try { await dep.avisarTelegram(texto); } catch (e) {}
  try { await dep.avisarOperador(texto); } catch (e) {}
}

// ── VIGIA (a cada 5 min): dia, visita expirada, extensao ausente ─────────────
async function vigiar() {
  if (!podeRodar()) return;
  virarDia();
  const agora = Date.now();

  // Lote entregue e nunca concluido (Chrome fechou no meio): volta para a fila.
  if (visitaParada(agora)) {
    for (const r of emVisita()) marcar(r, { insercaoMl: FILA });
    console.warn('[CUPONS-ML-AUTO] Visita ' + estado.visita.id + ' parada ha mais de ' + (VISITA_EXPIRA_MS / 60000) + ' min; lote devolvido a fila.');
    estado.visita = null;
    sortearProximaVisita(agora);
  }

  // Extensao fora do ar com cupom esperando alem do limite: o operador insere
  // do celular. Um aviso por dia.
  const fila = naFila();
  if (fila.length && agora - (estado.ultimoContatoExt || 0) > EXTENSAO_AUSENTE_MS && dentroDaJanela(agora)) {
    const velhos = fila.filter(r => agora - (estado.entrouEm[r.chave] || agora) > ESPERA_MAX_MS);
    if (velhos.length) {
      for (const r of velhos) marcar(r, { insercaoMl: MANUAL });
      try { dep.avisarManual(); } catch (e) {}
      if (estado.ausenteAvisadaEm !== estado.dia) {
        estado.ausenteAvisadaEm = estado.dia;
        try {
          await dep.avisarTelegram('🧩 Extensão Captura Tica sem contato há ' + Math.round((agora - (estado.ultimoContatoExt || 0)) / 60000)
            + ' min — ' + velhos.length + ' cupom(ns) do ML foram para o /inserir. Abra o Chrome com a extensão para a fila voltar a andar.');
        } catch (e) {}
      }
    }
  }
  resgatarOrfaos();
  adotarPendentes();
  podarLiberaEm();
  salvar();
}

// ── API PARA A EXTENSAO ──────────────────────────────────────────────────────
/** Compara o token da extensao em tempo constante. */
export function tokenExtensaoMlOk(recebido) {
  const esperado = String(process.env.CUPONS_ML_EXTENSAO_TOKEN || '').trim();
  const dado = String(recebido || '').trim();
  if (!esperado || !dado) return false;
  const a = Buffer.from(esperado), b = Buffer.from(dado);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function extensaoMlConfigurada() { return !!String(process.env.CUPONS_ML_EXTENSAO_TOKEN || '').trim(); }

/**
 * A extensao pergunta "tem lote para mim?". Resposta:
 *   { ok, lote: [{chave, codigo}], visitaId, seletores, tempos, aguardar (ms), motivo }
 * lote vazio + aguardar = volte depois. Com espiar=true nao reserva nada (para a
 * notificacao "3 cupons na fila — inserir agora?" do modo com aprovacao).
 */
export function proximoLoteInsercaoMl({ espiar = false } = {}) {
  const agora = Date.now();
  estado.ultimoContatoExt = agora;
  // "agora" muda a cada resposta: o navegador nunca recebe 304 com um lote velho.
  const base = { ok: true, lote: [], visitaId: null, seletores: seletores(), tempos: TEMPOS, agora };
  if (!LIGADA) { salvar(); return { ...base, ok: false, motivo: 'desligada', aguardar: 30 * 60000 }; }
  if (estado.disjuntor) { salvar(); return { ...base, ok: false, motivo: 'disjuntor', disjuntor: estado.disjuntor, aguardar: 30 * 60000 }; }
  virarDia();

  if (estado.folgaHoje) {
    if (estado.folgaAvisadaEm !== estado.dia) {
      estado.folgaAvisadaEm = estado.dia;
      const n = devolverFilaAoManual();
      if (n) try { dep.avisarTelegram('🧩 Hoje é dia de folga da inserção automática — ' + n + ' cupom(ns) foram para o /inserir.'); } catch (e) {}
    }
    salvar();
    return { ...base, motivo: 'folga', aguardar: msAteJanela(agora) };
  }
  if (!dentroDaJanela(agora)) { salvar(); return { ...base, motivo: 'fora_da_janela', aguardar: msAteJanela(agora) + Math.round(Math.random() * 15 * 60000) }; }

  if (estado.visita) {
    if (!visitaParada(agora)) { salvar(); return { ...base, motivo: 'visita_em_andamento', visitaId: estado.visita.id, aguardar: 60000 }; }
    for (const r of emVisita()) marcar(r, { insercaoMl: FILA });
    estado.visita = null;
  }

  if (tetoAtingido()) {
    if (estado.tetoAvisadoEm !== estado.dia) {
      estado.tetoAvisadoEm = estado.dia;
      const n = devolverFilaAoManual();
      enviarResumo('🧩 Inserção pela extensão — teto do dia atingido (' + estado.tetoHoje + ')'
        + (n ? '. ' + n + ' cupom(ns) foram para o /inserir.' : '.')).catch(() => {});
    }
    salvar();
    return { ...base, motivo: 'teto', aguardar: msAteJanela(agora) };
  }
  if (estado.proximaVisitaEm && agora < estado.proximaVisitaEm) {
    salvar();
    return { ...base, motivo: 'pausa_entre_visitas', aguardar: estado.proximaVisitaEm - agora };
  }

  // A base de cupons chega do GitHub depois do boot: adotar so no boot deixava
  // a fila vazia. Adota aqui o que nunca passou por decisao (cupom novo, valido).
  resgatarOrfaos();
  adotarPendentes();
  const eleg = elegiveis(agora);
  if (!eleg.length) {
    const fila = naFila();
    const proxima = fila.length ? Math.min(...fila.map(r => estado.liberaEm[r.chave] || agora)) : 0;
    salvar();
    return { ...base, motivo: fila.length ? 'aguardando_atraso' : 'fila_vazia',
      aguardar: fila.length ? Math.max(60000, proxima - agora) : 5 * 60000 };
  }
  const vagas = Math.max(0, estado.tetoHoje - estado.feitasHoje);
  // Basta UM cupom vencer o agrupamento para a fila INTEIRA sair junto.
  const todos = naFila();
  const tamanho = Math.max(1, Math.min(LOTE_MAX, vagas, todos.length));
  const lote = todos.slice(0, tamanho);
  if (espiar) { salvar(); return { ...base, motivo: 'pronto', espiar: true, lote: lote.map(r => ({ chave: r.chave, codigo: String(r.codigo).trim().toUpperCase() })) }; }

  // Carona: cupons ja confirmados que sumiram de "Meus cupons" vao no fim do
  // lote para o ML dizer se ainda valem (cabem nas vagas da trava do dia).
  const sobra = Math.max(0, vagas - lote.length);
  const rever = paraReverificar(agora).slice(0, Math.min(REVERIF_POR_VISITA, sobra));
  const id = randomBytes(6).toString('hex');
  const chaves = [];
  for (const r of lote) if (marcar(r, { insercaoMl: VISITA })) chaves.push(r.chave);
  const reverificar = rever.map(r => r.chave);
  estado.visita = { id, chaves, reverificar, iniciadaEm: agora, ativoEm: agora };
  salvar();
  console.log('[CUPONS-ML-AUTO] Visita ' + id + ' entregue a extensao: ' + lote.map(r => r.codigo).join(', ')
    + (rever.length ? ' | reverificar: ' + rever.map(r => r.codigo).join(', ') : ''));
  const item = r => ({ chave: r.chave, codigo: String(r.codigo).trim().toUpperCase() });
  return { ...base, motivo: 'pronto', visitaId: id,
    lote: [...lote.filter(r => chaves.includes(r.chave)).map(item), ...rever.map(item)] };
}

/**
 * Resultado de UM cupom da visita. veredito:
 *   inserido | ja_tinha | esgotado | vencido | inexistente | problema
 *   | sem_login | pagina_mudou | erro
 * rc/status/mensagem sao o que a extensao conseguiu ler da resposta do ML.
 */
export async function registrarResultadoInsercaoMl({ visitaId, chave, veredito, rc, status, mensagem, venceuEm } = {}) {
  estado.ultimoContatoExt = Date.now();
  if (!estado.visita || estado.visita.id !== visitaId) { salvar(); return { ok: false, erro: 'visita desconhecida ou expirada' }; }
  if (!VEREDITOS.has(veredito)) { salvar(); return { ok: false, erro: 'veredito inválido' }; }
  const reg = (dep.listarCuponsBase() || []).find(r => r.chave === chave);
  if (reg && (estado.visita.reverificar || []).includes(chave)) return registrarReverificacao(reg, { veredito, rc, status, mensagem, venceuEm });
  if (!reg || !estado.visita.chaves.includes(chave)) { salvar(); return { ok: false, erro: 'cupom não pertence a esta visita' }; }
  estado.visita.ativoEm = Date.now();
  const codigo = String(reg.codigo || '').toUpperCase();
  const msg = String(mensagem || '').slice(0, 160);
  const st = Number(status) || 0;
  // Recusa especifica do ML sobre o cupom, mesmo que a extensao a tenha lido
  // como "problema": nao e restricao da conta (403/"Tivemos um problema").
  if (veredito === 'problema' && st !== 403) {
    const lido = String(rc || '') + ' ' + msg;
    if (/\bINVALID_1\b/.test(lido)) veredito = 'inexistente';
    else if (RE_INDISPONIVEL.test(lido)) veredito = 'indisponivel';
  }

  // Falhas da extensao/pagina nao contam como tentativa no ML.
  if (veredito === 'erro') {
    estado.falhas++;
    marcar(reg, { insercaoMl: FILA });
    console.warn('[CUPONS-ML-AUTO] Erro da extensão em ' + codigo + ': ' + msg);
    salvar();
    if (estado.falhas >= FALHAS_MAX) await abrirDisjuntor(FALHAS_MAX + ' erros seguidos na extensão (' + msg + ')', codigo);
    return { ok: true };
  }
  if (veredito === 'sem_login') {
    marcar(reg, { insercaoMl: FILA });
    salvar();
    await abrirDisjuntor('a extensão encontrou o Mercado Livre deslogado — faça login no Chrome e religue', codigo);
    return { ok: true };
  }
  if (veredito === 'pagina_mudou') {
    // 29/09/2026: o disjuntor abriu com o botao "Inserir codigo" presente na
    // pagina (conferido no Chrome logado). Seletor ausente e um tropeco de
    // carregamento/aba em segundo plano, e nada chegou ao ML (acontece antes
    // do clique) — entao a 1a vez so devolve a fila; a extensao encerra a
    // visita e tenta na proxima. Duas visitas seguidas assim = mudou mesmo.
    // 01/10/2026: DESCONTOSMELI derrubou tudo com "campo sumiu durante a
    // digitacao" em visitas seguidas — o problema era aquele cupom, nao a
    // pagina. Serie so com o MESMO cupom: ele sai da fila (vai para o
    // /inserir) e a automacao segue. So desliga quando a falha se repete
    // em cupons DIFERENTES.
    estado.paginaMudouSeguidos = (estado.paginaMudouSeguidos || 0) + 1;
    estado.paginaMudouCodigos = [...(estado.paginaMudouCodigos || []), codigo].slice(-5);
    const distintos = new Set(estado.paginaMudouCodigos).size;
    if (estado.paginaMudouSeguidos >= PAGINA_MUDOU_MAX && distintos < 2) {
      marcar(reg, { insercaoMl: MANUAL, observacao: 'A extensão falhou na página só com este cupom (' + msg + ') — inserir à mão' });
      registrarDesfecho(reg, '✋ só este cupom trava a página — foi para o /inserir');
      salvar();
      try { dep.avisarManual(); } catch (e) {}
      console.warn('[CUPONS-ML-AUTO] Seletor ausente de novo só em ' + codigo + ' — cupom vai para o manual, automação segue');
      return { ok: true };
    }
    marcar(reg, { insercaoMl: FILA });
    salvar();
    if (estado.paginaMudouSeguidos < PAGINA_MUDOU_MAX) {
      console.warn('[CUPONS-ML-AUTO] Seletor ausente em ' + codigo + ' (' + msg + ') — tropeço ' + estado.paginaMudouSeguidos + '/' + PAGINA_MUDOU_MAX + ', tenta na próxima visita');
      return { ok: true };
    }
    await abrirDisjuntor('a página de cupons do ML mudou (seletor não encontrado: ' + msg + ')', codigo);
    return { ok: true };
  }

  estado.feitasHoje++;
  estado.falhas = 0;
  estado.paginaMudouSeguidos = 0;
  estado.paginaMudouCodigos = [];

  if (veredito === 'inserido' || veredito === 'ja_tinha') {
    estado.canalOkEm = Date.now(); estado.invalidosSeguidos = 0; estado.problemasSeguidos = 0;
    marcar(reg, { confirmadoNoMl: true, insercaoMl: 'inserido_auto' });
    registrarDesfecho(reg, veredito === 'ja_tinha' ? '☑️ já estava' : '✅ inserido');
  } else if (veredito === 'esgotado' || veredito === 'vencido') {
    estado.canalOkEm = Date.now(); estado.invalidosSeguidos = 0; estado.problemasSeguidos = 0;
    const campos = { ativo: false, insercaoMl: 'recusado', observacao: 'Recusado na inserção pela extensão: ' + (msg || rc || veredito) };
    let quando = venceuEm && !isNaN(Date.parse(venceuEm)) ? new Date(venceuEm).toISOString() : null;
    if (!quando && veredito === 'vencido' && dep.validadeDeVencimento) { try { quando = dep.validadeDeVencimento(msg); } catch (e) {} }
    if (quando) campos.validadeAte = quando;
    marcar(reg, campos);
    registrarDesfecho(reg, veredito === 'esgotado' ? '🗑 esgotado' : '🗑 vencido');
  } else if (veredito === 'indisponivel') {
    // O ML reconheceu o codigo e respondeu sobre ele: canal vivo. O cupom nao
    // entra nesta conta, mas pode valer para quem recebe a oferta — entao NAO
    // e desativado; so sai da fila e nao volta para o /inserir.
    estado.canalOkEm = Date.now(); estado.invalidosSeguidos = 0; estado.problemasSeguidos = 0;
    marcar(reg, { insercaoMl: INDISPONIVEL, observacao: 'Indisponível para a conta TSP segundo o ML: ' + (msg || rc || 'sem mensagem') });
    registrarDesfecho(reg, '🚫 indisponível p/ a conta');
  } else if (veredito === 'inexistente') {
    estado.problemasSeguidos = 0;
    estado.invalidosSeguidos++;
    if (estado.invalidosSeguidos >= INVALIDOS_SEGUIDOS_MAX) {
      marcar(reg, { insercaoMl: CONFERIR });
      salvar();
      await abrirDisjuntor(INVALIDOS_SEGUIDOS_MAX + ' códigos seguidos recusados como inexistentes — o ML pode estar respondendo "inválido" para tudo', codigo);
      return { ok: true };
    }
    if (Date.now() - (estado.canalOkEm || 0) < CANAL_OK_VALIDADE_MS) {
      marcar(reg, { ativo: false, insercaoMl: 'recusado', observacao: 'Código inexistente segundo o ML (inserção pela extensão)' });
      registrarDesfecho(reg, '🗑 inexistente');
    } else {
      // Sem prova recente de que o canal responde de verdade, "invalido" nao
      // basta para desativar: o operador confere no celular.
      marcar(reg, { insercaoMl: CONFERIR });
      registrarDesfecho(reg, '👀 conferir à mão');
      try { dep.avisarManual(); } catch (e) {}
    }
  } else if (veredito === 'problema') {
    // "Tivemos um problema" foi o sintoma da restricao de set/2026 (403 com
    // HTML no input-code). Com status 403 lido da rede, nem espera repetir.
    marcar(reg, { insercaoMl: FILA });
    estado.problemasSeguidos++;
    salvar();
    if (st === 403 || estado.problemasSeguidos >= PROBLEMAS_MAX) {
      await abrirDisjuntor('o ML respondeu com erro genérico' + (st ? ' (HTTP ' + st + ')' : '') + (msg ? ' — ' + msg : '') + ' — cheira a restrição da conta', codigo);
      return { ok: true };
    }
    registrarDesfecho(reg, '⚠️ problema (fica na fila)');
  }
  salvar();
  return { ok: true };
}

/**
 * Resposta do ML para um cupom JA CONFIRMADO que sumiu de "Meus cupons".
 * Mesmos contadores de seguranca da insercao (disjuntor), mas o cupom nunca
 * entra na fila nem vai para o /inserir: ou o ML prova que vale, ou que acabou,
 * ou fica como esta e tenta de novo amanha.
 */
async function registrarReverificacao(reg, { veredito, rc, status, mensagem, venceuEm }) {
  estado.visita.ativoEm = Date.now();
  estado.visita.reverificar = (estado.visita.reverificar || []).filter(k => k !== reg.chave);
  const codigo = String(reg.codigo || '').toUpperCase();
  const msg = String(mensagem || '').slice(0, 160);
  const st = Number(status) || 0;
  if (veredito === 'problema' && st !== 403) {
    const lido = String(rc || '') + ' ' + msg;
    if (/\bINVALID_1\b/.test(lido)) veredito = 'inexistente';
    else if (RE_INDISPONIVEL.test(lido)) veredito = 'indisponivel';
  }
  const tentar = () => { estado.reverificadoEm[reg.chave] = Date.now(); };

  if (veredito === 'erro') {
    estado.falhas++; salvar();
    if (estado.falhas >= FALHAS_MAX) await abrirDisjuntor(FALHAS_MAX + ' erros seguidos na extensão (' + msg + ')', codigo);
    return { ok: true };
  }
  if (veredito === 'sem_login') {
    salvar();
    await abrirDisjuntor('a extensão encontrou o Mercado Livre deslogado — faça login no Chrome e religue', codigo);
    return { ok: true };
  }
  if (veredito === 'pagina_mudou') {
    // Mesmo cupom travando a pagina: so ele sai da reverificacao do dia.
    estado.paginaMudouSeguidos = (estado.paginaMudouSeguidos || 0) + 1;
    estado.paginaMudouCodigos = [...(estado.paginaMudouCodigos || []), codigo].slice(-5);
    tentar(); salvar();
    if (estado.paginaMudouSeguidos >= PAGINA_MUDOU_MAX && new Set(estado.paginaMudouCodigos).size >= 2) {
      await abrirDisjuntor('a página de cupons do ML mudou (seletor não encontrado: ' + msg + ')', codigo);
    }
    return { ok: true };
  }

  estado.feitasHoje++;
  estado.falhas = 0;
  estado.paginaMudouSeguidos = 0;
  estado.paginaMudouCodigos = [];
  tentar();

  if (veredito === 'inserido' || veredito === 'ja_tinha') {
    estado.canalOkEm = Date.now(); estado.invalidosSeguidos = 0; estado.problemasSeguidos = 0;
    // Vale AGORA: validade vencida na base nao pode derruba-lo na proxima hora.
    const campos = { ativo: true, confirmadoNoMl: true };
    if (!(Date.parse(reg.validadeAte || '') > Date.now()) && dep.validadeDeTexto) {
      try { const v = dep.validadeDeTexto('amanha'); if (v) campos.validadeAte = v; } catch (e) {}
    }
    marcar(reg, campos);
    delete estado.reverificar[reg.chave];
    registrarDesfecho(reg, veredito === 'ja_tinha' ? '🔎 segue na conta' : '🔎 voltou para a conta');
  } else if (veredito === 'esgotado' || veredito === 'vencido') {
    estado.canalOkEm = Date.now(); estado.invalidosSeguidos = 0; estado.problemasSeguidos = 0;
    const campos = { ativo: false, insercaoMl: 'recusado', observacao: 'Reverificado pela extensão: ' + (msg || rc || veredito) };
    let quando = venceuEm && !isNaN(Date.parse(venceuEm)) ? new Date(venceuEm).toISOString() : null;
    if (!quando && veredito === 'vencido' && dep.validadeDeVencimento) { try { quando = dep.validadeDeVencimento(msg); } catch (e) {} }
    if (quando) campos.validadeAte = quando;
    marcar(reg, campos);
    delete estado.reverificar[reg.chave];
    registrarDesfecho(reg, veredito === 'esgotado' ? '🔎🗑 esgotou' : '🔎🗑 venceu');
  } else if (veredito === 'indisponivel') {
    estado.canalOkEm = Date.now(); estado.invalidosSeguidos = 0; estado.problemasSeguidos = 0;
    marcar(reg, { observacao: 'Indisponível para a conta TSP segundo o ML: ' + (msg || rc || 'sem mensagem') });
    delete estado.reverificar[reg.chave];
    registrarDesfecho(reg, '🔎🚫 indisponível p/ a conta');
  } else if (veredito === 'inexistente') {
    estado.problemasSeguidos = 0;
    estado.invalidosSeguidos++;
    if (estado.invalidosSeguidos >= INVALIDOS_SEGUIDOS_MAX) {
      salvar();
      await abrirDisjuntor(INVALIDOS_SEGUIDOS_MAX + ' códigos seguidos recusados como inexistentes — o ML pode estar respondendo "inválido" para tudo', codigo);
      return { ok: true };
    }
    if (Date.now() - (estado.canalOkEm || 0) < CANAL_OK_VALIDADE_MS) {
      marcar(reg, { ativo: false, insercaoMl: 'recusado', observacao: 'Código inexistente segundo o ML (reverificação pela extensão)' });
      delete estado.reverificar[reg.chave];
      registrarDesfecho(reg, '🔎🗑 não existe mais');
    }
    // Sem prova recente de canal vivo: fica como esta e tenta amanha.
  } else if (veredito === 'problema') {
    estado.problemasSeguidos++;
    salvar();
    if (st === 403 || estado.problemasSeguidos >= PROBLEMAS_MAX) {
      await abrirDisjuntor('o ML respondeu com erro genérico' + (st ? ' (HTTP ' + st + ')' : '') + (msg ? ' — ' + msg : '') + ' — cheira a restrição da conta', codigo);
      return { ok: true };
    }
  }
  salvar();
  return { ok: true };
}

/**
 * Leitura de "Meus cupons" aplicada (server.js): os confirmados que a pagina nao
 * mostrou viram candidatos a reverificacao; os que apareceram saem da lista.
 */
export function marcarAusentesLeituraMl(ausentes = []) {
  const agora = Date.now();
  const novo = {};
  for (const a of ausentes) {
    if (!a || !a.chave || a.confirmado !== true) continue;
    novo[a.chave] = (estado.reverificar && estado.reverificar[a.chave]) || agora;
  }
  estado.reverificar = novo;
  const vivas = new Set(Object.keys(novo));
  for (const k of Object.keys(estado.reverificadoEm || {})) {
    if (!vivas.has(k) && agora - estado.reverificadoEm[k] > 7 * REVERIF_INTERVALO_MS) delete estado.reverificadoEm[k];
  }
  salvar();
  return Object.keys(novo).length;
}

/** Fim da visita: o que sobrou volta para a fila; sorteia a proxima. */
export async function finalizarVisitaInsercaoMl({ visitaId, motivo } = {}) {
  estado.ultimoContatoExt = Date.now();
  if (!estado.visita || estado.visita.id !== visitaId) { salvar(); return { ok: false, erro: 'visita desconhecida ou expirada' }; }
  const sobras = emVisita();
  for (const r of sobras) marcar(r, { insercaoMl: FILA });
  estado.visita = null;
  estado.ultimaVisitaEm = Date.now();
  sortearProximaVisita();
  console.log('[CUPONS-ML-AUTO] Visita ' + visitaId + ' encerrada' + (motivo ? ' (' + motivo + ')' : '') + (sobras.length ? '; ' + sobras.length + ' voltaram a fila' : '') + '. Proxima ~' + hhmm(estado.proximaVisitaEm));
  if (!estado.disjuntor) await enviarResumo();
  return { ok: true, proximaEm: estado.proximaVisitaEm };
}

// ── API DO MODULO ────────────────────────────────────────────────────────────
export function insercaoMlAutoLigada() { return LIGADA; }

/**
 * Tenta colocar um cupom recem-capturado na fila. Devolve false quando nao da
 * (desligada, disjuntor aberto, folga, teto do dia) — o chamador segue com a
 * insercao manual (/inserir). O cupom so fica elegivel depois do atraso.
 */
export function enfileirarInsercaoMl(reg) {
  if (!dep || !podeRodar() || !reg || !reg.chave) return false;
  if (!ehMl(reg) || !reg.codigo || !RE_CODIGO.test(String(reg.codigo))) return false;
  if (reg.confirmadoNoMl === true) return true;
  virarDia();
  if (estado.folgaHoje || tetoAtingido()) return false;
  if (reg.insercaoMl && reg.insercaoMl !== FILA) return false;   // ja decidido ou devolvido ao operador
  if (!marcar(reg, { insercaoMl: FILA })) return false;
  agendarLiberacao(reg.chave);
  salvar();
  return true;
}

/**
 * Coloca na fila o que ja esta esperando no /inserir. No boot so adota o que
 * nunca passou por decisao nenhuma; ao religar, adota tambem o que o teto, a
 * folga ou o disjuntor devolveram. CONFERIR nunca e adotado.
 */
function adotarPendentes({ incluirDevolvidos = false, ja = false } = {}) {
  if (!podeRodar()) return 0;
  virarDia();
  if (estado.folgaHoje) return 0;
  let n = 0;
  const vagas = Math.max(0, estado.tetoHoje - estado.feitasHoje - naFila().length);
  const adotavel = x => !x.insercaoMl || (incluirDevolvidos && x.insercaoMl === MANUAL);
  const candidatos = inseriveis().filter(adotavel).sort(porValidade);
  for (const r of candidatos.slice(0, vagas)) {
    if (marcar(r, { insercaoMl: FILA })) { agendarLiberacao(r.chave, { ja }); n++; }
  }
  salvar();
  return n;
}

export function estadoInsercaoMlAuto() {
  if (LIGADA) virarDia();
  const agora = Date.now();
  const contato = estado.ultimoContatoExt || 0;
  return {
    ligada: LIGADA,
    extensaoConfigurada: extensaoMlConfigurada(),
    disjuntor: estado.disjuntor,
    feitasHoje: estado.feitasHoje,
    tetoDia: estado.tetoHoje,
    tetoFaixa: TETO_DIA,
    folgaHoje: !!estado.folgaHoje,
    janela: [JANELA_INI, JANELA_FIM],
    dentroDaJanela: dentroDaJanela(agora),
    lote: LOTE, pausaMin: PAUSA_MIN, agruparMin: AGRUPAR_MIN,
    naFila: dep ? naFila().map(r => r.codigo) : [],
    emVisita: dep ? emVisita().map(r => r.codigo) : [],
    aReverificar: Object.keys(estado.reverificar || {}).length,
    visita: estado.visita,
    proximaEm: estado.proximaVisitaEm || null,
    proximaHora: hhmm(estado.proximaVisitaEm),
    ultimaHora: hhmm(estado.ultimaVisitaEm),
    extensaoUltimoContato: contato || null,
    extensaoContatoMin: contato ? Math.round((agora - contato) / 60000) : null,
    extensaoPresente: !!contato && agora - contato <= EXTENSAO_AUSENTE_MS,
    ultimos: estado.ultimos,
  };
}

export async function religarInsercaoMlAuto() {
  if (!LIGADA) return { ok: false, erro: 'CUPONS_ML_INSERCAO_AUTO não está ligado no Railway' };
  estado.disjuntor = null; estado.falhas = 0; estado.invalidosSeguidos = 0; estado.problemasSeguidos = 0; estado.paginaMudouSeguidos = 0; estado.paginaMudouCodigos = [];
  estado.folgaHoje = false;   // religar a mao vale mais que o sorteio
  estado.proximaVisitaEm = 0;
  salvar();
  // Religar a mao = inserir ja: o que estava no /inserir sai na proxima consulta.
  for (const r of naFila()) estado.liberaEm[r.chave] = Math.min(estado.liberaEm[r.chave] || Infinity, Date.now());
  const adotados = adotarPendentes({ incluirDevolvidos: true, ja: true });
  console.log('[CUPONS-ML-AUTO] Religada pelo operador; ' + adotados + ' cupom(ns) adotados do /inserir.');
  return { ok: true, adotados };
}

export async function pausarInsercaoMlAuto(motivo = 'pausada pelo operador') {
  if (estado.disjuntor) return { ok: true };
  estado.disjuntor = { em: new Date().toISOString(), motivo, codigo: null };
  const devolvidos = devolverFilaAoManual();
  salvar();
  await enviarResumo();
  return { ok: true, devolvidos };
}

/**
 * deps: { listarCuponsBase, atualizarCupomBase, avisarManual, validadeDeVencimento(txt), validadeDeTexto(txt),
 *         avisarTelegram(texto), avisarOperador(texto), sessaoDir }
 */
export function iniciarInsercaoMlAuto(deps) {
  dep = deps;
  if (deps.sessaoDir) ESTADO_PATH = deps.sessaoDir.replace(/\/$/, '') + '/insercao_ml_auto.json';
  carregar();
  if (!LIGADA) {
    // Desligada: nada pode ficar preso em fila/visita, invisivel no /inserir.
    const n = devolverFilaAoManual();
    salvar();
    if (n) console.log('[CUPONS-ML-AUTO] Desligada — ' + n + ' cupom(ns) devolvidos ao /inserir.');
    return;
  }
  virarDia();
  // Disjuntor aberto por uma resposta que hoje e classificada como cupom
  // indisponivel (nao restricao da conta): fecha sozinho no boot.
  let reabertoNoBoot = false;
  if (estado.disjuntor && RE_INDISPONIVEL.test(String(estado.disjuntor.motivo || ''))) {
    console.log('[CUPONS-ML-AUTO] Disjuntor de ' + estado.disjuntor.em + ' fechado no boot: o motivo (' + String(estado.disjuntor.motivo).slice(0, 120)
      + ') e recusa do ML sobre o cupom, nao restricao da conta.');
    estado.disjuntor = null; estado.falhas = 0; estado.invalidosSeguidos = 0; estado.problemasSeguidos = 0; estado.paginaMudouSeguidos = 0; estado.paginaMudouCodigos = [];
    estado.proximaVisitaEm = 0;
    reabertoNoBoot = true;
    salvar();
  }
  if (!extensaoMlConfigurada()) console.warn('[CUPONS-ML-AUTO] CUPONS_ML_EXTENSAO_TOKEN vazio — a extensão não vai conseguir buscar lotes.');
  if (estado.disjuntor) {
    const n = devolverFilaAoManual();
    salvar();
    console.warn('[CUPONS-ML-AUTO] Disjuntor aberto desde ' + estado.disjuntor.em + ' (' + estado.disjuntor.motivo
      + ') — nada sera inserido ate religar no bot.' + (n ? ' ' + n + ' devolvido(s) ao /inserir.' : ''));
  } else {
    // Redeploy no meio de uma visita: o lote volta para a fila.
    if (estado.visita) { for (const r of emVisita()) marcar(r, { insercaoMl: FILA }); estado.visita = null; }
    const adotados = adotarPendentes(reabertoNoBoot ? { incluirDevolvidos: true, ja: true } : undefined);
    console.log('[CUPONS-ML-AUTO] Ligada (extensão, modo enxuto): agrupa ' + AGRUPAR_MIN + ' min e insere a fila inteira; trava ' + TETO_FIXO
      + '/dia, janela ' + JANELA_INI + 'h–' + JANELA_FIM + 'h. Hoje: ' + estado.feitasHoje + '. Adotados: ' + adotados + '.');
  }
  if (_vigia) clearInterval(_vigia);
  _vigia = setInterval(() => vigiar().catch(e => console.error('[CUPONS-ML-AUTO] Erro no vigia:', e.message)), 5 * 60000);
  _vigia.unref?.();
}
