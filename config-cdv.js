// ═══════════════════════════════════════════════════════════════════════════
// config-cdv.js — configuracao da operacao CDV editavel pela tela do gerador.
//
// Irmao de config-tsp.js, para o outro lado da casa. Ate aqui, TUDO do CDV era
// hardcode no server.js: os dois grupos de destino, os 20 grupos monitorados e
// a conta que dispara. Mudar qualquer um deles exigia commit e deploy — e o
// comentario no server.js dizia, literalmente, "os grupos do CDV seguem fixos".
// Nao seguem mais: o gerador tem aba Config, como o painel do TSP tem.
//
// O que NAO mora aqui, de proposito: as regras de extracao por grupo (minimo
// de datas, so-imagem, executiva, texto estruturado). Elas continuam no
// server.js — sao decisao de parsing, nao de operacao, e um valor torto ali
// nao desliga um grupo, faz o grupo capturar errado em silencio.
//
// Persistencia igual a do TSP: ./sessao/config_cdv.json + agendarPush para o
// repositorio de dados. O arquivo e versionado e sobrevive a perda do volume
// do Railway (esta em PRESERVAR_NO_RESET e em NOMES_SINCRONIZAVEIS).
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { agendarPush } from './sync-github.js';

const SESSAO_DIR = './sessao';
const CAMINHO    = SESSAO_DIR + '/config_cdv.json';
const NOME_PUSH  = 'config_cdv.json';

// Papeis de administrador. Os tres primeiros sao permissao no gerador (por
// e-mail); 'avisos' e o unico que age sozinho, sem ninguem logado: o telefone
// do admin recebe o aviso operacional no WhatsApp.
export const PAPEIS_CDV = ['config', 'aprovar', 'disparar', 'avisos'];

const RE_JID_GRUPO = /^\d{5,}@g\.us$/;
const RE_CONTA     = /^[a-z0-9_-]{2,24}$/i;

// Para que serve cada grupo monitorado. Ate esta versao havia um destino so:
// tudo que era lido virava candidato a EMISSAO (rota + milhas + datas). Grupos
// de plantao de milhas publicam outra coisa — transferencia bonificada, compra
// de pontos, clube, cartao — que nao tem rota nenhuma e por isso caia inteira
// no descarte "nao reconhecido como emissao". 'oferta' manda o conteudo para a
// fila de aprovacao do radar, o mesmo lugar onde cai o coletor de RSS.
const TIPOS_MONITORADO = ['emissao', 'oferta'];

// Categorias que a IA atribui a uma oferta de pontos/milhas. E a MESMA lista do
// server.js (processarBufferOfertaMilhas) e do coletor de RSS do painel — mora
// aqui porque a tela monta as caixas do filtro a partir dela: categoria nova
// entra nesta lista e aparece na aba Config sozinha, sem mexer no HTML.
export const CATEGORIAS_OFERTA_CDV = [
  { id: 'transferencia',     emoji: '🔄',  rotulo: 'Transferência bonificada' },
  { id: 'compra',            emoji: '💰',  rotulo: 'Compra de pontos' },
  { id: 'compra_bonificada', emoji: '🛍️', rotulo: 'Compra bonificada em parceiro' },
  { id: 'clube',             emoji: '🎁',  rotulo: 'Clube de assinatura' },
  { id: 'cartao',            emoji: '💳',  rotulo: 'Cartão de crédito' },
  { id: 'geral',             emoji: '📰',  rotulo: 'Geral / não classificada' },
];
const IDS_CATEGORIA_OFERTA = CATEGORIAS_OFERTA_CDV.map(c => c.id);

// Padrao = exatamente o que estava hardcoded no server.js ate esta versao. Um
// deploy sem config gravada se comporta como o sistema se comportava antes
// desta camada existir — nenhum grupo entra, nenhum grupo sai.
const CFG_CDV_PADRAO = {
  grupos: {
    // Destino das ofertas do radar de milhas (apelido 'cdv_ofertas').
    ofertas: '120363170138704529@g.us',
    // Destino das emissoes (apelido 'cdv_emissao').
    emissao: '120363172490263905@g.us',
    // Grupo interno de avisos do CDV. Vazio = os avisos vao so para os
    // telefones dos admins com papel 'avisos'. NAO herda o grupo do operador
    // do TSP: sao duas operacoes, e misturar os avisos foi justamente o que
    // afogou o grupo do TSP de ruido informativo.
    operador: '',
  },
  // Grupos de LEITURA: de onde o radar de milhas captura. `ativo:false` para
  // de capturar sem perder o cadastro — desligar e reversivel, e um JID que
  // some da lista volta como "grupo novo" sem nome e sem historico.
  monitorados: [
  { jid: '120363430801699326@g.us', nome: '', ativo: true },
  { jid: '120363409136599326@g.us', nome: '', ativo: true },
  { jid: '120363410708080270@g.us', nome: '', ativo: true },
  { jid: '120363229600818869@g.us', nome: 'TSM - ALERTAS BH', ativo: true },
  { jid: '120363298361885116@g.us', nome: 'TSM - ALERTAS SP #3', ativo: true },
  { jid: '120363301488379027@g.us', nome: 'TSM - ALERTAS RJ #2', ativo: true },
  { jid: '120363230402728347@g.us', nome: 'TSM - ALERTAS GOIÂNIA', ativo: true },
  { jid: '120363229682219999@g.us', nome: 'TSM - ALERTAS CURITIBA', ativo: true },
  { jid: '120363212151306916@g.us', nome: 'TSM - ALERTAS POA', ativo: true },
  { jid: '120363211235070904@g.us', nome: 'TSM - ALERTAS FLORIPA/NAVEGANTES', ativo: true },
  { jid: '120363230586056001@g.us', nome: 'TSM - ALERTAS FORTALEZA', ativo: true },
  { jid: '120363211276624072@g.us', nome: 'TSM - ALERTAS SALVADOR', ativo: true },
  { jid: '120363416996630307@g.us', nome: 'TSM - ALERTAS BRASÍLIA #3', ativo: true },
  { jid: '120363427410900900@g.us', nome: 'TSM - ALERTAS RECIFE #2', ativo: true },
  { jid: '120363423603571989@g.us', nome: 'TSM - ALERTAS UBERLÂNDIA', ativo: true },
  { jid: '120363428018752970@g.us', nome: 'TSM - ALERTAS CAMPO GRANDE #2', ativo: true },
  { jid: '120363281681293673@g.us', nome: 'TSM - ALERTAS ARACAJU', ativo: true },
  { jid: '120363231330746034@g.us', nome: 'TSM - ALERTAS BELÉM', ativo: true },
  { jid: '120363428522283420@g.us', nome: 'TSM - ALERTAS JOÃO PESSOA/CAMPINA GRANDE', ativo: true },
  { jid: '120363284038160631@g.us', nome: 'TSM - ALERTAS SÃO LUÍS', ativo: true },
  ],
  // Grupos de REENTRADA: onde um ex-aluno volta a ser colocado quando renova.
  // Lista separada dos destinos e dos monitorados de proposito — reentrada nao
  // e captura nem disparo, e misturar as tres faria um grupo desligado no radar
  // sumir tambem da reentrada. `ativo:false` tira da reentrada sem perder o
  // cadastro, igual aos monitorados.
  entrada: [],
  // Filtro da fila de aprovacao: categorias que NAO viram card, mesmo quando a
  // IA reconhece a promocao como valida. Serve para conteudo ja coberto por
  // outro pipeline (compra bonificada tem radar proprio no painel) — bloquear
  // aqui evita pagar aprovacao humana duas vezes pela mesma coisa.
  //
  // Vazio = tudo passa, que e como o sistema se comportava antes deste campo
  // existir. O filtro age DEPOIS da IA de proposito: so ela distingue
  // "transferencia bonificada" de "compra bonificada", e a palavra
  // "bonificada" aparece nas duas — filtro por texto bruto derrubaria a
  // transferencia junto.
  ofertas: {
    categoriasBloqueadas: [],
  },
  // Quem administra. `telefone` so importa para o papel 'avisos'; `email` so
  // importa para os papeis de permissao no gerador.
  admins: [],
  envio: {
    // Apelido da conta secundaria que dispara o CDV (aba Conexao). Vazio =
    // conta principal, que e o comportamento historico. Conta indisponivel na
    // hora do envio cai na principal — a mensagem sair pelo numero errado e
    // menos grave do que nao sair.
    conta: '',
  },
  leitura: {
    // Apelido da conta que LE os grupos monitorados do CDV. Vazio = principal.
    //
    // Envio e leitura sao escolhas separadas de proposito: e comum querer que o
    // CDV seja lido pelo numero que ja esta nos grupos de passagem e enviado
    // por outro, ou o contrario. Apontar as duas para a mesma conta e so um
    // caso particular.
    //
    // Se esta conta cair, a principal reassume a leitura — grupo cego e pior
    // que grupo lido pelo numero "errado", e a leitura nao muda nada do que o
    // assinante ve.
    conta: '',
  },
};

let _cfg = null;

// Merge raso por secao, como no config-tsp: config antiga sem um campo novo
// nao derruba o padrao daquele campo.
function estruturar(bruto) {
  const b = (bruto && typeof bruto === 'object') ? bruto : {};
  const out = {};
  for (const secao of Object.keys(CFG_CDV_PADRAO)) {
    const padrao = CFG_CDV_PADRAO[secao];
    if (Array.isArray(padrao)) {
      out[secao] = Array.isArray(b[secao]) ? b[secao] : JSON.parse(JSON.stringify(padrao));
    } else {
      out[secao] = { ...padrao, ...(b[secao] && typeof b[secao] === 'object' ? b[secao] : {}) };
    }
  }
  out.monitorados = normalizarMonitorados(out.monitorados);
  out.ofertas.categoriasBloqueadas = normalizarCategoriasOferta(out.ofertas.categoriasBloqueadas);
  out.entrada     = normalizarEntrada(out.entrada);
  out.admins      = normalizarAdmins(out.admins);
  out.grupos.ofertas  = String(out.grupos.ofertas  || '').trim();
  out.grupos.emissao  = String(out.grupos.emissao  || '').trim();
  out.grupos.operador = String(out.grupos.operador || '').trim();
  out.envio.conta     = String(out.envio.conta     || '').trim();
  out.leitura.conta   = String(out.leitura.conta   || '').trim();
  return out;
}

// Categoria desconhecida e DESCARTADA em vez de gravada: id torto viraria um
// filtro que nunca casa — bloqueio que o operador ve marcado na tela e que na
// pratica deixa tudo passar. Duplicata cai fora pelo Set.
function normalizarCategoriasOferta(bruto) {
  const lista = Array.isArray(bruto) ? bruto : [];
  const out = new Set();
  for (const item of lista) {
    const c = String(item || '').trim().toLowerCase();
    if (!c) continue;
    if (!IDS_CATEGORIA_OFERTA.includes(c)) {
      console.log('[CFG-CDV] Categoria de oferta ignorada (desconhecida): ' + c);
      continue;
    }
    out.add(c);
  }
  return [...out];
}

// Entrada torta e entrada DESCARTADA, nunca excecao no meio de uma captura.
// JID duplicado fica com a ultima ocorrencia: o painel envia a lista inteira a
// cada gravacao, entao a ultima e sempre a mais recente.
function normalizarMonitorados(bruto) {
  const lista = Array.isArray(bruto) ? bruto : [];
  const porJid = new Map();
  for (const item of lista) {
    const o = (item && typeof item === 'object') ? item : { jid: item };
    const jid = String(o.jid || '').trim();
    if (!RE_JID_GRUPO.test(jid)) {
      if (jid) console.log('[CFG-CDV] Grupo monitorado ignorado (JID invalido): ' + jid);
      continue;
    }
    porJid.set(jid, {
      jid,
      nome:  String(o.nome || '').trim(),
      // Ausencia do campo = ativo. Config gravada antes deste campo existir
      // (ou editada a mao no repositorio) nao pode desligar grupo por omissao.
      ativo: o.ativo !== false,
      // Ausencia do campo = 'emissao': e o que TODO grupo cadastrado antes
      // desta versao era. Tipo desconhecido tambem vira 'emissao' — mudar o
      // destino de um grupo por erro de digitacao seria pior que ignorar.
      tipo:  TIPOS_MONITORADO.includes(o.tipo) ? o.tipo : 'emissao',
    });
  }
  return [...porJid.values()];
}

// Mesma regra dos monitorados: JID torto e DESCARTADO, duplicata fica com a
// ultima ocorrencia (a tela manda a lista inteira a cada gravacao).
function normalizarEntrada(bruto) {
  const lista = Array.isArray(bruto) ? bruto : [];
  const porJid = new Map();
  for (const item of lista) {
    const o = (item && typeof item === 'object') ? item : { jid: item };
    const jid = String(o.jid || '').trim();
    if (!RE_JID_GRUPO.test(jid)) {
      if (jid) console.log('[CFG-CDV] Grupo de reentrada ignorado (JID invalido): ' + jid);
      continue;
    }
    porJid.set(jid, {
      jid,
      nome:  String(o.nome || '').trim(),
      ativo: o.ativo !== false,
    });
  }
  return [...porJid.values()];
}

// Admin sem nenhum identificador util (sem telefone e sem e-mail) nao
// administra nada: sai da lista. Papel desconhecido e descartado em vez de
// gravado — papel que nao existe no codigo nunca vira permissao.
function normalizarAdmins(bruto) {
  const lista = Array.isArray(bruto) ? bruto : [];
  const out = [];
  for (const item of lista) {
    const o = (item && typeof item === 'object') ? item : {};
    const telefone = String(o.telefone || '').replace(/\D/g, '');
    const email    = String(o.email || '').trim().toLowerCase();
    if (!telefone && !email) continue;
    const papeis = (Array.isArray(o.papeis) ? o.papeis : [])
      .map(p => String(p || '').trim().toLowerCase())
      .filter(p => PAPEIS_CDV.includes(p));
    out.push({
      nome: String(o.nome || '').trim(),
      telefone,
      email,
      papeis: [...new Set(papeis)],
    });
  }
  return out;
}

function carregarUm() {
  try {
    _cfg = existsSync(CAMINHO)
      ? estruturar(JSON.parse(readFileSync(CAMINHO, 'utf-8')))
      : estruturar({});
  } catch (e) {
    console.log('[CFG-CDV] Erro ao carregar config:', e.message);
    if (!_cfg) _cfg = estruturar({});
  }
}

export function carregarConfigCdv() {
  carregarUm();
  const ativos = _cfg.monitorados.filter(m => m.ativo);
  const deOferta = ativos.filter(m => m.tipo === 'oferta').length;
  console.log('[CFG-CDV] Config carregada — ' + ativos.length + '/' + _cfg.monitorados.length
    + ' grupo(s) monitorado(s) ativo(s) (' + (ativos.length - deOferta) + ' de emissao, '
    + deOferta + ' de oferta), ' + _cfg.entrada.filter(g => g.ativo).length
    + ' de reentrada, ' + _cfg.admins.length + ' admin(s).');
  const bloq = _cfg.ofertas.categoriasBloqueadas;
  console.log('[CFG-CDV] Categorias bloqueadas na fila de ofertas: '
    + (bloq.length ? bloq.join(', ') : 'nenhuma (tudo passa).'));
  return _cfg;
}

export function configCdv() {
  if (!_cfg) carregarUm();
  return _cfg;
}

/**
 * Gravacao parcial: o painel manda so a secao que mudou. Erro de validacao
 * LANCA — melhor a tela mostrar o motivo do que gravar um JID torto que
 * desliga a captura em silencio.
 */
export function salvarConfigCdv(parcial = {}) {
  const atual = configCdv();
  const novo = estruturar({
    grupos:      { ...atual.grupos,  ...(parcial.grupos  || {}) },
    envio:       { ...atual.envio,   ...(parcial.envio   || {}) },
    leitura:     { ...atual.leitura, ...(parcial.leitura || {}) },
    monitorados: parcial.monitorados !== undefined ? parcial.monitorados : atual.monitorados,
    entrada:     parcial.entrada     !== undefined ? parcial.entrada     : atual.entrada,
    ofertas:     { ...atual.ofertas, ...(parcial.ofertas || {}) },
    admins:      parcial.admins      !== undefined ? parcial.admins      : atual.admins,
  });

  // Os dois destinos sao obrigatorios: sem eles o gerador nao tem para onde
  // mandar oferta nem emissao, e resolverGrupo() devolveria null no envio.
  for (const [chave, rotulo] of [['ofertas', 'ofertas'], ['emissao', 'emissao']]) {
    const jid = novo.grupos[chave];
    if (!jid) throw new Error('Grupo de ' + rotulo + ' e obrigatorio.');
    if (!RE_JID_GRUPO.test(jid)) {
      throw new Error('Grupo de ' + rotulo + ' invalido: informe um JID de grupo (…@g.us).');
    }
  }
  if (novo.grupos.operador && !RE_JID_GRUPO.test(novo.grupos.operador)) {
    throw new Error('Grupo de avisos invalido: informe um JID de grupo (…@g.us) ou deixe vazio.');
  }
  if (novo.envio.conta && !RE_CONTA.test(novo.envio.conta)) {
    throw new Error('Conta de envio invalida: use o apelido da conta (2 a 24 caracteres).');
  }
  if (novo.leitura.conta && !RE_CONTA.test(novo.leitura.conta)) {
    throw new Error('Conta de leitura invalida: use o apelido da conta (2 a 24 caracteres).');
  }
  // Admin com papel 'avisos' e sem telefone e um aviso que nunca chega.
  for (const a of novo.admins) {
    if (a.papeis.includes('avisos') && !a.telefone) {
      throw new Error('Admin "' + (a.nome || a.email || '?') + '" tem o papel Avisos mas nao tem telefone.');
    }
  }

  _cfg = novo;
  try {
    if (!existsSync(SESSAO_DIR)) mkdirSync(SESSAO_DIR, { recursive: true });
    writeFileSync(CAMINHO, JSON.stringify(novo, null, 2), 'utf-8');
    agendarPush(NOME_PUSH);
  } catch (e) { console.log('[CFG-CDV] Erro ao salvar config:', e.message); }
  return novo;
}

// ── Acessores usados pelo restante do servidor ───────────────────────────────
// Funcoes, nunca constantes de modulo: gravar no painel passa a valer na
// proxima leitura, sem restart.

export function grupoOfertasCdv()  { return configCdv().grupos.ofertas; }
export function grupoEmissaoCdv()  { return configCdv().grupos.emissao; }
export function grupoAvisosCdv()   { return configCdv().grupos.operador; }

/** JIDs que o radar de milhas le AGORA. Grupo desligado nao entra. */
export function gruposMonitoradosCdv() {
  return configCdv().monitorados.filter(m => m.ativo).map(m => m.jid);
}

/** Cadastro completo, ligados e desligados — para a tela e para diagnostico. */
export function monitoradosCdv() {
  return configCdv().monitorados.map(m => ({ ...m }));
}

export function ehMonitoradoCdv(jid) {
  const j = String(jid || '').trim();
  if (!j) return false;
  return configCdv().monitorados.some(m => m.ativo && m.jid === j);
}

/** Tipo do grupo monitorado ('emissao' | 'oferta'). JID desconhecido -> null. */
export function tipoMonitoradoCdv(jid) {
  const j = String(jid || '').trim();
  if (!j) return null;
  const m = configCdv().monitorados.find(x => x.ativo && x.jid === j);
  return m ? (m.tipo || 'emissao') : null;
}

/** Grupo cadastrado como fonte de OFERTAS de pontos/milhas (radar). */
export function ehMonitoradoOfertaCdv(jid) {
  return tipoMonitoradoCdv(jid) === 'oferta';
}

/** Grupo cadastrado como fonte de EMISSOES (alerta de passagem). */
export function ehMonitoradoEmissaoCdv(jid) {
  return tipoMonitoradoCdv(jid) === 'emissao';
}

/** Nome cadastrado do grupo monitorado, para log e para a tela. */
export function nomeMonitoradoCdv(jid) {
  const j = String(jid || '').trim();
  const m = configCdv().monitorados.find(x => x.jid === j);
  return (m && m.nome) || '';
}

/** Apelido da conta que dispara o CDV. Vazio -> principal. */
export function contaEnvioCdv() { return configCdv().envio.conta; }

/** Apelido da conta que LE os grupos monitorados do CDV. Vazio -> principal. */
export function contaLeitoraCdv() { return configCdv().leitura.conta; }

/** Os dois destinos, para "este JID pertence ao CDV?". */
export function ehGrupoCdv(jid) {
  const j = String(jid || '').trim();
  if (!j) return false;
  const g = configCdv().grupos;
  return j === g.ofertas || j === g.emissao;
}

/** Cadastro completo dos grupos de reentrada, ligados e desligados — para a tela. */
export function entradaCdv() {
  return configCdv().entrada.map(g => ({ ...g }));
}

/** JIDs onde um ex-aluno deve ser recolocado AGORA. Grupo desligado nao entra. */
export function gruposEntradaCdv() {
  return configCdv().entrada.filter(g => g.ativo).map(g => g.jid);
}

/** Categorias que NAO entram na fila de aprovacao de ofertas. */
export function categoriasBloqueadasCdv() {
  return [...configCdv().ofertas.categoriasBloqueadas];
}

/** Esta categoria esta bloqueada AGORA? Leitura por chamada: gravar na tela
 *  passa a valer na proxima captura, sem restart. */
export function ehCategoriaOfertaBloqueadaCdv(categoria) {
  const c = String(categoria || '').trim().toLowerCase();
  if (!c) return false;
  return configCdv().ofertas.categoriasBloqueadas.includes(c);
}

export function adminsCdv() { return configCdv().admins.map(a => ({ ...a })); }

/** Telefones que recebem aviso operacional do CDV no WhatsApp. */
export function telefonesAvisoCdv() {
  return configCdv().admins
    .filter(a => a.papeis.includes('avisos') && a.telefone)
    .map(a => a.telefone);
}

/**
 * Permissoes de um e-mail no gerador. E-mail nao cadastrado nao tem papel
 * nenhum — mas ATENCAO: o gerador ainda nao tem login, entao isto organiza
 * quem faz o que, nao autentica ninguem. Enquanto o OTP nao chegar la (como
 * ja existe no painel-cdv), tratar como cadastro, nao como cadeado.
 */
export function papeisDoEmailCdv(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return [];
  const papeis = new Set();
  for (const a of configCdv().admins) {
    if (a.email && a.email === e) a.papeis.forEach(p => papeis.add(p));
  }
  return [...papeis];
}

// Auto-carrega no import, como o config-tsp: server.js pode ler a config
// imediatamente, sem depender da ordem do boot.
carregarConfigCdv();
