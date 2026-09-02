// ── AGENDA DE WORKFLOWS DO GITHUB ACTIONS ────────────────────────────────────
// PROBLEMA QUE ESTE MODULO RESOLVE
// O cron do GitHub Actions e best-effort: em conta com volume alto de runs ele
// atrasa horas e PULA disparos. Medido no painel-cdv: ate 25/08 o
// coletar-historico.yml rodava as 15 vezes por dia previstas (06h-20h SP); de
// 26/08 em diante caiu para 2 a 5 por dia, em horarios aleatorios — inclusive
// 22h, 00h e 01h SP, fora de qualquer janela do cron. O resumo diario, que deve
// sair 18h SP, saiu 02h10. Nao ha ajuste de cron que corrija isso: a fila
// atrasada e do GitHub, nao do arquivo .yml.
//
// COMO RESOLVE
// O baileys-server ja roda 24/7 no Railway. Este modulo usa esse processo como
// relogio: no minuto certo (fuso de SP) ele chama a API de workflow_dispatch,
// que entra na fila de EXECUCAO — a mesma do "Run workflow" manual, que sai em
// segundos — e nao na fila de AGENDAMENTO, que e a degradada.
//
// O cron no .yml continua existindo como rede de segurança para o caso de o
// Railway estar fora do ar. Por isso todo disparo checa antes se o workflow ja
// rodou ha pouco (jaRodouMin): sem essa checagem, cron atrasado + disparo daqui
// virariam duas coletas na mesma janela.
//
// NAO usa dependencia nova: fetch nativo do Node 20 e o mesmo GITHUB_TOKEN que
// o sync-github.js ja consome (precisa de permissao Actions: read and write no
// repositorio alvo — sem ela a API responde 403 e o alerta critico avisa).

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';

const TZ_SP = 'America/Sao_Paulo';
const SESSAO_DIR = './sessao';
const ESTADO_PATH = SESSAO_DIR + '/agenda_actions.json';
const HISTORICO_MAX = 60;

// Espelha os crons que existem hoje nos .yml do painel-cdv. Mudar horario aqui
// NAO muda o .yml: o cron de la e so fallback, e os dois podem divergir sem
// quebrar nada (jaRodouMin absorve a diferenca).
//   horas   — horas cheias no fuso de SP em que o job deve rodar
//   minuto  — minuto do disparo dentro da hora
//   dias    — dias da semana (0=domingo). null = todos
//   jaRodouMin — se o workflow ja teve run criado nos ultimos N minutos, pula
const JOBS = [
  {
    id: 'coletar-historico',
    repo: 'davileles/painel-cdv',
    workflow: 'coletar-historico.yml',
    ref: 'main',
    horas: [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
    minuto: 2,
    dias: null,
    jaRodouMin: 40,
    descricao: 'Pontuacoes Comparemania + cashback Inter/Meliuz/TopCashback',
  },
  {
    id: 'radar-ofertas',
    repo: 'davileles/painel-cdv',
    workflow: 'radar-ofertas.yml',
    ref: 'main',
    horas: [0, 3, 6, 9, 12, 15, 18, 21],
    minuto: 8,
    dias: null,
    jaRodouMin: 120,
    descricao: 'Radar de ofertas — coleta e reescrita com IA',
  },
  {
    // Mantido as 18h SP de proposito: e o horario do cron atual, e o
    // resumo-diario.js AGENDA o envio para as 20h a partir dai. Antecipar o
    // disparo mudaria o conteudo do resumo, nao so a hora do envio.
    id: 'resumo-diario',
    repo: 'davileles/painel-cdv',
    workflow: 'resumo-diario.yml',
    ref: 'main',
    horas: [18],
    minuto: 5,
    dias: [1, 2, 3, 4, 5],
    jaRodouMin: 180,
    descricao: 'Resumo diario de ofertas e emissoes (agenda o envio das 20h)',
  },
  {
    id: 'arquivar-passagens',
    repo: 'davileles/painel-cdv',
    workflow: 'arquivar-passagens.yml',
    ref: 'main',
    horas: [1],
    minuto: 10,
    dias: null,
    jaRodouMin: 180,
    descricao: 'Rotacao semestral de passagens (janela sem concorrencia)',
  },
];

// ── Estado ────────────────────────────────────────────────────────────────────
// Persistido porque redeploy no meio da hora nao pode reabrir um slot ja
// disparado — sem isso, cada deploy do baileys viraria uma coleta extra.
let _estado = { jobs: {}, historico: [] };

function carregarEstado() {
  try {
    if (existsSync(ESTADO_PATH)) {
      const bruto = JSON.parse(readFileSync(ESTADO_PATH, 'utf-8')) || {};
      _estado = {
        jobs: bruto.jobs && typeof bruto.jobs === 'object' ? bruto.jobs : {},
        historico: Array.isArray(bruto.historico) ? bruto.historico : [],
      };
    }
  } catch (e) {
    console.error('[AGENDA] Estado ilegivel, recomecando do zero:', e.message);
    _estado = { jobs: {}, historico: [] };
  }
}

function salvarEstado() {
  try {
    if (!existsSync(SESSAO_DIR)) mkdirSync(SESSAO_DIR, { recursive: true });
    const tmp = ESTADO_PATH + '.tmp';
    writeFileSync(tmp, JSON.stringify(_estado), 'utf-8');
    renameSync(tmp, ESTADO_PATH);
  } catch (e) { console.error('[AGENDA] Falha ao salvar estado:', e.message); }
}

// ── Relogio de SP ─────────────────────────────────────────────────────────────
function partesSP(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ_SP, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
  }).formatToParts(d);
  const g = t => p.find(x => x.type === t)?.value;
  const semana = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const hora = parseInt(g('hour'), 10);
  return {
    data: g('year') + '-' + g('month') + '-' + g('day'),
    // Intl com hour12:false devolve 24 para a meia-noite em alguns ICUs.
    hora: hora === 24 ? 0 : hora,
    minuto: parseInt(g('minute'), 10),
    diaSemana: semana[g('weekday')],
  };
}

function slotDe(agora, hora) {
  return agora.data + '-' + String(hora).padStart(2, '0');
}

// ── GitHub API ────────────────────────────────────────────────────────────────
function token() { return process.env.GITHUB_TOKEN || ''; }

function cabecalhos() {
  return {
    'Authorization': 'Bearer ' + token(),
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'baileys-server-agenda',
  };
}

// Guarda contra disparo duplo quando o cron do GitHub tambem acordar. Em caso
// de erro de rede retorna false DE PROPOSITO: perder uma coleta e pior do que
// rodar duas vezes (a coleta e idempotente — dedup por variacoes-notificadas).
async function houveRunRecente(job) {
  const minutos = Number(job.jaRodouMin) || 0;
  if (!minutos) return false;
  try {
    const url = 'https://api.github.com/repos/' + job.repo
      + '/actions/workflows/' + job.workflow + '/runs?per_page=10';
    const r = await fetch(url, { headers: cabecalhos() });
    if (!r.ok) return false;
    const j = await r.json();
    const limite = Date.now() - minutos * 60000;
    return (j.workflow_runs || []).some(x => {
      const t = Date.parse(x.created_at);
      return Number.isFinite(t) && t >= limite;
    });
  } catch (e) {
    console.warn('[AGENDA] Nao consegui checar runs de ' + job.id + ':', e.message);
    return false;
  }
}

async function dispararWorkflow(job) {
  const url = 'https://api.github.com/repos/' + job.repo
    + '/actions/workflows/' + job.workflow + '/dispatches';
  const r = await fetch(url, {
    method: 'POST',
    headers: { ...cabecalhos(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: job.ref || 'main' }),
  });
  if (r.status !== 204) {
    const corpo = await r.text().catch(() => '');
    throw new Error('HTTP ' + r.status + ' — ' + corpo.slice(0, 300));
  }
}

function registrarHistorico(entrada) {
  _estado.historico.unshift(entrada);
  if (_estado.historico.length > HISTORICO_MAX) _estado.historico.length = HISTORICO_MAX;
}

// ── Ciclo ─────────────────────────────────────────────────────────────────────
let _onAlerta = null;
let _rodando = false;

async function avisar(nivel, chave, titulo, corpo) {
  if (typeof _onAlerta !== 'function') return;
  try { await _onAlerta({ nivel, chave, origem: 'agenda-actions', titulo, corpo }); }
  catch (e) { console.error('[AGENDA] Falha ao registrar alerta:', e.message); }
}

/**
 * Dispara um job agora, ignorando slot e horario. Usado pelo endpoint manual e
 * pelo ciclo automatico (que ja fez a checagem de slot antes de chamar).
 */
export async function dispararAgora(idJob, { ignorarRunRecente = false } = {}) {
  const job = JOBS.find(j => j.id === idJob);
  if (!job) return { ok: false, erro: 'Job desconhecido: ' + idJob };
  if (!token()) return { ok: false, erro: 'GITHUB_TOKEN ausente no processo.' };

  if (!ignorarRunRecente && await houveRunRecente(job)) {
    return { ok: true, pulado: true, motivo: 'ja rodou nos ultimos ' + job.jaRodouMin + ' min' };
  }
  try {
    await dispararWorkflow(job);
    return { ok: true, pulado: false };
  } catch (e) {
    return { ok: false, erro: e.message };
  }
}

async function ciclo() {
  if (_rodando) return;
  _rodando = true;
  try {
    const agora = partesSP();
    for (const job of JOBS) {
      if (job.dias && !job.dias.includes(agora.diaSemana)) continue;
      if (!job.horas.includes(agora.hora)) continue;
      // Minuto alvo ja passou dentro desta hora? Dispara. O ">=" (e nao "===")
      // e o que recupera slot perdido por restart: container que sobe as 10h37
      // ainda executa o slot das 10h em vez de esperar as 11h.
      if (agora.minuto < job.minuto) continue;

      const slot = slotDe(agora, agora.hora);
      const st = _estado.jobs[job.id] || {};
      if (st.ultimoSlot === slot) continue;

      // Marca ANTES de disparar: se a chamada travar e o ciclo seguinte
      // reentrar, nao dispara duas vezes o mesmo slot.
      _estado.jobs[job.id] = { ...st, ultimoSlot: slot, ultimaTentativaEm: new Date().toISOString() };
      salvarEstado();

      const r = await dispararAgora(job.id);
      const em = new Date().toISOString();
      if (r.ok && r.pulado) {
        _estado.jobs[job.id] = { ..._estado.jobs[job.id], ultimoResultado: 'pulado', ultimoEm: em };
        registrarHistorico({ job: job.id, slot, em, resultado: 'pulado: ' + r.motivo });
        console.log('[AGENDA] ' + job.id + ' slot ' + slot + ' — pulado (' + r.motivo + ').');
      } else if (r.ok) {
        _estado.jobs[job.id] = { ..._estado.jobs[job.id], ultimoResultado: 'ok', ultimoEm: em, ultimoSucessoEm: em };
        registrarHistorico({ job: job.id, slot, em, resultado: 'disparado' });
        console.log('[AGENDA] ' + job.id + ' slot ' + slot + ' — disparado.');
      } else {
        _estado.jobs[job.id] = { ..._estado.jobs[job.id], ultimoResultado: 'erro', ultimoEm: em, ultimoErro: r.erro };
        registrarHistorico({ job: job.id, slot, em, resultado: 'erro: ' + r.erro });
        console.error('[AGENDA] ' + job.id + ' slot ' + slot + ' — FALHOU: ' + r.erro);
        // Critico: sem disparo daqui a coleta volta a depender do cron
        // degradado, que e exatamente o problema que este modulo existe para
        // resolver. Janela de 3h para nao encher o grupo de hora em hora.
        await avisar('critico', 'agenda:' + job.id,
          'Agenda Actions: falha ao disparar ' + job.id,
          'Nao consegui disparar o workflow ' + job.workflow + ' (' + job.repo + ').\n'
          + 'Erro: ' + r.erro + '\n\n'
          + 'Se for 403, o GITHUB_TOKEN do Railway precisa de "Actions: read and write" '
          + 'no repositorio. Ate resolver, a coleta so roda pelo cron do GitHub, que esta atrasando.');
      }
      salvarEstado();
    }
  } catch (e) {
    console.error('[AGENDA] Erro no ciclo:', e.message);
  } finally {
    _rodando = false;
  }
}

/** Retrato para o endpoint de diagnostico. */
export function estadoAgenda() {
  const agora = partesSP();
  return {
    ativa: agendaAtiva(),
    tokenPresente: !!token(),
    agoraSP: agora.data + ' ' + String(agora.hora).padStart(2, '0') + ':' + String(agora.minuto).padStart(2, '0'),
    jobs: JOBS.map(j => ({
      id: j.id,
      repo: j.repo,
      workflow: j.workflow,
      descricao: j.descricao,
      horas: j.horas,
      minuto: j.minuto,
      dias: j.dias,
      jaRodouMin: j.jaRodouMin,
      ...(_estado.jobs[j.id] || {}),
    })),
    historico: _estado.historico.slice(0, 30),
  };
}

export function agendaAtiva() {
  return process.env.AGENDA_ACTIONS !== '0' && !!token();
}

/**
 * Liga o relogio. `onAlerta` recebe o mesmo formato de registrarAlerta() do
 * server.js — passado por parametro para este modulo nao depender do server.
 */
export function iniciarAgendaActions({ onAlerta } = {}) {
  _onAlerta = onAlerta || null;
  carregarEstado();

  if (process.env.AGENDA_ACTIONS === '0') {
    console.log('[AGENDA] Desligada por AGENDA_ACTIONS=0 — workflows so pelo cron do GitHub.');
    return;
  }
  if (!token()) {
    console.log('[AGENDA] GITHUB_TOKEN ausente — workflows so pelo cron do GitHub.');
    return;
  }

  console.log('[AGENDA] Ligada — ' + JOBS.length + ' job(s): '
    + JOBS.map(j => j.id + ' (' + j.horas.length + 'x/dia)').join(', '));

  // Tick de 60s: a granularidade da agenda e o minuto, entao nao ha ganho em
  // olhar mais vezes. unref() para nao segurar o processo no encerramento.
  setInterval(() => { ciclo().catch(() => {}); }, 60 * 1000).unref?.();
  // Primeiro ciclo com folga: o boot ainda esta carregando sessao e configs, e
  // um disparo aqui nao tem pressa nenhuma.
  setTimeout(() => { ciclo().catch(() => {}); }, 30 * 1000).unref?.();
}
