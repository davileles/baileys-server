// ═══════════════════════════════════════════════════════════════════════════
// tenants.js — registro dos operadores do modelo hospedado (fase 2.1).
//
// Cada tenant e um operador com a propria operacao: numero de WhatsApp, conta
// do Telegram, config, dados e acesso ao painel. Este modulo e so o REGISTRO
// (quem existe, esta ativo, com quais e-mails entra); o isolamento de dados e
// conexoes vem nas fases seguintes.
//
// Nesta fase, todo o trafego resolve para o tenant padrao ('tsp' — a operacao
// original), preservando o comportamento atual byte a byte. A resolucao por
// requisicao ja existe (req.tenantId) para os proximos passos plugarem nela.
//
// Mesmo padrao de persistencia dos demais dados: ./sessao + push para o repo.
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { agendarPush } from './sync-github.js';

const SESSAO_DIR   = './sessao';
const TENANTS_PATH = SESSAO_DIR + '/tenants.json';

// Tenant da operacao original. Enquanto a resolucao por login nao chega
// (fase 2.5), toda requisicao e atendida como ele.
export const TENANT_PADRAO = 'tsp';

// Seed = a operacao existente. Um deploy sem arquivo em disco se comporta
// exatamente como antes do registro existir.
const SEED = {
  tenants: [{
    id: 'tsp',
    nome: 'Tudo Sobre Promos',
    emails: ['davileles@gmail.com'],
    ativo: true,
    criadoEm: '2026-08-09T00:00:00.000Z',
  }],
};

let _reg = JSON.parse(JSON.stringify(SEED));

function normalizar(bruto) {
  const lista = Array.isArray(bruto?.tenants) ? bruto.tenants : [];
  const vistos = new Set();
  const tenants = [];
  for (const t of lista) {
    const id = String(t?.id || '').trim().toLowerCase();
    if (!RE_ID.test(id) || vistos.has(id)) continue;
    vistos.add(id);
    tenants.push({
      id,
      nome: String(t.nome || id).trim() || id,
      emails: Array.isArray(t.emails)
        ? [...new Set(t.emails.map(e => String(e).trim().toLowerCase()).filter(e => e.includes('@')))]
        : [],
      ativo: t.ativo !== false,
      criadoEm: t.criadoEm || new Date().toISOString(),
    });
  }
  // O tenant padrao nunca pode sumir do registro: e a operacao que sustenta o
  // fallback de resolucao. Se um arquivo corrompido/editado o remover, resemeia.
  if (!vistos.has(TENANT_PADRAO)) tenants.unshift(JSON.parse(JSON.stringify(SEED.tenants[0])));
  return { tenants };
}

const RE_ID = /^[a-z0-9][a-z0-9-]{1,30}$/;

export function carregarTenants() {
  try {
    if (existsSync(TENANTS_PATH)) {
      _reg = normalizar(JSON.parse(readFileSync(TENANTS_PATH, 'utf-8')));
      console.log('[TENANTS] ' + _reg.tenants.length + ' operador(es) no registro.');
    } else {
      _reg = normalizar(SEED);
      console.log('[TENANTS] Sem registro em disco — semeando com a operacao original.');
      persistir();
    }
  } catch (e) {
    console.log('[TENANTS] Erro ao carregar registro:', e.message);
  }
  return _reg;
}

function persistir() {
  try {
    writeFileSync(TENANTS_PATH, JSON.stringify(_reg, null, 2), 'utf-8');
    agendarPush('tenants.json');
  } catch (e) { console.log('[TENANTS] Erro ao salvar registro:', e.message); }
}

export function listarTenants() { return _reg.tenants.map(t => ({ ...t, emails: [...t.emails] })); }
export function tenantPorId(id) {
  const alvo = String(id || '').trim().toLowerCase();
  return _reg.tenants.find(t => t.id === alvo) || null;
}
export function tenantPorEmail(email) {
  const alvo = String(email || '').trim().toLowerCase();
  if (!alvo) return null;
  return _reg.tenants.find(t => t.ativo && t.emails.includes(alvo)) || null;
}

export function criarTenant({ id, nome, emails } = {}) {
  const novoId = String(id || '').trim().toLowerCase();
  if (!RE_ID.test(novoId)) throw new Error('id invalido: use 2-31 caracteres, letras minusculas, numeros e hifen.');
  if (tenantPorId(novoId)) throw new Error('ja existe um operador com o id "' + novoId + '".');
  const t = normalizar({ tenants: [{ id: novoId, nome, emails, ativo: true }] }).tenants
    .find(x => x.id === novoId);
  _reg.tenants.push(t);
  persistir();
  return { ...t };
}

export function atualizarTenant(id, patch = {}) {
  const t = tenantPorId(id);
  if (!t) throw new Error('operador "' + id + '" nao encontrado.');
  if (patch.nome !== undefined)   t.nome = String(patch.nome).trim() || t.id;
  if (patch.emails !== undefined) t.emails = normalizar({ tenants: [{ ...t, emails: patch.emails }] }).tenants[0].emails;
  if (patch.ativo !== undefined) {
    // Desativar o tenant padrao derrubaria a resolucao de TODO o trafego atual.
    if (t.id === TENANT_PADRAO && patch.ativo === false) {
      throw new Error('o operador padrao nao pode ser desativado.');
    }
    t.ativo = patch.ativo !== false;
  }
  persistir();
  return { ...t };
}

// Resolucao por requisicao. Fase 2.1: sempre o tenant padrao — o parametro
// existe para as fases seguintes trocarem a origem (token de sessao do login)
// sem mexer nos pontos de uso.
export function resolverTenant(_req) {
  return tenantPorId(TENANT_PADRAO);
}

// Auto-carrega no import, como os demais modulos de dados.
carregarTenants();
