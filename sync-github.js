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
const REPO = process.env.GITHUB_REPO_DADOS || 'davileles/cdv-tsp-dados';
const PASTA = process.env.GITHUB_PASTA_DADOS || 'tsp';
const DEBOUNCE_MS = 10000;

// Arquivos versionados. Chave = nome em ./sessao, valor = caminho no repo.
export const ARQUIVOS_SINCRONIZADOS = {
  'cupons_base.json': PASTA + '/cupons_base.json',
  'vitrine.json':     PASTA + '/vitrine.json',
  'templates.json':   PASTA + '/templates.json',
  'radar_config.json':PASTA + '/radar_config.json',
};

const _shas = new Map();      // caminho no repo -> sha do ultimo commit conhecido
const _timers = new Map();    // arquivo -> timer de debounce
let _ultimoErro = null;

export function sincronizacaoAtiva() { return !!process.env.GITHUB_TOKEN; }
export function estadoSync() {
  const t = process.env.GITHUB_TOKEN || '';
  return {
    ativo: sincronizacaoAtiva(), repo: REPO, pasta: PASTA, ultimoErro: _ultimoErro,
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
    const res = await fetch('https://api.github.com/repos/' + REPO, {
      headers: { 'Authorization': 'Bearer ' + process.env.GITHUB_TOKEN, 'Accept': 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { ok: false, erro: 'HTTP ' + res.status + ' ao ler ' + REPO };
    const d = await res.json();
    return { ok: true, repo: d.full_name, privado: d.private, permissoes: d.permissions || null };
  } catch (e) { return { ok: false, erro: e.message }; }
}

async function api(caminho, opcoes = {}) {
  const res = await fetch('https://api.github.com/repos/' + REPO + '/contents/' + caminho, {
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
  for (const [local, remoto] of Object.entries(ARQUIVOS_SINCRONIZADOS)) {
    try {
      const res = await api(remoto);
      if (res.status === 404) { ausentes.push(local); continue; }
      if (!res.ok) { erros.push(local + ': HTTP ' + res.status); continue; }
      const dados = await res.json();
      _shas.set(remoto, dados.sha);
      const conteudo = Buffer.from(dados.content, 'base64').toString('utf-8');
      JSON.parse(conteudo);                       // nao sobrescreve o local com lixo
      writeFileSync(SESSAO_DIR + '/' + local, conteudo, 'utf-8');
      baixados++;
    } catch (e) { erros.push(local + ': ' + e.message); }
  }
  console.log('[SYNC] Boot — ' + baixados + ' arquivo(s) do GitHub, ' + ausentes.length +
    ' ausente(s) no repo' + (erros.length ? ', ' + erros.length + ' erro(s): ' + erros.join('; ') : '') + '.');
  return { baixados, ausentes, erros };
}

async function enviar(local) {
  const remoto = ARQUIVOS_SINCRONIZADOS[local];
  const caminhoLocal = SESSAO_DIR + '/' + local;
  if (!remoto || !existsSync(caminhoLocal)) return;

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
    console.log('[SYNC] ' + local + ' -> ' + REPO + '/' + remoto);
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
  if (!sincronizacaoAtiva() || !ARQUIVOS_SINCRONIZADOS[local]) return;
  if (_timers.has(local)) clearTimeout(_timers.get(local));
  _timers.set(local, setTimeout(() => {
    _timers.delete(local);
    enviar(local).catch(e => console.error('[SYNC] Erro inesperado:', e.message));
  }, DEBOUNCE_MS));
}

/** Envia tudo imediatamente, ignorando o debounce. Usado pelo endpoint manual. */
export async function pushImediato() {
  const feitos = [];
  for (const local of Object.keys(ARQUIVOS_SINCRONIZADOS)) {
    if (_timers.has(local)) { clearTimeout(_timers.get(local)); _timers.delete(local); }
    await enviar(local);
    feitos.push(local);
  }
  return feitos;
}
