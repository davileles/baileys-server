// ── NOTAS SHOPEE: comissão extra de vendedores → NFS-e Nacional ─────────────
// (18/11/2026, decisão do Davi)
//
// Todo mês a Shopee publica no painel de afiliados o "Relatório mensal para
// Documentos Fiscais": cada vendedor que pagou comissão extra ao Tica Promos,
// com CNPJ/CPF, razão social, endereço e valor. Para cada um sai uma NFS-e da
// empresa do Davi (Simples Nacional, Belo Horizonte, já no Emissor Nacional).
//
// Fluxo, sem ninguém no meio:
//   1. Do dia `diaInicio` em diante, o servidor pede o relatório do mês
//      anterior à extensão Captura Tica (GET /notas-shopee/tarefa). Ela abre a
//      página do relatório no Chrome do operador, numa janela minimizada, lê as
//      respostas que a PRÓPRIA página recebe (a Shopee assina cada chamada; um
//      pedido feito por fora cai em verificação anti-robô) e devolve em
//      POST /notas-shopee/relatorio.
//   2. O servidor converte em notas (uma por CNPJ/CPF, soma das lojas do mesmo
//      vendedor; estrangeiros e sem documento ficam de fora, com o motivo).
//   3. Emite cada nota direto na API da Sefin Nacional: monta a DPS, assina
//      com o certificado A1 da empresa (XMLDSig RSA-SHA1, C14N, igual à nota
//      que o eNotas emitia) e envia em mTLS. Uma por vez.
//
// Travas:
//   - nada é emitido em produção sem certificado válido, sem os códigos do
//     serviço confirmados no painel (`codigosConfirmados`) e sem `ativo`;
//   - cada nota tem a sua DPS (série própria + número) gravada ANTES do envio.
//     Resposta perdida (rede, 5xx) não reenvia às cegas: a próxima tentativa
//     consulta GET /dps/{id} e, se a nota já existe, só registra a chave;
//   - reimportar o relatório não duplica: a nota é identificada por
//     mês + documento e uma nota emitida nunca volta a pendente.
//
// O certificado (.pfx) e a senha ficam SÓ no volume (sessao/nfse/), nunca no
// GitHub: este módulo não usa o sync e o arquivo de estado não guarda segredo.
// A senha é cifrada (AES-256-GCM) com chave derivada de TSP_TENANT_SECRET.

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { createHash, createCipheriv, createDecipheriv, randomBytes, sign as assinarRsa, createPrivateKey } from 'crypto';
import { gzipSync, gunzipSync } from 'zlib';
import https from 'https';
import forge from 'node-forge';

// ── Caminhos e estado ─────────────────────────────────────────────────────────
let DIR = './sessao';
let ESTADO_PATH = DIR + '/nfse_shopee.json';
let CERT_DIR = DIR + '/nfse';
let _avisar = null;            // ({nivel, chave, titulo, corpo}) => Promise — central de alertas do server.js

const URLS = {
  producao:         { sefin: 'https://sefin.nfse.gov.br/SefinNacional',                 adn: 'https://adn.nfse.gov.br' },
  producaorestrita: { sefin: 'https://sefin.producaorestrita.nfse.gov.br/SefinNacional', adn: 'https://adn.producaorestrita.nfse.gov.br' },
};
const NS_NFSE = 'http://www.sped.fazenda.gov.br/nfse';
const NS_DSIG = 'http://www.w3.org/2000/09/xmldsig#';
const VER_APLIC = 'TicaPromos_1.0';

// 17.06 propaganda/promoção de vendas (escolha do Davi em 18/11/2026; BH 001,
// NBS 1.1406.19.00). Mesmo assim só vale em produção depois de confirmado no painel.
function PRODUTO_SHOPEE_PADRAO() {
  return { id: 'shopee-comissao', nome: 'Comissão extra de vendedores Shopee', ativo: true,
           cTribNac: '170601', cTribMun: '001', cNBS: '114061900',
           xDescServ: 'Promoção de vendas de produtos do vendedor por programa de afiliados Shopee (comissão extra) - competência {mes} - loja(s): {lojas}',
           xInfComp: '', tribISSQN: '1', tpRetISSQN: '1', cstPisCofins: '00',
           tpRetPisCofins: '0', pTotTribSN: '', codigosConfirmados: false };
}
// Programas de afiliados que geram nota por aqui. Só a comissão extra da Shopee
// tem relatório automático hoje; os outros entram quando ganharem a sua fonte.
// A chave 'shopee' é a comissão extra de vendedores (nome antigo, mantido).
export const PROGRAMAS_NOTA = {
  amazon: 'Amazon · comissão de afiliado',
  mercadolivre: 'Mercado Livre · comissão de afiliado',
  shopee_afiliado: 'Shopee · comissão de afiliado',
  shopee: 'Shopee · comissão extra de vendedores',
};
// Nome do programa que entra na tag {programa} da descrição da nota.
export const PROGRAMAS_NOME = { amazon: 'Amazon', mercadolivre: 'Mercado Livre', shopee_afiliado: 'Shopee', shopee: 'Shopee' };

const CONFIG_PADRAO = {
  // Emissão (19/11/2026, mesmas opções do Gestão CDV — notas-fiscais.js do painel-cdv):
  // modo 'desligado' = nada roda sozinho; 'homologacao' = busca o relatório, só sai teste;
  // 'producao' = notas válidas (botão Emitir); emitirAuto = em produção, emite sozinho.
  modo: 'homologacao',
  emitirAuto: false,
  diaInicio: 5,                 // a partir de que dia do mês busca o relatório do mês anterior (folga para o relatório assentar)
  competencia: 'emissao',       // 'emissao' | 'pagamento' | 'mes' (no relatório mensal, pagamento = último dia do mês da comissão)
  horaIni: 9, horaFim: 20,      // janela (SP) para buscar/emitir
  agrupar: true,                // uma nota por CNPJ/CPF
  estrangeiros: false,          // vendedor de fora do Brasil fica de fora (sem documento brasileiro)
  minimo: 0,                    // valor mínimo por nota (R$); 0 = todas
  serie: '70',                  // série das DPS deste módulo (o eNotas usa a série 1)
  // Dados da empresa: cadastro ÚNICO com o Gestão CDV (proxy, notas-fiscais.json).
  // Salvou aqui, vai para lá; salvou lá, chega aqui (ver EMPRESA COMPARTILHADA).
  emitente: { cnpj: '', im: '', razao: '', fone: '', email: '', cLocEmi: '3106200',
              opSimpNac: '3', regApTribSN: '1', regEspTrib: '0' },
  // Produtos fiscais (19/11/2026): cada um define como a nota sai (códigos,
  // tributos e texto). Todo programa usa o produto padrão; `programas` guarda
  // só as exceções (programa → outro produto).
  produtos: [PRODUTO_SHOPEE_PADRAO()],
  produtoPadrao: 'shopee-comissao',
  programas: {},
};

let E = { config: JSON.parse(JSON.stringify(CONFIG_PADRAO)), proxNDPS: {}, meses: {}, avulsas: [], tarefa: null, cepIbge: {}, log: [], empresaSync: {} };

function escreverAtomico(caminho, dados) {
  const tmp = caminho + '.tmp';
  writeFileSync(tmp, dados);
  renameSync(tmp, caminho);
}
function gravar() {
  try { escreverAtomico(ESTADO_PATH, JSON.stringify(E)); } catch (e) { console.error('[NFSE] Falha ao gravar estado:', e.message); }
}
function mesclar(base, extra) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const k of Object.keys(extra || {})) {
    const v = extra[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' ? mesclar(base[k], v) : v;
  }
  return out;
}
function registrarLog(texto) {
  E.log = [{ em: new Date().toISOString(), texto: String(texto).slice(0, 300) }].concat(E.log || []).slice(0, 80);
  console.log('[NFSE] ' + texto);
}

export function iniciarNotasShopee(sessaoDir, opcoes = {}) {
  DIR = sessaoDir || DIR;
  ESTADO_PATH = DIR + '/nfse_shopee.json';
  CERT_DIR = DIR + '/nfse';
  _avisar = opcoes.avisar || null;
  _proxy = { url: opcoes.proxyUrl || '', chave: opcoes.chaveOp || '' };
  try { if (!existsSync(CERT_DIR)) mkdirSync(CERT_DIR, { recursive: true }); } catch (_) {}
  try {
    if (existsSync(ESTADO_PATH)) {
      const lido = JSON.parse(readFileSync(ESTADO_PATH, 'utf-8')) || {};
      E = Object.assign(E, lido);
      E.config = mesclar(CONFIG_PADRAO, lido.config || {});
      migrarProdutos(lido.config || {});
      migrarModo(lido.config || {});
    }
  } catch (e) { console.error('[NFSE] Estado ilegível, começando vazio:', e.message); }
  // Nota que estava "emitindo" quando o processo caiu: resultado incerto.
  for (const m of Object.values(E.meses || {})) for (const n of m.notas || []) if (n.status === 'emitindo') n.status = 'incerta';
  if (!Array.isArray(E.avulsas)) E.avulsas = [];
  for (const n of E.avulsas) { if (n.status === 'emitindo') n.status = 'incerta'; if (n.teste && n.teste.status === 'emitindo') n.teste.status = 'incerta'; }
  gravar();
  setTimeout(() => { trabalho().catch(e => console.error('[NFSE] trabalho:', e.message)); }, 4 * 60000).unref();
  setInterval(() => { trabalho().catch(e => console.error('[NFSE] trabalho:', e.message)); }, 10 * 60000).unref();
  // Empresa compartilhada com o Gestão CDV: confere 40 s após o boot e a cada 10 min.
  setTimeout(() => { sincronizarEmpresa().catch(() => {}); }, 40000).unref();
  setInterval(() => { sincronizarEmpresa().catch(() => {}); }, 10 * 60000).unref();
}

// Antes de 19/11/2026 havia um só "serviço" (config.servico) e uma só
// confirmação de códigos: vira o produto fiscal da Shopee.
function migrarProdutos(lidoCfg) {
  const c = E.config;
  if (lidoCfg.servico && !Array.isArray(lidoCfg.produtos)) {
    const p = Object.assign(PRODUTO_SHOPEE_PADRAO(), lidoCfg.servico, { codigosConfirmados: !!lidoCfg.codigosConfirmados });
    c.produtos = [p];
    c.programas = { shopee: p.id };
    registrarLog('Serviço antigo convertido no produto fiscal "' + p.nome + '"');
  }
  delete c.servico; delete c.codigosConfirmados;
  if (!Array.isArray(c.produtos) || !c.produtos.length) c.produtos = [PRODUTO_SHOPEE_PADRAO()];
  if (!c.programas || typeof c.programas !== 'object') c.programas = {};
  // Padrão + exceções (19/11/2026): sem padrão gravado, o produto da Shopee vira o padrão
  // e as exceções iguais a ele saem.
  if (!lidoCfg.produtoPadrao || !c.produtos.some(p => p.id === c.produtoPadrao)) c.produtoPadrao = (lidoCfg.programas || {}).shopee || c.produtos[0].id;
  if (!c.produtos.some(p => p.id === c.produtoPadrao)) c.produtoPadrao = c.produtos[0].id;
  for (const k of Object.keys(c.programas)) if (!PROGRAMAS_NOTA[k] || c.programas[k] === c.produtoPadrao || !c.produtos.some(p => p.id === c.programas[k])) delete c.programas[k];
}

// Antes de 19/11/2026: `ativo` (emitir sozinho) + `ambiente`. Vira modo + emitirAuto
// sem mudar o que já acontecia: o botão Emitir funcionava sempre (= Produção) e o
// automático só com `ativo`.
function migrarModo(lidoCfg) {
  const c = E.config;
  if (!lidoCfg.modo) { c.modo = 'producao'; c.emitirAuto = !!lidoCfg.ativo; }
  delete c.ativo; delete c.ambiente;
}
// Data de competência (mesma regra do Gestão CDV): produto fiscal → padrão da Emissão.
// O relatório mensal não tem data de pagamento por venda: 'pagamento' e 'mes' = último dia do mês.
function competenciaDa(s, mesId) {
  const m = (s && s.competencia) || E.config.competencia;
  return m === 'mes' || m === 'pagamento' ? ultimoDiaDoMes(mesId) : dhEmiSp().slice(0, 10);
}

// ── Produtos fiscais ──────────────────────────────────────────────────────────
function produtoPorId(id) { return (E.config.produtos || []).find(p => p.id === id) || null; }
export function produtoDoPrograma(programa = 'shopee') {
  return produtoPorId((E.config.programas || {})[programa]) || produtoPorId(E.config.produtoPadrao) || (E.config.produtos || [])[0] || null;
}

// ── EMPRESA COMPARTILHADA com o Gestão CDV ───────────────────────────────────
// A fonte é o proxy (painel-cdv, notas-fiscais.json → empresa), que o gestor-cdv
// edita. Daqui: GET/POST /notas/empresa com a chave de operador (CAMPANHAS_KEY).
// Campo preenchido lá vale aqui; campo vazio lá e preenchido aqui sobe para lá.
// Salvar aqui sem conseguir falar com o proxy fica "pendente" e sobe na próxima.
// A alíquota do Simples (pTotTribSN) NÃO é compartilhada: fica em cada produto.
let _proxy = { url: '', chave: '' };
const CAMPOS_EMPRESA = [['cnpj', 'cnpj'], ['im', 'im'], ['razao', 'razao'], ['cLocEmi', 'cMun'], ['fone', 'fone'], ['email', 'email'],
                        ['opSimpNac', 'opSimpNac'], ['regApTribSN', 'regApTribSN'], ['regEspTrib', 'regEspTrib']];
const CAMPOS_NUMERICOS = new Set(['opSimpNac', 'regApTribSN', 'regEspTrib']);
function empresaParaProxy(em) {
  const o = {};
  for (const [l, r] of CAMPOS_EMPRESA) {
    const v = String(em[l] == null ? '' : em[l]).trim();
    if (v !== '') o[r] = CAMPOS_NUMERICOS.has(r) ? Number(v) : v;
  }
  return o;
}
async function chamarProxy(caminho, corpo) {
  if (!_proxy.url || !_proxy.chave) throw new Error('sem chave de operador (CAMPANHAS_KEY) para falar com o Gestão CDV');
  const r = await fetch(_proxy.url + caminho, {
    method: corpo ? 'POST' : 'GET', signal: AbortSignal.timeout(12000),
    headers: { 'Content-Type': 'application/json', 'X-CDV-Op': _proxy.chave },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(j.erro || ('Gestão CDV respondeu ' + r.status));
  return j;
}
async function enviarEmpresa() {
  const j = await chamarProxy('/notas/empresa', { empresa: empresaParaProxy(E.config.emitente), origem: 'tica-promos' });
  aplicarEmpresaRemota(j.empresa || {});
  E.empresaSync = { ok: true, em: new Date().toISOString(), pendente: false, erro: '', atualizada: j.atualizada || null };
  gravar();
  return E.empresaSync;
}
function aplicarEmpresaRemota(r) {
  const em = E.config.emitente;
  let faltaLa = false;
  for (const [l, k] of CAMPOS_EMPRESA) {
    const v = r[k] == null ? '' : String(r[k]).trim();
    if (v !== '') em[l] = v;
    else if (String(em[l] || '').trim() !== '') faltaLa = true;
  }
  return faltaLa;
}
let _syncEmpresa = null;
export function sincronizarEmpresa({ maxIdadeMs = 0 } = {}) {
  const ult = E.empresaSync && E.empresaSync.em ? new Date(E.empresaSync.em).getTime() : 0;
  if (maxIdadeMs && E.empresaSync && E.empresaSync.ok && !E.empresaSync.pendente && Date.now() - ult < maxIdadeMs) return Promise.resolve(E.empresaSync);
  if (_syncEmpresa) return _syncEmpresa;
  _syncEmpresa = (async () => {
    try {
      if (E.empresaSync && E.empresaSync.pendente) return await enviarEmpresa();
      const j = await chamarProxy('/notas/empresa');
      const faltaLa = aplicarEmpresaRemota(j.empresa || {});
      if (faltaLa) return await enviarEmpresa();
      E.empresaSync = { ok: true, em: new Date().toISOString(), pendente: false, erro: '', atualizada: j.atualizada || null };
      gravar();
      return E.empresaSync;
    } catch (e) {
      E.empresaSync = Object.assign({}, E.empresaSync, { ok: false, erro: e.message, tentativaEm: new Date().toISOString() });
      gravar();
      return E.empresaSync;
    } finally { _syncEmpresa = null; }
  })();
  return _syncEmpresa;
}

// ── Datas (America/Sao_Paulo, -03:00 fixo) ───────────────────────────────────
function agoraSp() { return new Date(Date.now() - 3 * 3600e3); }   // campos UTC = relógio de SP
function dhEmiSp() {
  const d = new Date(Date.now() - 3 * 3600e3 - 60000);               // 1 min atrás: a Sefin recusa data no futuro
  return d.toISOString().slice(0, 19) + '-03:00';
}
function mesAnterior() {
  const d = agoraSp();
  const a = d.getUTCFullYear(), m = d.getUTCMonth();                 // m 0-based = mês atual
  return m === 0 ? (a - 1) + '12' : a + String(m).padStart(2, '0');
}
function ultimoDiaDoMes(mesId) {
  const a = +mesId.slice(0, 4), m = +mesId.slice(4, 6);
  const d = new Date(Date.UTC(a, m, 0));
  return d.toISOString().slice(0, 10);
}
function mesTexto(mesId) { return mesId.slice(4, 6) + '/' + mesId.slice(0, 4); }

// ── Certificado A1 ───────────────────────────────────────────────────────────
function chaveCifra() {
  const seg = process.env.TSP_TENANT_SECRET || process.env.CAMPANHAS_KEY || 'tica-nfse';
  return createHash('sha256').update('nfse-shopee|' + seg).digest();
}
function cifrar(txt) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', chaveCifra(), iv);
  const enc = Buffer.concat([c.update(String(txt), 'utf8'), c.final()]);
  return [iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}
function decifrar(s) {
  const [iv, tag, enc] = String(s || '').split('.');
  const d = createDecipheriv('aes-256-gcm', chaveCifra(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
}

// Abre o .pfx: chave privada + certificado do titular (PEM) e dados para a tela.
function abrirPfx(pfxBuf, senha) {
  let p12;
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(pfxBuf.toString('binary')));
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, String(senha || ''));
  } catch (e) {
    throw new Error(/mac|password|invalid/i.test(e.message) ? 'senha do certificado incorreta' : 'arquivo .pfx ilegível (' + e.message + ')');
  }
  const chaves = []
    .concat(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || [])
    .concat(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || []);
  const certs = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];
  if (!chaves.length || !chaves[0].key) throw new Error('o .pfx não tem chave privada');
  const chave = chaves[0].key;
  // Certificado do titular = o que tem a mesma chave pública da chave privada.
  const mod = chave.n.toString(16);
  const titular = certs.map(b => b.cert).find(c => c && c.publicKey && c.publicKey.n && c.publicKey.n.toString(16) === mod);
  if (!titular) throw new Error('o .pfx não tem o certificado da chave privada');
  const cn = (titular.subject.getField('CN') || {}).value || '';
  const m = /:(\d{14})\s*$/.exec(cn);
  return {
    keyPem: forge.pki.privateKeyToPem(chave),
    certPem: forge.pki.certificateToPem(titular),
    certB64: forge.util.encode64(forge.asn1.toDer(forge.pki.certificateToAsn1(titular)).getBytes()),
    cn, cnpj: m ? m[1] : '',
    validoDe: titular.validity.notBefore.toISOString(),
    validoAte: titular.validity.notAfter.toISOString(),
    emissor: (titular.issuer.getField('CN') || {}).value || '',
  };
}

let _certCache = null;   // { keyPem, certPem, certB64, ... } — só em memória
function certificado() {
  if (_certCache) return _certCache;
  const meta = lerMetaCert();
  if (!meta || !existsSync(CERT_DIR + '/cert.pfx')) return null;
  try {
    _certCache = abrirPfx(readFileSync(CERT_DIR + '/cert.pfx'), decifrar(meta.senha));
    return _certCache;
  } catch (e) { console.error('[NFSE] Certificado não abre:', e.message); return null; }
}
function lerMetaCert() {
  try { return JSON.parse(readFileSync(CERT_DIR + '/cert.json', 'utf-8')); } catch (_) { return null; }
}
export function salvarCertificado({ pfxB64, senha }) {
  const buf = Buffer.from(String(pfxB64 || ''), 'base64');
  if (buf.length < 500 || buf.length > 200000) throw new Error('arquivo .pfx inválido');
  const info = abrirPfx(buf, senha);
  if (new Date(info.validoAte) < new Date()) throw new Error('este certificado venceu em ' + info.validoAte.slice(0, 10));
  const cnpjEmit = String(E.config.emitente.cnpj || '').replace(/\D/g, '');
  if (cnpjEmit && info.cnpj && cnpjEmit !== info.cnpj) throw new Error('o certificado é do CNPJ ' + info.cnpj + ', diferente do emitente cadastrado (' + cnpjEmit + ')');
  escreverAtomico(CERT_DIR + '/cert.pfx', buf);
  escreverAtomico(CERT_DIR + '/cert.json', JSON.stringify({
    senha: cifrar(senha), cn: info.cn, cnpj: info.cnpj, validoDe: info.validoDe, validoAte: info.validoAte,
    emissor: info.emissor, enviadoEm: new Date().toISOString(),
  }));
  _certCache = info;
  if (!E.config.emitente.cnpj && info.cnpj) { E.config.emitente.cnpj = info.cnpj; gravar(); }
  registrarLog('Certificado cadastrado: ' + info.cn + ' (válido até ' + info.validoAte.slice(0, 10) + ')');
  return estadoCertificado();
}
function estadoCertificado() {
  const m = lerMetaCert();
  if (!m) return { cadastrado: false };
  const dias = Math.floor((new Date(m.validoAte) - Date.now()) / 86400e3);
  return { cadastrado: true, cn: m.cn, cnpj: m.cnpj, validoAte: m.validoAte, emissor: m.emissor, enviadoEm: m.enviadoEm,
           diasParaVencer: dias, vencido: dias < 0, abre: !!certificado() };
}

// ── Conversão do relatório da Shopee ─────────────────────────────────────────
const UF_POR_NOME = { 'acre':'AC','alagoas':'AL','amapa':'AP','amazonas':'AM','bahia':'BA','ceara':'CE','distrito federal':'DF','espirito santo':'ES','goias':'GO','maranhao':'MA','mato grosso':'MT','mato grosso do sul':'MS','minas gerais':'MG','para':'PA','paraiba':'PB','parana':'PR','pernambuco':'PE','piaui':'PI','rio de janeiro':'RJ','rio grande do norte':'RN','rio grande do sul':'RS','rondonia':'RO','roraima':'RR','santa catarina':'SC','sao paulo':'SP','sergipe':'SE','tocantins':'TO' };
function semAcento(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim(); }
function limpo(s) { return String(s == null ? '' : s).replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function digitos(s) { return String(s || '').replace(/\D/g, ''); }

// "R Fulano, 506, Andar 2 Sala 03 - Catumbi, São Paulo - São Paulo, 03021060"
export function lerEnderecoShopee(s) {
  const r = { xLgr: '', nro: 'S/N', xCpl: '', xBairro: '', cidade: '', uf: '', cep: '', ok: false };
  const m = String(s || '').trim().match(/^(.*) - ([^,]*), ([^,]*?) - ([^,]*?), (\d{5}-?\d{3})$/);
  if (!m) { r.xLgr = limpo(s); return r; }
  const partes = m[1].split(',');
  r.xLgr = limpo(partes[0]);
  r.nro = limpo(partes[1] || '') || 'S/N';
  r.xCpl = limpo(partes.slice(2).join(',')).replace(/^-+\s*/, '');
  r.xBairro = limpo(m[2]); r.cidade = limpo(m[3]);
  r.uf = UF_POR_NOME[semAcento(m[4])] || '';
  r.cep = digitos(m[5]);
  r.ok = !!(r.uf && r.cidade && r.cep.length === 8);
  return r;
}

// Comissão vem da API em unidades de 1/100.000 (1175976 = R$ 11,76).
function valorShopee(v) {
  const n = Number(String(v || '0').replace(/[^\d.-]/g, ''));
  return Math.round(n / 1000) / 100;
}

// itens: lista crua de queryAffiliateMonthlyReport (só o mês pedido)
export function converterRelatorio(mesId, itens, cfg = E.config) {
  const notas = [], fora = [], porChave = {};
  for (const it of itens || []) {
    const cnpj = digitos(it.sellerCnpj), cpf = digitos(it.sellerCpf);
    const pais = String(it.sellerRegion || 'BR').toUpperCase();
    const loja = { shopId: String(it.shopId || ''), nome: limpo(it.shopName), valor: valorShopee(it.totalSellerCommission) };
    const base = {
      doc: cnpj ? cnpj.padStart(14, '0') : (cpf ? cpf.padStart(11, '0') : ''),
      tipo: cnpj ? 'CNPJ' : (cpf ? 'CPF' : ''),
      nome: limpo(it.sellerLegalName) || loja.nome,
      email: limpo(it.email),
      endereco: lerEnderecoShopee(it.sellerAddress),
      enderecoTexto: limpo(it.sellerAddress),
      pais, docEstrangeiro: limpo(it.foreignTaxId),
    };
    let motivo = '';
    if (String(it.completedMonth) !== mesId) motivo = 'outro mês (' + it.completedMonth + ')';
    else if (!(loja.valor > 0)) motivo = 'sem valor';
    else if (pais !== 'BR') motivo = 'vendedor estrangeiro (' + pais + ')';
    else if (!base.doc) motivo = 'sem CNPJ/CPF';
    if (motivo) { fora.push({ loja, nome: base.nome, motivo }); continue; }
    const chave = cfg.agrupar ? base.doc : base.doc + '-' + loja.shopId;
    let n = porChave[chave];
    if (!n) { n = porChave[chave] = Object.assign({ chave, lojas: [], valor: 0, status: 'pendente' }, base); notas.push(n); }
    n.lojas.push(loja);
    n.valor = Math.round((n.valor + loja.valor) * 100) / 100;
  }
  const minimo = Number(cfg.minimo) || 0;
  const ficam = [];
  for (const n of notas) {
    if (minimo > 0 && n.valor < minimo) n.lojas.forEach(l => fora.push({ loja: l, nome: n.nome, motivo: 'abaixo do mínimo (R$ ' + n.valor.toFixed(2) + ')' }));
    else ficam.push(n);
  }
  return { notas: ficam, fora };
}

// ── Pedido do relatório à extensão ───────────────────────────────────────────
const TAREFA_RESERVA_MS = 20 * 60000;   // entregue e sem retorno: libera de novo

export function tarefaParaExtensao() {
  const t = E.tarefa;
  if (!t) return null;
  if (t.entregueEm && Date.now() - t.entregueEm < TAREFA_RESERVA_MS) return null;
  t.entregueEm = Date.now(); t.tentativas = (t.tentativas || 0) + 1;
  gravar();
  return { mes: t.mes, motivo: t.motivo || 'mensal' };
}

export function pedirRelatorio(mesId, motivo = 'manual') {
  if (!/^\d{6}$/.test(mesId)) throw new Error('mês inválido');
  E.tarefa = { mes: mesId, motivo, pedidaEm: Date.now(), entregueEm: 0, tentativas: 0 };
  gravar();
  registrarLog('Relatório de ' + mesTexto(mesId) + ' pedido à extensão (' + motivo + ')');
  return E.tarefa;
}

// Body: { mes, itens:[...], amostra:[{shopId, texto}], total, erro?, url? }
export function receberRelatorio(b = {}) {
  const mesId = String(b.mes || '');
  if (!/^\d{6}$/.test(mesId)) throw new Error('mês inválido');
  if (b.erro) {
    if (E.tarefa && E.tarefa.mes === mesId) E.tarefa.entregueEm = Date.now() - TAREFA_RESERVA_MS + 30 * 60000;   // tenta de novo em ~30 min
    const m = E.meses[mesId] || (E.meses[mesId] = { notas: [], fora: [] });
    m.erroRelatorio = { em: new Date().toISOString(), erro: String(b.erro).slice(0, 300), url: String(b.url || '').slice(0, 300) };
    gravar();
    registrarLog('Extensão não leu o relatório de ' + mesTexto(mesId) + ': ' + b.erro);
    if (/login|verifica|captcha/i.test(String(b.erro))) avisar('critico', 'nfse:relatorio-bloqueado',
      'Shopee pediu login/verificação no relatório mensal',
      '🧾 *Notas Shopee: relatório não lido*\n\nA Captura Tica abriu o relatório mensal da Shopee e caiu em ' + b.erro + '.\n\n'
      + 'Abra https://affiliate.shopee.com.br/report/monthly_report no Chrome da extensão, entre/resolva a verificação. A extensão tenta de novo sozinha em 30 min.');
    return { ok: true, registrado: 'erro' };
  }
  const itens = Array.isArray(b.itens) ? b.itens : [];
  // Conferência da escala do valor contra o que a tela mostrou.
  for (const a of (b.amostra || []).slice(0, 5)) {
    const it = itens.find(x => String(x.shopId) === String(a.shopId));
    const tela = Number(String(a.texto || '').replace(/[^\d,]/g, '').replace(',', '.'));
    if (it && tela > 0 && Math.abs(valorShopee(it.totalSellerCommission) - tela) > 0.011) {
      throw new Error('valor da API não bate com a tela (loja ' + a.shopId + ': ' + valorShopee(it.totalSellerCommission) + ' × ' + tela + ') — a Shopee mudou o formato?');
    }
  }
  const { notas, fora } = converterRelatorio(mesId, itens);
  const antigo = E.meses[mesId] || { notas: [] };
  // Nota já emitida (ou em andamento) nunca volta a pendente nem muda de valor.
  const travadas = new Map((antigo.notas || []).filter(n => n.status !== 'pendente' && n.status !== 'erro' && n.status !== 'ignorada').map(n => [n.chave, n]));
  const ignoradas = new Set((antigo.notas || []).filter(n => n.status === 'ignorada').map(n => n.chave));
  const final = notas.map(n => travadas.get(n.chave) || Object.assign(n, ignoradas.has(n.chave) ? { status: 'ignorada' } : {}));
  for (const [k, n] of travadas) if (!final.some(x => x.chave === k)) final.push(n);
  E.meses[mesId] = {
    notas: final, fora,
    relatorio: { em: new Date().toISOString(), origem: b.origem === 'arquivo' ? 'arquivo' : 'extensao', linhas: itens.length, total: Math.round(final.reduce((s, n) => s + n.valor, 0) * 100) / 100 },
  };
  if (E.tarefa && E.tarefa.mes === mesId) E.tarefa = null;
  gravar();
  registrarLog('Relatório de ' + mesTexto(mesId) + ' recebido: ' + final.length + ' notas, ' + fora.length + ' fora');
  setTimeout(() => { trabalho().catch(e => console.error('[NFSE] trabalho:', e.message)); }, 5000).unref();
  return { ok: true, notas: final.length, fora: fora.length };
}

// ── DPS: montagem e assinatura ───────────────────────────────────────────────
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function tag(nome, valor) { return valor === '' || valor == null ? '' : '<' + nome + '>' + esc(valor) + '</' + nome + '>'; }
function corta(s, n) { return limpo(s).slice(0, n); }

async function codigoIbge(cep) {
  if (!cep || cep.length !== 8) return '';
  if (E.cepIbge[cep]) return E.cepIbge[cep];
  try {
    const r = await fetch('https://viacep.com.br/ws/' + cep + '/json/', { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const ibge = j && /^\d{7}$/.test(String(j.ibge || '')) ? String(j.ibge) : '';
    if (ibge) { E.cepIbge[cep] = ibge; gravar(); }
    return ibge;
  } catch (_) { return ''; }
}

function idDps(cfg, nDPS) {
  const cnpj = digitos(cfg.emitente.cnpj).padStart(14, '0');
  return 'DPS' + cfg.emitente.cLocEmi + '2' + cnpj + String(cfg.serie).padStart(5, '0') + String(nDPS).padStart(15, '0');
}

function textoServico(modelo, mesId, n) {
  const lojas = n.lojas.map(l => l.nome + ' (ID ' + l.shopId + ')').join(', ');
  const programa = PROGRAMAS_NOME[n.programa || 'shopee'] || 'Shopee';
  return String(modelo || '').replace(/\{programa\}/g, programa).replace(/\{mes\}/g, mesTexto(mesId)).replace(/\{lojas\}/g, lojas).replace(/\{valor\}/g, n.valor.toFixed(2).replace('.', ','));
}

// Devolve o XML do infDPS (sem namespace: ele é herdado do <DPS>).
async function montarInfDps(n, mesId, ambiente, nDPS, s = produtoDoPrograma('shopee')) {
  const cfg = E.config, em = cfg.emitente;
  if (!s) throw new Error('nenhum produto fiscal escolhido para a Shopee');
  const id = idDps(cfg, nDPS);
  const e = n.endereco || {};
  const cMun = e.ok ? await codigoIbge(e.cep) : '';
  const toma = '<toma>' + tag(n.tipo === 'CPF' ? 'CPF' : 'CNPJ', n.doc) + tag('xNome', corta(n.nome, 300))
    + (cMun ? '<end><endNac>' + tag('cMun', cMun) + tag('CEP', e.cep) + '</endNac>' + tag('xLgr', corta(e.xLgr, 255))
      + tag('nro', corta(e.nro, 60)) + tag('xCpl', corta(e.xCpl, 156)) + tag('xBairro', corta(e.xBairro, 60)) + '</end>' : '')
    + (digitos(n.fone).length >= 10 ? tag('fone', digitos(n.fone).slice(-11)) : '')
    + (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(n.email || '') ? tag('email', corta(n.email, 80)) : '')
    + '</toma>';
  const xml = '<infDPS Id="' + id + '">'
    + tag('tpAmb', ambiente === 'producao' ? '1' : '2')
    + tag('dhEmi', dhEmiSp())
    + tag('verAplic', VER_APLIC)
    + tag('serie', String(cfg.serie))
    + tag('nDPS', String(nDPS))
    // Competência do produto fiscal (19/11/2026); vazio = a padrão da Emissão.
    // Avulsa (mesma regra do Gestão CDV): data digitada; sem ela, a da emissão.
    + tag('dCompet', n.avulsa ? (n.competencia || dhEmiSp().slice(0, 10)) : competenciaDa(s, mesId))
    + tag('tpEmit', '1')
    + tag('cLocEmi', em.cLocEmi)
    + '<prest>' + tag('CNPJ', digitos(em.cnpj)) + tag('IM', digitos(em.im)) + tag('fone', digitos(em.fone)) + tag('email', em.email)
      + '<regTrib>' + tag('opSimpNac', em.opSimpNac) + tag('regApTribSN', em.regApTribSN) + tag('regEspTrib', em.regEspTrib) + '</regTrib></prest>'
    + toma
    + '<serv><locPrest>' + tag('cLocPrestacao', em.cLocEmi) + '</locPrest>'
      + '<cServ>' + tag('cTribNac', s.cTribNac) + tag('cTribMun', s.cTribMun) + tag('xDescServ', corta(n.descricao || textoServico(s.xDescServ, mesId, n), 2000)) + tag('cNBS', s.cNBS) + '</cServ>'
      + (s.xInfComp ? '<infoCompl>' + tag('xInfComp', corta(textoServico(s.xInfComp, mesId, n), 2000)) + '</infoCompl>' : '')
    + '</serv>'
    + '<valores><vServPrest>' + tag('vServ', n.valor.toFixed(2)) + '</vServPrest>'
      + '<trib><tribMun>' + tag('tribISSQN', s.tribISSQN) + tag('tpRetISSQN', s.tpRetISSQN) + '</tribMun>'
      + (s.cstPisCofins ? '<tribFed><piscofins>' + tag('CST', s.cstPisCofins) + tag('tpRetPisCofins', s.tpRetPisCofins) + '</piscofins></tribFed>' : '')
      + '<totTrib>' + (s.pTotTribSN ? tag('pTotTribSN', s.pTotTribSN) : '<indTotTrib>0</indTotTrib>') + '</totTrib></trib>'
    + '</valores>'
    + '</infDPS>';
  return { id, xml };
}

// XMLDSig envelopado, C14N inclusivo 1.0, RSA-SHA1 (o leiaute nacional aceita
// o mesmo que o eNotas usava). O XML é gerado por este módulo já na forma
// canônica (sem espaços, sem tag vazia, atributos em ordem), então a forma
// canônica de cada elemento é a própria string + a declaração de namespace
// herdada que o C14N acrescenta.
export function assinarDps(infXml, id, cert) {
  const infCanon = infXml.replace(/^<infDPS /, '<infDPS xmlns="' + NS_NFSE + '" ');
  const digest = createHash('sha1').update(infCanon, 'utf8').digest('base64');
  const signedInfoCorpo = '<CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"></CanonicalizationMethod>'
    + '<SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"></SignatureMethod>'
    + '<Reference URI="#' + id + '"><Transforms>'
    + '<Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"></Transform>'
    + '<Transform Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"></Transform>'
    + '</Transforms><DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"></DigestMethod>'
    + '<DigestValue>' + digest + '</DigestValue></Reference>';
  const signedInfoCanon = '<SignedInfo xmlns="' + NS_DSIG + '">' + signedInfoCorpo + '</SignedInfo>';
  const assinatura = assinarRsa('sha1', Buffer.from(signedInfoCanon, 'utf8'), createPrivateKey(cert.keyPem)).toString('base64');
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<DPS versao="1.00" xmlns="' + NS_NFSE + '">' + infXml
    + '<Signature xmlns="' + NS_DSIG + '"><SignedInfo>' + signedInfoCorpo + '</SignedInfo>'
    + '<SignatureValue>' + assinatura + '</SignatureValue>'
    + '<KeyInfo><X509Data><X509Certificate>' + cert.certB64 + '</X509Certificate></X509Data></KeyInfo></Signature>'
    + '</DPS>';
}

// ── Chamadas à Sefin / ADN (mTLS com o certificado A1) ───────────────────────
function chamar(url, { metodo = 'GET', corpo = null, cert, timeoutMs = 60000, binario = false } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const dados = corpo ? Buffer.from(JSON.stringify(corpo), 'utf8') : null;
    const req = https.request({
      method: metodo, hostname: u.hostname, path: u.pathname + u.search, port: 443,
      key: cert.keyPem, cert: cert.certPem, timeout: timeoutMs,
      headers: Object.assign({ Accept: binario ? 'application/pdf' : 'application/json' },
        dados ? { 'Content-Type': 'application/json', 'Content-Length': dados.length } : {}),
    }, res => {
      const partes = [];
      res.on('data', c => partes.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(partes);
        if (binario) return resolve({ status: res.statusCode, buf, tipo: res.headers['content-type'] || '' });
        let json = null;
        try { json = buf.length ? JSON.parse(buf.toString('utf8')) : null; } catch (_) {}
        resolve({ status: res.statusCode, json, texto: buf.toString('utf8').slice(0, 2000) });
      });
    });
    req.on('timeout', () => req.destroy(new Error('tempo esgotado')));
    req.on('error', reject);
    if (dados) req.write(dados);
    req.end();
  });
}

function errosSefin(json, texto) {
  const lista = (json && (json.erros || json.Erros || json.erro)) || [];
  const arr = Array.isArray(lista) ? lista : [lista];
  const msg = arr.map(e => [e.Codigo || e.codigo, e.Descricao || e.descricao, e.Complemento || e.complemento].filter(Boolean).join(' - ')).filter(Boolean).join(' | ');
  return msg || (texto || '').slice(0, 300) || 'erro sem descrição';
}

function nNfseDoXml(b64) {
  try {
    const xml = gunzipSync(Buffer.from(b64, 'base64')).toString('utf8');
    const m = /<nNFSe>(\d+)<\/nNFSe>/.exec(xml);
    return m ? m[1] : '';
  } catch (_) { return ''; }
}

// Já existe NFS-e para esta DPS? (resposta perdida numa tentativa anterior)
async function consultarDps(id, ambiente, cert) {
  const r = await chamar(URLS[ambiente].sefin + '/dps/' + id, { cert, timeoutMs: 30000 });
  if (r.status === 200 && r.json && (r.json.chaveAcesso || r.json.ChaveAcesso)) return { existe: true, chave: r.json.chaveAcesso || r.json.ChaveAcesso };
  if (r.status === 404) return { existe: false };
  throw new Error('consulta da DPS respondeu ' + r.status + ': ' + errosSefin(r.json, r.texto));
}

function proximoNumero(ambiente) {
  const k = ambiente + '|' + E.config.serie;
  const n = (E.proxNDPS[k] || 1);
  E.proxNDPS[k] = n + 1;
  return n;
}

// Emite UMA nota. Grava o número da DPS antes de enviar.
async function emitirNota(mesId, n, { ambiente = 'producao' } = {}) {
  const cert = certificado();
  if (!cert) throw new Error('certificado não cadastrado ou não abre');
  if (new Date(cert.validoAte) < new Date()) throw new Error('certificado vencido');
  const tent = ambiente === 'producao' ? n : (n.teste || (n.teste = {}));
  // Tentativa anterior sem resposta: confere na Sefin antes de reenviar.
  if (tent.idDps && (tent.status === 'incerta' || tent.status === 'emitindo')) {
    const c = await consultarDps(tent.idDps, ambiente, cert);
    if (c.existe) {
      Object.assign(tent, { status: 'emitida', chaveAcesso: c.chave, emitidaEm: new Date().toISOString(), erro: '' });
      gravar();
      registrarLog('Nota de ' + n.nome + ' já existia na Sefin (DPS ' + tent.nDPS + '): chave registrada');
      return tent;
    }
  }
  if (!tent.nDPS || tent.ambienteDps !== ambiente) {
    tent.nDPS = proximoNumero(ambiente);
    tent.ambienteDps = ambiente;
  }
  // Produto fiscal: o do programa agora; numa nova tentativa da mesma DPS, o de antes.
  const pf = (tent.idDps && tent.produtoId && produtoPorId(tent.produtoId))
    || (n.produtoFiscalId && produtoPorId(n.produtoFiscalId)) || produtoDoPrograma(n.programa || 'shopee');
  if (!pf) throw new Error('nenhum produto fiscal escolhido');
  if (ambiente === 'producao' && !pf.codigosConfirmados) throw new Error('códigos de "' + pf.nome + '" não confirmados com o contador');
  const { id, xml } = await montarInfDps(n, mesId, ambiente, tent.nDPS, pf);
  const assinado = assinarDps(xml, id, cert);
  Object.assign(tent, { idDps: id, produtoId: pf.id, status: 'emitindo', tentativas: (tent.tentativas || 0) + 1, ultimaTentativaEm: new Date().toISOString() });
  gravar();
  let r;
  try {
    r = await chamar(URLS[ambiente].sefin + '/nfse', { metodo: 'POST', cert, corpo: { dpsXmlGZipB64: gzipSync(Buffer.from(assinado, 'utf8')).toString('base64') } });
  } catch (e) {
    Object.assign(tent, { status: 'incerta', erro: 'sem resposta da Sefin: ' + e.message });
    gravar();
    throw e;
  }
  if (r.status === 201 || r.status === 200) {
    const chave = r.json && (r.json.chaveAcesso || r.json.ChaveAcesso) || '';
    Object.assign(tent, { status: 'emitida', chaveAcesso: chave, nNFSe: nNfseDoXml(r.json && r.json.nfseXmlGZipB64 || ''),
                          emitidaEm: new Date().toISOString(), erro: '' });
    gravar();
    return tent;
  }
  if (r.status >= 500 || r.status === 429) {
    Object.assign(tent, { status: 'incerta', erro: 'Sefin respondeu ' + r.status + ': ' + errosSefin(r.json, r.texto) });
    gravar();
    throw new Error(tent.erro);
  }
  // 4xx = rejeitada: a DPS não virou nota; o número segue reservado (a próxima
  // tentativa usa número novo para não colidir com a recusada).
  Object.assign(tent, { status: 'erro', erro: errosSefin(r.json, r.texto), nDPS: 0, idDps: '' });
  gravar();
  throw new Error(tent.erro);
}

// ── Trabalho periódico ───────────────────────────────────────────────────────
let _emitindo = false;
function naJanela() {
  const h = agoraSp().getUTCHours();
  return h >= E.config.horaIni && h < E.config.horaFim;
}
export function bloqueiosEmissao(ambiente = 'producao', produto = null) {
  const b = [];
  if (ambiente === 'producao' && E.config.modo !== 'producao') b.push('emissão em ' + (E.config.modo === 'desligado' ? 'Desligado' : 'Homologação') + ' (ligue o modo Produção)');
  const cert = estadoCertificado();
  if (!cert.cadastrado) b.push('certificado não cadastrado');
  else if (cert.vencido) b.push('certificado vencido');
  else if (!cert.abre) b.push('certificado não abre (senha?)');
  const em = E.config.emitente, s = produto || produtoDoPrograma('shopee');
  if (digitos(em.cnpj).length !== 14) b.push('CNPJ do emitente');
  if (!digitos(em.im)) b.push('inscrição municipal do emitente');
  if (!/^\d{7}$/.test(String(em.cLocEmi))) b.push('município do emitente');
  if (!s) b.push('produto fiscal da Shopee não escolhido');
  else {
    if (s.ativo === false) b.push('produto fiscal "' + s.nome + '" desligado');
    if (!/^\d{6}$/.test(String(s.cTribNac))) b.push('código de tributação nacional de "' + s.nome + '"');
    if (ambiente === 'producao' && !s.codigosConfirmados) b.push('códigos de "' + s.nome + '" não confirmados com o contador');
  }
  return b;
}

async function trabalho() {
  if (_emitindo) return;
  const cfg = E.config;
  if (cfg.modo === 'desligado' || !naJanela()) return;
  const dia = agoraSp().getUTCDate();
  const alvo = mesAnterior();
  if (dia >= (Number(cfg.diaInicio) || 1)) {
    const m = E.meses[alvo];
    if (!m || !m.relatorio) {
      if (!E.tarefa || E.tarefa.mes !== alvo) pedirRelatorio(alvo, 'mensal');
      return;
    }
  }
  if (cfg.modo !== 'producao' || !cfg.emitirAuto) return;
  // Automático só emite o mês anterior. Outros meses (buscados à mão no painel,
  // por exemplo um mês que já saiu pelo eNotas) só saem pelo botão Emitir.
  const mesesComPendente = [alvo].filter(k => E.meses[k] && (E.meses[k].notas || []).some(n => ['pendente', 'incerta'].includes(n.status)));
  if (!mesesComPendente.length) return;
  const b = bloqueiosEmissao('producao');
  if (b.length) {
    avisar('critico', 'nfse:bloqueada', 'Notas fiscais (Shopee) esperando configuração',
      '🧾 *Notas fiscais da Shopee paradas*\n\nHá notas para emitir (' + mesesComPendente.map(mesTexto).join(', ') + '), mas falta: ' + b.join(', ')
      + '.\n\nResolva no painel do Tica Promos → Resultados → 🧾 Notas Fiscais.', 24 * 3600e3);
    return;
  }
  for (const k of mesesComPendente.sort()) await emitirMes(k, { origem: 'automático' });
}

export async function emitirMes(mesId, { origem = 'painel', so = null } = {}) {
  if (_emitindo) throw new Error('já existe uma emissão em andamento');
  const m = E.meses[mesId];
  if (!m) throw new Error('mês sem relatório');
  const b = bloqueiosEmissao('producao');
  if (b.length) throw new Error('falta: ' + b.join(', '));
  _emitindo = true;
  let ok = 0, falhas = [];
  try {
    for (const n of m.notas) {
      if (so && !so.includes(n.chave)) continue;
      if (!['pendente', 'incerta', so ? 'erro' : '_'].includes(n.status)) continue;
      try {
        await emitirNota(mesId, n, { ambiente: 'producao' });
        ok++;
      } catch (e) {
        falhas.push(n.nome + ': ' + e.message);
        if (/certificado|mTLS|ECONNRESET|tempo esgotado|ENOTFOUND|socket/i.test(e.message)) break;   // problema geral: para o lote
      }
      await new Promise(r => setTimeout(r, 1500 + Math.random() * 1500));
    }
  } finally { _emitindo = false; }
  const total = m.notas.filter(n => n.status === 'emitida').reduce((s, n) => s + n.valor, 0);
  registrarLog('Emissão ' + mesTexto(mesId) + ' (' + origem + '): ' + ok + ' emitida(s), ' + falhas.length + ' falha(s)');
  if (falhas.length) avisar('critico', 'nfse:falhas:' + mesId, 'Notas fiscais (Shopee) com falha',
    '🧾 *Notas fiscais Shopee ' + mesTexto(mesId) + '*\n\n' + ok + ' emitida(s) agora, ' + falhas.length + ' com falha:\n'
    + falhas.slice(0, 8).map(f => '• ' + f).join('\n') + (falhas.length > 8 ? '\n…' : '')
    + '\n\nDetalhes no painel → Resultados → 🧾 Notas Fiscais.', 6 * 3600e3);
  else if (ok) avisar('info', 'nfse:ok:' + mesId, 'Notas fiscais Shopee ' + mesTexto(mesId) + ' emitidas',
    ok + ' nota(s) emitida(s); total emitido no mês R$ ' + total.toFixed(2));
  return { ok: true, emitidas: ok, falhas };
}

// Nota de teste na produção restrita (homologação): não vale como nota fiscal.
export async function emitirTeste(mesId, chave) {
  const m = E.meses[mesId];
  if (!m) throw new Error('mês sem relatório');
  const n = chave ? m.notas.find(x => x.chave === chave) : m.notas.find(x => x.status !== 'ignorada');
  if (!n) throw new Error('nota não encontrada');
  const b = bloqueiosEmissao('producaorestrita');
  if (b.length) throw new Error('falta: ' + b.join(', '));
  try {
    const t = await emitirNota(mesId, n, { ambiente: 'producaorestrita' });
    registrarLog('Teste em homologação ok: ' + n.nome + ' → ' + t.chaveAcesso);
    return { ok: true, nota: n.nome, chaveAcesso: t.chaveAcesso, nNFSe: t.nNFSe };
  } catch (e) {
    registrarLog('Teste em homologação falhou (' + n.nome + '): ' + e.message);
    return { ok: false, nota: n.nome, erro: e.message };
  }
}

// ── Nota avulsa (19/11/2026, mesma função do Gestão CDV) ─────────────────────
// Tomador digitado, ex.: comissão de afiliados da Amazon, do Mercado Livre ou
// da Shopee. Teste = homologação (produção restrita); válida = produção, só no
// modo Produção e com confirmação. Fica em E.avulsas, fora dos meses da Shopee.
function cpfValido(d) {
  if (!/^\d{11}$/.test(d) || /^(\d)\1+$/.test(d)) return false;
  for (const t of [9, 10]) {
    let s = 0; for (let i = 0; i < t; i++) s += +d[i] * (t + 1 - i);
    if (((s * 10) % 11) % 10 !== +d[t]) return false;
  }
  return true;
}
function cnpjValido(d) {
  if (!/^\d{14}$/.test(d) || /^(\d)\1+$/.test(d)) return false;
  for (const t of [12, 13]) {
    let s = 0, p = t - 7;
    for (let i = 0; i < t; i++) { s += +d[i] * p--; if (p < 2) p = 9; }
    if ((s % 11 < 2 ? 0 : 11 - s % 11) !== +d[t]) return false;
  }
  return true;
}
export async function emitirAvulsa(corpo = {}) {
  const t = corpo.tomador || {};
  const doc = digitos(t.doc);
  const tipo = doc.length === 14 ? 'CNPJ' : 'CPF';
  if (!(tipo === 'CNPJ' ? cnpjValido(doc) : cpfValido(doc))) throw new Error('CPF/CNPJ do tomador inválido');
  const valor = Math.round(Number(String(corpo.valor).replace(',', '.')) * 100) / 100;
  if (!(valor > 0)) throw new Error('valor inválido');
  const pf = produtoPorId(corpo.produtoFiscalId) || produtoPorId(E.config.produtoPadrao);
  if (!pf) throw new Error('produto fiscal inválido');
  const comp = corpo.competencia && /^\d{4}-\d{2}-\d{2}$/.test(corpo.competencia) ? corpo.competencia : '';
  const ambiente = corpo.teste ? 'producaorestrita' : 'producao';
  if (!corpo.teste && !corpo.confirmar) throw new Error('confirmação ausente');
  const b = bloqueiosEmissao(ambiente, pf);
  if (b.length) throw new Error('falta: ' + b.join(', '));
  const n = {
    chave: 'AV-' + Date.now(), avulsa: true, criadaEm: new Date().toISOString(), doc, tipo,
    nome: limpo(t.nome) || doc, email: limpo(t.email), fone: limpo(t.fone), valor, lojas: [],
    produtoFiscalId: pf.id, descricao: limpo(corpo.descricao), competencia: comp, status: corpo.teste ? 'teste' : 'pendente',
  };
  E.avulsas.unshift(n);
  if (E.avulsas.length > 300) E.avulsas.length = 300;
  gravar();
  const mesId = (comp || dhEmiSp()).slice(0, 7).replace('-', '');
  try {
    const r = await emitirNota(mesId, n, { ambiente });
    registrarLog((corpo.teste ? 'Teste avulso em homologação ok: ' : 'Nota avulsa emitida: ') + n.nome + ' → ' + r.chaveAcesso);
    return { ok: true, chave: n.chave, chaveAcesso: r.chaveAcesso, nNFSe: r.nNFSe, teste: !!corpo.teste };
  } catch (e) {
    registrarLog('Nota avulsa' + (corpo.teste ? ' (teste)' : '') + ' falhou (' + n.nome + '): ' + e.message);
    return { ok: false, chave: n.chave, erro: e.message, teste: !!corpo.teste };
  }
}

export function marcarNota(mesId, chave, acao, extra = {}) {
  const n = acharNota(mesId, chave);
  if (!n) throw new Error('nota não encontrada');
  // Cancelada direto no Portal Nacional (mesmo que "Já cancelei no portal" do Gestão CDV).
  if (acao === 'cancelada-fora') {
    if (n.status !== 'emitida') throw new Error('só nota emitida');
    Object.assign(n, { status: 'cancelada', canceladaEm: new Date().toISOString(), canceladaPor: 'portal', motivo: corta(extra.motivo, 255) });
    gravar();
    registrarLog('Nota marcada como cancelada no portal: ' + n.nome);
    return n;
  }
  if (mesId === 'avulsa') throw new Error('ação desconhecida');
  if (acao === 'ignorar') { if (n.status === 'emitida') throw new Error('nota já emitida'); n.status = 'ignorada'; }
  else if (acao === 'reativar') { if (n.status !== 'ignorada' && n.status !== 'erro') throw new Error('só nota ignorada ou com erro'); n.status = 'pendente'; n.erro = ''; }
  else if (acao === 'emitida-fora') { if (n.status === 'emitida') throw new Error('nota já emitida'); n.status = 'emitida'; n.foraDoSistema = true; n.emitidaEm = new Date().toISOString(); }
  else throw new Error('ação desconhecida');
  gravar();
  return n;
}

// ── Cancelamento (evento e101101) ────────────────────────────────────────────
// Mesma regra do Gestão CDV (painel-cdv/nfse.js `cancelar` + notas-fiscais.js
// `cancelarUma`), decisão do Davi de 19/11/2026: mudou um, muda o outro.
// motivo: 1 = erro na emissão, 2 = serviço não prestado, 9 = outros.
// justificativa: 15 a 255 caracteres. mesId 'avulsa' = nota avulsa.
function acharNota(mesId, chave) {
  if (mesId === 'avulsa') return (E.avulsas || []).find(x => x.chave === chave) || null;
  const m = E.meses[mesId];
  return (m && (m.notas || []).find(x => x.chave === chave)) || null;
}

function assinarEvento(id, corpo, cert, versao) {
  const infCanon = '<infPedReg xmlns="' + NS_NFSE + '" Id="' + id + '">' + corpo + '</infPedReg>';
  const digest = createHash('sha1').update(infCanon, 'utf8').digest('base64');
  const signedInfoCorpo = '<CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"></CanonicalizationMethod>'
    + '<SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"></SignatureMethod>'
    + '<Reference URI="#' + id + '"><Transforms>'
    + '<Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"></Transform>'
    + '<Transform Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"></Transform>'
    + '</Transforms><DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"></DigestMethod>'
    + '<DigestValue>' + digest + '</DigestValue></Reference>';
  const signedInfoCanon = '<SignedInfo xmlns="' + NS_DSIG + '">' + signedInfoCorpo + '</SignedInfo>';
  const valor = assinarRsa('sha1', Buffer.from(signedInfoCanon, 'utf8'), createPrivateKey(cert.keyPem)).toString('base64');
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<pedRegEvento xmlns="' + NS_NFSE + '" versao="' + versao + '"><infPedReg Id="' + id + '">' + corpo + '</infPedReg>'
    + '<Signature xmlns="' + NS_DSIG + '"><SignedInfo>' + signedInfoCorpo + '</SignedInfo>'
    + '<SignatureValue>' + valor + '</SignatureValue>'
    + '<KeyInfo><X509Data><X509Certificate>' + cert.certB64 + '</X509Certificate></X509Data></KeyInfo></Signature>'
    + '</pedRegEvento>';
}

function errosLista(json, texto, status) {
  const lista = (json && (json.erros || json.Erros || json.erro)) || [];
  const arr = (Array.isArray(lista) ? lista : [lista]).map(e => ({
    codigo: String(e.Codigo || e.codigo || ''), descricao: String(e.Descricao || e.descricao || ''), complemento: String(e.Complemento || e.complemento || ''),
  })).filter(e => e.codigo || e.descricao);
  if (!arr.length) arr.push({ codigo: 'HTTP' + status, descricao: String(texto || '').slice(0, 400), complemento: '' });
  return arr;
}

async function pedirCancelamento(ambiente, cert, chaveAcesso, motivo, justificativa, versao = '1.01', tentouOutra = false) {
  const id = 'PRE' + chaveAcesso + '101101';
  const corpo = tag('tpAmb', ambiente === 'producao' ? '1' : '2') + tag('verAplic', VER_APLIC) + tag('dhEvento', dhEmiSp())
    + tag('CNPJAutor', digitos(E.config.emitente.cnpj)) + tag('chNFSe', chaveAcesso)
    + '<e101101>' + tag('xDesc', 'Cancelamento de NFS-e') + tag('cMotivo', String(motivo)) + tag('xMotivo', justificativa) + '</e101101>';
  const xml = assinarEvento(id, corpo, cert, versao);
  let r;
  try {
    r = await chamar(URLS[ambiente].sefin + '/nfse/' + chaveAcesso + '/eventos', { metodo: 'POST', cert,
      corpo: { pedidoRegistroEventoXmlGZipB64: gzipSync(Buffer.from(xml, 'utf8')).toString('base64') } });
  } catch (e) {
    return { ok: false, ambiguo: true, erros: [{ codigo: 'REDE', descricao: e.message, complemento: '' }] };
  }
  const j = r.json;
  const evB64 = j && (j.eventoXmlGZipB64 || j.EventoXmlGZipB64);
  if ((r.status === 200 || r.status === 201) && evB64) {
    let xmlEv = '';
    try { xmlEv = gunzipSync(Buffer.from(evB64, 'base64')).toString('utf8'); } catch (_) {}
    return { ok: true, xml: xmlEv };
  }
  const erros = errosLista(j, r.texto, r.status);
  if (!tentouOutra && erros.some(e => /esquema|schema|vers[aã]o/i.test(e.descricao + ' ' + e.complemento))) {
    return pedirCancelamento(ambiente, cert, chaveAcesso, motivo, justificativa, '1.00', true);
  }
  const jaCancelada = erros.some(e => /j[aá] (est[aá] )?cancelad|evento j[aá] (registrad|vinculad)/i.test(e.descricao + ' ' + e.complemento));
  return { ok: false, status: r.status, ambiguo: r.status >= 500, jaCancelada, erros };
}

export async function cancelarNota(mesId, chave, { teste = false, motivo = 9, justificativa = '', origem = 'manual' } = {}) {
  const n = acharNota(mesId, chave);
  if (!n) throw new Error('nota não encontrada');
  const tent = teste ? n.teste : n;
  if (!tent) throw new Error('essa nota não tem teste emitido');
  if (tent.status === 'cancelada') return { ok: true, jaCancelada: true };
  if (tent.status !== 'emitida') throw new Error('só nota emitida pode ser cancelada');
  if (tent.foraDoSistema) throw new Error('nota emitida fora do sistema: cancele no Portal Nacional e use "Já cancelei no portal"');
  const ch = digitos(tent.chaveAcesso);
  if (ch.length !== 50) throw new Error('nota sem chave de acesso: cancele no Portal Nacional e use "Já cancelei no portal"');
  const mot = [1, 2, 9].includes(Number(motivo)) ? Number(motivo) : 9;
  const just = corta(justificativa, 255);
  if (just.length < 15) throw new Error('a justificativa precisa de pelo menos 15 caracteres');
  const cert = certificado();
  if (!cert) throw new Error('certificado não cadastrado ou não abre');
  if (new Date(cert.validoAte) < new Date()) throw new Error('certificado vencido');
  const ambiente = teste ? 'producaorestrita' : 'producao';
  let r;
  try { r = await pedirCancelamento(ambiente, cert, ch, mot, just); }
  catch (e) { r = { ok: false, erros: [{ codigo: 'LOCAL', descricao: e.message, complemento: '' }] }; }
  const agora = new Date().toISOString();
  tent.cancelamentoTentativas = (Number(tent.cancelamentoTentativas) || 0) + 1;
  tent.cancelamentoTentadoEm = agora;
  if (r.ok || r.jaCancelada) {
    Object.assign(tent, { status: 'cancelada', canceladaEm: agora, canceladaPor: origem, motivoCancelamento: mot, motivo: just, cancelamentoErros: [] });
    if (r.xml) tent.eventoXmlGz = gzipSync(Buffer.from(r.xml, 'utf8')).toString('base64');
    registrarLog((teste ? 'Teste cancelado' : 'Nota cancelada') + ': ' + n.nome + ' (' + ch + ')');
  } else {
    tent.cancelamentoErros = r.erros || [];
    registrarLog('Cancelamento recusado (' + n.nome + '): ' + (r.erros || []).map(e => e.codigo + ' ' + e.descricao).join('; ').slice(0, 300));
  }
  gravar();
  return r.ok || r.jaCancelada ? { ok: true } : { ok: false, erros: r.erros };
}

// DPS assinada de uma nota, sem enviar (conferência no painel). Não consome número.
export async function previaDps(mesId, chave, ambiente = 'producaorestrita') {
  const m = E.meses[mesId];
  const n = m && (chave ? m.notas.find(x => x.chave === chave) : m.notas[0]);
  if (!n) throw new Error('nota não encontrada');
  const cert = certificado();
  if (!cert) throw new Error('certificado não cadastrado');
  const { id, xml } = await montarInfDps(n, mesId, ambiente, 999999);
  return assinarDps(xml, id, cert);
}

export async function baixarDanfse(chave, ambiente = 'producao') {
  const cert = certificado();
  if (!cert) throw new Error('certificado não cadastrado');
  if (!/^\d{50}$/.test(String(chave))) throw new Error('chave inválida');
  // O ADN fica instável (503/504) com frequência: tenta de novo antes de desistir.
  const esperas = [0, 3000, 8000];
  let ultimo = '';
  for (const ms of esperas) {
    if (ms) await new Promise(res => setTimeout(res, ms));
    let r;
    try { r = await chamar(URLS[ambiente].adn + '/danfse/' + chave, { cert, binario: true, timeoutMs: 45000 }); }
    catch (e) { ultimo = e.message; continue; }
    if (r.status === 200 && /pdf/i.test(r.tipo)) return r.buf;
    ultimo = 'ADN respondeu ' + r.status;
    if (r.status < 500 && r.status !== 429) break;   // erro definitivo: não adianta repetir
  }
  throw new Error(ultimo + ' (o ADN da NFS-e Nacional está fora do ar agora; a nota segue emitida, tente de novo mais tarde ou baixe pela Consulta Pública do Portal Nacional com a chave de acesso)');
}

// ── Configuração ─────────────────────────────────────────────────────────────
const CAMPOS_TEXTO = /^[\s\S]{0,2000}$/;
export function salvarConfig(c = {}) {
  const novo = mesclar(E.config, c);
  novo.modo = ['desligado', 'homologacao', 'producao'].includes(novo.modo) ? novo.modo : 'homologacao';
  novo.emitirAuto = novo.emitirAuto === true;
  delete novo.ativo; delete novo.ambiente;
  novo.competencia = ['pagamento', 'mes'].includes(novo.competencia) ? novo.competencia : 'emissao';
  novo.diaInicio = Math.min(28, Math.max(1, Number(novo.diaInicio) || 1));
  novo.horaIni = Math.min(23, Math.max(0, Number(novo.horaIni) || 9));
  novo.horaFim = Math.min(24, Math.max(novo.horaIni + 1, Number(novo.horaFim) || 20));
  novo.minimo = Math.max(0, Number(String(novo.minimo).replace(',', '.')) || 0);
  novo.serie = String(digitos(novo.serie) || '70').slice(0, 5);
  if (Array.isArray(c.produtos)) novo.produtos = validarProdutos(c.produtos);
  if (c.produtoPadrao != null) novo.produtoPadrao = String(c.produtoPadrao);
  if (!novo.produtos.some(p => p.id === novo.produtoPadrao)) throw new Error('escolha o produto fiscal padrão');
  // Exceções: a lista enviada substitui a anterior (dá para remover uma).
  const progs = Object.assign({}, c.programas && typeof c.programas === 'object' ? c.programas : E.config.programas);
  for (const k of Object.keys(progs)) if (!PROGRAMAS_NOTA[k] || progs[k] === novo.produtoPadrao || !novo.produtos.some(p => p.id === progs[k])) delete progs[k];
  novo.programas = progs;
  for (const k of ['cnpj', 'im', 'fone', 'cLocEmi']) novo.emitente[k] = digitos(novo.emitente[k]);
  novo.emitente.razao = String(novo.emitente.razao || '').trim().slice(0, 300);
  novo.emitente.email = String(novo.emitente.email || '').trim().slice(0, 80);
  E.config = novo;
  gravar();
  return E.config;
}

function validarProdutos(lista) {
  const ids = new Set();
  return lista.map(p => {
    const id = String(p.id || '').trim().replace(/[^\w-]/g, '').slice(0, 40) || ('pf-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5));
    if (ids.has(id)) throw new Error('produto fiscal repetido: ' + id);
    ids.add(id);
    const antes = produtoPorId(id);
    const x = Object.assign(PRODUTO_SHOPEE_PADRAO(), {
      id, nome: String(p.nome || '').trim().slice(0, 80), ativo: p.ativo !== false,
      cTribNac: digitos(p.cTribNac), cTribMun: digitos(p.cTribMun) || '001', cNBS: digitos(p.cNBS),
      xDescServ: String(p.xDescServ || '').trim(), xInfComp: String(p.xInfComp || '').trim(),
      tribISSQN: digitos(p.tribISSQN) || '1', tpRetISSQN: digitos(p.tpRetISSQN) || '1',
      cstPisCofins: digitos(p.cstPisCofins), tpRetPisCofins: digitos(p.tpRetPisCofins) || '0',
      pTotTribSN: String(p.pTotTribSN == null ? '' : p.pTotTribSN).trim().replace(',', '.'),
      codigosConfirmados: p.codigosConfirmados === true,
      competencia: ['emissao', 'pagamento', 'mes'].includes(p.competencia) ? p.competencia : '',
    });
    if (!x.nome) throw new Error('produto fiscal sem nome');
    if (x.cTribNac.length !== 6) throw new Error(x.nome + ': código de tributação nacional precisa de 6 dígitos');
    if (x.cNBS.length !== 9) throw new Error(x.nome + ': NBS precisa de 9 dígitos');
    if (!x.xDescServ) throw new Error(x.nome + ': descrição da nota vazia');
    if (!CAMPOS_TEXTO.test(x.xDescServ) || !CAMPOS_TEXTO.test(x.xInfComp)) throw new Error(x.nome + ': texto longo demais');
    if (x.pTotTribSN && !/^\d{1,2}(\.\d{1,2})?$/.test(x.pTotTribSN)) throw new Error(x.nome + ': alíquota do Simples inválida');
    // Mexeu nos códigos: precisa confirmar de novo com o contador (o painel
    // desmarca a caixa ao editar um código; aqui só vale se veio marcada).
    if (antes && ['cTribNac', 'cTribMun', 'cNBS'].some(k => antes[k] !== x[k]) && p.codigosConfirmados !== true) x.codigosConfirmados = false;
    return x;
  });
}

// Salva a configuração e, se a empresa mudou, manda para o Gestão CDV.
export async function salvarConfigCompartilhada(c = {}) {
  const antes = JSON.stringify(empresaParaProxy(E.config.emitente));
  salvarConfig(c);
  let empresaSync = E.empresaSync;
  if (JSON.stringify(empresaParaProxy(E.config.emitente)) !== antes) {
    E.empresaSync = Object.assign({}, E.empresaSync, { pendente: true });
    gravar();
    try { empresaSync = await enviarEmpresa(); }
    catch (e) { E.empresaSync = Object.assign({}, E.empresaSync, { ok: false, erro: e.message, tentativaEm: new Date().toISOString() }); gravar(); empresaSync = E.empresaSync; }
  }
  return { config: E.config, empresaSync };
}

// Preenche emitente/regime a partir do XML de uma NFS-e já emitida pela empresa.
export function importarXmlEmitente(xml) {
  const g = (re) => { const m = re.exec(xml); return m ? m[1] : ''; };
  const prest = g(/<prest>([\s\S]*?)<\/prest>/);
  if (!prest) throw new Error('XML sem o bloco do prestador (<prest>)');
  const em = E.config.emitente;
  const v = {
    cnpj: g(/<prest>[\s\S]*?<CNPJ>(\d{14})<\/CNPJ>/), im: g(/<prest>[\s\S]*?<IM>(\d+)<\/IM>/),
    fone: g(/<prest>[\s\S]*?<fone>(\d+)<\/fone>/), email: g(/<prest>[\s\S]*?<email>([^<]+)<\/email>/),
    cLocEmi: g(/<cLocEmi>(\d{7})<\/cLocEmi>/),
    opSimpNac: g(/<opSimpNac>(\d)<\/opSimpNac>/), regApTribSN: g(/<regApTribSN>(\d)<\/regApTribSN>/), regEspTrib: g(/<regEspTrib>(\d)<\/regEspTrib>/),
  };
  for (const k of Object.keys(v)) if (v[k]) em[k] = v[k];
  const s = produtoDoPrograma('shopee') || {};
  const trib = { tribISSQN: g(/<tribISSQN>(\d)<\/tribISSQN>/), tpRetISSQN: g(/<tpRetISSQN>(\d)<\/tpRetISSQN>/),
                 cstPisCofins: g(/<piscofins>[\s\S]*?<CST>(\d+)<\/CST>/), tpRetPisCofins: g(/<tpRetPisCofins>(\d)<\/tpRetPisCofins>/),
                 pTotTribSN: g(/<pTotTribSN>([\d.]+)<\/pTotTribSN>/) };
  for (const k of Object.keys(trib)) if (trib[k]) s[k] = trib[k];
  E.empresaSync = Object.assign({}, E.empresaSync, { pendente: true });
  gravar();
  registrarLog('Dados do emitente importados de um XML de NFS-e');
  sincronizarEmpresa().catch(() => {});
  return { emitente: em, servico: s, codigosDoXml: { cTribNac: g(/<cTribNac>(\d+)<\/cTribNac>/), cTribMun: g(/<cTribMun>(\d+)<\/cTribMun>/), cNBS: g(/<cNBS>(\d+)<\/cNBS>/) } };
}

// ── Estado para o painel ─────────────────────────────────────────────────────
function camposCancelamento(x) {
  return { canceladaEm: x.canceladaEm || '', canceladaPor: x.canceladaPor || '', motivoCancelamento: x.motivoCancelamento || 0,
           motivo: x.status === 'cancelada' ? (x.motivo || '') : '', cancelamentoErros: x.cancelamentoErros || [] };
}
export function estadoNotasShopee() {
  const meses = Object.keys(E.meses).sort().reverse().map(k => {
    const m = E.meses[k];
    const cont = {};
    for (const n of m.notas || []) cont[n.status] = (cont[n.status] || 0) + 1;
    return {
      mes: k, relatorio: m.relatorio || null, erroRelatorio: m.erroRelatorio || null, contagem: cont,
      totalEmitido: Math.round((m.notas || []).filter(n => n.status === 'emitida').reduce((s, n) => s + n.valor, 0) * 100) / 100,
      notas: (m.notas || []).map(n => ({ chave: n.chave, doc: n.doc, tipo: n.tipo, nome: n.nome, valor: n.valor, status: n.status,
        lojas: n.lojas, cidade: n.endereco && n.endereco.ok ? n.endereco.cidade + '/' + n.endereco.uf : '', enderecoOk: !!(n.endereco && n.endereco.ok),
        nDPS: n.nDPS || 0, chaveAcesso: n.chaveAcesso || '', nNFSe: n.nNFSe || '', emitidaEm: n.emitidaEm || '', erro: n.erro || '',
        foraDoSistema: !!n.foraDoSistema, produtoId: n.produtoId || '', ...camposCancelamento(n),
        teste: n.teste ? { status: n.teste.status, chaveAcesso: n.teste.chaveAcesso || '', erro: n.teste.erro || '', ...camposCancelamento(n.teste) } : null })),
      fora: m.fora || [],
    };
  });
  return { ok: true, config: E.config, programasNota: PROGRAMAS_NOTA, empresaSync: E.empresaSync || {},
           certificado: estadoCertificado(), bloqueios: bloqueiosEmissao('producao'),
           tarefa: E.tarefa, emitindo: _emitindo, mesAlvo: mesAnterior(), meses, log: (E.log || []).slice(0, 30),
           avulsas: (E.avulsas || []).slice(0, 60).map(n => {
             const x = n.teste || n;
             return { chave: n.chave, criadaEm: n.criadaEm, doc: n.doc, nome: n.nome, valor: n.valor, produtoId: n.produtoFiscalId,
                      teste: !!n.teste, status: x.status, chaveAcesso: x.chaveAcesso || '', nNFSe: x.nNFSe || '', erro: x.erro || '',
                      foraDoSistema: !!x.foraDoSistema, ...camposCancelamento(x) };
           }) };
}

function avisar(nivel, chave, titulo, corpo, janelaMs) {
  if (!_avisar) return;
  try { Promise.resolve(_avisar({ nivel, origem: 'nfse', chave, titulo, corpo, janelaMs })).catch(() => {}); } catch (_) {}
}
