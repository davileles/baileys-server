// ═══════════════════════════════════════════════════════════════════════════
// sync-github.js — durabilidade dos dados de negocio no repositorio.
//
// Os arquivos de ./sessao continuam sendo a fonte de leitura (sincrona, rapida,
// sem latencia no meio de uma captura). Este modulo acrescenta duas coisas:
//
//   1. No boot, baixa a versao do GitHub e reescreve o disco — assim o servico
//      sobrevive a perda do volume do Railway.
//   2. A cada gravacao, agenda um push com debounce. O debounce e essencial:
//      uma mensagem do Telegram com varios cupons grava cinco vezes no mesmo
//      segundo, e sem agrupar isso viraria cinco commits.
//
// Credenciais e sempre estado de runtime (creds do WhatsApp, fila, dedup) NAO
// entram aqui: nao se versiona o que muda a cada segundo.
//
// Requisitos no Railway:
//   GITHUB_TOKEN        PAT com escrita no repositorio de dados
//   GITHUB_REPO_DADOS   ex: davileles/cdv-tsp-dados
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';

const SESSAO_DIR = './sessao';
// Funcoes, nao constantes: o repositorio de dados pode ser trocado pelo painel
// e precisa valer no proximo push, sem restart.
function repoDados()  { return process.env.GITHUB_REPO_DADOS || 'davileles/cdv-tsp-dados'; }
function pastaDados() { return process.env.GITHUB_PASTA_DADOS || 'tsp'; }
// 3 min (era 10 s ate 13/11/2026). Cada envio manda o ARQUIVO INTEIRO em
// base64 para a Contents API (nao ha envio parcial), e arquivos de ~1 MB que
// mudam a todo disparo (historico de envios, serie de precos, vitrine) subiam
// varias vezes por minuto: o baileys-server fez 512 GB de egress num ciclo do
// Railway (US$ 25,59). O flush do SIGTERM segue subindo o que estiver
// pendente, entao deploy nao perde gravacao.
const DEBOUNCE_MS = 3 * 60000;

// Nomes de arquivo versionaveis. Na raiz de ./sessao pertencem ao tenant
// padrao (operacao original — layout historico, sem migracao); em
// ./sessao/tenants/<id>/ pertencem ao operador <id> e vao para
// <pasta>/tenants/<id>/ no repo. `agendarPush` aceita os dois formatos:
// 'config_tsp.json' ou 'tenants/acme/config_tsp.json'.
export const NOMES_SINCRONIZAVEIS = new Set([
  'cupons_base.json',
  'vitrine.json',
  'templates.json',
  'listas.json',
  'radar_config.json',
  'config_tsp.json',
  // Config da operacao CDV: destinos, grupos monitorados, admins e conta de
  // disparo. Mesmo peso do config_tsp — perdido, o CDV volta aos valores de
  // fabrica e para de monitorar o que o operador cadastrou em tela.
  'config_cdv.json',
  'awin_config.json',
  'tenants.json',            // global: registro de operadores (so na raiz)
  'grupos_censo_hist.json',
  // Ledger de entradas/saidas. O PUT aceita arquivo grande, mas a leitura via
  // Contents API para de devolver o conteudo acima de ~1MB: passando disso o
  // push continua, so a restauracao automatica no boot deixa de funcionar
  // (o local e mantido, nao corrompido). Perto do limite, virar shard por ano.
  'grupos_membros_log.json',
  // Ledger ref -> produto do rastreio de desempenho. Precisa sobreviver a
  // deploy: sem ele o relatorio da Amazon fica ilegivel, porque a tag
  // sozinha nao diz qual produto foi divulgado naquele dia.
  'rastreio.json',
  // Taxonomia dos grupos de nicho e o cache asin -> trilha. A taxonomia e
  // editada a mao no repo (nao exige deploy); o cache e escrito pelo servidor.
  'categorias.json',
  'categorias_cache.json',
  // Monitor de queda de preco: configuracao, serie diaria de precos e estado
  // (fila de candidatos + cotas do dia). A serie e o ativo mais caro de
  // reconstruir — sem ela o gatilho volta a zero e leva dias para amadurecer.
  'monitor_precos_config.json',
  'precos_hist.json',
  'monitor_precos_estado.json',
  // Ledger de ganho por clique por ASIN, escrito pelo coletor (GitHub Actions)
  // e apenas LIDO aqui. Entra na lista para ser baixado no boot; o servidor
  // nunca chama agendarPush para ele, entao as duas pontas nunca escrevem
  // o mesmo arquivo.
  'epc-produtos.json',
  // Carimbo da sonda diaria da pagina do ML: {em, bloqueado, bloqueadoDesde}.
  // TEM de sobreviver a restart — o filesystem local nao dura, e sem o carimbo
  // cada boot dispara sonda nova. Em 28/08 o Railway reiniciou sozinho no meio
  // do dia e a "uma consulta por dia" virou duas.
  'ml_sonda_pagina.json',
  // Links fixos rastreados (resgate de cupons, Prime...): codigo permanente por
  // link. Perdido, cada link ganharia codigo novo e os cliques se partiriam.
  'links_fixos.json',
  // Avisos de preco no privado (avisos-preco.js): pedidos dos clientes, com
  // nome e telefone. Vai para o repo PRIVADO de dados, como todo o resto daqui.
  'avisos_preco.json',
]);

// Compat: modulos antigos listam Object.keys() daqui; e a visao da RAIZ.
export const ARQUIVOS_SINCRONIZADOS = Object.fromEntries(
  [...NOMES_SINCRONIZAVEIS].map(n => [n, pastaDados() + '/' + n]));

// Shards mensais do historico de envios (historico_envios_2026-08.json).
// Nome dinamico por natureza — nao cabe no Set fixo. Sao shardados por mes
// justamente por causa do limite de ~1MB da Contents API na leitura: um unico
// arquivo de historico cresceria alem disso em poucos meses e a restauracao
// pos-deploy pararia de funcionar.
const RE_NOME_HISTORICO = /^historico_envios_\d{4}-\d{2}\.json$/;
// Shards mensais da serie de precos (precos_hist_2026-08.json). Mesmo motivo do
// historico de envios: a serie diaria de cada produto cresce ate 120 dias e,
// com a serie efetiva em paralelo, um arquivo unico passaria de 1 MB em poucos
// meses — e acima disso a Contents API para de devolver o conteudo na leitura,
// matando a restauracao pos-deploy em silencio.
const RE_NOME_PRECOS = /^precos_hist_\d{4}-\d{2}\.json$/;
// Shards diarios do mapa de links rastreados (links_rastreio_2026-09-15.json).
// Diario, e nao mensal, porque o proxy le o shard no clique quando o servidor
// esta fora: arquivo pequeno = fallback rapido. Sobem por agendarPush e sao
// restaurados sob demanda por baixarArquivoDoGitHub (links-rastreio.js).
const RE_NOME_LINKS = /^links_rastreio_\d{4}-\d{2}-\d{2}\.json$/;
function nomeSincronizavel(nome) {
  return NOMES_SINCRONIZAVEIS.has(nome) || RE_NOME_HISTORICO.test(nome) || RE_NOME_PRECOS.test(nome)
      || RE_NOME_LINKS.test(nome);
}

// Caminho relativo valido: nome permitido na raiz, ou tenants/<id>/<nome>.
// Recusa qualquer coisa fora disso — este modulo escreve em disco e no repo,
// entao a validacao do caminho e inegociavel.
const RE_TENANT_SEG = /^[a-z0-9][a-z0-9-]{1,30}$/;
function caminhoValido(local) {
  const partes = String(local || '').split('/');
  if (partes.length === 1) return nomeSincronizavel(partes[0]);
  return partes.length === 3 && partes[0] === 'tenants'
      && RE_TENANT_SEG.test(partes[1])
      && nomeSincronizavel(partes[2])
      && partes[2] !== 'tenants.json';
}
// Dinamico de proposito: o repositorio/pasta podem mudar pelo painel.
function remotoDe(local) { return pastaDados() + '/' + local; }

// Ids de operadores alem do padrao, lidos de sessao/tenants.json. Leitura
// direta do disco (sem importar tenants.js) para nao criar ciclo de modulos.
function _idsTenantsDoDisco() {
  try {
    const reg = JSON.parse(readFileSync(SESSAO_DIR + '/tenants.json', 'utf-8'));
    return (reg.tenants || []).map(t => String(t.id || '').toLowerCase())
      .filter(id => RE_TENANT_SEG.test(id) && id !== 'tsp');
  } catch { return []; }
}

const _shas = new Map();      // caminho no repo -> sha do ultimo commit conhecido
// Hash do conteudo do ultimo envio bem-sucedido de cada arquivo, neste boot.
const _ultimoHash = new Map();
// Bytes enviados por arquivo desde o boot (corpo do PUT). Lido pelo GET /egress.
const _enviosPorArquivo = new Map();   // local -> { envios, bytes, iguais }
function _contarEnvio(local, bytes, igual) {
  const r = _enviosPorArquivo.get(local) || { envios: 0, bytes: 0, iguais: 0 };
  if (igual) r.iguais += 1; else { r.envios += 1; r.bytes += bytes; }
  _enviosPorArquivo.set(local, r);
}
export function enviosPorArquivo() {
  return [..._enviosPorArquivo.entries()]
    .map(([arquivo, v]) => ({ arquivo, mb: Math.round(v.bytes / 1048576 * 10) / 10, envios: v.envios, semMudanca: v.iguais }))
    .sort((a, b) => b.mb - a.mb);
}
const _timers = new Map();    // arquivo -> timer de debounce (ou de nova tentativa)
let _ultimoErro = null;

// ── FILA DE ENVIO + NOVA TENTATIVA ─────────────────────────────────────────
// Antes cada arquivo subia no seu proprio timer, todos ao mesmo tempo: um item
// de lista grava listas.json, historico de envios, rastreio, links_fixos e a
// serie de precos no mesmo segundo, e os cinco PUTs na Contents API disputavam
// a mesma branch. O GitHub recusa parte deles (409) e o arquivo recusado nao
// era reenviado — ficava velho no repo ate a proxima gravacao. No boot seguinte
// baixarDoGitHub() reescrevia o disco com a copia velha. Em 05/11/2026 isso fez
// a lista "Quinta - Shopee" voltar 3 itens a cada deploy (11:27, 11:46, 12:09)
// e a mesma caneleira saiu 4 vezes nos grupos.
// Agora: um envio por vez (fila unica) e, se falhar, o arquivo volta para o
// debounce com espera crescente (10 s, 20 s, 40 s... ate 5 min) ate subir.
// Enquanto nao sobe, ele aparece em pushesPendentes() e o flush do SIGTERM
// tenta de novo.
let _filaEnvio = Promise.resolve();
const _naFila = new Set();     // arquivos ja na fila, esperando a vez
const _falhas = new Map();     // arquivo -> tentativas seguidas que falharam
const RETRY_BASE_MS = 10000;
const RETRY_TETO_MS = 5 * 60000;

function enfileirarEnvio(local) {
  _naFila.add(local);
  const passo = async () => {
    _naFila.delete(local);
    return enviar(local);
  };
  const p = _filaEnvio.then(passo, passo);
  _filaEnvio = p.catch(() => {});
  return p;
}

async function enviarComNovaTentativa(local) {
  const ok = await enfileirarEnvio(local);
  if (ok) { _falhas.delete(local); return true; }
  const n = (_falhas.get(local) || 0) + 1;
  _falhas.set(local, n);
  // Gravacao nova no meio da espera ja reagendou o arquivo: nao duplica.
  if (_timers.has(local)) return false;
  const espera = Math.min(RETRY_BASE_MS * 2 ** (n - 1), RETRY_TETO_MS);
  console.warn('[SYNC] ' + local + ' nao subiu (tentativa ' + n + '); nova tentativa em '
    + Math.round(espera / 1000) + ' s.');
  _timers.set(local, setTimeout(() => {
    _timers.delete(local);
    enviarComNovaTentativa(local).catch(e => console.error('[SYNC] Erro inesperado:', e.message));
  }, espera));
  return false;
}

export function sincronizacaoAtiva() { return !!process.env.GITHUB_TOKEN; }
export function estadoSync() {
  const t = process.env.GITHUB_TOKEN || '';
  return {
    ativo: sincronizacaoAtiva(), repo: repoDados(), pasta: pastaDados(), ultimoErro: _ultimoErro,
    pendentes: pushesPendentes(),
    falhando: Object.fromEntries(_falhas),
    arquivos: Object.keys(ARQUIVOS_SINCRONIZADOS),
    // Diagnostico sem vazar o segredo: so presenca, tamanho e prefixo. Variavel
    // adicionada no Railway so entra no processo apos o restart do container.
    diagnostico: {
      GITHUB_TOKEN_presente: !!t,
      GITHUB_TOKEN_tamanho: t.length,
      GITHUB_TOKEN_prefixo: t ? t.slice(0, 11) + '…' : null,
      GITHUB_REPO_DADOS: process.env.GITHUB_REPO_DADOS || '(usando padrao)',
      variaveis_github_vistas: Object.keys(process.env).filter(k => /GITHUB|GH_/i.test(k)).sort(),
    },
  };
}

/** Testa credencial e permissao de escrita sem alterar nada. */
export async function testarAcesso() {
  if (!sincronizacaoAtiva()) return { ok: false, erro: 'GITHUB_TOKEN ausente no processo.' };
  try {
    const res = await fetch('https://api.github.com/repos/' + repoDados(), {
      headers: { 'Authorization': 'Bearer ' + process.env.GITHUB_TOKEN, 'Accept': 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { ok: false, erro: 'HTTP ' + res.status + ' ao ler ' + repoDados() };
    const d = await res.json();
    return { ok: true, repo: d.full_name, privado: d.private, permissoes: d.permissions || null };
  } catch (e) { return { ok: false, erro: e.message }; }
}

async function api(caminho, opcoes = {}) {
  const res = await fetch('https://api.github.com/repos/' + repoDados() + '/contents/' + caminho, {
    ...opcoes,
    headers: {
      'Authorization': 'Bearer ' + process.env.GITHUB_TOKEN,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      ...(opcoes.headers || {}),
    },
    signal: AbortSignal.timeout(20000),
  });
  return res;
}

/**
 * Baixa os arquivos do repositorio e reescreve ./sessao.
 * Arquivo ausente no repo e normal na primeira execucao: mantem o local e ele
 * sobe no primeiro push.
 */
export async function baixarDoGitHub() {
  if (!sincronizacaoAtiva()) {
    console.log('[SYNC] GITHUB_TOKEN ausente — dados ficam apenas no volume do Railway.');
    return { baixados: 0, ausentes: [], erros: [] };
  }
  if (!existsSync(SESSAO_DIR)) mkdirSync(SESSAO_DIR, { recursive: true });

  let baixados = 0; const ausentes = [], erros = [];
  async function baixarUm(local) {
    try {
      const res = await api(remotoDe(local));
      if (res.status === 404) { ausentes.push(local); return; }
      if (!res.ok) { erros.push(local + ': HTTP ' + res.status); return; }
      const dados = await res.json();
      _shas.set(remotoDe(local), dados.sha);
      const conteudo = Buffer.from(dados.content, 'base64').toString('utf-8');
      JSON.parse(conteudo);                       // nao sobrescreve o local com lixo
      const destino = SESSAO_DIR + '/' + local;
      const dir = destino.slice(0, destino.lastIndexOf('/'));
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(destino, conteudo, 'utf-8');
      _ultimoHash.set(local, createHash('sha1').update(conteudo).digest('hex'));
      baixados++;
    } catch (e) { erros.push(local + ': ' + e.message); }
  }
  // 1) Raiz — dados do tenant padrao + registro de operadores. O registro desce
  // junto desta leva, entao a enumeracao abaixo ja enxerga operadores novos.
  for (const local of NOMES_SINCRONIZAVEIS) await baixarUm(local);
  // 2) Pastas dos demais operadores.
  for (const id of _idsTenantsDoDisco()) {
    for (const nome of NOMES_SINCRONIZAVEIS) {
      if (nome === 'tenants.json') continue;
      await baixarUm('tenants/' + id + '/' + nome);
    }
  }
  console.log('[SYNC] Boot — ' + baixados + ' arquivo(s) do GitHub, ' + ausentes.length +
    ' ausente(s) no repo' + (erros.length ? ', ' + erros.length + ' erro(s): ' + erros.join('; ') : '') + '.');
  return { baixados, ausentes, erros };
}

/**
 * Baixa UM arquivo do repositorio para ./sessao, sob demanda. Existe para os
 * shards de historico: eles nao entram na varredura do boot (nome dinamico),
 * entao quem for dar append precisa restaurar o shard do mes antes da primeira
 * gravacao num volume novo — senao o primeiro envio do mes sobrescreveria o
 * historico ja acumulado no repo.
 */
export async function baixarArquivoDoGitHub(local) {
  if (!sincronizacaoAtiva() || !caminhoValido(local)) return false;
  try {
    const res = await api(remotoDe(local));
    if (!res.ok) return false;
    const dados = await res.json();
    _shas.set(remotoDe(local), dados.sha);
    const conteudo = Buffer.from(dados.content, 'base64').toString('utf-8');
    JSON.parse(conteudo);                       // nao grava lixo no disco
    const destino = SESSAO_DIR + '/' + local;
    const dir = destino.slice(0, destino.lastIndexOf('/'));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(destino, conteudo, 'utf-8');
    _ultimoHash.set(local, createHash('sha1').update(conteudo).digest('hex'));
    return true;
  } catch { return false; }
}

// Devolve true quando o repo ficou igual ao disco (subiu ou ja era igual) e
// false quando falhou — quem chama decide se tenta de novo.
async function enviar(local) {
  if (!caminhoValido(local)) return true;
  const remoto = remotoDe(local);
  const caminhoLocal = SESSAO_DIR + '/' + local;
  if (!existsSync(caminhoLocal)) return true;

  try {
    const conteudo = readFileSync(caminhoLocal, 'utf-8');
    const hash = createHash('sha1').update(conteudo).digest('hex');

    // Igual ao ultimo envio deste boot: nada a fazer (nem o GET).
    if (_ultimoHash.get(local) === hash) { _contarEnvio(local, 0, true); return true; }

    // Atalho (13/11/2026): com o sha do ultimo commit conhecido, tenta o PUT
    // direto, sem o GET que baixava o arquivo inteiro antes de cada envio —
    // metade das chamadas e do tempo, o que importa no flush do SIGTERM (teto
    // de 20 s). Sha velho (alguem escreveu no meio) = 409/422 e cai no caminho
    // completo abaixo, que le o sha fresco.
    const shaConhecido = _shas.get(remoto);
    if (shaConhecido) {
      const corpoJson = JSON.stringify({
        message: 'chore(tsp): atualiza ' + local,
        content: Buffer.from(conteudo, 'utf-8').toString('base64'),
        sha: shaConhecido,
      });
      const r = await api(remoto, { method: 'PUT', body: corpoJson });
      _contarEnvio(local, Buffer.byteLength(corpoJson), false);
      if (r.ok) {
        const d = await r.json();
        _shas.set(remoto, d.content?.sha);
        _ultimoHash.set(local, hash);
        _ultimoErro = null;
        console.log('[SYNC] ' + local + ' -> ' + repoDados() + '/' + remoto);
        return true;
      }
      if (r.status !== 409 && r.status !== 422) throw new Error('PUT falhou: HTTP ' + r.status + ' ' + (await r.text()).slice(0, 160));
      _shas.delete(remoto);
    }

    // SHA sempre fresco antes do PUT: um push concorrente invalida o anterior.
    let sha = null;
    const atual = await api(remoto);
    if (atual.ok) {
      const d = await atual.json();
      sha = d.sha;
      // Conteudo identico: nao gera commit vazio.
      if (Buffer.from(d.content, 'base64').toString('utf-8') === conteudo) { _shas.set(remoto, sha); _ultimoHash.set(local, hash); _contarEnvio(local, 0, true); return true; }
    } else if (atual.status !== 404) {
      throw new Error('leitura falhou: HTTP ' + atual.status);
    }

    const corpo = {
      message: 'chore(tsp): atualiza ' + local,
      content: Buffer.from(conteudo, 'utf-8').toString('base64'),
      ...(sha ? { sha } : {}),
    };
    const corpoJson = JSON.stringify(corpo);
    const res = await api(remoto, { method: 'PUT', body: corpoJson });
    _contarEnvio(local, Buffer.byteLength(corpoJson), false);
    if (!res.ok) throw new Error('PUT falhou: HTTP ' + res.status + ' ' + (await res.text()).slice(0, 160));

    const d = await res.json();
    _shas.set(remoto, d.content?.sha);
    _ultimoHash.set(local, hash);
    _ultimoErro = null;
    console.log('[SYNC] ' + local + ' -> ' + repoDados() + '/' + remoto);
    return true;
  } catch (e) {
    _ultimoErro = local + ': ' + e.message;
    console.error('[SYNC] Falha ao enviar ' + local + ':', e.message);
    return false;
  }
}

/**
 * Agenda o envio de um arquivo. Chamadas repetidas dentro da janela reiniciam
 * o timer, entao uma rajada de gravacoes vira um unico commit.
 */
export function agendarPush(local) {
  if (!sincronizacaoAtiva() || !caminhoValido(local)) return;
  // Janela FIXA (desde 13/11/2026): a primeira gravacao agenda o envio e as
  // seguintes pegam carona — o envio le o disco na hora e leva a versao mais
  // nova. Antes cada gravacao reiniciava o timer; com 3 min, arquivo gravado a
  // todo minuto nunca subiria. Timer de nova tentativa tambem conta como
  // agendado.
  if (_timers.has(local)) return;
  _timers.set(local, setTimeout(() => {
    _timers.delete(local);
    enviarComNovaTentativa(local).catch(e => console.error('[SYNC] Erro inesperado:', e.message));
  }, DEBOUNCE_MS));
}

/** Arquivos gravados no disco que ainda nao subiram (debounce, fila ou nova tentativa). */
export function pushesPendentes() { return [...new Set([..._timers.keys(), ..._naFila])]; }

/**
 * Envia AGORA so o que esta no debounce. Existe para o encerramento: o Railway
 * manda SIGTERM e derruba o processo em seguida, entao gravacao feita nos
 * ultimos DEBOUNCE_MS so existe no disco do container. No boot seguinte
 * baixarDoGitHub() reescreve o disco com a versao do repositorio e a gravacao
 * some — o registro volta a um estado anterior, com atualizadoEm no passado.
 * Diferente de pushImediato(), nao varre todos os arquivos: no encerramento ha
 * poucos segundos, e cada arquivo custa um GET mais um PUT.
 */
export async function flushPushesPendentes() {
  const pendentes = pushesPendentes();
  // Cancela os timers antes de enviar: se o processo sobreviver, o envio ja
  // aconteceu e o timer dispararia um segundo PUT identico.
  // Os que ja estao na fila saem pela propria fila; os do debounce entram nela.
  for (const local of pendentes) {
    if (_timers.has(local)) { clearTimeout(_timers.get(local)); _timers.delete(local); }
  }
  for (const local of pendentes) if (!_naFila.has(local)) enfileirarEnvio(local);
  await _filaEnvio;
  return pendentes;
}

/** Envia tudo imediatamente, ignorando o debounce. Usado pelo endpoint manual. */
export async function pushImediato() {
  const feitos = [];
  const alvos = [...NOMES_SINCRONIZAVEIS];
  for (const id of _idsTenantsDoDisco()) {
    for (const nome of NOMES_SINCRONIZAVEIS) {
      if (nome !== 'tenants.json') alvos.push('tenants/' + id + '/' + nome);
    }
  }
  for (const local of alvos) {
    if (_timers.has(local)) { clearTimeout(_timers.get(local)); _timers.delete(local); }
    if (await enfileirarEnvio(local)) _falhas.delete(local);
    feitos.push(local);
  }
  return feitos;
}
