// ═══════════════════════════════════════════════════════════════════════════
// config-tsp.js — configuracao da operacao, POR OPERADOR (fase 2.2a).
//
// Cada tenant tem a propria config (links de afiliado, rodapes, grupos,
// blacklist do Telegram, credenciais). O tenant padrao ('tsp', a operacao
// original) mantem o layout historico em ./sessao/config_tsp.json — sem
// migracao, sem risco; os demais vivem em ./sessao/tenants/<id>/.
//
// Todas as funcoes aceitam um tenantId opcional com padrao 'tsp': os pontos
// de uso existentes (pipelines de captura, formatadores, GRUPOS) continuam
// exatamente como estao e passam a receber contexto nas fases 2.3/2.4.
//
// Credenciais: para o tenant padrao continuam injetadas em process.env (os
// radares leem env na hora da chamada). Para os demais tenants elas ficam
// armazenadas e mascaradas, e passam a ser usadas na fase 2.3 (passagem por
// contexto) — injetar env de N operadores num processo so seria colisao.
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { agendarPush } from './sync-github.js';

const SESSAO_DIR = './sessao';
// Mesmo valor de TENANT_PADRAO em tenants.js. Nao importamos de la para este
// modulo nao depender do registro (e o registro ja depende do sync).
const TENANT_RAIZ = 'tsp';
const RE_TENANT = /^[a-z0-9][a-z0-9-]{1,30}$/;

function caminhoLocalDe(tenantId) {
  return tenantId === TENANT_RAIZ
    ? SESSAO_DIR + '/config_tsp.json'
    : SESSAO_DIR + '/tenants/' + tenantId + '/config_tsp.json';
}
function caminhoPushDe(tenantId) {
  return tenantId === TENANT_RAIZ ? 'config_tsp.json' : 'tenants/' + tenantId + '/config_tsp.json';
}

// Valores padrao = operacao original, o "primeiro usuario" do modelo hospedado.
// Um tenant novo nasce com links/rodapes VAZIOS (nada de comissao alheia por
// engano); so o padrao herda os valores historicos como fallback.
const CFG_TSP_PADRAO = {
  branding: {
    nome: 'Tudo Sobre Promos',
  },
  afiliados: {
    amazon:       'https://amzn.to/4dFRSzy',
    mercadolivre: 'https://meli.la/2xystLt',
    shopee_sem:   'https://s.shopee.com.br/9fHPmP3QZF',   // pagina de cupons (sem codigo)
    shopee_com:   'https://s.shopee.com.br/30kdYeLY0W',   // oferta com codigo
    magalu:       'https://magazineluiza.onelink.me/589508454/3jdc7bbv',
    zedelivery:   'https://ze.onelink.me/qZhP/p8z09c1x',
  },
  rodapes: {
    cupom:       '`Convide seus amigos para entrar aqui no grupo: https://chat.whatsapp.com/HK7NL13BdPXKJPAGtvTKKg`',
    oferta:      '`Convide seus amigos para entrar aqui no grupo:  https://chat.whatsapp.com/Ia5ZTqeTJdXHG5OT9LUwz8`',
    grupoCupons: '`Entre no grupo de ofertas: https://chat.whatsapp.com/C7ed3Z1tYIb980POo9MqF8?s=cl&p=i&ilr=4`',
  },
  grupos: {
    padrao:   '120363424721106736@g.us',
    cupons:   '120363410183381243@g.us',
    operador: '120363409136599326@g.us',
  },
  telegram: {
    canaisIgnorados: ['bugmundodasmilhas'],
  },
  credenciais: {
    AMZ_CLIENT_ID: '', AMZ_CLIENT_SECRET: '', AMZ_PARTNER_TAG: '',
    ML_CLIENT_ID: '', ML_CLIENT_SECRET: '', ML_AFF_TOKEN: '',
    SHOPEE_APP_ID: '', SHOPEE_SECRET: '',
    MAGALU_LOJA: '',
  },
};

// Config vazia de um operador novo: mesma ESTRUTURA, sem os valores da
// operacao original (exceto grupos, que sao obrigatorios e validados no save —
// ficam vazios ate o operador escolher, e os envios simplesmente nao ocorrem).
function padraoDe(tenantId) {
  if (tenantId === TENANT_RAIZ) return CFG_TSP_PADRAO;
  const vazio = JSON.parse(JSON.stringify(CFG_TSP_PADRAO));
  for (const k of Object.keys(vazio.afiliados)) vazio.afiliados[k] = '';
  for (const k of Object.keys(vazio.rodapes))   vazio.rodapes[k] = '';
  for (const k of Object.keys(vazio.grupos))    vazio.grupos[k] = '';
  vazio.telegram.canaisIgnorados = [];
  vazio.branding.nome = '';
  return vazio;
}

function estruturar(bruto, tenantId) {
  const base = padraoDe(tenantId);
  const b = (bruto && typeof bruto === 'object') ? bruto : {};
  const out = {};
  for (const secao of Object.keys(base)) {
    out[secao] = { ...base[secao], ...(b[secao] && typeof b[secao] === 'object' ? b[secao] : {}) };
  }
  out.telegram.canaisIgnorados = Array.isArray(out.telegram.canaisIgnorados)
    ? out.telegram.canaisIgnorados.map(s => String(s).trim().toLowerCase()).filter(Boolean)
    : [];
  return out;
}

const _cfgs = new Map();   // tenantId -> config estruturada

function obter(tenantId = TENANT_RAIZ) {
  const id = RE_TENANT.test(String(tenantId || '')) ? tenantId : TENANT_RAIZ;
  if (!_cfgs.has(id)) carregarUm(id);
  return _cfgs.get(id);
}

function carregarUm(tenantId) {
  const caminho = caminhoLocalDe(tenantId);
  try {
    if (existsSync(caminho)) {
      _cfgs.set(tenantId, estruturar(JSON.parse(readFileSync(caminho, 'utf-8')), tenantId));
    } else {
      _cfgs.set(tenantId, estruturar({}, tenantId));
    }
  } catch (e) {
    console.log('[CFG-TSP] Erro ao carregar config de "' + tenantId + '":', e.message);
    if (!_cfgs.has(tenantId)) _cfgs.set(tenantId, estruturar({}, tenantId));
  }
  if (tenantId === TENANT_RAIZ) aplicarCredenciaisEnv();
}

// Recarrega do disco: o padrao sempre, e todo tenant com pasta em ./sessao/tenants.
export function carregarConfigTsp() {
  _cfgs.clear();
  carregarUm(TENANT_RAIZ);
  try {
    const dir = SESSAO_DIR + '/tenants';
    if (existsSync(dir)) {
      for (const id of readdirSync(dir)) {
        if (RE_TENANT.test(id) && id !== TENANT_RAIZ) carregarUm(id);
      }
    }
  } catch (e) { console.log('[CFG-TSP] Erro ao enumerar tenants:', e.message); }
  console.log('[CFG-TSP] Config carregada para ' + _cfgs.size + ' operador(es).');
  return obter();
}

// Injeta as credenciais do TENANT PADRAO em process.env. Config vazia preserva
// a env original do Railway; limpar no painel volta a valer a env, se houver.
const _ENV_ORIGINAL = {};
function aplicarCredenciaisEnv() {
  const cred = (_cfgs.get(TENANT_RAIZ) || {}).credenciais || {};
  for (const [k, v] of Object.entries(cred)) {
    if (!(k in _ENV_ORIGINAL)) _ENV_ORIGINAL[k] = process.env[k] || '';
    const val = String(v || '').trim();
    if (val) process.env[k] = val;
    else if (_ENV_ORIGINAL[k]) process.env[k] = _ENV_ORIGINAL[k];
    else delete process.env[k];
  }
}

export function configTsp(tenantId) { return obter(tenantId); }

const RE_JID_GRUPO = /^\d{5,}@g\.us$/;

export function salvarConfigTsp(parcial = {}, tenantId = TENANT_RAIZ) {
  const atual = obter(tenantId);

  // Credenciais: vazio = manter; '__limpar__' = apagar (volta a valer a env no
  // tenant padrao). O painel nunca recebe o valor em claro para reenviar.
  const cred = { ...(atual.credenciais || {}) };
  for (const [k, v] of Object.entries(parcial.credenciais || {})) {
    if (!(k in CFG_TSP_PADRAO.credenciais)) continue;
    const val = String(v == null ? '' : v).trim();
    if (val === '__limpar__') cred[k] = '';
    else if (val) cred[k] = val;
  }

  const novo = estruturar({
    branding: { ...atual.branding, ...(parcial.branding || {}) },
    afiliados:{ ...atual.afiliados, ...(parcial.afiliados || {}) },
    rodapes:  { ...atual.rodapes,   ...(parcial.rodapes   || {}) },
    grupos:   { ...atual.grupos,    ...(parcial.grupos    || {}) },
    telegram: { ...atual.telegram,  ...(parcial.telegram  || {}) },
    credenciais: cred,
  }, tenantId);

  // Grupos especiais: no tenant padrao um JID invalido quebra fallback de envio
  // e avisos de forma silenciosa — recusa. Tenant novo pode ficar vazio ate
  // conectar o WhatsApp e escolher os grupos.
  for (const [k, v] of Object.entries(novo.grupos)) {
    const s = String(v || '').trim();
    novo.grupos[k] = s;
    if (s && !RE_JID_GRUPO.test(s)) {
      throw new Error('Grupo "' + k + '" invalido: informe um JID de grupo (…@g.us).');
    }
    if (!s && tenantId === TENANT_RAIZ) {
      throw new Error('Grupo "' + k + '" e obrigatorio na operacao padrao.');
    }
  }
  for (const [k, v] of Object.entries(novo.afiliados)) {
    const s = String(v || '').trim();
    novo.afiliados[k] = s;
    if (s && !/^https?:\/\//i.test(s)) {
      throw new Error('Link de afiliado "' + k + '" invalido: use uma URL http(s) ou deixe vazio.');
    }
  }

  _cfgs.set(tenantId, novo);
  if (tenantId === TENANT_RAIZ) aplicarCredenciaisEnv();
  try {
    const caminho = caminhoLocalDe(tenantId);
    const dir = caminho.slice(0, caminho.lastIndexOf('/'));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(caminho, JSON.stringify(novo, null, 2), 'utf-8');
    agendarPush(caminhoPushDe(tenantId));
  } catch (e) { console.log('[CFG-TSP] Erro ao salvar config de "' + tenantId + '":', e.message); }
  return novo;
}

// Copia da config SEM as credenciais — e o que os endpoints publicos devolvem.
export function configTspPublico(tenantId) {
  const { credenciais, ...resto } = obter(tenantId);
  return JSON.parse(JSON.stringify(resto));
}

// Estado mascarado por credencial. Origem 'ambiente' (env do Railway) so faz
// sentido para o tenant padrao — os demais so enxergam o que salvaram.
export function credenciaisEstado(tenantId = TENANT_RAIZ) {
  const cfg = obter(tenantId);
  const out = {};
  for (const k of Object.keys(CFG_TSP_PADRAO.credenciais)) {
    const doPainel = String((cfg.credenciais || {})[k] || '').trim();
    const doAmb = (!doPainel && tenantId === TENANT_RAIZ)
      ? String(_ENV_ORIGINAL[k] !== undefined ? _ENV_ORIGINAL[k] : (process.env[k] || '')).trim()
      : '';
    const valor = doPainel || doAmb;
    out[k] = {
      definido: !!valor,
      origem: doPainel ? 'painel' : (doAmb ? 'ambiente' : null),
      final: valor ? valor.slice(-4) : '',
    };
  }
  return out;
}

// ── Acessores usados pelo restante do servidor (padrao = tenant raiz) ────────

export function linksTsp(tenantId) {
  const a = obter(tenantId).afiliados || {};
  return {
    'Amazon':         a.amazon || '',
    'Mercado Livre':  a.mercadolivre || '',
    'Shopee_sem':     a.shopee_sem || '',
    'Shopee_com':     a.shopee_com || '',
    'Magazine Luiza': a.magalu || '',
    'Zé Delivery':    a.zedelivery || '',
  };
}

export function rodapeCupom(tenantId)       { return (obter(tenantId).rodapes.cupom || '').trim(); }
export function rodapeOferta(tenantId)      { return (obter(tenantId).rodapes.oferta || '').trim(); }
export function rodapeGrupoCupons(tenantId) { return (obter(tenantId).rodapes.grupoCupons || '').trim(); }

export function grupoTspPadrao(tenantId)    { return obter(tenantId).grupos.padrao; }
export function grupoTspCupons(tenantId)    { return obter(tenantId).grupos.cupons; }
export function grupoOperadorTsp(tenantId)  { return obter(tenantId).grupos.operador; }

export function tgIgnoradosConfig(tenantId) { return obter(tenantId).telegram.canaisIgnorados.slice(); }

// Auto-carrega no import, como os demais modulos de dados.
carregarConfigTsp();
