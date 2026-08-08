// ═══════════════════════════════════════════════════════════════════════════
// config-tsp.js — configuracao da operacao TSP editavel pelo painel.
//
// Tudo que antes era hardcode de UMA operacao (links de afiliado, rodapes das
// mensagens, grupos especiais, blacklist do Telegram, nome da marca) mora aqui.
// E o alicerce do modelo hospedado: cada operador configura a propria operacao
// em tela, sem tocar em codigo nem em variavel de ambiente.
//
// Segue o mesmo padrao dos demais modulos de dados (radar_config, templates):
// leitura sincrona de ./sessao, gravacao local + agendarPush para o repositorio
// de dados. O arquivo config_tsp.json e versionado e sobrevive a perda do
// volume do Railway.
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { agendarPush } from './sync-github.js';

const SESSAO_DIR   = './sessao';
const CFG_TSP_PATH = SESSAO_DIR + '/config_tsp.json';

// Valores padrao = operacao original (Tudo Sobre Promos / Davi), que e o
// "primeiro usuario" do modelo hospedado. Um deploy novo sem config gravada se
// comporta exatamente como o sistema se comportava antes desta camada existir.
const CFG_TSP_PADRAO = {
  branding: {
    nome: 'Tudo Sobre Promos',
  },
  // Links de afiliado usados no formatador de cupons (auto-envio e fila) e no
  // gerador manual do painel. Chave vazia = loja sem link: o cupom sai sem o
  // bloco "RESGATE O CUPOM AQUI" e a loja fica inelegivel para auto-envio.
  afiliados: {
    amazon:       'https://amzn.to/4dFRSzy',
    mercadolivre: 'https://meli.la/2xystLt',
    shopee_sem:   'https://s.shopee.com.br/9fHPmP3QZF',   // pagina de cupons (sem codigo)
    shopee_com:   'https://s.shopee.com.br/30kdYeLY0W',   // oferta com codigo
    magalu:       'https://magazineluiza.onelink.me/589508454/3jdc7bbv',
    zedelivery:   'https://ze.onelink.me/qZhP/p8z09c1x',
  },
  // Rodapes anexados as mensagens. Texto livre — o operador pode usar crase
  // para o estilo monoespacado do WhatsApp, ou deixar vazio para nao anexar.
  rodapes: {
    // Mensagens de CUPOM (formatador automatico + gerador manual de cupom).
    cupom:       '`Convide seus amigos para entrar aqui no grupo: https://chat.whatsapp.com/HK7NL13BdPXKJPAGtvTKKg`',
    // Mensagens de OFERTA (gerador manual, mensagem livre e semente do
    // template padrao de produto).
    oferta:      '`Convide seus amigos para entrar aqui no grupo:  https://chat.whatsapp.com/Ia5ZTqeTJdXHG5OT9LUwz8`',
    // Copia enviada ao grupo so-cupons: convite cruzado para o grupo de ofertas.
    grupoCupons: '`Entre no grupo de ofertas: https://chat.whatsapp.com/C7ed3Z1tYIb980POo9MqF8?s=cl&p=i&ilr=4`',
  },
  // Grupos especiais da operacao (JIDs de WhatsApp).
  grupos: {
    padrao:   '120363424721106736@g.us',  // fallback de destino quando nada esta marcado
    cupons:   '120363410183381243@g.us',  // grupo so-cupons: recebe copia com rodape cruzado
    operador: '120363409136599326@g.us',  // avisos operacionais (falhas, resumos) — nunca clientes
  },
  telegram: {
    // Substrings de titulo/username ou channelIds numericos a ignorar na
    // captura. Complementa (nao substitui) a env TG_CANAIS_IGNORADOS.
    canaisIgnorados: ['bugmundodasmilhas'],
  },
};

// Merge raso por secao: cada bloco do padrao e preenchido com o que veio do
// disco. Suficiente para a estrutura de 2 niveis deste arquivo e evita que uma
// config antiga (sem um campo novo) derrube o padrao do campo.
function estruturar(bruto) {
  const b = (bruto && typeof bruto === 'object') ? bruto : {};
  const out = {};
  for (const secao of Object.keys(CFG_TSP_PADRAO)) {
    out[secao] = { ...CFG_TSP_PADRAO[secao], ...(b[secao] && typeof b[secao] === 'object' ? b[secao] : {}) };
  }
  // canaisIgnorados precisa ser array de strings limpas.
  out.telegram.canaisIgnorados = Array.isArray(out.telegram.canaisIgnorados)
    ? out.telegram.canaisIgnorados.map(s => String(s).trim().toLowerCase()).filter(Boolean)
    : CFG_TSP_PADRAO.telegram.canaisIgnorados.slice();
  return out;
}

let _cfg = estruturar({});

export function carregarConfigTsp() {
  try {
    if (existsSync(CFG_TSP_PATH)) {
      _cfg = estruturar(JSON.parse(readFileSync(CFG_TSP_PATH, 'utf-8')));
      console.log('[CFG-TSP] Configuracao da operacao carregada.');
    } else {
      _cfg = estruturar({});
      console.log('[CFG-TSP] Sem config em disco — usando padrao da operacao original.');
    }
  } catch (e) {
    console.log('[CFG-TSP] Erro ao carregar config:', e.message);
  }
  return _cfg;
}

export function configTsp() { return _cfg; }

const RE_JID_GRUPO = /^\d{5,}@g\.us$/;

export function salvarConfigTsp(parcial = {}) {
  const novo = estruturar({
    branding: { ..._cfg.branding, ...(parcial.branding || {}) },
    afiliados:{ ..._cfg.afiliados, ...(parcial.afiliados || {}) },
    rodapes:  { ..._cfg.rodapes,   ...(parcial.rodapes   || {}) },
    grupos:   { ..._cfg.grupos,    ...(parcial.grupos    || {}) },
    telegram: { ..._cfg.telegram,  ...(parcial.telegram  || {}) },
  });
  // Grupos especiais: um JID invalido aqui quebra fallback de envio e avisos
  // do operador de forma silenciosa — melhor recusar a gravacao.
  for (const [k, v] of Object.entries(novo.grupos)) {
    if (!RE_JID_GRUPO.test(String(v || ''))) {
      throw new Error('Grupo "' + k + '" invalido: informe um JID de grupo (…@g.us).');
    }
  }
  // Links: se preenchidos, precisam ser http(s). Vazio e permitido (loja sem link).
  for (const [k, v] of Object.entries(novo.afiliados)) {
    const s = String(v || '').trim();
    novo.afiliados[k] = s;
    if (s && !/^https?:\/\//i.test(s)) {
      throw new Error('Link de afiliado "' + k + '" invalido: use uma URL http(s) ou deixe vazio.');
    }
  }
  _cfg = novo;
  try {
    writeFileSync(CFG_TSP_PATH, JSON.stringify(_cfg, null, 2), 'utf-8');
    agendarPush('config_tsp.json');
  } catch (e) { console.log('[CFG-TSP] Erro ao salvar config:', e.message); }
  return _cfg;
}

// ── Acessores usados pelo restante do servidor ───────────────────────────────

// Mapa no formato historico do LINKS_TSP, para o formatador nao mudar de shape.
export function linksTsp() {
  const a = _cfg.afiliados || {};
  return {
    'Amazon':         a.amazon || '',
    'Mercado Livre':  a.mercadolivre || '',
    'Shopee_sem':     a.shopee_sem || '',
    'Shopee_com':     a.shopee_com || '',
    'Magazine Luiza': a.magalu || '',
    'Zé Delivery':    a.zedelivery || '',
  };
}

export function rodapeCupom()       { return (_cfg.rodapes.cupom || '').trim(); }
export function rodapeOferta()      { return (_cfg.rodapes.oferta || '').trim(); }
export function rodapeGrupoCupons() { return (_cfg.rodapes.grupoCupons || '').trim(); }

export function grupoTspPadrao()    { return _cfg.grupos.padrao; }
export function grupoTspCupons()    { return _cfg.grupos.cupons; }
export function grupoOperadorTsp()  { return _cfg.grupos.operador; }

export function tgIgnoradosConfig() { return _cfg.telegram.canaisIgnorados.slice(); }

// Auto-carrega no import: os modulos que consomem (server.js, radar-amazon.js)
// podem ler a config imediatamente, sem depender da ordem do boot.
carregarConfigTsp();
