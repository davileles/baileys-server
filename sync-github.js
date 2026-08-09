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

const SESSAO_DIR = './sessao';
// Funcoes, nao constantes: o repositorio de dados pode ser trocado pelo painel
// e precisa valer no proximo push, sem restart.
function repoDados()  { return process.env.GITHUB_REPO_DADOS || 'davileles/cdv-tsp-dados'; }
function pastaDados() { return process.env.GITHUB_PASTA_DADOS || 'tsp'; }
const DEBOUNCE_MS = 10000;

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
  'awin_config.json',
  'tenants.json',            // global: registro de operadores (so na raiz)
  'grupos_censo_hist.json',
  // Ledger de entradas/saidas. O PUT aceita arquivo grande, mas a leitura via
  // Contents API para de devolver o conteudo acima de ~1MB: passando disso o
  // push continua, so a restauracao automatica no boot deixa de funcionar
  // (o local e mantido, nao corrompido). Perto do limite, virar shard por ano.
  'grupos_membros_log.json',
]);

// Compat: modulos antigos listam Object.keys() daqui; e a visao da RAIZ.
export const ARQUIVOS_SINCRONIZADOS = Object.fromEntries(
  [...NOMES_SINCRONIZAVEIS].map(n => [n, pastaDados() + '/' + n]));

// Caminho relativo valido: nome permitido na raiz, ou tenants/<id>/<nome>.
// Recusa qualquer coisa fora disso — este modulo escreve em disco e no repo,
// entao a validacao do caminho e inegociavel.
const RE_TENANT_SEG = /^[a-z0-9][a-z0-9-]{1,30}$/;
function caminhoValido(local) {
  const partes = String(local || '').split('/');
  if (partes.length === 1) return NOMES_SINCRONIZAVEIS.has(partes[0]);
  return partes.length === 3 && partes[0] === 'tenants'
      && RE_TENANT_SEG.test(partes[1])
      && NOMES_SINCRONIZAVEIS.has(partes[2])
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
const _timers = new Map();    // arquivo -> timer de debounce
let _ultimoErro = null;

export function sincronizacaoAtiva() { return !!process.env.GITHUB_TOKEN; }
export function estadoSync() {
  const t = process.env.GITHUB_TOKEN || '';
  return {
    ativo: sincronizacaoAtiva(), repo: repoDados(), pasta: pastaDados(), ultimoErro: _ultimoErro,
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

async function enviar(local) {
  if (!caminhoValido(local)) return;
  const remoto = remotoDe(local);
  const caminhoLocal = SESSAO_DIR + '/' + local;
  if (!existsSync(caminhoLocal)) return;

  try {
    const conteudo = readFileSync(caminhoLocal, 'utf-8');

    // SHA sempre fresco antes do PUT: um push concorrente invalida o anterior.
    let sha = null;
    const atual = await api(remoto);
    if (atual.ok) {
      const d = await atual.json();
      sha = d.sha;
      // Conteudo identico: nao gera commit vazio.
      if (Buffer.from(d.content, 'base64').toString('utf-8') === conteudo) { _shas.set(remoto, sha); return; }
    } else if (atual.status !== 404) {
      throw new Error('leitura falhou: HTTP ' + atual.status);
    }

    const corpo = {
      message: 'chore(tsp): atualiza ' + local,
      content: Buffer.from(conteudo, 'utf-8').toString('base64'),
      ...(sha ? { sha } : {}),
    };
    const res = await api(remoto, { method: 'PUT', body: JSON.stringify(corpo) });
    if (!res.ok) throw new Error('PUT falhou: HTTP ' + res.status + ' ' + (await res.text()).slice(0, 160));

    const d = await res.json();
    _shas.set(remoto, d.content?.sha);
    _ultimoErro = null;
    console.log('[SYNC] ' + local + ' -> ' + repoDados() + '/' + remoto);
  } catch (e) {
    _ultimoErro = local + ': ' + e.message;
    console.error('[SYNC] Falha ao enviar ' + local + ':', e.message);
  }
}

/**
 * Agenda o envio de um arquivo. Chamadas repetidas dentro da janela reiniciam
 * o timer, entao uma rajada de gravacoes vira um unico commit.
 */
export function agendarPush(local) {
  if (!sincronizacaoAtiva() || !caminhoValido(local)) return;
  if (_timers.has(local)) clearTimeout(_timers.get(local));
  _timers.set(local, setTimeout(() => {
    _timers.delete(local);
    enviar(local).catch(e => console.error('[SYNC] Erro inesperado:', e.message));
  }, DEBOUNCE_MS));
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
    await enviar(local);
    feitos.push(local);
  }
  return feitos;
}
