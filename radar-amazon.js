// ═══════════════════════════════════════════════════════════════════════════
// radar-amazon.js — Radar de ofertas de marketplace para o Gestão TSP
//
// Fluxo: grupo-fonte (WhatsApp) -> link Amazon -> ASIN -> Creators API
//        -> link com o SEU partnerTag -> mensagem no formato da aba Oferta
//        -> filaPendentes com tipoConteudo 'oferta_amazon'
//
// A Creators API substituiu a PA-API 5.0 (descontinuada em 15/05/2026).
// Autenticacao: OAuth client_credentials via Login with Amazon.
// Brasil fica na regiao NA -> token endpoint api.amazon.com.
//
// Requisitos no Railway:
//   AMZ_CLIENT_ID      credencial da Creators API
//   AMZ_CLIENT_SECRET  segredo da Creators API
//   AMZ_PARTNER_TAG    ex: tudosobrepromos-20
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { comContextoTenant, tenantContexto } from './tenants.js';
import { agendarPush } from './sync-github.js';
import { rodapeOferta, rodapeCupom, credencialTsp } from './config-tsp.js';

const SESSAO_DIR      = './sessao';

// ═══════════ ESTADO POR OPERADOR (fase 2.2b) ═══════════
// Todo o estado deste modulo (radar_config, dedup, base de cupons, templates,
// vitrine, listas, token Amazon) vive num mapa por tenant. E() resolve o
// operador do contexto da requisicao (AsyncLocalStorage); fora de requisicao
// — pipelines, workers, boot — cai no tenant padrao, a operacao original.
// O padrao mantem o layout historico na raiz de ./sessao; os demais em
// ./sessao/tenants/<id>/, espelhado em tenants/<id>/ no repo de dados.
const TENANT_RAIZ = 'tsp';
const _estados = new Map();          // tenantId -> estado do modulo
let _moduloPronto = false;           // vira true na ultima linha do modulo

function novoEstado() {
  return {
    cfg: { ...CFG_PADRAO },
    vistos: {},            // asin -> { preco, ts }
    cupons: {},            // chave -> registro
    templates: {},
    vitrine: {},
    listas: {},
    token: { valor: null, expiraEm: 0 },
  };
}

function tenantAtual() { return tenantContexto() || TENANT_RAIZ; }
function E() { return estadoDe(tenantAtual()); }

function estadoDe(id) {
  if (!_estados.has(id)) {
    _estados.set(id, novoEstado());  // antes de hidratar: corta recursao
    // O tenant raiz e hidratado pelas chamadas top-level historicas deste
    // modulo (ordem preservada — evita TDZ das consts declaradas adiante).
    // Os demais so aparecem via requisicao, com o modulo ja pronto.
    if (id !== TENANT_RAIZ && _moduloPronto) hidratarTenant(id);
  }
  return _estados.get(id);
}

function hidratarTenant(id) {
  comContextoTenant(id, () => {
    carregarRadarConfig(); carregarVistos(); carregarCuponsBase();
    carregarTemplates(); carregarVitrine(); carregarListas();
  });
  console.log('[RADAR] Estado do operador "' + id + '" hidratado do disco.');
}

// Recarrega do disco os operadores ja em memoria (usado apos /sync/pull).
export function recarregarRadarTenants() {
  for (const id of _estados.keys()) {
    if (id !== TENANT_RAIZ) hidratarTenant(id);
  }
}

// Caminho local do arquivo do tenant atual (cria a pasta de tenants novos).
function cT(nome) {
  const t = tenantAtual();
  if (t === TENANT_RAIZ) return SESSAO_DIR + '/' + nome;
  const dir = SESSAO_DIR + '/tenants/' + t;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir + '/' + nome;
}
// Caminho relativo para o push (raiz ou tenants/<id>/).
function pT(nome) {
  const t = tenantAtual();
  return t === TENANT_RAIZ ? nome : 'tenants/' + t + '/' + nome;
}

const LINK_CONVITE_OFERTAS = 'https://chat.whatsapp.com/Ia5ZTqeTJdXHG5OT9LUwz8';

// ── CONFIG ────────────────────────────────────────────────────────────────

const CFG_PADRAO = {
  // jid -> 'fonte' | 'destino'. Gravado pela aba Grupos do painel.
  papeis: {},
  ativo: true,
  descontoMinimo: 5,      // % — abaixo disso descarta, salvo se for deal relampago
  dedupHoras: 24,
  // Vazio de proposito: resolvido no uso via credencialTsp — um tenant novo
  // NAO pode nascer com a partner tag da operacao original.
  partnerTag: '',
  gatilhoPadrao: '',      // texto opcional no topo da mensagem
  // Janela de publicacao dos cupons no auto-envio. Antes era o horario fixo da
  // fila CDV (8h-21h) no codigo; virou config porque cupom e oferta tem ritmos
  // diferentes e quem decide isso e o operador, nao o deploy.
  janelaCupom: { inicio: '08:00', fim: '21:00', dias: 'todos', intervaloSeg: 90 },
  // Turnos fixos de qual numero dispara o TSP. Vazio ou inativo = tudo pela
  // conta principal (comportamento historico). Fora de qualquer turno tambem
  // cai na principal: a mensagem nunca deixa de sair por causa da escala.
  turnosTsp: { ativo: false, turnos: [] },
};


export function carregarRadarConfig() {
  try {
    if (existsSync(cT('radar_config.json'))) {
      E().cfg = { ...CFG_PADRAO, ...JSON.parse(readFileSync(cT('radar_config.json'), 'utf-8')) };
      const f = radarFontes().length, d = radarDestinos().length;
      console.log(`[MKT] Config carregada — ${f} grupo(s) fonte, ${d} destino.`);
    } else {
      console.log('[MKT] Sem config em disco, usando padrao.');
    }
  } catch (e) {
    console.log('[MKT] Erro ao carregar config:', e.message);
  }
  return E().cfg;
}

export function radarConfig() { return E().cfg; }

export function salvarRadarConfig(novo = {}) {
  E().cfg = { ...E().cfg, ...novo };
  if (novo.papeis) E().cfg.papeis = novo.papeis;
  try {
    writeFileSync(cT('radar_config.json'), JSON.stringify(E().cfg, null, 2), 'utf-8');
    agendarPush(pT('radar_config.json'));
  } catch (e) {
    console.log('[MKT] Erro ao salvar config:', e.message);
  }
  return E().cfg;
}

export function radarFontes() {
  return Object.keys(E().cfg.papeis || {}).filter(j => E().cfg.papeis[j] === 'fonte');
}
export function radarDestinos() {
  return Object.keys(E().cfg.papeis || {}).filter(j => E().cfg.papeis[j] === 'destino');
}
export function ehFonteRadar(jid) {
  return E().cfg.ativo !== false && E().cfg.papeis?.[jid] === 'fonte';
}

// ── MONITORAMENTO POR GRUPO ───────────────────────────────────────────────
// Cada grupo-fonte precisa de um cadastro dizendo QUAIS lojas capturar e EM QUE
// janela. Sem cadastro o grupo nao captura nada — marcar como fonte passa a ser
// so metade da configuracao.
//
// A janela e restrita ao mesmo dia (inicio < fim); horarios e dia da semana sao
// avaliados no fuso de Sao Paulo, nao no do servidor.

export const LOJAS_MONITORAVEIS = ['Amazon', 'Shopee', 'Magazine Luiza', 'Mercado Livre'];
const TZ_SP = 'America/Sao_Paulo';

function minutosAgoraSP(d = new Date()) {
  const s = d.toLocaleString('en-GB', { timeZone: TZ_SP, hour12: false, hour: '2-digit', minute: '2-digit' });
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}

function diaSemanaSP(d = new Date()) {
  const s = d.toLocaleDateString('en-US', { timeZone: TZ_SP, weekday: 'short' });
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(s);
}

function paraMinutos(hhmm, padrao) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return padrao;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return padrao;
  return h * 60 + min;
}

// ── JANELA DE PUBLICACAO DOS CUPONS ───────────────────────────────────────
// Mesma mecanica da janela por grupo da aba Grupos, mas global: vale para todo
// cupom que o gate de auto-envio liberar.

export function janelaCupom() {
  return { ...CFG_PADRAO.janelaCupom, ...(E().cfg.janelaCupom || {}) };
}

export function salvarJanelaCupom(dados = {}) {
  const atual = janelaCupom();
  const nova = {
    inicio: dados.inicio !== undefined ? String(dados.inicio) : atual.inicio,
    fim:    dados.fim    !== undefined ? String(dados.fim)    : atual.fim,
    dias:   dados.dias === 'uteis' ? 'uteis' : (dados.dias === 'todos' ? 'todos' : atual.dias),
    intervaloSeg: dados.intervaloSeg !== undefined
      ? Math.max(0, Math.min(3600, Number(dados.intervaloSeg) || 0))
      : atual.intervaloSeg,
  };
  // Horario invalido cairia no padrao do paraMinutos e o operador nunca saberia
  // por que a janela nao mudou — melhor recusar na hora de gravar.
  if (paraMinutos(nova.inicio, null) === null) throw new Error('horario inicial invalido (use HH:MM)');
  if (paraMinutos(nova.fim, null) === null)    throw new Error('horario final invalido (use HH:MM)');
  salvarRadarConfig({ janelaCupom: nova });
  return nova;
}

/** { ok, motivo } — o motivo aparece no veredito do gate, no card da fila. */
export function dentroDaJanelaCupom(quando = new Date()) {
  const j = janelaCupom();
  if (j.dias === 'uteis') {
    const dia = diaSemanaSP(quando);
    if (dia === 0 || dia === 6) return { ok: false, motivo: 'fora da janela (so dias uteis)' };
  }
  const agora  = minutosAgoraSP(quando);
  const inicio = paraMinutos(j.inicio, 8 * 60);
  const fim    = paraMinutos(j.fim, 21 * 60);
  // Janela que vira a meia-noite (ex: 20:00-02:00) e um intervalo unico partido
  // em dois pedacos do dia, nao um erro de digitacao.
  const dentro = inicio <= fim
    ? (agora >= inicio && agora < fim)
    : (agora >= inicio || agora < fim);
  if (!dentro) return { ok: false, motivo: `fora da janela ${j.inicio}-${j.fim} SP` };
  return { ok: true, motivo: 'dentro da janela' };
}

// ── ESCALA DE NUMEROS DO TSP ──────────────────────────────────────────────
// Turnos fixos por faixa de horario. A rotacao existe para o padrao de disparo
// nao ficar concentrado num numero so; por isso alterna em blocos, e nao a cada
// mensagem — duas mensagens seguidas no mesmo grupo saindo de numeros
// diferentes chama mais atencao do que uma sequencia coerente.

export function turnosTsp() {
  const t = E().cfg.turnosTsp || {};
  return { ativo: !!t.ativo, turnos: Array.isArray(t.turnos) ? t.turnos : [] };
}

export function salvarTurnosTsp(dados = {}) {
  const atual = turnosTsp();
  const lista = (Array.isArray(dados.turnos) ? dados.turnos : atual.turnos).map(t => {
    if (paraMinutos(t.inicio, null) === null) throw new Error('turno com horario inicial invalido: ' + t.inicio);
    if (paraMinutos(t.fim, null) === null)    throw new Error('turno com horario final invalido: ' + t.fim);
    if (!t.conta) throw new Error('turno sem conta definida');
    return { inicio: String(t.inicio), fim: String(t.fim), conta: String(t.conta) };
  });
  const nova = { ativo: dados.ativo !== undefined ? !!dados.ativo : atual.ativo, turnos: lista };
  salvarRadarConfig({ turnosTsp: nova });
  return nova;
}

/** Qual conta dispara agora. Sempre devolve algo — 'principal' e o fallback. */
export function contaDoTurno(quando = new Date()) {
  const { ativo, turnos } = turnosTsp();
  if (!ativo || !turnos.length) return 'principal';
  const agora = minutosAgoraSP(quando);
  for (const t of turnos) {
    const ini = paraMinutos(t.inicio, 0);
    const fim = paraMinutos(t.fim, 24 * 60);
    // Turno que vira a meia-noite (22:00-06:00) e um bloco unico partido em dois.
    const dentro = ini <= fim ? (agora >= ini && agora < fim) : (agora >= ini || agora < fim);
    if (dentro) return t.conta;
  }
  return 'principal';
}

export function listarMonitor() { return E().cfg.monitor || {}; }

export function monitorDoGrupo(jid) { return (E().cfg.monitor || {})[jid] || null; }

// Um grupo pode ter VARIAS janelas de captura no mesmo dia (ex: 08:00-08:30,
// 11:00-11:30, 12:30-14:00). Serve para espalhar o volume de mensagens em vez
// de despejar tudo num bloco continuo, que faz gente sair do grupo.
// O par inicio/fim antigo continua aceito na entrada e sempre sai preenchido na
// saida (primeira janela), para nada que le o formato velho quebrar.
const HORA_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function normalizarJanelas(dados, anterior) {
  let brutas = null;
  if (Array.isArray(dados.janelas)) brutas = dados.janelas;
  else if (dados.inicio !== undefined || dados.fim !== undefined)
    brutas = [{ inicio: dados.inicio, fim: dados.fim }];
  else brutas = anterior.janelas
    || (anterior.inicio ? [{ inicio: anterior.inicio, fim: anterior.fim }] : null);

  const limpas = [];
  for (const j of (brutas || [])) {
    const ini = String(j?.inicio ?? '').trim();
    const fim = String(j?.fim ?? '').trim();
    if (!HORA_RE.test(ini) || !HORA_RE.test(fim)) continue;
    if (ini === fim) continue;                       // janela de duracao zero
    limpas.push({ inicio: ini, fim });
  }
  if (!limpas.length) limpas.push({ inicio: '00:00', fim: '23:59' });

  // Ordena e funde sobreposicoes: duas janelas encavaladas viram uma so, para o
  // painel nao mostrar faixa duplicada. Janela que vira a meia-noite fica fora
  // da fusao, porque nao e comparavel na mesma reta de minutos.
  const min = h => paraMinutos(h, 0);
  const viram = limpas.filter(j => min(j.inicio) > min(j.fim));
  const retas = limpas.filter(j => min(j.inicio) <= min(j.fim))
    .sort((a, b) => min(a.inicio) - min(b.inicio));
  const fundidas = [];
  for (const j of retas) {
    const ultima = fundidas[fundidas.length - 1];
    if (ultima && min(j.inicio) <= min(ultima.fim)) {
      if (min(j.fim) > min(ultima.fim)) ultima.fim = j.fim;
    } else fundidas.push({ ...j });
  }
  return [...fundidas, ...viram].slice(0, 12);
}

export function salvarMonitor(jid, dados = {}) {
  if (!jid) return null;
  if (!E().cfg.monitor) E().cfg.monitor = {};
  const anterior = E().cfg.monitor[jid] || {};

  const lojas = Array.isArray(dados.lojas)
    ? dados.lojas.filter(l => LOJAS_MONITORAVEIS.includes(l))
    : (anterior.lojas || []);

  const janelas = normalizarJanelas(dados, anterior);

  E().cfg.monitor[jid] = {
    jid,
    lojas,
    janelas,
    // Espelho da primeira janela: compatibilidade com leitores do formato antigo.
    inicio: janelas[0].inicio,
    fim:    janelas[0].fim,
    dias:   dados.dias === 'uteis' ? 'uteis' : (dados.dias === 'todos' ? 'todos' : (anterior.dias || 'todos')),
    ativo:  dados.ativo !== undefined ? !!dados.ativo : (anterior.ativo !== false),
    atualizadoEm: new Date().toISOString(),
  };
  salvarRadarConfig({ monitor: E().cfg.monitor });
  return E().cfg.monitor[jid];
}

// Cadastro salvo antes das multiplas janelas so tem inicio/fim: le como uma
// janela unica em vez de exigir migracao do arquivo.
export function janelasDoMonitor(cfg) {
  if (Array.isArray(cfg?.janelas) && cfg.janelas.length) return cfg.janelas;
  return [{ inicio: cfg?.inicio || '00:00', fim: cfg?.fim || '23:59' }];
}

export function removerMonitor(jid) {
  if (!E().cfg.monitor?.[jid]) return false;
  delete E().cfg.monitor[jid];
  salvarRadarConfig({ monitor: E().cfg.monitor });
  return true;
}

/**
 * Decide se um grupo pode capturar uma loja neste instante.
 * Devolve { ok, motivo } — o motivo alimenta o log, para um silencio no radar
 * sempre ter explicacao.
 */
export function podeCapturar(jid, loja, quando = new Date()) {
  const cfg = monitorDoGrupo(jid);
  if (!cfg)             return { ok: false, motivo: 'grupo sem cadastro de monitoramento' };
  if (cfg.ativo === false) return { ok: false, motivo: 'monitoramento desativado neste grupo' };
  if (!cfg.lojas?.length)  return { ok: false, motivo: 'nenhuma loja selecionada' };
  if (!cfg.lojas.includes(loja)) return { ok: false, motivo: loja + ' nao monitorada neste grupo' };

  const dia = diaSemanaSP(quando);
  if (cfg.dias === 'uteis' && (dia === 0 || dia === 6)) {
    return { ok: false, motivo: 'fora dos dias uteis' };
  }

  const agora   = minutosAgoraSP(quando);
  const janelas = janelasDoMonitor(cfg);
  for (const j of janelas) {
    const ini = paraMinutos(j.inicio, 0);
    const fim = paraMinutos(j.fim, 23 * 60 + 59);
    // Janela que vira a meia-noite (22:00-02:00) e um bloco unico partido em dois.
    const dentro = ini <= fim ? (agora >= ini && agora <= fim) : (agora >= ini || agora <= fim);
    if (dentro) return { ok: true, motivo: 'dentro da janela ' + j.inicio + '-' + j.fim };
  }
  const hhmm = String(Math.floor(agora / 60)).padStart(2, '0') + ':' + String(agora % 60).padStart(2, '0');
  return { ok: false, motivo: 'fora das janelas ' +
    janelas.map(j => j.inicio + '-' + j.fim).join(', ') + ' (agora ' + hhmm + ' SP)' };
}

/**
 * Garante cadastro para todo grupo marcado como fonte. Sem isto, ativar a regra
 * "sem cadastro nao captura" desligaria em silencio os grupos ja configurados.
 * O cadastro semeado e permissivo e fica visivel no painel para ajuste.
 */
export function semearMonitorDasFontes() {
  const fontes = radarFontes();
  let novos = 0;
  for (const jid of fontes) {
    if (monitorDoGrupo(jid)) continue;
    salvarMonitor(jid, { lojas: [...LOJAS_MONITORAVEIS], janelas: [{ inicio: '00:00', fim: '23:59' }], dias: 'todos', ativo: true });
    novos++;
  }
  if (novos) console.log('[MONITOR] ' + novos + ' grupo(s) fonte receberam cadastro inicial (todas as lojas, 24h).');
  return novos;
}

// ── DEDUPLICACAO ──────────────────────────────────────────────────────────
// Persiste em disco para nao repostar o mesmo ASIN depois de um restart.

function carregarVistos() {
  try {
    if (existsSync(cT('radar_vistos.json'))) E().vistos = JSON.parse(readFileSync(cT('radar_vistos.json'), 'utf-8'));
  } catch (e) { E().vistos = {}; }
}
function salvarVistos() {
  try {
    const limite = Date.now() - (E().cfg.dedupHoras || 24) * 3600e3;
    for (const k of Object.keys(E().vistos)) if (E().vistos[k].ts < limite) delete E().vistos[k];
    writeFileSync(cT('radar_vistos.json'), JSON.stringify(E().vistos), 'utf-8');
  } catch (e) {}
}
carregarVistos();

function jaDivulgado(p) {
  const ant = E().vistos[p.asin];
  if (!ant) return false;
  if (Date.now() - ant.ts > (E().cfg.dedupHoras || 24) * 3600e3) return false;
  // Se caiu mais de 5% desde a ultima vez, vale repostar
  if (ant.preco && p.preco && p.preco < ant.preco * 0.95) return false;
  return true;
}
function registrarVisto(p) {
  E().vistos[p.asin] = { preco: p.preco, ts: Date.now() };
  salvarVistos();
}

// ── BASE DE CUPONS ────────────────────────────────────────────────────────
// Alimentada pelo mesmo ponto que registra a deduplicacao no server.js: todo
// cupom capturado (Telegram ou WhatsApp) entra aqui com os campos que a IA ja
// extrai. Serve para aplicar o desconto sobre o preco cheio que a Creators API
// devolve, que e sempre o preco de tabela — a API nao conhece cupom.
//
// Validade: 2 dias a partir da captura, salvo se o registro for editado a mao
// via endpoint. Flag 'ativo' permite desligar um cupom sem apagar o historico.

const CUPOM_VALIDADE_PADRAO_MS = 24 * 3600e3;


function normalizarTexto(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/^outro:\s*/, '')
    .replace(/[^a-z0-9]/g, '');
}

// Mesma logica de chave do dedup do server.js, para os dois lados baterem.
export function chaveCupom(loja, codigo) {
  const l = normalizarTexto(loja) || 'outros';
  const c = normalizarTexto(codigo);
  return c ? `${l}:${c}` : null;
}

export function carregarCuponsBase() {
  try {
    if (existsSync(cT('cupons_base.json'))) {
      E().cupons = JSON.parse(readFileSync(cT('cupons_base.json'), 'utf-8'));
      // A validade padrao caiu de 48h para 24h: recalcula quem foi gravado com a
      // janela antiga, para a base nao ficar com dois criterios convivendo.
      let migrados = 0;
      for (const reg of Object.values(E().cupons)) {
        const base = new Date(reg.capturadoEm).getTime();
        if (!isFinite(base)) continue;
        const alvo = base + CUPOM_VALIDADE_PADRAO_MS;
        if (new Date(reg.validadeAte).getTime() > alvo + 60e3) {
          reg.validadeAte = new Date(alvo).toISOString();
          migrados++;
        }
      }
      if (migrados) { salvarCuponsBase(); console.log('[CUPONS] ' + migrados + ' cupom(ns) migrado(s) para validade de 24h.'); }
      console.log('[CUPONS] Base carregada — ' + Object.keys(E().cupons).length + ' cupom(ns).');
    }
  } catch (e) { console.log('[CUPONS] Erro ao carregar base:', e.message); E().cupons = {}; }
  return E().cupons;
}

function salvarCuponsBase() {
  try {
    // Purga o que venceu ha mais de 7 dias para o arquivo nao crescer sem fim.
    const corte = Date.now() - 7 * 24 * 3600e3;
    for (const k of Object.keys(E().cupons)) {
      if (new Date(E().cupons[k].validadeAte).getTime() < corte) delete E().cupons[k];
    }
    writeFileSync(cT('cupons_base.json'), JSON.stringify(E().cupons, null, 2), 'utf-8');
    agendarPush(pT('cupons_base.json'));
  } catch (e) { console.log('[CUPONS] Erro ao salvar base:', e.message); }
}

/**
 * Grava (ou atualiza) um cupom na base a partir do objeto que a IA extraiu.
 * Cupom sem codigo nao entra: sem codigo nao ha o que aplicar no checkout.
 */
export function registrarCupomBase(c) {
  const chave = chaveCupom(c?.loja, c?.codigo);
  if (!chave) return null;
  const agora = Date.now();
  const anterior = E().cupons[chave];

  const reg = {
    chave,
    loja: c.loja || null,
    codigo: c.codigo,
    tipo: c.tipo === 'reais' ? 'reais' : 'pct',
    valor: Number(c.valor) || 0,
    minimo: c.minimo === null || c.minimo === undefined ? null : Number(c.minimo),
    limite: c.limite === null || c.limite === undefined ? null : Number(c.limite),
    // 'maximo' e o teto do PRODUTO/PEDIDO elegivel ("15% em produtos ate R$700"),
    // coisa diferente de 'limite', que e o teto do DESCONTO ("15%, ate R$60").
    // Confundir os dois faz o cupom ser anunciado para uma faixa de preco em que
    // ele nem se aplica.
    maximo: c.maximo === null || c.maximo === undefined ? null : Number(c.maximo),
    observacao: c.observacao || null,
    capturadoEm: anterior?.capturadoEm || new Date(agora).toISOString(),
    atualizadoEm: new Date(agora).toISOString(),
    validadeAte: new Date(agora + CUPOM_VALIDADE_PADRAO_MS).toISOString(),
    // Reaparecer no grupo nao deve ressuscitar cupom que o operador desativou.
    ativo: anterior ? anterior.ativo !== false : true,
  };
  E().cupons[chave] = reg;
  salvarCuponsBase();
  console.log('[CUPONS] ' + (anterior ? 'Atualizado' : 'Novo') + ' — ' + reg.loja + ' ' + reg.codigo +
    ' ' + reg.valor + (reg.tipo === 'pct' ? '%' : ' R$'));
  return reg;
}

export function listarCuponsBase() {
  return Object.values(E().cupons).sort((a, b) => (a.loja || '').localeCompare(b.loja || '', 'pt-BR'));
}

export function atualizarCupomBase(chave, campos = {}) {
  const reg = E().cupons[chave];
  if (!reg) return null;
  for (const k of ['ativo', 'valor', 'minimo', 'maximo', 'limite', 'tipo', 'validadeAte', 'observacao']) {
    if (campos[k] !== undefined) reg[k] = campos[k];
  }
  reg.atualizadoEm = new Date().toISOString();
  salvarCuponsBase();
  return reg;
}

export function removerCupomBase(chave) {
  if (!E().cupons[chave]) return false;
  delete E().cupons[chave];
  salvarCuponsBase();
  return true;
}

/** Liga ou desliga de uma vez todos os cupons de uma loja. */
export function definirAtivoPorLoja(loja, ativo) {
  const alvo = normalizarTexto(loja);
  let n = 0;
  for (const reg of Object.values(E().cupons)) {
    if (normalizarTexto(reg.loja) !== alvo) continue;
    if (reg.ativo === ativo) continue;
    reg.ativo = ativo;
    reg.atualizadoEm = new Date().toISOString();
    n++;
  }
  if (n) salvarCuponsBase();
  return n;
}

export function cupomVigente(reg) {
  return !!reg && reg.ativo !== false && new Date(reg.validadeAte).getTime() > Date.now();
}

/**
 * Desconto em R$ que o cupom gera sobre um preco. 0 quando nao se aplica.
 * Tres regras distintas, que nao devem ser confundidas:
 *   minimo — piso do pedido para o cupom valer ("acima de R$ 79")
 *   maximo — teto do produto/pedido elegivel ("em produtos ate R$ 700")
 *   limite — teto do proprio desconto, so em cupom percentual ("ate R$ 60")
 */
export function calcularDesconto(reg, preco) {
  if (!reg || !preco || preco <= 0) return 0;
  if (reg.minimo != null && preco < reg.minimo) return 0;
  if (reg.maximo != null && preco > reg.maximo) return 0;

  let d = reg.tipo === 'reais'
    ? (Number(reg.valor) || 0)
    : preco * (Number(reg.valor) || 0) / 100;

  if (reg.tipo === 'pct' && reg.limite != null) d = Math.min(d, Number(reg.limite));
  d = Math.min(d, preco);                       // nunca zera ou inverte o preco
  return d > 0 ? Math.round(d * 100) / 100 : 0;
}

/**
 * Melhor cupom vigente da loja que REALMENTE se aplica a este preco.
 *
 * Diferente de melhorCupom(), que so age quando a mensagem original citou cupom:
 * aqui quem pediu foi o operador, ao marcar a lista como "cupom automatico".
 * Entre varios aplicaveis vence o de maior desconto em reais.
 */
export function melhorCupomAplicavel(loja, preco) {
  const alvo = normalizarTexto(loja);
  let melhor = null, melhorDesc = 0;
  for (const reg of Object.values(E().cupons)) {
    if (!cupomVigente(reg)) continue;
    if (normalizarTexto(reg.loja) !== alvo) continue;
    const d = calcularDesconto(reg, preco);
    if (d > melhorDesc) { melhor = reg; melhorDesc = d; }
  }
  return melhor ? { reg: melhor, desconto: melhorDesc } : null;
}

/** Busca um cupom da base pelo par (loja, codigo). Usado pela vitrine. */
export function cupomPorCodigo(loja, codigo) {
  const k = chaveCupom(loja, codigo);
  return k ? (E().cupons[k] || null) : null;
}

// Mensagens que falam de cupom sem dar o codigo: "resgate cupom do anuncio",
// "com cupom", "aplique o cupom". Exige a palavra cupom — nao inferimos cupom a
// partir de "desconto" ou "promocao", que aparecem em qualquer oferta.
const REGEX_CUPOM_GENERICO = /\bcupom\b|\bcupons\b|\bcoupon\b/i;

/** Cupom vigente mais recente de uma loja, pela data de captura. */
export function ultimoCupomDaLoja(loja) {
  const alvo = normalizarTexto(loja);
  let recente = null;
  for (const reg of Object.values(E().cupons)) {
    if (!cupomVigente(reg)) continue;
    if (normalizarTexto(reg.loja) !== alvo) continue;
    if (!recente || new Date(reg.capturadoEm) > new Date(recente.capturadoEm)) recente = reg;
  }
  return recente;
}

/**
 * Melhor cupom para (loja, preco), em duas etapas:
 *
 *   1. Codigo citado na mensagem — caminho preferencial. A base entra so para
 *      dar as regras (percentual, minimo, teto) que o texto raramente traz.
 *   2. Se a mensagem fala de cupom mas nao da o codigo ("resgate cupom do
 *      anuncio"), usa o ultimo cupom registrado para aquela loja.
 *
 * Fora esses dois casos nao aplica nada: cruzar um cupom qualquer com um produto
 * que nunca falou em cupom anunciaria um preco que nao existe no checkout.
 */
export function melhorCupom(loja, preco, textoOriginal = '') {
  const lojaKey = normalizarTexto(loja);
  const texto = normalizarTexto(textoOriginal);
  if (!texto) return null;
  let melhor = null;

  for (const reg of Object.values(E().cupons)) {
    if (!cupomVigente(reg)) continue;
    if (normalizarTexto(reg.loja) !== lojaKey) continue;
    if (!reg.codigo || !texto.includes(normalizarTexto(reg.codigo))) continue;

    const desconto = calcularDesconto(reg, preco);
    if (desconto <= 0) continue;

    if (!melhor || desconto > melhor.desconto) melhor = { reg, desconto, citado: true };
  }
  if (melhor) return melhor;

  // Etapa 2: mencao generica ao cupom, sem codigo.
  // Usa o MELHOR cupom aplicavel a este preco, nao o mais recente capturado. O
  // ML publica varios cupons por dia com minimo alto (R$ 299, R$ 399, R$ 899):
  // o mais novo quase nunca vale para produto de ticket baixo, e a etapa antes
  // desistia ali mesmo, deixando a oferta sair sem cupom nenhum apesar de haver
  // outro vigente que servia.
  if (!REGEX_CUPOM_GENERICO.test(String(textoOriginal))) return null;
  const m = melhorCupomAplicavel(loja, preco);
  if (!m) return null;
  return { reg: m.reg, desconto: m.desconto, citado: false, generico: true };
}

// Codigos que aparecem depois da palavra "cupom" no texto do grupo-fonte.
// Aceita "cupom XYZ", "cupom: XYZ", "cupom de desconto XYZ".
const REGEX_CODIGO_CITADO = /\bcupo(?:m|ns)\s*(?:de\s+desconto\s*)?:?\s*(?:e|eh|de|do|da)?\s*([A-Z0-9][A-Z0-9._-]{3,29})\b/gi;

// Palavras que seguem "cupom" sem serem codigo. Sem esta lista, texto escrito
// todo em caixa alta geraria aviso a cada mensagem.
const PALAVRAS_NAO_CODIGO = new Set([
  'DESCONTO','DESCONTOS','EXCLUSIVO','EXCLUSIVA','PROMO','PROMOCAO','ANUNCIO',
  'LOJA','LOJAS','LINK','AQUI','ABAIXO','ACIMA','GRATIS','FRETE','APLIQUE',
  'RESGATE','SOMENTE','PRIMEIRA','COMPRA','COMPRAS','APENAS','VALIDO','CLIQUE',
  'NOVOS','USUARIOS','PONTOS','REAIS','MERCADO','LIVRE','SHOPEE','AMAZON',
  'MAGALU','MAGAZINE','LUIZA','PARA','PELO','PELA','COM','SEM','MAIS',
]);

/**
 * Codigos de cupom citados na postagem original que NAO estao na base.
 *
 * Sem o registro nao ha regra (percentual, minimo, teto) para calcular o
 * desconto, entao a oferta sai pelo preco cheio mesmo o post prometendo outro
 * valor. Serve para o operador cadastrar e nao perder as proximas.
 *
 * Conservador de proposito: so aceita token em CAIXA ALTA ou com digito, para
 * nao confundir "cupom do anuncio" com codigo.
 */
export function cupomCitadoDesconhecido(loja, textoOriginal) {
  const texto = String(textoOriginal || '');
  const achados = new Set();
  for (const m of texto.matchAll(REGEX_CODIGO_CITADO)) {
    const bruto = m[1];
    const codigo = bruto.toUpperCase();
    if (PALAVRAS_NAO_CODIGO.has(codigo)) continue;
    if (bruto !== codigo && !/\d/.test(codigo)) continue;   // nao parece codigo
    if (cupomPorCodigo(loja, codigo)) continue;              // ja esta na base
    achados.add(codigo);
  }
  return [...achados];
}

carregarCuponsBase();

// ── EXTRACAO DE ASIN ──────────────────────────────────────────────────────

const PADROES_ASIN = [
  /\/dp\/(?:product\/)?([A-Z0-9]{10})/i,
  /\/gp\/(?:product|aw\/d|offer-listing)\/([A-Z0-9]{10})/i,
  /\/product\/([A-Z0-9]{10})/i,
  /[?&]asin=([A-Z0-9]{10})/i,
];

// Dois formatos convivem nos grupos-fonte: link direto (amazon.com.br/dp/ASIN)
// e encurtador (amzn.to, a.co, link.amazon). O encurtador NAO carrega o ASIN no
// path — o codigo ali e do shortlink, nao do produto — entao precisa ser
// resolvido por redirect antes de virar consulta na API.
const REGEX_URL_AMAZON = /https?:\/\/(?:[\w-]+\.)*(?:amazon\.com\.br|amzn\.to|amzn\.eu|a\.co|link\.amazon(?:\.com)?)\/\S+/gi;

const UA_NAVEGADOR = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function asinDeUrl(url) {
  for (const re of PADROES_ASIN) {
    const m = url.match(re);
    if (m) return m[1].toUpperCase();
  }
  return null;
}

// Encurtadores (amzn.to, a.co) nao carregam o ASIN. Segue os redirects
// manualmente. Usa Range para nao baixar a pagina inteira — a Amazon costuma
// ignorar HEAD nesses shortlinks.
async function resolverEncurtador(url, tentativas = 5) {
  let atual = url;
  for (let i = 0; i < tentativas; i++) {
    const res = await fetch(atual, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'User-Agent': UA_NAVEGADOR,
        'Accept-Language': 'pt-BR,pt;q=0.9',
        'Range': 'bytes=0-0',
      },
      signal: AbortSignal.timeout(8000),
    });
    const loc = res.headers.get('location');
    if (!loc) return res.url || atual;
    atual = new URL(loc, atual).href;
    if (asinDeUrl(atual)) return atual;
  }
  return atual;
}

// Nem todo encurtador entrega o destino por header Location: alguns respondem
// 200 com redirect via JS ou meta refresh, e ai a cadeia de redirects termina
// sem ASIN. Neste caso busca a pagina e le o ASIN do canonical.
// So aceita canonical/og:url/campo "asin" — nunca um /dp/ solto no corpo, que
// costuma ser produto recomendado e anunciaria o item errado.
async function asinPorHtml(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA_NAVEGADOR, 'Accept-Language': 'pt-BR,pt;q=0.9' },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, 300000);

    const canonical = html.match(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i);
    if (canonical) { const a = asinDeUrl(canonical[1]); if (a) return { asin: a, canonical: canonical[1] }; }

    const og = html.match(/<meta[^>]+property=["']og:url["'][^>]*content=["']([^"']+)["']/i);
    if (og) { const a = asinDeUrl(og[1]); if (a) return { asin: a, canonical: og[1] }; }

    const campo = html.match(/["']asin["']\s*:\s*["']([A-Z0-9]{10})["']/i);
    if (campo) return { asin: campo[1].toUpperCase(), canonical: null };

    return null;
  } catch (e) {
    console.warn('[MKT] Falha ao ler HTML de', url, '-', e.message);
    return null;
  }
}

export async function extrairAsins(texto) {
  if (!texto) return [];
  const urls = [...new Set(texto.match(REGEX_URL_AMAZON) || [])]
    .map(u => u.replace(/[)\]}.,;!]+$/, ''));
  const asins = new Set();
  for (const url of urls) {
    let asin = asinDeUrl(url);
    let destino = url;
    if (!asin) {
      try { destino = await resolverEncurtador(url); asin = asinDeUrl(destino); }
      catch (e) { console.warn('[MKT] Falha ao resolver', url, '-', e.message); }
    }
    if (!asin) { const r = await asinPorHtml(destino); asin = r?.asin || null; }
    if (asin) asins.add(asin);
    else console.warn('[MKT] Sem ASIN para', url, '— destino:', destino);
  }
  return [...asins];
}

// ── CREATORS API ──────────────────────────────────────────────────────────

const TOKEN_ENDPOINT = 'https://api.amazon.com/auth/o2/token';  // regiao NA (BR)
const API_BASE       = 'https://creatorsapi.amazon';
const MARKETPLACE    = 'www.amazon.com.br';


async function getToken() {
  if (E().token.valor && Date.now() < E().token.expiraEm) return E().token.valor;
  const amzId = credencialTsp('AMZ_CLIENT_ID'), amzSecret = credencialTsp('AMZ_CLIENT_SECRET');
  if (!amzId || !amzSecret) {
    throw new Error('AMZ_CLIENT_ID / AMZ_CLIENT_SECRET nao configurados.');
  }
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: amzId,
      client_secret: amzSecret,
      scope: 'creatorsapi::default',
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error('Token Creators API falhou: ' + res.status + ' ' + (await res.text()).slice(0, 200));
  const data = await res.json();
  E().token = { valor: data.access_token, expiraEm: Date.now() + (data.expires_in - 300) * 1000 };
  return E().token.valor;
}

const RECURSOS = [
  'itemInfo.title',
  'itemInfo.byLineInfo',
  'images.primary.medium',
  'images.primary.large',
  'offersV2.listings.price',
  'offersV2.listings.availability',
  'offersV2.listings.condition',
  'offersV2.listings.dealDetails',
  'offersV2.listings.isBuyBoxWinner',
  'offersV2.listings.merchantInfo',
  'customerReviews.starRating',
  'customerReviews.count',
];

/**
 * Sonda de diagnostico: pede recursos arbitrarios a Creators API e devolve o
 * JSON cru. Serve para descobrir o que a API expoe (ex.: promocao/cupom da
 * pagina) sem arriscar o pipeline com um recurso invalido.
 */
export async function sondarRecursos(asin, recursos) {
  const token = await getToken();
  const partnerTag = E().cfg.partnerTag || credencialTsp('AMZ_PARTNER_TAG');
  const res = await fetch(API_BASE + '/catalog/v1/getItems', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'x-marketplace': MARKETPLACE },
    body: JSON.stringify({
      itemIds: [asin], itemIdType: 'ASIN', marketplace: MARKETPLACE,
      partnerTag, partnerType: 'Associates', resources: recursos,
    }),
    signal: AbortSignal.timeout(20000),
  });
  const texto = await res.text();
  try { return { status: res.status, corpo: JSON.parse(texto) }; }
  catch (e) { return { status: res.status, corpo: texto.slice(0, 600) }; }
}

// GetItems aceita ate 10 ASINs por chamada.
export async function buscarProdutos(asins) {
  if (!asins.length) return [];
  const token = await getToken();
  const partnerTag = E().cfg.partnerTag || credencialTsp('AMZ_PARTNER_TAG');
  if (!partnerTag) throw new Error('partnerTag nao configurado.');

  const lotes = [];
  for (let i = 0; i < asins.length; i += 10) lotes.push(asins.slice(i, i + 10));

  const itens = [];
  for (const lote of lotes) {
    const res = await fetch(API_BASE + '/catalog/v1/getItems', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'x-marketplace': MARKETPLACE,
      },
      body: JSON.stringify({
        itemIds: lote,
        itemIdType: 'ASIN',
        marketplace: MARKETPLACE,
        partnerTag,
        partnerType: 'Associates',
        resources: RECURSOS,
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      console.error('[MKT] getItems', res.status, (await res.text()).slice(0, 300));
      continue;
    }
    const data = await res.json();
    itens.push(...(data?.itemsResult?.items || []));
    if (lotes.length > 1) await new Promise(r => setTimeout(r, 1100));
  }
  return itens;
}

// ── NORMALIZACAO ──────────────────────────────────────────────────────────

// A Amazon pode devolver mais de um listing para o mesmo ASIN (ex.: um Prime
// Exclusive e um aberto) e a ordem NAO e garantida. Anunciar o preco Prime como
// se fosse geral gera reclamacao no grupo, entao prioriza o buy box.
function escolherListing(item) {
  const listings = item?.offersV2?.listings || [];
  if (!listings.length) return null;
  return listings.find(l => l.isBuyBoxWinner) || listings[0];
}

export function normalizar(item) {
  const l = escolherListing(item);
  const preco = l?.price?.money;
  const de    = l?.price?.savingBasis?.money;
  const desconto = (de?.amount && preco?.amount)
    ? Math.round((1 - preco.amount / de.amount) * 100)
    : 0;

  return {
    asin: item.asin,
    titulo: item?.itemInfo?.title?.displayValue || '',
    marca: item?.itemInfo?.byLineInfo?.brand?.displayValue || '',
    imagemUrl: item?.images?.primary?.medium?.url || item?.images?.primary?.large?.url || null,
    link: item.detailPageURL,          // ja vem com o partnerTag aplicado
    preco: preco?.amount ?? null,
    precoTexto: preco?.displayAmount || null,
    precoDe: de?.amount ?? null,
    precoDeTexto: de?.displayAmount || null,
    desconto,
    disponivel: l?.availability?.type === 'IN_STOCK',
    vendedor: l?.merchantInfo?.name || null,
    ehDeal: Boolean(l?.dealDetails),
    dealTermina: l?.dealDetails?.endTime || null,
    nota: item?.customerReviews?.starRating?.value ?? null,
    avaliacoes: item?.customerReviews?.count ?? null,
    loja: 'Amazon',
  };
}

// ── FORMATACAO ────────────────────────────────────────────────────────────
// Segue exatamente o formato da aba Oferta do gerador, para a mensagem do robo
// ser indistinguivel da que voce escreve na mao.

function brl(n) {
  return Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function encurtarTitulo(t, max = 80) {
  if (!t || t.length <= max) return t || '';
  const corte = t.lastIndexOf(' ', max);
  return t.slice(0, corte > 40 ? corte : max) + '...';
}

export function formatarOfertaAmazon(p, opcoes = {}) {
  const cupom = opcoes.cupom || null;
  const tpl   = opcoes.template || templateDaLoja(p.loja);
  const vars  = varsDoProduto(p, cupom);
  if (opcoes.gatilho ?? E().cfg.gatilhoPadrao) vars.gatilho = opcoes.gatilho ?? E().cfg.gatilhoPadrao;
  return renderTemplate(tpl?.corpo || TEMPLATE_PADRAO, vars);
}

// ── TEMPLATES POR LOJA ────────────────────────────────────────────────────
// O formato da mensagem deixa de ser codigo e passa a ser dado editavel. Cada
// loja tem o seu; quem nao tiver cai no '_padrao'. Sintaxe estilo Mustache:
//   {{var}}            insere o valor (vazio se ausente)
//   {{#var}}...{{/var}} so renderiza o bloco se var tiver valor
//   {{^var}}...{{/var}} so renderiza o bloco se var estiver vazia
// As condicionais existem porque sem elas a mensagem sai com "De: ~R$ ~" ou um
// selo de cupom orfao quando o campo nao veio da API.


// Funcao (nao const): o rodape vem da config editavel pelo painel, entao a
// semente do template padrao de um operador novo ja nasce com o convite DELE.
function templatePadrao() {
  const linhas = [
    '*{{titulo_curto}}*',
    '',
    'De: ~R$ {{preco_de}}~',
    'Por: R$ {{preco}}',
    '',
    '\uD83C\uDFAB *CUPOM* {{cupom}}',
    '\u26A0\uFE0F *IMPORTANTE* {{alerta}}',
    '',
    '\uD83D\uDED2 *LOJA* {{loja_upper}}',
    '',
    '\uD83D\uDD17 *LINK* {{link}}',
  ];
  const r = rodapeOferta(tenantAtual());
  if (r) linhas.push('', r);
  return linhas.join('\n');
}

// Template das mensagens de CUPOM. Ate aqui o formato do cupom era codigo fixo
// no server.js, entao o auto-envio do monitoramento e a aba Cupom do painel
// tinham cada um a sua copia do mesmo layout — e elas divergiam. Agora as duas
// renderizam ESTE corpo, editavel na aba Templates.
//
// O rodape faz parte do CORPO, como no template de oferta: o operador edita a
// mensagem inteira num lugar so. O campo "Rodape dos CUPONS" da aba
// Configuracoes e a semente deste corpo na primeira execucao.
function templateCupomPadrao() {
  const linhas = [
    '`\uD83D\uDEA8 {{gatilho}}`',
    '',
    '*\uD83D\uDEA8 Cupom de {{valor_str}} - {{loja}}*',
    '',
    '{{validade}}',
    '',
    '\uD83D\uDED2 *LOJA* {{loja_upper}}',
    '',
    '\uD83C\uDFF7\uFE0F *CUPOM* {{codigo}}',
    '',
    '\u26A0\uFE0F *IMPORTANTE* {{importante}}',
    '',
    '\u26A0\uFE0F *IMPORTANTE* {{aviso}}',
    '',
    '\uD83D\uDD17 *RESGATE O CUPOM AQUI* {{link}}',
  ];
  const r = rodapeCupom(tenantAtual());
  if (r) linhas.push('', r);
  return linhas.join('\n');
}

// Corpo da versao anterior, que exigia {{#var}}...{{/var}}. Serve so para
// reconhecer o padrao nao editado e migra-lo para a sintaxe simples — template
// que o operador ja customizou nao e tocado.
const TEMPLATE_PADRAO_LEGADO = [
  '*{{titulo_curto}}*', '', '{{#preco_de}}De: ~R$ {{preco_de}}~', '{{/preco_de}}Por: R$ {{preco}}',
  '{{#cupom}}', '\uD83C\uDFAB *CUPOM* {{cupom}}', '{{/cupom}}', '{{#alerta}}',
  '\u26A0\uFE0F *IMPORTANTE* {{alerta}}', '{{/alerta}}', '', '\uD83D\uDED2 *LOJA* {{loja_upper}}',
  '', '\uD83D\uDD17 *LINK* {{link}}', '',
  '`Convide seus amigos para entrar aqui no grupo:  ' + LINK_CONVITE_OFERTAS + '`',
].join('\n');


// Chaves reservadas: templates que nao pertencem a loja nenhuma. Sem este mapa
// '_padrao' virava 'padrao' (o replace come o underline) e o template salvo
// pelo painel ia parar num registro que nenhuma leitura consultava.
//   _padrao  fallback das ofertas de marketplace
//   _cupom   mensagem de cupom (auto-envio + aba Cupom)
//   _awin    ofertas vindas da rede Awin, quando a loja nao tem template proprio
const TPL_RESERVADOS = { padrao: '_padrao', cupom: '_cupom', awin: '_awin' };

function chaveLoja(loja) {
  const k = (loja || '')
    .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '') || '_padrao';
  return TPL_RESERVADOS[k] || k;
}

export function carregarTemplates() {
  try {
    if (existsSync(cT('templates.json'))) E().templates = JSON.parse(readFileSync(cT('templates.json'), 'utf-8'));
  } catch (e) { console.log('[TPL] Erro ao carregar templates:', e.message); E().templates = {}; }
  // Migracao do bug da chave: 'padrao' (sem underline) era onde o painel
  // gravava, '_padrao' era o que o pipeline lia. Quem estiver mais novo vence —
  // salvar no painel e nao ver efeito nenhum era o sintoma.
  const orfao = E().templates.padrao;
  if (orfao) {
    const dPadrao = new Date(orfao.atualizadoEm || 0).getTime() || 0;
    const dReal   = new Date((E().templates._padrao || {}).atualizadoEm || 0).getTime() || 0;
    if (!E().templates._padrao || dPadrao > dReal) E().templates._padrao = orfao;
    delete E().templates.padrao;
    salvarTemplates();
    console.log('[TPL] Chave orfa \'padrao\' migrada para \'_padrao\'.');
  }

  // Semeia o padrao na primeira execucao para o operador ter de onde partir.
  if (!E().templates._padrao) {
    E().templates._padrao = { nome: 'Padrão', corpo: templatePadrao(), usarLinkPreview: true,
                           atualizadoEm: new Date().toISOString() };
    salvarTemplates();
  } else if ((E().templates._padrao.corpo || '').trim() === TEMPLATE_PADRAO_LEGADO.trim()) {
    E().templates._padrao.corpo = templatePadrao();
    E().templates._padrao.atualizadoEm = new Date().toISOString();
    salvarTemplates();
    console.log('[TPL] Padrao migrado para a sintaxe sem condicionais.');
  }
  // Cupom e Awin nascem com o layout que o codigo usava antes de virarem
  // template, para ligar a novidade sem mudar nenhuma mensagem no ar.
  if (!E().templates._cupom) {
    E().templates._cupom = { nome: 'Cupom', corpo: templateCupomPadrao(), usarLinkPreview: false,
                             atualizadoEm: new Date().toISOString() };
    salvarTemplates();
  }
  if (!E().templates._awin) {
    E().templates._awin = { nome: 'Awin', corpo: (E().templates._padrao.corpo || templatePadrao()),
                            usarLinkPreview: true, atualizadoEm: new Date().toISOString() };
    salvarTemplates();
  }
  console.log('[TPL] ' + Object.keys(E().templates).length + ' template(s) carregado(s).');
  return E().templates;
}

function salvarTemplates() {
  try { writeFileSync(cT('templates.json'), JSON.stringify(E().templates, null, 2), 'utf-8');
    agendarPush(pT('templates.json')); }
  catch (e) { console.log('[TPL] Erro ao salvar templates:', e.message); }
}

export function listarTemplates() { return E().templates; }

export function templateDaLoja(loja) {
  return E().templates[chaveLoja(loja)] || E().templates._padrao;
}

/** Template proprio da loja, SEM cair no padrao. Quem precisa saber se a loja
 *  tem layout dedicado (a Awin, para decidir entre o dela e o da loja). */
export function templateProprioDaLoja(loja) {
  return E().templates[chaveLoja(loja)] || null;
}

/** Corpo das mensagens de cupom. Sempre devolve algo renderizavel. */
export function templateCupom() {
  return E().templates._cupom || { nome: 'Cupom', corpo: templateCupomPadrao() };
}

/** Corpo das ofertas da rede Awin. Cai no padrao das ofertas se nao existir. */
export function templateAwin() {
  return E().templates._awin || E().templates._padrao || { nome: 'Awin', corpo: templatePadrao() };
}

export function salvarTemplate(loja, dados = {}) {
  const k = chaveLoja(loja);
  const anterior = E().templates[k] || {};
  E().templates[k] = {
    nome: dados.nome || anterior.nome || loja || 'Padrão',
    corpo: dados.corpo !== undefined ? dados.corpo : (anterior.corpo || TEMPLATE_PADRAO),
    usarLinkPreview: dados.usarLinkPreview !== undefined
      ? !!dados.usarLinkPreview
      : (anterior.usarLinkPreview !== false),
    atualizadoEm: new Date().toISOString(),
  };
  salvarTemplates();
  return E().templates[k];
}

export function removerTemplate(loja) {
  const k = chaveLoja(loja);
  if (k === '_padrao' || !E().templates[k]) return false;   // o padrao nunca some
  delete E().templates[k];
  salvarTemplates();
  return true;
}

export function renderTemplate(corpo, vars) {
  const vazio = v => v === null || v === undefined || v === '' || v === false;
  let out = String(corpo || '');

  // Condicionais explicitas seguem valendo para casos que a regra de linha nao
  // cobre (bloco de varias linhas, ou negacao com {{^var}}).
  out = out.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, k, dentro) => vazio(vars[k]) ? '' : dentro);
  out = out.replace(/\{\{\^(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, k, dentro) => vazio(vars[k]) ? dentro : '');

  // Omissao automatica: uma linha que so contem variaveis vazias nao tem o que
  // dizer, entao sai inteira. Assim "De: ~R$ {{preco_de}}~" desaparece sozinho
  // quando nao ha preco de lista, sem o operador escrever condicional nenhuma.
  // Linha sem variavel e texto fixo e nunca some; linha com pelo menos uma
  // variavel preenchida e mantida.
  out = out.split('\n').filter(linha => {
    const usadas = (linha.match(/\{\{(\w+)\}\}/g) || []).map(t => t.slice(2, -2));
    if (!usadas.length) return true;
    return usadas.some(k => !vazio(vars[k]));
  }).join('\n');

  out = out.replace(/\{\{(\w+)\}\}/g, (_, k) => vazio(vars[k]) ? '' : String(vars[k]));
  return out.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** Variaveis disponiveis no template, a partir do produto ja normalizado. */
export function varsDoProduto(p, cupom) {
  const precoFinal = cupom ? Math.max(0, p.preco - cupom.desconto) : p.preco;
  // Com cupom e sem preco de lista, o preco cheio faz as vezes de valor riscado
  // — legitimo quando ele veio de fonte verificavel. Se veio do texto do grupo
  // (precoDeReferencia), o 'De' seria um numero que ninguem confirmou, entao fica vazio.
  const riscado = cupom
    ? (p.precoDe || (p.precoDeReferencia ? null : p.preco))
    : p.precoDe;
  const descTotal = (riscado && riscado > precoFinal)
    ? Math.round((1 - precoFinal / riscado) * 100)
    : p.desconto;

  const alertas = [];
  if (descTotal >= 40) alertas.push(descTotal + '% de desconto');
  if (p.dealTermina) {
    alertas.push('Oferta relâmpago, termina em ' + new Date(p.dealTermina).toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo',
    }));
  }

  return {
    titulo: p.titulo || '',
    titulo_curto: encurtarTitulo(p.titulo),
    preco: brl(precoFinal),
    preco_cheio: brl(p.preco),
    preco_de: (riscado && riscado > precoFinal) ? brl(riscado) : '',
    desconto: descTotal > 0 ? descTotal : '',
    economia: (riscado && riscado > precoFinal) ? brl(riscado - precoFinal) : '',
    cupom: cupom ? cupom.reg.codigo : '',
    cupom_desconto: cupom ? brl(cupom.desconto) : '',
    alerta: alertas.join('. '),
    link: p.link || '',
    loja: p.loja || '',
    loja_upper: (p.loja || '').toUpperCase(),
    vendedor: p.vendedor || '',
    asin: p.asin || '',
    avaliacao: p.nota ? String(p.nota).replace('.', ',') : '',
    avaliacoes: p.avaliacoes || '',
    marca: p.marca || '',
  };
}

/** Lista para a UI montar os botoes de insercao. */
export const VARIAVEIS_TEMPLATE = [
  { chave:'titulo_curto',  desc:'Título do produto, cortado em 80 caracteres' },
  { chave:'titulo',        desc:'Título completo do produto' },
  { chave:'preco',         desc:'Preço final, já com o cupom aplicado' },
  { chave:'preco_cheio',   desc:'Preço da API, sem o cupom' },
  { chave:'preco_de',      desc:'Preço de lista (vazio quando não há)' },
  { chave:'desconto',      desc:'Percentual total de desconto' },
  { chave:'economia',      desc:'Quanto o cliente economiza, em R$' },
  { chave:'cupom',         desc:'Código do cupom (vazio quando não há)' },
  { chave:'cupom_desconto',desc:'Valor do desconto do cupom, em R$' },
  { chave:'alerta',        desc:'Aviso de desconto alto ou oferta relâmpago' },
  { chave:'link',          desc:'Link do produto com a sua tag de afiliado' },
  { chave:'loja',          desc:'Nome da loja' },
  { chave:'loja_upper',    desc:'Nome da loja em maiúsculas' },
  { chave:'vendedor',      desc:'Vendedor do anúncio' },
  { chave:'marca',         desc:'Marca do produto' },
  { chave:'avaliacao',     desc:'Nota média (ex: 4,5)' },
  { chave:'avaliacoes',    desc:'Quantidade de avaliações' },
  { chave:'asin',          desc:'Código ASIN do produto' },
];

/** Variaveis do template de CUPOM (a UI monta os botoes a partir daqui). */
export const VARIAVEIS_CUPOM = [
  { chave:'valor_str',  desc:'Desconto ja formatado — ex: "15%" ou "20 reais"' },
  { chave:'valor',      desc:'Só o número do desconto' },
  { chave:'loja',       desc:'Nome da loja' },
  { chave:'loja_upper', desc:'Nome da loja em maiúsculas' },
  { chave:'validade',   desc:'Frase das condições (mínimo, teto de produto, teto de desconto)' },
  { chave:'codigo',     desc:'Código do cupom (vazio quando é cupom sem código)' },
  { chave:'importante', desc:'Aviso calculado do teto — ex: "Ideal para compras de até R$ 400."' },
  { chave:'aviso',      desc:'Observação livre digitada na aba Cupom' },
  { chave:'gatilho',    desc:'Chamada opcional no topo da mensagem' },
  { chave:'link',       desc:'Link de afiliado de resgate do cupom' },
  { chave:'minimo',     desc:'Valor mínimo de compra, só o número' },
  { chave:'maximo',     desc:'Teto de preço do produto elegível, só o número' },
  { chave:'limite',     desc:'Teto de desconto em R$, só o número' },
];

// ── PIPELINE ──────────────────────────────────────────────────────────────

/**
 * Recebe o texto bruto de uma mensagem e devolve as ofertas prontas.
 * A API e a fonte da verdade: preco, estoque e desconto vem dela, nunca do
 * texto do grupo de origem — e o que evita repassar oferta que ja morreu.
 *
 * @param {string} texto
 * @param {object} opcoes  { ignorarDedup: bool, gatilho: string }
 * @returns {Promise<Array<{ produto, mensagem, descartadoPor? }>>}
 */
export async function processarTextoAmazon(texto, opcoes = {}) {
  const asins = await extrairAsins(texto);
  if (!asins.length) return [];

  const itens = await buscarProdutos(asins);
  const saida = [];

  for (const item of itens) {
    const p = normalizar(item);

    if (!p.preco)      { saida.push({ produto: p, descartadoPor: 'sem preço disponível' }); continue; }
    if (!p.disponivel) { saida.push({ produto: p, descartadoPor: 'produto esgotado' }); continue; }
    // ignorarMinimo: montagem manual pelo gerador. Quando o operador cola o
    // link ele ja decidiu que quer aquele produto — o piso de desconto existe
    // para o radar automatico, que escolhe sozinho o que divulgar.
    if (p.desconto < (E().cfg.descontoMinimo ?? 5) && !p.ehDeal && !opcoes.ignorarMinimo) {
      saida.push({ produto: p, descartadoPor: 'desconto de ' + p.desconto + '% abaixo do mínimo' });
      continue;
    }
    if (!opcoes.ignorarDedup && jaDivulgado(p)) {
      saida.push({ produto: p, descartadoPor: 'já divulgado nas últimas ' + (E().cfg.dedupHoras || 24) + 'h' });
      continue;
    }

    // A API devolve sempre o preco de tabela; o cupom vem da base alimentada
    // pelo pipeline de cupons e e aplicado aqui sobre esse preco cheio.
    const cupom = melhorCupom(p.loja, p.preco, texto);
    if (cupom) {
      console.log('[MKT] ' + p.asin + ' + cupom ' + cupom.reg.codigo +
        ' (-R$ ' + cupom.desconto.toFixed(2) + ')' +
        (cupom.citado ? ' [citado no texto]' : ' [ultimo da loja — texto cita cupom sem codigo]'));
    }
    saida.push({
      produto: p,
      cupom: cupom ? { codigo: cupom.reg.codigo, desconto: cupom.desconto, citado: cupom.citado,
                       generico: !!cupom.generico } : null,
      precoFinal: cupom ? Math.max(0, p.preco - cupom.desconto) : p.preco,
      mensagem: formatarOfertaAmazon(p, { ...opcoes, cupom }),
    });
    if (!opcoes.ignorarDedup) registrarVisto(p);
  }
  return saida;
}

carregarRadarConfig();
semearMonitorDasFontes();
carregarTemplates();

// ── VITRINE ───────────────────────────────────────────────────────────────
// Produtos que o operador quer manter a mao para disparar quando sair um cupom
// bom. Guarda so link, ASIN e nome: preco, estoque e desconto sao consultados
// no disparo, porque preco salvo envelhece e anunciar preco velho e o erro que
// esse pipeline inteiro existe para evitar.


export function carregarVitrine() {
  try { if (existsSync(cT('vitrine.json'))) E().vitrine = JSON.parse(readFileSync(cT('vitrine.json'), 'utf-8')); }
  catch (e) { console.log('[VITRINE] Erro ao carregar:', e.message); E().vitrine = {}; }
  return E().vitrine;
}
function salvarVitrine() {
  try { writeFileSync(cT('vitrine.json'), JSON.stringify(E().vitrine, null, 2), 'utf-8');
    agendarPush(pT('vitrine.json')); }
  catch (e) { console.log('[VITRINE] Erro ao salvar:', e.message); }
}

// O slug da URL da Amazon ja traz o nome do produto
// (/Carrinho-Eletrico-Infantil-Maxi-Toys/dp/B0FPT9JLMX), entao da para gravar um
// nome legivel sem gastar uma chamada de API no cadastro.
function nomeDoSlug(url) {
  try {
    // Precisa ser o pathname: casar na URL inteira faria o host virar "nome"
    // em links no formato /dp/ASIN, que nao tem slug.
    const m = new URL(url).pathname.match(/^\/([^\/]+)\/dp\//i);
    if (!m) return '';
    return decodeURIComponent(m[1]).replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  } catch (e) { return ''; }
}

/**
 * Resolve uma linha colada pelo operador. Aceita "nome | link" ou so o link.
 * Faz apenas o trabalho de rede necessario para achar o ASIN (encurtador);
 * nao consulta a Creators API.
 */
export async function resolverLinhaVitrine(linha) {
  const bruto = String(linha || '').trim();
  if (!bruto) return null;

  let nomeManual = '', url = bruto;
  const sep = bruto.match(/^(.*?)\s*[|;]\s*(https?:\/\/\S+)$/);
  if (sep) { nomeManual = sep[1].trim(); url = sep[2].trim(); }
  else {
    const m = bruto.match(REGEX_URL_AMAZON);
    if (!m) return { erro: 'sem link da Amazon', linha: bruto };
    url = m[0].replace(/[)\]}.,;!]+$/, '');
    REGEX_URL_AMAZON.lastIndex = 0;
  }

  let asin = asinDeUrl(url), destino = url;
  if (!asin) {
    try { destino = await resolverEncurtador(url); asin = asinDeUrl(destino); }
    catch (e) { /* segue para o fallback por HTML */ }
  }
  if (!asin) {
    const r = await asinPorHtml(destino);
    if (r?.asin) { asin = r.asin; if (r.canonical) destino = r.canonical; }
  }
  if (!asin) return { erro: 'não foi possível identificar o produto', linha: bruto };

  const nome = nomeManual || nomeDoSlug(destino) || nomeDoSlug(url) || ('Produto ' + asin);
  return { asin, nome, url: destino, loja: 'Amazon' };
}

export function listarVitrine() {
  return Object.values(E().vitrine).sort((a, b) => (a.nome || '').localeCompare(b.nome || '', 'pt-BR'));
}

const NOME_PROVISORIO = /^Produto [A-Z0-9]{10}$/;

export function salvarItemVitrine(item) {
  if (!item?.asin) return null;
  const anterior = E().vitrine[item.asin];

  // Um nome provisorio nunca sobrescreve um nome bom: o mesmo produto colado por
  // dois formatos de link (um com slug, outro encurtado) perderia o nome legivel.
  let nome = item.nome !== undefined ? item.nome : (anterior?.nome || '');
  if (NOME_PROVISORIO.test(nome) && anterior?.nome && !NOME_PROVISORIO.test(anterior.nome)) {
    nome = anterior.nome;
  }

  E().vitrine[item.asin] = {
    asin: item.asin,
    nome,
    url: item.url || anterior?.url || '',
    loja: item.loja || anterior?.loja || 'Amazon',
    // Shopee identifica o produto por (shopId, itemId), nao por um codigo unico
    // como o ASIN — os dois precisam sobreviver no cadastro.
    shopId: item.shopId || anterior?.shopId || null,
    itemId: item.itemId || anterior?.itemId || null,
    // Awin: o item guarda DOIS enderecos — 'url' e o link de afiliado que vai na
    // mensagem e 'urlProduto' e a pagina original da loja, que e o que permite
    // reconsultar o preco no instante do disparo.
    urlProduto: item.urlProduto || anterior?.urlProduto || null,
    advertiserId: item.advertiserId || anterior?.advertiserId || null,
    cupom: item.cupom !== undefined ? (item.cupom || null) : (anterior?.cupom || null),
    criadoEm: anterior?.criadoEm || new Date().toISOString(),
    atualizadoEm: new Date().toISOString(),
    ultimoDisparo: anterior?.ultimoDisparo || null,
  };
  salvarVitrine();
  return E().vitrine[item.asin];
}

export function removerItemVitrine(asin) {
  if (!E().vitrine[asin]) return false;
  delete E().vitrine[asin];
  salvarVitrine();
  return true;
}

export function marcarDisparo(asin) {
  if (E().vitrine[asin]) { E().vitrine[asin].ultimoDisparo = new Date().toISOString(); salvarVitrine(); }
}

export function itemVitrine(asin) { return E().vitrine[asin] || null; }

/**
 * Monta as mensagens de uma lista de ASINs no momento do disparo: consulta a
 * Creators API agora, aplica o cupom (o informado no disparo tem prioridade
 * sobre o vinculado ao produto) e renderiza o template da loja.
 * Devolve { prontos, descartados } — nada e enviado aqui.
 */
export async function montarOfertasVitrine(asins, codigoCupom = null) {
  const itens = await buscarProdutos(asins);
  const prontos = [], descartados = [];
  const achados = new Set();

  for (const item of itens) {
    const p = normalizar(item);
    achados.add(p.asin);
    const salvo = E().vitrine[p.asin];
    // Link sem slug entra como "Produto ASIN"; o disparo e a primeira vez que
    // temos o titulo real, entao aproveita para gravar.
    let nome = salvo?.nome || p.titulo;
    if (salvo && NOME_PROVISORIO.test(nome) && p.titulo) {
      nome = p.titulo; salvarItemVitrine({ asin: p.asin, nome });
    }

    if (!p.preco)      { descartados.push({ asin:p.asin, nome, motivo:'sem preço disponível' }); continue; }
    if (!p.disponivel) { descartados.push({ asin:p.asin, nome, motivo:'produto esgotado' }); continue; }

    // Cupom do disparo vence o vinculado; sem nenhum dos dois, vai sem cupom.
    const codigo = codigoCupom || salvo?.cupom || null;
    let cupom = null, avisoCupom = null;
    // 'auto': escolhe sozinho o melhor cupom da loja que atenda o preco deste
    // produto — um cupom de R$10 acima de R$40 entra num produto de R$50 e nao
    // entra num de R$30, produto a produto.
    if (codigo === 'auto') {
      const m = melhorCupomAplicavel(p.loja, p.preco);
      if (m) cupom = { reg: m.reg, desconto: m.desconto, citado: true };
      else avisoCupom = 'nenhum cupom vigente se aplica a R$ ' + brl(p.preco);
    } else if (codigo) {
      const reg = cupomPorCodigo(p.loja, codigo);
      if (!reg)                   avisoCupom = 'cupom ' + codigo + ' não está na base';
      else if (!cupomVigente(reg)) avisoCupom = 'cupom ' + codigo + ' expirado ou inativo';
      else {
        const desconto = calcularDesconto(reg, p.preco);
        if (desconto > 0) cupom = { reg, desconto, citado: true };
        else {
          const regra = reg.maximo != null && p.preco > reg.maximo
            ? ' (vale só até R$ ' + brl(reg.maximo) + ')'
            : (reg.minimo != null ? ' (mínimo R$ ' + brl(reg.minimo) + ')' : '');
          avisoCupom = 'cupom ' + codigo + ' não se aplica a R$ ' + brl(p.preco) + regra;
        }
      }
    }

    prontos.push({
      asin: p.asin, nome, produto: p,
      cupom: cupom ? { codigo: cupom.reg.codigo, desconto: cupom.desconto } : null,
      avisoCupom,
      precoFinal: cupom ? Math.max(0, p.preco - cupom.desconto) : p.preco,
      mensagem: formatarOfertaAmazon(p, { cupom }),
    });
  }

  for (const a of asins) {
    if (!achados.has(a)) {
      descartados.push({ asin:a, nome:E().vitrine[a]?.nome || a, motivo:'produto não retornado pela API' });
    }
  }
  return { prontos, descartados };
}

carregarVitrine();

// ── LISTAS DE REENVIO ───────────────────────────────────────────────────────
// Conjunto nomeado de produtos da vitrine que o operador dispara de tempos em
// tempos (produtos que ele sabe que vendem). O disparo NAO e uma rajada: sai um
// produto por vez, com o intervalo que a lista define, para nao inundar o grupo.

export function carregarListas() {
  try { if (existsSync(cT('listas.json'))) E().listas = JSON.parse(readFileSync(cT('listas.json'), 'utf-8')); }
  catch (e) { console.log('[LISTAS] Erro ao carregar:', e.message); E().listas = {}; }
  return E().listas;
}
function salvarListas() {
  try { writeFileSync(cT('listas.json'), JSON.stringify(E().listas, null, 2), 'utf-8');
    agendarPush(pT('listas.json')); }
  catch (e) { console.log('[LISTAS] Erro ao salvar:', e.message); }
}

export function listarListas() {
  return Object.values(E().listas).sort((a, b) => (a.nome || '').localeCompare(b.nome || '', 'pt-BR'));
}
export function listaPorId(id) { return E().listas[id] || null; }

export function salvarLista(dados = {}) {
  const id = dados.id || ('L' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
  const ant = E().listas[id] || {};

  const produtos = Array.isArray(dados.produtos)
    ? [...new Set(dados.produtos.filter(Boolean))]
    : (ant.produtos || []);

  // Intervalo minimo de 1 min: abaixo disso o disparo vira rajada, que e
  // exatamente o padrao que faz o WhatsApp marcar a conta como automacao.
  const intervalo = dados.intervaloMin !== undefined
    ? Math.min(Math.max(Number(dados.intervaloMin) || 1, 1), 720)
    : (ant.intervaloMin || 20);

  const modo = ['auto', 'fixo', 'nenhum'].includes(dados.cupomModo)
    ? dados.cupomModo : (ant.cupomModo || 'auto');

  // Envio unico: a lista existe apenas para carregar a fila deste disparo e some
  // sozinha quando a fila termina. Nao aceita agendamento — nao ha o que
  // reagendar numa lista que nao vai existir amanha.
  const efemera = dados.efemera !== undefined ? !!dados.efemera : !!ant.efemera;

  const ag = dados.agenda !== undefined ? (dados.agenda || {}) : (ant.agenda || {});
  const agenda = {
    ativo: !efemera && !!ag.ativo,
    diasSemana: Array.isArray(ag.diasSemana)
      ? ag.diasSemana.map(Number).filter(d => d >= 0 && d <= 6) : [],
    hora: /^([01]\d|2[0-3]):([0-5]\d)$/.test(String(ag.hora || '')) ? ag.hora : '09:00',
  };

  E().listas[id] = {
    id,
    nome: dados.nome !== undefined ? String(dados.nome).trim() : (ant.nome || 'Lista sem nome'),
    produtos,
    efemera,
    intervaloMin: intervalo,
    cupomModo: modo,
    cupomCodigo: modo === 'fixo'
      ? String(dados.cupomCodigo || ant.cupomCodigo || '').trim().toUpperCase() : null,
    agenda,
    ativo: dados.ativo !== undefined ? !!dados.ativo : (ant.ativo !== false),
    execucao: ant.execucao || null,
    ultimoDisparo: ant.ultimoDisparo || null,
    criadoEm: ant.criadoEm || new Date().toISOString(),
    atualizadoEm: new Date().toISOString(),
  };
  salvarListas();
  return E().listas[id];
}

export function removerLista(id) {
  if (!E().listas[id]) return false;
  delete E().listas[id];
  salvarListas();
  return true;
}

/** Grava o andamento do disparo. Persistido para sobreviver a restart do container. */
export function atualizarExecucaoLista(id, execucao) {
  if (!E().listas[id]) return null;
  E().listas[id].execucao = execucao;
  if (execucao === null) E().listas[id].ultimoDisparo = new Date().toISOString();
  salvarListas();
  return E().listas[id];
}

/** Codigo de cupom a passar para o montador, conforme o modo da lista. */
export function cupomDaLista(lista) {
  if (!lista || lista.cupomModo === 'nenhum') return null;
  if (lista.cupomModo === 'fixo') return lista.cupomCodigo || null;
  return 'auto';
}

carregarListas();

_moduloPronto = true;
