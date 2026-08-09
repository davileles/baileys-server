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
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac, timingSafeEqual } from 'node:crypto';

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

// ── Token de sessao por operador (fase 2.5) ─────────────────────────────────
// Cunhado pelo proxy apos o OTP por e-mail, verificado aqui por HMAC com o
// segredo compartilhado TSP_TENANT_SECRET (mesma env nos dois servicos).
// Formato: base64url(JSON{email,exp}) + '.' + hmacSHA256hex.
export function verificarTokenTenant(bruto) {
  const secret = process.env.TSP_TENANT_SECRET || '';
  const tk = String(bruto || '').trim();
  if (!secret || !tk) return null;
  const ponto = tk.lastIndexOf('.');
  if (ponto < 1) return null;
  const payload = tk.slice(0, ponto), assinatura = tk.slice(ponto + 1);
  const esperada = createHmac('sha256', secret).update(payload).digest('hex');
  try {
    if (!timingSafeEqual(Buffer.from(assinatura, 'hex'), Buffer.from(esperada, 'hex'))) return null;
  } catch { return null; }
  try {
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
    if (!d.email || !d.exp || Date.now() > d.exp) return null;
    return { email: String(d.email).toLowerCase(), exp: d.exp };
  } catch { return null; }
}

// Extrai e valida o token da requisicao. Query string existe para paginas
// abertas em aba propria (QR, /tg-auth), que nao mandam header.
// Retorno: payload | null (sem token — superficie publica legada, cai na raiz)
// | false (token presente mas invalido/expirado — 401, NUNCA cair na raiz:
// sessao vencida de um operador operando os dados de outro seria gravissimo).
export function tokenDaReq(req) {
  const bruto = req?.headers?.['x-tsp-token'] || req?.query?.tsp_token || '';
  if (!bruto) return null;
  return verificarTokenTenant(bruto) || false;
}

// Resolucao por requisicao: token valido manda; sem token, operacao padrao
// (compatibilidade com toda a superficie publica existente).
export function resolverTenant(req) {
  const tk = tokenDaReq(req);
  if (tk === false || tk === null) return tk === false ? null : tenantPorId(TENANT_PADRAO);
  return tenantPorEmail(tk.email) || null;
}

// ── Contexto de tenant por cadeia de execucao ────────────────────────────────
// AsyncLocalStorage propaga o operador atraves de awaits: o middleware abre o
// contexto na requisicao e todo o processamento dela (mesmo assincrono) enxerga
// o mesmo tenant. Codigo fora de requisicao (pipelines de captura, workers)
// roda sem contexto e os modulos caem no tenant padrao — exatamente a operacao
// original, ate as fases 2.3/2.4 amarrarem cada pipeline ao seu operador.
const _ctx = new AsyncLocalStorage();
export function comContextoTenant(tenantId, fn) { return _ctx.run(tenantId, fn); }
export function tenantContexto() { return _ctx.getStore() || null; }

// Auto-carrega no import, como os demais modulos de dados.
carregarTenants();
