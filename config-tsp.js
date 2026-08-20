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

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { agendarPush } from './sync-github.js';
import { tenantContexto } from './tenants.js';

const SESSAO_DIR = './sessao';
// Mesmo valor de TENANT_PADRAO em tenants.js (nao importado para este modulo
// nao depender do registro). Raiz de ./sessao = operacao original, layout
// historico; demais operadores em ./sessao/tenants/<id>/.
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
  // TAG DE AFILIADO AMAZON POR GRUPO DE DESTINO.
  //
  // Excecao ao rastreio padrao: o link sai da API com a tag da conta e o pool
  // rotativo a substitui por um identificador de produto. Para os JIDs listados
  // aqui, a tag e trocada mais uma vez no momento do envio — depois de saber
  // para qual grupo a mensagem vai — para direcionar a comissao daquele grupo a
  // outra conta de associado.
  //
  //   { '<jid>@g.us': 'tag-20' }
  //
  // Grupo fora do mapa nao muda em NADA: continua com a tag do pool e continua
  // medido pelo desempenho. So vale para Amazon; Shopee, Mercado Livre, Magalu
  // e Awin saem intactos.
  //
  // Consequencia deliberada: a venda cai na conta do associado dono da tag, e
  // por isso NAO aparece no relatorio de comissoes nem no EPC desta operacao.
  tagsPorGrupo: {
    // Promos do Davi #07 — comissao direcionada a outro associado.
    '120363429334971122@g.us': 'dl04f-20',
  },
  // LINK DE AFILIADO POR GRUPO DE DESTINO.
  //
  // Irmao de tagsPorGrupo, para o caso que a troca de tag nao resolve: os links
  // de resgate de cupom acima sao ENCURTADOS, e num link curto a tag mora do
  // outro lado do redirect — reescrever a query string nao muda nada. Entao,
  // para esses grupos, o link inteiro e substituido pelo do outro associado.
  //
  //   { '<jid>@g.us': { amazon: 'https://...' } }
  //
  // As chaves de loja sao as mesmas de `afiliados` (amazon, mercadolivre,
  // shopee_sem, shopee_com, magalu, zedelivery). Loja ausente no override
  // continua com o link global.
  linksPorGrupo: {
    // Promos do Davi #07 — link de afiliado da conta que recebe a comissao.
    // Qualquer link da Amazon com a tag do associado abre a janela de cookie,
    // entao o produto de destino e indiferente para a atribuicao.
    '120363429334971122@g.us': {
      amazon: 'https://link.amazon/B03wEQT0G',
    },
  },
  // TROCAS LITERAIS DE LINK POR GRUPO — de -> para.
  //
  // Existe para os links de afiliado que NAO moram em `afiliados`: o convite do
  // Prime, por exemplo, e escrito direto no corpo do template da Amazon
  // (dados/tsp/templates.json), que e um so para todos os grupos. Trocar la
  // mudaria a conta em toda a operacao; aqui a troca vale so no destino.
  //
  //   { '<jid>@g.us': { 'https://link-antigo': 'https://link-novo' } }
  //
  // A troca e literal, comparando a string inteira: link que nao aparecer na
  // mensagem simplesmente nao casa e nada acontece.
  linksLiteraisPorGrupo: {
    // Promos do Davi #07 — convite do Prime na conta do associado (dl04f-20).
    '120363429334971122@g.us': {
      'https://link.amazon/B0dULFSvu': 'https://link.amazon/B08eCYlQ3',
    },
  },
  // Rodapes anexados as mensagens. Texto livre — o operador pode usar crase
  // para o estilo monoespacado do WhatsApp, ou deixar vazio para nao anexar.
  rodapes: {
    // Mensagens de CUPOM (formatador automatico + gerador manual de cupom).
    cupom:       '`Convide seus amigos para entrar aqui no grupo: https://chat.whatsapp.com/HK7NL13BdPXKJPAGtvTKKg`',
    // Mensagens de OFERTA (gerador manual, mensagem livre e semente do
    // template padrao de produto).
    oferta:      '`Convide seus amigos para entrar aqui no grupo:  https://chat.whatsapp.com/Ia5ZTqeTJdXHG5OT9LUwz8`',
    // RODAPES EXTRA POR NICHO (convite cruzado). Cada regra e um bloco de texto
    // anexado ao FINAL da mensagem no momento do envio, grupo a grupo. Nada
    // aqui altera template salvo: sem regra que case, a mensagem sai exatamente
    // como saia antes desta camada existir.
    //   { id, nome, ativo, tipos:['oferta'|'cupom'|'manual'],
    //     categorias:[ids da taxonomia], escopo, texto }
    // escopo: 'fora-da-trilha' (padrao) anexa so nos grupos que NAO sao destino
    // de uma trilha da mesma categoria — e o que evita convidar para o grupo de
    // bebidas quem ja esta nele; 'todos' anexa em todo destino; 'so-trilha'
    // anexa apenas dentro do grupo de nicho.
    // Primeira regra que casa vence: duas regras aplicaveis nao viram dois
    // blocos empilhados no fim da mensagem.
    regras: [],
  },
  // Grupos especiais da operacao (JIDs de WhatsApp).
  //
  // Nao ha mais "grupo padrao": o destino de tudo que e oferta sao os grupos
  // marcados como DESTINO na aba Grupos. Um fallback escondido aqui fazia
  // oferta cair num grupo que o operador nao escolheu.
  grupos: {
    // Grupos que recebem SO cupom — nunca oferta de produto. Podem ser varios.
    cupons:   ['120363410183381243@g.us'],
    // Avisos operacionais (falhas, resumos) — nunca clientes.
    operador: '120363409136599326@g.us',
  },
  // Credenciais dos servicos. Ficam aqui para o operador configurar em tela, em
  // vez de depender de variavel de ambiente e redeploy. Vazio = usa a env de
  // mesmo nome, que continua valendo como fallback.
  //
  // ATENCAO: gravadas no repositorio de dados junto com o resto da config. Esse
  // repositorio PRECISA ser privado.
  credenciais: {
    AWIN_TOKEN: '', AWIN_PUBLISHER_ID: '', AWIN_FEED_APIKEY: '',
    SHOPEE_APP_ID: '', SHOPEE_SECRET: '',
    ML_CLIENT_ID: '', ML_CLIENT_SECRET: '', ML_AFF_TOKEN: '', ML_TAG: '',
    AMZ_CLIENT_ID: '', AMZ_CLIENT_SECRET: '', AMZ_PARTNER_TAG: '',
    MAGALU_LOJA: '',
    ANTHROPIC_API_KEY: '',
    TG_API_ID: '', TG_API_HASH: '',
    GITHUB_TOKEN: '', GITHUB_REPO_DADOS: '',
  },
  telegram: {
    // Substrings de titulo/username ou channelIds numericos a ignorar na
    // captura. Complementa (nao substitui) a env TG_CANAIS_IGNORADOS.
    canaisIgnorados: ['bugmundodasmilhas'],
  },
  // Modo de disparo automatico. Decisao de OPERACAO, nao de infraestrutura:
  // mora aqui para o operador mudar em tela, sem mexer no Railway e sem
  // redeploy. String vazia = herda a env de mesmo nome (AUTO_ENVIO_CUPOM /
  // AUTO_ENVIO_OFERTA), que continua valendo como fallback — assim ninguem
  // perde a configuracao atual ao subir esta versao.
  autoEnvio: {
    // 'off' (tudo vai para a fila) | 'sombra' (avalia e loga, mas nao envia)
    // | 'on' (envia direto quando passa em todos os gates).
    cupom:  '',
    // Ofertas de marketplace nao tem modo 'sombra': 'off' | 'on'.
    oferta: '',
  },
};

// Config de partida por operador: a raiz herda os valores historicos da
// operacao original; um tenant novo nasce com tudo VAZIO — links, rodapes,
// grupos, credenciais. Evita o pior bug do modelo hospedado: comissao ou envio
// caindo na operacao errada por um campo esquecido.
function padraoDe(tenantId) {
  if (tenantId === TENANT_RAIZ) return CFG_TSP_PADRAO;
  const vazio = JSON.parse(JSON.stringify(CFG_TSP_PADRAO));
  for (const k of Object.keys(vazio.afiliados))   vazio.afiliados[k] = '';
  for (const k of Object.keys(vazio.rodapes)) {
    if (Array.isArray(vazio.rodapes[k])) vazio.rodapes[k] = [];
    else vazio.rodapes[k] = '';
  }
  for (const k of Object.keys(vazio.credenciais)) vazio.credenciais[k] = '';
  vazio.grupos = { cupons: [], operador: '' };
  vazio.telegram.canaisIgnorados = [];
  vazio.branding.nome = '';
  return vazio;
}

// Merge raso por secao: cada bloco do padrao e preenchido com o que veio do
// disco. Suficiente para a estrutura de 2 niveis deste arquivo e evita que uma
// config antiga (sem um campo novo) derrube o padrao do campo.
function estruturar(bruto, tenantId = TENANT_RAIZ) {
  const PADRAO = padraoDe(tenantId);
  const b = (bruto && typeof bruto === 'object') ? bruto : {};
  const out = {};
  for (const secao of Object.keys(PADRAO)) {
    out[secao] = { ...PADRAO[secao], ...(b[secao] && typeof b[secao] === 'object' ? b[secao] : {}) };
  }
  // Config gravada antes desta versao tem grupos.cupons como string e um
  // grupos.padrao que nao existe mais — normaliza sem perder o que estava la.
  const cup = out.grupos.cupons;
  out.grupos.cupons = (Array.isArray(cup) ? cup : [cup])
    .map(x => String(x || '').trim()).filter(Boolean);
  delete out.grupos.padrao;
  // Rodape de convite cruzado do grupo so-cupons: regra removida. Some do JSON
  // gravado para nao ressuscitar se alguem reler a config antiga.
  delete out.rodapes.grupoCupons;
  // Regras de rodape extra: normalizadas na leitura, nao na gravacao. Assim
  // config antiga (sem o campo) e config editada a mao no repositorio chegam
  // no mesmo formato para quem consome — regra torta vira regra descartada,
  // nunca excecao no meio de um envio.
  out.rodapes.regras = normalizarRegrasRodape(out.rodapes.regras);
  // Mapa jid -> tag: normalizado na leitura, como as regras de rodape. Entrada
  // torta (jid vazio, tag fora do formato da Amazon) e descartada em vez de
  // virar excecao no meio de um envio.
  out.afiliados.tagsPorGrupo = normalizarTagsPorGrupo(out.afiliados.tagsPorGrupo);
  out.afiliados.linksPorGrupo = normalizarLinksPorGrupo(out.afiliados.linksPorGrupo);
  out.afiliados.linksLiteraisPorGrupo = normalizarLiteraisPorGrupo(out.afiliados.linksLiteraisPorGrupo);
  // Credencial nao preenchida fica string vazia, nunca undefined: o painel
  // precisa distinguir "nao configurado" de "campo inexistente".
  for (const k of Object.keys(CFG_TSP_PADRAO.credenciais)) {
    out.credenciais[k] = String(out.credenciais[k] ?? '').trim();
  }
  // canaisIgnorados precisa ser array de strings limpas.
  out.telegram.canaisIgnorados = Array.isArray(out.telegram.canaisIgnorados)
    ? out.telegram.canaisIgnorados.map(s => String(s).trim().toLowerCase()).filter(Boolean)
    : padraoDe(tenantId).telegram.canaisIgnorados.slice();
  return out;
}

// Regra sem texto e regra que nao faz nada: sai da lista. Os demais campos tem
// default seguro — o escopo mais conservador ('fora-da-trilha') e o tipo mais
// comum ('oferta'), para que um cadastro incompleto nunca vire cupom com
// convite cruzado que ninguem pediu.
// A Amazon so aceita tag no formato <nome>-<numero> (ex.: dl04f-20). Qualquer
// outra coisa viraria um link com tag invalida — a venda ate acontece, mas sem
// atribuicao para ninguem. Melhor descartar e deixar o grupo no fluxo normal.
const RE_TAG_AFILIADO = /^[a-z0-9](?:[a-z0-9._-]{1,48})-[0-9]{2}$/i;

function normalizarTagsPorGrupo(bruto) {
  const o = (bruto && typeof bruto === 'object' && !Array.isArray(bruto)) ? bruto : {};
  const out = {};
  for (const [jid, tag] of Object.entries(o)) {
    const j = String(jid || '').trim();
    const t = String(tag || '').trim();
    if (!j || !t) continue;
    if (!RE_TAG_AFILIADO.test(t)) {
      console.log('[CFG-TSP] Tag de afiliado ignorada (formato invalido): ' + j + ' -> ' + t);
      continue;
    }
    out[j] = t;
  }
  return out;
}

// Chaves de loja aceitas no override por grupo: exatamente as de `afiliados`.
// Uma chave desconhecida seria um override que nunca casa com nada, e um erro
// de digitacao passaria despercebido ate alguem conferir o relatorio.
const LOJAS_AFILIADO = ['amazon', 'mercadolivre', 'shopee_sem', 'shopee_com', 'magalu', 'zedelivery'];

function normalizarLinksPorGrupo(bruto) {
  const o = (bruto && typeof bruto === 'object' && !Array.isArray(bruto)) ? bruto : {};
  const out = {};
  for (const [jid, mapa] of Object.entries(o)) {
    const j = String(jid || '').trim();
    if (!j || !mapa || typeof mapa !== 'object') continue;
    const limpo = {};
    for (const [loja, url] of Object.entries(mapa)) {
      const l = String(loja || '').trim().toLowerCase();
      const u = String(url || '').trim();
      if (!l || !u) continue;
      if (!LOJAS_AFILIADO.includes(l)) {
        console.log('[CFG-TSP] Override de link ignorado (loja desconhecida): ' + j + ' -> ' + l);
        continue;
      }
      if (!/^https?:\/\//i.test(u)) {
        console.log('[CFG-TSP] Override de link ignorado (nao e URL): ' + j + ' -> ' + l);
        continue;
      }
      limpo[l] = u;
    }
    if (Object.keys(limpo).length) out[j] = limpo;
  }
  return out;
}

function normalizarLiteraisPorGrupo(bruto) {
  const o = (bruto && typeof bruto === 'object' && !Array.isArray(bruto)) ? bruto : {};
  const out = {};
  for (const [jid, mapa] of Object.entries(o)) {
    const j = String(jid || '').trim();
    if (!j || !mapa || typeof mapa !== 'object') continue;
    const limpo = {};
    for (const [de, para] of Object.entries(mapa)) {
      const d = String(de || '').trim();
      const a = String(para || '').trim();
      if (!d || !a || d === a) continue;
      if (!/^https?:\/\//i.test(d) || !/^https?:\/\//i.test(a)) {
        console.log('[CFG-TSP] Troca literal ignorada (nao e URL): ' + j + ' -> ' + d);
        continue;
      }
      limpo[d] = a;
    }
    if (Object.keys(limpo).length) out[j] = limpo;
  }
  return out;
}

const ESCOPOS_RODAPE = ['fora-da-trilha', 'todos', 'so-trilha'];
const TIPOS_RODAPE   = ['oferta', 'cupom', 'manual'];

function normalizarRegrasRodape(bruto) {
  const lista = Array.isArray(bruto) ? bruto : [];
  const vistos = new Set();
  const out = [];
  lista.forEach((b, i) => {
    const o = (b && typeof b === 'object') ? b : {};
    const texto = String(o.texto ?? '').trim();
    if (!texto) return;
    let id = String(o.id || '').trim() || ('rod' + (i + 1));
    while (vistos.has(id)) id += '-' + (i + 1);
    vistos.add(id);
    const tipos = [...new Set((Array.isArray(o.tipos) ? o.tipos : [])
      .map(x => String(x || '').trim().toLowerCase())
      .filter(t => TIPOS_RODAPE.includes(t)))];
    out.push({
      id,
      nome: String(o.nome || '').trim() || ('Rodape ' + (i + 1)),
      ativo: o.ativo !== false,
      tipos: tipos.length ? tipos : ['oferta'],
      categorias: [...new Set((Array.isArray(o.categorias) ? o.categorias : [])
        .map(x => String(x || '').trim()).filter(Boolean))],
      escopo: ESCOPOS_RODAPE.includes(String(o.escopo || '')) ? String(o.escopo) : 'fora-da-trilha',
      texto,
    });
  });
  return out;
}

const _cfgs = new Map();   // tenantId -> config estruturada

// Resolucao do operador: parametro explicito > contexto da requisicao
// (AsyncLocalStorage, aberto pelo middleware) > operacao padrao. Assim os
// acessores chamados sem parametro dentro de uma requisicao ja enxergam o
// tenant certo, e pipelines/workers sem contexto caem na raiz.
function resolver(tenantId) {
  const id = tenantId || tenantContexto() || TENANT_RAIZ;
  return RE_TENANT.test(String(id || '')) ? id : TENANT_RAIZ;
}

function obter(tenantId) {
  const id = resolver(tenantId);
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
  if (tenantId === TENANT_RAIZ) aplicarCredenciais();
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

export function configTsp(tenantId) { return obter(tenantId); }

const RE_JID_GRUPO = /^\d{5,}@g\.us$/;

export function salvarConfigTsp(parcial = {}, tenantId) {
  tenantId = resolver(tenantId);
  const atual = obter(tenantId);
  const novo = estruturar({
    branding: { ...atual.branding, ...(parcial.branding || {}) },
    afiliados:{ ...atual.afiliados, ...(parcial.afiliados || {}) },
    rodapes:  { ...atual.rodapes,   ...(parcial.rodapes   || {}) },
    grupos:   { ...atual.grupos,    ...(parcial.grupos    || {}) },
    telegram: { ...atual.telegram,  ...(parcial.telegram  || {}) },
    autoEnvio:{ ...atual.autoEnvio, ...(parcial.autoEnvio || {}) },
    credenciais: { ...atual.credenciais, ...(parcial.credenciais || {}) },
  }, tenantId);

  // Modo invalido aqui viraria disparo em massa por engano: recusa explicita.
  const MODOS_CUPOM  = ['', 'off', 'sombra', 'on'];
  const MODOS_OFERTA = ['', 'off', 'on'];
  novo.autoEnvio.cupom  = String(novo.autoEnvio.cupom  || '').trim().toLowerCase();
  novo.autoEnvio.oferta = String(novo.autoEnvio.oferta || '').trim().toLowerCase();
  if (!MODOS_CUPOM.includes(novo.autoEnvio.cupom)) {
    throw new Error('Auto-envio de cupom invalido: use off, sombra ou on.');
  }
  if (!MODOS_OFERTA.includes(novo.autoEnvio.oferta)) {
    throw new Error('Auto-envio de oferta invalido: use off ou on.');
  }
  // Um JID invalido quebra avisos do operador em silencio — melhor recusar.
  // Tenant novo pode ficar sem grupo do operador ate conectar o WhatsApp.
  const opd = String(novo.grupos.operador || '').trim();
  novo.grupos.operador = opd;
  if (opd && !RE_JID_GRUPO.test(opd)) {
    throw new Error('Grupo do operador invalido: informe um JID de grupo (…@g.us).');
  }
  if (!opd && tenantId === TENANT_RAIZ) {
    throw new Error('Grupo do operador e obrigatorio na operacao padrao.');
  }
  for (const jid of novo.grupos.cupons) {
    if (!RE_JID_GRUPO.test(jid)) {
      throw new Error('Grupo so-cupons invalido: "' + jid + '" nao e um JID de grupo (…@g.us).');
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
  _cfgs.set(tenantId, novo);
  // Injecao em process.env e inerentemente global: so a operacao padrao usa
  // esse caminho. Credenciais dos demais operadores ficam armazenadas e passam
  // a ser consumidas por contexto na fase 2.3.
  if (tenantId === TENANT_RAIZ) aplicarCredenciais();
  try {
    const caminho = caminhoLocalDe(tenantId);
    const dir = caminho.slice(0, caminho.lastIndexOf('/'));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(caminho, JSON.stringify(novo, null, 2), 'utf-8');
    agendarPush(caminhoPushDe(tenantId));
  } catch (e) { console.log('[CFG-TSP] Erro ao salvar config de "' + tenantId + '":', e.message); }
  return novo;
}

// ── Acessores usados pelo restante do servidor ───────────────────────────────

// Mapa no formato historico do LINKS_TSP, para o formatador nao mudar de shape.
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
/** Regras de rodape extra por nicho, ja normalizadas e na ordem de prioridade. */
export function rodapesRegras(tenantId) {
  const r = obter(tenantId).rodapes.regras;
  return Array.isArray(r) ? r.map(x => ({ ...x, tipos: x.tipos.slice(), categorias: x.categorias.slice() })) : [];
}

/** Tag de afiliado Amazon especifica do grupo, ou null quando ele nao tem. */
export function tagAmazonDoGrupo(jid, tenantId) {
  const j = String(jid || '').trim();
  if (!j) return null;
  try { return obter(tenantId).afiliados.tagsPorGrupo[j] || null; }
  catch (e) { return null; }
}
/**
 * Pares [linkGlobal, linkDoGrupo] para substituir no texto ao enviar para `jid`.
 * Cruza o override com os links globais aqui, e nao em quem chama, porque a
 * substituicao so faz sentido contra o link que REALMENTE foi renderizado.
 * Grupo sem override, ou override igual ao global, devolve lista vazia.
 */
export function trocasDeLinkDoGrupo(jid, tenantId) {
  const j = String(jid || '').trim();
  if (!j) return [];
  try {
    const cfg = obter(tenantId);
    const over = cfg.afiliados.linksPorGrupo[j];
    const temLiteral = !!cfg.afiliados.linksLiteraisPorGrupo[j];
    if (!over && !temLiteral) return [];
    const globais = cfg.afiliados;
    const pares = [];
    for (const [loja, url] of Object.entries(over || {})) {
      const global = String(globais[loja] || '').trim();
      if (!global || global === url) continue;
      pares.push([global, url]);
    }
    // Trocas literais entram na mesma lista: para quem consome, e tudo
    // "substitua esta URL por aquela antes de enviar".
    const literais = cfg.afiliados.linksLiteraisPorGrupo[j] || {};
    for (const [de, para] of Object.entries(literais)) pares.push([de, para]);
    return pares;
  } catch (e) { return []; }
}

export function tagsAmazonPorGrupo(tenantId) {
  try { return { ...obter(tenantId).afiliados.tagsPorGrupo }; } catch (e) { return {}; }
}

export function gruposTspCupons(tenantId)   { return (obter(tenantId).grupos.cupons || []).slice(); }
export function grupoOperadorTsp(tenantId)  { return obter(tenantId).grupos.operador; }

// ── CREDENCIAIS ──────────────────────────────────────────────────────────────
// Em vez de trocar cada leitura de process.env espalhada pelos modulos, o que
// esta gravado e ESCRITO em process.env no boot e a cada gravacao. Assim todo
// o codigo existente continua lendo do mesmo lugar e o painel passa a mandar,
// com a env do Railway sobrando como fallback de quem nao preencheu nada.
export function aplicarCredenciais() {
  const c = (_cfgs.get(TENANT_RAIZ) || {}).credenciais || {};
  const aplicadas = [];
  for (const [chave, valor] of Object.entries(c)) {
    const v = String(valor || '').trim();
    if (!v) continue;
    process.env[chave] = v;
    aplicadas.push(chave);
  }
  if (aplicadas.length) console.log('[CFG-TSP] ' + aplicadas.length + ' credencial(is) da config aplicada(s).');
  return aplicadas;
}

/**
 * Estado das credenciais para a tela. NUNCA devolve o valor: so se esta
 * preenchida, de onde veio e um sufixo para o operador reconhecer qual chave
 * esta la sem poder copia-la de volta.
 */
export function estadoCredenciais(tenantId) {
  tenantId = resolver(tenantId);
  const c = obter(tenantId).credenciais || {};
  const out = {};
  for (const chave of Object.keys(CFG_TSP_PADRAO.credenciais)) {
    const daConfig = String(c[chave] || '').trim();
    // A env do Railway e infraestrutura da OPERACAO PADRAO — operador novo nao
    // enxerga (nem herda) as chaves da plataforma.
    const daEnv    = tenantId === TENANT_RAIZ ? String(process.env[chave] || '').trim() : '';
    const valor    = daConfig || daEnv;
    out[chave] = {
      preenchida: !!valor,
      origem: daConfig ? 'painel' : (daEnv ? 'railway' : null),
      sufixo: valor ? '…' + valor.slice(-4) : null,
    };
  }
  return out;
}

export function tgIgnoradosConfig(tenantId) { return obter(tenantId).telegram.canaisIgnorados.slice(); }

// ── MODO DE AUTO-ENVIO ───────────────────────────────────────────────────────
// Ordem de resolucao: config do painel -> env do Railway -> padrao seguro.
// Lidos a CADA decisao de envio (nunca cacheados numa const de modulo), para
// que salvar no painel passe a valer na hora, sem restart.
export function modoAutoEnvioCupom(tenantId) {
  const cfg = String(obter(tenantId).autoEnvio?.cupom || '').trim().toLowerCase();
  if (cfg) return cfg;
  return String(process.env.AUTO_ENVIO_CUPOM || 'sombra').toLowerCase();
}

export function modoAutoEnvioOferta(tenantId) {
  const cfg = String(obter(tenantId).autoEnvio?.oferta || '').trim().toLowerCase();
  if (cfg) return cfg;
  return String(process.env.AUTO_ENVIO_OFERTA || 'off').toLowerCase();
}

// De onde veio cada modo — o painel precisa dizer se o valor esta vindo da
// tela ou ainda da env, senao o operador nao entende por que mudar no Railway
// deixou de ter efeito (ou por que ainda tem).
export function origemAutoEnvio(tenantId) {
  const a = obter(tenantId).autoEnvio || {};
  return {
    cupom:  String(a.cupom  || '').trim() ? 'painel' : 'env',
    oferta: String(a.oferta || '').trim() ? 'painel' : 'env',
  };
}

// ── Credencial por contexto (fase 2.3) ───────────────────────────────────────
// Resolucao para os radares: o que o operador do contexto salvou no painel; na
// operacao padrao a env do Railway continua valendo como fallback. Operador
// novo NUNCA herda credencial da plataforma — sem a chave dele, a integracao
// simplesmente fica indisponivel para ele.
export function credencialTsp(nome, tenantId) {
  const id = resolver(tenantId);
  const daConfig = String(((obter(id).credenciais || {})[nome]) || '').trim();
  if (daConfig) return daConfig;
  return id === TENANT_RAIZ ? String(process.env[nome] || '').trim() : '';
}

// Auto-carrega no import: os modulos que consomem (server.js, radar-amazon.js)
// podem ler a config imediatamente, sem depender da ordem do boot.
carregarConfigTsp();
// Aplica antes de qualquer outro modulo ler process.env. Modulos que guardam a
// credencial numa const no topo (Telegram, por exemplo) so pegam o valor novo
// no proximo restart — os demais leem a cada uso e mudam na hora.
aplicarCredenciais();
