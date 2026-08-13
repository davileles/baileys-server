import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  initAuthCreds,
  BufferJSON,
  proto,
} from '@whiskeysockets/baileys';
import express from 'express';
import cors from 'cors';
import pino from 'pino';
import multer from 'multer';
import { Boom } from '@hapi/boom';
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { readdir, unlink, writeFile as writeFileAsync, readFile as readFileAsync, rename as renameAsync, mkdir as mkdirAsync, rm as rmAsync } from 'fs/promises';
import { join } from 'path';
import QRCode from 'qrcode';

// ── RADAR DE MARKETPLACE (Amazon hoje; ML e Shopee entram pelo mesmo pipeline) ─
import {
  carregarRadarConfig, salvarRadarConfig, radarConfig,
  radarFontes, radarDestinos, ehFonteRadar,
  processarTextoAmazon,
  registrarCupomBase, listarCuponsBase, atualizarCupomBase, removerCupomBase, definirAtivoPorLoja,
  cupomPorCodigo, cupomVigente, calcularDesconto, melhorCupomAplicavel,
  cupomCitadoDesconhecido,
  janelaCupom, salvarJanelaCupom, dentroDaJanelaCupom,
  turnosTsp, salvarTurnosTsp, contaDoTurno,
  listarTemplates, templateDaLoja, salvarTemplate, removerTemplate,
  templateCupom, templateAwin, templateProprioDaLoja,
  renderTemplate, varsDoProduto, VARIAVEIS_TEMPLATE, VARIAVEIS_CUPOM,
  resolverLinhaVitrine, listarVitrine, salvarItemVitrine, removerItemVitrine,
  buscarProdutos, normalizar,
  itemVitrine, marcarDisparo, montarOfertasVitrine,
  listarListas, listaPorId, salvarLista, removerLista, atualizarExecucaoLista, cupomDaLista,
  listarMonitor, monitorDoGrupo, salvarMonitor, removerMonitor,
  podeCapturar, LOJAS_MONITORAVEIS, semearMonitorDasFontes,
  carregarCuponsBase, carregarTemplates, carregarVitrine, sondarRecursos,
  recarregarRadarTenants,
} from './radar-amazon.js';

// ── SINCRONIZACAO COM O GITHUB ────────────────────────────────────────────────
import {
  baixarDoGitHub, pushImediato, estadoSync, sincronizacaoAtiva, testarAcesso, agendarPush,
} from './sync-github.js';

// ── VITRINE PUBLICA (tudosobrepromos.com) ─────────────────────────────────────
import {
  iniciarFeedPublico, registrarPublicacao, publicarAgora, estadoFeedPublico,
} from './feed-publico.js';

// ── CONFIG DA OPERACAO TSP (editavel pelo painel) ─────────────────────────────
import {
  carregarConfigTsp, configTsp, salvarConfigTsp,
  linksTsp,
  gruposTspCupons, grupoOperadorTsp, tgIgnoradosConfig,
  estadoCredenciais, aplicarCredenciais,
} from './config-tsp.js';

// ── REGISTRO DE OPERADORES (fase 2.1 do modelo hospedado) ─────────────────────
import {
  carregarTenants, listarTenants, resolverTenant, TENANT_PADRAO, comContextoTenant, tenantContexto,
  tokenDaReq, tenantPorEmail, tenantPorId, criarTenant, atualizarTenant,
} from './tenants.js';

// ── AWIN (rede de afiliados) ─────────────────────────────────────────────────
import {
  credenciaisAwinOk, carregarProgramasAwin, atualizarProgramasAwin,
  listarProgramasAwin, programaAwinPorLoja, programaAwinPorUrl, linkAwinDaLoja,
  gerarLinkAwin, quotaLinkAwin, buscarOfertasAwin, normalizarOfertaAwin,
  estadoAwin, ehLinkAwin, processarTextoAwin, limparUrlAwin, extrairProdutoAwin,
  resolverLinhaVitrineAwin, montarOfertasAwinVitrine, ttlPrecoAwin,
  chaveVitrineAwin, deeplinkAwin,
} from './radar-awin.js';
import {
  credenciaisFeedOk, carregarFeedListDoDisco, atualizarFeedList,
  feedsDoAnunciante, estadoFeed, amostraFeed,
} from './awin-feed.js';
import {
  configOfertasAwin, carregarConfigOfertasAwin, salvarConfigOfertasAwin,
  carregarOfertadosAwin, marcarOfertado, usoDeHoje,
  carregarCandidatosAwin, reabastecerCandidatosAwin, estadoCandidatos,
  proximosCandidatos, dentroDaJanelaAwin, vagasAgora,
  candidatosRanqueados, retirarCandidatos,
} from './awin-ofertas.js';
import { formatarOfertaAwin, definirTtlPrecoAwin } from './radar-awin.js';
import { definirTtlFeedHoras } from './awin-feed.js';
import { bootBotTsp, tratarUpdateBotTsp, BOT_TSP_PATH } from './bot-tsp.js';
// Matching de desejos de compra x ofertas do radar. Controlado por MATCH_DESEJOS
// (off | aviso | on). Em 'off' — o padrao — o modulo nao faz nada.
import { casarDesejosComOferta, MODO_DESEJOS } from './matching-desejos.js';

// Espalha os prazos da config para os modulos que os usam. Chamado no boot e
// depois de cada gravacao, para valer sem redeploy.
function aplicarTtlsAwin() {
  const c = configOfertasAwin();
  definirTtlPrecoAwin(c.precoTtlHoras);
  definirTtlFeedHoras(c.feedTtlHoras);
}

// ── RADAR SHOPEE ──────────────────────────────────────────────────────────────
import {
  processarTextoShopee, ehLinkShopee, extrairIdsShopee, buscarProdutoShopee,
  normalizarShopee, credenciaisShopeeOk, montarOfertasShopeeVitrine,
  validarAtribuicao, resolverEncurtadorShopee, chamarShopee,
} from './radar-shopee.js';

// ── RADAR MERCADO LIVRE ───────────────────────────────────────────────────────
import {
  processarTextoMl, ehLinkMl, extrairIdsMl, buscarProdutoMl, normalizarMl,
  credenciaisMlOk, estadoMl, urlAutorizacao, trocarCodePorToken, ML_REDIRECT_URI,
  sondarMl, chamarAff, tokenAffOk, saudeAff, verificarTokenAff, inspecionarTokenAff,
  chavesCookieAff, lerCuponsAtivosMl, lerTodosCuponsMl, ativarCupomMl, validadeDeTexto,
  resolverLinhaVitrineMl, montarOfertasMlVitrine, dumpCupomMl, dumpCampanhasCupomMl,
  sincronizarCuponsContaMl, listarCampanhasMl, campanhaMlConhecida,
} from './radar-ml.js';

// URL usada para testar a validade do token do painel de afiliados. Fica em
// variavel porque o endpoint interno pode mudar sem aviso.
// Testa a pagina do proprio linkbuilder: exige sessao valida e nao gera link
// nenhum. Cookie caido redireciona para login, o que muda o status.
const ML_AFF_URL_TESTE = process.env.ML_AFF_URL_TESTE
  || 'https://www.mercadolivre.com.br/afiliados/linkbuilder';

// Aviso no grupo do operador — o token parar em silencio custaria um dia
// inteiro de ofertas do ML sem ninguem perceber.
async function avisarTokenMlCaiu(motivo) {
  const texto = '⚠️ *Token do Mercado Livre parou de funcionar*\n\n'
    + 'Motivo: ' + motivo + '\n\n'
    + 'O radar do ML está parado até a renovação. Para resolver:\n'
    + '1. Abra o Chrome logado na conta de colaborador do ML\n'
    + '2. Clique na extensão e copie o token\n'
    + '3. Atualize ML_AFF_TOKEN no Railway\n\n'
    + 'Amazon, Shopee e Magalu seguem normalmente.';
  try {
    await enviarMensagem(GRUPOS['operador'], { text: texto });
    console.error('[ML-AFF] Operador avisado: token caiu (' + motivo + ')');
  } catch (e) { console.error('[ML-AFF] Falha ao avisar operador:', e.message); }
}

// Sincroniza os cupons do ML de hora em hora. Cupom esgotado que continua ativo
// na base faz o radar anunciar preco que nao se aplica no checkout.
// Alimenta o mapa de campanhas do ML (radar-ml.js), que vive em memoria e por
// isso zera a cada redeploy. Sem esta passada o mapa fica vazio em producao e
// todo cupom sem codigo digitavel cai no caminho conservador: a oferta sai pelo
// preco cheio. Roda junto do sync de cupons — mesmo gatilho, fonte diferente.
async function sincronizarCampanhasMlAgendado() {
  if (!tokenAffOk()) return;
  try {
    const r = await sincronizarCuponsContaMl();
    console.log('[CAMPANHAS-ML] Sync agendado — ' + (r.campanhas?.total || 0) +
      ' campanha(s) no mapa, ' + (r.gravados || []).length + ' cupom(ns) na base.');
  } catch (e) { console.warn('[CAMPANHAS-ML] Sync agendado — erro:', e.message); }
}

// Throttle do aviso de canal de ativacao fora do ar (12h).
let _avisoCanalMl = 0;

async function sincronizarCuponsMlAgendado() {
  if (!tokenAffOk()) return;
  // O mapa de campanhas nao depende do resultado abaixo: roda antes e em
  // separado para que uma falha do sync antigo nao deixe o mapa vazio.
  sincronizarCampanhasMlAgendado().catch(() => {});
  try {
    const r = await fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/cupons/sync-ml', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      // O loop de verificacao tem espera entre chamadas: ate 40 cupons x 800ms
      // mais a latencia do ML nao cabem em 2 minutos.
      signal: AbortSignal.timeout(300000),
    });
    const d = await r.json();
    if (!d.ok) { console.warn('[CUPONS-ML] Sync agendado falhou:', d.erro); return; }
    console.log('[CUPONS-ML] Sync agendado — ' + (d.atualizados || []).length + ' atualizado(s), '
      + (d.criados || []).length + ' novo(s), ' + (d.desativados || []).length + ' desativado(s)'
      + (d.leituraCompleta ? '' : ' [leitura parcial]') + '.');

    // Cupom que saiu do ar e noticia operacional: o operador pode estar contando
    // com ele para as ofertas do dia.
    if ((d.desativados || []).length) {
      await enviarMensagem(GRUPOS['operador'], {
        text: '🎫 *Cupons do Mercado Livre desativados*\n\n'
            + d.desativados.map(c => '• ' + c).join('\n')
            + '\n\nO ML recusou o código na hora de ativar — vencido ou esgotado. '
            + 'Saíram da base e não entram mais nas ofertas. Nada a fazer.'
      }).catch(() => {});
    }

    // Cupom que o sync conseguiu adicionar sozinho na conta. Vale avisar: a
    // partir dai o ML passa a informar validade e esgotamento dele.
    if ((d.ativadosAgora || []).length) {
      await enviarMensagem(GRUPOS['operador'], {
        text: '✅ *Cupons ativados na sua conta do ML*\n\n'
            + d.ativadosAgora.map(c => '• ' + c).join('\n')
            + '\n\nEntraram automaticamente. A validade real é lida no próximo sync.'
      }).catch(() => {});
    }

    // Sobra so o que o ML respondeu de forma inesperada — os casos de verdade
    // ambiguos. Cupom vencido e cupom ja ativo na conta ja foram resolvidos
    // acima, entao esta lista tende a vir vazia.
    // Canal de ativacao mudo: o ML recusou todos os codigos, entao a lista de
    // pendentes e so ruido — seria a base inteira, de hora em hora. Um aviso a
    // cada 12h basta, porque a correcao e no cookie/payload, nao no cupom.
    if (d.canalAtivacaoOk === false && d.recusasIgnoradas) {
      if (Date.now() - _avisoCanalMl > 12 * 3600 * 1000) {
        _avisoCanalMl = Date.now();
        await enviarMensagem(GRUPOS['operador'], {
          text: '⚠️ *Ativação de cupom no ML fora do ar*\n\n'
              + 'O ML recusou os ' + d.recusasIgnoradas + ' código(s) testados nesta passada, '
              + 'inclusive os que estão ativos na conta. Nenhum cupom foi desativado.\n\n'
              + 'Cupom novo do Telegram não está entrando na sua conta até isso voltar.'
        }).catch(() => {});
      }
    } else if ((d.pendentesAtivacao || []).length) {
      await enviarMensagem(GRUPOS['operador'], {
        text: '➕ *Confira estes cupons no Mercado Livre*\n\n'
            + d.pendentesAtivacao.map(c => '• ' + c).join('\n')
            + '\n\nO ML não aceitou nem recusou o código. Tente em: '
            + 'mercadolivre.com.br/cupons → Inserir código.'
      }).catch(() => {});
    }
  } catch (e) { console.warn('[CUPONS-ML] Sync agendado — erro:', e.message); }
}
setInterval(sincronizarCuponsMlAgendado, 60 * 60 * 1000);
setTimeout(sincronizarCuponsMlAgendado, 120000);   // primeira passada apos o boot
// O mapa de campanhas e pre-requisito para aplicar cupom sem codigo, entao nao
// espera os 2 minutos do sync de cupons: sobe assim que o socket estabiliza.
setTimeout(() => sincronizarCampanhasMlAgendado().catch(() => {}), 20000);

// Verifica no boot e a cada 30 min. Frequencia alta de proposito: o custo de
// uma chamada e irrelevante perto de descobrir tarde que o radar parou.
setInterval(() => {
  if (tokenAffOk()) verificarTokenAff(ML_AFF_URL_TESTE, avisarTokenMlCaiu).catch(()=>{});
}, 30 * 60 * 1000);
setTimeout(() => {
  if (tokenAffOk()) verificarTokenAff(ML_AFF_URL_TESTE, avisarTokenMlCaiu).catch(()=>{});
}, 45000);

// ── RADAR MAGAZINE LUIZA ──────────────────────────────────────────────────────
import {
  processarTextoMagalu, ehLinkMagalu, converterLinkMagalu, lojaMagalu,
  resolverLinhaVitrineMagalu, montarOfertasMagaluVitrine, ttlPrecoMagalu,
} from './radar-magalu.js';

// ── TELEGRAM ──────────────────────────────────────────────────────────────────
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Raw, NewMessage } from 'telegram/events/index.js';
import { Api } from 'telegram';

// ── LOGGER CUSTOMIZADO (suprimir ruído do Baileys) ───────────────────────────
const baileysLogger = pino({ level: 'silent' });

// Intercepta console.log/warn para suprimir dumps de criptografia do Baileys
// que causam rate limit de 500 logs/s no Railway e derrubam o processo.
// Filtro de noise removido temporariamente para diagnóstico.

// Boot: o GitHub e a copia durável. Os modulos ja carregaram do disco no import;
// depois do download recarregam, agora com o conteudo do repositorio.
(async () => {
  try {
    const r = await baixarDoGitHub();
    if (r.baixados) {
      carregarTenants(); carregarConfigTsp();
      carregarRadarConfig(); carregarCuponsBase(); carregarTemplates(); carregarVitrine();
      recarregarRadarTenants();
      semearMonitorDasFontes();
      console.log('[SYNC] Modulos recarregados a partir do repositorio.');
    }
  } catch (e) { console.error('[SYNC] Falha no boot:', e.message); }
})();

// ── HANDLERS DE ERRO GLOBAIS ──────────────────────────────────────────────────
// Boot da Awin: catalogo do disco (instantaneo) e refresh diario em segundo
// plano. Sem credenciais o modulo fica inerte — nada mais no server muda.
carregarProgramasAwin();
// Lista de feeds: cache em disco no boot, atualizacao diaria em segundo plano.
carregarFeedListDoDisco();
if (credenciaisFeedOk()) {
  atualizarFeedList().catch(e => console.log('[AWIN-FEED] Falha ao atualizar lista:', e.message));
  setInterval(() => atualizarFeedList().catch(() => {}), 24 * 60 * 60 * 1000).unref?.();
}
if (credenciaisAwinOk()) {
  atualizarProgramasAwin().catch(e => console.log('[AWIN] Falha ao atualizar catalogo:', e.message));
  setInterval(() => atualizarProgramasAwin().catch(() => {}), 24 * 60 * 60 * 1000).unref?.();
}

process.on('uncaughtException',  (err) => console.error('[FATAL] uncaughtException:', err.message, err.stack));
process.on('unhandledRejection', (err) => console.error('[FATAL] unhandledRejection:', err?.message || err));

// ── GRUPOS DE DESTINO ─────────────────────────────────────────────────────────
// Os grupos do TSP (padrao, so-cupons e operador) vem da config editavel pelo
// painel (aba Configuracoes) — getters para toda leitura ver o valor atual.
// Os grupos do CDV seguem fixos: pertencem a outra operacao, fora deste painel.
const GRUPOS = {
  // Grupos exclusivos de cupons — recebem copia de todo cupom_tsp com rodape
  // convidando para o grupo de ofertas (convite cruzado). Nunca recebem oferta
  // de produto. Podem ser varios.
  get tsp_cupons() { return gruposTspCupons(); },
  cdv_ofertas: '120363170138704529@g.us',
  cdv_emissao: '120363172490263905@g.us',
  // Grupo interno do operador — avisos operacionais que NAO vao para clientes
  // (novo cupom capturado, falha de coleta, etc).
  get operador()   { return grupoOperadorTsp(); },
};
const GRUPOS_MONITORADOS      = [
  '120363430801699326@g.us',
  '120363409136599326@g.us',
  '120363410708080270@g.us',
  '120363229600818869@g.us',
  '120363298361885116@g.us',
  '120363301488379027@g.us',
  '120363230402728347@g.us',
  '120363229682219999@g.us',
  '120363212151306916@g.us',
  '120363211235070904@g.us',
  '120363318399199070@g.us',
  '120363230586056001@g.us',
  '120363211276624072@g.us',
  '120363416996630307@g.us',
  '120363427410900900@g.us',
  '120363423603571989@g.us',
  '120363280292009756@g.us',
];
const GRUPO_DESTINO_PASSAGENS = 'cdv_emissao';
const JANELA_AGRUPAMENTO_MS   = 3 * 60 * 1000;

const GRUPOS_FILTRO_DATAS_MIN = {
  '120363229600818869@g.us': 5, // TSM - ALERTAS BH
  '120363298361885116@g.us': 5, // TSM - ALERTAS SP #3
  '120363301488379027@g.us': 5, // TSM - ALERTAS RJ #2
  '120363230402728347@g.us': 5, // TSM - ALERTAS GOIÂNIA
  '120363229682219999@g.us': 5, // TSM - ALERTAS CURITIBA
  '120363212151306916@g.us': 5, // TSM - ALERTAS POA
  '120363211235070904@g.us': 5, // TSM - ALERTAS FLORIPA/NAVEGANTES
  '120363318399199070@g.us': 5, // TSM - (sem nome na lista)
  '120363230586056001@g.us': 5, // TSM - ALERTAS FORTALEZA
  '120363211276624072@g.us': 5, // TSM - ALERTAS SALVADOR
  '120363416996630307@g.us': 5, // TSM - ALERTAS BRASÍLIA #3
  '120363427410900900@g.us': 5, // TSM - ALERTAS RECIFE #2
  '120363423603571989@g.us': 5, // TSM - ALERTAS UBERLÂNDIA
  '120363280292009756@g.us': 5, // TSM - ALERTAS CAMPO GRANDE
};

const PORT          = process.env.PORT || 3001;
// Funcao, nao const: a chave pode ser gravada pelo painel depois do boot e
// precisa valer na proxima chamada, sem restart.
function anthropicKey() { return process.env.ANTHROPIC_API_KEY; }
const SESSAO_DIR    = './sessao';
const UPLOAD_DIR    = './tmp-uploads';

[SESSAO_DIR, UPLOAD_DIR].forEach(d => { if (!existsSync(d)) mkdirSync(d, { recursive: true }); });

// ── AUTH STATE ATÔMICO ────────────────────────────────────────────────────────
// Substitui o useMultiFileAuthState do Baileys mantendo o MESMO formato de
// arquivos (100% compatível com a sessão existente em ./sessao), mas com duas
// proteções que ele não tem:
//   1. Escrita atômica: grava em arquivo .tmp e faz rename() — um restart do
//      Railway no meio de um write nunca mais deixa JSON truncado (causa raiz
//      clássica de "Bad MAC" / "Failed to decrypt").
//   2. Escritas serializadas: uma cadeia única de Promise evita dois writes
//      concorrentes no mesmo arquivo de chave.
async function useAuthStateAtomico(pasta) {
  await mkdirAsync(pasta, { recursive: true });
  const fixFileName = (file) => file?.replace(/\//g, '__')?.replace(/:/g, '-');
  let cadeiaEscrita = Promise.resolve();

  const writeData = (data, file) => {
    const destino = join(pasta, fixFileName(file));
    const tmp = destino + '.tmp';
    cadeiaEscrita = cadeiaEscrita
      .then(async () => {
        await writeFileAsync(tmp, JSON.stringify(data, BufferJSON.replacer));
        await renameAsync(tmp, destino);
      })
      .catch(e => console.error('[AUTH] Erro ao gravar', file, '-', e.message));
    return cadeiaEscrita;
  };

  const readData = async (file) => {
    try {
      const raw = await readFileAsync(join(pasta, fixFileName(file)), 'utf-8');
      return JSON.parse(raw, BufferJSON.reviver);
    } catch { return null; }
  };

  const removeData = async (file) => {
    try { await unlink(join(pasta, fixFileName(file))); } catch {}
  };

  const creds = (await readData('creds.json')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async (id) => {
            let value = await readData(type + '-' + id + '.json');
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }));
          return data;
        },
        set: async (data) => {
          const tarefas = [];
          for (const categoria in data) {
            for (const id in data[categoria]) {
              const value = data[categoria][id];
              const file = categoria + '-' + id + '.json';
              tarefas.push(value ? writeData(value, file) : removeData(file));
            }
          }
          await Promise.all(tarefas);
        },
      },
    },
    saveCreds: () => writeData(creds, 'creds.json'),
  };
}

const app    = express();
const upload = multer({ dest: UPLOAD_DIR });
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Resolucao de operador por requisicao (fase 2.1). Hoje tudo resolve para o
// tenant padrao — comportamento identico ao anterior. Nas proximas fases a
// origem passa a ser o token de sessao do login, e os modulos de dados leem
// req.tenantId em vez de estado global.
app.use((req, res, next) => {
  // Fase 2.5: token do login por e-mail decide o operador. Sem token = raiz
  // (superficie publica historica). Token invalido/expirado = 401 — jamais
  // cair na raiz, para sessao vencida nao operar dados de outro.
  const tk = tokenDaReq(req);
  if (tk === false) {
    return res.status(401).json({ ok:false, erro:'Sessao invalida ou expirada — faca login novamente.' });
  }
  const t = tk ? tenantPorEmail(tk.email) : tenantPorId(TENANT_PADRAO);
  if (!t) return res.status(403).json({ ok:false, erro:'E-mail sem operador ativo no registro.' });
  req.tenantId = t.id;
  req.autenticado = !!tk;
  // Contexto assincrono: tudo que a requisicao tocar (mesmo apos awaits)
  // enxerga o estado DESTE operador nos modulos de dados.
  comContextoTenant(req.tenantId, next);
});

let sock         = null;
let conectado    = false;
let qrAtual      = null;

// ── GERENCIADOR DE CONEXÃO ────────────────────────────────────────────────────
// Flag que indica se já existe um processo de conexão ativo.
// Evita instâncias duplas de sock sem complexidade de Promises aninhadas.
let _conexaoPromise = null; // apenas para expor no /status

// Aguarda sock disponível com polling leve.
// Dispara conectar() uma única vez se não estiver conectando.
async function aguardarSock(ms = 20000) {
  if (conectado && sock) return true;
  console.log('[WA] aguardarSock: aguardando conexão...');
  if (!isConnecting && !sock) conectar();
  const inicio = Date.now();
  while ((!conectado || !sock) && Date.now() - inicio < ms) {
    await new Promise(r => setTimeout(r, 500));
  }
  return conectado && !!sock;
}

// Alias mantido para compatibilidade com /qr route
function iniciarConexao() {
  if (!isConnecting && !sock) conectar();
}
const FILA_PATH = SESSAO_DIR + '/fila_pendentes.json';

// ── DEDUPLICAÇÃO DE CUPONS TSP ────────────────────────────────────────────────
// Ignora cupons já vistos (mesma loja + código) nas últimas N horas.
// Persiste em disco para sobreviver a restarts.
const CUPONS_VISTOS_PATH = SESSAO_DIR + '/cupons_vistos.json';
// TTL de 24h: cupons costumam durar mais que 6h e, com auto-envio ligado, um
// repost do mesmo cupom 7h depois viraria mensagem duplicada para os clientes.
const CUPONS_VISTOS_TTL_MS = 24 * 60 * 60 * 1000; // 24 horas

let _cuponsVistos = {};

function carregarCuponsVistos() {
  try {
    if (existsSync(CUPONS_VISTOS_PATH)) {
      _cuponsVistos = JSON.parse(readFileSync(CUPONS_VISTOS_PATH, 'utf-8'));
      console.log('[DEDUP] Cupons vistos carregados:', Object.keys(_cuponsVistos).length);
    }
  } catch(e) { console.warn('[DEDUP] Erro ao carregar cupons_vistos:', e.message); _cuponsVistos = {}; }
}

function salvarCuponsVistos() {
  try {
    // Limpa entradas expiradas antes de salvar
    const agora = Date.now();
    for (const k of Object.keys(_cuponsVistos)) {
      if (agora - _cuponsVistos[k] > CUPONS_VISTOS_TTL_MS) delete _cuponsVistos[k];
    }
    writeFileSync(CUPONS_VISTOS_PATH, JSON.stringify(_cuponsVistos), 'utf-8');
  } catch(e) { console.warn('[DEDUP] Erro ao salvar cupons_vistos:', e.message); }
}

// Normaliza forte para que "Outro: Casas Bahia", "outro: casasbahia" e
// "Casas Bahia" gerem a MESMA chave. Sem isso, os dois canais monitorados
// escrevendo a loja de formas diferentes furam a deduplicacao.
function normalizarDedup(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // remove acentos
    .replace(/^outro:\s*/, '')
    .replace(/[^a-z0-9]/g, '');
}

function chaveDedup(cupom) {
  const lojaKey = normalizarDedup(cupom?.loja) || 'outros';
  const codKey  = normalizarDedup(cupom?.codigo);
  // Com codigo: loja+codigo identifica o cupom sem ambiguidade.
  // Sem codigo (caso Shopee): usar so "__sem_codigo__" faria QUALQUER cupom sem
  // codigo da mesma loja dedupar contra outro na janela, suprimindo cupons
  // legitimamente diferentes. Entao a chave incorpora tipo+valor+minimo.
  if (codKey) return `${lojaKey}:${codKey}`;
  const tipo   = normalizarDedup(cupom?.tipo) || 'x';
  const valor  = Number(cupom?.valor)  || 0;
  const minimo = Number(cupom?.minimo) || 0;
  return `${lojaKey}:sc:${tipo}:${valor}:${minimo}`;
}

function cupomJaVisto(cupom) {
  const chave = chaveDedup(cupom);
  const ts = _cuponsVistos[chave];
  if (!ts) return false;
  if (Date.now() - ts > CUPONS_VISTOS_TTL_MS) {
    delete _cuponsVistos[chave];
    return false;
  }
  return true;
}

function registrarCupomVisto(cupom) {
  const chave = chaveDedup(cupom);
  _cuponsVistos[chave] = Date.now();
  salvarCuponsVistos();
}

carregarCuponsVistos();

function carregarFila() {
  try {
    if (existsSync(FILA_PATH)) {
      const dados = JSON.parse(readFileSync(FILA_PATH, 'utf-8'));
      filaPendentes.push(...dados);
      console.log('[FILA] Carregadas ' + dados.length + ' ofertas do disco.');
    }
  } catch(e) { console.log('[FILA] Erro ao carregar fila:', e.message); }
}

// Tipos que o painel Gestao TSP trata como oferta de marketplace. Amazon hoje;
// ML e Shopee entram aqui sem mudar mais nada no roteamento.
const TIPOS_OFERTA_MARKETPLACE = new Set(['oferta_amazon', 'oferta_ml', 'oferta_shopee', 'oferta_magalu']);

function limparFila() {
  const agora = Date.now();
  const LIMITE_PENDENTE = 18 * 60 * 60 * 1000; // pendentes somem 18h após a captura
  const LIMITE_CUPOM_TSP = 12 * 60 * 60 * 1000; // cupons expiram rápido
  const LIMITE_PROCESSADAS_MS = 24 * 60 * 60 * 1000;
  const LIMITE_PROCESSADAS = 20;

  // 1. Remove ofertas expiradas, sempre contando a partir de item.timestamp
  //    (momento em que a captura foi registrada na fila):
  //    - pendente: 18h — se não foi aprovada nesse prazo, sai sozinha
  //    - pendente do tipo cupom_tsp: 12h, pois perde validade antes
  //    - já processada (aprovado/agendado/enviado/rejeitado): 24h, só histórico
  for (let i = filaPendentes.length - 1; i >= 0; i--) {
    const item = filaPendentes[i];
    const ts = new Date(item.timestamp).getTime();
    if (!ts || isNaN(ts)) continue;

    let limite;
    if (item.status !== 'pendente') limite = LIMITE_PROCESSADAS_MS;
    else if (item.tipoConteudo === 'cupom_tsp') limite = LIMITE_CUPOM_TSP;
    // Oferta de produto envelhece igual cupom: preco muda e estoque acaba.
    else if (TIPOS_OFERTA_MARKETPLACE.has(item.tipoConteudo)) limite = LIMITE_CUPOM_TSP;
    else limite = LIMITE_PENDENTE;

    if (agora - ts > limite) filaPendentes.splice(i, 1);
  }

  // 2. Garante no máximo 20 aprovadas/rejeitadas (remove as mais antigas)
  const processadas = filaPendentes
    .map((o, i) => ({ o, i }))
    .filter(({ o }) => o.status !== 'pendente')
    .sort((a, b) => new Date(a.o.timestamp) - new Date(b.o.timestamp));
  const excesso = processadas.length - LIMITE_PROCESSADAS;
  if (excesso > 0) {
    const idxRemover = new Set(processadas.slice(0, excesso).map(({ i }) => i));
    for (let i = filaPendentes.length - 1; i >= 0; i--) {
      if (idxRemover.has(i)) filaPendentes.splice(i, 1);
    }
  }
}

function salvarFila() {
  try {
    limparFila();
    writeFileSync(FILA_PATH, JSON.stringify(filaPendentes), 'utf-8');
  } catch(e) { console.log('[FILA] Erro ao salvar fila:', e.message); }
}

const filaPendentes = [];
carregarFila();
let contadorId = filaPendentes.length > 0
  ? filaPendentes.reduce((max, o) => Math.max(max, parseInt(o.id)||0), 0) + 1
  : 1;
console.log('[FILA] Contador de IDs iniciado em: ' + contadorId);

// ── Reaplica links de afiliado em cupons TSP já pendentes ────────────────────
// Quando o formatador passa a conhecer um link novo (ex.: Magazine Luiza), os
// cupons que já estavam na fila continuariam sem o bloco de resgate. Esta
// varredura regenera a mensagem a partir de dadosExtraidos, mas SOMENTE quando
// a mensagem atual está sem link — nunca sobrescreve algo que já tem link nem
// edições manuais feitas no painel.
function reformatarCupomsTSPPendentes() {
  let n = 0;
  for (const o of filaPendentes) {
    if (o.tipoConteudo !== 'cupom_tsp' || o.status !== 'pendente') continue;
    if (!o.dadosExtraidos) continue;
    if ((o.mensagemFormatada || '').includes('RESGATE O CUPOM AQUI')) continue;
    const nova = formatarCupomTSP(o.dadosExtraidos);
    if (!nova.includes('RESGATE O CUPOM AQUI')) continue; // loja sem link cadastrado
    o.mensagemFormatada = nova;
    n++;
  }
  if (n > 0) {
    salvarFila();
    console.log('[FILA] ' + n + ' cupom(ns) TSP pendente(s) reformatado(s) com link de afiliado.');
  }
  return n;
}
// A chamada de boot fica LOGO APÓS a definição de LINKS_TSP/formatarCupomTSP:
// a função é hoisted, mas LINKS_TSP é `const` e estaria em TDZ aqui.

// Varredura periódica (15 min): garante que a expiração de 18h aconteça mesmo
// sem ninguém abrir o painel ou aprovar/rejeitar nada.
setInterval(() => {
  const antes = filaPendentes.length;
  salvarFila();
  const removidos = antes - filaPendentes.length;
  if (removidos > 0) console.log('[FILA] Varredura automática removeu ' + removidos + ' item(ns) expirado(s).');
}, 15 * 60 * 1000);

// Recolocar na fila de envio ofertas que foram aprovadas mas não enviadas (survives restart)
function requeueAprovadas() {
  const aprovadas = filaPendentes.filter(o => o.status === 'aprovado' && o.mensagemFinal);
  if (aprovadas.length === 0) return;
  console.log('[FILA] Reenfileirando ' + aprovadas.length + ' oferta(s) aprovada(s) após restart...');
  for (const o of aprovadas) {
    filaEnvio.push({ ofertaId: o.id, mensagem: o.mensagemFinal, destino: GRUPOS[GRUPO_DESTINO_PASSAGENS] });
    console.log('[FILA] Reenfileirada oferta #' + o.id);
  }
  workerFila().catch(e => { console.error('[FILA] Worker erro:', e.message); workerRodando = false; });
}
const bufferAgrupamento = new Map();

// ── FILA DE ENVIO CDV (intervalo de 5 min, janela 08h–21h, fuso SP) ──────────
const INTERVALO_ENVIO_MS = 10 * 60 * 1000;
const HORA_INICIO_ENVIO  = 8;
const HORA_FIM_ENVIO     = 21;
const TZ_SP              = 'America/Sao_Paulo';

const filaEnvio = [];
let workerRodando = false;

function horaSP() {
  return parseInt(new Intl.DateTimeFormat('pt-BR', { timeZone: TZ_SP, hour: 'numeric', hour12: false }).format(new Date()), 10);
}

// Irma de horaSP(): o minuto cheio no fuso de SP. Usada pelo censo, que dispara
// num minuto especifico (00:10) e nao numa hora inteira.
function minutoSP() {
  return parseInt(new Intl.DateTimeFormat('pt-BR', { timeZone: TZ_SP, minute: 'numeric', hour12: false }).format(new Date()), 10);
}

function msAteJanela() {
  const hora = horaSP();
  if (hora >= HORA_INICIO_ENVIO && hora < HORA_FIM_ENVIO) return 0;
  const agora = Date.now();
  const partes = new Intl.DateTimeFormat('pt-BR', {
    timeZone: TZ_SP, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(new Date(agora));
  const get = t => parseInt(partes.find(p => p.type === t).value, 10);
  const h = get('hour'), m = get('minute'), s = get('second');
  const segundosPassados = h * 3600 + m * 60 + s;
  const segundosAte08   = HORA_INICIO_ENVIO * 3600;
  let diffMs;
  if (h < HORA_INICIO_ENVIO) {
    diffMs = (segundosAte08 - segundosPassados) * 1000;
  } else {
    diffMs = (86400 - segundosPassados + segundosAte08) * 1000;
  }
  return Math.max(0, diffMs);
}

function calcularPosicaoFila(posicaoNaFila) {
  const agora   = Date.now();
  let tempoMs   = agora + msAteJanela();
  for (let i = 0; i < posicaoNaFila; i++) {
    tempoMs += INTERVALO_ENVIO_MS;
    const h = parseInt(new Intl.DateTimeFormat('pt-BR', { timeZone: TZ_SP, hour: 'numeric', hour12: false }).format(new Date(tempoMs)), 10);
    if (h >= HORA_FIM_ENVIO || h < HORA_INICIO_ENVIO) {
      tempoMs += (24 + HORA_INICIO_ENVIO - h) * 3600000;
    }
  }
  const tempoMin = Math.round((tempoMs - agora) / 60000);
  const horario  = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ_SP, hour: '2-digit', minute: '2-digit' }).format(new Date(tempoMs));
  return { posicao: posicaoNaFila, tempoMin, horario };
}

async function aguardarConectado(timeoutMs = 180000) {
  // Dispara conexão sob demanda se worker precisar enviar
  if (!conectado || !sock) {
    console.log("[WORKER] Desconectado. Conectando sob demanda para envio...");
    conectar();
  }
  const inicio = Date.now();
  while (!conectado || !sock) {
    if (Date.now() - inicio > timeoutMs) throw new Error("Timeout aguardando conexão WhatsApp");
    await new Promise(r => setTimeout(r, 2000));
  }
  resetarInactivityTimer();
}

// Envia mensagem com retry automático (1 tentativa extra) caso a conexão caia no momento do envio.
// Isso resolve o erro que você vê na página TSP na primeira tentativa de envio.
// ── CONTAS SECUNDARIAS DE ENVIO ──────────────────────────────────────────────
// A conta principal continua sendo o unico socket que LE mensagens: as duas
// contas estao nos mesmos grupos-fonte, e deixar as duas processarem
// 'messages.upsert' dobraria o pipeline inteiro (inclusive as chamadas de IA)
// para publicar exatamente a mesma coisa. As secundarias so enviam.
//
// Cada conta tem pasta de credenciais propria e cache de mensagens enviadas
// proprio: o getMessage responde retry receipt: buscar a mensagem da conta A no
// cache da B deixaria o destinatario preso em "aguardando mensagem".
const CONTAS_DIR = SESSAO_DIR + '/contas';

const contasExtras = new Map();

// ── CONTAS POR OPERADOR (fase 2.4a) ──────────────────────────────────────────
// A conta WhatsApp de um operador e uma conta secundaria com id interno
// 't-<tenant>-<apelido>'. Os endpoints traduzem o apelido pelo tenant da
// requisicao — o operador so enxerga o proprio apelido, e nao consegue
// enderecar conta de outro. A operacao padrao segue sem prefixo: ids, pastas
// de credenciais e escala historicos ficam intactos.
const RE_CONTA_TENANT = /^t-([a-z0-9][a-z0-9-]{1,30})-([a-z0-9_-]{2,24})$/i;
function contaIdDe(tenantId, apelido) {
  return (!tenantId || tenantId === TENANT_PADRAO) ? apelido : 't-' + tenantId + '-' + apelido;
}
function tenantDaConta(id) {
  const m = RE_CONTA_TENANT.exec(String(id || ''));
  return m ? m[1].toLowerCase() : TENANT_PADRAO;
}
function apelidoDaConta(id) {
  const m = RE_CONTA_TENANT.exec(String(id || ''));
  return m ? m[2] : String(id || '');
}
function contaIdReq(req) { return contaIdDe(req.tenantId, String(req.params.id || '').trim()); }
// Primeira conta conectada de um operador — o "numero dele" para envio.
function contaConectadaDoTenant(tenantId) {
  for (const c of contasExtras.values()) {
    if (tenantDaConta(c.id) === tenantId && c.conectado && c.sock) return c.id;
  }
  return null;
}

function estadoConta(id) {
  if (!contasExtras.has(id)) {
    contasExtras.set(id, {
      id, sock: null, conectado: false, qr: null, conectando: false,
      tentativas: 0, timer: null, enviadas: new Map(),
      ultimoEnvio: null, ultimoErro: null,
    });
  }
  return contasExtras.get(id);
}

function contaDisponivel(id) {
  const c = contasExtras.get(id);
  return !!(c && c.conectado && c.sock);
}

async function conectarConta(id) {
  const c = estadoConta(id);
  if (c.removida) return c;
  if (c.conectando || (c.conectado && c.sock)) return c;
  c.conectando = true;
  try {
    const dir = CONTAS_DIR + '/' + id;
    await mkdirAsync(dir, { recursive: true });
    const { state, saveCreds } = await useAuthStateAtomico(dir);
    const { version } = await fetchLatestBaileysVersion();
    const s = makeWASocket({
      version,
      auth: state,
      logger: baileysLogger,
      printQRInTerminal: false,
      syncFullHistory: false,
      // Este numero e usado por outra ferramenta ao mesmo tempo. Marcar online
      // aqui roubaria a presenca dele e mudaria o comportamento de notificacao
      // no celular do operador — nao vale, ja que esta conta so envia.
      markOnlineOnConnect: false,
      getMessage: async (key) => c.enviadas.get(key?.id),
      shouldIgnoreJid: (jid) => jid === 'status@broadcast' || (typeof jid === 'string' && jid.endsWith('@newsletter')),
      keepAliveIntervalMs: 30000,
    });
    c.sock = s;
    s.ev.on('creds.update', saveCreds);
    s.ev.on('connection.update', async (u) => {
      if (u.qr) c.qr = await QRCode.toDataURL(u.qr);
      if (u.connection === 'open') {
        c.conectado = true; c.qr = null; c.conectando = false; c.tentativas = 0;
        console.log('[CONTA:' + id + '] ✓ conectada.');
      }
      if (u.connection === 'close') {
        if (s !== c.sock && c.sock !== null) return;   // evento de socket antigo
        c.conectado = false; c.conectando = false; c.sock = null;
        const codigo = new Boom(u.lastDisconnect?.error)?.output?.statusCode;
        console.log('[CONTA:' + id + '] conexao fechada. Codigo: ' + codigo);
        if (codigo === DisconnectReason.loggedOut) {
          c.ultimoErro = 'deslogada — escaneie o QR de novo';
          return;   // logout nao reconecta sozinho
        }
        // Backoff ate 5 min: a conta secundaria nao e critica, entao insistir
        // rapido so gastaria tentativa de conexao com os servidores do WhatsApp.
        if (c.removida) return;
        c.tentativas++;
        const espera = Math.min(5 * 60000, 5000 * Math.pow(2, Math.min(c.tentativas, 6)));
        clearTimeout(c.timer);
        c.timer = setTimeout(() => conectarConta(id).catch(()=>{}), espera);
      }
    });
    // De proposito sem handler de 'messages.upsert': quem le e a conta principal.
  } catch (e) {
    c.conectando = false;
    c.ultimoErro = e.message;
    console.error('[CONTA:' + id + '] falha ao conectar:', e.message);
  }
  return c;
}

async function enviarPelaConta(id, destino, conteudo) {
  const c = contasExtras.get(id);
  if (!c?.conectado || !c.sock) throw new Error('conta ' + id + ' nao conectada');
  const r = await c.sock.sendMessage(destino, conteudo);
  try {
    if (r?.key?.id && r?.message) {
      c.enviadas.set(r.key.id, r.message);
      if (c.enviadas.size > 300) c.enviadas.delete(c.enviadas.keys().next().value);
    }
  } catch (e) {}
  c.ultimoEnvio = new Date().toISOString();
  return r;
}

async function enviarMensagem(destino, conteudo, tentativa = 0, opcoes = {}) {
  // ── Operador nao-padrao (fase 2.4a): envio SO pela conta DELE. O fallback
  // para a principal (logo abaixo) vale apenas dentro da operacao padrao —
  // cair nela aqui mandaria conteudo de um operador pelo numero de outro, a
  // pior falha possivel do modelo hospedado. Sem conta conectada: falha alto.
  const tidEnvio = tenantContexto() || TENANT_PADRAO;
  if (tidEnvio !== TENANT_PADRAO) {
    const pedida = (opcoes.conta && opcoes.conta !== 'principal')
      ? contaIdDe(tidEnvio, apelidoDaConta(opcoes.conta)) : null;
    const alvo = (pedida && contaDisponivel(pedida)) ? pedida : contaConectadaDoTenant(tidEnvio);
    if (!alvo) {
      throw new Error('WhatsApp do operador "' + tidEnvio + '" nao esta conectado — pareie uma conta na aba Conexao.');
    }
    return enviarPelaConta(alvo, destino, conteudo);
  }

  // Conta escolhida pela escala de turnos. Falha ou indisponibilidade cai na
  // principal em vez de abortar: a mensagem sair pelo numero "errado" e menos
  // grave do que nao sair.
  const contaId = opcoes.conta;
  if (contaId && contaId !== 'principal' && tentativa === 0) {
    if (contaDisponivel(contaId)) {
      try { return await enviarPelaConta(contaId, destino, conteudo); }
      catch (e) {
        console.warn('[WA] Envio pela conta ' + contaId + ' falhou (' + e.message + ') — indo pela principal.');
        const c = contasExtras.get(contaId); if (c) c.ultimoErro = e.message;
      }
    } else {
      console.warn('[WA] Conta ' + contaId + ' indisponivel — enviando pela principal.');
    }
  }

  if (!conectado || !sock) {
    const ok = await aguardarSock(20000);
    if (!ok) throw new Error('WhatsApp não conectado após aguardar reconexão.');
  }
  try {
    const resultado = await sock.sendMessage(destino, conteudo);
    guardarMensagemEnviada(resultado);
    return resultado;
  } catch (err) {
    const retryable = err.message?.includes('Connection Closed') ||
                      err.message?.includes('Connection Terminated') ||
                      err.message?.includes('timed out') ||
                      err.message?.includes('Bad MAC') ||
                      err.output?.statusCode === 428;
    if (retryable && tentativa < 2) {
      console.warn('[WA] Falha ao enviar (tentativa ' + (tentativa+1) + '):', err.message, '— aguardando reconexão...');
      await new Promise(r => setTimeout(r, 2000));
      const ok = await aguardarSock(20000);
      if (!ok) throw new Error('WhatsApp não reconectou a tempo para reenvio.');
      return enviarMensagem(destino, conteudo, tentativa + 1, opcoes);
    }
    throw err;
  }
}

// ── JID CANONICO ─────────────────────────────────────────────────────────────
// O JID nao pode ser montado somando '@s.whatsapp.net' ao telefone. Contas
// antigas (tipico em DDD >= 31) estao registradas SEM o nono digito, e contas
// migradas podem responder por outro identificador. Enviar para o JID montado
// na mao cria uma CONVERSA FANTASMA: o WhatsApp Web abre uma thread separada,
// sem contato vinculado, a mensagem trava em "Aguardando mensagem" com um
// unico check e nunca chega ao aparelho do destinatario. onWhatsApp() devolve
// o JID que o servidor de fato reconhece — e so ele vale para sendMessage.
async function resolverJidWhatsApp(telefone, fallback) {
  const digitos = String(telefone || '').replace(/\D/g, '');
  const reserva = fallback || (digitos ? digitos + '@s.whatsapp.net' : null);
  if (!digitos) return { jid: reserva, existe: false };
  if (!conectado || !sock) {
    const ok = await aguardarSock(20000);
    if (!ok) throw new Error('WhatsApp nao conectado para resolver o JID.');
  }
  let r;
  try { r = await sock.onWhatsApp(digitos); }
  catch (e) { throw new Error('onWhatsApp falhou: ' + e.message); }
  const achado = Array.isArray(r) ? r.find(x => x && x.exists && x.jid) : null;
  if (achado) return { jid: achado.jid, existe: true };
  return { jid: reserva, existe: false };
}

// Timestamp do último envio — persiste entre execuções do worker
let ultimoEnvioMs = 0;

// ── PONTO UNICO DE SAIDA ─────────────────────────────────────────────────────
// A fila de ofertas e o worker de campanha disputam o mesmo socket. Sem isto,
// uma oferta aprovada no meio de um disparo de campanha sai colada na mensagem
// anterior — duas mensagens no mesmo segundo pelo mesmo numero. Toda saida passa
// por esta cadeia de promessas: nunca ha dois sendMessage simultaneos.
let _cadeiaSaida = Promise.resolve();
function saidaSerializada(fn) {
  const proxima = _cadeiaSaida.then(fn, fn);
  // O catch mantem a cadeia viva depois de um erro; quem chamou recebe a rejeicao.
  _cadeiaSaida = proxima.catch(() => {});
  return proxima;
}

async function workerFila() {
  if (workerRodando) return;
  workerRodando = true;
  console.log('[FILA] Worker iniciado.');
  while (filaEnvio.length > 0) {
    // 1. Aguardar janela de horário (8h–21h SP)
    const espera = msAteJanela();
    if (espera > 0) {
      console.log('[FILA] Fora da janela (hora SP:' + horaSP() + '). Aguardando ' + Math.round(espera / 60000) + ' min...');
      await new Promise(r => setTimeout(r, espera));
    }

    // 2. Respeitar intervalo desde o último envio (mesmo que worker tenha encerrado antes)
    const msDesdoUltimo = Date.now() - ultimoEnvioMs;
    if (ultimoEnvioMs > 0 && msDesdoUltimo < INTERVALO_ENVIO_MS) {
      const aguardar = INTERVALO_ENVIO_MS - msDesdoUltimo;
      console.log('[FILA] Intervalo entre envios: aguardando ' + Math.round(aguardar / 60000) + ' min (último envio há ' + Math.round(msDesdoUltimo / 60000) + ' min).');
      await new Promise(r => setTimeout(r, aguardar));
    }

    // 3. Verificar conexão
    try {
      await aguardarConectado();
    } catch(e) {
      console.error('[FILA] ' + e.message + '. Recolocando item na fila e aguardando 60s.');
      await new Promise(r => setTimeout(r, 60000));
      continue;
    }

    const item = filaEnvio[0];
    if (!item) break;
    try {
      console.log('[FILA] Enviando oferta #' + item.ofertaId + ' para ' + item.destino + ' (' + filaEnvio.length + ' na fila)');
      await saidaSerializada(() => enviarMensagem(item.destino, { text: item.mensagem }));
      filaEnvio.shift();
      ultimoEnvioMs = Date.now(); // registra timestamp do envio

      // Marca como 'enviado' na filaPendentes para não reentrar na fila após restart
      const ofertaEnviada = filaPendentes.find(o => String(o.id) === String(item.ofertaId));
      if (ofertaEnviada) {
        ofertaEnviada.status = 'enviado';
        ofertaEnviada.enviadoEm = new Date().toISOString();
        salvarFila();
      }

      // ÚNICO ponto de gravação definitiva em passagens.json (fonte 'alerta').
      // Antes da aprovação o pré-registro roda com apenasConsulta:true, então
      // só emissões efetivamente enviadas entram no histórico divulgado.
      // Fallback em item.dados cobre agendamentos cuja oferta já saiu da fila.
      const de = ofertaEnviada?.dadosExtraidos || item.dados || {};
      if (de.origem && de.destino && de.programa && ofertaEnviada?.tipoConteudo !== 'cupom_tsp') {
        registrarPassagemProxy({
          origem:      de.origem,
          destino:     de.destino,
          cia:         de.cia || '',
          programa:    de.programa,
          pontos:      Number(de.pontos) || 0,
          cabine:      de.cabine || 'Economica',
          datas_ida:   de.datasIda || '',
          datas_volta: de.datasVolta || '',
          fonte:       'alerta',
        }).catch(() => {});
      }

      console.log('[FILA] ✓ Oferta #' + item.ofertaId + ' enviada.');
    } catch(e) {
      console.error('[FILA] ✗ Erro ao enviar oferta #' + item.ofertaId + ':', e.message);
      await new Promise(r => setTimeout(r, 10000));
      continue;
    }
  }
  workerRodando = false;
  console.log('[FILA] Worker encerrado (fila vazia).');
}

function enfileirarEnvio(ofertaId, mensagem, grupoAlvo, dados) {
  const destino = grupoAlvo || GRUPOS[GRUPO_DESTINO_PASSAGENS];
  const posicao = filaEnvio.length;
  // dados: snapshot de dadosExtraidos usado como fallback no registro de passagem
  // quando a oferta já saiu de filaPendentes (agendamentos de mais de 24h).
  filaEnvio.push({ ofertaId, mensagem, destino, dados: dados || null });
  console.log('[FILA] Oferta #' + ofertaId + ' enfileirada na posição ' + (posicao + 1));
  workerFila().catch(e => {
    console.error('[FILA] Worker encerrou com erro:', e.message);
    workerRodando = false;
  });
}

requeueAprovadas();

// ── AGENDAMENTOS ──────────────────────────────────────────────────────────────
const AGEND_PATH = SESSAO_DIR + '/agendamentos.json';
// Teto do anexo agendado (bytes do arquivo, nao da string base64).
const AGEND_ANEXO_MAX_BYTES = 3 * 1024 * 1024;
let agendamentos = [];

function carregarAgendamentos() {
  try {
    if (existsSync(AGEND_PATH)) {
      agendamentos = JSON.parse(readFileSync(AGEND_PATH, 'utf-8'));
      console.log('[AGEND] Carregados ' + agendamentos.length + ' agendamentos.');
    }
  } catch(e) { console.log('[AGEND] Erro ao carregar:', e.message); }
}

function salvarAgendamentos() {
  try { writeFileSync(AGEND_PATH, JSON.stringify(agendamentos), 'utf-8'); } catch(e) {}
}

carregarAgendamentos();

// Envio de um agendamento simples. Existe separado do setInterval porque montar
// o link preview e assincrono (baixa a thumbnail) e o loop nao pode esperar.
// Falha ao montar o card nao cancela o envio: a mensagem sai sem preview.
async function despacharAgendamento(ag, grupoId) {
  // Anexo agendado: os bytes viajam dentro do proprio agendamento (o painel
  // manda em base64), entao o disparo nao depende de nenhum arquivo em disco
  // nem de baixar nada na hora. Imagem vai com legenda; qualquer outro mime
  // vai como documento, mesma regra do envio imediato.
  if (ag.anexo && ag.anexo.base64) {
    const buffer = Buffer.from(String(ag.anexo.base64).replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (!buffer.length) throw new Error('Anexo do agendamento vazio ou base64 invalido.');
    const mt = String(ag.anexo.mimetype || '');
    if (!mt || mt.indexOf('image/') === 0) {
      const conteudo = { image: buffer, caption: ag.mensagem || '' };
      if (mt) conteudo.mimetype = mt;
      return enviarMensagem(grupoId, conteudo);
    }
    const conteudo = { document: buffer, mimetype: mt, fileName: ag.anexo.nomeArquivo || 'arquivo' };
    if (ag.mensagem && ag.mensagem.trim()) conteudo.caption = ag.mensagem;
    return enviarMensagem(grupoId, conteudo);
  }

  let lp = null;
  if (ag.preview?.link) {
    try { lp = await montarLinkPreviewManual(ag.preview); }
    catch (e) { console.warn('[AGEND] Nao montou o preview de #' + ag.id + ':', e.message); }
  }
  return enviarMensagem(grupoId, lp ? { text: ag.mensagem, linkPreview: lp } : { text: ag.mensagem });
}

// Versao multi-grupo do despacho agendado. Anexo so vale se for imagem: enviar
// um PDF de 3 MB em doze grupos nao e caso de uso do painel, entao um anexo
// nao-imagem e ignorado e a mensagem sai como texto.
async function despacharAgendamentoMulti(ag) {
  let imagem = null;
  const mt = String(ag.anexo?.mimetype || '');
  if (ag.anexo?.base64 && (!mt || mt.indexOf('image/') === 0)) {
    imagem = {
      imagemBase64: String(ag.anexo.base64).replace(/^data:[^;]+;base64,/, ''),
      mime: mt || 'image/jpeg',
    };
  }
  return enviarManualParaGrupos({
    mensagem: ag.mensagem,
    tipo:     ag.tipo || null,
    imagem,
    preview:  ag.preview || null,
  });
}

setInterval(() => {
  const agora = Date.now();
  const prontos = agendamentos.filter(a => a.status === 'aguardando' && a.dispararEm <= agora);
  for (const ag of prontos) {
    ag.status = 'despachado';
    salvarAgendamentos();
    // Agendamento multi-grupo: a lista de destinos e lida AGORA, na hora do
    // disparo, e nao na hora do agendamento — se o operador mexeu na aba Grupos
    // no meio do caminho, vale a configuracao atual.
    if (ehGrupoMulti(ag.grupo)) {
      despacharAgendamentoMulti(ag)
        .then(() => { ag.status = 'enviado'; delete ag.anexo; salvarAgendamentos(); })
        .catch(e  => { ag.status = 'erro';   delete ag.anexo; salvarAgendamentos(); console.error('[AGEND] Erro envio multi:', e.message); });
      console.log('[AGEND] Disparando agendamento #' + ag.id + ' para todos os grupos (' + ag.grupo + ')');
      continue;
    }
    const grupoId = resolverGrupo(ag.grupo);
    if (!grupoId) { ag.status = 'erro'; delete ag.anexo; salvarAgendamentos(); continue; }
    const isEmissao = ag.grupo === 'cdv_emissao' || grupoId === GRUPOS['cdv_emissao'];
    if (isEmissao && !ag.direto) {
      enfileirarEnvio(ag.ofertaId ?? ('ag-'+ag.id), ag.mensagem, grupoId, ag.dados || null);
    } else {
      // A thumbnail e baixada agora, na hora do disparo, e nao no agendamento:
      // guardar bytes no agendamentos.json inflaria o arquivo e ainda entregaria
      // uma foto velha se a loja trocasse a imagem do anuncio no meio do caminho.
      despacharAgendamento(ag, grupoId)
        .then(() => { ag.status = 'enviado'; delete ag.anexo; salvarAgendamentos(); })
        .catch(e  => { ag.status = 'erro';   delete ag.anexo; salvarAgendamentos(); console.error('[AGEND] Erro envio:', e.message); });
    }
    console.log('[AGEND] Disparando agendamento #'+ag.id+' para grupo '+ag.grupo);
  }
}, 30 * 1000);

// ── Limpeza automática da fila (a cada 15 min) — nível do módulo ────────────
setInterval(() => {
  const antes = filaPendentes.length;
  limparFila();
  salvarFila();
  const depois = filaPendentes.length;
  if (antes !== depois) console.log('[FILA] Limpeza automática: ' + (antes - depois) + ' oferta(s) removida(s).');

  // Agendamentos ja resolvidos so interessam por alguns dias: sem poda o
  // arquivo cresce para sempre e o boot fica mais lento a cada semana.
  const corte = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const antesAg = agendamentos.length;
  agendamentos = agendamentos.filter(a =>
    a.status === 'aguardando' || new Date(a.criadoEm || 0).getTime() > corte);
  if (agendamentos.length !== antesAg) {
    salvarAgendamentos();
    console.log('[AGEND] Poda: ' + (antesAg - agendamentos.length) + ' agendamento(s) antigo(s) removido(s).');
  }
}, 15 * 60 * 1000);

function resolverGrupo(chave) {
  return GRUPOS[chave] ?? (chave?.includes('@g.us') ? chave : null);
}

// Apelidos que NAO sao um JID: significam "todos os grupos configurados na aba
// Grupos". 'tsp' e o apelido historico do gerador manual — antes apontava para
// um unico grupo padrao, que deixou de existir quando os destinos passaram a
// ser configuraveis. Quem resolve a lista e o envio, na hora do disparo.
const ALIAS_MULTI = new Set(['tsp', 'tsp_destinos', 'todos']);
function ehGrupoMulti(chave) { return ALIAS_MULTI.has(String(chave || '').toLowerCase()); }
function gerarId() { return contadorId++; }

// ── TABELA IATA → CIDADE ──────────────────────────────────────────────────────
const IATA_CIDADES = {
  'GRU':'São Paulo','CGH':'São Paulo','VCP':'Campinas',
  'GIG':'Rio de Janeiro','SDU':'Rio de Janeiro',
  'BSB':'Brasília','CNF':'Belo Horizonte','SSA':'Salvador',
  'REC':'Recife','FOR':'Fortaleza','MAO':'Manaus','BEL':'Belém',
  'CWB':'Curitiba','POA':'Porto Alegre','FLN':'Florianópolis',
  'NAT':'Natal','MCZ':'Maceió','AJU':'Aracaju','THE':'Teresina',
  'SLZ':'São Luís','JPA':'João Pessoa','PMW':'Palmas',
  'MIA':'Miami','JFK':'Nova York','EWR':'Nova York','LGA':'Nova York',
  'MCO':'Orlando','LAX':'Los Angeles','ORD':'Chicago','ATL':'Atlanta',
  'IAH':'Houston','DFW':'Dallas','SFO':'São Francisco','BOS':'Boston',
  'LIS':'Lisboa','MAD':'Madrid','CDG':'Paris','LHR':'Londres',
  'FCO':'Roma','MXP':'Milão','AMS':'Amsterdã','FRA':'Frankfurt',
  'BCN':'Barcelona','VIE':'Viena','ZRH':'Zurique','MUC':'Munique',
  'CPH':'Copenhague','ARN':'Estocolmo','HEL':'Helsinki','OSL':'Oslo',
  'EZE':'Buenos Aires','AEP':'Buenos Aires','SCL':'Santiago',
  'BOG':'Bogotá','LIM':'Lima','MVD':'Montevidéu','ASU':'Assunção',
  'CUN':'Cancún','MEX':'Cidade do México','PTY':'Cidade do Panamá',
  'MBJ':'Montego Bay','HAV':'Havana','SDQ':'Santo Domingo',
  'DXB':'Dubai','DOH':'Doha','AUH':'Abu Dhabi','RUH':'Riade',
  'NRT':'Tóquio','HND':'Tóquio','ICN':'Seul','PEK':'Pequim',
  'PVG':'Xangai','HKG':'Hong Kong','SIN':'Singapura',
  'BKK':'Bangcoc','KUL':'Kuala Lumpur','CGK':'Jacarta',
  'SYD':'Sydney','MEL':'Melbourne','AKL':'Auckland',
  'JNB':'Joanesburgo','CPT':'Cidade do Cabo','CAI':'Cairo',
  'CMN':'Casablanca','NBO':'Nairóbi',
  // Ampliacao para cobrir as cidades mais frequentes da base de emissoes que
  // ainda nao tinham codigo — sem codigo o link cai no destino padrao.
  'NVT':'Navegantes','VIX':'Vitória','GYN':'Goiânia','IGU':'Foz do Iguaçu',
  'BPS':'Porto Seguro','UDI':'Uberlândia','CGR':'Campo Grande','CGB':'Cuiabá',
  'JOI':'Joinville','FEN':'Fernando de Noronha','LDB':'Londrina','PNZ':'Petrolina',
  'BYO':'Bonito','IOS':'Ilhéus','MGF':'Maringá','RAO':'Ribeirão Preto',
  'AUA':'Aruba','CTG':'Cartagena','PUJ':'Punta Cana','ADZ':'San Andrés',
  'MDZ':'Mendoza','UIO':'Quito','CUR':'Curaçao','CUZ':'Cusco','BRC':'Bariloche',
  'SJO':'San José','IAD':'Washington','YYZ':'Toronto','YUL':'Montreal',
  'OPO':'Porto','FNC':'Madeira','LPA':'Las Palmas','EDI':'Edimburgo',
  'BRU':'Bruxelas','GVA':'Genebra','NCE':'Nice','VCE':'Veneza','ZAG':'Zagreb',
  'IST':'Istambul','TPE':'Taipei','NGO':'Nagoia','HNL':'Honolulu',
};

// Grafias alternativas que a IA as vezes devolve em ingles ou sem acento.
const CIDADE_ALIAS = {
  'amsterdam':'Amsterdã', 'cape town':'Cidade do Cabo', 'sao francisco':'São Francisco',
  'san jose':'San José', 'uberlandia':'Uberlândia', 'mexico city':'Cidade do México',
  'new york':'Nova York', 'lisbon':'Lisboa', 'rome':'Roma', 'milan':'Milão',
  'panama city':'Cidade do Panamá', 'shangai':'Xangai', 'singapora':'Singapura',
};

// Reverso de IATA_CIDADES: cidade → aeroporto principal. Como o objeto acima
// lista o aeroporto principal primeiro em cada cidade (GRU antes de CGH, GIG
// antes de SDU, EZE antes de AEP, JFK antes de EWR/LGA, NRT antes de HND), a
// regra "primeiro vence" ja entrega a escolha certa.
const CIDADE_IATA = (function () {
  const m = {};
  for (const cod of Object.keys(IATA_CIDADES)) {
    const chave = normalizarCidade(IATA_CIDADES[cod]);
    if (!m[chave]) m[chave] = cod;
  }
  return m;
})();

function normalizarCidade(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function iataDaCidade(nome) {
  const k = normalizarCidade(nome);
  if (CIDADE_IATA[k]) return CIDADE_IATA[k];
  const alias = CIDADE_ALIAS[k];
  return alias ? (CIDADE_IATA[normalizarCidade(alias)] || null) : null;
}

// ── Extracao de datas do texto livre de datasIda / datasVolta ────────────────
// Os formatos usados nas mensagens sao "Ago/26: 15, 20", "18, 20 de Junho" e
// "26,27/03;04/06". Devolve ISO ordenado; o link usa a PRIMEIRA ida e a ULTIMA
// volta, que e o intervalo que cobre a oferta inteira.
const MESES_NUM = { jan:1, fev:2, mar:3, abr:4, mai:5, jun:6, jul:7, ago:8, set:9, out:10, nov:11, dez:12 };

function extrairDatasISO(str, ref) {
  const txt = String(str || '').trim();
  if (!txt || txt === '-') return [];
  const hoje = ref instanceof Date ? ref : new Date();
  const out = new Set();
  const add = (a, mes, dia) => {
    const d = new Date(Date.UTC(a, mes - 1, dia));
    if (d.getUTCMonth() === mes - 1 && d.getUTCDate() === dia) out.add(d.toISOString().slice(0, 10));
  };
  const anoImplicito = (mes) => (mes >= hoje.getUTCMonth() + 1 ? hoje.getUTCFullYear() : hoje.getUTCFullYear() + 1);
  const expandir = (t) => {
    const dias = [];
    for (const p of String(t).split(/[,\s]+|\se\s/)) {
      const f = p.trim().match(/^(\d{1,2})\s*[-\u2013a]\s*(\d{1,2})$/);
      if (f) { const a = +f[1], b = +f[2]; if (a <= b && b <= 31) for (let x = a; x <= b; x++) dias.push(x); }
      else if (/^\d{1,2}$/.test(p.trim())) dias.push(+p.trim());
    }
    return dias;
  };
  const mesDe = (n) => MESES_NUM[normalizarCidade(n).slice(0, 3)];

  // "Ago/26: 15, 20"  |  "Marco: 03, 09-11"
  let achou = false;
  const re1 = /([A-Za-z\u00C0-\u00FF]{3,10})\s*(?:\/\s*(\d{2,4}))?\s*:\s*([0-9][0-9,\s\-\u2013]*)/g;
  let m;
  while ((m = re1.exec(txt))) {
    const mes = mesDe(m[1]); if (!mes) continue;
    const ano = m[2] ? (+m[2] < 100 ? 2000 + +m[2] : +m[2]) : anoImplicito(mes);
    for (const d of expandir(m[3])) { add(ano, mes, d); achou = true; }
  }
  // "18, 20 de Junho [2026]"
  if (!achou) {
    const re2 = /([0-9][0-9,\s\-\u2013]*?)\s*(?:de\s+)?([A-Za-z\u00C0-\u00FF]{3,10})\s*(\d{4})?/g;
    while ((m = re2.exec(txt))) {
      const mes = mesDe(m[2]); if (!mes) continue;
      const ano = m[3] ? +m[3] : anoImplicito(mes);
      for (const d of expandir(m[1])) { add(ano, mes, d); achou = true; }
    }
  }
  // "26,27/03;04/06"
  if (!achou) {
    const re3 = /(\d{1,2}(?:\s*[-\u2013]\s*\d{1,2})?)\s*\/\s*(\d{1,2})(?!\d)/g;
    while ((m = re3.exec(txt))) {
      const mes = +m[2]; if (mes < 1 || mes > 12) continue;
      for (const d of expandir(m[1])) add(anoImplicito(mes), mes, d);
    }
  }
  return [...out].sort();
}

function resolverCidade(codigo, nomeIA) {
  if (codigo && IATA_CIDADES[codigo.toUpperCase()]) return IATA_CIDADES[codigo.toUpperCase()];
  return nomeIA || codigo || '-';
}

// ── CONSTANTES CDV ────────────────────────────────────────────────────────────
const PROGRAMAS_CPM = {
  'Smiles':16,'Azul Fidelidade':15,'Azul pelo Mundo':15,
  'LATAM Pass':26,'Iberia Plus':58,'Privilege Club':58,
  'Executive Club':58,'TAP':43,'AAdvantage':100,'SUMA':80,
  'Flying Club':50,'Finnair Plus':58,'Aeroplan':50
};
// Links mascarados do Clube do Viajante. O destino real (com os parametros de
// afiliado) vive em painel-cdv/links.json e e resolvido pelo endpoint /ir do
// proxy. Para trocar um destino NAO mexa aqui: edite links.json.
// ATENCAO: manter os slugs iguais aos de gerador-cdv/index.html (PROGRAMAS_SLUG).
const IR_BASE = 'https://ir.clubedoviajante.com.br/';
const PROGRAMAS_SLUG = {
  'Smiles':'smiles',
  'Azul Fidelidade':'azul',
  'Azul pelo Mundo':'azul-mundo',
  'LATAM Pass':'latam',
  'Iberia Plus':'iberia',
  'Privilege Club':'qatar',
  'Executive Club':'british',
  'TAP':'tap',
  'AAdvantage':'aadvantage',
  'SUMA':'suma',
  'Flying Club':'virgin',
  'Finnair Plus':'finnair',
  'Aeroplan':'aeroplan'
};
// Programas cujo link mascarado aceita a busca ja preenchida (o proxy monta a
// URL final em BUSCA_BUILDERS). Adicionar aqui conforme forem mapeados.
const PROGRAMAS_COM_BUSCA = new Set(['smiles']);

function linkPrograma(programa, origem, busca) {
  const slug = PROGRAMAS_SLUG[programa];
  if (!slug) {
    console.warn('[links] programa sem slug cadastrado:', programa);
    return '';
  }
  const qs = [];
  if (origem) qs.push('o=' + encodeURIComponent(origem));
  if (busca && PROGRAMAS_COM_BUSCA.has(slug) && busca.bo && busca.bd && busca.bi) {
    qs.push('bo=' + busca.bo, 'bd=' + busca.bd, 'bi=' + busca.bi);
    if (busca.bv) qs.push('bv=' + busca.bv);
    if (busca.bc) qs.push('bc=' + busca.bc);
  }
  return IR_BASE + slug + (qs.length ? '?' + qs.join('&') : '');
}

// Monta os parametros de busca a partir dos dados da emissao.
// Regra: primeira data de ida; se houver volta, a ULTIMA data de volta.
function buscaDaEmissao(d) {
  const bo = iataDaCidade(d.origem), bd = iataDaCidade(d.destino);
  if (!bo || !bd) return null;   // cidade fora da tabela IATA: link continua o padrao
  const idas = extrairDatasISO(d.datasIda);
  if (!idas.length) return null;
  const bi = idas[0];
  // A lista de volta nem sempre pertence a mesma combinacao da ida — ha ofertas
  // com voltas anteriores a primeira ida. Volta antes da ida faria a Smiles
  // recusar a busca, entao nesse caso o link sai como so-ida.
  const voltas = extrairDatasISO(d.datasVolta).filter((v) => v >= bi);
  return {
    bo, bd,
    bi,
    bv: voltas.length ? voltas[voltas.length - 1] : '',
    bc: /execut|business/i.test(d.cabine || '') ? 'exec' : 'eco',
  };
}

function contarDatas(datasStr) {
  if (!datasStr || datasStr === '-') return 0;
  const matches = datasStr.match(/\b\d{1,2}\b/g);
  return matches ? matches.length : 0;
}

function comprimirSequencia(nums) {
  if (!nums || nums.length === 0) return '';
  const sorted = [...new Set(nums)].sort((a, b) => a - b);
  const grupos = [];
  let inicio = sorted[0], fim = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === fim + 1) {
      fim = sorted[i];
    } else {
      grupos.push(inicio === fim ? String(inicio) : fim === inicio + 1 ? `${inicio}, ${fim}` : `${inicio}-${fim}`);
      inicio = sorted[i]; fim = sorted[i];
    }
  }
  grupos.push(inicio === fim ? String(inicio) : fim === inicio + 1 ? `${inicio}, ${fim}` : `${inicio}-${fim}`);
  return grupos.join(', ');
}

function formatarDatas(str) {
  if (!str || str === '-') return '-';
  return str
    .replace(/([A-Za-záàãâéêíóôõúüç]+\/\d{2}:)/g, '\n$1')
    .replace(/^\n/, '')
    .trim()
    .split('\n')
    .map(linha => {
      const match = linha.match(/^([A-Za-záàãâéêíóôõúüç]+\/\d{2}:)\s*(.+)$/);
      if (!match) return linha;
      const prefixo = match[1];
      const dias = match[2].match(/\d+/g);
      if (!dias || dias.length <= 2) return linha;
      const nums = dias.map(Number);
      return `${prefixo} ${comprimirSequencia(nums)}`;
    })
    .join('\n');
}

// ── CAMPOS EDITAVEIS DO PAINEL ───────────────────────────────────────────────
// Os campos abaixo sao a fonte unica de verdade da emissao: o que o operador
// corrige no painel vale tanto para a mensagem que sai no grupo quanto para o
// registro em passagens.json (gravado pelo worker de envio a partir de
// dadosExtraidos). Metadados internos (indices, origemCodigo, tipo, indice)
// nao sao editaveis e ficam preservados.
const CAMPOS_EDITAVEIS_ALERTA = ['origem','destino','cia','programa','pontos','cabine','tipoVoo','datasIda','datasVolta'];

function aplicarDadosEditados(oferta, dados) {
  // Sem payload de campos (ex: painel HTML interno do Baileys), nao mexe em nada.
  if (!dados || typeof dados !== 'object') return oferta.dadosExtraidos || {};
  if (!oferta.dadosExtraidos) oferta.dadosExtraidos = {};
  const de = oferta.dadosExtraidos;
  for (const k of CAMPOS_EDITAVEIS_ALERTA) {
    const v = dados[k];
    if (v === undefined || v === null) continue;
    de[k] = String(v).trim();
  }
  return de;
}

// Corrige a grafia da cabine APENAS para exibicao. O valor canonico interno
// segue sem acento ("Economica"), porque a deduplicacao de emissoes e o
// registro em passagens.json comparam esse formato por igualdade estrita.
function rotuloCabine(c) {
  var s = String(c == null ? '' : c).trim();
  if (!s) return 'Econômica';
  var base = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  var alta = s === s.toUpperCase();
  var MAP = {
    'economica': 'Econômica',
    'economy': 'Econômica',
    'economica premium': 'Econômica Premium',
    'premium economica': 'Premium Econômica',
    'executiva': 'Executiva',
    'business': 'Executiva',
    'primeira classe': 'Primeira Classe'
  };
  var r = MAP[base];
  if (!r) return s;
  return alta ? r.toUpperCase() : r;
}

function formatarMensagemCDV(d) {
  var n = '\n';
  var rodape = '`Dica de emissão encontrada por @davileles - Clube do Viajante`';
  var balcao = '`Faça parte do Balcão clicando aqui: https://pay.hub.la/TkIbYhix67evTSu1be7c`';
  var cpm = PROGRAMAS_CPM[d.programa] || 0;
  // Título usa SEMPRE o MENOR valor entre os trechos. d.pontos pode vir como
  // um número só ("458600"), com separador ("102.000") ou com os dois trechos
  // ("102000 (ida) / 86600 (volta)"). Extrai todos os números e pega o mínimo.
  var pontosTokens = String(d.pontos||'').replace(/\([^)]*\)/g, ' ').match(/\d[\d.,]*/g);
  var pontosNums = (pontosTokens || [])
    .map(function (s) { return parseInt(s.replace(/[.,]/g, ''), 10) || 0; })
    .filter(function (x) { return x > 0 && x <= 5000000; });
  var num = pontosNums.length ? Math.min.apply(null, pontosNums) : 0;
  var valR = cpm > 0 ? Math.round((num/1000)*cpm) : 0;
  var valStr = valR > 0 ? 'R$ '+valR.toLocaleString('pt-BR') : '-';
  var link = linkPrograma(d.programa, 'alerta', buscaDaEmissao(d));
  var trecho = d.tipoVoo === 'internacional' ? ' o trecho em '+rotuloCabine(d.cabine) : '';
  var pts = num > 0 ? num.toLocaleString('pt-BR') : (d.pontos||'-');
  var msg = '';
  msg += '*'+d.origem+' - '+d.destino+' por '+pts+' pontos OU '+valStr+trecho+'*'+n+n;
  msg += rodape+n+n;
  msg += 'Você pode comprar essa passagem no Balcão de Milhas CDV por aproximadamente '+valStr+' o trecho + taxa de embarque.'+n+n;
  msg += balcao+n+n;
  msg += '✈️ *DATAS DE IDA*'+n+formatarDatas(d.datasIda)+n+n;
  msg += '🛬 *DATAS DE VOLTA*'+n+formatarDatas(d.datasVolta)+n+n;
  msg += '🎟️ *PROGRAMA* '+d.programa+n+n;
  msg += '✈️ *CIA AÉREA* '+d.cia+n+n;
  msg += '🔗 *LINK* '+link+n+n;
  msg += rodape;
  return msg;
}

// ── REGISTRO DE PASSAGEM NO PROXY + HISTÓRICO 180 DIAS ───────────────────────
const CDV_PROXY_URL = 'https://cdv-proxy-production.up.railway.app';

async function registrarPassagemProxy(dados) {
  // Chama /passagens/registrar e retorna hist180 stats ({ minPts, mediaPts, count, isMin })
  // ou null em caso de falha (fire-and-register, não bloqueia o fluxo).
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(CDV_PROXY_URL + '/passagens/registrar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dados),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    const json = await r.json();
    return json.ok ? (json.hist180 || null) : null;
  } catch (e) {
    console.warn('[CDV-HIST] Falha ao registrar passagem no proxy:', e.message);
    return null;
  }
}

function appendHistoricoMensagem(msg, hist180) {
  // Insere bloco de histórico ANTES do 🔗 *LINK* na mensagem WhatsApp.
  // Só inclui se hist180 tiver ao menos 1 entrada prévia (count >= 1).
  if (!hist180 || hist180.count < 1) return msg;
  const min   = hist180.minPts.toLocaleString('pt-BR');
  const media = hist180.mediaPts.toLocaleString('pt-BR');
  const minLinha = hist180.isMin
    ? `🏆 *MÍN. 180 DIAS*: ${min} pts ➤ 🔥 Menor valor histórico`
    : `🏆 *MÍN. 180 DIAS*: ${min} pts`;
  const bloco = `${minLinha}\n\n📈 *MÉDIA 180 DIAS*: ${media} pts\n\n`;
  // Insere antes do marcador do LINK
  const linkMarker = '🔗 *LINK*';
  const linkIdx = msg.indexOf(linkMarker);
  if (linkIdx === -1) return msg + '\n\n' + bloco.trim();
  return msg.slice(0, linkIdx) + bloco + msg.slice(linkIdx);
}

// ── FILTRO: preço fora da curva vs média 180 dias ────────────────────────────
// Descarta emissões cujo valor supera a média dos últimos 180 dias da MESMA
// chave (origem|destino|programa|cabine|cia — a mesma usada pelo proxy no
// hist180) em mais de 30% (internacional) ou 50% (nacional). Valores tão
// acima do histórico já computado não valem alerta.
function precoForaDaCurva(pontos, hist180, tipoVoo) {
  if (!hist180 || !hist180.mediaPts || hist180.count < 1) return false;
  const pts = Number(pontos) || 0;
  if (pts <= 0) return false;
  const tipo = String(tipoVoo || '').toLowerCase();
  // "internacional" contém "nacional" — teste de internacional vem primeiro;
  // tipoVoo ausente assume internacional (mesmo default do restante do código)
  const nacional = !/internacion/.test(tipo) && /nacion|domest/.test(tipo);
  const fator  = nacional ? 1.50 : 1.30;
  const limite = Math.round(hist180.mediaPts * fator);
  if (pts > limite) {
    console.log('[FILTRO-180D] Fora da curva: ' + pts.toLocaleString('pt-BR') + ' pts > limite ' + limite.toLocaleString('pt-BR') + ' (média ' + hist180.mediaPts.toLocaleString('pt-BR') + ' × ' + fator + ', ' + hist180.count + ' amostra(s), ' + (nacional ? 'nacional' : 'internacional') + ')');
    return true;
  }
  return false;
}

// ── LINKS AFILIADOS TSP ───────────────────────────────────────────────────────
// Os links agora vem da config editavel pelo painel (aba Configuracoes). O
// Proxy mantem a leitura LINKS_TSP['Loja'] usada em todo o arquivo, sempre
// refletindo o valor atual — sem restart apos salvar.
const LINKS_TSP = new Proxy({}, { get: (_alvo, chave) => linksTsp()[chave] });

// A IA devolve a loja como "Zé Delivery", "Ze Delivery", "zedelivery" ou
// "Outro: Zé Delivery" dependendo de como o texto original escreveu. Uma unica
// funcao de reconhecimento evita repetir a variacao em cada ponto.
function ehZeDelivery(loja) {
  const n = String(loja || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/^outro:\s*/, '').replace(/[^a-z]/g, '');
  return n.includes('zedelivery') || n === 'ze';
}

// A IA devolve lojas fora das quatro principais como "Outro: Casas Bahia".
// O prefixo e um rotulo interno de classificacao — nunca deve vazar para a
// mensagem enviada ao grupo, onde so o nome da loja faz sentido.
function nomeLojaExibicao(loja) {
  return String(loja || '').replace(/^outr[oa]s?\s*:\s*/i, '').trim();
}

// Link de resgate do cupom. Lojas com link fixo na config saem daqui; o resto
// cai na Awin, que cobre qualquer anunciante afiliado. Um link ja resolvido em
// dados.urlAfiliado (caso da propria Offers API) tem prioridade sobre tudo.
function linkDoCupomTSP(loja, codigo, dados = {}) {
  const lojaNorm = loja.toLowerCase().replace(/^outro:\s*/, '').trim();
  const isMagalu = /magazine\s*luiza|magalu/.test(lojaNorm);

  let url = '';
  if (loja === 'Amazon')             url = LINKS_TSP['Amazon'];
  else if (loja === 'Mercado Livre') url = LINKS_TSP['Mercado Livre'];
  else if (loja === 'Shopee')        url = codigo ? LINKS_TSP['Shopee_com'] : LINKS_TSP['Shopee_sem'];
  else if (isMagalu)                 url = LINKS_TSP['Magazine Luiza'];
  else if (ehZeDelivery(loja))       url = LINKS_TSP['Zé Delivery'];
  if (!url) url = dados.urlAfiliado || linkAwinDaLoja(loja) || '';
  return url || '';
}

// Variaveis do template de cupom. Toda a regra de negocio (o que e teto de
// desconto, o que e teto de produto, quando se pode afirmar "sem minimo") vive
// AQUI — o template so escolhe onde cada frase aparece.
function varsDoCupomTSP(dados) {
  const loja   = nomeLojaExibicao(dados.loja);
  const tipo   = dados.tipo   || 'reais';
  const valor  = dados.valor  || 0;
  // minimo null/0 = sem valor minimo. Antes caia em `|| 0` e a mensagem saia
  // como "Válido em compras acima de R$ 0".
  const minimo = (dados.minimo === null || dados.minimo === undefined) ? null : Number(dados.minimo);
  const temMin = minimo !== null && minimo > 0;
  const limite = dados.limite || null;
  // Teto do PRODUTO ("15% em produtos de ate R$700"), que nao e o teto do
  // desconto. Tratar um como o outro anuncia o cupom para uma faixa de preco em
  // que ele nao vale — o pior erro possivel numa mensagem de cupom.
  const maximo = dados.maximo || null;
  const codigo = dados.codigo || null;
  const isPct  = tipo === 'pct';
  const tipoStr = isPct ? '%' : ' reais';

  const partes = [];
  if (temMin) partes.push(`em compras acima de R$ ${minimo}`);
  if (maximo) partes.push(`em produtos de até R$ ${maximo}`);
  if (isPct && limite) partes.push(`com limite de R$ ${limite} de desconto`);

  // "Sem valor minimo" e uma AFIRMACAO. So pode ser feita quando a fonte disse
  // que nao ha minimo. Quando ela apenas nao informou (caso comum nas ofertas
  // da rede), a mensagem manda conferir as condicoes em vez de prometer algo.
  const validade = partes.length
    ? 'Válido ' + partes.join(', ') + '.'
    : (dados.minimoDesconhecido
        ? 'Confira as condições de uso na página da loja.'
        : 'Válido sem valor mínimo de compra.');

  // Com teto de desconto, a compra "ideal" e aquela em que o percentual bate
  // exatamente no teto. Com teto de PRODUTO, o desconto maximo e simplesmente o
  // percentual sobre esse teto — sao contas diferentes e a mensagem tem de dizer
  // qual delas esta mostrando.
  let importante = '';
  if (isPct && limite && Number(valor) > 0) {
    const ideal = Math.ceil(100 * Number(limite) / Number(valor));
    const tetoIdeal = maximo ? Math.min(ideal, Number(maximo)) : ideal;
    importante = `Ideal para compras de até R$ ${tetoIdeal}.`;
  } else if (isPct && maximo) {
    const economia = Math.floor(Number(maximo) * Number(valor) / 100);
    importante = `Só vale para produtos de até R$ ${maximo} — economia máxima de R$ ${economia}.`;
  }

  return {
    gatilho:    String(dados.gatilho || '').trim(),
    loja,
    loja_upper: loja.toUpperCase(),
    valor:      String(valor),
    valor_str:  `${valor}${tipoStr}`,
    validade,
    codigo:     codigo ? String(codigo).toUpperCase() : '',
    importante,
    aviso:      String(dados.aviso || dados.observacao || '').trim(),
    link:       linkDoCupomTSP(loja, codigo, dados),
    minimo:     temMin ? String(minimo) : '',
    maximo:     maximo ? String(maximo) : '',
    limite:     limite ? String(limite) : '',
  };
}

// O layout deixou de ser codigo e virou template editavel na aba Templates
// (chave '_cupom'). O auto-envio do monitoramento e a aba Cupom do painel
// renderizam O MESMO corpo — antes cada um tinha a sua copia do formato e elas
// divergiam sem ninguem perceber.
// O rodape faz parte do corpo do template (igual as ofertas) — nada e anexado
// depois. Quem quiser mudar o convite edita o template, nao o codigo.
function formatarCupomTSP(dados) {
  const corpo = (templateCupom()?.corpo || '').trim();
  return renderTemplate(corpo, varsDoCupomTSP(dados));
}

// Boot: reaplica links de afiliado nos cupons TSP que já estavam na fila.
// Precisa rodar aqui (e não junto de carregarFila) porque depende de LINKS_TSP.
reformatarCupomsTSPPendentes();

// ── CHAMADA ANTHROPIC ─────────────────────────────────────────────────────────
// Motivo da ultima falha do chamarClaude. Serve para o aviso ao operador dizer
// POR QUE a mensagem foi descartada, em vez de um generico "falhou".
let _ultimoMotivoClaude = null;

async function chamarClaude(system, userContent, maxTokens) {
  _ultimoMotivoClaude = null;
  // 3 tentativas com backoff — antes uma falha momentânea da API/parse fazia
  // a classificação retornar null e o item sumia silenciosamente do buffer.
  const ESPERAS = [0, 2000, 5000];
  for (let tentativa = 0; tentativa < ESPERAS.length; tentativa++) {
    if (ESPERAS[tentativa] > 0) await new Promise(r => setTimeout(r, ESPERAS[tentativa]));
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey(),
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5',
          max_tokens: maxTokens || 1024,
          system,
          messages: [{ role: 'user', content: userContent }],
        }),
      });
      const data = await response.json();
      if (data.error) { console.log('API erro (tentativa '+(tentativa+1)+'/3):', JSON.stringify(data.error)); continue; }
      // stop_reason 'max_tokens' = resposta cortada no meio. O JSON.parse vai
      // falhar nas 3 tentativas sempre igual (o corte e deterministico), entao
      // repetir e desperdicio: o log precisa dizer que o teto e que e curto,
      // senao isso aparece como "parse falhou" e manda investigar o lugar errado.
      if (data.stop_reason === 'max_tokens') {
        console.error('[CLAUDE] Resposta truncada em max_tokens=' + (maxTokens || 1024)
          + ' — aumente o teto desta chamada. Nao adianta repetir.');
        _ultimoMotivoClaude = 'resposta truncada (max_tokens=' + (maxTokens || 1024) + ')';
        return null;
      }
      const raw = data.content?.[0]?.text || '{}';
      try { return JSON.parse(raw.replace(/```json|```/g,'').trim()); }
      catch(e) {
        console.log('JSON parse falhou (tentativa '+(tentativa+1)+'/3):', e.message);
        _ultimoMotivoClaude = 'JSON invalido: ' + e.message;
        continue;
      }
    } catch(e) {
      console.log('Fetch API falhou (tentativa '+(tentativa+1)+'/3):', e.message);
    }
  }
  console.log('[CLAUDE] Todas as tentativas falharam — retornando null.');
  return null;
}

// ── EXTRAIR CAMPOS DO CUPOM TELEGRAM ─────────────────────────────────────────
async function extrairCupomTelegram(texto) {
  const system = `Você é um extrator de dados de cupons de desconto para o mercado brasileiro.
Analise a mensagem e retorne SOMENTE JSON válido, sem texto extra, sem markdown.

Campos:
{
  "eh_cupom": true/false,
  "loja": "Amazon" | "Mercado Livre" | "Shopee" | "Magazine Luiza" | "Outro: nome",
  "tipo": "pct" | "reais",
  "valor": número (ex: 10, 30, 15),
  "minimo": número | null (valor mínimo de compra; use null se a mensagem NÃO informar mínimo),
  "maximo": número | null (preço máximo do produto/pedido para o cupom valer; null se não informado),
  "limite": número | null (limite máximo de DESCONTO em R$, só para tipo "pct"),
  "codigo": "CUPOM123" | null,
  "multiplos": [ {valor, minimo, codigo, tipo} ] | null (quando há múltiplos cupons na mesma mensagem),
  "observacao": "texto livre" | null
}

Regras:
- Se não for cupom de desconto com código de DESCONTO aplicável em compras, retorne {"eh_cupom": false}
- NÃO é cupom: ofertas de milhas, pontos, cashback em programas de fidelidade (Azul Fidelidade, Smiles, TudoAzul, Livelo, etc), bônus de cadastro, promoções de acúmulo de pontos, sorteios, gifts, reembolso, indique-e-ganhe — mesmo que tenham um código
- É cupom: código de desconto (%) ou valor fixo (R$) aplicável em compras em lojas como Amazon, Mercado Livre, Shopee, iFood, Uber Eats, Rappi, Magazine Luiza, etc
- Magalu / Magazine Luiza / Magazine Você = sempre retorne "loja": "Magazine Luiza"
- Shopee sem código = "codigo": null
- "tipo": use "pct" quando o desconto for em porcentagem (ex: 20% OFF, 15% de desconto). Use "reais" quando for valor fixo em R$ (ex: R$30 OFF, R$10 de desconto)
- Em "multiplos", cada item DEVE ter seu próprio campo "tipo" ("pct" ou "reais") — não herde o tipo do cupom principal
- Para múltiplos cupons na mesma mensagem (ex: 20% OFF em TVs + 15% OFF em Celulares), use "multiplos" com um item por cupom
- Valores devem ser números puros sem símbolo (ex: 20 para 20%, 30 para R$30)
- "minimo": use null quando a mensagem não informar valor mínimo de compra. Use 0 SOMENTE se a mensagem disser explicitamente que não há mínimo ("sem valor mínimo", "sem mínimo"). Nunca chute um valor.
- ATENÇÃO — "limite" e "maximo" são coisas DIFERENTES e confundi-los inverte o sentido do cupom:
  • "limite" = teto do DESCONTO. Frases: "15% OFF até R$60 de desconto", "desconto máximo de R$60", "limitado a R$60".
  • "maximo" = teto do PREÇO DO PRODUTO ou do pedido que pode usar o cupom. Frases: "15% OFF em produtos de até R$700", "em compras de até R$700", "válido para itens até R$700", "para produtos abaixo de R$700".
  • Exemplo: "15% OFF em produtos de até R$700" → {"valor":15,"tipo":"pct","maximo":700,"limite":null}. NUNCA {"limite":700}.
  • Exemplo: "15% OFF, desconto máximo de R$60, mínimo R$79" → {"valor":15,"tipo":"pct","minimo":79,"limite":60,"maximo":null}.
  • Na dúvida entre os dois, olhe se o valor se refere ao que o cliente ECONOMIZA (limite) ou ao que ele COMPRA (maximo).
- Em "multiplos", cada item pode ter seu próprio "minimo", "maximo" e "limite".`;

  // 2000 e nao 500: uma mensagem com 8 cupons ja estoura 500 tokens de saida,
  // o JSON volta cortado e a mensagem INTEIRA era descartada em silencio. As
  // listas diarias do Juao passam de 8 cupons com frequencia.
  return await chamarClaude(system, [{ type:'text', text: texto }], 2000);
}

// ── AUTO-ENVIO DE CUPOM TSP ──────────────────────────────────────────────────
// AUTO_ENVIO_CUPOM: 'off' (tudo vai para fila) | 'sombra' (avalia e loga, mas
// continua indo para fila) | 'on' (envia direto quando passa em todos os gates).
// Default 'sombra': ligar em producao exige acao explicita no Railway.
const AUTO_ENVIO_MODO       = (process.env.AUTO_ENVIO_CUPOM || 'sombra').toLowerCase();
// Ofertas de marketplace (Amazon/Shopee/ML/Magalu). Diferente dos cupons, aqui
// nao ha modo 'sombra': ou vai direto, ou vai para a fila.
const AUTO_ENVIO_OFERTA     = (process.env.AUTO_ENVIO_OFERTA || 'off').toLowerCase();
// Intervalo minimo entre auto-envios. Vem da janela de cupons (aba Cupons do
// painel) para o operador ajustar o ritmo sem redeploy.
function intervaloAutoEnvioMs() { return (janelaCupom().intervaloSeg ?? 90) * 1000; }
const AUTO_ENVIO_TEXTO_MIN  = 20;        // texto curto demais = info provavelmente na imagem
const AUTO_ENVIO_MAX_ESPERA = 30 * 60 * 1000; // agendado ha mais que isso = cupom provavelmente vencido, vira aprovacao manual
let   _ultimoAutoEnvio      = 0;

// Lojas elegiveis: precisam ter link de afiliado em LINKS_TSP, senao a mensagem
// sai sem "RESGATE O CUPOM AQUI" — comercialmente inutil.
function lojaComLink(loja, codigo) {
  const norm = (loja || '').toLowerCase().replace(/^outro:\s*/, '').trim();
  if (loja === 'Amazon')        return !!LINKS_TSP['Amazon'];
  if (loja === 'Mercado Livre') return !!LINKS_TSP['Mercado Livre'];
  // Shopee: auto-envio SOMENTE com codigo (decisao do operador).
  if (loja === 'Shopee')        return !!codigo && !!LINKS_TSP['Shopee_com'];
  if (/magazine\s*luiza|magalu/.test(norm)) return !!LINKS_TSP['Magazine Luiza'];
  if (ehZeDelivery(loja))       return !!LINKS_TSP['Zé Delivery'];
  // Loja da rede Awin: o link sai do proprio catalogo de programas afiliados.
  return !!linkAwinDaLoja(loja);
}

// Confere se um numero extraido pela IA aparece de fato no texto original.
// Pega a maior parte das alucinacoes numericas do modelo por um custo trivial.
function numeroNoTexto(texto, n) {
  if (n === null || n === undefined) return true;
  const num = Number(n);
  if (!isFinite(num)) return false;
  const digitos = String(Math.round(num));
  // aceita 1000, 1.000, 1,000 e variacoes com separador
  const re = new RegExp(digitos.split('').join('[.,\\s]?'), 'i');
  return re.test(texto);
}

// Em mensagem com varios cupons, o risco nao e a extracao em si — e a IA
// ATRIBUIR o minimo/limite de um cupom ao outro. Em vez de bloquear tudo,
// particiona o texto por codigo: o escopo de um cupom vai do fim do bloco
// anterior ate a linha onde o proprio codigo aparece. Validar os numeros
// dentro desse escopo prova que a atribuicao esta correta.
function escopoDoCupom(texto, codigo, todosCodigos) {
  const linhas = (texto || '').split('\n');
  const alvo = String(codigo || '').toLowerCase();
  if (!alvo) return null;
  const marcadas = linhas.map(l => {
    const low = l.toLowerCase();
    return todosCodigos.some(cd => cd && low.includes(String(cd).toLowerCase()));
  });
  const idx = linhas.findIndex(l => l.toLowerCase().includes(alvo));
  if (idx === -1) return null;
  let prev = -1;
  for (let i = 0; i < idx; i++) if (marcadas[i]) prev = i;
  return linhas.slice(prev + 1, idx + 1).join('\n');
}

// Gate deterministico. Retorna { auto:boolean, motivo:string }.
function avaliarAutoEnvio(cupom, textoOriginal, tinhaMultiplos, codigosIrmaos = []) {
  let t = textoOriginal || '';

  if (AUTO_ENVIO_MODO === 'off')          return { auto:false, motivo:'modo off' };
  if (t.trim().length < AUTO_ENVIO_TEXTO_MIN) return { auto:false, motivo:'texto curto demais (info pode estar na imagem)' };

  // Mensagem com varios cupons: restringe a validacao cruzada ao bloco deste
  // cupom. Se o bloco nao for identificavel, cai para a fila.
  if (tinhaMultiplos) {
    if (!cupom.codigo) return { auto:false, motivo:'multiplos cupons e este item sem codigo' };
    const escopo = escopoDoCupom(textoOriginal, cupom.codigo, codigosIrmaos);
    if (!escopo) return { auto:false, motivo:'multiplos cupons e bloco do codigo nao identificado' };
    t = escopo;
  }

  if (!cupom.loja)                        return { auto:false, motivo:'sem loja' };
  if (!cupom.codigo)                      return { auto:false, motivo:'sem codigo do cupom' };
  if (!lojaComLink(cupom.loja, cupom.codigo)) return { auto:false, motivo:`loja sem link de afiliado (${cupom.loja})` };

  if (cupom.tipo !== 'pct' && cupom.tipo !== 'reais') return { auto:false, motivo:'tipo invalido' };
  if (!(Number(cupom.valor) > 0))         return { auto:false, motivo:'valor ausente ou zero' };

  // Cupom lido de texto solto pode ter minimo omitido por falha de extracao —
  // dai a exigencia. Vindo da API do proprio anunciante (Awin), a ausencia e um
  // fato da oferta, nao um erro de leitura, e a mensagem ja avisa para conferir
  // as condicoes em vez de prometer "sem minimo".
  if (!cupom.fonteOficial && (cupom.minimo === null || cupom.minimo === undefined))
    return { auto:false, motivo:'minimo nao informado (regra de aplicacao incompleta)' };
  if (Number(cupom.minimo) < 0)           return { auto:false, motivo:'minimo invalido' };

  // Percentual precisa de ALGUM teto declarado: ou o do desconto ('limite') ou o
  // do produto elegivel ('maximo'). Sem nenhum dos dois a regra de aplicacao
  // esta incompleta e o cupom nao pode sair sozinho.
  if (!cupom.fonteOficial && cupom.tipo === 'pct'
      && !(Number(cupom.limite) > 0) && !(Number(cupom.maximo) > 0))
    return { auto:false, motivo:'cupom percentual sem teto de desconto nem de produto' };
  if (cupom.maximo != null && cupom.minimo != null && Number(cupom.maximo) > 0
      && Number(cupom.maximo) < Number(cupom.minimo))
    return { auto:false, motivo:'maximo menor que o minimo (extracao inconsistente)' };

  // Validacao cruzada contra o texto original
  const ondeStr = tinhaMultiplos ? 'no bloco deste cupom' : 'no texto original';
  if (!numeroNoTexto(t, cupom.valor))     return { auto:false, motivo:'valor nao confere '+ondeStr };
  if (Number(cupom.minimo) > 0 && !numeroNoTexto(t, cupom.minimo))
    return { auto:false, motivo:'minimo nao confere '+ondeStr };
  if (cupom.limite && !numeroNoTexto(t, cupom.limite))
    return { auto:false, motivo:'limite nao confere '+ondeStr };
  if (cupom.maximo && !numeroNoTexto(t, cupom.maximo))
    return { auto:false, motivo:'maximo nao confere '+ondeStr };
  if (!t.toLowerCase().includes(String(cupom.codigo).toLowerCase()))
    return { auto:false, motivo:'codigo nao aparece '+ondeStr };

  // Janela de publicacao configurada na aba Cupons — nada de cupom as 3h da manha
  const janela = dentroDaJanelaCupom();
  if (!janela.ok) return { auto:false, motivo: janela.motivo };

  // Anti-flood: canal despejando varios cupons de uma vez
  const intervalo = intervaloAutoEnvioMs();
  const desde = Date.now() - _ultimoAutoEnvio;
  if (desde < intervalo)
    return { auto:false, motivo:`intervalo minimo (faltam ${Math.ceil((intervalo-desde)/1000)}s)` };

  return { auto:true, motivo:'aprovado' };
}

// Envia um cupom para TODOS os grupos de destino configurados (radarDestinos)
// mais os grupos so-cupons. Todos recebem exatamente a mesma mensagem — a
// regra do rodape de convite cruzado foi removida. Falha isolada em um grupo
// NAO derruba os outros: loga, segue para o proximo e avisa o operador ao final.
async function enviarCupomParaGrupos(mensagem, imagem) {
  // Mesma conta em todos os grupos: o cupom e as copias dele saem juntos, e
  // alternar no meio deixaria o mesmo conteudo com dois remetentes no mesmo minuto.
  const op = { conta: contaDoTurno() };
  const destinos = radarDestinos();
  const soCupons = GRUPOS['tsp_cupons'];
  const alvos = [...new Set([...destinos, ...soCupons])];
  const enviados = [], falhas = [];

  for (const jid of alvos) {
    const texto = mensagem;
    try {
      if (imagem?.imagemBase64) {
        await enviarMensagem(jid, {
          image: Buffer.from(imagem.imagemBase64, 'base64'),
          caption: texto,
          mimetype: imagem.mime || 'image/jpeg',
        }, 0, op);
      } else {
        await enviarMensagem(jid, { text: texto }, 0, op);
      }
      enviados.push(jid);
      // Espacamento entre grupos: mesmo padrao das ofertas do radar, evita
      // rajada identica em varios grupos no mesmo segundo.
      if (alvos.length > 1) await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000));
    } catch(e) {
      console.error('[CUPONS] Falha ao enviar em ' + jid + ':', e.message);
      falhas.push({ jid, erro: e.message });
    }
  }

  if (!enviados.length) throw new Error('Nenhum grupo recebeu o cupom.');
  if (falhas.length) {
    try {
      await enviarMensagem(GRUPOS.operador, { text: '*Cupom nao entregue em ' + falhas.length + ' grupo(s)* \u26a0\ufe0f\n\n'
        + falhas.map(f => (NOMES_GRUPOS.get(f.jid) || f.jid) + ': ' + f.erro).join('\n') });
    } catch(_) {}
  }
  return { enviados, falhas };
}

// Envia uma oferta de marketplace para os grupos marcados como 'destino' no
// painel. Sem destino marcado, cai no grupo TSP principal.
//
// O espacamento de 3–5s entre grupos e proposital: disparo simultaneo em varios
// grupos e justamente o padrao que o WhatsApp usa para identificar automacao, e
// o custo de perder a sessao e muito maior que o de a oferta sair 1min depois.
// Monta o preview de link nativo. O Baileys aceita um linkPreview pronto
// (Utils/messages.js), entao nao precisamos de link-preview-js nem de raspar a
// pagina da Amazon — que bloqueia bots. A thumbnail vem da propria API.
// Acima de ~100KB o WhatsApp descarta o jpegThumbnail e a mensagem sai sem
// imagem; melhor mandar preview sem foto do que a mensagem falhar.
const THUMB_MAX_BYTES = 100 * 1024;

function montarLinkPreview(oferta, mensagem) {
  const d = oferta.dadosExtraidos || {};
  const url = d.link;
  if (!url) return null;

  const preview = {
    'canonical-url': url,
    'matched-text': url,
    title: d.titulo || d.loja || 'Oferta',
    description: [d.precoFinal != null ? 'R$ ' + Number(d.precoFinal).toFixed(2).replace('.', ',') : null,
                  d.loja].filter(Boolean).join(' · '),
  };

  const img = (oferta.imagens || [])[0];
  if (img?.imagemBase64) {
    const buf = Buffer.from(img.imagemBase64, 'base64');
    // Precisa ser JPEG de verdade: um buffer webp (padrao do Mercado Livre)
    // rotulado como jpegThumbnail faz o cliente descartar o card inteiro.
    const ehJpeg = buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
    if (!ehJpeg) console.log('[MKT] Thumbnail nao e JPEG (' + (img.mime || 'mime desconhecido') + ') — preview sem imagem.');
    else if (buf.length <= THUMB_MAX_BYTES) preview.jpegThumbnail = buf;
    else console.log('[MKT] Thumbnail de ' + buf.length + ' bytes acima do limite — preview sem imagem.');
  }
  return preview;
}

// Mesma ideia do montarLinkPreview, mas a partir de campos soltos: o gerador
// manual nao tem uma oferta na fila, so o produto que o operador acabou de
// consultar. A thumbnail passa pelo baixarImagemProduto para herdar a conversao
// de webp -> jpg do Mercado Livre.
async function montarLinkPreviewManual(dados) {
  const url = String(dados?.link || '').trim();
  if (!url) return null;
  const preview = {
    'canonical-url': url,
    'matched-text': url,
    title: dados.titulo || dados.loja || 'Oferta',
    description: dados.descricao || '',
  };
  if (dados.imagemUrl) {
    const img = await baixarImagemProduto(dados.imagemUrl);
    if (img?.imagemBase64) {
      const buf = Buffer.from(img.imagemBase64, 'base64');
      const ehJpeg = buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
      if (ehJpeg && buf.length <= THUMB_MAX_BYTES) preview.jpegThumbnail = buf;
    }
  }
  return preview;
}

async function enviarOfertaParaDestinos(mensagem, imagem, oferta) {
  // Sem fallback: oferta vai para os grupos marcados como DESTINO na aba
  // Grupos, e para mais nenhum. Se nao ha destino marcado, o envio falha com
  // uma mensagem que diz o que fazer — antes isso caia num grupo fixo que o
  // operador nao tinha escolhido.
  const alvos = radarDestinos();
  if (!alvos.length) throw new Error('Nenhum grupo marcado como destino na aba Grupos.');
  // Grupo so-cupons nao recebe oferta de produto, mesmo que esteja marcado
  // como destino por engano.
  const soCupons = new Set(GRUPOS['tsp_cupons']);
  const enviados = [], falhas = [];
  const preview = oferta ? montarLinkPreview(oferta, mensagem) : null;
  const op = { conta: contaDoTurno() };

  for (const jid of alvos) {
    if (soCupons.has(jid)) continue;
    try {
      await enviarMensagem(jid, preview ? { text: mensagem, linkPreview: preview } : { text: mensagem }, 0, op);
      enviados.push(jid);
      if (alvos.length > 1) await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000));
    } catch (e) {
      console.error('[MKT] Falha ao enviar em ' + jid + ':', e.message);
      falhas.push({ jid, erro: e.message });
    }
  }
  if (!enviados.length) throw new Error('Nenhum grupo recebeu a oferta.');
  // Vitrine publica: so entra o que realmente saiu em algum grupo. Chamada aqui
  // (e nao nos dois callers) para cobrir tanto o auto-envio quanto a aprovacao
  // manual pelo painel, sem risco de um dos caminhos ficar de fora.
  if (oferta) registrarPublicacao(oferta, enviados.length);
  return { enviados, falhas };
}

// ── ENVIO MANUAL PARA VARIOS GRUPOS ──────────────────────────────────────────
// Usado pelo gerador manual do painel (abas Cupom, Oferta e Livre), que manda o
// apelido 'tsp'. Cupom sai nos grupos de destino MAIS os grupos so-cupons;
// qualquer outro tipo sai so nos destinos, porque grupo so-cupons nunca recebe
// oferta de produto. Falha isolada num grupo nao derruba os outros: loga, segue
// para o proximo e avisa o operador no fim.
//
// Existe separado de enviarCupomParaGrupos/enviarOfertaParaDestinos porque a
// mensagem manual pode trazer imagem E card de link, combinacao que nao aparece
// no fluxo da fila.
async function enviarManualParaGrupos({ mensagem, tipo, imagem, preview }) {
  const ehCupom  = String(tipo || '').toLowerCase() === 'cupom';
  const destinos = radarDestinos();
  const soCupons = new Set(GRUPOS['tsp_cupons'] || []);
  const alvos = ehCupom
    ? [...new Set([...destinos, ...soCupons])]
    : destinos.filter(j => !soCupons.has(j));
  if (!alvos.length) throw new Error('Nenhum grupo marcado como destino na aba Grupos.');

  // Mesma conta em todos os grupos: alternar no meio deixaria a mesma mensagem
  // com dois remetentes no mesmo minuto.
  const op = { conta: contaDoTurno() };

  // Card de link so vale quando nao ha imagem — o WhatsApp mostra um ou outro.
  let lp = null;
  if (!imagem?.imagemBase64 && preview?.link) {
    try { lp = await montarLinkPreviewManual(preview); }
    catch (e) { console.warn('[MANUAL] Nao montou o preview:', e.message); }
  }

  const enviados = [], falhas = [];
  for (const jid of alvos) {
    try {
      if (imagem?.imagemBase64) {
        await enviarMensagem(jid, {
          image:    Buffer.from(imagem.imagemBase64, 'base64'),
          caption:  mensagem || '',
          mimetype: imagem.mime || 'image/jpeg',
        }, 0, op);
      } else {
        await enviarMensagem(jid, lp ? { text: mensagem, linkPreview: lp } : { text: mensagem }, 0, op);
      }
      enviados.push(jid);
      // Espacamento entre grupos: mesmo padrao do radar. Disparo simultaneo em
      // varios grupos e justamente o que o WhatsApp usa para achar automacao.
      if (alvos.length > 1) await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000));
    } catch (e) {
      console.error('[MANUAL] Falha ao enviar em ' + jid + ':', e.message);
      falhas.push({ jid, erro: e.message });
    }
  }

  if (!enviados.length) throw new Error('Nenhum grupo recebeu a mensagem.');
  if (falhas.length) {
    try {
      await enviarMensagem(GRUPOS.operador, { text: '*Envio manual nao entregue em ' + falhas.length + ' grupo(s)* \u26a0\ufe0f\n\n'
        + falhas.map(f => (NOMES_GRUPOS.get(f.jid) || f.jid) + ': ' + f.erro).join('\n') });
    } catch(_) {}
  }
  console.log('[MANUAL] ' + (ehCupom ? 'Cupom' : 'Oferta') + ' manual enviado em '
    + enviados.length + '/' + alvos.length + ' grupo(s).');
  return { enviados, falhas };
}

// Envia um cupom aprovado pelo gate para os grupos de cupons e marca a oferta
// como enviada. Lanca excecao se o envio principal falhar (caller decide o fallback).
async function despacharCupomAuto(oferta) {
  await enviarCupomParaGrupos(oferta.mensagemFormatada, oferta.imagens?.[0]);
  _ultimoAutoEnvio     = Date.now();
  oferta.status        = 'enviado';
  oferta.mensagemFinal = oferta.mensagemFormatada;
  oferta.autoEnviado   = true;
  delete oferta.autoAgendado;
}

// ── WORKER DE ESPACAMENTO DO AUTO-ENVIO ──────────────────────────────────────
// Cupons que passaram em TODAS as regras de conteudo mas foram bloqueados por
// motivo apenas temporal (janela de horario ou intervalo minimo entre envios)
// ficam na fila com autoAgendado=true. Este worker envia um por vez, sempre
// respeitando a janela e o intervalo de 90s. Cupons agendados ha mais de
// AUTO_ENVIO_MAX_ESPERA viram aprovacao manual (provavelmente ja venceram).
let _workerAutoRodando = false;
setInterval(async () => {
  if (AUTO_ENVIO_MODO !== 'on') return;
  if (_workerAutoRodando) return;
  _workerAutoRodando = true;
  try {
    const agora = Date.now();

    // 1. Expira agendamentos velhos → viram aprovacao manual (com o alerta de
    //    "novo cupom" que foi pulado na captura, para o operador ficar sabendo)
    for (const o of filaPendentes) {
      if (!o.autoAgendado || o.status !== 'pendente') continue;
      const ts = new Date(o.timestamp).getTime();
      if (!ts || isNaN(ts) || agora - ts <= AUTO_ENVIO_MAX_ESPERA) continue;
      delete o.autoAgendado;
      if (o.autoAvaliacao) o.autoAvaliacao.motivo += ' — prazo de auto-envio expirado, requer aprovacao manual';
      salvarFila();
      console.log(`[AUTO-FILA] Cupom #${o.id} expirou o prazo de auto-envio — caindo para aprovacao manual.`);
      try {
        await enviarMensagem(GRUPOS.operador, {
          text: '*Novo cupom capturado* ✅\n\nAprove aqui: https://davileles.github.io/tudo-sobre-promos/'
        });
      } catch(e) { console.warn('[AUTO-FILA] Falha ao avisar operador:', e.message); }
    }

    // 2. Condicoes temporais para enviar o proximo da fila
    if (!dentroDaJanelaCupom().ok) return;
    if (agora - _ultimoAutoEnvio < intervaloAutoEnvioMs()) return;
    if (!conectado || !sock) return;

    // 3. Mais antigo primeiro (ordem de captura)
    const candidatos = filaPendentes
      .filter(o => o.autoAgendado && o.status === 'pendente' && o.tipoConteudo === 'cupom_tsp')
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const oferta = candidatos[0];
    if (!oferta) return;

    const d = oferta.dadosExtraidos || {};
    const rotulo = `${nomeLojaExibicao(d.loja)} ${d.valor}${d.tipo === 'pct' ? '%' : ' R$'}${d.codigo ? ' · '+d.codigo : ''}`;

    // Marca como 'enviando' antes do await para o card sumir do painel e
    // reduzir a janela de corrida com uma aprovacao manual simultanea.
    oferta.status = 'enviando';
    try {
      await despacharCupomAuto(oferta);
      salvarFila();
      console.log(`[AUTO-FILA] Cupom #${oferta.id} ENVIADO automaticamente (espacamento) — ${rotulo}`);
      try {
        await enviarMensagem(GRUPOS.operador, {
          text: `*Cupom enviado automaticamente* 🤖\n\n${rotulo}\n\nOrigem: ${oferta.grupoOrigem || '?'}`
        });
      } catch(e) { console.warn('[AUTO-FILA] Falha ao avisar operador:', e.message); }
    } catch(err) {
      oferta.status = 'pendente';
      delete oferta.autoAgendado;
      if (oferta.autoAvaliacao) oferta.autoAvaliacao.motivo += ' — falha no envio automatico, requer aprovacao manual';
      salvarFila();
      console.error(`[AUTO-FILA] Falha no envio do cupom #${oferta.id}: ${err.message} — caindo para aprovacao manual`);
      try {
        await enviarMensagem(GRUPOS.operador, {
          text: '*Novo cupom capturado* ✅\n\nAprove aqui: https://davileles.github.io/tudo-sobre-promos/'
        });
      } catch(e) { console.warn('[AUTO-FILA] Falha ao avisar operador:', e.message); }
    }
  } finally { _workerAutoRodando = false; }
}, 15 * 1000);

// ── AVISO: FALHA NA EXTRACAO DE CUPOM ────────────────────────────────────────
// Throttle de 10 min: se a API da Anthropic cair, cada mensagem do canal viraria
// um aviso e o grupo do operador ficaria inutilizavel justo na hora do problema.
let _ultimoAvisoExtracao = 0;
const AVISO_EXTRACAO_INTERVALO_MS = 10 * 60 * 1000;

async function avisarExtracaoFalhou(texto, canal) {
  const agora = Date.now();
  if (agora - _ultimoAvisoExtracao < AVISO_EXTRACAO_INTERVALO_MS) return;
  _ultimoAvisoExtracao = agora;

  const trecho = String(texto || '').trim().slice(0, 300);
  const msg = '⚠️ *Mensagem descartada — extração falhou*\n\n'
    + '*Canal* @' + canal + '\n'
    + '*Motivo* ' + (_ultimoMotivoClaude || 'API não respondeu após 3 tentativas') + '\n\n'
    + '*Trecho*\n' + trecho + (String(texto || '').length > 300 ? '…' : '') + '\n\n'
    + 'Nenhum cupom desta mensagem entrou na base. Cadastre à mão se ainda valer. '
    + '(Avisos deste tipo são agrupados a cada 10 min.)';

  try { await enviarMensagem(GRUPOS.operador, { text: msg }); }
  catch (e) { console.error('[TG] Falha ao avisar operador sobre extração:', e.message); }
}

// ── ENFILEIRAR / DESPACHAR UM CUPOM ──────────────────────────────────────────
// Caminho unico para todo cupom, venha do Telegram ou da Awin: dedup, gravacao
// na base, gate de auto-envio e envio (ou fila). Antes isso vivia dentro do
// processador do Telegram; extrair evita que uma segunda fonte reimplemente as
// mesmas regras de seguranca com sutis diferencas.
// Ativa na conta do ML um cupom recem-capturado, como o botao "Inserir codigo"
// da pagina de cupons. Chamada sem await de proposito: o envio aos grupos nao
// pode depender do ML responder.
//
// Recusa NAO desativa o cupom aqui. Essa decisao continua com o sync horario,
// que tem a pagina inteira como contexto — uma resposta isolada pode ser rate
// limit ou cupom segmentado, e desativar na captura derrubaria oferta valida.
function ativarCupomCapturadoMl(c, reg) {
  if (!c || c.loja !== 'Mercado Livre' || !c.codigo) return;
  if (!tokenAffOk()) return;
  ativarCupomMl(c.codigo).then(r => {
    if (r.ok || r.jaTinha) {
      // Marca o que o sync usa para nao tratar o cupom como "nunca ativado".
      if (reg?.chave) { try { atualizarCupomBase(reg.chave, { confirmadoNoMl: true }); } catch(e) {} }
      console.log('[CUPONS-ML] ' + c.codigo + (r.jaTinha ? ' ja estava na conta.' : ' ativado na conta na captura.'));
    } else if (r.esgotado) {
      console.warn('[CUPONS-ML] ' + c.codigo + ' ja esgotado no ML na captura — ' +
        'o sync horario decide se desativa.');
    } else if (r.invalido) {
      console.warn('[CUPONS-ML] ' + c.codigo + ' recusado pelo ML na captura: ' +
        (r.mensagem || 'sem detalhe') + ' — o sync horario decide se desativa.');
    } else if (r.payloadRejeitado) {
      console.error('[CUPONS-ML] ' + c.codigo + ': INVALID_6 na captura — o formato do ' +
        'input-code mudou de novo. Nenhum cupom esta entrando na conta.');
    } else {
      console.warn('[CUPONS-ML] Resposta inesperada ao ativar ' + c.codigo + ' na captura: ' +
        (r.mensagem || r.status));
    }
  }).catch(e => console.warn('[CUPONS-ML] Falha ao ativar ' + c.codigo + ' na captura: ' + e.message));
}

async function enfileirarCupomTSP(c, ctx = {}) {
  const {
    origem = 'desconhecida',
    textoOriginal = '',
    imagens = [],
    tinhaMultiplos = false,
    codigosLista = [],
    somenteFila = false,
  } = ctx;

  const mensagemFormatada = formatarCupomTSP(c);
  const oferta = {
    id: gerarId(),
    timestamp: new Date().toISOString(),
    grupoOrigem: origem,
    tipoConteudo: 'cupom_tsp',
    conteudoOriginal: textoOriginal,
    imagens,
    mensagemFormatada,
    dadosExtraidos: c,
    status: 'pendente',
    tenant: tenantContexto() || TENANT_PADRAO,
  };

  // Verificar deduplicação: ignorar se o mesmo cupom já foi visto recentemente
  if (cupomJaVisto(c)) {
    console.log(`[DEDUP] Cupom ignorado (duplicata): ${c.loja} | ${c.codigo || 'sem código'}`);
    return { ignorado: true, motivo: 'duplicata' };
  }

  // Registra ANTES de qualquer envio: se o envio falhar preferimos perder um
  // cupom a arriscar mandar duplicado quando o outro canal repostar.
  registrarCupomVisto(c);
  // Mesmo ponto, mesma garantia: o cupom entra na base antes de qualquer
  // envio, para ja estar disponivel quando uma oferta do radar chegar.
  let regBase = null;
  try { regBase = registrarCupomBase(c); } catch(e) { console.warn('[CUPONS] Falha ao gravar na base:', e.message); }
  // Cupom capturado de grupo so vale nas SUAS compras depois de ativado na
  // conta. O sync horario ja faz isso, mas ate ele rodar o cupom fica anunciado
  // sem estar aplicavel. Aqui a janela fecha na hora — sem await, porque o
  // disparo nos grupos nao pode esperar pelo ML nem falhar por causa dele.
  ativarCupomCapturadoMl(c, regBase);

  const veredito = avaliarAutoEnvio(c, textoOriginal, tinhaMultiplos, codigosLista);
  const rotulo   = `${nomeLojaExibicao(c.loja)} ${c.valor}${c.tipo === 'pct' ? '%' : ' R$'}${c.codigo ? ' · '+c.codigo : ''}`;

  // Veredito fica gravado na oferta para aparecer no card da fila (o log do
  // Railway sozinho nao serve: em modo sombra o operador precisa comparar a
  // decisao do gate com a propria aprovacao manual, cupom a cupom.
  oferta.autoAvaliacao = {
    auto: veredito.auto,
    motivo: veredito.motivo,
    modo: AUTO_ENVIO_MODO,
    avaliadoEm: new Date().toISOString(),
  };

  // Bloqueio APENAS temporal (janela/intervalo): todas as regras de conteudo
  // passaram. Em modo 'on', em vez de exigir aprovacao manual, o cupom entra
  // agendado e o worker de espacamento envia quando a condicao liberar.
  const bloqueioTemporal = !veredito.auto && /^(fora da janela|intervalo minimo)/.test(veredito.motivo);
  if (AUTO_ENVIO_MODO === 'on' && bloqueioTemporal && !somenteFila) oferta.autoAgendado = true;

  // MODO SOMBRA: decide e loga, mas nao envia. Serve para medir a taxa de
  // acerto do gate contra a aprovacao manual antes de ligar 'on'.
  if (AUTO_ENVIO_MODO === 'sombra') {
    console.log(`[AUTO-SOMBRA] ${veredito.auto ? 'ENVIARIA' : 'BLOQUEADO'} — ${rotulo} — ${veredito.motivo}`);
  }

  if (AUTO_ENVIO_MODO === 'on' && veredito.auto && !somenteFila) {
    try {
      await despacharCupomAuto(oferta);
      filaPendentes.unshift(oferta);
      salvarFila();
      console.log(`[AUTO] Cupom #${oferta.id} ENVIADO automaticamente — ${rotulo}`);
      try {
        await enviarMensagem(GRUPOS.operador, {
          text: `*Cupom enviado automaticamente* 🤖\n\n${rotulo}\n\nOrigem: ${origem}`
        });
      } catch(e) { console.warn('[AUTO] Falha ao avisar operador:', e.message); }
      return { oferta, veredito, enviado: true };
    } catch(err) {
      // Falha no envio: cai para a fila manual em vez de perder o cupom.
      console.error(`[AUTO] Falha no envio automatico, caindo para fila: ${err.message}`);
    }
  }

  filaPendentes.unshift(oferta);
  salvarFila();
  console.log(`[FILA] Cupom #${oferta.id} adicionado à fila — ${rotulo} (${veredito.motivo}) — origem ${origem}`);

  // Cupom agendado para auto-envio: sem alerta de aprovacao — o worker de
  // espacamento avisa o operador quando de fato enviar (ou se expirar).
  if (oferta.autoAgendado) {
    console.log(`[AUTO-FILA] Cupom #${oferta.id} agendado para auto-envio com espacamento.`);
    return { oferta, veredito, agendado: true };
  }

  // Alerta de novo cupom no grupo do operador
  try {
    await enviarMensagem(GRUPOS.operador, {
      text: '*Novo cupom capturado* ✅\n\nAprove aqui: https://davileles.github.io/tudo-sobre-promos/'
    });
  } catch(e) { console.warn('[FILA] Falha ao enviar alerta de cupom:', e.message); }

  return { oferta, veredito, enviado: false };
}

// ── PROCESSAR MENSAGEM DO TELEGRAM ────────────────────────────────────────────
// Serializacao: o gate de dedup so roda DEPOIS da chamada a Anthropic (1-3s).
// Sem mutex, o mesmo cupom chegando pelos dois canais com poucos segundos de
// diferenca passa duas vezes pelo gate — e com auto-envio isso vira mensagem
// duplicada no grupo de clientes. Uma cadeia de promises basta (processo unico).
let _tgChain = Promise.resolve();

function processarMensagemTelegram(texto, canalUsername = 'desconhecido', imagemBase64 = null) {
  _tgChain = _tgChain
    .then(() => _processarMensagemTelegram(texto, canalUsername, imagemBase64))
    .catch(e => console.error('[TG] Erro na cadeia:', e.message));
  return _tgChain;
}

async function _processarMensagemTelegram(texto, canalUsername = 'desconhecido', imagemBase64 = null) {
  if (!texto?.trim()) return;
  console.log('[TG] Nova mensagem recebida:', texto.slice(0, 80));

  try {
    const campos = await extrairCupomTelegram(texto);

    // Distinguir os dois casos e o ponto todo: 'eh_cupom: false' e uma decisao
    // (a mensagem nao era cupom); null e uma FALHA (API fora, JSON invalido,
    // resposta truncada). O segundo caso jogava a mensagem fora em silencio,
    // e uma lista com 8 cupons sumia sem deixar rastro nenhum.
    if (!campos) {
      console.error('[TG] Extração falhou — mensagem descartada:', texto.slice(0, 120));
      avisarExtracaoFalhou(texto, canalUsername).catch(() => {});
      return;
    }
    if (!campos.eh_cupom) {
      console.log('[TG] Não é cupom, ignorado.');
      return;
    }

    console.log(`[TG] Cupom identificado: ${campos.loja} | ${campos.valor}${campos.tipo === 'pct' ? '%' : ' R$'}`);

    const tinhaMultiplos = !!campos.multiplos?.length;
    const lista = tinhaMultiplos
      ? campos.multiplos.map(m => ({ ...campos, valor: m.valor, minimo: m.minimo ?? null, codigo: m.codigo ?? campos.codigo, tipo: m.tipo ?? campos.tipo, limite: m.limite ?? campos.limite ?? null, maximo: m.maximo ?? campos.maximo ?? null, multiplos: null }))
      : [campos];
    const codigosLista = lista.map(x => x.codigo).filter(Boolean);

    // try/catch POR ITEM: antes um cupom que estourasse derrubava o catch geral
    // e os seguintes da mesma mensagem nunca eram processados — perda silenciosa
    // proporcional ao tamanho da lista.
    for (const c of lista) {
      try {
        await enfileirarCupomTSP(c, {
          origem: `telegram:@${canalUsername}`,
          textoOriginal: texto,
          imagens: imagemBase64 ? [{ imagemBase64, mime: 'image/jpeg' }] : [],
          tinhaMultiplos, codigosLista,
        });
      } catch (e) {
        console.error(`[TG] Falha no cupom ${c.codigo || 'sem código'} (${c.loja}): ${e.message} — seguindo para o próximo.`);
      }
    }

  } catch(err) {
    console.error('[TG] Erro ao processar cupom:', err.message);
  }
}

// ── TELEGRAM CLIENT ───────────────────────────────────────────────────────────
const TG_API_ID   = parseInt(process.env.TG_API_ID   || '0');
const TG_API_HASH = process.env.TG_API_HASH || '';
const TG_SESSION_PATH = SESSAO_DIR + '/telegram_session.txt';
const TG_CANAIS_MONITORADOS = (process.env.TG_GRUPO || '@juaocupons,@canaldetestetsp').split(',').map(s => s.trim().replace('@','').toLowerCase());
// Blacklist: channelIds numéricos ou substrings de title/username a ignorar (separados por vírgula).
// TG_CANAIS_IGNORADOS_BASE fica no código para canais que nunca devem ser capturados,
// independente do que esteja configurado no Railway. O modo de captura é GERAL
// (aceita qualquer chat da conta), então só a blacklist impede a captura.
const TG_CANAIS_IGNORADOS_BASE = ['bugmundodasmilhas'];
// Funcao (nao const) para a lista da aba Configuracoes valer na hora, sem
// restart. Env e base do codigo continuam somando — nunca substituindo.
function TG_CANAIS_IGNORADOS_RAW() {
  return [...new Set([
    ...TG_CANAIS_IGNORADOS_BASE,
    ...(process.env.TG_CANAIS_IGNORADOS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    ...tgIgnoradosConfig(),
  ])];
}

let tgClient = null;
let tgConectado = false;

let tgAuthState = null;
let tgConta = null;
let tgAuthResolve = null;
let tgAuthReject  = null;
let tgAuthValor   = null;

async function iniciarTelegram() {
  if (!TG_API_ID || !TG_API_HASH) {
    console.log('[TG] TG_API_ID ou TG_API_HASH não configurados. Monitor Telegram desativado.');
    return;
  }

  const sessionStr = existsSync(TG_SESSION_PATH)
    ? readFileSync(TG_SESSION_PATH, 'utf-8').trim()
    : '';

  const session = new StringSession(sessionStr);

  tgClient = new TelegramClient(session, TG_API_ID, TG_API_HASH, {
    connectionRetries: 5,
    receiveUpdates: true,
    floodSleepThreshold: 60,
  });

  await tgClient.start({
    phoneNumber: () => new Promise((resolve, reject) => {
      console.log('[TG] Aguardando número de telefone via /tg-auth...');
      tgAuthState = 'aguardando_telefone';
      tgAuthResolve = resolve;
      tgAuthReject  = reject;
    }),
    password: () => new Promise((resolve, reject) => {
      console.log('[TG] Aguardando senha 2FA via /tg-auth...');
      tgAuthState = 'aguardando_senha';
      tgAuthResolve = resolve;
      tgAuthReject  = reject;
    }),
    phoneCode: () => new Promise((resolve, reject) => {
      console.log('[TG] Aguardando código de verificação via /tg-auth...');
      tgAuthState = 'aguardando_codigo';
      tgAuthResolve = resolve;
      tgAuthReject  = reject;
    }),
    onError: (err) => {
      console.error('[TG] Erro de autenticação:', err.message);
      tgAuthState = 'erro';
    },
  });

  const sessionSalva = tgClient.session.save();
  writeFileSync(TG_SESSION_PATH, sessionSalva, 'utf-8');
  tgConectado = true;
  tgAuthState = 'ok';
  tgConta = await tgClient.getMe().then(u => ({ id: u.id?.toString(), username: u.username || null, phone: u.phone || null, nome: ((u.firstName||'')+' '+(u.lastName||'')).trim() })).catch(() => null);
  // Sincronizar diálogos para garantir recebimento de updates de todos os canais seguidos
  try {
    const dialogs = await tgClient.getDialogs({ limit: 500 });
    console.log(`[TG] ${dialogs.length} diálogos sincronizados`);
  } catch(e) { console.warn('[TG] Falha ao sincronizar diálogos:', e.message); }

  // Forçar acesso explícito aos canais monitorados via getMessages — ativa recebimento de updates
  // Só getInputEntity não é suficiente; é preciso acessar histórico para o MTProto liberar updates
  for (const canal of TG_CANAIS_MONITORADOS) {
    try {
      const ent = await tgClient.getInputEntity(canal);
      const cid = (ent?.channelId ?? ent?.chatId ?? ent?.userId)?.toString();
      // Buscar última mensagem para registrar o canal como "acessado" no MTProto
      await tgClient.getMessages(ent, { limit: 1 });
      console.log(`[TG] Canal monitorado ativo: @${canal} → channelId=${cid}`);
    } catch(e) { console.warn(`[TG] Falha ao ativar canal monitorado @${canal}: ${e.message}`); }
  }

  // Resolver blacklist para channelIds numéricos
  const _ignoradosIds = new Set();
  for (const termo of TG_CANAIS_IGNORADOS_RAW()) {
    if (/^\d+$/.test(termo)) { _ignoradosIds.add(termo); continue; } // já é um ID
    try {
      const ent = await tgClient.getInputEntity(termo).catch(() => null);
      const cid = ent && (ent.channelId ?? ent.chatId ?? ent.userId)?.toString();
      if (cid) { _ignoradosIds.add(cid); console.log(`[TG] Blacklist resolvido "${termo}" → channelId=${cid}`); }
    } catch(e) { /* termo será comparado por título em runtime */ }
  }
  console.log(`[TG] Conectado! Modo: captura geral | Blacklist: ${TG_CANAIS_IGNORADOS_RAW().join(', ') || 'nenhum'}`);

  // ── KEEPALIVE: mantém sessão ativa para o servidor TG continuar entregando updates ──
  // Sem isso, sessões inativas perdem updates de canais broadcast após alguns minutos
  const _keepaliveInterval = setInterval(async () => {
    try {
      await tgClient.invoke(new Api.updates.GetState());
    } catch(e) {
      console.warn('[TG] Keepalive falhou:', e.message);
    }
  }, 30000); // a cada 30 segundos

  // Cache de deduplicação: evita processar mesma mensagem duas vezes (NewMessage + Polling)
  const _msgProcessadas = new Map(); // chave: "channelId:msgId" → timestamp
  const MSG_DEDUP_TTL = 10 * 60 * 1000; // 10 minutos (cobre janela do polling)

  // ── POLLING de segurança: busca últimas msgs dos canais monitorados a cada 5 min ──
  // Garante captura mesmo se algum update MTProto for perdido
  const _ultimosMsgIds = {}; // channelId → último msgId processado
  const _pollingInterval = setInterval(async () => {
    for (const canal of TG_CANAIS_MONITORADOS) {
      try {
        const ent = await tgClient.getInputEntity(canal);
        // 20 e nao 5: o canal posta em rajada e, com update MTProto perdido, o
        // que passar de 5 numa janela de 60s sumia sem rastro. O corte real e
        // o _ultimosMsgIds abaixo, entao ler mais so custa uma chamada maior.
        const msgs = await tgClient.getMessages(ent, { limit: 20 });
        const cid = (ent?.channelId ?? ent?.chatId ?? ent?.userId)?.toString();
        for (const msg of msgs.reverse()) { // do mais antigo ao mais novo
          if (!msg.message?.trim()) continue;
          const ultimoId = _ultimosMsgIds[cid] || 0;
          if (msg.id <= ultimoId) continue; // já processado
          _ultimosMsgIds[cid] = msg.id;
          // Verificar blacklist
          const bloqueado = _ignoradosIds.has(cid) ||
            TG_CANAIS_IGNORADOS_RAW().some(t => canal.includes(t));
          if (bloqueado) continue;
          // Checar deduplicação — evita reprocessar msg já capturada pelo NewMessage
          const dedupKeyPolling = `${cid}:${msg.id}`;
          if (_msgProcessadas.has(dedupKeyPolling)) continue;
          _msgProcessadas.set(dedupKeyPolling, Date.now());
          console.log(`[TG] Polling ACEITA @${canal} msgId=${msg.id}: ${msg.message.slice(0,60)}`);
          await processarMensagemTelegram(msg.message, canal, null);
        }
      } catch(e) { /* silencioso — canal pode estar temporariamente inacessível */ }
    }
  }, 60 * 1000); // a cada 1 minuto

  // Handler principal: NewMessage captura UpdateNewMessage + UpdateNewChannelMessage de forma normalizada
  tgClient.addEventHandler(async (event) => {
    try {
      const msg = event.message;
      if (!msg) return;

      // Resolver identidade do canal remetente
      const peerId = msg.peerId;
      const peerChannelId = (peerId?.channelId ?? peerId?.chatId ?? peerId?.userId)?.toString();
      const entity = await tgClient.getEntity(peerId).catch(() => null);
      const username = (entity?.username || '').toLowerCase();
      const title    = (entity?.title    || '').toLowerCase();

      // Verificar blacklist: por channelId numérico OU substring de title/username
      const bloqueadoPorId   = peerChannelId && _ignoradosIds.has(peerChannelId);
      const bloqueadoPorNome = TG_CANAIS_IGNORADOS_RAW().some(t => username.includes(t) || title.includes(t));
      if (bloqueadoPorId || bloqueadoPorNome) {
        console.log(`[TG] BLOQUEADO (blacklist) channelId=${peerChannelId} username="${username}" title="${title}"`);
        return;
      }

      // Deduplicação por messageId — evita processar mesma msg de canais espelhados
      const dedupKey = `${peerChannelId}:${msg.id}`;
      const agora = Date.now();
      for (const [k, ts] of _msgProcessadas) { if (agora - ts > MSG_DEDUP_TTL) _msgProcessadas.delete(k); }
      if (_msgProcessadas.has(dedupKey)) {
        console.log(`[TG] DUPLICATA ignorada channelId=${peerChannelId} msgId=${msg.id}`);
        return;
      }
      _msgProcessadas.set(dedupKey, agora);

      console.log(`[TG] Mensagem ACEITA channelId=${peerChannelId} username="${username}" title="${title}"`);

      const texto = msg.message || '';
      if (!texto.trim()) return;

      // Tentar baixar mídia se existir
      let imagemBase64 = null;
      if (msg.media) {
        try {
          const buffer = await tgClient.downloadMedia(msg, {});
          if (buffer) imagemBase64 = buffer.toString('base64');
          console.log('[TG] Mídia capturada:', buffer?.length, 'bytes');
        } catch(e) { console.warn('[TG] Falha ao baixar mídia:', e.message); }
      }

      console.log('[TG] Nova mensagem:', texto.slice(0, 80));
      await processarMensagemTelegram(texto, username, imagemBase64);
    } catch (err) { console.error('[TG] Erro no handler NewMessage:', err.message); }
  }, new NewMessage({}));
}

iniciarTelegram().catch(err => {
  console.error('[TG] Falha ao iniciar:', err.message);
  tgAuthState = 'erro';
});

// ── TELEGRAM POR OPERADOR (fase 2.4b) ────────────────────────────────────────
// Cada operador conecta a PROPRIA conta do Telegram (app api_id/api_hash da
// plataforma, compartilhado). A captura roda no contexto do dono da sessao:
// config, links, fila, auto-envio e WhatsApp — tudo dele, com o isolamento de
// envio da fase 2.4a garantindo que nada sai pelo numero de outro.
const tgTenants = new Map();
function tgEstadoTenant(id) {
  if (!tgTenants.has(id)) tgTenants.set(id, {
    id, client: null, conectado: false, authState: null, conta: null,
    resolve: null, reject: null, erro: null, iniciando: false,
  });
  return tgTenants.get(id);
}
function tgSessionPathTenant(id) {
  const dir = SESSAO_DIR + '/tenants/' + id;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir + '/telegram_session.txt';
}

async function iniciarTelegramTenant(tenantId) {
  const st = tgEstadoTenant(tenantId);
  if (st.iniciando || st.conectado) return st;
  if (!TG_API_ID || !TG_API_HASH) { st.erro = 'app Telegram da plataforma nao configurado'; return st; }
  st.iniciando = true; st.erro = null;
  try {
    const p = tgSessionPathTenant(tenantId);
    const session = new StringSession(existsSync(p) ? readFileSync(p, 'utf-8').trim() : '');
    const client = new TelegramClient(session, TG_API_ID, TG_API_HASH, {
      connectionRetries: 5, receiveUpdates: true, floodSleepThreshold: 60,
    });
    st.client = client;
    await client.start({
      phoneNumber: () => new Promise((res, rej) => { st.authState = 'aguardando_telefone'; st.resolve = res; st.reject = rej; }),
      phoneCode:   () => new Promise((res, rej) => { st.authState = 'aguardando_codigo';   st.resolve = res; st.reject = rej; }),
      password:    () => new Promise((res, rej) => { st.authState = 'aguardando_senha';    st.resolve = res; st.reject = rej; }),
      onError: (e) => { st.authState = 'erro'; st.erro = e.message; },
    });
    writeFileSync(p, client.session.save(), 'utf-8');
    st.conectado = true; st.authState = 'ok';
    st.conta = await client.getMe()
      .then(u => ({ id: u.id?.toString(), username: u.username || null, phone: u.phone || null }))
      .catch(() => null);
    try { await client.getDialogs({ limit: 500 }); } catch {}
    setInterval(async () => { try { await client.invoke(new Api.updates.GetState()); } catch {} }, 30000);

    const vistos = new Map();
    client.addEventHandler(async (event) => {
      try {
        const msg = event.message; if (!msg) return;
        const texto = msg.message || ''; if (!texto.trim()) return;
        const peerId = msg.peerId;
        const cid = (peerId?.channelId ?? peerId?.chatId ?? peerId?.userId)?.toString();
        const ent = await client.getEntity(peerId).catch(() => null);
        const username = (ent?.username || '').toLowerCase();
        const title    = (ent?.title    || '').toLowerCase();
        // Blacklist do OPERADOR (config dele) + base do codigo.
        const bloq = [...new Set([...TG_CANAIS_IGNORADOS_BASE, ...tgIgnoradosConfig(tenantId)])];
        if (bloq.some(t => (/^\d+$/.test(t) && t === cid) || (t && (username.includes(t) || title.includes(t))))) return;
        const k = cid + ':' + msg.id;
        const agora = Date.now();
        for (const [kk, ts] of vistos) if (agora - ts > 10 * 60 * 1000) vistos.delete(kk);
        if (vistos.has(k)) return;
        vistos.set(k, agora);
        let imagemBase64 = null;
        if (msg.media) {
          try { const b = await client.downloadMedia(msg, {}); if (b) imagemBase64 = b.toString('base64'); } catch {}
        }
        console.log('[TG:' + tenantId + '] captura de "' + (username || title) + '": ' + texto.slice(0, 60));
        await comContextoTenant(tenantId, () => processarMensagemTelegram(texto, username || title, imagemBase64));
      } catch (e) { console.error('[TG:' + tenantId + '] erro no handler:', e.message); }
    }, new NewMessage({}));
    console.log('[TG:' + tenantId + '] conectado.');
  } catch (e) {
    st.erro = e.message; st.authState = 'erro';
    console.error('[TG:' + tenantId + '] falha:', e.message);
  }
  st.iniciando = false;
  return st;
}

// Boot: religa os operadores que ja tem sessao salva (15s apos subir, para o
// resto do servidor estar de pe).
setTimeout(() => {
  for (const t of listarTenants()) {
    if (t.id === TENANT_PADRAO || t.ativo === false) continue;
    try {
      const p = SESSAO_DIR + '/tenants/' + t.id + '/telegram_session.txt';
      if (existsSync(p) && readFileSync(p, 'utf-8').trim()) iniciarTelegramTenant(t.id).catch(() => {});
    } catch {}
  }
}, 15000);

// ── GRUPOS COM REGRAS ESPECIAIS DE EXTRAÇÃO ───────────────────────────────────
const GRUPO_APENAS_IMAGEM = '120363430801699326@g.us';
const GRUPO_EXECUTIVA     = '120363410708080270@g.us';
const GRUPOS_TEXTO_ESTRUTURADO = new Set([
  '120363229600818869@g.us',
  '120363298361885116@g.us',
  '120363301488379027@g.us',
  '120363230402728347@g.us',
  '120363229682219999@g.us',
  '120363212151306916@g.us',
  '120363318399199070@g.us',
  '120363230586056001@g.us',
  '120363211235070904@g.us',
]);

const SYSTEM_CDV = 'Voce e especialista em passagens aereas com milhas para o mercado brasileiro. Seja GENEROSO: qualquer mencao a rota aerea, milhas/pontos, programa de fidelidade ou companhia aerea deve ser valido. Responda APENAS JSON sem markdown.';
const PROGRAMAS_VALIDOS = 'Programa deve ser um destes: Smiles, Azul Fidelidade, Azul pelo Mundo, LATAM Pass, Iberia Plus, Privilege Club, Executive Club, TAP, AAdvantage, SUMA, Flying Club, Finnair Plus, Aeroplan.\nIMPORTANTE: TudoAzul = Azul Fidelidade. Tudo Azul = Azul Fidelidade. LatamPass = LATAM Pass.\nCabine deve ser exatamente "Economica" ou "Executiva".'
  + '\nREGRAS DE COMPANHIA AEREA (campo "cia"):'
  + '\n- "SAA" ou "South African Airways" deve ser sempre gravado como "South African".'
  + '\n- Voo NACIONAL dentro do Brasil (origem E destino brasileiros): a cia segue o programa — Smiles = "GOL"; Azul Fidelidade/TudoAzul = "Azul"; LATAM Pass = "LATAM". Nunca use outra cia nesses casos.'
  + '\n- Voo INTERNACIONAL: identifique a companhia aerea OPERADORA ("cia") lendo o texto e principalmente a IMAGEM quando houver — screenshots da Smiles mostram o nome da cia (ex: "AIR FRANCE"). Preencha "cia" apenas com o que estiver visivel na fonte; NUNCA deduza a cia a partir do programa (Smiles NAO implica GOL em voo internacional). Se nao estiver visivel, deixe "cia" vazia.'
  + '\n- Defina tipoVoo="nacional" sempre que origem e destino forem cidades brasileiras.';

// ── DE-PARA: programa → CIA operadora (para voos nacionais BR e fallback) ─────
const CIA_POR_PROGRAMA = {
  'Smiles':           'GOL',
  'Azul Fidelidade':  'Azul',
  'Azul':             'Azul',
  'TudoAzul':         'Azul',
  'LATAM Pass':       'LATAM',
};

// ── DE-PARA: destino internacional Smiles → parceira típica ──────────────────
// Fallback usado APENAS quando a fonte não informa a cia em voo internacional
// do programa Smiles. Chaves: código IATA ou nome de cidade normalizado
// (maiúsculas, sem acento). Nunca inclui destinos que a GOL também opera
// (EUA, Buenos Aires etc.) para evitar atribuição errada.
const CIA_SMILES_POR_DESTINO = {
  'CDG':'Air France', 'ORY':'Air France', 'PARIS':'Air France',
  'AMS':'KLM', 'AMSTERDA':'KLM', 'AMSTERDAM':'KLM',
  'MAD':'Air Europa', 'MADRI':'Air Europa', 'MADRID':'Air Europa',
  'BOG':'Avianca', 'BOGOTA':'Avianca',
  'MDE':'Avianca', 'MEDELLIN':'Avianca',
  'PTY':'COPA', 'PANAMA':'COPA', 'CIDADE DO PANAMA':'COPA',
  'DXB':'Emirates', 'DUBAI':'Emirates',
  'IST':'Turkish', 'ISTAMBUL':'Turkish', 'ISTANBUL':'Turkish',
  'ADD':'Ethiopian', 'ADIS ABEBA':'Ethiopian',
};

function chaveDestinoSmiles(s) {
  return String(s == null ? '' : s)
    .toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── NORMALIZAÇÃO DE NOME DE CIA (siglas e variações → nome canônico) ──────────
const ALIAS_CIA = {
  'saa':'South African', 'south african airways':'South African', 'south african':'South African',
  'sa':'South African',
  'gol':'GOL', 'gol linhas aereas':'GOL', 'g3':'GOL', 'voegol':'GOL',
  'azul':'Azul', 'azul linhas aereas':'Azul', 'ad':'Azul', 'voeazul':'Azul',
  'latam':'LATAM', 'latam airlines':'LATAM', 'tam':'LATAM', 'la':'LATAM',
  'aa':'American Airlines', 'american':'American Airlines', 'american airlines':'American Airlines',
  'tap':'TAP', 'tap air portugal':'TAP', 'tp':'TAP',
  'af':'Air France', 'air france':'Air France',
  'kl':'KLM', 'klm':'KLM', 'klm royal dutch airlines':'KLM',
  'ba':'British Airways', 'british':'British Airways', 'british airways':'British Airways',
  'ib':'Iberia', 'iberia':'Iberia',
  'cm':'COPA', 'copa':'COPA', 'copa airlines':'COPA',
  'ua':'United', 'united':'United', 'united airlines':'United',
  'dl':'Delta', 'delta':'Delta', 'delta air lines':'Delta',
  'tk':'Turkish', 'turkish':'Turkish', 'turkish airlines':'Turkish',
  'qr':'Qatar Airways', 'qatar':'Qatar Airways', 'qatar airways':'Qatar Airways',
  'ek':'Emirates', 'emirates':'Emirates',
  'ay':'Finnair', 'finnair':'Finnair',
  'lh':'Lufthansa', 'lufthansa':'Lufthansa',
  'ux':'Air Europa', 'air europa':'Air Europa',
  'ar':'Aerolineas Argentinas', 'aerolineas':'Aerolineas Argentinas', 'aerolineas argentinas':'Aerolineas Argentinas',
  'av':'Avianca', 'avianca':'Avianca',
  'et':'Ethiopian', 'ethiopian':'Ethiopian', 'ethiopian airlines':'Ethiopian',
  'ac':'Air Canada', 'air canada':'Air Canada',
  'sq':'Singapore Airlines', 'singapore':'Singapore Airlines', 'singapore airlines':'Singapore Airlines',
  'a3':'Aegean', 'aegean':'Aegean', 'aegean airlines':'Aegean',
  'ib plus':'Iberia', 'iberia express':'Iberia',
  'vs':'Virgin Atlantic', 'virgin atlantic':'Virgin Atlantic',
  'af/klm':'Air France', 'airfrance':'Air France',
};

function normalizarCia(cia) {
  const bruto = String(cia == null ? '' : cia).trim();
  if (!bruto) return bruto;
  const chave = bruto
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[.]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return ALIAS_CIA[chave] || bruto;
}

// Aeroportos brasileiros com voo comercial (lista ampla — evita classificar
// voo nacional como internacional só porque o IATA não estava mapeado)
const IATAS_BR = new Set([
  // Sudeste
  'GRU','CGH','VCP','GIG','SDU','CNF','PLU','VIX','RAO','SJP','SJK','BAU','ARU',
  'MII','PPB','UBA','UDI','IPN','MOC','GVR','POJ','JDF','VAG','AAX','DIQ','SOD',
  'QSC','RVD','JTC','MEA','ITR','CAW','MOC',
  // Sul
  'CWB','POA','FLN','NVT','JOI','IGU','MGF','LDB','CAC','XAP','CXJ','PFB','PET',
  'BGX','URG','LAJ','CCM','JJG','CFC','SQX','PTO','TOW','RIA','GEL','ERM','CBW',
  // Centro-Oeste
  'BSB','CGB','CGR','GYN','CLV','ROO','OPS','DOU','CMG','AFL','BAT','TJL','SIN',
  'AQA','MTG',
  // Nordeste
  'SSA','REC','FOR','NAT','MCZ','AJU','JPA','SLZ','THE','IOS','BPS','JDO','PNZ',
  'PHB','CPV','JJD','FEN','LEC','VDC','MVF','BRA','GNM','PTZ','TMT','JDR','ARS',
  'IMP','PIN','STZ','CZB','SSZ','FLB','BVM','PDF',
  // Norte
  'MAO','BEL','STM','MCP','PVH','RBR','BVB','PMW','MAB','ATM','TBT','CZS','TFF',
  'JPR','CAF','SJL','OAL','ITB','ERN','TMT','RBB','HUW','LBR','MNX','PIN','ALT',
  'AUX','GRP','PBQ','TUR','SXX','APQ',
]);

function corrigirCia(cia, programa, origemCodigo, destinoCodigo, tipoVoo, destinoNome) {
  const oc   = String(origemCodigo  || '').toUpperCase().trim();
  const dc   = String(destinoCodigo || '').toUpperCase().trim();
  const tipo = String(tipoVoo || '').toLowerCase();

  const internacionalIA = /internacion/.test(tipo);
  // "internacional" contém "nacional" — por isso o teste de internacional vem primeiro
  const nacionalIA      = !internacionalIA && /nacion|domest/.test(tipo);

  const oriBR  = oc ? IATAS_BR.has(oc) : null;
  const destBR = dc ? IATAS_BR.has(dc) : null;

  let isDomestico;
  if (oriBR === true && destBR === true) {
    // Ambos os IATAs reconhecidos como brasileiros → nacional
    isDomestico = true;
  } else if (nacionalIA && (oriBR === true || destBR === true || (oriBR === null && destBR === null))) {
    // A fonte diz que é nacional e nada contradiz (IATA BR fora da lista, p.ex.)
    isDomestico = true;
  } else if (oriBR === null && destBR === null) {
    // Sem códigos IATA: assume nacional salvo se a fonte disser internacional
    isDomestico = !internacionalIA;
  } else {
    isDomestico = false;
  }

  // Nacional BR: o programa determina a operadora
  // (Smiles→GOL, Azul Fidelidade→Azul, LATAM Pass→LATAM)
  if (isDomestico && CIA_POR_PROGRAMA[programa]) {
    return normalizarCia(CIA_POR_PROGRAMA[programa]);
  }
  // Internacional com CIA explícita na fonte (ex: Air France, Turkish) — respeita
  if (cia && cia !== programa) return normalizarCia(cia);
  // Doméstico sem CIA identificada: programa determina a operadora
  if (isDomestico) return normalizarCia(CIA_POR_PROGRAMA[programa] || cia);
  // Internacional Smiles sem CIA: a GOL quase não voa internacional —
  // tenta a parceira típica do destino; senão, "Desconhecida" (nunca GOL).
  if (programa === 'Smiles') {
    const porDestino = CIA_SMILES_POR_DESTINO[dc] || CIA_SMILES_POR_DESTINO[chaveDestinoSmiles(destinoNome)];
    return porDestino || 'Desconhecida';
  }
  // Demais programas (LATAM Pass, Azul Fidelidade): a própria cia do programa
  // opera amplamente voos internacionais — mantém o comportamento anterior.
  return normalizarCia(CIA_POR_PROGRAMA[programa] || cia || 'Desconhecida');
}

// ── FALLBACK: cia nao consta no texto → le APENAS a companhia na imagem ───────
// Grupos de texto estruturado ignoram a imagem por design (o texto e a fonte
// canonica de rota/programa/milhas), mas a cia OPERADORA quase nunca esta no
// texto e costuma estar impressa no screenshot ("GOL LINHAS AEREAS").
// Nesses casos corrigirCia() devolve 'Desconhecida' e a oferta sai sem cia.
// Nao da para deduzir pelo destino: a Smiles emite em varias parceiras que
// servem a mesma rota (EZE = GOL, Aerolineas, Emirates, Turkish; MIA = GOL e
// American). So a leitura da imagem resolve — chamada curta, disparada apenas
// quando a cia ficou desconhecida E existe imagem.
async function ciaPelaImagem(imagemBase64, rotaDesc) {
  if (!imagemBase64) return null;
  const content = [
    { type:'image', source:{ type:'base64', media_type:'image/jpeg', data:imagemBase64 } },
    { type:'text', text:
      'Este screenshot e de uma busca de passagem aerea com milhas'+(rotaDesc ? ' ('+rotaDesc+')' : '')+'.\n'
      +'Responda APENAS qual e a COMPANHIA AEREA OPERADORA do voo, lida literalmente da imagem.\n'
      +'REGRAS:\n'
      +'- Nao deduza a cia a partir do programa de fidelidade nem do destino. Vale somente o que estiver escrito ou no logo visivel.\n'
      +'- Se houver conexao com companhias diferentes, devolva a do primeiro trecho.\n'
      +'- Se nao houver nome nem logo de companhia legivel, devolva cia vazia.\n'
      +'Responda somente este JSON: {"cia":"GOL"} ou {"cia":""}'
    }
  ];
  const r = await chamarClaude('Voce le screenshots de busca de passagens aereas. Responda APENAS JSON sem markdown.', content, 200);
  const cia = String(r?.cia || '').trim();
  return cia || null;
}

// Wrapper usado por todos os ramos de classificarItens(): aplica corrigirCia()
// e, so quando o resultado for 'Desconhecida', tenta recuperar da imagem.
async function resolverCiaComImagem(r, item) {
  const cia = corrigirCia(r.cia, r.programa, r.origemCodigo, r.destinoCodigo, r.tipoVoo, r.destino);
  if (cia !== 'Desconhecida' || !item || !item.imagemBase64) return cia;
  const rota = (r.origemCodigo || r.origem || '?')+'->'+(r.destinoCodigo || r.destino || '?')
             + ', programa '+(r.programa || '?');
  const lida = await ciaPelaImagem(item.imagemBase64, rota);
  if (!lida) { console.log('   [CIA-IMG] Cia nao legivel na imagem ('+rota+').'); return cia; }
  const norm = normalizarCia(lida);
  console.log('   [CIA-IMG] Cia recuperada da imagem: '+norm+' ('+rota+')');
  return norm;
}
const JSON_EXEMPLO = (i) => '{"resultados":[{"valido":true,"indice":'+i+',"origem":"São Paulo","destino":"Cancún","origemCodigo":"GRU","destinoCodigo":"CUN","cia":"LATAM","programa":"LATAM Pass","pontos":"31494","cabine":"Economica","tipoVoo":"internacional","direcao":"ida_volta","datasIda":"Jun/26: 16, 19, 22","datasVolta":"Jun/26: 22, 23"}]}';
const JSON_INVALIDO = (i) => '{"resultados":[{"valido":false,"indice":'+i+'}]}';

// ── PASSO 1: CLASSIFICAR (CDV) ────────────────────────────────────────────────
// ── FILTRO: programas descartados automaticamente nos monitoramentos ─────────
// Emissoes cujo programa seja Aeroplan ou Aegean nao devem alimentar a aba
// Alertas do gerador-cdv — marcamos como invalidas (preserva indices p/ pareamento).
const PROGRAMAS_BLOQUEADOS_ALERTA = /aeroplan|aegean/i;
function filtrarProgramasBloqueados(resultados) {
  return resultados.map(r => {
    if (r?.valido && PROGRAMAS_BLOQUEADOS_ALERTA.test(String(r.programa || ''))) {
      console.log('   [FILTRO] Descartada por programa bloqueado: ' + r.programa + ' (' + (r.origemCodigo || r.origem || '?') + '->' + (r.destinoCodigo || r.destino || '?') + ')');
      return { ...r, valido: false };
    }
    return r;
  });
}

async function classificarItens(itens, grupoId) {
  const resultados = [];

  if (grupoId === GRUPO_APENAS_IMAGEM) {
    // Aceita também itens SEM imagem mas COM legenda (ex: download da imagem
    // falhou) — a legenda deste grupo traz rota, programa e milhas completos,
    // o que permite ao menos classificar e parear ida/volta. Antes esses itens
    // eram descartados silenciosamente e o par nunca fechava.
    const itensClassificaveis = itens.filter(item => item.imagemBase64 || (item.texto && item.texto.trim() && item.texto.trim() !== '[imagem sem legenda]'));
    const descartados = itens.length - itensClassificaveis.length;
    if (descartados > 0) console.log('[GRUPO-IMG] '+descartados+' item(ns) sem imagem e sem legenda descartado(s).');
    if (itensClassificaveis.length === 0) { console.log('[GRUPO-IMG] Nenhum item classificável, descartando.'); return []; }

    for (let i = 0; i < itensClassificaveis.length; i++) {
      const item = itensClassificaveis[i];
      const indiceOriginal = itens.indexOf(item);
      const temImagem  = !!item.imagemBase64;
      const temLegenda = !!(item.texto && item.texto.trim());
      const introducaoImg = !temImagem
        ? (
            'Este texto é a legenda de uma postagem de um grupo de alertas de passagens aéreas com milhas. A imagem que a acompanhava não pôde ser baixada — extraia TODOS os dados possíveis da legenda abaixo. As datas de ida/volta normalmente ficam na imagem; se não constarem na legenda, deixe os campos de datas vazios.\n\n'
            +'"""\n'+item.texto.trim()+'\n"""\n\n'
          )
        : temLegenda
        ? (
            'Esta imagem é de um grupo de alertas de passagens aéreas com milhas. Ela veio acompanhada da seguinte legenda/descrição em texto:\n\n'
            +'"""\n'+item.texto.trim()+'\n"""\n\n'
            +'REGRAS DE PRIORIDADE (IMPORTANTE):\n'
            +'1. Trate a legenda acima como fonte PRINCIPAL: programa de fidelidade, origem, destino, quantidade de milhas/pontos, classe/cabine e companhia aérea ("cia") normalmente já vêm prontos nela — extraia esses campos do texto.\n'
            +'2. Use a IMAGEM principalmente para ler as DATAS de ida e volta, que costumam ser a única informação que falta na legenda.\n'
            +'3. Se algum campo não estiver claro na legenda (ex: código IATA, cia), complemente lendo a imagem.\n'
            +'4. Se legenda e imagem tiverem informação conflitante em algum campo, priorize a legenda.\n\n'
          )
        : (
            'Esta imagem é de um grupo de alertas de passagens aéreas com milhas e não veio acompanhada de nenhum texto/legenda. Extraia TODOS os dados diretamente da imagem.\n\n'
          );
      const content = [
        ...(temImagem ? [{ type:'image', source:{ type:'base64', media_type:'image/jpeg', data:item.imagemBase64 } }] : []),
        { type:'text', text:
          introducaoImg
          +'Leia (priorizando a legenda quando houver, complementando com a imagem):\n'
          +'- Programa de fidelidade (ex: LATAM Pass, Smiles, Azul Fidelidade, Azul pelo Mundo)\n'
          +'- Origem e destino com código IATA\n'
          +'- Quantidade de milhas/pontos\n'
          +'- Classe (Econômica ou Executiva)\n'
          +'- Companhia aérea operadora do voo (campo "cia")\n'
          +'- Datas de ida\n'
          +'- Datas de volta (pode estar em imagem separada)\n\n'
          +'CRÍTICO sobre códigos IATA (origemCodigo e destinoCodigo):\n'
          +'- Leia o código IATA EXATAMENTE como aparece na legenda ou na imagem. Ex: se mostrar "VIX → RAO", origemCodigo="VIX" e destinoCodigo="RAO".\n'
          +'- NUNCA substitua, corrija ou invente um código IATA diferente do que está na fonte.\n'
          +'- Para o campo "origem" use o nome da cidade do IATA de origem. Para "destino" use o nome da cidade do IATA de destino. Ex: VIX=Vitória, RAO=Ribeirão Preto, CLV=Caldas Novas, CTG=Cartagena, CGB=Cuiabá, SSA=Salvador.\n'
          +'- Se não souber o nome da cidade, use o próprio código IATA como nome — nunca invente.\n\n'
          +'CRÍTICO sobre companhia aérea (campo "cia"):\n'
          +'- "cia" é a companhia que OPERA o voo, não o programa de fidelidade.\n'
          +'- Quando o programa for "Azul pelo Mundo", a CIA é sempre uma parceira estrangeira mencionada na fonte (ex: COPA, United, TAP, Air France, KLM, Air Europa). NUNCA coloque "Azul" como CIA nesse programa.\n'
          +'- Frases como "voando pela COPA", "operado por United", "voando pela Air Europa" indicam a CIA correta.\n\n'
          +'Se houver APENAS datas de ida (sem datas de volta) ou APENAS datas de volta, preencha somente o campo correspondente e deixe o outro vazio.\n'
          +'Normalize as datas para o formato "Mês/Ano: dias". Ex: "Jun/26: 11, 13, 15".\n'
          +'IMPORTANTE sobre cidades: use o nome completo da cidade, não o código IATA.\n\n'
          +PROGRAMAS_VALIDOS+'\n\n'
          +'Responda com este JSON:\n'+JSON_EXEMPLO(indiceOriginal)+'\n'
          +'Se não houver passagem aérea retorne: '+JSON_INVALIDO(indiceOriginal)
        }
      ];
      const resultado = await chamarClaude(SYSTEM_CDV, content, 4096);
      const lista = resultado?.resultados || (resultado?.valido !== undefined ? [resultado] : [{ valido:false, indice:indiceOriginal }]);
      for (const r of lista) {
        // Indice deterministico do item no buffer - nunca confia no valor devolvido
        // pela IA (ela renumera quando um mesmo item contem varias emissoes,
        // fazendo a oferta herdar imagem/texto original de OUTRA mensagem).
        if (r) r.indice = indiceOriginal;
        if (r?.valido) {
          r.origem  = resolverCidade(r.origemCodigo, r.origem);
          r.destino = resolverCidade(r.destinoCodigo, r.destino);
          r.cia     = await resolverCiaComImagem(r, item);
        } else {
          // Diagnóstico: item do grupo-imagem descartado como inválido
          console.log('[GRUPO-IMG] Item '+indiceOriginal+' classificado como INVÁLIDO ('+(temImagem?'com imagem':'sem imagem')+'). Legenda: '+(item.texto||'').slice(0,80).replace(/\n/g,' | '));
        }
        resultados.push(r || { valido:false, indice:indiceOriginal });
      }
    }
    return filtrarProgramasBloqueados(resultados);
  }

  if (grupoId === GRUPO_EXECUTIVA) {
    const itensTexto = itens.filter(item => item.texto?.trim());
    if (itensTexto.length === 0) { console.log('[GRUPO-EXEC] Sem texto, descartando.'); return []; }

    for (let i = 0; i < itensTexto.length; i++) {
      const item = itensTexto[i];
      const indiceOriginal = itens.indexOf(item);
      const content = [{ type:'text', text:
        'Este texto é de um grupo especializado em passagens de CLASSE EXECUTIVA com milhas.\n\n'
        +'REGRAS CRÍTICAS:\n'
        +'1. Cabine é SEMPRE "Executiva" independente do que estiver no texto.\n'
        +'2. Se houver múltiplos programas de fidelidade listados (ex: Smiles, Azul, Aegean), use APENAS O PRIMEIRO programa e suas respectivas milhas. Ignore os demais.\n'
        +'3. Ignore COMPLETAMENTE imagens — extraia dados somente do texto.\n'
        +'4. Nas datas, remova números entre parênteses (quantidade de assentos). Ex: "JUL/26: 13(2), 19(1)" → "Jul/26: 13, 19".\n'
        +'5. Normalize datas para "Mês/Ano: dias". Ex: "JUL/26: 13, 19" → "Jul/26: 13, 19".\n'
        +'6. Pode haver uma mensagem somente com datas de ida (rota A→B) e outra somente com datas de volta (rota B→A). Nesse caso, indique "direcao":"ida" ou "direcao":"volta" conforme aplicável.\n\n'
        +'Texto:\n'+item.texto+'\n\n'
        +PROGRAMAS_VALIDOS+'\n\n'
        +'Responda com este JSON:\n'+JSON_EXEMPLO(indiceOriginal)+'\n'
        +'Se NAO houver passagem aerea retorne: '+JSON_INVALIDO(indiceOriginal)
      }];
      const resultado = await chamarClaude(SYSTEM_CDV, content, 4096);
      const lista = resultado?.resultados || (resultado?.valido !== undefined ? [resultado] : [{ valido:false, indice:indiceOriginal }]);
      for (const r of lista) {
        // Indice deterministico do item no buffer - nunca confia no valor devolvido
        // pela IA (ela renumera quando um mesmo item contem varias emissoes,
        // fazendo a oferta herdar imagem/texto original de OUTRA mensagem).
        if (r) r.indice = indiceOriginal;
        if (r?.valido) {
          r.cabine  = 'Executiva';
          r.origem  = resolverCidade(r.origemCodigo, r.origem);
          r.destino = resolverCidade(r.destinoCodigo, r.destino);
          r.cia     = await resolverCiaComImagem(r, item);
        }
        resultados.push(r || { valido:false, indice:indiceOriginal });
      }
    }
    return filtrarProgramasBloqueados(resultados);
  }

  if (GRUPOS_TEXTO_ESTRUTURADO.has(grupoId)) {
    const itensTexto = itens.filter(item => item.texto?.trim());
    if (itensTexto.length === 0) { console.log('[GRUPO-TEXTO] Sem texto, descartando.'); return []; }

    for (let i = 0; i < itensTexto.length; i++) {
      const item = itensTexto[i];
      const indiceOriginal = itens.indexOf(item);
      const content = [{ type:'text', text:
        'Este texto é de um grupo de alertas de passagens aéreas com milhas. Extraia os dados — IGNORE imagens completamente.\n\n'
        +'REGRAS:\n'
        +'1. O texto pode conter UMA ou MAIS emissões separadas por "Oportunidade de resgate" ou por rotas/programas diferentes. Retorne uma entrada por emissão.\n'
        +'2. Ignore tudo após as datas de volta: propagandas, valores em dinheiro, links de agência.\n'
        +'3. Milhas podem vir como "X mil milhas" — converta para número. Ex: "101.9 mil" = 101900, "39,5 mil" = 39500.\n'
        +'4. Datas podem vir em formato longo. Normalize para "Mês/Ano: dias". Ex: "Junho/26: 13, 14, 15" → "Jun/26: 13, 14, 15". "Agosto: 4 a 31" → "Ago/26: 4, 5, 6, ..., 31" (liste todos os dias).\n'
        +'5. Textos válidos DEVEM conter: programa, origem, destino, milhas e lista de datas. Se faltar lista de datas, retorne inválido.\n\n'
        +'Texto:\n'+item.texto+'\n\n'
        +PROGRAMAS_VALIDOS+'\n\n'
        +'Responda com este JSON (uma entrada por emissão):\n'+JSON_EXEMPLO(indiceOriginal)+'\n'
        +'Se NAO houver passagem aerea retorne: '+JSON_INVALIDO(indiceOriginal)
      }];
      const resultado = await chamarClaude(SYSTEM_CDV, content, 4096);
      const lista = resultado?.resultados || (resultado?.valido !== undefined ? [resultado] : [{ valido:false, indice:indiceOriginal }]);
      for (const r of lista) {
        // Indice deterministico do item no buffer - nunca confia no valor devolvido
        // pela IA (ela renumera quando um mesmo item contem varias emissoes,
        // fazendo a oferta herdar imagem/texto original de OUTRA mensagem).
        if (r) r.indice = indiceOriginal;
        if (r?.valido) {
          r.origem  = resolverCidade(r.origemCodigo, r.origem);
          r.destino = resolverCidade(r.destinoCodigo, r.destino);
          r.cia     = await resolverCiaComImagem(r, item);
        }
        resultados.push(r || { valido:false, indice:indiceOriginal });
      }
    }
    return filtrarProgramasBloqueados(resultados);
  }

  for (let i = 0; i < itens.length; i++) {
    const item = itens[i];
    const content = [];
    if (item.imagemBase64) content.push({ type:'image', source:{ type:'base64', media_type:'image/jpeg', data:item.imagemBase64 } });
    content.push({ type:'text', text:
      'Extraia TODAS as ofertas de passagem aerea presentes neste conteudo. Pode haver UMA ou MAIS emissoes separadas - identifique cada uma individualmente.\n'
      +(item.texto ? 'Texto: '+item.texto+'\n' : '')
      +'\nREGRAS DE EXTRACAO:\n'
      +'1. Se houver multiplas emissoes no TEXTO (separadas por "Oportunidade de resgate" ou programas/rotas diferentes), retorne UMA entrada por emissao.\n'
      +'2. Se houver IMAGEM junto com texto: a imagem e um screenshot de confirmacao da PRIMEIRA emissao do texto. Use o texto como fonte principal dos dados (programa, milhas, datas). A imagem serve apenas para confirmar dados visuais nao presentes no texto.\n'
      +'3. Priorize SEMPRE os dados do texto sobre os dados da imagem quando houver conflito.\n'
      +'4. DESCARTE imagens que sejam apenas screenshots de resultado de busca sem lista de datas explícita. Para uma imagem ser válida como emissão independente ela DEVE conter: origem, destino, programa/milhas E lista de datas. Se a imagem mostrar apenas o resultado de uma busca (ex: tela de seleção de voo sem datas listadas), descarte-a — ela é apenas uma confirmação visual de outra emissão.\n'
      +'5. Textos válidos como emissão DEVEM conter: programa de fidelidade, origem, destino, cabine E lista de datas. Textos sem lista de datas não são emissões válidas.\n'
      +'\nIMPORTANTE sobre datas: Use as datas do TEXTO quando disponiveis. So leia datas da imagem se o texto nao tiver datas. Normalize para o formato "Mês/Ano: dias". Ex: "Jun/26: 16, 19, 22".\n'
      +'\nIMPORTANTE sobre cidades: use o nome completo da cidade, nao o codigo IATA.\n'
      +'CRITICO: use SEMPRE o codigo IATA do texto quando disponivel. Nunca substitua o codigo IATA correto por outro.\n'
      +'\nResponda com este JSON (uma entrada por emissao encontrada):\n'
      +JSON_EXEMPLO(i)+'\n'
      +PROGRAMAS_VALIDOS+'\n'
      +'Se NAO houver nenhuma passagem aerea retorne: '+JSON_INVALIDO(i)
    });
    const resultado = await chamarClaude(SYSTEM_CDV, content, 4096);
    const lista = resultado?.resultados || (resultado?.valido !== undefined ? [resultado] : [{ valido:false, indice:i }]);
    for (const r of lista) {
      // Indice deterministico do item no buffer (ver comentario acima).
      if (r) r.indice = i;
      if (r?.valido) {
        r.origem  = resolverCidade(r.origemCodigo, r.origem);
        r.destino = resolverCidade(r.destinoCodigo, r.destino);
        r.cia     = await resolverCiaComImagem(r, item);
      }
      resultados.push(r || { valido:false, indice:i });
    }
  }
  return filtrarProgramasBloqueados(resultados);
}

// ── PASSO 2: AGRUPAR E FORMATAR (CDV) ─────────────────────────────────────────
async function agruparEFormatar(classificacoes) {
  const validas = classificacoes.filter(c => c?.valido);
  if (validas.length === 0) return [];

  if (validas.length === 1) {
    const v = validas[0];
    const dados = { origem:v.origem, destino:v.destino, pontos:v.pontos, programa:v.programa, cia:v.cia, cabine:v.cabine||'Economica', tipoVoo:v.tipoVoo||'internacional', datasIda:v.datasIda||'', datasVolta:v.datasVolta||'' };
    return [{ indices:[v.indice], tipo:v.direcao||'ida', ...dados, mensagem:formatarMensagemCDV(dados) }];
  }

  const grupos = new Map();
  for (const v of validas) {
    const cidadeA = [v.origemCodigo||v.origem, v.destinoCodigo||v.destino].sort().join('-');
    const chave = (v.programa||'') + '|' + (v.cabine||'Economica') + '|' + cidadeA;
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(v);
  }

  if (grupos.size > 1) {
    const resultado = [];
    for (const [, items] of grupos) {
      const v = items.reduce((best, cur) => {
        const dBest = contarDatas((best.datasIda||'') + ' ' + (best.datasVolta||''));
        const dCur  = contarDatas((cur.datasIda||'') + ' ' + (cur.datasVolta||''));
        return dCur > dBest ? cur : best;
      }, items[0]);
      const dados = { origem:v.origem, destino:v.destino, pontos:v.pontos, programa:v.programa, cia:v.cia, cabine:v.cabine||'Economica', tipoVoo:v.tipoVoo||'internacional', datasIda:v.datasIda||'', datasVolta:v.datasVolta||'' };
      resultado.push({ indices:items.map(i=>i.indice), tipo:v.direcao||'ida', ...dados, mensagem:formatarMensagemCDV(dados) });
    }
    return resultado;
  }

  const system = 'Voce e especialista em passagens aereas. Agrupe trechos da mesma emissao. Responda APENAS JSON sem markdown.';
  const prompt = 'Agrupe estas '+validas.length+' ofertas que pertencem a mesma emissao.\n\n'
    +'Criterios para pertencer ao MESMO grupo: mesmo programa, mesmas milhas, mesma companhia, mesma cabine, rotas complementares.\n\n'
    +'REGRAS DE SEPARACAO — sempre separe quando: programas diferentes, cias diferentes, cabines diferentes, rotas sem relacao.\n\n'
    +'IMPORTANTE para pontos: use SEMPRE o MENOR valor entre os trechos.\n\n'
    +'Ofertas:\n'+JSON.stringify(validas,null,2)+'\n\n'
    +'Responda:\n{"emissoes":[{"indices":[0,1],"tipo":"ida_volta","origem":"São Paulo","destino":"Cancún","origemCodigo":"GRU","destinoCodigo":"CUN","cia":"LATAM","programa":"LATAM Pass","pontos":70300,"cabine":"Economica","tipoVoo":"internacional","datasIda":"Jun/26: 16, 19, 22","datasVolta":"Jun/26: 22, 23"}]}';

  const resultado = await chamarClaude(system, [{ type:'text', text:prompt }], 4096);
  const emissoes  = resultado?.emissoes || [];

  if (emissoes.length === 0) {
    return validas.map(v => {
      const dados = { origem:v.origem, destino:v.destino, pontos:v.pontos, programa:v.programa, cia:v.cia, cabine:v.cabine||'Economica', tipoVoo:v.tipoVoo||'internacional', datasIda:v.datasIda||'', datasVolta:v.datasVolta||'' };
      return { indices:[v.indice], tipo:v.direcao||'ida', ...dados, mensagem:formatarMensagemCDV(dados) };
    });
  }

  return emissoes.map(e => {
    const origem  = resolverCidade(e.origemCodigo,  e.origem);
    const destino = resolverCidade(e.destinoCodigo, e.destino);
    const dados   = { origem, destino, pontos:e.pontos, programa:e.programa, cia:e.cia, cabine:e.cabine||'Economica', tipoVoo:e.tipoVoo||'internacional', datasIda:e.datasIda||'', datasVolta:e.datasVolta||'' };
    // A Claude AI retorna índices como posições em `validas` (0,1,2...).
    // Remapeia para os índices reais de `itens` (v.indice) antes de retornar.
    const indicesReais = (e.indices||[]).map(pos => validas[pos]?.indice ?? pos);
    // Também preserva o indice da classificação que melhor corresponde à emissão
    // (usado como fallback na associação de imagens no processarBuffer)
    const indiceClassif = indicesReais.length > 0 ? indicesReais[0] : undefined;
    return { ...e, ...dados, indices: indicesReais, indice: indiceClassif, mensagem:formatarMensagemCDV(dados) };
  });
}

// ── MESCLAR PARES IDA/VOLTA ───────────────────────────────────────────────────
function mesclarParesIdaVolta(validas) {
  const resultado = [];
  let i = 0;

  function normalizar(codigo, nome) {
    return (codigo || resolverCidade('', nome) || '').toLowerCase().trim();
  }

  function ehParInvertido(v, w) {
    const mesmoPrograma = (v.programa||'') === (w.programa||'');
    const mesmaCabine   = (v.cabine||'Economica') === (w.cabine||'Economica');

    // Mesma CIA (companhia operadora) — evita mesclar Finnair com Iberia, etc.
    const mesmaCia = !v.cia || !w.cia || (v.cia||'').toLowerCase().trim() === (w.cia||'').toLowerCase().trim();

    // Milhas similares (±15%) — evita mesclar 50.500 Avios com 77.250 Avios
    const pV = Number(v.pontos) || 0;
    const pW = Number(w.pontos) || 0;
    const milhasSimilares = pV === 0 || pW === 0 || Math.abs(pV - pW) / Math.max(pV, pW) <= 0.15;

    // Rota estritamente invertida: A→B com B→A usando código IATA
    const vOri = normalizar(v.origemCodigo,  v.origem);
    const vDes = normalizar(v.destinoCodigo, v.destino);
    const wOri = normalizar(w.origemCodigo,  w.origem);
    const wDes = normalizar(w.destinoCodigo, w.destino);
    const rotaInvertida = vOri && vDes && wOri && wDes && vOri === wDes && vDes === wOri;

    // Diagnóstico: rota é invertida mas alguma condição barrou a mescla
    if (rotaInvertida && !(mesmoPrograma && mesmaCabine && mesmaCia && milhasSimilares)) {
      const motivos = [];
      if (!mesmoPrograma)   motivos.push('programa "'+(v.programa||'?')+'"≠"'+(w.programa||'?')+'"');
      if (!mesmaCabine)     motivos.push('cabine "'+(v.cabine||'?')+'"≠"'+(w.cabine||'?')+'"');
      if (!mesmaCia)        motivos.push('cia "'+(v.cia||'?')+'"≠"'+(w.cia||'?')+'"');
      if (!milhasSimilares) motivos.push('milhas '+pV+' vs '+pW+' ('+Math.round(Math.abs(pV-pW)/Math.max(pV,pW)*100)+'%)');
      console.log('[MERGE-SKIP] '+(v.origemCodigo||v.origem)+'<->'+(w.origemCodigo||w.origem)+' rota invertida mas: '+motivos.join(' | '));
    }

    return mesmoPrograma && mesmaCabine && mesmaCia && milhasSimilares && rotaInvertida;
  }

  const usados = new Set();

  while (i < validas.length) {
    if (usados.has(i)) { i++; continue; }
    const v = validas[i];

    let parIdx = -1;
    // Busca par ida/volta em TODO o restante do buffer.
    // (Antes limitava a 2 posições à frente — perdia pares separados por
    // outras postagens dentro da mesma janela de 3 min.)
    // O Set "usados" garante que nenhuma mensagem é reutilizada.
    for (let j = i + 1; j <= validas.length - 1; j++) {
      if (!usados.has(j) && ehParInvertido(v, validas[j])) {
        parIdx = j;
        break;
      }
    }

    if (parIdx !== -1) {
      const w = validas[parIdx];
      const merged = {
        ...v,
        direcao:    'ida_volta',
        datasIda:   v.datasIda   || v.datasVolta || '',
        datasVolta: w.datasIda   || w.datasVolta || '',
        indices:    [...(v.indices||[v.indice]), ...(w.indices||[w.indice])],
      };
      merged.origem  = resolverCidade(merged.origemCodigo,  merged.origem);
      merged.destino = resolverCidade(merged.destinoCodigo, merged.destino);
      console.log('[MERGE] Par ida/volta mesclado (pos '+i+'+'+parIdx+'): '+(v.origemCodigo||v.origem)+'->'+(v.destinoCodigo||v.destino));
      resultado.push(merged);
      usados.add(i);
      usados.add(parIdx);
    } else {
      resultado.push({ ...v, indices: v.indices||[v.indice] });
      usados.add(i);
    }
    i++;
  }
  return resultado;
}

// ── PROCESSAR BUFFER (CDV) ────────────────────────────────────────────────────
// ── FILA DE ESPERA POR PAR IDA/VOLTA ENTRE BUFFERS ───────────────────────────
// Quando uma oferta somente-ida chega, aguarda até 5 minutos por sua volta.
// Se a volta chegar, mescla e libera. Se não chegar, libera como somente-ida.
const _esperandoPar = new Map(); // chave → { oferta, timer, grupoId }

function chaveParOuInverso(oferta) {
  const ori = (oferta.dadosExtraidos?.origemCodigo || '').toUpperCase();
  const des = (oferta.dadosExtraidos?.destinoCodigo || '').toUpperCase();
  const prog = (oferta.dadosExtraidos?.programa || '').toLowerCase();
  const cab  = (oferta.dadosExtraidos?.cabine || 'Economica').toLowerCase();
  if (!ori || !des) return null;
  return prog + '|' + cab + '|' + [ori, des].sort().join('-');
}

async function aguardarParIdaVolta(oferta, grupoId) {
  // Só aplica em ofertas somente-ida com rota identificada
  const tipo = oferta.dadosExtraidos?.tipo;
  if (tipo === 'ida_volta') return false; // já completa, libera direto

  const chave = chaveParOuInverso(oferta);
  if (!chave) return false;

  const esperando = _esperandoPar.get(chave);
  if (esperando) {
    // Valida cia e milhas antes de mesclar (mesmo rigor de ehParInvertido):
    // rota+programa+cabine já batem pela chave; cia deve bater (leniente se vazia)
    // e milhas devem estar dentro de ±15%.
    const dE = esperando.oferta.dadosExtraidos || {};
    const dO = oferta.dadosExtraidos || {};
    const ciaE = (dE.cia||'').toLowerCase().trim();
    const ciaO = (dO.cia||'').toLowerCase().trim();
    const mesmaCia = !ciaE || !ciaO || ciaE === ciaO;
    const pE = Number(dE.pontos) || 0;
    const pO = Number(dO.pontos) || 0;
    const milhasSimilares = pE === 0 || pO === 0 || Math.abs(pE - pO) / Math.max(pE, pO) <= 0.15;
    if (!mesmaCia || !milhasSimilares) {
      const motivos = [];
      if (!mesmaCia)        motivos.push('cia "'+(dE.cia||'?')+'"≠"'+(dO.cia||'?')+'"');
      if (!milhasSimilares) motivos.push('milhas '+pE+' vs '+pO);
      console.log('[PAR-BUFFER] Par com mesma chave mas incompatível ('+motivos.join(' | ')+') — liberando ambas separadas.');
      return false; // libera a nova como somente-ida; a que espera segue no timer
    }
    // Par encontrado — mescla e libera
    clearTimeout(esperando.timer);
    _esperandoPar.delete(chave);
    const o1 = esperando.oferta;
    const o2 = oferta;
    // Determina qual é ida e qual é volta pela rota
    const o1Ori = (o1.dadosExtraidos?.origemCodigo || '').toUpperCase();
    const o2Ori = (o2.dadosExtraidos?.origemCodigo || '').toUpperCase();
    const base  = o1Ori <= o2Ori ? o1 : o2;
    const volta = o1Ori <= o2Ori ? o2 : o1;
    const mesclada = {
      ...base,
      id: gerarId(),
      dadosExtraidos: {
        ...base.dadosExtraidos,
        tipo: 'ida_volta',
        datasIda:   base.dadosExtraidos?.datasIda  || volta.dadosExtraidos?.datasIda  || '',
        datasVolta: volta.dadosExtraidos?.datasIda || base.dadosExtraidos?.datasVolta || '',
      },
      conteudoOriginal: [base.conteudoOriginal, volta.conteudoOriginal].filter(Boolean).join('\n'),
      imagens: [...(base.imagens||[]), ...(volta.imagens||[])],
    };
    const hist180Par = await registrarPassagemProxy({ origem:mesclada.dadosExtraidos?.origem||'', destino:mesclada.dadosExtraidos?.destino||'', cia:mesclada.dadosExtraidos?.cia||'', programa:mesclada.dadosExtraidos?.programa||'', pontos:Number(mesclada.dadosExtraidos?.pontos)||0, cabine:mesclada.dadosExtraidos?.cabine||'Economica', datas_ida:mesclada.dadosExtraidos?.datasIda||'', datas_volta:mesclada.dadosExtraidos?.datasVolta||'', fonte:'alerta_pendente', apenasConsulta:true });
    if (precoForaDaCurva(mesclada.dadosExtraidos?.pontos, hist180Par, mesclada.dadosExtraidos?.tipoVoo)) {
      console.log('[PAR-BUFFER] Par mesclado descartado pelo filtro 180d: ' + (mesclada.dadosExtraidos?.origemCodigo) + '↔' + (mesclada.dadosExtraidos?.destinoCodigo));
      return true; // consumido (descartado)
    }
    mesclada.mensagemFormatada = appendHistoricoMensagem(formatarMensagemCDV({ ...mesclada.dadosExtraidos }), hist180Par);
    mesclada.tipoConteudo = mesclada.imagens.length > 1 ? mesclada.imagens.length+' imagens' : mesclada.imagens.length === 1 ? 'imagem' : 'texto';
    filaPendentes.unshift(mesclada);
    salvarFila();
    console.log('[PAR-BUFFER] Mesclado ida/volta entre buffers: ' + (mesclada.dadosExtraidos?.origemCodigo) + '↔' + (mesclada.dadosExtraidos?.destinoCodigo));
    return true; // consumido
  }

  // Sem par ainda — coloca na espera por 5 minutos
  const timer = setTimeout(() => {
    if (_esperandoPar.get(chave)?.oferta === oferta) {
      _esperandoPar.delete(chave);
      // Registra no proxy e appenda histórico (fire-and-update antes de entrar na fila)
      registrarPassagemProxy({ origem:oferta.dadosExtraidos?.origem||'', destino:oferta.dadosExtraidos?.destino||'', cia:oferta.dadosExtraidos?.cia||'', programa:oferta.dadosExtraidos?.programa||'', pontos:Number(oferta.dadosExtraidos?.pontos)||0, cabine:oferta.dadosExtraidos?.cabine||'Economica', datas_ida:oferta.dadosExtraidos?.datasIda||'', datas_volta:oferta.dadosExtraidos?.datasVolta||'', fonte:'alerta_pendente', apenasConsulta:true })
        .then(hist180 => {
          if (precoForaDaCurva(oferta.dadosExtraidos?.pontos, hist180, oferta.dadosExtraidos?.tipoVoo)) {
            console.log('[PAR-BUFFER] Somente-ida descartada pelo filtro 180d: ' + (oferta.dadosExtraidos?.origemCodigo) + '->' + (oferta.dadosExtraidos?.destinoCodigo));
            return;
          }
          if (hist180) oferta.mensagemFormatada = appendHistoricoMensagem(oferta.mensagemFormatada, hist180);
          filaPendentes.unshift(oferta);
          salvarFila();
        })
        .catch(() => { filaPendentes.unshift(oferta); salvarFila(); });
      console.log('[PAR-BUFFER] Timeout — liberando somente-ida: ' + (oferta.dadosExtraidos?.origemCodigo) + '->' + (oferta.dadosExtraidos?.destinoCodigo));
    }
  }, 5 * 60 * 1000);

  _esperandoPar.set(chave, { oferta, timer, grupoId });
  console.log('[PAR-BUFFER] Aguardando par para: ' + (oferta.dadosExtraidos?.origemCodigo) + '->' + (oferta.dadosExtraidos?.destinoCodigo));
  return true; // segurado
}

async function processarBuffer(grupoId) {
  const entrada = bufferAgrupamento.get(grupoId);
  if (!entrada) return;
  bufferAgrupamento.delete(grupoId);
  const { itens } = entrada;
  console.log('Janela encerrada - '+itens.length+' item(ns)');
  try {
    const classificacoes = await classificarItens(itens, grupoId);
    let validas = classificacoes.filter(c => c?.valido);
    if (validas.length === 0) { console.log('Nenhuma oferta encontrada.'); return; }

    const gruposMesclagem = new Set([GRUPO_APENAS_IMAGEM, GRUPO_EXECUTIVA, ...GRUPOS_TEXTO_ESTRUTURADO]);
    if (gruposMesclagem.has(grupoId)) {
      validas = mesclarParesIdaVolta(validas);
    }

    const minDatas = GRUPOS_FILTRO_DATAS_MIN[grupoId];
    if (minDatas) {
      const validasFiltradas = validas.filter(v => {
        const total = contarDatas(v.datasIda) + contarDatas(v.datasVolta);
        if (total <= minDatas) { console.log('   [FILTRO] Descartada por poucas datas ('+total+'): '+v.origemCodigo+'->'+v.destinoCodigo); return false; }
        return true;
      });
      if (validasFiltradas.length === 0) { console.log('   [FILTRO] Todas descartadas.'); return; }
      validas = validasFiltradas;
    }

    const gruposBypass = new Set([GRUPO_APENAS_IMAGEM, GRUPO_EXECUTIVA]);
    if (gruposBypass.has(grupoId)) {
      for (const v of validas) {
        const indices = v.indices || [v.indice];
        const textos  = indices.map(i => itens[i]?.texto).filter(Boolean).join('\n');
        const dados   = { origem:v.origem, destino:v.destino, pontos:v.pontos, programa:v.programa, cia:v.cia, cabine:v.cabine||'Economica', tipoVoo:v.tipoVoo||'internacional', tipo:v.direcao||'ida', datasIda:v.datasIda||'', datasVolta:v.datasVolta||'' };
        const hist180Bypass = await registrarPassagemProxy({ origem:dados.origem, destino:dados.destino, cia:dados.cia, programa:dados.programa, pontos:Number(dados.pontos)||0, cabine:dados.cabine, datas_ida:dados.datasIda, datas_volta:dados.datasVolta, fonte:'alerta_pendente', apenasConsulta:true });
        if (precoForaDaCurva(dados.pontos, hist180Bypass, dados.tipoVoo)) {
          console.log('[BYPASS] Emissão descartada pelo filtro 180d: ' + v.origemCodigo + '->' + v.destinoCodigo + ' (' + v.programa + ')');
          continue;
        }
        const mensagem = appendHistoricoMensagem(formatarMensagemCDV(dados), hist180Bypass);
        // indices já contém os índices reais de itens[] — inclui par ida+volta após mesclarParesIdaVolta
        const imagens  = indices.map(i => itens[i]?.imagemBase64).filter(Boolean);
        const oferta   = { id:gerarId(), timestamp:new Date().toISOString(), grupoOrigem:grupoId, tipoConteudo:imagens.length>1?imagens.length+' imagens':imagens.length===1?'imagem':'texto', conteudoOriginal:textos, imagens, mensagemFormatada:mensagem, dadosExtraidos:{ ...dados, indices }, status:'pendente' };
        // Somente-ida: aguarda até 5 min por par ida/volta de outro buffer
        // (antes o bypass entrava direto na fila e pares divididos entre
        // buffers viravam duas ofertas separadas)
        const parEsperandoBypass = await aguardarParIdaVolta(oferta, grupoId);
        if (!parEsperandoBypass) {
          filaPendentes.unshift(oferta);
          salvarFila();
          console.log('[BYPASS] Oferta criada direto: '+v.origemCodigo+'->'+v.destinoCodigo+' ('+v.programa+')');
        }
      }
      return;
    }

    const classificacoesFinais = validas.map(v => ({ ...v, valido:true }));
    const emissoes = await agruparEFormatar(classificacoesFinais);

    // Monta mapa indice→item para associação correta de imagens/textos
    // (os índices nas emissões vêm do passo 1 e podem não ser posicionais)
    const indiceMapa = new Map();
    itens.forEach((item, idx) => indiceMapa.set(idx, item));

    for (const emissao of emissoes) {
      const indices = emissao.indices || [];

      // Usa os índices reais da emissão (já remapeados de validas para itens no agruparEFormatar).
      // Para emissões com múltiplos programas/rotas no mesmo item (ex: texto com várias emissões),
      // a Claude AI pode retornar o mesmo índice para emissões diferentes — neste caso,
      // usamos o dadosExtraidos para identificar qual item é o original correto.
      // Estratégia: busca o item cujo texto/imagem melhor corresponde à emissão.
      let imagensFinal = indices.map(i => indiceMapa.get(i)?.imagemBase64).filter(Boolean);
      let textosFinal  = indices.map(i => indiceMapa.get(i)?.texto).filter(Boolean).join('\n');

      // Se não encontrou imagens pelos índices (bug de remapeamento), usa o índice da
      // classificação original que gerou esta emissão via dadosExtraidos.indice
      if (imagensFinal.length === 0 && emissao.indice !== undefined) {
        const img = indiceMapa.get(emissao.indice)?.imagemBase64;
        if (img) imagensFinal = [img];
        const txt = indiceMapa.get(emissao.indice)?.texto;
        if (txt && !textosFinal) textosFinal = txt;
      }

      const hist180Normal = await registrarPassagemProxy({ origem:emissao.origem, destino:emissao.destino, cia:emissao.cia, programa:emissao.programa, pontos:Number(emissao.pontos)||0, cabine:emissao.cabine||'Economica', datas_ida:emissao.datasIda||'', datas_volta:emissao.datasVolta||'', fonte:'alerta_pendente', apenasConsulta:true });
      if (precoForaDaCurva(emissao.pontos, hist180Normal, emissao.tipoVoo)) {
        console.log('[FILTRO-180D] Emissão descartada: ' + emissao.origem + '->' + emissao.destino + ' (' + emissao.programa + ')');
        continue;
      }
      const mensagemComHist = appendHistoricoMensagem(emissao.mensagem, hist180Normal);
      const oferta = {
        id: gerarId(),
        timestamp: new Date().toISOString(),
        grupoOrigem: grupoId,
        tipoConteudo: imagensFinal.length > 1 ? imagensFinal.length+' imagens' : imagensFinal.length === 1 ? 'imagem' : 'texto',
        conteudoOriginal: textosFinal,
        imagens: imagensFinal,
        mensagemFormatada: mensagemComHist,
        dadosExtraidos: emissao,
        status: 'pendente',
        tenant: tenantContexto() || TENANT_PADRAO,
      };
      // Aguarda par ida/volta de buffer diferente (até 5 min)
      const parEsperando = await aguardarParIdaVolta(oferta, grupoId);
      if (!parEsperando) {
        filaPendentes.unshift(oferta);
        salvarFila();
      }
    }
  } catch (err) { console.error('Erro ao processar buffer:', err.message); }
}

// ── LISTENER WHATSAPP ─────────────────────────────────────────────────────────
// ── FILA SERIAL POR GRUPO ─────────────────────────────────────────────────────
// Garante que mensagens do mesmo grupo são processadas uma por vez, em ordem.
// Grupos diferentes processam em paralelo entre si.
const _filaGrupo = new Map(); // jid → Promise (última tarefa na fila)

// Buffer circular de diagnostico dos ultimos upserts recebidos (ver /debug-upserts).
const _debugUpserts = [];

// jid -> nome do grupo. Preenchido sob demanda para o painel mostrar de onde
// veio cada oferta sem depender de uma chamada extra ao WhatsApp.
const NOMES_GRUPOS = new Map();
async function atualizarNomesGrupos() {
  if (!sock || !conectado) return;
  try {
    const chats = await sock.groupFetchAllParticipating();
    for (const g of Object.values(chats)) NOMES_GRUPOS.set(g.id, g.subject || '(sem nome)');
    console.log('[GRUPOS] Cache de nomes atualizado — ' + NOMES_GRUPOS.size + ' grupo(s).');
  } catch (e) { console.warn('[GRUPOS] Falha ao atualizar cache de nomes:', e.message); }
}

// Arquivos de ./sessao que sobrevivem a um reset completo: nao sao credenciais
// do WhatsApp e nao se regeneram sozinhos. Ao criar um arquivo novo nessa pasta,
// avaliar se ele pertence a esta lista.
const PRESERVAR_NO_RESET = new Set([
  'fila_pendentes.json',    // fila de aprovacao
  'agendamentos.json',      // envios agendados
  'telegram_session.txt',   // sessao do Telegram (independente do WhatsApp)
  'cupons_base.json',       // base de cupons — cadastro manual/capturado
  'radar_config.json',      // papeis fonte/destino dos grupos do radar
  'config_tsp.json',        // config da operacao (afiliados, rodapes, grupos)
  'tenants.json',           // registro dos operadores do modelo hospedado
  'cupons_vistos.json',     // dedup de cupons
  'radar_vistos.json',      // dedup do radar
  'msgs-enviadas.json',     // dedup de mensagens enviadas
  'publicadas.json',        // historico da vitrine publica
  'contas',                 // credenciais dos numeros secundarios de envio
]);

function enfileirarPorGrupo(jid, fn) {
  const anterior = _filaGrupo.get(jid) || Promise.resolve();
  const proxima  = anterior.then(() => fn()).catch(err => {
    console.error('[FILA-GRUPO] Erro ao processar mensagem do grupo', jid, ':', err.message);
  });
  _filaGrupo.set(jid, proxima);
  // Limpa o Map após processar para não vazar memória
  proxima.finally(() => {
    if (_filaGrupo.get(jid) === proxima) _filaGrupo.delete(jid);
  });
  return proxima;
}

// Desembrulha wrappers comuns do WhatsApp (mensagens efêmeras, view-once,
// documento com legenda, etc.) até chegar ao conteúdo real.
const _WRAPPERS_WA = ['ephemeralMessage','viewOnceMessage','viewOnceMessageV2','viewOnceMessageV2Extension','documentWithCaptionMessage','deviceSentMessage'];
function desembrulharMessage(m) {
  let atual = m, prof = 0;
  while (atual && prof < 5) {
    const chave = _WRAPPERS_WA.find(w => atual[w]);
    if (!chave) break;
    atual = atual[chave].message || atual[chave];
    prof++;
  }
  return atual || m;
}

// Tipos que geram captura. A detecção busca por PRIORIDADE entre as chaves —
// nunca pela primeira chave do objeto (Object.keys(m)[0]), pois mensagens com
// metadados E2E na frente (ex: messageContextInfo, comum em imagens enviadas
// como álbum) eram classificadas com o tipo errado e descartadas SEM LOG.
const _TIPOS_TRATADOS = ['imageMessage','extendedTextMessage','conversation'];
// Tipos sem valor de captura — descartados sem log para não poluir
const _TIPOS_IGNORADOS = new Set(['protocolMessage','reactionMessage','pollUpdateMessage','senderKeyDistributionMessage','messageContextInfo','stickerMessage','audioMessage','pollCreationMessage','pollCreationMessageV2','pollCreationMessageV3']);

// ── RADAR DE MARKETPLACE ─────────────────────────────────────────────────────
// Extrai o link do produto da mensagem do grupo-fonte, consulta a Creators API
// (que e a fonte da verdade de preco e estoque — nunca o texto do grupo) e
// ── AVISO: CUPOM CITADO QUE NAO ESTA NA BASE ─────────────────────────────────
// Dedup por (loja, codigo) com janela de 6h: um cupom novo do ML aparece em
// dezenas de posts no mesmo dia e o operador so precisa ser avisado uma vez.
// Em memoria de proposito — perder o registro num redeploy so custa um aviso
// repetido, e persistir isso no GitHub nao vale a escrita.
const AVISOS_CUPOM_SEM_BASE = new Map();
const AVISO_CUPOM_SEM_BASE_TTL_MS = 6 * 60 * 60 * 1000;

async function avisarCupomDesconhecido(loja, codigos, p, jid) {
  const agora = Date.now();
  const novos = codigos.filter(cod => {
    const k = loja + ':' + cod;
    const visto = AVISOS_CUPOM_SEM_BASE.get(k);
    if (visto && agora - visto < AVISO_CUPOM_SEM_BASE_TTL_MS) return false;
    AVISOS_CUPOM_SEM_BASE.set(k, agora);
    return true;
  });
  if (!novos.length) return;

  const grupo = NOMES_GRUPOS.get(jid) || jid.split('@')[0];
  const preco = Number(p.preco);
  const texto = '🏷️ *Cupom citado não está na base*\n\n'
    + '*Cupom* ' + novos.join(', ') + '\n'
    + '*Loja* ' + (loja || '—') + '\n'
    + '*Oferta* ' + (p.titulo || p.asin || '—') + '\n'
    + (preco ? '*Preço sem cupom* R$ ' + preco.toFixed(2).replace('.', ',') + '\n' : '')
    + (p.link ? '*Link* ' + p.link + '\n' : '')
    + '*Grupo de origem* ' + grupo + '\n\n'
    + 'A oferta saiu pelo preço cheio. Cadastre o cupom na base para o radar '
    + 'aplicar o desconto nas próximas.';

  try {
    await enviarMensagem(GRUPOS['operador'], { text: texto });
    console.log('[CUPOM-SEM-BASE] ' + loja + ' — ' + novos.join(', ') + ' (grupo ' + grupo + ')');
  } catch (e) { console.error('[CUPOM-SEM-BASE] Falha ao avisar operador:', e.message); }
}

// Cupom que o ANUNCIO declara e a base nao conhece. Diferente do caso acima
// (cupom citado no post), aqui o desconto e real e confirmado pelo ML — falta
// so o codigo, que so a base tem. Sem ele nao ha o que o membro digitar, entao
// a oferta sai pelo preco cheio e o operador recebe o campaign_id para cadastrar
// o cupom ja vinculado.
const AVISOS_CUPOM_ANUNCIO = new Map();
const AVISO_CUPOM_ANUNCIO_TTL_MS = 6 * 3600e3;

async function avisarCupomAnuncioSemBase(aviso, p, jid) {
  const chave = 'anuncio:' + (aviso.idCampanhaLoja || aviso.percentual);
  const agora = Date.now();
  const visto = AVISOS_CUPOM_ANUNCIO.get(chave);
  if (visto && agora - visto < AVISO_CUPOM_ANUNCIO_TTL_MS) return;
  AVISOS_CUPOM_ANUNCIO.set(chave, agora);

  const grupo = jid ? (NOMES_GRUPOS.get(jid) || jid.split('@')[0]) : '—';
  const preco = Number(p.preco);
  const brl = (v) => 'R$ ' + Number(v).toFixed(2).replace('.', ',');
  const texto = '🏷️ *Cupom no anúncio que não está na base*\n\n'
    + '*Desconto* ' + aviso.percentual + (aviso.desconto ? ' (' + brl(aviso.desconto) + ')' : '') + '\n'
    + (aviso.idCampanhaLoja ? '*Campanha* ' + aviso.idCampanhaLoja + '\n' : '')
    + '*Oferta* ' + (p.titulo || p.id || '—') + '\n'
    + (preco ? '*Preço sem cupom* ' + brl(preco) + '\n' : '')
    + (preco && aviso.desconto ? '*Sairia por* ' + brl(Math.max(0, preco - aviso.desconto)) + '\n' : '')
    + (p.link ? '*Link* ' + p.link + '\n' : '')
    + '*Grupo de origem* ' + grupo + '\n\n'
    + 'A oferta saiu pelo preço cheio: o anúncio confirma o desconto, mas sem o '
    + 'código na base não há o que passar ao membro. Rode /ml/sync-cupons-conta '
    + 'para importar os cupons da conta com código e campanha.';

  try {
    await enviarMensagem(GRUPOS['operador'], { text: texto });
    console.log('[CUPOM-ANUNCIO] ' + aviso.percentual + ' campanha ' + (aviso.idCampanhaLoja || '—'));
  } catch (e) { console.error('[CUPOM-ANUNCIO] Falha ao avisar operador:', e.message); }
}

// enfileira em filaPendentes com tipoConteudo 'oferta_amazon'. A partir dai
// segue exatamente o mesmo caminho de aprovacao dos cupons TSP.
// O Mercado Livre publica as imagens de produto em WebP, e o WhatsApp so
// decodifica JPEG no jpegThumbnail do link preview — webp cru faz o card nao
// renderizar (por isso Shopee/Amazon tinham preview e o ML nao). O CDN serve o
// mesmo asset em .jpg trocando a extensao; o sufixo -O (~28KB) cabe folgado no
// limite de 100KB, enquanto o -F em 2X passa de 100KB e seria descartado.
function variantesImagemProduto(url) {
  const lista = [];
  if (/mlstatic\.com/i.test(url) && /\.webp(\?|$)/i.test(url)) {
    const jpg = url.replace(/\.webp(\?|$)/i, '.jpg$1');
    lista.push(jpg.replace(/D_NQ_NP_2X_/i, 'D_NQ_NP_').replace(/-F\.jpg/i, '-O.jpg'));
    lista.push(jpg);
  }
  lista.push(url);
  return [...new Set(lista)];
}

async function baixarImagemProduto(url) {
  if (!url) return null;
  for (const alvo of variantesImagemProduto(url)) {
    try {
      const res = await fetch(alvo, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 4 * 1024 * 1024) continue;
      return { imagemBase64: buf.toString('base64'), mime: res.headers.get('content-type') || 'image/jpeg' };
    } catch (e) {
      console.warn('[MKT] Nao baixou a imagem do produto (' + alvo + '):', e.message);
    }
  }
  return null;
}

async function processarRadarMarketplace(jid, texto) {
  if (!texto) return;

  // Uma mensagem pode trazer link de mais de uma loja; cada pipeline cuida dos
  // links que reconhece e ignora o resto.
  const resultados = [];

  // O cadastro de monitoramento decide loja a loja: um grupo pode estar dentro
  // da janela para Amazon e fora para Shopee.
  const podeAmazon = podeCapturar(jid, 'Amazon');
  if (podeAmazon.ok) {
    try { resultados.push(...await processarTextoAmazon(texto)); }
    catch (e) { console.error('[MKT] Falha no pipeline Amazon:', e.message); }
  } else if (/amazon|amzn|a\.co/i.test(texto)) {
    console.log('[MONITOR] Amazon ignorada em ' + jid.split('@')[0] + ' — ' + podeAmazon.motivo);
  }

  if (ehLinkMl(texto)) {
    const podeMl = podeCapturar(jid, 'Mercado Livre');
    if (!podeMl.ok) {
      console.log('[MONITOR] ML ignorado em ' + jid.split('@')[0] + ' — ' + podeMl.motivo);
    } else if (!credenciaisMlOk()) {
      console.warn('[ML] Link detectado mas ML_CLIENT_ID/ML_CLIENT_SECRET nao configurados.');
    } else {
      try { resultados.push(...await processarTextoMl(texto)); }
      catch (e) { console.error('[ML] Falha no pipeline:', e.message); }
    }
  }

  if (ehLinkMagalu(texto)) {
    const podeMagalu = podeCapturar(jid, 'Magazine Luiza');
    if (!podeMagalu.ok) {
      console.log('[MONITOR] Magalu ignorada em ' + jid.split('@')[0] + ' — ' + podeMagalu.motivo);
    } else {
      try { resultados.push(...await processarTextoMagalu(texto)); }
      catch (e) { console.error('[MAGALU] Falha no pipeline:', e.message); }
    }
  }

  if (ehLinkShopee(texto)) {
    const podeShopee = podeCapturar(jid, 'Shopee');
    if (!podeShopee.ok) {
      console.log('[MONITOR] Shopee ignorada em ' + jid.split('@')[0] + ' — ' + podeShopee.motivo);
    } else if (!credenciaisShopeeOk()) {
      console.warn('[SHOPEE] Link detectado mas SHOPEE_APP_ID/SHOPEE_SECRET nao estao configurados.');
    } else {
      try { resultados.push(...await processarTextoShopee(texto)); }
      catch (e) { console.error('[SHOPEE] Falha no pipeline:', e.message); }
    }
  }
  if (ehLinkAwin(texto)) {
    const prog = programaAwinPorUrl((texto.match(/https?:\/\/[^\s]+/) || [''])[0]);
    const lojaAwin = String(prog?.name || 'Awin').replace(/\s*\(?(BR|Global)\)?\s*$/i, '').trim();
    const podeAwin = podeCapturar(jid, lojaAwin);
    if (!podeAwin.ok) {
      console.log('[MONITOR] ' + lojaAwin + ' ignorada em ' + jid.split('@')[0] + ' — ' + podeAwin.motivo);
    } else {
      try { resultados.push(...await processarTextoAwin(texto, { clickref: 'grupo' })); }
      catch (e) { console.error('[AWIN] Falha no pipeline:', e.message); }
    }
  }

  if (!resultados.length) return;

  for (const r of resultados) {
    if (!r.mensagem) {
      console.log('[MKT] ' + (r.produto?.asin || r.produto?.itemId || '?') + ' descartado — ' + r.descartadoPor);
      continue;
    }
    const p = r.produto;

    // Cupom citado no post original que nao existe na base: sem a regra
    // (percentual, minimo, teto) o radar nao calcula o desconto e a oferta sai
    // pelo preco cheio. Aviso ao operador, sem travar o envio.
    const _cupSemBase = cupomCitadoDesconhecido(p.loja, texto);
    if (_cupSemBase.length) avisarCupomDesconhecido(p.loja, _cupSemBase, p, jid).catch(() => {});

    // Cupom declarado pelo proprio anuncio sem correspondente na base.
    if (r.avisoCupomPagina) avisarCupomAnuncioSemBase(r.avisoCupomPagina, p, jid).catch(() => {});

    const imagem = await baixarImagemProduto(p.imagemUrl);

    const oferta = {
      id: gerarId(),
      tipoConteudo: p.loja === 'Shopee' ? 'oferta_shopee'
                  : p.loja === 'Magazine Luiza' ? 'oferta_magalu'
                  : p.loja === 'Mercado Livre' ? 'oferta_ml' : 'oferta_amazon',
      origem: jid,
      conteudoOriginal: texto,
      mensagemFormatada: r.mensagem,
      dadosExtraidos: {
        loja: p.loja || 'Amazon',
        asin: p.asin,
        titulo: p.titulo,
        preco: p.preco,
        precoDe: p.precoDe,
        desconto: p.desconto,
        link: p.link,
        // URL original da imagem: a vitrine publica precisa de um endereco
        // hotlinkavel, e o base64 de oferta.imagens so serve ao WhatsApp.
        imagemUrl: p.imagemUrl || null,
        vendedor: p.vendedor,
        ehDeal: p.ehDeal,
        cupom: r.cupom || null,
        precoFinal: r.precoFinal ?? p.preco,
        // Magalu nao tem fonte verificavel de preco: o painel precisa avisar
        // antes da aprovacao que aquele valor veio do texto do grupo.
        precoDeReferencia: !!r.precoDeReferencia,
      },
      imagens: imagem ? [imagem] : [],
      // Nome do grupo resolvido na captura: no painel o jid sozinho nao diz nada,
      // e a lista de grupos pode nao estar carregada quando a fila renderiza.
      grupoOrigem: jid,
      grupoOrigemNome: (NOMES_GRUPOS.get(jid) || null),
      status: 'pendente',
      tenant: tenantContexto() || TENANT_PADRAO,
      timestamp: new Date().toISOString(),
    };

    // Cruzamento com os desejos de compra registrados. Fire-and-forget: roda em
    // paralelo e nunca lanca, para nao interferir no pipeline de ofertas.
    casarDesejosComOferta(oferta, {
      enviarAviso: (texto) => enviarMensagem(GRUPOS['operador'], { text: texto })
    }).catch(() => {});

    // AUTO_ENVIO_OFERTA: 'off' (tudo para a fila, padrao) | 'on' (dispara direto
    // nos destinos). Existe para validar o fluxo completo com grupo de teste;
    // apontar para grupo de cliente exige voltar para 'off' no Railway.
    // Uma oferta so chega aqui depois de passar por TODOS os filtros: preco
    // confirmado pela API, em estoque, desconto acima do minimo e fora do dedup.
    // Excecao: precoDeReferencia marca oferta cujo preco veio do TEXTO do grupo
    // e nao de fonte verificavel (caso da Magalu). Anunciar valor nao conferido
    // sem revisao humana ja produziu 'De/Por' inexistente — essas vao para a fila.
    if (AUTO_ENVIO_OFERTA === 'on' && !oferta.dadosExtraidos.precoDeReferencia) {
      try {
        const r = await enviarOfertaParaDestinos(oferta.mensagemFormatada, null, oferta);
        oferta.status = 'enviado';
        oferta.enviadoEm = new Date().toISOString();
        oferta.gruposEnviados = r.enviados;
        // Continua entrando na fila, agora como historico: alimenta o painel e
        // preserva o rastro de tudo que saiu.
        filaPendentes.unshift(oferta);
        salvarFila();
        console.log('[MKT] Oferta #' + oferta.id + ' ENVIADA direto — ' + p.asin
          + ' R$ ' + p.preco + ' -> ' + r.enviados.length + ' grupo(s)');
        continue;
      } catch (e) {
        // Falhou o envio: cai para a fila em vez de perder a oferta.
        console.error('[MKT] Auto-envio falhou (' + e.message + ') — indo para a fila.');
      }
    }

    filaPendentes.unshift(oferta);
    salvarFila();
    const _motivoFila = (AUTO_ENVIO_OFERTA === 'on' && oferta.dadosExtraidos.precoDeReferencia)
      ? ' — preco nao verificado, exige aprovacao manual' : '';
    console.log('[MKT] Oferta #' + oferta.id + ' na fila — ' + p.asin + ' R$ ' + p.preco + ' (' + p.desconto + '% off)' + _motivoFila);
  }
}

async function processarMensagem(msg) {
  try {
    const jid    = msg.key.remoteJid;
    // Dois monitoramentos convivem: GRUPOS_MONITORADOS alimenta o pipeline de
    // emissoes CDV; os grupos marcados como 'fonte' no painel alimentam o radar
    // de marketplace. Um grupo pode estar so em um dos dois.
    const _ehRadar = ehFonteRadar(jid);
    if (!GRUPOS_MONITORADOS.includes(jid) && !_ehRadar) return;
    const m    = desembrulharMessage(msg.message);
    const tipo = _TIPOS_TRATADOS.find(t => m && m[t]) || Object.keys(m || {})[0];
    let texto = '', imagemB64 = null;
    if (tipo === 'conversation') { texto = m.conversation; }
    else if (tipo === 'extendedTextMessage') { texto = m.extendedTextMessage.text; }
    else if (tipo === 'imageMessage') {
      texto = m.imageMessage.caption || '';
      try {
        const buffer = await downloadMediaMessage(msg,'buffer',{},{ logger:pino({level:'silent'}), reuploadRequest:sock.updateMediaMessage });
        imagemB64 = buffer.toString('base64');
      } catch(e) { console.error('[IMG] Erro ao baixar imagem:', e.message); if (!texto) texto = '[imagem sem legenda]'; }
    } else {
      // Antes: return silencioso. Agora loga o tipo não tratado de grupos
      // monitorados para nenhuma mensagem sumir sem rastro.
      const chaves = Object.keys(m || {});
      if (!chaves.every(k => _TIPOS_IGNORADOS.has(k))) {
        console.log('[MSG] Tipo não tratado de ' + jid.split('@')[0] + ': [' + chaves.join(', ') + '] — descartada.');
      }
      return;
    }
    if (!texto && !imagemB64) return;

    console.log('[MSG] Capturada de', jid.split('@')[0], '— tipo:', tipo, texto ? '| texto: '+texto.slice(0,60) : '| imagem');
    ultimaCapturaPorGrupo.set(jid, Date.now());

    if (texto && (
      texto.includes('Dica de emissao encontrada por @davileles') ||
      texto.includes('Dica de emissão encontrada por @davileles') ||
      texto.includes('Faca parte do Balcao clicando aqui') ||
      texto.includes('Faça parte do Balcão clicando aqui')
    )) { return; }

    // Radar de marketplace: sai antes do buffer de agrupamento, que e do
    // pipeline de emissoes CDV e nao sabe lidar com link de produto.
    if (_ehRadar) {
      await processarRadarMarketplace(jid, texto);
      if (!GRUPOS_MONITORADOS.includes(jid)) return;
    }

    if (!bufferAgrupamento.has(jid)) bufferAgrupamento.set(jid, { itens:[], timer:null });
    const entrada = bufferAgrupamento.get(jid);
    if (entrada.timer) clearTimeout(entrada.timer);
    entrada.timer = setTimeout(() => processarBuffer(jid), JANELA_AGRUPAMENTO_MS);
    entrada.itens.push({ texto, imagemBase64:imagemB64, timestamp:Date.now() });
  } catch(err) { console.error('Erro ao processar mensagem WA:', err.message); }
}

// ── WHATSAPP ──────────────────────────────────────────────────────────────────
var HEALTH_PING_MS   = 60 * 1000;   // ping leve a cada 60s (backstop p/ morte silenciosa)
var PING_TIMEOUT_MS  = 15 * 1000;   // sem resposta em 15s = falha
var PING_FALHAS_MAX  = 2;           // só reconecta após N pings falhos seguidos
var ultimoUpsert     = Date.now();
var healthTimer      = null;
var pingFalhas       = 0;

function _reconectarPorHealth(motivo) {
  console.log('[HEALTH] ' + motivo + ' Forçando reconexão...');
  conectado = false;
  isConnecting = false; // evita que reconexão seja ignorada por flag travada
  const sockRef = sock;
  sock = null;
  if (sockRef) { try { sockRef.end(new Error('health-ping-falhou')); } catch(e) {} }
  conectar();
}

// A detecção PRINCIPAL de queda continua sendo por eventos: o keepAliveIntervalMs
// do socket + o handler 'connection.update' (close) reconectam na hora.
// Aqui rodamos só um PING LEVE periódico como backstop para "morte silenciosa"
// (TCP meio-aberto: o socket parece vivo, mas está morto e nenhum evento de close
// dispara). Diferença crucial em relação ao antigo health-check: o ping NÃO derruba
// conexões saudáveis nem reage a canal quieto — só reconecta após PING_FALHAS_MAX
// pings sem resposta seguidos. Por ser leve, pode rodar a cada 60s sem causar churn,
// deixando a janela cega em ~60s em vez de minutos.
function resetarHealthTimer() {
  ultimoUpsert = Date.now();
  pingFalhas = 0;
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = setInterval(async () => {
    if (!conectado || !sock) return;  // queda real já é tratada por connection.update
    try {
      await Promise.race([
        sock.sendPresenceUpdate('available'),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), PING_TIMEOUT_MS)),
      ]);
      pingFalhas = 0;                 // respondeu → conexão viva, não faz nada
    } catch (e) {
      pingFalhas++;
      console.log('[HEALTH] Ping leve falhou (' + pingFalhas + '/' + PING_FALHAS_MAX + '): ' + e.message);
      if (pingFalhas >= PING_FALHAS_MAX) {
        pingFalhas = 0;
        _reconectarPorHealth('Ping leve sem resposta.');
      }
    }
  }, HEALTH_PING_MS);
}

var errosDescripto  = 0;
var ERROS_SOFT_MAX  = 8;   // 8 falhas seguidas → cura cirúrgica (só sender keys, sem reconectar)
var ERROS_DESCR_MAX = 20;  // 20 falhas seguidas → limpa sessions+sender keys (pre-keys preservadas)
var isResetting     = false; // true durante limpeza de sessão — bloqueia conexões/timers concorrentes
var _reconnectTimer = null;  // referência única do timer de reconexão pendente (evita corrida)

// Agenda uma única reconexão, cancelando qualquer timer pendente anterior.
function _agendarReconexao(delay) {
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); }
  _reconnectTimer = setTimeout(() => { _reconnectTimer = null; conectar(); }, delay);
}

async function limparSessaoEReconectar() {
  if (isResetting) { console.log('[WA] Reset já em andamento, ignorando chamada duplicada.'); return; }
  isResetting = true;
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  conectado = false;
  const sockRef = sock;
  sock = null;
  if (sockRef) { try { sockRef.end(new Error('bad-session')); } catch(e) {} }
  try {
    const arquivos = await readdir(SESSAO_DIR);
    for (const arq of arquivos) {
      // IMPORTANTE: NUNCA apagar arquivos 'pre-key-*'. As pre-keys locais precisam
      // bater com as registradas nos servidores do WhatsApp; apagá-las tornava
      // IMPOSSÍVEL decifrar qualquer nova sessão recebida (inclusive as re-tentativas
      // automáticas dos remetentes) → loop permanente de "Bad MAC" até novo QR.
      // Sessions e sender-keys são seguras de apagar: os remetentes as recriam
      // sozinhos via retry receipt, desde que as pre-keys estejam intactas.
      if (arq.startsWith('session-') || arq.startsWith('sender-key')) {
        await unlink(SESSAO_DIR + '/' + arq).catch(() => {});
      }
    }
  } catch(e) {}
  errosDescripto = 0;
  isResetting = false;
  _agendarReconexao(3000);
}

// Cura cirúrgica: apaga SOMENTE as sender keys (chaves de decodificação de grupos),
// sem derrubar a conexão e sem tocar em sessions/pre-keys. Como o auth state lê as
// chaves do disco sob demanda, o efeito é imediato: na próxima mensagem de cada
// grupo o Baileys envia retry receipt e o remetente redistribui a chave nova.
async function limparSenderKeys() {
  try {
    const arquivos = await readdir(SESSAO_DIR);
    let n = 0;
    for (const arq of arquivos) {
      if (arq.startsWith('sender-key')) {
        await unlink(SESSAO_DIR + '/' + arq).catch(() => {});
        n++;
      }
    }
    console.log('[WA] Cura cirúrgica: ' + n + ' sender keys apagadas (conexão mantida, remetentes redistribuirão as chaves).');
  } catch(e) { console.error('[WA] Erro na cura cirúrgica:', e.message); }
}

// Guarda as últimas mensagens ENVIADAS para responder retry receipts (getMessage).
const mensagensEnviadas = new Map();
function guardarMensagemEnviada(info) {
  try {
    if (info?.key?.id && info.message) {
      mensagensEnviadas.set(info.key.id, info.message);
      if (mensagensEnviadas.size > 300) mensagensEnviadas.delete(mensagensEnviadas.keys().next().value);
    }
  } catch(e) {}
}

// Última mensagem capturada por grupo monitorado (observabilidade em /status).
const ultimaCapturaPorGrupo = new Map();

// ── WHATSAPP ──────────────────────────────────────────────────────────────────
var isConnecting = false; // evita instâncias duplas de conexão

// ── CONEXÃO PERMANENTE ───────────────────────────────────────────────────────
// O servidor mantém conexão ativa para monitorar mensagens dos grupos.
// O health timer cuida de reconexão em caso de queda real.
// O inactivity timer foi removido — ele desconectava o sock a cada 5 min e
// fazia o servidor perder todas as mensagens dos grupos monitorados.
let inactivityTimer = null; // mantido por compatibilidade (não usado)

function resetarInactivityTimer() {
  // Conexão permanente — não desconecta por inatividade.
}

// Garante que sock está pronto; usa iniciarConexao() para evitar instâncias duplas.
async function conectarSeNecessario() {
  if (conectado && sock) return true;
  return await aguardarSock(20000);
}

// Backoff exponencial para reconexões: evita hammering no WhatsApp
let _reconectarTentativas = 0;
let _erros500Consecutivos = 0;

function _delayReconexao(codigo) {
  if (codigo === 440) {
    _reconectarTentativas++;
    _erros500Consecutivos = 0;
    const delay = Math.min(15000 * _reconectarTentativas, 60000);
    console.log('[WA] Connection Replaced (440). Reconectando em ' + (delay/1000) + 's (tentativa ' + _reconectarTentativas + ')...');
    return delay;
  }
  if (codigo === 500) {
    _erros500Consecutivos++;
    // Erros 500 são falhas de stream comuns em conexões longas — NUNCA apagar
    // sessão por causa deles. O wipe automático que existia aqui destruía as
    // chaves de decodificação dos grupos a cada instabilidade de rede e era a
    // causa raiz das mensagens sumirem da aba Alertas. Apenas reconectar com backoff.
    const delay = Math.min(5000 * _erros500Consecutivos, 60000);
    console.log('[WA] Stream error 500 (' + _erros500Consecutivos + ' seguido(s)). Reconectando em ' + (delay/1000) + 's...');
    return delay;
  } else {
    _erros500Consecutivos = 0;
  }
  _reconectarTentativas++;
  const delay = Math.min(5000 * Math.pow(2, _reconectarTentativas - 1), 60000);
  console.log('[WA] Erro (código ' + codigo + '). Reconectando em ' + (delay/1000) + 's...');
  return delay;
}

async function conectar() {
  if (isResetting) {
    console.log('[WA] Reset de sessão em andamento, adiando reconexão.');
    _agendarReconexao(3000);
    return;
  }
  if (isConnecting) {
    console.log('[WA] Conexão já em andamento, ignorando chamada duplicada.');
    return;
  }
  isConnecting = true;

  try {
    const { state, saveCreds } = await useAuthStateAtomico(SESSAO_DIR);
    const { version }          = await fetchLatestBaileysVersion();
    const novaSock = makeWASocket({
      version,
      auth: state,
      logger: baileysLogger,
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: true,
      // getMessage real: quando um destinatário não consegue decifrar uma mensagem
      // NOSSA, o WhatsApp pede reenvio (retry receipt). Devolver undefined fazia o
      // reenvio falhar e o destinatário ficar preso em "aguardando mensagem".
      getMessage: async (key) => mensagensEnviadas.get(key?.id),
      // Ignora status e newsletters: reduz drasticamente o volume de decodificação
      // (e de erros Bad MAC) de conteúdo que o servidor nunca usa.
      shouldIgnoreJid: (jid) => jid === 'status@broadcast' || (typeof jid === 'string' && jid.endsWith('@newsletter')),
      // Keepalive agressivo para detectar quedas mais rápido
      keepAliveIntervalMs: 30000,
    });
    sock = novaSock;
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) { qrAtual = await QRCode.toDataURL(qr); }
      if (connection === 'open') {
        conectado = true;
        qrAtual = null;
        errosDescripto = 0;
        isConnecting = false;
        _reconectarTentativas = 0;
        _erros500Consecutivos = 0;
        resetarHealthTimer();
        console.log('[WA] ✓ WhatsApp conectado!');
        // Aquece o cache de nomes: a fila mostra de qual grupo veio cada oferta.
        atualizarNomesGrupos().catch(()=>{});
      }
      if (connection === 'close') {
        // Ignora eventos de sock antigo (pode acontecer durante troca de instância)
        if (novaSock !== sock && sock !== null) {
          console.log('[WA] Evento de fechamento de sock antigo ignorado.');
          return;
        }
        conectado = false;
        isConnecting = false;
        sock = null;

        clearTimeout(inactivityTimer);
        if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
        const codigo = new Boom(lastDisconnect?.error)?.output?.statusCode;
        console.log('[WA] Conexão fechada. Código:', codigo);
        if (codigo === DisconnectReason.loggedOut) {
          console.log('[WA] Logout detectado. Escaneie o QR novamente em /qr');
          _reconectarTentativas = 0;
          // NÃO reconecta automaticamente
        } else {
          const delay = _delayReconexao(codigo);
          if (delay >= 0) _agendarReconexao(delay);
        }
      }
    });
    // Entradas e saidas de membros: evento que o WhatsApp ja mandava e o socket
    // descartava. Nao gera nenhuma requisicao — so escuta.
    sock.ev.on('group-participants.update', (u) => {
      try { registrarMovimentoMembros(u?.id, u?.participants, u?.action, u?.author); }
      catch(e) { console.error('[MEMBROS] Erro no handler:', e.message); }
    });
    // Grupo novo (criado agora ou em que a conta acabou de entrar). Sem isto o
    // cache NOMES_GRUPOS so era preenchido em connection==='open', entao grupo
    // criado depois da conexao ficava invisivel em GET /grupos ate reconectar.
    sock.ev.on('groups.upsert', (grupos) => {
      try {
        for (const g of (grupos || [])) {
          if (!g?.id) continue;
          NOMES_GRUPOS.set(g.id, g.subject || '(sem nome)');
          console.log('[GRUPOS] Novo grupo no cache: ' + (g.subject || g.id));
        }
      } catch(e) { console.error('[GRUPOS] Erro no handler de upsert:', e.message); }
    });
    // Renomeacao de grupo: mantem o nome do cache alinhado com o WhatsApp.
    sock.ev.on('groups.update', (grupos) => {
      try {
        for (const g of (grupos || [])) {
          if (!g?.id || !g.subject) continue;
          NOMES_GRUPOS.set(g.id, g.subject);
        }
      } catch(e) { console.error('[GRUPOS] Erro no handler de update:', e.message); }
    });
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      // Diagnostico: registra o evento CRU, antes de qualquer filtro. Sem isso
      // nao da para distinguir "socket nao recebe nada" de "recebe e descarta".
      try {
        for (const mm of (messages || [])) {
          _debugUpserts.push({
            em: new Date().toISOString(),
            type,
            jid: mm.key?.remoteJid || null,
            fromMe: !!mm.key?.fromMe,
            monitorado: GRUPOS_MONITORADOS.includes(mm.key?.remoteJid),
            fonteRadar: ehFonteRadar(mm.key?.remoteJid),
            chaves: mm.message ? Object.keys(mm.message) : null,
            stub: mm.messageStubType ?? null,
          });
          if (_debugUpserts.length > 60) _debugUpserts.shift();
        }
      } catch (e) {}
      if (conectado) resetarHealthTimer();
      if (type !== 'notify') {
        // Upserts 'append' (sync/reconexão) eram descartados sem rastro.
        // Loga quando envolvem grupos monitorados para diagnóstico de sumiços.
        const dosMonitorados = (messages || []).filter(mm => GRUPOS_MONITORADOS.includes(mm.key?.remoteJid));
        if (dosMonitorados.length > 0) {
          console.log('[WA] Upsert tipo "' + type + '" com ' + dosMonitorados.length + ' msg(s) de grupos monitorados DESCARTADA(S): ' + dosMonitorados.map(mm => mm.key?.remoteJid?.split('@')[0] + (mm.message ? ' [' + Object.keys(mm.message).join(',') + ']' : ' [sem message]')).join(' | '));
        }
        return;
      }
      for (const msg of messages) {
        if (msg.messageStubType === 2 || (msg.message === null && !msg.key.fromMe)) {
          errosDescripto++;
          console.warn('[WA] Mensagem indecifrável de ' + (msg.key?.remoteJid || '?') + ' (' + errosDescripto + ' seguidas). Baileys enviou retry receipt ao remetente.');
          if (errosDescripto === ERROS_SOFT_MAX) { limparSenderKeys(); }
          else if (errosDescripto >= ERROS_DESCR_MAX) { errosDescripto = 0; await limparSessaoEReconectar(); return; }
          continue;
        }
        if (msg.message) errosDescripto = 0; // decifrou com sucesso → sessão saudável
        // Campanha: resposta de um contato cancela o follow-up dele na hora.
        // Sem isto o sistema cobra quem ja respondeu — o pior erro possivel
        // numa campanha de recuperacao.
        campanhaMarcarResposta(msg).catch(() => {});
        // Enfileira por grupo: mesmo grupo = sequencial, grupos distintos = paralelo
        const jid = msg.key?.remoteJid;
        if (jid) {
          enfileirarPorGrupo(jid, () => processarMensagem(msg));
        } else {
          await processarMensagem(msg);
        }
      }
    });
    resetarHealthTimer();
  } catch (err) {
    console.error('[WA] Erro ao inicializar socket:', err.message);
    isConnecting = false;

    const delay = _delayReconexao(null);
    if (delay >= 0) _agendarReconexao(delay);
  }
}

// ── WORKER DE CAMPANHAS DE WHATSAPP ──────────────────────────────────────────
// Disparo individual para lista propria (nao e grupo). Le a campanha 'ativa' do
// proxy CDV, respeita janela/teto/intervalo e grava o status de volta a cada
// envio. So liga se CAMPANHAS_KEY existir no ambiente — a variavel e o
// kill switch: sem ela o modulo inteiro fica inerte.
const CAMPANHAS_KEY = process.env.CAMPANHAS_KEY || '';
const CAMP_LOG = (...a) => console.log('[CAMPANHA]', ...a);

let _campCicloRodando  = false;
let _campErrosSeguidos = 0;
let _campDesdeAPausa   = 0;
let _campPausaAte      = 0;
let _campUltimoEnvioMs = 0;
let _campIntervaloAlvo = 0;
const _campMidiaCache  = new Map();   // arquivo -> Buffer (carregado uma vez)
let _campJids          = new Map();   // jid -> { campanhaId, contatoId }

function campHeaders() {
  return { 'Content-Type': 'application/json', 'X-CDV-Op': CAMPANHAS_KEY };
}
async function campApi(rota, metodo, corpo) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(CDV_PROXY_URL + rota, {
      method: metodo || 'GET',
      headers: campHeaders(),
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: ctrl.signal
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.erro || ('status ' + r.status));
    return d;
  } finally { clearTimeout(t); }
}

// ── Tempo ────────────────────────────────────────────────────────────────────
function campPartesSP(ts) {
  const p = new Intl.DateTimeFormat('pt-BR', {
    timeZone: TZ_SP, weekday: 'short', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date(ts || Date.now()));
  const g = t => (p.find(x => x.type === t) || {}).value;
  return {
    dia: `${g('year')}-${g('month')}-${g('day')}`,
    minutos: parseInt(g('hour'), 10) * 60 + parseInt(g('minute'), 10),
    semana: String(g('weekday') || '').toLowerCase()
  };
}
function campHhmmParaMin(hhmm) {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}
function campDentroDaJanela(cfg) {
  const { minutos, semana } = campPartesSP();
  if (cfg.diasUteisApenas && /^(s[áa]b|dom)/.test(semana)) return false;
  const janelas = Array.isArray(cfg.janelas) ? cfg.janelas : [];
  if (!janelas.length) return false;
  return janelas.some(j => minutos >= campHhmmParaMin(j[0]) && minutos < campHhmmParaMin(j[1]));
}
// Conta pelos carimbos gravados nos contatos, nao por contador em memoria: o
// Railway reinicia o processo e o teto do dia nao pode zerar junto.
function campEnviosHoje(camp) {
  const hoje = campPartesSP().dia;
  return (camp.contatos || []).filter(c => {
    const ts = c.followupEm || c.enviadoEm;
    return ts && campPartesSP(Date.parse(ts)).dia === hoje;
  }).length;
}
function campAleatorio(min, max) {
  return Math.floor(min + Math.random() * Math.max(0, max - min));
}

// ── Variaveis e spintax (mesma regra da previa no gerador) ───────────────────
function campResolver(txt, ct) {
  let t = String(txt || '');
  t = t.replace(/\{([^{}]*\|[^{}]*)\}/g, (_, g) => {
    let partes = g.split('|');
    // {rotulo|opcao A|opcao B} — o primeiro pedaco e so rotulo, sai do sorteio
    if (partes.length > 2 && /^[a-zA-Z0-9_]+$/.test(partes[0].trim())) partes = partes.slice(1);
    return partes[Math.floor(Math.random() * partes.length)];
  });
  t = t.replace(/\{([a-zA-Z0-9_]+)\}/g, (m, k) =>
    (ct && ct[k] !== undefined && ct[k] !== null && ct[k] !== '') ? String(ct[k]) : m);
  return t;
}

async function campMidia(arquivo) {
  if (_campMidiaCache.has(arquivo)) return _campMidiaCache.get(arquivo);
  const d = await campApi('/campanhas/midia/' + encodeURIComponent(arquivo));
  const buf = Buffer.from(d.base64, 'base64');
  _campMidiaCache.set(arquivo, { buffer: buf, mime: d.mime || 'image/png' });
  return _campMidiaCache.get(arquivo);
}

async function campPatchContato(campanhaId, contatoId, patch) {
  try {
    await campApi('/campanhas/contato', 'POST', { campanhaId, contatoId, patch });
  } catch (e) {
    CAMP_LOG('Falha ao gravar status de ' + contatoId + ':', e.message);
  }
}

// ── Envio de um contato ──────────────────────────────────────────────────────
async function campEnviarContato(camp, ct, mensagem, ehFollowup) {
  const cfg = camp.config || {};

  // O ct.jid vem do gerador, montado como telefone + '@s.whatsapp.net'. Isso
  // erra em conta registrada sem o nono digito e o envio vira conversa
  // fantasma (ver resolverJidWhatsApp). A resolucao roda SEMPRE, independente
  // de verificarNumeroAntes: aquele flag decide se numero inexistente aborta,
  // nao se o JID deve ser confiavel.
  let jidDestino = ct.jid;
  {
    const alvo = await resolverJidWhatsApp(ct.telefone, ct.jid);
    if (!alvo.existe && cfg.verificarNumeroAntes !== false) {
      await campPatchContato(camp.id, ct.id, { status: 'erro', erro: 'numero sem WhatsApp' });
      CAMP_LOG('✗ ' + ct.nome + ' — numero sem WhatsApp.');
      return { enviado: false, contabiliza: false };
    }
    if (alvo.jid && alvo.jid !== jidDestino) {
      CAMP_LOG('↪ JID corrigido — ' + ct.nome + ': ' + jidDestino + ' → ' + alvo.jid);
      jidDestino = alvo.jid;
      await campPatchContato(camp.id, ct.id, { jid: jidDestino });
      ct.jid = jidDestino;   // o mapa de respostas deste ciclo ja usa o certo
      _campJids.set(jidDestino, { campanhaId: camp.id, contatoId: ct.id });
    }
  }

  const [dMin, dMax] = cfg.delayEntreMensagensSegundos || [20, 40];
  const blocos = mensagem.blocos || [];
  for (let i = 0; i < blocos.length; i++) {
    const b = blocos[i];
    let conteudo;
    if (b.tipo === 'imagem') {
      if (!b.arquivo) continue;
      const m = await campMidia(b.arquivo);
      conteudo = { image: m.buffer, mimetype: m.mime };
      if (b.legenda) conteudo.caption = campResolver(b.legenda, ct);
    } else {
      const txt = campResolver(b.conteudo, ct).trim();
      if (!txt) continue;
      conteudo = { text: txt };
    }
    // Passa pela mesma cadeia da fila de ofertas: nunca dois envios ao mesmo tempo
    await saidaSerializada(() => enviarMensagem(jidDestino, conteudo));
    if (i < blocos.length - 1) {
      await new Promise(r => setTimeout(r, campAleatorio(dMin * 1000, dMax * 1000)));
    }
  }

  const agora = new Date().toISOString();
  await campPatchContato(camp.id, ct.id, ehFollowup
    ? { followupEm: agora }
    : { status: 'enviado', enviadoEm: agora, erro: null, tentativasEnvio: (ct.tentativasEnvio || 0) + 1 });

  ultimoEnvioMs = Date.now();       // a fila de ofertas respeita o mesmo espacamento
  _campUltimoEnvioMs = Date.now();
  CAMP_LOG((ehFollowup ? '↻ follow-up' : '✓ enviado') + ' — ' + ct.nome);
  return { enviado: true, contabiliza: true };
}

// ── Escolha do proximo alvo ──────────────────────────────────────────────────
function campProximoAlvo(camp) {
  const fila = (camp.contatos || []).find(c => c.status === 'fila');
  if (fila) {
    const msg = (camp.mensagens || []).find(m => m.id === fila.mensagemId)
             || (camp.mensagens || []).find(m => m.segmento === fila.segmento)
             || (camp.mensagens || []).find(m => m.segmento === '*');
    return msg ? { ct: fila, mensagem: msg, followup: false } : null;
  }
  const f = camp.config && camp.config.followup;
  if (!f || !f.ativo || !f.variante) return null;
  const limite = Date.now() - (f.aposDias || 3) * 86400000;
  const alvo = (camp.contatos || []).find(c =>
    c.status === 'enviado' && !c.respondidoEm && !c.followupEm &&
    c.enviadoEm && Date.parse(c.enviadoEm) < limite);
  if (!alvo) return null;
  const msg = (camp.mensagens || []).find(m => m.id === f.variante);
  return msg ? { ct: alvo, mensagem: msg, followup: true } : null;
}

// ── Ciclo de 1 minuto ────────────────────────────────────────────────────────
async function campanhaCiclo() {
  if (_campCicloRodando) return;
  _campCicloRodando = true;
  try {
    const { campanha: camp } = await campApi('/campanhas/ativa');
    if (!camp) { _campJids = new Map(); return; }

    // Mapa de JIDs para o hook de resposta, refeito a cada ciclo
    const mapa = new Map();
    (camp.contatos || []).forEach(c => {
      if (c.jid && c.status !== 'respondido' && c.status !== 'optout') {
        mapa.set(c.jid, { campanhaId: camp.id, contatoId: c.id });
      }
    });
    _campJids = mapa;

    const cfg = camp.config || {};
    if (Date.now() < _campPausaAte) return;
    if (!campDentroDaJanela(cfg)) return;

    const hoje = campEnviosHoje(camp);
    if (hoje >= (cfg.limiteDiario || 15)) return;

    // Intervalo aleatorio, sorteado uma vez por envio — cadencia regular e padrao detectavel
    if (!_campIntervaloAlvo) {
      _campIntervaloAlvo = campAleatorio(
        (cfg.intervaloMinSegundos || 180) * 1000,
        (cfg.intervaloMaxSegundos || 480) * 1000);
    }
    if (_campUltimoEnvioMs && Date.now() - _campUltimoEnvioMs < _campIntervaloAlvo) return;
    // A fila de ofertas tambem conta: se uma oferta acabou de sair, espera
    if (ultimoEnvioMs && Date.now() - ultimoEnvioMs < _campIntervaloAlvo) return;

    const alvo = campProximoAlvo(camp);
    if (!alvo) {
      if (!(camp.contatos || []).some(c => c.status === 'fila')) {
        CAMP_LOG('Fila vazia — concluindo "' + camp.nome + '".');
        await campApi('/campanhas/status', 'POST', { campanhaId: camp.id, status: 'concluida' });
      }
      return;
    }

    try { await aguardarConectado(120000); }
    catch (e) { CAMP_LOG('Sem conexao:', e.message); return; }

    try {
      const r = await campEnviarContato(camp, alvo.ct, alvo.mensagem, alvo.followup);
      _campErrosSeguidos = 0;
      _campIntervaloAlvo = 0;
      if (r.contabiliza) {
        _campDesdeAPausa++;
        const cada = cfg.pausaLongaACada || 0;
        if (cada && _campDesdeAPausa >= cada) {
          const [pMin, pMax] = cfg.pausaLongaMinutos || [20, 30];
          const ms = campAleatorio(pMin * 60000, pMax * 60000);
          _campPausaAte = Date.now() + ms;
          _campDesdeAPausa = 0;
          CAMP_LOG('Pausa longa de ' + Math.round(ms / 60000) + ' min apos ' + cada + ' envios.');
        }
      }
    } catch (e) {
      _campErrosSeguidos++;
      _campIntervaloAlvo = 0;
      CAMP_LOG('✗ Erro em ' + alvo.ct.nome + ': ' + e.message + ' (' + _campErrosSeguidos + ' seguido(s))');
      await campPatchContato(camp.id, alvo.ct.id, {
        status: 'erro', erro: e.message, tentativasEnvio: (alvo.ct.tentativasEnvio || 0) + 1 });
      // Erros em sequencia = sessao quebrada ou bloqueio. Para tudo e avisa.
      if (_campErrosSeguidos >= (cfg.pararSeErrosSeguidos || 3)) {
        CAMP_LOG('PARANDO: ' + _campErrosSeguidos + ' erros seguidos.');
        await campApi('/campanhas/status', 'POST', { campanhaId: camp.id, status: 'pausada' }).catch(() => {});
        _campErrosSeguidos = 0;
      }
    }
  } catch (e) {
    CAMP_LOG('Ciclo falhou:', e.message);
  } finally {
    _campCicloRodando = false;
  }
}

// ── Hook de resposta (chamado do messages.upsert) ────────────────────────────
async function campanhaMarcarResposta(msg) {
  if (!CAMPANHAS_KEY) return;
  const jid = msg?.key?.remoteJid;
  if (!jid || msg.key.fromMe || jid.endsWith('@g.us')) return;
  const ref = _campJids.get(jid);
  if (!ref) return;
  _campJids.delete(jid);   // uma vez so: as proximas mensagens dele nao reescrevem
  CAMP_LOG('↩ resposta de ' + jid.split('@')[0] + ' — follow-up cancelado.');
  await campPatchContato(ref.campanhaId, ref.contatoId, {
    status: 'respondido', respondidoEm: new Date().toISOString() });
}

if (CAMPANHAS_KEY) {
  setInterval(() => { campanhaCiclo().catch(() => {}); }, 60000);
  CAMP_LOG('Worker ligado (ciclo de 1 min).');
} else {
  CAMP_LOG('Worker desligado — CAMPANHAS_KEY nao definida.');
}

// ── Rotas de campanha ────────────────────────────────────────────────────────
function campRotaAutorizada(req, res) {
  if (!CAMPANHAS_KEY) { res.status(503).json({ ok: false, erro: 'CAMPANHAS_KEY nao definida' }); return false; }
  if ((req.headers['x-cdv-op'] || '') !== CAMPANHAS_KEY) { res.status(401).json({ ok: false, erro: 'nao autorizado' }); return false; }
  return true;
}

app.post('/campanha/iniciar', async (req, res) => {
  if (!campRotaAutorizada(req, res)) return;
  const { campanhaId } = req.body || {};
  if (!campanhaId) return res.status(400).json({ ok: false, erro: 'campanhaId obrigatorio' });
  try {
    await campApi('/campanhas/status', 'POST', { campanhaId, status: 'ativa' });
    _campErrosSeguidos = 0; _campPausaAte = 0; _campIntervaloAlvo = 0;
    campanhaCiclo().catch(() => {});
    res.json({ ok: true, status: 'ativa' });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.post('/campanha/pausar', async (req, res) => {
  if (!campRotaAutorizada(req, res)) return;
  const { campanhaId } = req.body || {};
  if (!campanhaId) return res.status(400).json({ ok: false, erro: 'campanhaId obrigatorio' });
  try {
    await campApi('/campanhas/status', 'POST', { campanhaId, status: 'pausada' });
    res.json({ ok: true, status: 'pausada' });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.get('/campanha/status', async (req, res) => {
  if (!campRotaAutorizada(req, res)) return;
  try {
    const { campanha } = await campApi('/campanhas/ativa');
    if (!campanha) return res.json({ ok: true, ativa: null });
    const por = { fila: 0, enviado: 0, respondido: 0, erro: 0, optout: 0 };
    (campanha.contatos || []).forEach(c => { if (por[c.status] !== undefined) por[c.status]++; });
    res.json({
      ok: true,
      ativa: { id: campanha.id, nome: campanha.nome },
      contadores: por,
      enviosHoje: campEnviosHoje(campanha),
      limiteDiario: (campanha.config || {}).limiteDiario || null,
      dentroDaJanela: campDentroDaJanela(campanha.config || {}),
      pausaLongaAte: _campPausaAte > Date.now() ? new Date(_campPausaAte).toISOString() : null,
      errosSeguidos: _campErrosSeguidos,
      whatsappConectado: !!conectado
    });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});


// ── CSS DO PAINEL ─────────────────────────────────────────────────────────────
const PAINEL_CSS = `*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#0d0d0d;color:#f0f0f0;min-height:100vh}header{background:#111;border-bottom:1px solid #222;padding:16px 24px;display:flex;align-items:center;justify-content:space-between}header h1{font-size:18px;color:#ffa500}header .nav a{color:#aaa;text-decoration:none;margin-left:16px;font-size:14px}header .nav a:hover{color:#ffa500}.container{max-width:960px;margin:0 auto;padding:24px 16px}.badge{background:#ffa500;color:#000;font-size:11px;font-weight:700;padding:2px 7px;border-radius:10px;margin-left:6px}.empty{text-align:center;color:#555;padding:60px 0;font-size:15px}.card{background:#161616;border:1px solid #222;border-radius:12px;margin-bottom:16px;overflow:hidden}.card-header{padding:12px 16px;background:#1a1a1a;border-bottom:1px solid #222;display:flex;align-items:center;gap:8px;font-size:13px;color:#aaa;flex-wrap:wrap}.card-header .id{color:#ffa500;font-weight:700;font-size:14px}.tag{background:#252525;padding:2px 8px;border-radius:6px;font-size:11px}.tag-iv{background:#1a2e1a;color:#22c55e}.tag-ida{background:#1a1f2e;color:#60a5fa}.tag-exec{background:#2e1a2e;color:#c084fc}.tag-eco{background:#1a2020;color:#67e8f9}.tag-tsp{background:#2e1a00;color:#ffa500}.card-body{display:grid;grid-template-columns:1fr 1fr}.col{padding:16px}.col+.col{border-left:1px solid #222}.col-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#444;margin-bottom:10px}.imgs-grid{display:flex;flex-wrap:wrap;gap:8px}.imgs-grid img{width:calc(50% - 4px);min-width:120px;border-radius:8px;object-fit:cover}.imgs-grid img:only-child{width:100%}.texto-orig{font-size:13px;color:#888;white-space:pre-wrap;word-break:break-word;margin-top:8px}.edit-area{width:100%;background:#0d0d0d;color:#f0f0f0;border:1px solid #2a2a2a;border-radius:8px;padding:12px;font-size:13px;font-family:inherit;line-height:1.7;resize:vertical;min-height:200px}.edit-area:focus{outline:none;border-color:#444}.card-footer{padding:12px 16px;border-top:1px solid #1a1a1a;display:flex;gap:10px;align-items:center;flex-wrap:wrap}.btn{padding:8px 20px;border-radius:8px;border:none;font-size:13px;font-weight:600;cursor:pointer;transition:opacity .15s}.btn:hover{opacity:.8}.btn-ap{background:#22c55e;color:#000}.btn-rej{background:#333;color:#aaa}.ok-ap{color:#22c55e;font-size:13px}.ok-rej{color:#555;font-size:13px}.buffer-bar{background:#1a1400;border:1px solid #3a2e00;border-radius:8px;padding:10px 16px;font-size:13px;color:#ffa500;margin-bottom:16px}.sep{color:#333;font-size:12px;text-transform:uppercase;letter-spacing:1px;margin:28px 0 12px}.tg-bar{background:#0d1a2e;border:1px solid #1a3a5e;border-radius:8px;padding:10px 16px;font-size:13px;margin-bottom:16px;display:flex;align-items:center;gap:8px}.tg-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}.tg-dot-on{background:#22c55e}.tg-dot-off{background:#555}.tg-dot-wait{background:#ffa500}@media(max-width:600px){.card-body{grid-template-columns:1fr}.col+.col{border-left:none;border-top:1px solid #1a1a1a}.imgs-grid img{width:100%}}`;

// ── ROTAS ─────────────────────────────────────────────────────────────────────

// ── TELEGRAM DO OPERADOR (fase 2.4b) — API JSON para o painel ────────────────
// ── BOT DO TELEGRAM (criacao manual de cupom / oferta / mensagem) ────────────
// Responde 200 na hora e processa depois: a Bot API reenvia o update se a
// resposta demorar, e um reenvio no meio do wizard duplicaria o passo.
app.post(BOT_TSP_PATH, (req, res) => {
  res.sendStatus(200);
  tratarUpdateBotTsp(req.body).catch(e => console.error('[BOT-TSP] Erro:', e.message));
});

app.get('/tg/estado', (req, res) => {
  if (req.tenantId === TENANT_PADRAO) {
    return res.json({ ok:true, tenant:'tsp', conectado: tgConectado, authState: tgAuthState, conta: tgConta });
  }
  const st = tgEstadoTenant(req.tenantId);
  res.json({ ok:true, tenant: req.tenantId, conectado: st.conectado, authState: st.authState, conta: st.conta, erro: st.erro });
});

app.post('/tg/conectar', (req, res) => {
  if (req.tenantId === TENANT_PADRAO) {
    return res.status(400).json({ ok:false, erro:'a conexao da operacao padrao usa /tg-auth' });
  }
  iniciarTelegramTenant(req.tenantId).catch(() => {});
  res.json({ ok:true, mensagem:'Conectando — acompanhe /tg/estado e responda em /tg/auth quando pedir telefone/codigo.' });
});

app.post('/tg/auth', (req, res) => {
  const valor = String(req.body?.valor || '').trim();
  if (!valor) return res.status(400).json({ ok:false, erro:'valor vazio' });
  if (req.tenantId === TENANT_PADRAO) {
    if (!tgAuthResolve) return res.status(400).json({ ok:false, erro:'nenhuma autenticacao em andamento' });
    tgAuthResolve(valor); tgAuthResolve = null; tgAuthReject = null;
    return res.json({ ok:true });
  }
  const st = tgEstadoTenant(req.tenantId);
  if (!st.resolve) return res.status(400).json({ ok:false, erro:'nenhuma autenticacao em andamento — chame /tg/conectar' });
  const r = st.resolve; st.resolve = null; st.reject = null; st.authState = 'processando';
  r(valor);
  res.json({ ok:true });
});

app.delete('/tg/sessao', async (req, res) => {
  if (req.tenantId === TENANT_PADRAO) {
    return res.status(400).json({ ok:false, erro:'a sessao da operacao padrao nao e removida por aqui' });
  }
  const st = tgTenants.get(req.tenantId);
  try { if (st?.client) await st.client.disconnect(); } catch {}
  tgTenants.delete(req.tenantId);
  try {
    const p = SESSAO_DIR + '/tenants/' + req.tenantId + '/telegram_session.txt';
    if (existsSync(p)) unlinkSync(p);
  } catch {}
  res.json({ ok:true });
});

// ── ADMINISTRACAO DO REGISTRO (fase 2.5) ─────────────────────────────────────
// So a operacao padrao AUTENTICADA (token valido de e-mail da raiz) gerencia
// operadores. A superficie publica sem token continua so com a leitura mascarada.
function ehAdminRaiz(req) { return req.tenantId === TENANT_PADRAO && req.autenticado === true; }

app.get('/tenants/admin', (req, res) => {
  if (!ehAdminRaiz(req)) return res.status(403).json({ ok:false, erro:'somente o administrador autenticado' });
  res.json({ ok:true, tenants: listarTenants() });
});

app.post('/tenants', (req, res) => {
  if (!ehAdminRaiz(req)) return res.status(403).json({ ok:false, erro:'somente o administrador autenticado' });
  try {
    const t = criarTenant(req.body || {});
    console.log('[TENANTS] Operador "' + t.id + '" criado pelo painel.');
    res.json({ ok:true, tenant: t });
  } catch (e) { res.status(400).json({ ok:false, erro: e.message }); }
});

app.patch('/tenants/:id', (req, res) => {
  if (!ehAdminRaiz(req)) return res.status(403).json({ ok:false, erro:'somente o administrador autenticado' });
  try {
    const t = atualizarTenant(String(req.params.id || ''), req.body || {});
    res.json({ ok:true, tenant: t });
  } catch (e) { res.status(400).json({ ok:false, erro: e.message }); }
});

app.get('/tg-auth', (req, res) => {
  const estado = tgAuthState;
  const conectadoTg = tgConectado;

  if (conectadoTg) {
    return res.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Telegram Auth</title><style>body{font-family:sans-serif;background:#0d0d0d;color:#f0f0f0;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;gap:16px}h2{color:#22c55e}a{color:#ffa500}</style></head><body><h2>✅ Telegram conectado!</h2><p>Monitorando ${TG_CANAIS_MONITORADOS.map(c=>'@'+c).join(', ')}</p><a href="/painel">Ir para o painel</a></body></html>`);
  }

  const labels = {
    'aguardando_telefone': { titulo: 'Digite seu número do Telegram', placeholder: '+5511999999999', campo: 'telefone' },
    'aguardando_codigo':   { titulo: 'Digite o código de verificação', placeholder: '12345', campo: 'codigo' },
    'aguardando_senha':    { titulo: 'Digite sua senha do Telegram (2FA)', placeholder: 'sua senha', campo: 'senha' },
    'erro':                { titulo: 'Erro na autenticação', placeholder: '', campo: '' },
  };

  const info = labels[estado] || { titulo: 'Aguardando...', placeholder: '', campo: '' };

  res.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Telegram Auth</title>
<style>body{font-family:-apple-system,sans-serif;background:#0d0d0d;color:#f0f0f0;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;gap:20px;padding:24px}h2{color:#ffa500;font-size:20px}input{background:#1a1a1a;border:1px solid #333;border-radius:8px;color:#f0f0f0;font-size:16px;padding:12px 16px;width:280px;outline:none}input:focus{border-color:#ffa500}button{background:#ffa500;color:#000;border:none;border-radius:8px;font-size:15px;font-weight:700;padding:12px 32px;cursor:pointer}p{color:#888;font-size:14px;text-align:center;max-width:300px}.ok{color:#22c55e}.err{color:#ef4444}</style></head>
<body>
<h2>🔐 Autenticação Telegram</h2>
<p>${info.titulo}</p>
${info.campo ? `<input type="text" id="val" placeholder="${info.placeholder}" autocomplete="off"/>
<button onclick="enviar()">Confirmar</button>
<p id="msg"></p>
<script>
async function enviar(){
  const v = document.getElementById('val').value.trim();
  if(!v) return;
  const r = await fetch('/tg-auth/submit', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({valor: v, campo: '${info.campo}'})});
  const d = await r.json();
  const m = document.getElementById('msg');
  if(d.ok){ m.className='ok'; m.textContent='✓ Enviado! Aguardando próximo passo...'; setTimeout(()=>location.reload(), 2000); }
  else { m.className='err'; m.textContent='Erro: '+d.erro; }
}
document.getElementById('val').addEventListener('keydown', e => { if(e.key==='Enter') enviar(); });
</script>` : `<p class="${estado === 'erro' ? 'err' : ''}">${estado === 'erro' ? 'Ocorreu um erro. Verifique os logs do servidor.' : 'Inicializando conexão com o Telegram...'}</p><script>setTimeout(()=>location.reload(), 3000)</script>`}
</body></html>`);
});

app.post('/tg-auth/submit', (req, res) => {
  const { valor } = req.body;
  if (!valor?.trim()) return res.status(400).json({ ok:false, erro:'Valor vazio.' });
  if (!tgAuthResolve) return res.status(400).json({ ok:false, erro:'Nenhuma autenticação em andamento.' });
  tgAuthResolve(valor.trim());
  tgAuthResolve = null;
  tgAuthReject  = null;
  res.json({ ok:true });
});

app.get('/', (req, res) => {
  const pendentes = filaPendentes.filter(o => o.status==='pendente').length;
  const emBuffer  = [...bufferAgrupamento.values()].reduce((s,e) => s+e.itens.length, 0);
  const statusWA  = conectado ? 'WhatsApp conectado' : qrAtual ? 'Aguardando QR' : 'Desconectado';
  const statusTG  = tgConectado ? 'Telegram conectado' : 'Telegram desconectado';
  res.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>CDV Server</title><style>body{font-family:sans-serif;background:#0d0d0d;color:#f0f0f0;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;gap:16px;margin:0}h1{color:#ffa500}p{color:#aaa;font-size:14px}.links{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;margin-top:8px}a{color:#ffa500;text-decoration:none;border:1px solid #333;padding:9px 20px;border-radius:8px;font-size:14px}a:hover{border-color:#ffa500}</style></head><body><h1>CDV Baileys Server</h1><p>${statusWA}</p><p>${statusTG}</p>${emBuffer>0?'<p>'+emBuffer+' item(ns) na janela</p>':''}<div class="links">${!conectado?'<a href="/qr">Escanear QR WhatsApp</a>':''}${!tgConectado?'<a href="/tg-auth">Conectar Telegram</a>':''}<a href="/painel">Painel${pendentes>0?' ('+pendentes+')':''}</a><a href="/status">Status</a><a href="/grupos">Grupos</a></div></body></html>`);
});

app.get('/qr', (req, res) => {
  if (conectado) return res.send('<html><body style="background:#0d0d0d;color:#ffa500;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:16px"><h2>WhatsApp ja conectado!</h2><a href="/" style="color:#ffa500">Voltar</a></body></html>');
  // Dispara conexão se ainda não estiver conectando (modo lazy)
  if (!isConnecting && !sock) iniciarConexao();
  if (!qrAtual)  return res.send('<html><head><meta http-equiv="refresh" content="3"></head><body style="background:#0d0d0d;color:#f0f0f0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh"><h2>Gerando QR...</h2></body></html>');
  res.send('<html><head><title>QR</title><meta http-equiv="refresh" content="30"><style>body{background:#0d0d0d;color:#f0f0f0;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;gap:16px;margin:0}h2{color:#ffa500}img{border:4px solid #ffa500;border-radius:12px;width:260px}p{color:#aaa;font-size:.9rem;text-align:center}</style></head><body><h2>Escanear QR Code</h2><img src="'+qrAtual+'" alt="QR"/><p>WhatsApp - Dispositivos conectados - Conectar dispositivo</p></body></html>');
});

// ── CONTAS SECUNDARIAS ───────────────────────────────────────────────────────
app.get('/contas', (req, res) => {
  // Cada operador ve SO as proprias contas (pelo apelido, sem o prefixo
  // interno). O socket principal e da operacao padrao — operador novo nao o ve.
  const extras = [...contasExtras.values()]
    .filter(c => tenantDaConta(c.id) === req.tenantId)
    .map(c => ({
      id: apelidoDaConta(c.id), conectado: c.conectado, conectando: c.conectando,
      qrDisponivel: !!c.qr, ultimoEnvio: c.ultimoEnvio, ultimoErro: c.ultimoErro,
    }));
  res.json({
    ok: true,
    principal: req.tenantId === TENANT_PADRAO
      ? { id:'principal', conectado, conectando: isConnecting, qrDisponivel: !!qrAtual }
      : null,
    extras,
    turnosTsp: turnosTsp(),
    contaAgora: contaDoTurno(),
  });
});

app.post('/contas/:id/conectar', async (req, res) => {
  const apelido = String(req.params.id || '').trim();
  if (!/^[a-z0-9_-]{2,24}$/i.test(apelido)) {
    return res.status(400).json({ ok:false,
      erro: 'apelido invalido: use de 2 a 24 caracteres, so letras sem acento, numeros, - e _' });
  }
  const id = contaIdDe(req.tenantId, apelido);
  // 'principal' sem prefixo e o socket da operacao padrao; para um operador,
  // 't-<id>-principal' e uma conta secundaria como outra qualquer.
  if (!id || id === 'principal') return res.status(400).json({ ok:false, erro:'use /reconectar para a conta principal' });
  conectarConta(id).catch(()=>{});
  res.json({ ok:true, mensagem:'Conectando. Abra /contas/' + apelido + '/qr para parear.' });
});

app.get('/contas/:id/qr', async (req, res) => {
  const id = contaIdReq(req);
  // NAO usa estadoConta() aqui: ela CRIA a conta se nao existir. Como esta
  // pagina se auto-recarrega a cada 3-30s, uma aba esquecida aberta ressuscitava
  // a conta a cada refresh — inclusive depois de excluida pelo painel.
  // Criar conta e responsabilidade exclusiva do POST /contas/:id/conectar.
  const c = contasExtras.get(id);
  if (!c) {
    return res.status(404).send('<html><body style="background:#0d0d0d;color:#f0f0f0;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:12px;margin:0"><h2 style="color:#ffa500">Conexao "' + id + '" nao existe</h2><p style="color:#aaa">Ela foi removida ou ainda nao foi criada. Pode fechar esta aba.</p><p style="color:#aaa">Para criar: painel Gestao TSP - aba Conexao - Gerar QR.</p></body></html>');
  }
  if (c.conectado) return res.send('<html><body style="background:#0d0d0d;color:#ffa500;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh"><h2>Conta ' + id + ' ja conectada!</h2></body></html>');
  if (!c.qr) return res.send('<html><head><meta http-equiv="refresh" content="3"></head><body style="background:#0d0d0d;color:#f0f0f0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh"><h2>Gerando QR de ' + id + '...</h2></body></html>');
  res.send('<html><head><title>QR ' + id + '</title><meta http-equiv="refresh" content="30"><style>body{background:#0d0d0d;color:#f0f0f0;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;gap:16px;margin:0}h2{color:#ffa500}img{border:4px solid #ffa500;border-radius:12px;width:260px}p{color:#aaa;font-size:.9rem;text-align:center}</style></head><body><h2>Parear conta: ' + id + '</h2><img src="' + c.qr + '" alt="QR"/><p>WhatsApp - Dispositivos conectados - Conectar dispositivo</p></body></html>');
});

// Remove uma conta secundaria: desvincula o dispositivo no WhatsApp, apaga as
// credenciais e tira a conta da escala. Sem isso, um pareamento que deu errado
// fica cadastrado para sempre e ainda aparece como opcao de turno — e um turno
// apontando para conta morta cai no fallback em silencio, dando a impressao de
// que a escala funciona.
app.delete('/contas/:id', async (req, res) => {
  const apelido = String(req.params.id || '').trim();
  if (!/^[a-z0-9_-]{2,24}$/i.test(apelido)) return res.status(400).json({ ok:false, erro:'apelido invalido' });
  const id = contaIdDe(req.tenantId, apelido);
  if (!id || id === 'principal') return res.status(400).json({ ok:false, erro:'a conta principal nao pode ser removida aqui' });

  const c = contasExtras.get(id);
  let desvinculou = false;
  if (c) {
    // Uma reconexao ja agendada ou um connection.update em voo recolocaria a
    // conta no mapa depois do delete. A flag faz esses caminhos desistirem.
    c.removida = true;
    clearTimeout(c.timer);
    if (c.sock) {
      // logout() desvincula o aparelho na lista de dispositivos conectados.
      // Sessao ja quebrada costuma falhar aqui — nesse caso so encerra o socket,
      // e o dispositivo orfao pode ser removido pelo proprio celular.
      try { await c.sock.logout(); desvinculou = true; }
      catch (e) { try { c.sock.end(new Error('conta removida')); } catch(_) {} }
    }
    contasExtras.delete(id);
  }

  try { await rmAsync(CONTAS_DIR + '/' + id, { recursive: true, force: true }); }
  catch (e) { return res.status(500).json({ ok:false, erro:'nao apagou as credenciais: ' + e.message }); }

  // Turnos que apontavam para ela sairiam do ar sem aviso: melhor removê-los.
  const escala = turnosTsp();
  const restantes = escala.turnos.filter(t => t.conta !== apelidoDaConta(id));
  let turnosRemovidos = escala.turnos.length - restantes.length;
  if (turnosRemovidos) salvarTurnosTsp({ ativo: escala.ativo, turnos: restantes });

  console.log('[CONTA:' + id + '] removida' + (desvinculou ? ' (dispositivo desvinculado)' : '')
    + (turnosRemovidos ? ' — ' + turnosRemovidos + ' turno(s) descartado(s)' : '') + '.');
  res.json({ ok:true, desvinculou, turnosRemovidos });
});

// Compara os grupos das duas contas. Um numero que nao esta num grupo de destino
// falha o envio na hora do turno dele — melhor descobrir antes.
app.get('/contas/:id/grupos', async (req, res) => {
  const id = contaIdReq(req);
  const c = contasExtras.get(id);
  if (!c?.conectado || !c.sock) return res.status(503).json({ ok:false, erro:'conta ' + id + ' nao conectada' });
  try {
    const daConta = Object.keys(await c.sock.groupFetchAllParticipating());
    const alvos = [...new Set([...radarDestinos(), ...GRUPOS['tsp_cupons']])];
    const ausentes = (lista) => [...new Set(lista)]
      .filter(j => !daConta.includes(j))
      .map(j => ({ jid:j, nome: NOMES_GRUPOS.get(j) || null }));

    // Resposta padrao = so grupos de destino do TSP. E o que o painel de gestao
    // do TSP consome, e grupo do CDV nao diz respeito aquele painel.
    const resposta = {
      ok: true,
      total: daConta.length,
      faltando: ausentes(alvos),
      conferidos: alvos.length,
    };

    // Escopo ampliado (?escopo=tudo): grupos de LEITURA do ecossistema CDV.
    // Hoje quem le e sempre a conta principal, entao isso nao afeta envio nenhum.
    // Serve para responder "posso promover esta conta a principal sem cegar o
    // radar de emissoes?" — se faltar grupo aqui, o pipeline para em silencio.
    if (String(req.query.escopo || '') === 'tudo') {
      const fontes = radarFontes();
      resposta.leitura = {
        monitorados: {
          conferidos: GRUPOS_MONITORADOS.length,
          faltando: ausentes(GRUPOS_MONITORADOS),
        },
        fontesRadar: {
          conferidos: [...new Set(fontes)].length,
          faltando: ausentes(fontes),
        },
      };
      resposta.leitura.aptaAPrincipal =
        resposta.leitura.monitorados.faltando.length === 0 &&
        resposta.leitura.fontesRadar.faltando.length === 0;
    }

    res.json(resposta);
  } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
});

app.post('/reconectar', async (req, res) => {
  console.log('[MANUAL] Reconexão forçada via /reconectar');
  conectado = false;
  isConnecting = false;
  _reconectarTentativas = 0;

  const sockRef = sock;
  sock = null;
  if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
  if (sockRef) { try { sockRef.end(new Error('manual-reconnect')); } catch(e) {} }
  _agendarReconexao(1000);
  res.json({ ok: true, mensagem: 'Reconectando... aguarde 10s e verifique /status' });
});

app.get('/debug-upserts', (req, res) => {
  res.json({
    ok: true,
    total: _debugUpserts.length,
    ultimoEventoEm: _debugUpserts.length ? _debugUpserts[_debugUpserts.length - 1].em : null,
    eventos: _debugUpserts.slice().reverse(),
  });
});

app.get('/debug-fila', (req, res) => {
  try {
    const raw = readFileSync(FILA_PATH, 'utf-8');
    const dados = JSON.parse(raw);
    res.json({ total: dados.length, itens: dados });
  } catch(e) {
    res.json({ erro: e.message });
  }
});

app.get('/status', (req, res) => {
  const emBuffer = [...bufferAgrupamento.values()].reduce((s,e) => s+e.itens.length, 0);
  res.json({ conectado, sockAtivo:!!sock, qrDisponivel:!!qrAtual, telegramConectado:tgConectado, telegramAuthState:tgAuthState, telegramGrupos:TG_CANAIS_MONITORADOS, autoEnvioCupom:AUTO_ENVIO_MODO, telegramConta:tgConta, grupos:Object.keys(GRUPOS), gruposMonitorados:GRUPOS_MONITORADOS, radarFontes:radarFontes(), radarDestinos:radarDestinos(), radarAtivo:radarConfig().ativo!==false, bufferAtivo:emBuffer, filaPendentes:filaPendentes.filter(o=>o.status==='pendente').length, filaTotal:filaPendentes.length, reconectarTentativas:_reconectarTentativas, conexaoEmAndamento:!!_conexaoPromise, errosDecodificacao:errosDescripto, ultimasCapturas:Object.fromEntries([...ultimaCapturaPorGrupo].map(([j,t])=>[j, new Date(t).toISOString()])) });
});

app.get('/fila-envio', (req, res) => {
  const itens = filaEnvio.map((item, idx) => ({
    posicao:  idx + 1,
    ofertaId: item.ofertaId,
    destino:  item.destino,
    preview:  item.mensagem.substring(0, 80) + (item.mensagem.length > 80 ? '...' : ''),
  }));
  const espera = msAteJanela();
  const horaSP_ = horaSP();
  res.json({
    total:         filaEnvio.length,
    workerAtivo:   workerRodando,
    dentroJanela:  espera === 0,
    horaSP:        horaSP_,
    janelaEnvio:   `${HORA_INICIO_ENVIO}h–${HORA_FIM_ENVIO}h SP`,
    msAteJanela:   espera,
    intervaloMinutos: INTERVALO_ENVIO_MS / 60000,
    itens,
  });
});

app.delete('/fila-envio/:ofertaId', (req, res) => {
  const id = req.params.ofertaId;
  const idx = filaEnvio.findIndex(i => String(i.ofertaId) === String(id));
  if (idx === -1) return res.status(404).json({ ok: false, erro: 'Item não encontrado na fila' });
  filaEnvio.splice(idx, 1);
  console.log('[FILA] Item #' + id + ' removido manualmente da fila. Restam ' + filaEnvio.length);
  res.json({ ok: true, removido: id, total: filaEnvio.length });
});

app.delete('/fila-envio', (req, res) => {
  const total = filaEnvio.length;
  filaEnvio.splice(0, filaEnvio.length);
  console.log('[FILA] Fila de envio limpa manualmente. ' + total + ' itens removidos.');
  res.json({ ok: true, removidos: total });
});

app.post('/fila-envio/marcar-enviado/:ofertaId', (req, res) => {
  const id = req.params.ofertaId;
  const oferta = filaPendentes.find(o => String(o.id) === String(id));
  if (!oferta) return res.status(404).json({ ok: false, erro: 'Oferta #' + id + ' não encontrada' });
  oferta.status = 'enviado';
  salvarFila();
  console.log('[FILA] Oferta #' + id + ' marcada como enviado manualmente.');
  res.json({ ok: true, id, statusAnterior: oferta.status });
});

app.post('/fila-envio/marcar-todas-enviado', (req, res) => {
  const aprovadas = filaPendentes.filter(o => o.status === 'aprovado');
  aprovadas.forEach(o => { o.status = 'enviado'; });
  salvarFila();
  console.log('[FILA] ' + aprovadas.length + ' oferta(s) marcada(s) como enviado manualmente.');
  res.json({ ok: true, marcadas: aprovadas.length, ids: aprovadas.map(o => o.id) });
});

// ── FILA DO RADAR (ofertas de bonificação aprovadas pelo gerador-cdv) ─────────
// Intervalo de 3 min entre envios, sem janela horária (envia a qualquer hora)
const RADAR_INTERVALO_MS = 3 * 60 * 1000;
const filaRadar = []; // { id, mensagem, grupo, tentativas }
let radarWorkerRodando = false;
let radarUltimoEnvioMs = 0;

async function radarWorker() {
  if (radarWorkerRodando) return;
  radarWorkerRodando = true;
  console.log('[RADAR] Worker iniciado. Itens na fila: ' + filaRadar.length);
  while (filaRadar.length > 0) {
    const decorrido = Date.now() - radarUltimoEnvioMs;
    const espera = radarUltimoEnvioMs === 0 ? 0 : Math.max(0, RADAR_INTERVALO_MS - decorrido);
    if (espera > 0) {
      console.log('[RADAR] Aguardando ' + Math.round(espera / 1000) + 's antes do próximo envio...');
      await new Promise(r => setTimeout(r, espera));
    }
    try {
      await aguardarConectado();
    } catch(e) {
      console.error('[RADAR] ' + e.message + '. Aguardando 30s.');
      await new Promise(r => setTimeout(r, 30000));
      continue;
    }
    const item = filaRadar[0];
    if (!item) break;
    try {
      console.log('[RADAR] Enviando oferta "' + item.id + '" para ' + item.grupo + ' (' + filaRadar.length + ' na fila)');
      await enviarMensagem(item.grupo, { text: item.mensagem });
      filaRadar.shift();
      radarUltimoEnvioMs = Date.now();
      console.log('[RADAR] ✓ Oferta "' + item.id + '" enviada. Restam ' + filaRadar.length + '.');
    } catch(e) {
      console.error('[RADAR] ✗ Erro ao enviar "' + item.id + '":', e.message);
      item.tentativas = (item.tentativas || 0) + 1;
      if (item.tentativas >= 3) {
        console.error('[RADAR] Desistindo após 3 tentativas: ' + item.id);
        filaRadar.shift();
      }
      await new Promise(r => setTimeout(r, 10000));
    }
  }
  radarWorkerRodando = false;
  console.log('[RADAR] Worker encerrado (fila vazia).');
}

// POST /radar/enviar — enfileira uma oferta do radar para envio
app.post('/radar/enviar', (req, res) => {
  const { id, mensagem, grupo } = req.body || {};
  if (!mensagem?.trim()) return res.status(400).json({ ok: false, erro: 'mensagem obrigatória' });
  const grupoId = grupo ? (GRUPOS[grupo] || grupo) : GRUPOS['cdv_ofertas'];
  if (!grupoId) return res.status(400).json({ ok: false, erro: 'grupo inválido: ' + grupo });

  const posicao = filaRadar.length;
  filaRadar.push({ id: id || ('r_' + Date.now()), mensagem, grupo: grupoId, tentativas: 0 });

  const agora = Date.now();
  const decorrido = agora - radarUltimoEnvioMs;
  const esperaMs = radarUltimoEnvioMs === 0 ? 0 : Math.max(0, RADAR_INTERVALO_MS - decorrido);
  const totalMs = esperaMs + posicao * RADAR_INTERVALO_MS;
  const minutos = Math.round(totalMs / 60000);

  console.log('[RADAR] Oferta "' + (id || '?') + '" enfileirada na posição ' + (posicao + 1));
  radarWorker().catch(e => { console.error('[RADAR] Worker erro:', e.message); radarWorkerRodando = false; });

  res.json({ ok: true, posicao: posicao + 1, minutos, total: filaRadar.length });
});

// GET /radar/fila — inspecionar a fila do radar
app.get('/radar/fila', (req, res) => {
  res.json({
    total: filaRadar.length,
    workerAtivo: radarWorkerRodando,
    intervaloMinutos: RADAR_INTERVALO_MS / 60000,
    itens: filaRadar.map((item, idx) => ({
      posicao: idx + 1,
      id: item.id,
      tentativas: item.tentativas || 0,
      preview: item.mensagem.substring(0, 80) + (item.mensagem.length > 80 ? '...' : ''),
    })),
  });
});

app.get('/painel', (req, res) => {
  const pendentes   = filaPendentes.filter(o => o.status==='pendente');
  const processados = filaPendentes.filter(o => o.status!=='pendente');
  const emBuffer    = [...bufferAgrupamento.values()].reduce((s,e) => s+e.itens.length, 0);

  const tgStatusDot = tgConectado ? 'tg-dot-on' : (tgAuthState && tgAuthState !== 'ok' && tgAuthState !== 'erro' ? 'tg-dot-wait' : 'tg-dot-off');
  const tgStatusTxt = tgConectado ? `Telegram conectado — monitorando ${TG_CANAIS_MONITORADOS.map(c=>'@'+c).join(', ')}` : (tgAuthState === 'aguardando_telefone' || tgAuthState === 'aguardando_codigo' || tgAuthState === 'aguardando_senha' ? `Telegram aguardando autenticação — <a href="/tg-auth" style="color:#ffa500">clique aqui para autenticar</a>` : `Telegram desconectado — <a href="/tg-auth" style="color:#ffa500">conectar</a>`);

  const renderCard = (o) => {
    const data = new Date(o.timestamp).toLocaleString('pt-BR');
    const d    = o.dadosExtraidos || {};
    const isTSP = o.tipoConteudo === 'cupom_tsp';

    if (isTSP) {
      const loja  = nomeLojaExibicao(d.loja);
      const valor = d.valor || '';
      const tipo  = d.tipo === 'pct' ? '%' : ' R$';
      const cod   = d.codigo ? `<span class="tag">${d.codigo}</span>` : '';
      const textoHtml = o.conteudoOriginal ? `<div class="texto-orig">${o.conteudoOriginal}</div>` : '';
      if (o.status==='aprovado'||o.status==='enviado')  return `<div class="card"><div class="card-header"><span class="id">#${o.id}</span><span class="tag tag-tsp">📦 Cupom TSP</span><span style="color:#f0f0f0;font-weight:600">${loja} ${valor}${tipo}</span>${cod}<span style="margin-left:auto">${data}</span></div><div style="padding:12px 16px"><span class="ok-ap">${o.status==='enviado'?'✓ Enviado':'Aprovado e enviado'}</span></div></div>`;
      if (o.status==='agendado') return `<div class="card"><div class="card-header"><span class="id">#${o.id}</span><span class="tag tag-tsp">📦 Cupom TSP</span><span style="color:#f0f0f0;font-weight:600">${loja} ${valor}${tipo}</span>${cod}<span style="margin-left:auto">${data}</span></div><div style="padding:12px 16px"><span class="ok-ap">📅 Agendado</span></div></div>`;
      if (o.status==='rejeitado') return `<div class="card"><div class="card-header"><span class="id">#${o.id}</span><span class="tag tag-tsp">📦 Cupom TSP</span><span style="color:#f0f0f0;font-weight:600">${loja} ${valor}${tipo}</span>${cod}<span style="margin-left:auto">${data}</span></div><div style="padding:12px 16px"><span class="ok-rej">Rejeitado</span></div></div>`;
      return `<div class="card" id="card-${o.id}"><div class="card-header"><span class="id">#${o.id}</span><span class="tag tag-tsp">📦 Cupom TSP</span><span style="color:#f0f0f0;font-weight:600">${loja} ${valor}${tipo}</span>${cod}<span style="font-size:12px;color:#555;margin-left:auto">${data}</span></div><div class="card-body"><div class="col"><div class="col-title">Original (Telegram)</div>${textoHtml}</div><div class="col"><div class="col-title">Mensagem formatada</div><textarea class="edit-area" id="msg-${o.id}">${o.mensagemFormatada}</textarea></div></div><div class="card-footer"><button class="btn btn-ap" onclick="aprovar(${o.id})">Aprovar e enviar</button><button class="btn btn-rej" onclick="rejeitar(${o.id})">Rejeitar</button><span id="fb-${o.id}" style="font-size:13px;margin-left:auto"></span></div></div>`;
    }

    const tipoTag   = d.tipo==='ida_volta'?'<span class="tag tag-iv">Ida e volta</span>':d.tipo==='ida'?'<span class="tag tag-ida">Somente ida</span>':'';
    const cabineTag = d.cabine==='Executiva'?'<span class="tag tag-exec">Executiva</span>':'<span class="tag tag-eco">Econômica</span>';
    const rota = d.origem&&d.destino?`<span style="color:#f0f0f0;font-weight:600">${d.origem} - ${d.destino}</span>`:'';
    const prog = d.programa?`<span class="tag">${d.programa}</span>`:'';
    const imgsHtml = (o.imagens||[]).length>0?'<div class="imgs-grid">'+(o.imagens.map(b=>'<img src="data:image/jpeg;base64,'+b+'" />')).join('')+'</div>':'';
    const textoHtml = o.conteudoOriginal?`<div class="texto-orig">${typeof o.conteudoOriginal === 'string' ? o.conteudoOriginal : o.conteudoOriginal.join?.('\n') || ''}</div>`:'';
    if (o.status==='aprovado'||o.status==='enviado')  return `<div class="card"><div class="card-header"><span class="id">#${o.id}</span>${rota}${tipoTag}${cabineTag}<span style="margin-left:auto">${data}</span></div><div style="padding:12px 16px"><span class="ok-ap">${o.status==='enviado'?'✓ Enviado':'Aprovado — na fila de envio'}</span></div></div>`;
    if (o.status==='agendado')  return `<div class="card"><div class="card-header"><span class="id">#${o.id}</span>${rota}${tipoTag}${cabineTag}<span style="margin-left:auto">${data}</span></div><div style="padding:12px 16px"><span class="ok-ap">📅 Agendado</span></div></div>`;
    if (o.status==='rejeitado') return `<div class="card"><div class="card-header"><span class="id">#${o.id}</span>${rota}${tipoTag}${cabineTag}<span style="margin-left:auto">${data}</span></div><div style="padding:12px 16px"><span class="ok-rej">Rejeitado</span></div></div>`;
    return `<div class="card" id="card-${o.id}"><div class="card-header"><span class="id">#${o.id}</span>${rota}${tipoTag}${cabineTag}${prog}<span style="margin-left:auto;font-size:12px;color:#555">${data}</span></div><div class="card-body"><div class="col"><div class="col-title">Original (${o.tipoConteudo})</div>${imgsHtml}${textoHtml}</div><div class="col"><div class="col-title">Mensagem formatada</div><textarea class="edit-area" id="msg-${o.id}">${o.mensagemFormatada}</textarea></div></div><div class="card-footer"><button class="btn btn-ap" onclick="aprovar(${o.id})">Aprovar e enviar</button><button class="btn btn-rej" onclick="rejeitar(${o.id})">Rejeitar</button><span id="fb-${o.id}" style="font-size:13px;margin-left:auto"></span></div></div>`;
  };

  res.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Painel CDV</title><style>${PAINEL_CSS}</style></head><body><header><h1>Painel${pendentes.length>0?' <span class="badge">'+pendentes.length+'</span>':''}</h1><nav class="nav"><a href="/">Inicio</a><a href="/painel">Atualizar</a></nav></header><div class="container"><div class="tg-bar"><div class="tg-dot ${tgStatusDot}"></div><span>${tgStatusTxt}</span></div>${emBuffer>0?'<div class="buffer-bar">'+emBuffer+' item(ns) aguardando janela de '+JANELA_AGRUPAMENTO_MS/60000+' min...</div>':''}${pendentes.length===0&&emBuffer===0?'<div class="empty">Nenhuma oferta pendente.</div>':pendentes.map(renderCard).join('')}${processados.length>0?'<div class="sep">Processados recentemente</div>'+processados.slice(0,10).map(renderCard).join(''):''}</div><script>async function aprovar(id){const msg=document.getElementById("msg-"+id).value;const fb=document.getElementById("fb-"+id);fb.textContent="Enviando...";fb.style.color="#aaa";const r=await fetch("/painel/aprovar/"+id,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({mensagem:msg})});const d=await r.json();if(d.ok){fb.style.color="#22c55e";fb.textContent="Enviado!";setTimeout(()=>{const c=document.getElementById("card-"+id);if(c)c.style.opacity=".35"},800)}else{fb.style.color="#ef4444";fb.textContent="Erro: "+d.erro}}async function rejeitar(id){const fb=document.getElementById("fb-"+id);const r=await fetch("/painel/rejeitar/"+id,{method:"POST"});const d=await r.json();if(d.ok){fb.style.color="#555";fb.textContent="Rejeitado";setTimeout(()=>{const c=document.getElementById("card-"+id);if(c)c.style.opacity=".35"},400)}}${emBuffer>0?'setTimeout(()=>location.reload(),30000);':''}</script></body></html>`);
});

app.post('/api/claude', async (req, res) => {
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', { method:'POST', headers:{ 'Content-Type':'application/json', 'x-api-key':process.env.ANTHROPIC_API_KEY, 'anthropic-version':'2023-06-01' }, body:JSON.stringify(req.body) });
    res.json(await resp.json());
  } catch(e) { res.status(500).json({ error:{ message:e.message } }); }
});

app.get('/grupos/nomes', (req, res) => {
  if (!NOMES_GRUPOS.size) atualizarNomesGrupos().catch(()=>{});
  res.json({ ok:true, nomes: Object.fromEntries(NOMES_GRUPOS) });
});

app.get('/painel-json', (req, res) => {
  try {
    limparFila(); // garante que cupons com +12h nunca apareçam no painel
    const emBuffer = [...bufferAgrupamento.values()].reduce((s,e) => s+e.itens.length, 0);
    // Fila por OPERADOR: cada um so ve o que e dele. Item antigo sem etiqueta
    // pertence a operacao padrao (todo o historico e dela).
    const ofertas = filaPendentes
      .filter(o => (o.tenant || TENANT_PADRAO) === req.tenantId)
      .slice(0,50).map(o => ({ ...o, conteudoOriginal: typeof o.conteudoOriginal==='string'?o.conteudoOriginal:(Array.isArray(o.conteudoOriginal)?o.conteudoOriginal.join('\n'):''), imagens:Array.isArray(o.imagens)?o.imagens:[] }));
    res.json({ ok:true, bufferAtivo:emBuffer, ofertas });
  } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
});

app.post('/painel/aprovar/:id', async (req, res) => {
  const id     = parseInt(req.params.id);
  const oferta = filaPendentes.find(o => String(o.id)===String(id));
  if (!oferta) return res.status(404).json({ ok:false, erro:'Oferta nao encontrada.' });
  // Dono: agir em item de outro operador e proibido (defesa alem do filtro de listagem).
  if ((oferta.tenant || TENANT_PADRAO) !== req.tenantId) return res.status(404).json({ ok:false, erro:'Oferta nao encontrada.' });
  if (!conectado || !sock) {
    const ok = await aguardarSock();
    if (!ok) return res.status(503).json({ ok:false, erro:'WhatsApp nao conectado.' });
  }
  const mensagem  = req.body.mensagem || oferta.mensagemFormatada;
  const agendarEm = req.body.agendarEm || null;

  // Campos corrigidos no painel entram em dadosExtraidos ANTES do envio, para
  // que o worker (unico ponto de gravacao definitiva) registre em
  // passagens.json exatamente o que foi revisado — e nao a extracao bruta da IA.
  const deFinal = aplicarDadosEditados(oferta, req.body.dados);
  if (req.body.dados) salvarFila();

  if (agendarEm) {
    const dispararEm = new Date(agendarEm).getTime();
    if (isNaN(dispararEm)) return res.status(400).json({ ok:false, erro:'Data inválida.' });
    const agId = gerarId();
    agendamentos.push({ id:agId, ofertaId:oferta.id, dados:oferta.dadosExtraidos || null, grupo:'cdv_emissao', mensagem, dispararEm, status:'aguardando', criadoEm:new Date().toISOString() });
    salvarAgendamentos();
    oferta.status = 'agendado'; oferta.mensagemFinal = mensagem; salvarFila();
    const horario = new Intl.DateTimeFormat('pt-BR',{timeZone:TZ_SP,dateStyle:'short',timeStyle:'short'}).format(new Date(dispararEm));
    return res.json({ ok:true, agendado:true, horario });
  }

  if (oferta.tipoConteudo === 'cupom_tsp') {
    try {
      await enviarCupomParaGrupos(mensagem, oferta.imagens?.[0]);
      oferta.status = 'enviado'; oferta.mensagemFinal = mensagem; salvarFila();
      res.json({ ok:true });
    } catch(err) { res.status(500).json({ ok:false, erro: err.message }); }
    return;
  }

  if (TIPOS_OFERTA_MARKETPLACE.has(oferta.tipoConteudo)) {
    try {
      const r = await enviarOfertaParaDestinos(mensagem, oferta.imagens?.[0], oferta);
      oferta.status = 'enviado'; oferta.mensagemFinal = mensagem;
      oferta.destinos = r.enviados; oferta.falhas = r.falhas;
      salvarFila();
      res.json({ ok:true, enviados:r.enviados.length, falhas:r.falhas });
    } catch(err) { res.status(500).json({ ok:false, erro: err.message }); }
    return;
  }

  const info = calcularPosicaoFila(filaEnvio.length);
  oferta.status = 'aprovado'; oferta.mensagemFinal = mensagem; salvarFila();
  enfileirarEnvio(oferta.id, mensagem, GRUPOS[GRUPO_DESTINO_PASSAGENS], deFinal);
  res.json({ ok:true, posicao:info.posicao, tempoMin:info.tempoMin, horario:info.horario });
});

// ── Backfill: registra no proxy todos os 'enviados' que ainda não têm enviadoEm ─
app.post('/backfill-passagens', async (req, res) => {
  const force = req.body?.force === true;
  const enviados = filaPendentes.filter(o =>
    o.status === 'enviado' &&
    (force || !o.enviadoEm) &&
    o.tipoConteudo !== 'cupom_tsp' &&
    o.dadosExtraidos?.origem &&
    o.dadosExtraidos?.destino &&
    o.dadosExtraidos?.programa
  );
  console.log('[BACKFILL] Iniciando para ' + enviados.length + ' registros sem enviadoEm');
  let ok = 0, fail = 0;
  for (const oferta of enviados) {
    // Usa o timestamp original como data de envio
    const dataEnvio = oferta.timestamp || new Date().toISOString();
    oferta.enviadoEm = dataEnvio;
    const de = oferta.dadosExtraidos;
    try {
      await registrarPassagemProxy({
        origem:      de.origem,
        destino:     de.destino,
        cia:         de.cia || '',
        programa:    de.programa,
        pontos:      Number(de.pontos) || 0,
        cabine:      de.cabine || 'Economica',
        datas_ida:   de.datasIda || '',
        datas_volta: de.datasVolta || '',
        fonte:       'alerta',
      });
      ok++;
    } catch(e) {
      console.warn('[BACKFILL] Falha oferta #' + oferta.id + ':', e.message);
      fail++;
    }
  }
  salvarFila();
  console.log('[BACKFILL] Concluído: ' + ok + ' ok, ' + fail + ' falhas');
  res.json({ ok: true, processados: enviados.length, registrados: ok, falhas: fail });
});

app.get('/agendamentos', (req, res) => {
  // Os bytes do anexo ficam de fora: o painel so precisa saber que existe um,
  // e devolver base64 aqui deixaria a listagem pesada sem nenhum ganho.
  const lista = agendamentos.filter(a => a.status === 'aguardando').map(a => {
    const { anexo, ...resto } = a;
    return anexo
      ? { ...resto, anexo: { nomeArquivo: anexo.nomeArquivo || '', mimetype: anexo.mimetype || '', bytes: anexo.bytes || 0 } }
      : { ...resto, anexo: null };
  });
  res.json({ ok:true, agendamentos: lista });
});

app.delete('/agendamentos/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = agendamentos.findIndex(a => a.id === id);
  if (idx === -1) return res.status(404).json({ ok:false, erro:'Agendamento não encontrado.' });
  agendamentos[idx].status = 'cancelado';
  delete agendamentos[idx].anexo;
  salvarAgendamentos();
  res.json({ ok:true });
});

app.post('/painel/rejeitar/:id', (req, res) => {
  const id     = parseInt(req.params.id);
  const oferta = filaPendentes.find(o => String(o.id)===String(id));
  if (!oferta) return res.status(404).json({ ok:false, erro:'Oferta nao encontrada.' });
  // Dono: agir em item de outro operador e proibido (defesa alem do filtro de listagem).
  if ((oferta.tenant || TENANT_PADRAO) !== req.tenantId) return res.status(404).json({ ok:false, erro:'Oferta nao encontrada.' });
  oferta.status = 'rejeitado';
  salvarFila();
  res.json({ ok:true });
});

app.post('/painel/remover-imagem/:id', (req, res) => {
  const id     = parseInt(req.params.id);
  const oferta = filaPendentes.find(o => String(o.id)===String(id));
  if (!oferta) return res.status(404).json({ ok:false, erro:'Oferta nao encontrada.' });
  // Dono: agir em item de outro operador e proibido (defesa alem do filtro de listagem).
  if ((oferta.tenant || TENANT_PADRAO) !== req.tenantId) return res.status(404).json({ ok:false, erro:'Oferta nao encontrada.' });
  oferta.imagens = [];
  salvarFila();
  res.json({ ok:true });
});

app.post('/painel/reprocessar/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const oferta = filaPendentes.find(o => String(o.id)===String(id) && o.status==='pendente');
  if (!oferta) return res.status(404).json({ ok:false, erro:'Oferta não encontrada.' });
  try {
    const itens = [];
    for (const imgB64 of (oferta.imagens||[])) itens.push({ texto:oferta.conteudoOriginal||'', imagemBase64:imgB64, timestamp:Date.now() });
    if (itens.length===0 && oferta.conteudoOriginal) itens.push({ texto:oferta.conteudoOriginal, imagemBase64:null, timestamp:Date.now() });
    if (itens.length===0) return res.status(400).json({ ok:false, erro:'Sem conteúdo para reprocessar.' });
    const classificacoes = await classificarItens(itens, oferta.grupoOrigem||'');
    const validas = classificacoes.filter(c => c.valido);
    if (validas.length===0) return res.json({ ok:false, erro:'Nenhuma emissão válida encontrada.' });
    const emissoes = await agruparEFormatar(classificacoes);
    if (emissoes.length===0) return res.json({ ok:false, erro:'Agrupamento retornou 0 emissões.' });
    oferta.mensagemFormatada = emissoes[0].mensagem;
    oferta.dadosExtraidos    = emissoes[0];
    oferta.timestamp         = new Date().toISOString();
    salvarFila();
    res.json({ ok:true, mensagemFormatada:oferta.mensagemFormatada });
  } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
});

// ── Reformatar: regera a mensagem a partir dos campos editados no painel ─────
// O gerador envia os campos estruturados; aqui eles sobrescrevem dadosExtraidos
// e a mensagem e remontada pelo MESMO formatador usado na captura, garantindo
// que mensagem enviada e registro em passagens.json nunca divirjam.
app.post('/painel/reformatar/:id', async (req, res) => {
  const id     = parseInt(req.params.id);
  const oferta = filaPendentes.find(o => String(o.id)===String(id));
  if (!oferta) return res.status(404).json({ ok:false, erro:'Oferta nao encontrada.' });
  // Dono: agir em item de outro operador e proibido (defesa alem do filtro de listagem).
  if ((oferta.tenant || TENANT_PADRAO) !== req.tenantId) return res.status(404).json({ ok:false, erro:'Oferta nao encontrada.' });
  if (oferta.tipoConteudo === 'cupom_tsp') return res.status(400).json({ ok:false, erro:'Cupom TSP nao usa formatacao de emissao.' });
  try {
    const de = aplicarDadosEditados(oferta, req.body && req.body.dados);
    if (!de.origem || !de.destino || !de.programa) {
      return res.status(400).json({ ok:false, erro:'Origem, destino e programa sao obrigatorios.' });
    }
    const hist180 = await registrarPassagemProxy({
      origem:      de.origem,
      destino:     de.destino,
      cia:         de.cia || '',
      programa:    de.programa,
      pontos:      Number(de.pontos) || 0,
      cabine:      de.cabine || 'Economica',
      datas_ida:   de.datasIda || '',
      datas_volta: de.datasVolta || '',
      fonte:       'alerta_pendente',
      apenasConsulta: true,
    });
    oferta.mensagemFormatada = appendHistoricoMensagem(formatarMensagemCDV(de), hist180);
    salvarFila();
    res.json({ ok:true, mensagemFormatada: oferta.mensagemFormatada, dadosExtraidos: de });
  } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
});

// Reaplica links de afiliado nos cupons TSP pendentes sob demanda (sem restart)
app.post('/painel/reformatar-tsp', (req, res) => {
  try {
    const n = reformatarCupomsTSPPendentes();
    res.json({ ok:true, atualizados:n });
  } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
});

app.post('/painel/mesclar', (req, res) => {
  const { id1, id2 } = req.body;
  if (!id1||!id2) return res.status(400).json({ ok:false, erro:'ids necessarios.' });
  const o1 = filaPendentes.find(o => String(o.id)===String(id1)&&o.status==='pendente');
  const o2 = filaPendentes.find(o => String(o.id)===String(id2)&&o.status==='pendente');
  if (!o1||!o2) return res.status(404).json({ ok:false, erro:'Uma ou ambas não encontradas.' });
  if ((o1.tenant || TENANT_PADRAO) !== req.tenantId || (o2.tenant || TENANT_PADRAO) !== req.tenantId) {
    return res.status(404).json({ ok:false, erro:'Uma ou ambas não encontradas.' });
  }
  const toArray = v => Array.isArray(v)?v:(v?[v]:[]);
  o1.conteudoOriginal  = [...toArray(o1.conteudoOriginal),...toArray(o2.conteudoOriginal)];
  o1.imagens           = [...(o1.imagens||[]),...(o2.imagens||[])];

  // Mesclagem inteligente de datas de volta:
  // Se o1 tem bloco de volta vazio ("-") e o2 tem datas de ida, injeta em vez de concatenar.
  const datasVoltaO2 = (o2.dadosExtraidos && o2.dadosExtraidos.datasIda) || '';
  const blocoVoltaVazio = /(🛬 \*DATAS DE VOLTA\*\n)-\n/;
  if (datasVoltaO2 && blocoVoltaVazio.test(o1.mensagemFormatada||'')) {
    o1.mensagemFormatada = (o1.mensagemFormatada||'').replace(blocoVoltaVazio, '$1' + datasVoltaO2 + '\n');
    if (o1.dadosExtraidos) o1.dadosExtraidos.datasVolta = datasVoltaO2;
  } else {
    o1.mensagemFormatada = (o1.mensagemFormatada||'').trim()+'\n\n'+(o2.mensagemFormatada||'').trim();
  }

  o1.tipoConteudo = 'mesclado';
  o1.timestamp    = new Date().toISOString();
  o2.status = 'mesclado';
  salvarFila();
  res.json({ ok:true, id:o1.id, mensagemMesclada:o1.mensagemFormatada });
});

app.post('/painel/limpar', (req, res) => {
  const { confirmar, tipoConteudo, tiposConteudo } = req.body;
  if (confirmar!=='sim') return res.status(400).json({ ok:false, erro:'Envie { "confirmar": "sim" } para confirmar.' });
  // Filtro opcional de tipo, para o painel TSP nunca limpar as emissoes CDV.
  // Aceita lista (tiposConteudo) alem da string antiga: a fila do painel mostra
  // cupons E ofertas de marketplace, e limpar so 'cupom_tsp' deixava as ofertas
  // na tela — o botao parecia nao fazer nada.
  const tipos = tiposConteudo
    ? (Array.isArray(tiposConteudo) ? tiposConteudo : [tiposConteudo])
    : (tipoConteudo ? [tipoConteudo] : null);
  let removidos = 0;
  filaPendentes.forEach(o => {
    if ((o.tenant || TENANT_PADRAO) !== req.tenantId) return;  // so a fila do proprio operador
    if (o.status !== 'pendente') return;
    if (tipos && !tipos.includes(o.tipoConteudo)) return;
    o.status = 'rejeitado';
    removidos++;
  });
  salvarFila();
  console.log('[FILA] Limpeza manual — ' + removidos + ' item(ns) rejeitado(s)'
    + (tipos ? ' (tipos: ' + tipos.join(', ') + ')' : ' (todos os pendentes)') + '.');
  res.json({ ok:true, removidos });
});

app.post('/injetar', async (req, res) => {
  const { texto } = req.body;
  if (!texto?.trim()) return res.status(400).json({ ok:false, erro:'Texto vazio.' });
  // Cada injeção manual recebe seu PRÓPRIO grupo (id único) e é processada
  // isoladamente. Assim 1 injeção = 1 oferta: não há janela de 3 min
  // compartilhada (que quebrava as injeções em lotes conforme o tempo) nem
  // risco de o agrupamento por IA fundir rotas diferentes enviadas em sequência.
  const grupoFake = 'injecao_manual_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const entrada = { itens: [], timer: null };
  bufferAgrupamento.set(grupoFake, entrada);
  entrada.itens.push({ texto: texto.trim(), imagemBase64: null, timestamp: Date.now() });
  // Pequeno atraso só para a resposta HTTP retornar antes do processamento.
  entrada.timer = setTimeout(() => processarBuffer(grupoFake), 1500);
  res.json({ ok: true, grupo: grupoFake, bufferItens: entrada.itens.length });
});

app.post('/enviar', async (req, res) => {
  // direto:true → pula a fila de envio (intervalo de 10 min / janela 8h-21h SP).
  // Usado por mensagens unicas e datadas, como o resumo diario das 20h.
  // preview: { link, titulo, descricao, imagemUrl } — opcional. Existe para a
  // mensagem montada a mao no gerador sair com o mesmo card de link das ofertas
  // do radar. So vale no envio imediato: agendamento guarda apenas o texto.
  // tipo: 'cupom' | 'oferta' — so importa quando o grupo e um apelido multi.
  // Decide se os grupos so-cupons entram na lista de alvos.
  const { grupo, mensagem, agendarEm, direto, preview, anexo, tipo } = req.body;

  // Se sock nulo mas server está tentando reconectar, aguarda até 15s
  if (!conectado || !sock) {
    const ok = await aguardarSock(15000);
    if (!ok) return res.status(503).json({ ok:false, erro:'WhatsApp nao conectado. Acesse /qr para reconectar.' });
  }
  // Apelido multi ('tsp') nao resolve para um JID: a mensagem sai em todos os
  // grupos da aba Grupos. Agendado, o apelido e guardado como veio e a lista so
  // e resolvida no disparo.
  const multi   = ehGrupoMulti(grupo);
  const grupoId = multi ? null : resolverGrupo(grupo);
  if (!multi && !grupoId) return res.status(400).json({ ok:false, erro:'Grupo invalido: '+grupo });
  if (!mensagem?.trim()) return res.status(400).json({ ok:false, erro:'Mensagem vazia.' });

  if (agendarEm) {
    const dispararEm = new Date(agendarEm).getTime();
    if (isNaN(dispararEm)) return res.status(400).json({ ok:false, erro:'Data inválida.' });
    // Anexo agendado fica guardado em base64 no proprio agendamento. Tem teto:
    // agendamentos.json e lido inteiro a cada boot, entao um arquivo grande
    // demais penaliza todos os outros agendamentos, nao so o dele.
    let anexoGuardado = null;
    if (anexo?.base64) {
      const bruto = String(anexo.base64).replace(/^data:[^;]+;base64,/, '');
      const bytes = Math.floor(bruto.length * 3 / 4);
      if (bytes > AGEND_ANEXO_MAX_BYTES) {
        return res.status(413).json({ ok:false, erro:'Anexo de ' + Math.round(bytes/1024) +
          ' KB acima do limite de ' + Math.round(AGEND_ANEXO_MAX_BYTES/1024) + ' KB para envio agendado.' });
      }
      anexoGuardado = { base64: bruto, mimetype: String(anexo.mimetype || ''),
                        nomeArquivo: String(anexo.nomeArquivo || ''), bytes };
    }
    const id = gerarId();
    agendamentos.push({ id, grupo, mensagem, dispararEm, status:'aguardando', direto: !!direto,
                        tipo: tipo || null,
                        preview: preview?.link ? preview : null,
                        anexo: anexoGuardado,
                        criadoEm: new Date().toISOString() });
    salvarAgendamentos();
    const horario = new Intl.DateTimeFormat('pt-BR',{timeZone:TZ_SP,dateStyle:'short',timeStyle:'short'}).format(new Date(dispararEm));
    return res.json({ ok:true, agendado:true, id, horario });
  }

  if (multi) {
    try {
      const r = await enviarManualParaGrupos({ mensagem, tipo, preview });
      return res.json({ ok:true, enviados:r.enviados.length, falhas:r.falhas });
    } catch(err) { return res.status(500).json({ ok:false, erro:err.message }); }
  }

  const isEmissao = grupo==='cdv_emissao'||grupoId===GRUPOS['cdv_emissao'];
  if (isEmissao && !direto) {
    // Comprime datas consecutivas antes de enfileirar (ex: 1, 2, 3, 4 → 1-4)
    const mensagemComprimida = mensagem
      .split('\n')
      .map(linha => {
        const m = linha.match(/^([A-Za-záàãâéêíóôõúüçÁÀÃÂÉÊÍÓÔÕÚÜÇ]+\/\d{2}:)\s*(.+)$/);
        if (!m) return linha;
        const dias = m[2].match(/\d+/g);
        if (!dias || dias.length <= 2) return linha;
        const nums = dias.map(Number);
        return m[1] + ' ' + comprimirSequencia(nums);
      })
      .join('\n');
    const info = calcularPosicaoFila(filaEnvio.length);
    enfileirarEnvio('manual', mensagemComprimida, grupoId);
    res.json({ ok:true, posicao:info.posicao, tempoMin:info.tempoMin, horario:info.horario });
  } else {
    try {
      const lp = preview?.link ? await montarLinkPreviewManual(preview) : null;
      await enviarMensagem(grupoId, lp ? { text:mensagem, linkPreview:lp } : { text:mensagem });
      res.json({ ok:true, comPreview: !!lp });
    }
    catch(err) { res.status(500).json({ ok:false, erro:err.message }); }
  }
});

// ── ENVIAR ANEXO (imagem OU documento) ────────────────────────────────────────
// Handler unico usado por /enviar-imagem (retrocompatibilidade) e /enviar-arquivo.
// Aceita DOIS formatos:
//  1) multipart/form-data com campo 'imagem' (gerador-cdv) ou qualquer campo (/enviar-arquivo)
//  2) application/json { grupo, legenda, base64, mimetype, nomeArquivo } — concierge
// O tipo da mensagem e decidido pelo mimetype: image/* vai como imagem com legenda;
// qualquer outro (PDF, DOCX, XLSX, CSV...) vai como documento com caption e fileName.
const EXT_POR_MIME = {
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'text/csv': '.csv',
  'text/plain': '.txt',
  'text/html': '.html',
  'application/zip': '.zip',
};

async function enviarAnexoHandler(req, res, padraoImagem) {
  // tipoEnvio (nao 'tipo': o nome ja e usado mais abaixo para imagem/documento)
  const { grupo, legenda, base64, mimetype, nomeArquivo, tipo: tipoEnvio } = req.body;
  const file = req.file;
  const limpar = () => { try { if (file && existsSync(file.path)) unlinkSync(file.path); } catch(e) {} };

  if (!file && !base64) return res.status(400).json({ ok:false, erro:'Arquivo obrigatorio (campo: imagem/arquivo ou base64).' });

  if (!conectado || !sock) {
    const ok = await aguardarSock(15000);
    if (!ok) { limpar(); return res.status(503).json({ ok:false, erro:'WhatsApp nao conectado.' }); }
  }
  // Apelido multi ('tsp'): a mesma imagem sai em todos os grupos da aba Grupos.
  // Documento nao entra aqui de proposito — ver despacharAgendamentoMulti.
  if (ehGrupoMulti(grupo)) {
    try {
      const buf = file
        ? readFileSync(file.path)
        : Buffer.from(String(base64).replace(/^data:[^;]+;base64,/, ''), 'base64');
      if (!buf || !buf.length) throw new Error('Arquivo vazio ou base64 invalido.');
      const mtMulti = String(mimetype || (file && file.mimetype) || '');
      if (mtMulti && mtMulti.indexOf('image/') !== 0) {
        throw new Error('Envio para varios grupos aceita apenas imagem.');
      }
      const r = await enviarManualParaGrupos({
        mensagem: legenda || '',
        tipo:     tipoEnvio,
        imagem:   { imagemBase64: buf.toString('base64'), mime: mtMulti || 'image/jpeg' },
      });
      return res.json({ ok:true, tipo:'imagem', enviados:r.enviados.length, falhas:r.falhas });
    } catch(err) {
      console.error('[ANEXO] Erro no envio multi-grupo:', err.message);
      return res.status(500).json({ ok:false, erro:err.message });
    } finally { limpar(); }
  }

  const grupoId = resolverGrupo(grupo);
  if (!grupoId) { limpar(); return res.status(400).json({ ok:false, erro:'Grupo invalido: '+grupo }); }

  try {
    const buffer = file
      ? readFileSync(file.path)
      : Buffer.from(String(base64).replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (!buffer || !buffer.length) throw new Error('Arquivo vazio ou base64 invalido.');

    const mt   = String(mimetype || (file && file.mimetype) || '');
    const nome = String(nomeArquivo || (file && file.originalname) || '');
    // Sem mimetype: /enviar-imagem assume imagem (clientes antigos), /enviar-arquivo assume documento.
    const ehImagem = mt ? mt.indexOf('image/') === 0 : !!padraoImagem;
    const ehAudio  = mt.indexOf('audio/') === 0;

    let conteudo, tipo;
    if (ehImagem) {
      tipo = 'imagem';
      conteudo = { image: buffer, caption: legenda || '' };
      if (mt) conteudo.mimetype = mt;
    } else if (ehAudio) {
      tipo = 'audio';
      conteudo = { audio: buffer, mimetype: mt, ptt: false };
    } else {
      tipo = 'documento';
      conteudo = {
        document: buffer,
        mimetype: mt || 'application/octet-stream',
        fileName: nome || ('arquivo' + (EXT_POR_MIME[mt] || '')),
      };
      if (legenda && String(legenda).trim()) conteudo.caption = legenda;
    }

    await enviarMensagem(grupoId, conteudo);
    console.log('[ANEXO] ' + tipo + ' enviado para ' + grupoId + ' (' + buffer.length + ' bytes' + (nome ? ', ' + nome : '') + ')');
    res.json({ ok:true, tipo });
  } catch(err) {
    console.error('[ANEXO] Erro ao enviar anexo:', err.message);
    res.status(500).json({ ok:false, erro:err.message });
  }
  finally { limpar(); }
}

// Rota historica — mantida identica para gerador-cdv e clientes antigos.
app.post('/enviar-imagem', upload.single('imagem'), (req, res) => enviarAnexoHandler(req, res, true));

// Rota nova — aceita PDF, DOCX, XLSX, imagens etc. (multipart em qualquer campo ou JSON base64).
app.post('/enviar-arquivo', upload.any(), (req, res) => {
  if (!req.file && req.files && req.files.length) req.file = req.files[0];
  return enviarAnexoHandler(req, res, false);
});

// ── ENVIAR ÁUDIO / VOICEMAIL ──────────────────────────────────────────────────
// Aceita upload de arquivo de áudio (ogg, mp4, m4a, mp3, etc) via multipart
// e envia como mensagem de voz (PTT = push-to-talk) no grupo indicado.
app.post('/enviar-audio', upload.single('audio'), async (req, res) => {
  const { grupo } = req.body;
  const file = req.file;
  if (!file) return res.status(400).json({ ok:false, erro:'Arquivo de áudio obrigatório (campo: audio).' });

  // Conecta sob demanda antes de tentar enviar
  const ok = await aguardarSock(20000);
  if (!ok) {
    if (existsSync(file.path)) unlinkSync(file.path);
    return res.status(503).json({ ok:false, erro:'WhatsApp não conectado. Tente novamente em instantes.' });
  }

  const grupoId = resolverGrupo(grupo || 'cdv_ofertas');
  if (!grupoId) {
    if (existsSync(file.path)) unlinkSync(file.path);
    return res.status(400).json({ ok:false, erro:'Grupo inválido: ' + grupo });
  }

  try {
    const buffer   = readFileSync(file.path);
    const mimetype = file.mimetype || 'audio/ogg; codecs=opus';
    await enviarMensagem(grupoId, {
      audio:    buffer,
      mimetype: mimetype,
      ptt:      true,
    });
    console.log('[AUDIO] Áudio enviado para ' + grupoId + ' (' + buffer.length + ' bytes)');
    res.json({ ok:true });
  } catch(err) {
    console.error('[AUDIO] Erro ao enviar áudio:', err.message);
    res.status(500).json({ ok:false, erro:err.message });
  } finally {
    if (existsSync(file.path)) unlinkSync(file.path);
  }
});

// ── RADAR DE MARKETPLACE (TSP) ───────────────────────────────────────────────
// Nao confundir com /radar/* e filaRadar acima, que sao do Radar de Ofertas CDV.

// Config do radar de marketplace — a aba Grupos do painel Gestao TSP grava aqui.
app.get('/mkt/config', (req, res) => {
  const cfg = radarConfig();
  res.json({
    ok: true,
    papeis: cfg.papeis || {},
    ativo: cfg.ativo !== false,
    descontoMinimo: cfg.descontoMinimo,
    dedupHoras: cfg.dedupHoras,
    partnerTag: cfg.partnerTag,
    gatilhoPadrao: cfg.gatilhoPadrao || '',
    fontes: radarFontes(),
    destinos: radarDestinos(),
    credenciaisOk: !!(process.env.AMZ_CLIENT_ID && process.env.AMZ_CLIENT_SECRET),
    credenciaisShopeeOk: credenciaisShopeeOk(),
    autoEnvioOferta: AUTO_ENVIO_OFERTA,
    matchDesejos: MODO_DESEJOS,
    autoEnvioCupom: AUTO_ENVIO_MODO,
    janelaCupom: janelaCupom(),
    turnosTsp: turnosTsp(),
    contaAgora: contaDoTurno(),
  });
});

app.post('/mkt/config', (req, res) => {
  try {
    const permitido = {};
    for (const k of ['papeis','ativo','descontoMinimo','dedupHoras','partnerTag','gatilhoPadrao']) {
      if (req.body[k] !== undefined) permitido[k] = req.body[k];
    }
    const cfg = salvarRadarConfig(permitido);
    // Janela de cupons tem gravacao propria (valida os horarios antes de salvar).
    let janela = janelaCupom();
    if (req.body.janelaCupom !== undefined) {
      janela = salvarJanelaCupom(req.body.janelaCupom || {});
      console.log('[CUPONS] Janela de publicacao — ' + janela.inicio + '-' + janela.fim
        + ' (' + janela.dias + '), intervalo ' + janela.intervaloSeg + 's.');
    }
    let turnos = turnosTsp();
    if (req.body.turnosTsp !== undefined) {
      turnos = salvarTurnosTsp(req.body.turnosTsp || {});
      console.log('[TSP] Escala de numeros — ' + (turnos.ativo ? turnos.turnos.length + ' turno(s)' : 'desligada')
        + '. Agora: ' + contaDoTurno() + '.');
    }
    console.log('[MKT] Config atualizada — ' + radarFontes().length + ' fonte(s), ' + radarDestinos().length + ' destino(s).');
    res.json({ ok:true, papeis: cfg.papeis, fontes: radarFontes(), destinos: radarDestinos(),
               janelaCupom: janela, turnosTsp: turnos, contaAgora: contaDoTurno() });
  } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
});

// ── CONFIG DA OPERACAO (aba Configuracoes do painel Gestao TSP) ──────────────
app.get('/config-tsp', (req, res) => {
  // A config sai SEM os valores das credenciais: quem abre o painel ve o que
  // esta configurado, nao o segredo em si. O painel recebe so o estado
  // (preenchida, origem, ultimos 4 caracteres).
  const cfg = { ...configTsp(req.tenantId) };
  delete cfg.credenciais;
  const t = listarTenants().find(x => x.id === req.tenantId) || null;
  res.json({
    ok: true,
    tenant: t ? { id: t.id, nome: t.nome } : null,
    config: cfg,
    credenciais: estadoCredenciais(req.tenantId),
  });
});

app.post('/config-tsp', (req, res) => {
  try {
    const corpo = { ...(req.body || {}) };
    // Campo em branco no formulario significa "nao mexi nisso", nunca "apague a
    // credencial". Para limpar de proposito existe o valor especial '--'.
    if (corpo.credenciais && typeof corpo.credenciais === 'object') {
      const limpas = {};
      for (const [k, v] of Object.entries(corpo.credenciais)) {
        const s2 = String(v ?? '').trim();
        if (!s2) continue;
        limpas[k] = s2 === '--' ? '' : s2;
      }
      corpo.credenciais = limpas;
    }
    const cfg = salvarConfigTsp(corpo, req.tenantId);
    console.log('[CFG-TSP] Configuracao atualizada pelo painel (' + req.tenantId + ').');
    // Credencial nova so vale se os modulos rebuscarem o que depende dela: sem
    // isso, colar a chave da Awin no painel nao carregava catalogo nenhum ate o
    // proximo restart.
    if (req.tenantId === TENANT_PADRAO) {
      if (credenciaisAwinOk()) atualizarProgramasAwin(true).catch(() => {});
      if (credenciaisFeedOk()) atualizarFeedList(true).catch(() => {});
      agendarAwin();
    }
    const saida = { ...cfg };
    delete saida.credenciais;
    res.json({ ok: true, config: saida, credenciais: estadoCredenciais() });
  } catch (e) {
    res.status(400).json({ ok: false, erro: e.message });
  }
});

// ── REGISTRO DE OPERADORES ───────────────────────────────────────────────────
// Leitura publica MASCARADA: sem e-mails (endpoints do painel sao abertos; a
// gestao completa do registro entra junto do login por operador, na fase 2.5).
app.get('/tenants', (req, res) => {
  res.json({
    ok: true,
    atual: req.tenantId,
    tenants: listarTenants().map(t => ({ id: t.id, nome: t.nome, ativo: t.ativo, criadoEm: t.criadoEm })),
  });
});

// ── SINCRONIZACAO ────────────────────────────────────────────────────────────
app.get('/sync', async (req, res) => {
  const base = estadoSync();
  res.json({ ok:true, ...base, acesso: base.ativo ? await testarAcesso() : null });
});

app.post('/sync/push', async (req, res) => {
  if (!sincronizacaoAtiva()) return res.status(400).json({ ok:false, erro:'GITHUB_TOKEN nao configurado.' });
  try { res.json({ ok:true, enviados: await pushImediato() }); }
  catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
});

app.post('/sync/pull', async (req, res) => {
  if (!sincronizacaoAtiva()) return res.status(400).json({ ok:false, erro:'GITHUB_TOKEN nao configurado.' });
  try {
    const r = await baixarDoGitHub();
    carregarTenants(); carregarConfigTsp();
    carregarRadarConfig(); carregarCuponsBase(); carregarTemplates(); carregarVitrine();
    recarregarRadarTenants();
    res.json({ ok:true, ...r });
  } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
});

// ── AWIN (rede de afiliados) ─────────────────────────────────────────────────
// A Awin nao e uma loja: e uma rede com dezenas de anunciantes sob o mesmo
// token. E o que permite publicar cupom de loja que nao seja uma das quatro
// grandes sem perder a comissao.
app.get('/awin/estado', async (req, res) => {
  const base = estadoAwin();
  if (!base.configurado) return res.json({ ok:true, ...base });
  let quota = null;
  try { quota = await quotaLinkAwin(); } catch (e) { quota = { erro: e.message }; }
  res.json({ ok:true, ...base, quota });
});

app.get('/awin/programas', (req, res) => {
  const busca = String(req.query.q || '').trim().toLowerCase();
  let lista = listarProgramasAwin();
  if (busca) lista = lista.filter(p => (p.name || '').toLowerCase().includes(busca));
  lista.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'pt-BR'));
  res.json({ ok:true, total: lista.length, programas: lista });
});

app.post('/awin/programas/atualizar', async (req, res) => {
  try { res.json({ ok:true, total: (await atualizarProgramasAwin(true)).length }); }
  catch (e) { res.status(500).json({ ok:false, erro:e.message }); }
});

// Diagnostico: dado um nome de loja ou um link, mostra que programa responde.
app.get('/awin/resolver', (req, res) => {
  const loja = String(req.query.loja || '').trim();
  const url  = String(req.query.url || '').trim();
  const p = url ? programaAwinPorUrl(url) : (loja ? programaAwinPorLoja(loja) : null);
  if (!p) return res.json({ ok:false, erro:'nenhum programa afiliado para essa loja/link.' });
  res.json({ ok:true, advertiserId:p.id, nome:p.name, link:p.clickThroughUrl });
});

// Deeplink para uma URL especifica. O clickref viaja ate o relatorio de
// transacoes — e por ele que se descobre depois qual disparo gerou a venda.
app.post('/awin/link', async (req, res) => {
  try {
    const r = await gerarLinkAwin({
      url: req.body?.url,
      advertiserId: req.body?.advertiserId || null,
      clickref: req.body?.clickref || '',
      encurtar: req.body?.encurtar !== false,
    });
    res.json({ ok:true, ...r });
  } catch (e) { res.status(400).json({ ok:false, erro:e.message }); }
});

app.get('/awin/ofertas', async (req, res) => {
  try {
    const brutas = await buscarOfertasAwin({
      tipo:   req.query.tipo   || 'voucher',
      status: req.query.status || 'active',
      atualizadoDesde: req.query.desde || null,
    });
    res.json({ ok:true, total: brutas.length, ofertas: brutas.map(normalizarOfertaAwin) });
  } catch (e) { res.status(500).json({ ok:false, erro:e.message }); }
});

// Importa os vouchers ativos para a base de cupons. NAO dispara nada: so
// popula a base que a vitrine e o gerador ja consomem. Diferente da captura do
// Telegram, aqui a validade e a real do anunciante (endDate), nao um TTL fixo.
app.post('/awin/cupons/importar', async (req, res) => {
  try {
    const brutas = await buscarOfertasAwin({ tipo:'voucher', status: req.body?.status || 'active' });
    const importados = [], ignorados = [];
    for (const bruta of brutas) {
      const c = normalizarOfertaAwin(bruta);
      if (!c.codigo)            { ignorados.push({ loja:c.loja, motivo:'sem codigo' }); continue; }
      if (!c.tipo || !c.valor)  { ignorados.push({ loja:c.loja, codigo:c.codigo, motivo:'valor/tipo nao identificado no titulo' }); continue; }
      const reg = registrarCupomBase({
        loja: c.loja, codigo: c.codigo, tipo: c.tipo, valor: c.valor,
        minimo: c.minimo, limite: c.limite, maximo: c.maximo,
        validadeAte: c.validadeAte,
        observacao: 'Awin' + (c.atribuivel ? ' (atribuivel)' : '') + (c.exclusivo ? ' (exclusivo)' : ''),
      });
      if (reg) importados.push({ loja:reg.loja, codigo:reg.codigo, valor:reg.valor, tipo:reg.tipo, validadeAte:reg.validadeAte });
    }
    console.log('[AWIN] Importacao de cupons — ' + importados.length + ' ok, ' + ignorados.length + ' ignorado(s).');
    res.json({ ok:true, total: brutas.length, importados, ignorados });
  } catch (e) { res.status(500).json({ ok:false, erro:e.message }); }
});

// ── OFERTAS AUTOMATICAS A PARTIR DOS FEEDS ───────────────────────────────────
// Uma varredura acha centenas de produtos com desconto. O que impede isso de
// virar spam nao e o filtro de percentual — e a cota: teto por dia, teto por
// loja e bloqueio de repeticao, tudo aplicado em awin-ofertas.js. Aqui entram
// as duas ultimas travas: janela de horario e espacamento entre envios.
// Dois ritmos distintos: varrer os feeds e caro e roda de poucas em poucas
// horas; publicar e barato e roda de meia em meia hora. Ambos em funcao (nao
// const) para o painel mudar o ritmo sem redeploy.
function awinVarreduraMs()  { return Math.max(5, configOfertasAwin().varreduraMin) * 60 * 1000; }
function awinPublicacaoMs() { return Math.max(5, configOfertasAwin().intervaloMin) * 60 * 1000; }
let _varrendoAwin = false;

async function processarOfertasAwin({ simular = false } = {}) {
  const cfg = configOfertasAwin();
  if (cfg.modo === 'off' && !simular) return { ok:false, erro:'AWIN_OFERTAS=off' };
  if (_varrendoAwin) return { ok:false, erro:'ja ha uma varredura em andamento' };
  _varrendoAwin = true;

  try {
    // Fora da janela nao ha o que fazer: a proxima rodada tenta de novo.
    const janela = dentroDaJanelaAwin();
    if (!simular && !janela.ok) return { ok:true, pulada: janela.motivo, fila: estadoCandidatos() };

    const r = proximosCandidatos({ simular });
    const saida = { ok:true, simulacao: simular, modo: cfg.modo, usoHoje: usoDeHoje(),
      vagas: r.vagas, motivo: r.motivo, fila: estadoCandidatos(),
      enviadas: [], naFila: [], previa: [] };

    for (const c of r.escolhidos) {
      const p = {
        asin: 'AWIN-' + c.advertiserId + '-feed',
        codigo: c.urlLoja || '',
        titulo: c.titulo || '',
        preco: c.preco,
        precoDe: c.precoDe,
        precoTexto: 'R$ ' + c.preco.toFixed(2).replace('.', ','),
        precoDeTexto: c.precoDe ? 'R$ ' + c.precoDe.toFixed(2).replace('.', ',') : null,
        desconto: c.desconto,
        disponivel: true,
        link: c.linkAfiliado,
        imagemUrl: c.imagem || null,
        vendedor: null, marca: c.marca || '', nota: null, avaliacoes: null,
        dealTermina: null, ehDeal: false,
        loja: c.loja.replace(/\s*\(?(BR|Global)\)?\s*$/i, '').trim(),
        precoDeReferencia: true,   // preco de feed, nao lido do site agora
      };

      // Cupom vigente da propria loja, se algum se aplicar a este preco. E o
      // ganho de juntar as duas pontas: os cupons da Awin ja estao na base.
      const mc = melhorCupomAplicavel(p.loja, p.preco);
      const cupom = mc ? { reg: mc.reg, desconto: mc.desconto, citado: true } : null;
      const mensagem = formatarOfertaAwin(p, { cupom });

      if (simular) {
        saida.previa.push({ loja: p.loja, titulo: p.titulo, preco: p.preco, precoDe: p.precoDe,
          desconto: p.desconto, cupom: cupom?.reg?.codigo || null, mensagem });
        continue;
      }

      const oferta = {
        id: gerarId(), origem: 'awin-feed', tipoConteudo: 'oferta_awin',
        mensagemFormatada: mensagem,
        dadosExtraidos: {
          loja: p.loja, asin: p.asin, titulo: p.titulo, preco: p.preco, precoDe: p.precoDe,
          desconto: p.desconto, link: p.link,
          // URL da imagem para a vitrine publica (o base64 so serve ao WhatsApp).
          imagemUrl: p.imagemUrl || null,
          cupom: cupom ? { codigo: cupom.reg.codigo, desconto: cupom.desconto } : null,
          precoFinal: cupom ? Math.max(0, p.preco - cupom.desconto) : p.preco,
          precoDeReferencia: true,
        },
        imagens: [], status: 'pendente', tenant: tenantContexto() || TENANT_PADRAO, timestamp: new Date().toISOString(),
      };
      try {
        const img = await baixarImagemProduto(p.imagemUrl);
        if (img) oferta.imagens = [img];
      } catch {}

      // Consome a vaga assim que a oferta e aceita, mesmo indo para a fila: o
      // proposito do historico e nao repetir o produto, nao contar envios.
      marcarOfertado(c.chaveHistorico);

      if (cfg.modo === 'on') {
        try {
          const env = await enviarOfertaParaDestinos(oferta.mensagemFormatada, null, oferta);
          oferta.status = 'enviado';
          oferta.enviadoEm = new Date().toISOString();
          oferta.gruposEnviados = env.enviados;
          filaPendentes.unshift(oferta); salvarFila();
          saida.enviadas.push({ loja: p.loja, titulo: p.titulo, desconto: p.desconto });
          console.log('[AWIN-OFERTAS] Enviada — ' + p.loja + ' ' + p.desconto + '% — ' + p.titulo.slice(0, 40));
          // Espacamento so quando a rodada leva mais de uma: com maxRodada=1 o
          // proprio intervalo entre rodadas ja e o espacamento.
          if (r.escolhidos.length > 1) await new Promise(r2 => setTimeout(r2, intervaloAutoEnvioMs()));
          continue;
        } catch (e) {
          console.error('[AWIN-OFERTAS] Falha no envio, indo para a fila:', e.message);
        }
      }

      filaPendentes.unshift(oferta); salvarFila();
      saida.naFila.push({ loja: p.loja, titulo: p.titulo, desconto: p.desconto });
      console.log('[AWIN-OFERTAS] Na fila — ' + p.loja + ' ' + p.desconto + '% — ' + p.titulo.slice(0, 40));
    }
    return saida;
  } catch (e) {
    console.log('[AWIN-OFERTAS] Erro na varredura:', e.message);
    return { ok:false, erro:e.message };
  } finally { _varrendoAwin = false; }
}

carregarConfigOfertasAwin();
aplicarTtlsAwin();
carregarOfertadosAwin();
// Agendamento reprogramavel: cada rodada marca a proxima com o intervalo atual
// da config, entao alterar no painel muda o ritmo sem reiniciar o container.
let _timerVarredura = null, _timerPublicacao = null;
function agendarAwin() {
  if (_timerVarredura)  clearTimeout(_timerVarredura);
  if (_timerPublicacao) clearTimeout(_timerPublicacao);
  if (!credenciaisFeedOk() || configOfertasAwin().modo === 'off') return;

  _timerVarredura = setTimeout(async () => {
    try { await reabastecerCandidatosAwin(); } catch (e) { console.log('[AWIN-OFERTAS] ' + e.message); }
    agendarAwin();
  }, awinVarreduraMs());
  _timerVarredura.unref?.();

  _timerPublicacao = setTimeout(async () => {
    try { await processarOfertasAwin(); } catch (e) { console.log('[AWIN-OFERTAS] ' + e.message); }
    // Reagenda so a publicacao: a varredura tem ritmo proprio.
    _timerPublicacao = null;
    agendarPublicacaoAwin();
  }, awinPublicacaoMs());
  _timerPublicacao.unref?.();
}
function agendarPublicacaoAwin() {
  if (_timerPublicacao) clearTimeout(_timerPublicacao);
  if (!credenciaisFeedOk() || configOfertasAwin().modo === 'off') return;
  _timerPublicacao = setTimeout(async () => {
    try { await processarOfertasAwin(); } catch (e) { console.log('[AWIN-OFERTAS] ' + e.message); }
    agendarPublicacaoAwin();
  }, awinPublicacaoMs());
  _timerPublicacao.unref?.();
}
carregarCandidatosAwin();
if (credenciaisFeedOk() && configOfertasAwin().modo !== 'off') {
  const c = configOfertasAwin();
  // Primeira varredura logo apos o boot: sem fila, nao ha o que publicar.
  setTimeout(() => reabastecerCandidatosAwin().catch(() => {}), 90 * 1000);
  agendarAwin();
  console.log('[AWIN-OFERTAS] Ligada (modo ' + c.modo + ') — publica a cada '
    + c.intervaloMin + 'min entre ' + c.horaInicio + ' e ' + c.horaFim
    + ', ate ' + c.maxDia + '/dia; varredura a cada ' + (c.varreduraMin / 60) + 'h.');
}

// Varredura sob demanda: reabastece a fila sem publicar nada.
app.post('/awin/ofertas/varredura', async (req, res) => {
  const r = await reabastecerCandidatosAwin({ forcar: !!req.body?.forcar });
  res.status(r.ok ? 200 : 400).json(r);
});

app.get('/awin/ofertas/fila', (req, res) => {
  res.json({ ok:true, ...estadoCandidatos(), ...vagasAgora(), janela: dentroDaJanelaAwin() });
});

// A fila inteira, ranqueada, para o operador escolher na aba Vitrine. Traz o
// melhor cupom da base que se aplica a cada preco — e a informacao que decide
// se vale a pena disparar aquele item agora.
app.get('/awin/ofertas/candidatos', (req, res) => {
  const limite = Math.min(300, Math.max(1, Number(req.query.limite) || 150));
  const lista = candidatosRanqueados({ limite }).map(c => {
    const mc = melhorCupomAplicavel(c.loja, c.preco);
    return { ...c, cupom: mc ? { codigo: mc.reg.codigo, desconto: mc.desconto } : null,
             precoFinal: mc ? Math.max(0, c.preco - mc.desconto) : c.preco };
  });
  res.json({ ok:true, itens: lista, ...estadoCandidatos(), ...vagasAgora(),
             janela: dentroDaJanelaAwin() });
});

// Manda os escolhidos para a BASE DE PRODUTOS da vitrine. Dali eles seguem o
// mesmo caminho de qualquer outro produto: so cadastrar, disparo unico ou lista
// salva. Nada e enviado aqui.
//
// A escolha manual passa por cima das cotas de propósito — o teto por dia e por
// loja existe para segurar o robo, nao o operador. Mas o produto sai da fila de
// candidatos e entra no historico de ofertados, senao o publicador automatico
// mandaria o mesmo item por conta propria depois.
app.post('/awin/ofertas/cadastrar', (req, res) => {
  try {
    const chaves = Array.isArray(req.body?.chaves) ? req.body.chaves : [];
    if (!chaves.length) return res.status(400).json({ ok:false, erro:'nenhum produto selecionado' });
    if (chaves.length > 60) return res.status(400).json({ ok:false, erro:'máximo de 60 produtos por vez' });

    const cupom = req.body?.cupom || null;
    const escolhidos = retirarCandidatos(chaves);
    if (!escolhidos.length) {
      return res.status(400).json({ ok:false,
        erro:'os produtos não estão mais na fila — atualize a lista (a varredura pode tê-la renovado)' });
    }

    const salvos = [];
    for (const c of escolhidos) {
      const asin = chaveVitrineAwin(c.advertiserId, c.urlLoja);
      const jaTinha = !!itemVitrine(asin);
      salvos.push({ ...salvarItemVitrine({
        asin, loja: c.loja,
        nome: (c.titulo || (c.loja + ' — produto')).slice(0, 140),
        // 'url' e o link de afiliado que vai na mensagem; 'urlProduto' e a
        // pagina da loja, que permite reconsultar o preco no disparo.
        url: c.linkAfiliado || deeplinkAwin(c.advertiserId, c.urlLoja),
        urlProduto: c.urlLoja,
        advertiserId: c.advertiserId,
        // Preco do feed serve de plano B se a loja bloquear a leitura na hora
        // do disparo. Datado agora, para o TTL poder vence-lo.
        preco: c.preco, precoDe: c.precoDe,
        cupom,
      }), jaExistia: jaTinha });
      marcarOfertado(c.chaveHistorico);
    }

    console.log('[AWIN-OFERTAS] ' + salvos.length + ' candidato(s) enviados para a vitrine.');
    res.json({ ok:true, salvos, naFila: estadoCandidatos().total });
  } catch (e) { res.status(500).json({ ok:false, erro:e.message }); }
});

// Simulacao: mostra exatamente o que sairia, sem enviar e sem gastar cota.
app.post('/awin/ofertas/varrer', async (req, res) => {
  const r = await processarOfertasAwin({ simular: !!req.body?.simular });
  res.status(r.ok ? 200 : 400).json(r);
});

app.get('/awin/ofertas/estado', (req, res) => {
  const c = configOfertasAwin();
  // Teto real do dia: a publicacao so acontece dentro da janela e entrega no
  // maximo maxRodada por vez, entao o limite efetivo costuma ser menor que
  // maxDia — e melhor mostrar a conta pronta do que deixar o operador supor.
  const paraMin = h => { const m = String(h).match(/^(\d{1,2}):(\d{2})$/); return m ? +m[1]*60 + +m[2] : 0; };
  const minutosJanela = Math.max(0, paraMin(c.horaFim) - paraMin(c.horaInicio));
  const rodadasNaJanela = Math.floor(minutosJanela / Math.max(1, c.intervaloMin));
  res.json({ ok:true, config: c, usoHoje: usoDeHoje(), varrendo: _varrendoAwin,
    fila: estadoCandidatos(), janela: dentroDaJanelaAwin(),
    // As duas credenciais da Awin sao independentes e vem de lugares
    // diferentes na interface deles. Sem dizer qual falta, o operador so
    // descobre ao clicar em varrer e receber um erro seco.
    credenciais: {
      api:  credenciaisAwinOk(),   // AWIN_TOKEN + AWIN_PUBLISHER_ID
      feed: credenciaisFeedOk(),   // AWIN_FEED_APIKEY (Toolbox > Create-a-Feed)
    },
    rodadasNaJanela,
    tetoEfetivoDia: Math.min(c.maxDia, rodadasNaJanela * Math.max(1, c.maxRodada)) });
});

app.get('/awin/ofertas/config', (req, res) => res.json({ ok:true, config: configOfertasAwin() }));

app.post('/awin/ofertas/config', (req, res) => {
  try {
    const nova = salvarConfigOfertasAwin(req.body || {});
    aplicarTtlsAwin();
    agendarPush('awin_config.json');
    agendarAwin();   // ritmo novo passa a valer agora
    res.json({ ok:true, config: nova });
  } catch (e) { res.status(400).json({ ok:false, erro:e.message }); }
});

// ── PRODUCT FEEDS DA AWIN ────────────────────────────────────────────────────
app.get('/awin/feeds', (req, res) => {
  const anunciante = req.query.advertiserId;
  res.json({ ok:true, ...estadoFeed(),
    feeds: anunciante ? feedsDoAnunciante(anunciante) : undefined });
});

app.post('/awin/feeds/atualizar', async (req, res) => {
  try { res.json({ ok:true, total: (await atualizarFeedList(true)).length }); }
  catch (e) { res.status(500).json({ ok:false, erro:e.message }); }
});

// Amostra crua do feed. Serve para conferir a olho qual coluna de preco a loja
// usa: a Awin nao impoe a mesma semantica para todos os anunciantes.
app.get('/awin/feeds/amostra', async (req, res) => {
  try { res.json({ ok:true, ...await amostraFeed(req.query.advertiserId, Number(req.query.n) || 5) }); }
  catch (e) { res.status(500).json({ ok:false, erro:e.message }); }
});

// ── POLLER DE CUPONS DA AWIN ─────────────────────────────────────────────────
// Roda de tempos em tempos, pega o que apareceu de novo na Offers API e joga no
// MESMO caminho dos cupons do Telegram (enfileirarCupomTSP): dedup, base, gate
// de auto-envio e envio ou fila. Nada aqui contorna as regras de seguranca.
//
// AWIN_CUPONS:
//   'off'  (padrao) — poller desligado
//   'fila'          — coleta e manda para aprovacao manual, nunca auto-envia
//   'on'            — coleta e passa pelo gate; auto-envia se AUTO_ENVIO_CUPOM=on
// AWIN_POLL_MIN: intervalo em minutos (minimo 5, padrao 20).
function awinCuponsModo()  { return configOfertasAwin().cupons; }
function awinCuponsAtivo() { return ['on', 'fila'].includes(awinCuponsModo()); }
function awinPollMs() { return Math.max(5, configOfertasAwin().cupomPollMin) * 60 * 1000; }
const AWIN_VISTOS_PATH = SESSAO_DIR + '/awin_vistos.json';

let _awinVistos = {};       // promotionId -> ISO da 1a vez que foi visto
let _awinRodando = false;

function carregarAwinVistos() {
  try {
    if (existsSync(AWIN_VISTOS_PATH)) _awinVistos = JSON.parse(readFileSync(AWIN_VISTOS_PATH, 'utf-8')) || {};
  } catch (e) { console.log('[AWIN] Erro ao ler vistos:', e.message); _awinVistos = {}; }
  return _awinVistos;
}

function salvarAwinVistos() {
  // Poda o que ja passou de 90 dias: promocao antiga nao volta a ser "nova".
  const limite = Date.now() - 90 * 24 * 60 * 60 * 1000;
  for (const [k, v] of Object.entries(_awinVistos)) {
    const t = new Date(v).getTime();
    if (isFinite(t) && t < limite) delete _awinVistos[k];
  }
  try { writeFileSync(AWIN_VISTOS_PATH, JSON.stringify(_awinVistos)); }
  catch (e) { console.log('[AWIN] Falha ao gravar vistos:', e.message); }
}

/**
 * Uma passada no catalogo de ofertas.
 * `semear`: marca tudo como visto e grava na base SEM enviar nada. E o que
 * impede que a primeira execucao despeje as dezenas de cupons ja existentes
 * nos grupos de uma vez so. Roda sozinho quando ainda nao ha arquivo de vistos.
 */
async function processarCuponsAwin({ semear = false, forcarEnvio = false } = {}) {
  if (!credenciaisAwinOk()) return { ok:false, erro:'Awin nao configurada' };
  if (_awinRodando) return { ok:false, erro:'ja ha uma coleta em andamento' };
  _awinRodando = true;
  const resumo = { novos: 0, enviados: 0, naFila: 0, ignorados: 0, semeados: 0, erros: [] };

  try {
    const brutas = await buscarOfertasAwin({ tipo:'voucher', status:'active' });
    for (const bruta of brutas) {
      const id = String(bruta?.promotionId || '');
      if (!id || _awinVistos[id]) continue;

      const base = normalizarOfertaAwin(bruta);
      _awinVistos[id] = new Date().toISOString();
      if (!base.codigo) { resumo.ignorados++; continue; }

      // Semeadura: entra na base de cupons (para a vitrine e o gerador ja
      // poderem vincular) mas nao vai para grupo nenhum.
      if (semear) {
        if (base.tipo && base.valor) {
          try {
            registrarCupomBase({ loja:base.loja, codigo:base.codigo, tipo:base.tipo, valor:base.valor,
              minimo:base.minimo, limite:base.limite, maximo:base.maximo, validadeAte:base.validadeAte,
              observacao:'Awin' });
            resumo.semeados++;
          } catch (e) { resumo.erros.push({ loja:base.loja, erro:e.message }); }
        }
        continue;
      }

      // Texto de referencia da validacao cruzada. Loja, codigo e validade vem
      // da propria rede (nao da IA), entao entram no texto de proposito: o que
      // precisa ser conferido contra alucinacao sao os NUMEROS extraidos.
      const texto = [bruta.title, bruta.description, bruta.terms !== '..' ? bruta.terms : '',
                     'Cupom: ' + base.codigo, 'Loja: ' + base.loja].filter(Boolean).join('\n');

      // A IA le so os numeros (valor, minimo, limite, maximo). Se falhar, cai
      // no que o regex do normalizador conseguiu tirar do titulo.
      let campos = null;
      try { campos = await extrairCupomTelegram(texto); } catch (e) { resumo.erros.push({ loja:base.loja, erro:e.message }); }

      const c = {
        loja: base.loja,
        codigo: base.codigo,
        tipo:   campos?.tipo   ?? base.tipo,
        valor:  campos?.valor  ?? base.valor,
        minimo: campos?.minimo ?? base.minimo,
        limite: campos?.limite ?? base.limite,
        maximo: campos?.maximo ?? base.maximo,
        validadeAte: base.validadeAte,
        urlAfiliado: base.urlAfiliado,
        // Loja, codigo e validade vieram da API do anunciante, nao de leitura de
        // texto: e o que autoriza o gate a dispensar minimo e teto obrigatorios.
        fonteOficial: awinCuponsModo() === 'on',
        minimoDesconhecido: (campos?.minimo ?? base.minimo) === null
                         || (campos?.minimo ?? base.minimo) === undefined,
        observacao: 'Awin' + (base.atribuivel ? ' (atribuivel)' : '') + (base.exclusivo ? ' (exclusivo)' : ''),
      };
      if (!c.tipo || !(Number(c.valor) > 0)) { resumo.ignorados++; continue; }

      resumo.novos++;
      const r = await enfileirarCupomTSP(c, {
        origem: 'awin:' + base.loja,
        textoOriginal: texto,
        somenteFila: awinCuponsModo() === 'fila',
      });
      if (r?.enviado) resumo.enviados++;
      else if (r?.ignorado) resumo.ignorados++;
      else resumo.naFila++;
    }
    salvarAwinVistos();
    console.log('[AWIN] Coleta de cupons — ' + (semear
      ? resumo.semeados + ' semeado(s) sem envio.'
      : resumo.novos + ' novo(s), ' + resumo.enviados + ' enviado(s), ' + resumo.naFila + ' na fila.'));
    return { ok:true, total: brutas.length, ...resumo };
  } catch (e) {
    console.log('[AWIN] Falha na coleta:', e.message);
    return { ok:false, erro:e.message };
  } finally { _awinRodando = false; }
}

// Boot: sem arquivo de vistos, a primeira passada e sempre semeadura. So a
// partir da segunda e que cupom novo vira mensagem.
if (credenciaisAwinOk() && awinCuponsAtivo()) {
  const primeiraVez = !existsSync(AWIN_VISTOS_PATH);
  carregarAwinVistos();
  setTimeout(() => {
    processarCuponsAwin({ semear: primeiraVez })
      .then(() => { if (primeiraVez) console.log('[AWIN] Semeadura concluida — a partir de agora so cupom novo e publicado.'); })
      .catch(e => console.log('[AWIN] Erro no boot da coleta:', e.message));
  }, 60 * 1000);
  setInterval(() => { processarCuponsAwin().catch(() => {}); }, awinPollMs()).unref?.();
  console.log('[AWIN] Coleta automatica de cupons ligada (modo ' + awinCuponsModo()
    + ') — a cada ' + (awinPollMs() / 60000) + ' min.');
} else {
  carregarAwinVistos();
}

// Coleta sob demanda. { semear: true } refaz a marcacao sem enviar nada.
app.post('/awin/cupons/poll', async (req, res) => {
  const r = await processarCuponsAwin({ semear: !!req.body?.semear });
  res.status(r.ok ? 200 : 400).json(r);
});

app.get('/awin/cupons/estado', (req, res) => {
  res.json({
    ok: true,
    modo: awinCuponsModo(),
    intervaloMin: awinPollMs() / 60000,
    autoEnvio: AUTO_ENVIO_MODO,
    promocoesConhecidas: Object.keys(_awinVistos).length,
    coletando: _awinRodando,
  });
});

// ── MONITORAMENTO POR GRUPO ──────────────────────────────────────────────────
app.get('/monitor', (req, res) => {
  const monitor = listarMonitor();
  const fontes = radarFontes();
  res.json({
    ok: true,
    lojas: LOJAS_MONITORAVEIS,
    monitor,
    // Fonte sem cadastro nao captura nada: o painel precisa destacar isso.
    fontesSemCadastro: fontes.filter(j => !monitor[j]),
    agoraSP: new Intl.DateTimeFormat('pt-BR', { timeZone: TZ_SP, dateStyle: 'short', timeStyle: 'short' }).format(new Date()),
  });
});

app.post('/monitor/:jid', (req, res) => {
  try {
    const cfg = salvarMonitor(req.params.jid, req.body || {});
    if (!cfg) return res.status(400).json({ ok:false, erro:'jid invalido' });
    const faixas = (cfg.janelas || [{ inicio: cfg.inicio, fim: cfg.fim }])
      .map(j => j.inicio + '-' + j.fim).join(', ');
    console.log('[MONITOR] ' + req.params.jid.split('@')[0] + ' — ' + (cfg.lojas.join('+') || 'nenhuma loja')
      + ' ' + faixas + ' (' + cfg.dias + ')' + (cfg.ativo ? '' : ' [inativo]'));
    res.json({ ok:true, cfg, estadoAgora: podeCapturar(req.params.jid, cfg.lojas[0] || 'Amazon') });
  } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
});

app.delete('/monitor/:jid', (req, res) => {
  if (!removerMonitor(req.params.jid)) return res.status(404).json({ ok:false, erro:'sem cadastro para este grupo' });
  res.json({ ok:true });
});

// ── LISTAS DE REENVIO ────────────────────────────────────────────────────────
// Uma lista dispara um produto por vez, com o intervalo configurado. Nao da para
// fazer isso dentro do request HTTP (30 produtos x 20 min = 10 horas), entao o
// endpoint so abre a execucao e um worker toca a fila. O andamento fica gravado
// no proprio registro da lista, sobrevivendo a restart do container.

// Monta e envia UM produto. Isolada porque e usada pelo worker e pelo disparo
// avulso, e o preco tem de ser sempre consultado no instante do envio.
async function dispararProdutoDaLista(asin, codigoCupom) {
  const item = itemVitrine(asin);
  if (!item) return { ok:false, motivo:'produto nao esta mais na vitrine' };

  let montado;
  if (item.loja === 'Shopee') {
    if (!credenciaisShopeeOk()) return { ok:false, motivo:'Shopee nao configurada' };
    montado = await montarOfertasShopeeVitrine([item], codigoCupom);
  } else if (item.loja === 'Mercado Livre') {
    if (!tokenAffOk()) return { ok:false, motivo:'Mercado Livre nao configurado (ML_AFF_TOKEN)' };
    montado = await montarOfertasMlVitrine([item], codigoCupom);
  } else if (item.loja === 'Magazine Luiza') {
    montado = await montarOfertasMagaluVitrine([item], codigoCupom);
  } else if (String(item.asin).startsWith('AWIN-')) {
    montado = await montarOfertasAwinVitrine([item], codigoCupom);
  } else {
    montado = await montarOfertasVitrine([asin], codigoCupom);
  }

  const o = montado.prontos[0];
  if (!o) return { ok:false, motivo: montado.descartados[0]?.motivo || 'produto descartado' };

  const oferta = {
    id: gerarId(), origem:'lista',
    tipoConteudo: o.produto.loja === 'Shopee' ? 'oferta_shopee'
                : o.produto.loja === 'Mercado Livre' ? 'oferta_ml'
                : o.produto.loja === 'Magazine Luiza' ? 'oferta_magalu'
                : String(o.asin || '').startsWith('AWIN-') ? 'oferta_awin' : 'oferta_amazon',
    mensagemFormatada: o.mensagem,
    dadosExtraidos: {
      loja:o.produto.loja || 'Amazon', asin:o.asin, titulo:o.produto.titulo, preco:o.produto.preco,
      precoDe:o.produto.precoDe, desconto:o.produto.desconto, link:o.produto.link,
      cupom:o.cupom, precoFinal:o.precoFinal,
      precoDeReferencia: !!o.precoDeReferencia,
      // URL da imagem para a vitrine publica (o base64 so serve ao WhatsApp).
      imagemUrl: o.produto.imagemUrl || null,
    },
    imagens: [],
  };
  try {
    const img = await baixarImagemProduto(o.produto.imagemUrl);
    if (img) oferta.imagens = [img];
  } catch (e) {}

  const r = await enviarOfertaParaDestinos(o.mensagem, null, oferta);
  marcarDisparo(asin);
  return { ok:true, nome:o.nome, grupos:r.enviados.length, cupom:o.cupom?.codigo || null,
           aviso:o.avisoCupom || null, preco:o.produto.preco };
}

// "09:00" -> epoch ms do proximo instante HOJE, no fuso de SP. Devolve null se a
// hora nao for valida, e um instante ja passado quando o horario ficou para tras
// (quem chama decide se cai para "agora").
function tsHojeSP(hhmm) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const agora = new Date();
  const p = {};
  new Intl.DateTimeFormat('en-US', { timeZone: TZ_SP, year:'numeric', month:'2-digit', day:'2-digit',
                                     hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false })
    .formatToParts(agora).forEach(x => { p[x.type] = x.value; });
  // Relogio de SP lido como se fosse UTC menos o instante real = deslocamento do fuso.
  const spComoUTC = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
  const offset    = spComoUTC - (agora.getTime() - agora.getMilliseconds());
  return Date.UTC(+p.year, +p.month - 1, +p.day, +m[1], +m[2], 0) - offset;
}

// Nome proprio: horaSP() (la em cima) devolve a hora cheia como numero e e usada
// pela janela de envio; aqui o que se quer e o relogio HH:MM de um instante.
function relogioSP(ts) {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: TZ_SP, hour:'2-digit', minute:'2-digit', hour12:false })
    .format(new Date(ts));
}

// iniciarEm no futuro apenas empurra o primeiro item: o worker so acorda listas
// cujo proximoEm ja venceu, entao "agendado" e "em disparo" usam a mesma maquina.
function iniciarExecucaoLista(lista, iniciarEm) {
  const alvo = Number(iniciarEm) > Date.now() ? Number(iniciarEm) : Date.now();
  return atualizarExecucaoLista(lista.id, {
    iniciadaEm: new Date().toISOString(),
    indice: 0,
    proximoEm: alvo,                // agora, ou a hora marcada para hoje
    agendadoPara: alvo > Date.now() ? alvo : null,
    pausada: false,
    enviados: [], falhas: [], pulados: [],
  });
}

// ── JANELA DE ENVIO DAS LISTAS ───────────────────────────────────────────────
// O monitor tem janelas proprias (podeCapturar) que governam a CAPTURA de links
// nos grupos-fonte. O disparo de listas era outra maquina, sem hora limite: uma
// fila de 36 itens a 20 min comecando as 08:00 termina as 20:21, fora de
// qualquer janela. Agora a fila respeita horario — fora da janela ela ADIA o
// item, sem consumir, e retoma na proxima abertura.
// Padrao configuravel por env LISTA_JANELAS ('08:00-20:00' ou '08:00-12:00,14:00-20:00').
const LISTA_JANELAS_PADRAO = (() => {
  const js = String(process.env.LISTA_JANELAS || '08:00-20:00').split(',').map(p => {
    const m = p.trim().match(/^([01]\d|2[0-3]):([0-5]\d)\s*-\s*([01]\d|2[0-3]):([0-5]\d)$/);
    return m ? { inicio: m[1] + ':' + m[2], fim: m[3] + ':' + m[4] } : null;
  }).filter(Boolean);
  return js.length ? js : [{ inicio: '08:00', fim: '20:00' }];
})();

/** Janelas efetivas da lista: as proprias, ou o padrao do servidor. */
function janelasDaLista(lista) {
  const js = Array.isArray(lista?.janelas)
    ? lista.janelas.filter(j => j && j.inicio && j.fim) : [];
  return js.length ? js : LISTA_JANELAS_PADRAO;
}

/**
 * { ok:true } quando pode enviar agora; { ok:false, proximoEm } com o timestamp
 * da proxima abertura (hoje ou amanha) quando esta fora. Fila 24h continua
 * possivel: basta configurar a janela 00:00-23:59.
 */
function janelaEnvioLista(lista, quando = Date.now()) {
  const janelas = janelasDaLista(lista);
  const agora   = campPartesSP(quando).minutos;
  for (const j of janelas) {
    const ini = campHhmmParaMin(j.inicio);
    const fim = campHhmmParaMin(j.fim);
    // Janela que vira a meia-noite (22:00-02:00) e um bloco unico partido em dois.
    const dentro = ini <= fim ? (agora >= ini && agora <= fim) : (agora >= ini || agora <= fim);
    if (dentro) return { ok: true, janelas: janelas.map(j2 => j2.inicio + '-' + j2.fim).join(', ') };
  }
  const inicios = janelas.map(j => campHhmmParaMin(j.inicio)).sort((a, b) => a - b);
  const proximo = inicios.find(m => m > agora);
  const faltam  = proximo !== undefined ? (proximo - agora) : (1440 - agora + inicios[0]);
  return { ok: false, proximoEm: quando + faltam * 60000 + 5000,
           janelas: janelas.map(j => j.inicio + '-' + j.fim).join(', ') };
}

/**
 * Simula a fila item a item respeitando as janelas e devolve quando ela termina.
 * Existe porque "36 produtos x 20 min" nao cabe numa janela de 12h: o operador
 * precisa ver, na hora de disparar, que a fila vai virar o dia — antes que o
 * ultimo item saia as 20h de um dia que nem era o combinado.
 */
function previsaoTerminoLista(lista, inicioTs, qtd) {
  const passo = (lista.intervaloMin || 20) * 60000;
  const total = Math.min(Number(qtd) || 0, 2000);   // trava de seguranca
  let t = Number(inicioTs) || Date.now();
  let adiados = 0;
  for (let i = 0; i < total; i++) {
    const j = janelaEnvioLista(lista, t);
    if (!j.ok) { t = j.proximoEm; adiados++; }
    if (i < total - 1) t += passo;
  }
  return { terminaEm: t, adiados, cabeNoDia: adiados === 0 };
}

/** Data+hora curta no fuso de SP: previsao que vira o dia precisa mostrar o dia. */
function dataHoraSP(ts) {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: TZ_SP, day:'2-digit', month:'2-digit',
                                            hour:'2-digit', minute:'2-digit', hour12:false })
    .format(new Date(ts));
}

// Worker: acorda a cada 15s e envia o proximo produto de cada lista cuja hora
// chegou. Uma lista por vez dentro do tick — se duas vencerem juntas, a segunda
// espera o proximo ciclo, evitando dois envios no mesmo segundo.
let _listaWorkerRodando = false;
setInterval(async () => {
  if (_listaWorkerRodando) return;
  const pendentes = listarListas().filter(l =>
    l.execucao && !l.execucao.pausada && l.execucao.proximoEm <= Date.now());
  if (!pendentes.length) return;

  _listaWorkerRodando = true;
  try {
    const lista = pendentes[0];
    const ex = lista.execucao;
    const asin = lista.produtos[ex.indice];

    if (asin === undefined) {                       // fim da fila
      console.log('[LISTA] "' + lista.nome + '" concluida — ' + ex.enviados.length
        + ' enviado(s), ' + ex.falhas.length + ' falha(s), ' + ex.pulados.length + ' pulado(s).');
      try {
        await enviarMensagem(GRUPOS.operador, { text: '*Lista concluida: ' + lista.nome + '*\n\n'
          + ex.enviados.length + ' enviado(s)\n' + ex.falhas.length + ' falha(s)\n'
          + ex.pulados.length + ' pulado(s) (sem preco, esgotado ou fora da base)' });
      } catch(_) {}
      // Envio unico nao vira historico: cumprida a fila, o registro sai do painel.
      if (lista.efemera) removerLista(lista.id);
      else atualizarExecucaoLista(lista.id, null);
      return;
    }

    if (!conectado || !sock) {
      // Sem WhatsApp nao adianta consumir a fila: adia sem gastar o item.
      ex.proximoEm = Date.now() + 60000;
      atualizarExecucaoLista(lista.id, ex);
      return;
    }

    // Fora da janela de envio: adia sem gastar o item. Uma fila longa demais
    // pausa no fim do dia e retoma na abertura seguinte, em vez de varar a noite.
    const _jan = janelaEnvioLista(lista);
    if (!_jan.ok) {
      ex.proximoEm = _jan.proximoEm;
      atualizarExecucaoLista(lista.id, ex);
      console.log('[LISTA] "' + lista.nome + '" fora da janela (' + _jan.janelas + ' SP) — item '
        + (ex.indice + 1) + '/' + lista.produtos.length + ' adiado para ' + relogioSP(_jan.proximoEm) + '.');
      return;
    }

    try {
      const r = await dispararProdutoDaLista(asin, cupomDaLista(lista));
      if (r.ok) ex.enviados.push({ asin, nome:r.nome, cupom:r.cupom, em:new Date().toISOString() });
      else      ex.pulados.push({ asin, motivo:r.motivo, em:new Date().toISOString() });
    } catch (e) {
      ex.falhas.push({ asin, erro:e.message, em:new Date().toISOString() });
    }

    ex.indice += 1;
    ex.proximoEm = Date.now() + lista.intervaloMin * 60000;
    atualizarExecucaoLista(lista.id, ex);
    console.log('[LISTA] "' + lista.nome + '" — item ' + ex.indice + '/' + lista.produtos.length
      + ', proximo em ' + lista.intervaloMin + ' min.');
  } catch (e) {
    console.error('[LISTA] Erro no worker:', e.message);
  } finally { _listaWorkerRodando = false; }
}, 15000);

// Agendador: dispara a lista no dia da semana e hora marcados. Guarda o dia ja
// disparado para restart do container nao repetir a lista no mesmo dia.
const _listaDiaDisparado = new Map();
setInterval(() => {
  const agora = new Date();
  const hhmm = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ_SP, hour:'2-digit', minute:'2-digit', hour12:false }).format(agora);
  const dia  = new Intl.DateTimeFormat('en-CA', { timeZone: TZ_SP }).format(agora);
  // Dia da semana no fuso de SP (0=domingo), nao no fuso do container.
  const diaSemana = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(
    new Intl.DateTimeFormat('en-US', { timeZone: TZ_SP, weekday: 'short' }).format(agora));

  for (const lista of listarListas()) {
    if (!lista.ativo || !lista.agenda?.ativo || lista.execucao) continue;
    if (!lista.produtos?.length) continue;
    if (!lista.agenda.diasSemana.includes(diaSemana)) continue;
    if (lista.agenda.hora !== hhmm) continue;
    if (_listaDiaDisparado.get(lista.id) === dia) continue;
    _listaDiaDisparado.set(lista.id, dia);
    iniciarExecucaoLista(lista);
    console.log('[LISTA] "' + lista.nome + '" iniciada pela agenda (' + hhmm + ' SP, '
      + lista.produtos.length + ' produto(s), ' + lista.intervaloMin + ' min de intervalo).');
  }
}, 30000);

app.get('/listas', (req, res) => {
  const listas = listarListas().map(l => ({
    ...l,
    // Nome do produto resolvido aqui: o painel nao deve ter que cruzar com a vitrine.
    itens: (l.produtos || []).map(a => ({ asin:a, nome: itemVitrine(a)?.nome || a,
                                          loja: itemVitrine(a)?.loja || null,
                                          sumiu: !itemVitrine(a) })),
    restantes: l.execucao ? Math.max(0, l.produtos.length - l.execucao.indice) : null,
    // Janelas efetivas (proprias ou padrao do servidor) para o painel exibir
    // por que uma fila em andamento pode estar parada.
    janelasEfetivas: janelasDaLista(l),
    dentroDaJanela: janelaEnvioLista(l).ok,
    // Fila em andamento: quando o ultimo item sai, ja contando as pausas.
    terminaAs: l.execucao
      ? dataHoraSP(previsaoTerminoLista(l, Math.max(l.execucao.proximoEm, Date.now()),
          Math.max(0, l.produtos.length - l.execucao.indice)).terminaEm)
      : null,
  }));
  res.json({ ok:true, total: listas.length, listas,
             agoraSP: new Intl.DateTimeFormat('pt-BR', { timeZone: TZ_SP, dateStyle:'short', timeStyle:'short' }).format(new Date()) });
});

app.post('/listas', (req, res) => {
  try { res.json({ ok:true, lista: salvarLista(req.body || {}) }); }
  catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
});

app.delete('/listas/:id', (req, res) => {
  if (!removerLista(req.params.id)) return res.status(404).json({ ok:false, erro:'lista nao encontrada' });
  res.json({ ok:true });
});

// Comeca a execucao agora. Nao envia nada de forma sincrona: o primeiro item sai
// no proximo tick do worker (ate 15s), e o restante conforme o intervalo.
app.post('/listas/:id/disparar', async (req, res) => {
  const lista = listaPorId(req.params.id);
  if (!lista) return res.status(404).json({ ok:false, erro:'lista nao encontrada' });
  if (lista.execucao) return res.status(409).json({ ok:false, erro:'esta lista ja esta em disparo' });
  if (!lista.produtos?.length) return res.status(400).json({ ok:false, erro:'lista sem produtos' });

  // iniciarHora ('HH:MM', fuso de SP) adia o primeiro item para mais tarde HOJE.
  const inicio    = tsHojeSP(req.body?.iniciarHora);
  const aguardando = inicio !== null && inicio > Date.now();

  // Fila que so comeca daqui a horas nao precisa do WhatsApp ligado agora: o
  // worker adia sozinho enquanto a sessao nao volta.
  if (!aguardando && (!conectado || !sock)) {
    const ok = await aguardarSock(10000);
    if (!ok) return res.status(503).json({ ok:false, erro:'WhatsApp nao conectado.' });
  }
  const atualizada = iniciarExecucaoLista(lista, aguardando ? inicio : null);
  const minutos  = (lista.produtos.length - 1) * lista.intervaloMin;
  const inicioTs = aguardando ? inicio : Date.now();
  const prev     = previsaoTerminoLista(lista, inicioTs, lista.produtos.length);
  console.log('[LISTA] "' + lista.nome + '" ' + (aguardando ? 'agendada para ' + relogioSP(inicio) + ' SP' : 'iniciada manualmente')
    + ' — ' + lista.produtos.length + ' produto(s), ' + lista.intervaloMin + ' min de intervalo, termina '
    + dataHoraSP(prev.terminaEm) + ' SP' + (prev.cabeNoDia ? '' : ' (fila vira o dia)') + '.');
  res.json({ ok:true, lista: atualizada, produtos: lista.produtos.length, duracaoMin: minutos,
             aguardando, iniciarEm: inicioTs,
             iniciaAs: relogioSP(inicioTs),
             janelas: janelasDaLista(lista),
             terminaEm: prev.terminaEm, terminaAs: dataHoraSP(prev.terminaEm),
             cabeNoDia: prev.cabeNoDia,
             aviso: prev.cabeNoDia ? null
               : lista.produtos.length + ' itens a ' + lista.intervaloMin + ' min nao cabem na janela '
                 + janelasDaLista(lista).map(j => j.inicio + '-' + j.fim).join(', ')
                 + ' — a fila pausa e continua ate ' + dataHoraSP(prev.terminaEm) + ' SP.' });
});

// Envio unico: mesma maquina de disparo das listas salvas, so que o registro e
// descartavel. Cria e inicia num passo so — se nao der para iniciar, a lista e
// desfeita, porque envio unico parado no painel vira lixo que ninguem entende.
app.post('/listas/disparo-unico', async (req, res) => {
  const produtos = Array.isArray(req.body?.produtos) ? req.body.produtos.filter(Boolean) : [];
  if (!produtos.length) return res.status(400).json({ ok:false, erro:'selecione ao menos um produto' });

  // Hora de inicio opcional, sempre do MESMO dia: cadastrar de madrugada e deixar
  // a fila comecar as 9h. Horario ja vencido cai para agora, sem barrar o envio.
  const inicio     = tsHojeSP(req.body?.iniciarHora);
  const aguardando = inicio !== null && inicio > Date.now();

  if (!aguardando && (!conectado || !sock)) {
    const ok = await aguardarSock(10000);
    if (!ok) return res.status(503).json({ ok:false, erro:'WhatsApp nao conectado.' });
  }

  const agora = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ_SP, day:'2-digit', month:'2-digit',
                                                   hour:'2-digit', minute:'2-digit' }).format(new Date());
  const lista = salvarLista({
    nome: String(req.body?.nome || '').trim()
       || ('Envio único · ' + agora + (aguardando ? ' · começa ' + relogioSP(inicio) : '')),
    produtos,
    intervaloMin: req.body?.intervaloMin,
    cupomModo: req.body?.cupomModo,
    cupomCodigo: req.body?.cupomCodigo,
    efemera: true,
    agenda: { ativo:false },
    janelas: req.body?.janelas,
  });

  try {
    const atualizada = iniciarExecucaoLista(lista, aguardando ? inicio : null);
    console.log('[LISTA] Envio unico ' + (aguardando ? 'agendado para ' + relogioSP(inicio) + ' SP' : 'iniciado')
      + ' — ' + produtos.length + ' produto(s), ' + lista.intervaloMin + ' min de intervalo.');
    const inicioTs = aguardando ? inicio : Date.now();
    const prev     = previsaoTerminoLista(lista, inicioTs, produtos.length);
    res.json({ ok:true, lista: atualizada, produtos: produtos.length,
               duracaoMin: (produtos.length - 1) * lista.intervaloMin,
               aguardando, iniciarEm: inicioTs,
               iniciaAs: relogioSP(inicioTs),
               janelas: janelasDaLista(lista),
               terminaEm: prev.terminaEm, terminaAs: dataHoraSP(prev.terminaEm),
               cabeNoDia: prev.cabeNoDia,
               aviso: prev.cabeNoDia ? null
                 : produtos.length + ' itens a ' + lista.intervaloMin + ' min nao cabem na janela '
                   + janelasDaLista(lista).map(j => j.inicio + '-' + j.fim).join(', ')
                   + ' — a fila pausa e continua ate ' + dataHoraSP(prev.terminaEm) + ' SP.' });
  } catch (e) {
    removerLista(lista.id);
    res.status(500).json({ ok:false, erro:e.message });
  }
});

// Pausar/retomar/cancelar no meio: lista longa pode precisar parar (grupo
// reclamando, cupom que caiu, preco errado).
app.post('/listas/:id/pausar', (req, res) => {
  const lista = listaPorId(req.params.id);
  if (!lista?.execucao) return res.status(400).json({ ok:false, erro:'lista nao esta em disparo' });
  lista.execucao.pausada = true;
  res.json({ ok:true, lista: atualizarExecucaoLista(lista.id, lista.execucao) });
});

app.post('/listas/:id/retomar', (req, res) => {
  const lista = listaPorId(req.params.id);
  if (!lista?.execucao) return res.status(400).json({ ok:false, erro:'lista nao esta em disparo' });
  lista.execucao.pausada = false;
  lista.execucao.proximoEm = Date.now();
  res.json({ ok:true, lista: atualizarExecucaoLista(lista.id, lista.execucao) });
});

app.post('/listas/:id/cancelar', (req, res) => {
  const lista = listaPorId(req.params.id);
  if (!lista?.execucao) return res.status(400).json({ ok:false, erro:'lista nao esta em disparo' });
  const parcial = lista.execucao;
  if (lista.efemera) removerLista(lista.id);
  else atualizarExecucaoLista(lista.id, null);
  res.json({ ok:true, enviados: parcial.enviados.length, restantes: lista.produtos.length - parcial.indice });
});

// ── VITRINE ──────────────────────────────────────────────────────────────────
// Link encurtado (amzn.to) e link /dp/ASIN puro nao trazem o slug com o nome do
// produto, entao o item entrava na base como "Produto B0XXXXXXXX". O disparo ja
// corrigia isso ao ler o titulo na Creators API, mas so DEPOIS de a mensagem
// existir — o operador montava a lista sem saber o que estava mandando.
// Aqui o titulo e resolvido no cadastro, em lote (a propria buscarProdutos
// quebra em grupos de 10). Falha de rede nao derruba o cadastro: o nome
// provisorio continua valendo e o disparo ainda o corrige.
const NOME_PROVISORIO_VIT = /^Produto [A-Z0-9]{10}$/;

async function resolverNomesProvisorios(asins) {
  const alvo = [...new Set(asins)].filter(a => {
    const i = itemVitrine(a);
    return i && (i.loja || '') === 'Amazon' && NOME_PROVISORIO_VIT.test(i.nome || '');
  });
  if (!alvo.length) return { resolvidos: 0, restantes: 0 };
  let resolvidos = 0;
  try {
    const itens = await buscarProdutos(alvo);
    for (const it of itens) {
      const titulo = normalizar(it).titulo;
      if (!titulo) continue;
      salvarItemVitrine({ asin: it.asin, nome: titulo });
      resolvidos++;
    }
  } catch (e) {
    console.warn('[VITRINE] Nao resolveu titulos:', e.message);
  }
  return { resolvidos, restantes: alvo.length - resolvidos };
}

// Repara a base inteira de uma vez. Existe porque os itens cadastrados antes
// desta correcao continuam com o nome provisorio gravado.
app.post('/vitrine/nomes', async (req, res) => {
  const todos = listarVitrine().map(i => i.asin);
  const r = await resolverNomesProvisorios(todos);
  res.json({ ok:true, ...r });
});

// Previa do disparo: monta as mensagens exatamente como sairiam, mas NAO envia
// nem enfileira. Existe porque ate aqui a unica forma de ver o resultado de uma
// lista era dispara-la de verdade — e cupom e preco so sao resolvidos no momento
// do envio, entao o operador montava a lista as cegas.
// ?cupom=auto escolhe o melhor cupom aplicavel; sem o parametro, usa o cupom
// vinculado a cada item. Aceita ?asins=A,B,C para limitar a alguns produtos.
app.post('/vitrine/previa', async (req, res) => {
  try {
    const filtro = String(req.body?.asins || req.query.asins || '').split(',')
      .map(x => x.trim()).filter(Boolean);
    const cupom = req.body?.cupom ?? req.query.cupom ?? null;
    const itens = listarVitrine()
      .filter(i => i.loja === 'Mercado Livre')
      .filter(i => !filtro.length || filtro.includes(String(i.asin)));
    if (!itens.length) return res.json({ ok:true, total:0, prontos:[], descartados:[],
                                         aviso:'nenhum item do Mercado Livre na vitrine' });
    if (!tokenAffOk()) return res.status(400).json({ ok:false, erro:'ML_AFF_TOKEN nao configurado' });

    const m = await montarOfertasMlVitrine(itens, cupom);
    res.json({
      ok: true,
      total: itens.length,
      cupomPedido: cupom,
      prontos: (m.prontos || []).map(o => ({
        asin: o.asin, nome: o.nome,
        preco: o.produto?.preco, precoDe: o.produto?.precoDe, precoFinal: o.precoFinal,
        cupom: o.cupom, avisoCupom: o.avisoCupom, mensagem: o.mensagem,
      })),
      descartados: m.descartados || [],
    });
  } catch (e) { res.status(500).json({ ok:false, erro:e.message }); }
});

app.get('/vitrine', (req, res) => {
  const itens = listarVitrine();
  // O painel precisa do TTL para avisar quando o preco da Magalu venceu — a
  // unica loja em que o preco nao e reconsultado no disparo.
  res.json({ ok:true, total: itens.length, itens, ttlPrecoMagalu: ttlPrecoMagalu() });
});

// Recebe o texto colado (um link por linha) e cadastra o que conseguir resolver.
// So resolve o ASIN e o nome — preco fica para o disparo.
app.post('/vitrine', async (req, res) => {
  const linhas = String(req.body?.texto || '').split('\n').map(l => l.trim()).filter(Boolean);
  if (!linhas.length) return res.status(400).json({ ok:false, erro:'nenhuma linha enviada' });
  if (linhas.length > 60) return res.status(400).json({ ok:false, erro:'máximo de 60 linhas por vez' });

  const cupom = req.body?.cupom || null;
  const salvos = [], erros = [];

  for (const linha of linhas) {
    try {
      // Shopee tem seu proprio formato de link e de identificador.
      if (ehLinkShopee(linha)) {
        if (!credenciaisShopeeOk()) { erros.push({ linha, erro: 'Shopee não configurada no Railway' }); continue; }
        const nomeManual = (linha.match(/^(.*?)\s*[|;]\s*https?:\/\//) || [])[1];
        const ids = await extrairIdsShopee(linha);
        if (!ids.length) {
          // Sem o destino do encurtador o erro nao ensina nada: pode ser link de
          // loja, de campanha, expirado ou formato novo. Mostra onde ele parou.
          let destino = '';
          try { destino = await resolverEncurtadorShopee(linha); } catch {}
          const curto = destino ? destino.split('?')[0].slice(0, 90) : '';
          erros.push({ linha, erro: 'não é link de produto Shopee'
            + (curto ? ' — o link leva para ' + curto : ' e o encurtador não respondeu') });
          continue;
        }
        const node = await buscarProdutoShopee(ids[0]);
        // Sem nome da API e sem nome manual, o produto entraria como "Produto
        // 123456" e o disparo sairia com titulo inutil. Melhor recusar aqui.
        if (!node && !(nomeManual || '').trim()) {
          erros.push({ linha, erro: 'produto ' + ids[0].itemId
            + ' fora do catálogo de afiliados (sem comissão ou indisponível)' });
          continue;
        }
        const chave = 'SHOPEE-' + ids[0].shopId + '-' + ids[0].itemId;
        const jaTinha = !!itemVitrine(chave);
        salvos.push({ ...salvarItemVitrine({
          asin: chave, loja: 'Shopee',
          shopId: String(ids[0].shopId), itemId: String(ids[0].itemId),
          nome: (nomeManual || '').trim() || node?.productName || ('Produto ' + ids[0].itemId),
          url: node?.offerLink || node?.productLink || linha.trim(),
          cupom,
        }), jaExistia: jaTinha });
        continue;
      }
      // Magazine Luiza: link vira link de afiliado por transformacao de URL, sem
      // rede. Preco vem da propria linha porque nao ha fonte para consultar.
      if (ehLinkMagalu(linha)) {
        const rmg = await resolverLinhaVitrineMagalu(linha);
        if (!rmg || rmg.erro) { erros.push({ linha, erro: rmg?.erro || 'falhou' }); continue; }
        const jaTinhaMg = !!itemVitrine(rmg.asin);
        salvos.push({ ...salvarItemVitrine({ ...rmg, cupom }), jaExistia: jaTinhaMg });
        continue;
      }
      // Mercado Livre: identificador e MLB, nao ASIN, e o link de afiliado so
      // e gerado no disparo — por isso nao passa pelo resolvedor da Amazon.
      if (ehLinkMl(linha)) {
        if (!tokenAffOk()) { erros.push({ linha, erro: 'Mercado Livre nao configurado (ML_AFF_TOKEN)' }); continue; }
        const rml = await resolverLinhaVitrineMl(linha);
        if (!rml || rml.erro) { erros.push({ linha, erro: rml?.erro || 'falhou' }); continue; }
        const jaTinhaMl = !!itemVitrine(rml.asin);
        salvos.push({ ...salvarItemVitrine({ ...rml, cupom }), jaExistia: jaTinhaMl });
        continue;
      }
      // Rede Awin: qualquer anunciante afiliado. Vem antes do fallback da
      // Amazon, que so deve receber o que nenhuma outra loja reconheceu.
      if (ehLinkAwin(linha)) {
        const raw = await resolverLinhaVitrineAwin(linha);
        if (!raw || raw.erro) { erros.push({ linha, erro: raw?.erro || 'falhou' }); continue; }
        const jaTinhaAw = !!itemVitrine(raw.asin);
        salvos.push({ ...salvarItemVitrine({ ...raw, cupom }), jaExistia: jaTinhaAw,
          aviso: raw.precoManual ? 'preco informado a mao — a loja bloqueou a leitura automatica' : null });
        continue;
      }
      const r = await resolverLinhaVitrine(linha);
      if (!r || r.erro) { erros.push({ linha, erro: r?.erro || 'falhou' }); continue; }
      const jaTinha = !!itemVitrine(r.asin);
      salvos.push({ ...salvarItemVitrine({ ...r, cupom }), jaExistia: jaTinha });
    } catch (e) { erros.push({ linha, erro: e.message }); }
  }
  // Titulo real antes de o produto aparecer na base — ver resolverNomesProvisorios.
  if (salvos.length) {
    await resolverNomesProvisorios(salvos.map(s => s.asin));
    for (const s of salvos) {
      const atual = itemVitrine(s.asin);
      if (atual?.nome) s.nome = atual.nome;
    }
  }

  console.log('[VITRINE] Cadastro — ' + salvos.length + ' ok, ' + erros.length + ' erro(s).');
  res.json({ ok: salvos.length > 0, salvos, erros });
});

// LEGADO — o painel nao usa mais este caminho. Todo disparo da vitrine passa
// agora pelas listas (salvas ou de envio unico), que enviam um produto por vez
// com intervalo em vez da rajada de 3-5s que este endpoint faz. Mantido apenas
// para nao quebrar chamada externa que ainda aponte para ca.
// O preco e SEMPRE consultado agora — item salvo tem preco velho, e anunciar
// preco que nao existe mais e o erro que este pipeline existe para evitar.
app.post('/vitrine/disparar', async (req, res) => {
  const asins = Array.isArray(req.body?.asins) ? req.body.asins.filter(Boolean) : [];
  if (!asins.length) return res.status(400).json({ ok:false, erro:'selecione ao menos um produto' });
  if (!conectado || !sock) {
    const ok = await aguardarSock();
    if (!ok) return res.status(503).json({ ok:false, erro:'WhatsApp não conectado.' });
  }

  // Cada loja tem sua API: separa antes de consultar e junta os resultados.
  const itens = asins.map(a => itemVitrine(a)).filter(Boolean);
  const daShopee = itens.filter(i => i.loja === 'Shopee');
  const daMl     = itens.filter(i => i.loja === 'Mercado Livre');
  const daMagalu = itens.filter(i => i.loja === 'Magazine Luiza');
  const daAmazon = asins.filter(a =>
    !daShopee.some(s => s.asin === a) && !daMl.some(m => m.asin === a)
    && !daMagalu.some(g => g.asin === a));

  let montado = { prontos: [], descartados: [] };
  if (daAmazon.length) {
    try {
      const m = await montarOfertasVitrine(daAmazon, req.body?.cupom || null);
      montado.prontos.push(...m.prontos); montado.descartados.push(...m.descartados);
    } catch (e) { return res.status(500).json({ ok:false, erro:'falha na API da Amazon: ' + e.message }); }
  }
  if (daMagalu.length) {
    try {
      const m = await montarOfertasMagaluVitrine(daMagalu, req.body?.cupom || null);
      montado.prontos.push(...m.prontos); montado.descartados.push(...m.descartados);
    } catch (e) {
      daMagalu.forEach(i => montado.descartados.push({ asin:i.asin, nome:i.nome, motivo:'Magazine Luiza: ' + e.message }));
    }
  }
  if (daMl.length) {
    if (!tokenAffOk()) {
      daMl.forEach(i => montado.descartados.push({ asin:i.asin, nome:i.nome, motivo:'Mercado Livre nao configurado' }));
    } else {
      try {
        const m = await montarOfertasMlVitrine(daMl, req.body?.cupom || null);
        montado.prontos.push(...m.prontos); montado.descartados.push(...m.descartados);
      } catch (e) {
        daMl.forEach(i => montado.descartados.push({ asin:i.asin, nome:i.nome, motivo:'Mercado Livre: ' + e.message }));
      }
    }
  }
  if (daShopee.length) {
    if (!credenciaisShopeeOk()) {
      daShopee.forEach(i => montado.descartados.push({ asin:i.asin, nome:i.nome, motivo:'Shopee não configurada' }));
    } else {
      try {
        const m = await montarOfertasShopeeVitrine(daShopee, req.body?.cupom || null);
        montado.prontos.push(...m.prontos); montado.descartados.push(...m.descartados);
      } catch (e) {
        daShopee.forEach(i => montado.descartados.push({ asin:i.asin, nome:i.nome, motivo:'Shopee: ' + e.message }));
      }
    }
  }

  const enviados = [], falhas = [];
  for (const o of montado.prontos) {
    const oferta = {
      id: gerarId(), origem:'vitrine',
      tipoConteudo: o.produto.loja === 'Shopee' ? 'oferta_shopee'
                : o.produto.loja === 'Mercado Livre' ? 'oferta_ml'
                : o.produto.loja === 'Magazine Luiza' ? 'oferta_magalu'
                : String(o.asin || '').startsWith('AWIN-') ? 'oferta_awin' : 'oferta_amazon',
      mensagemFormatada: o.mensagem,
      dadosExtraidos: {
        loja:o.produto.loja || 'Amazon', asin:o.asin, titulo:o.produto.titulo, preco:o.produto.preco,
        precoDe:o.produto.precoDe, desconto:o.produto.desconto, link:o.produto.link,
        cupom:o.cupom, precoFinal:o.precoFinal,
        precoDeReferencia: !!o.precoDeReferencia,
        // URL da imagem para a vitrine publica (o base64 so serve ao WhatsApp).
        imagemUrl: o.produto.imagemUrl || null,
      },
      imagens: [],
    };
    // A imagem alimenta o thumbnail do link preview; falha nela nao impede o envio.
    try {
      const img = await baixarImagemProduto(o.produto.imagemUrl);
      if (img) oferta.imagens = [img];
    } catch (e) {}

    try {
      const r = await enviarOfertaParaDestinos(o.mensagem, null, oferta);
      marcarDisparo(o.asin);
      enviados.push({ asin:o.asin, nome:o.nome, grupos:r.enviados.length,
                      cupom:o.cupom?.codigo || null, aviso:o.avisoCupom || null });
    } catch (e) {
      falhas.push({ asin:o.asin, nome:o.nome, erro:e.message });
    }
    // Mesmo espacamento do radar: rajada em varios grupos e o padrao que o
    // WhatsApp usa para identificar automacao.
    if (montado.prontos.length > 1) await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000));
  }

  console.log('[VITRINE] Disparo — ' + enviados.length + ' enviada(s), '
    + falhas.length + ' falha(s), ' + montado.descartados.length + ' descartada(s).');
  res.json({ ok:true, enviados, falhas, descartados: montado.descartados });
});

app.post('/vitrine/:asin', (req, res) => {
  if (!itemVitrine(req.params.asin)) return res.status(404).json({ ok:false, erro:'produto não está na vitrine' });
  res.json({ ok:true, item: salvarItemVitrine({ asin: req.params.asin, ...req.body }) });
});

app.delete('/vitrine/:asin', (req, res) => {
  if (!removerItemVitrine(req.params.asin)) return res.status(404).json({ ok:false, erro:'não encontrado' });
  res.json({ ok:true });
});

// ── TEMPLATES DE MENSAGEM POR LOJA ───────────────────────────────────────────
app.get('/templates', (req, res) => {
  res.json({ ok:true, templates: listarTemplates(),
             variaveis: VARIAVEIS_TEMPLATE, variaveisCupom: VARIAVEIS_CUPOM });
});

// Renderiza um corpo de template com dados de exemplo. Serve ao preview ao vivo
// do editor: o operador ve o resultado sem precisar esperar uma oferta real.
app.post('/templates/preview', (req, res) => {
  try {
    // Template de cupom tem outro conjunto de variaveis — previa propria, com
    // um cupom de exemplo que exercita minimo, teto de desconto e codigo.
    if (req.body.tipo === 'cupom') {
      const corpoCup = req.body.corpo !== undefined
        ? req.body.corpo
        : (templateCupom()?.corpo || '');
      return res.json({ ok:true, mensagem: renderTemplate(corpoCup, varsDoCupomTSP({
        loja:'Amazon', tipo:'pct', valor:15, minimo:150, limite:60,
        codigo: req.body.comCupom === false ? '' : 'CURTEAPROMO',
      })) });
    }
    const exemplo = {
      asin:'B0H6N6K239', loja: req.body.loja || 'Amazon', marca:'Samsung',
      titulo:'Samsung Smart TV 58" Crystal UHD 4K U8000H 2026, Vision AI Companion, Modo Jogo',
      preco:3032.10, precoDe:3639.00, desconto:17, disponivel:true,
      nota:4.6, avaliacoes:812, vendedor:'Amazon.com.br', dealTermina:null,
      link:'https://www.amazon.com.br/dp/B0H6N6K239?tag=tdsobrepromos-20',
    };
    const cupom = req.body.comCupom === false ? null
      : { reg:{ codigo:'CURTEAPROMO' }, desconto:100, citado:true };
    const corpo = req.body.corpo !== undefined
      ? req.body.corpo
      : (templateDaLoja(req.body.loja)?.corpo || '');
    res.json({ ok:true, mensagem: renderTemplate(corpo, varsDoProduto(exemplo, cupom)) });
  } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
});

app.post('/templates/:loja', (req, res) => {
  try {
    const tpl = salvarTemplate(req.params.loja, req.body || {});
    console.log('[TPL] Template salvo — ' + req.params.loja);
    res.json({ ok:true, template: tpl });
  } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
});

// Monta a mensagem de um cupom a partir do template '_cupom'. Existe para a
// aba Cupom do painel parar de ter a sua propria copia do formato: o que o
// operador gera na mao e o que o auto-envio dispara saem do MESMO corpo.
app.post('/cupons/montar', (req, res) => {
  try {
    const b = req.body || {};
    const num = v => (v === '' || v === null || v === undefined) ? null : Number(v);
    res.json({ ok:true, mensagem: formatarCupomTSP({
      loja:    b.loja,
      tipo:    b.tipo === 'pct' ? 'pct' : 'reais',
      valor:   num(b.valor) || 0,
      minimo:  num(b.minimo),
      maximo:  num(b.maximo),
      limite:  num(b.limite),
      codigo:  String(b.codigo || '').trim(),
      gatilho: b.gatilho,
      aviso:   b.aviso,
      minimoDesconhecido: !!b.minimoDesconhecido,
    }) });
  } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
});

app.delete('/templates/:loja', (req, res) => {
  if (!removerTemplate(req.params.loja)) {
    return res.status(400).json({ ok:false, erro:'Template nao encontrado, ou e o padrao (que nao pode ser removido).' });
  }
  res.json({ ok:true });
});

// Sincroniza a base com a pagina "Meus cupons" do ML: corrige valores, grava a
// expiracao real quando o ML informa, e desativa o que saiu do ar. Sem isto a
// validade e so o TTL de 24h, que e chute.
app.post('/cupons/sync-ml', async (req, res) => {
  if (!tokenAffOk()) return res.status(400).json({ ok:false, erro:'ML_AFF_TOKEN nao configurado' });
  try {
    const { cupons: naPagina, totalDeclarado, semCodigo, fontes } = await lerTodosCuponsMl();
    if (!naPagina.length) {
      return res.json({ ok:false, erro:'nenhum cupom lido — sessao pode ter caido' });
    }

    // Leitura completa = todos os cards do ML foram vistos, somando os que tem
    // codigo e os que nao tem (esses nunca entram na base, mas contam no total).
    const vistos = naPagina.length + (semCodigo || 0);
    const leituraCompleta = !totalDeclarado || vistos >= totalDeclarado;

    const mapaPagina = new Map(naPagina.map(c => [c.codigo.toUpperCase(), c]));
    const atualizados = [], desativados = [], criados = [];
    // Cupom da base que o ML nao lista cai em um de tres casos: ja venceu, nunca
    // foi ativado na conta, ou esta ativo com um card cujo rotulo nao traz o
    // codigo digitavel (a raspagem nunca o encontra). A pagina nao distingue os
    // tres — quem distingue e o proprio ML, no "Inserir codigo". Por isso a
    // decisao sai do loop e vai para a verificacao autoritativa mais abaixo.
    const ausentes = [];

    // Percorre a NOSSA base e procura cada cupom na pagina — nao o contrario.
    // Assim os cards sem codigo digitavel deixam de ser um caso especial.
    for (const reg of listarCuponsBase()) {
      if (reg.loja !== 'Mercado Livre') continue;
      const naTela = mapaPagina.get(String(reg.codigo).toUpperCase());

      if (!naTela) {
        // Leitura parcial nao barra mais a verificacao. O input-code responde por
        // cupom, individualmente, e nao depende de a pagina ter vindo inteira —
        // um unico card que o parser nao entende travava o bloco para sempre.
        // Quem protege contra desativacao indevida agora e o canalAtivacaoOk.
        if (reg.ativo === false) continue;
        ausentes.push({ codigo: reg.codigo, chave: reg.chave, confirmado: reg.confirmadoNoMl === true,
                        observacao: reg.observacao || null, validadeAte: reg.validadeAte || null });
        continue;
      }

      const campos = { tipo:naTela.tipo, valor:naTela.valor,
                       minimo:naTela.minimo, limite:naTela.limite, ativo:true,
                       confirmadoNoMl:true };
      // Recusa antiga que o proprio sync escreveu perde o sentido no momento em
      // que o cupom reaparece na conta. Observacao do operador nao e tocada.
      if (/^Desativado no sync/.test(reg.observacao || '')) campos.observacao = null;
      // Validade real: contador tem prioridade sobre o texto ("quarta-feira").
      const validade = naTela.expiraEm || validadeDeTexto(naTela.venceTexto);
      if (validade) campos.validadeAte = validade;
      else {
        // Card sem linha "Vence ...": acontece quando o ML mostra "Esta esgotando"
        // no lugar do prazo. O cupom esta na conta AGORA, entao vale pelo menos
        // hoje — deixar a validade congelada no TTL de 24h da captura o mata em
        // silencio (cupomVigente reprova e ele some das ofertas).
        const atual = Date.parse(reg.validadeAte || '');
        if (!atual || atual < Date.now()) campos.validadeAte = validadeDeTexto('amanha');
      }
      atualizarCupomBase(reg.chave, campos);
      atualizados.push({ codigo:reg.codigo, valor:naTela.valor, minimo:naTela.minimo,
                         limite:naTela.limite,
                         validadeAte:campos.validadeAte || reg.validadeAte || null,
                         prazoInferido: !validade && !!campos.validadeAte,
                         esgotando:naTela.esgotando });
    }

    // Cupom que o ML lista e a base ainda nao tem.
    if (req.body?.criarNovos !== false) {
      const naBase = new Set(listarCuponsBase()
        .filter(r => r.loja === 'Mercado Livre')
        .map(r => String(r.codigo).toUpperCase()));
      for (const c of naPagina) {
        if (naBase.has(c.codigo.toUpperCase())) continue;
        const reg = registrarCupomBase({ loja:'Mercado Livre', ...c, confirmadoNoMl:true });
        // Mesmo fallback do loop acima: card "esgotando" nao traz prazo, e um
        // cupom recem-lido da conta nao pode nascer com validade menor que a do
        // proprio card.
        const validade = c.expiraEm || validadeDeTexto(c.venceTexto) || validadeDeTexto('amanha');
        if (validade && reg) atualizarCupomBase(reg.chave, { validadeAte: validade });
        criados.push(c.codigo);
      }
    }

    // Verificacao autoritativa do que a pagina nao mostrou. O endpoint de
    // inserir codigo responde tres coisas diferentes, e cada uma tem um destino:
    //   "ja foi adicionado"  -> esta na conta; o card so nao traz o codigo no
    //                           rotulo. Confirma e para de cobrar o operador.
    //   sucesso              -> entrou agora; a validade real vem no proximo sync.
    //   INVALID_1 / SOLD_OUT  -> nao existe ou acabou — MAS so vale como prova se o
    //                           canal responder outra coisa para algum codigo.
    // Teto por passada: o loop tem espera de 800ms entre chamadas e nao pode
    // estourar o timeout do agendador. O que sobrar volta na proxima hora.
    const MAX_VERIFICACOES = 40;
    const adiados = ausentes.slice(MAX_VERIFICACOES).map(p => p.codigo);
    const paraVerificar = ausentes.slice(0, MAX_VERIFICACOES);

    const pendentesAtivacao = [], ativadosAgora = [], jaNaConta = [], indeterminados = [];
    // Recusa NAO desativa na hora. Quando o canal de ativacao cai, o ML responde
    // "codigo invalido" para tudo — inclusive para cupom que esta ativo na conta
    // neste exato momento. Tratar isso como prova de vencimento derruba cupom bom
    // em lote. As recusas ficam em quarentena ate o fim do loop, e so viram
    // desativacao se alguma outra resposta provar que o canal responde de verdade.
    const recusados = [];
    let bloqueio = false;
    for (let i = 0; i < paraVerificar.length; i++) {
      const p = paraVerificar[i];
      let r2 = null;
      try { r2 = await ativarCupomMl(p.codigo); }
      catch (e) { console.warn('[CUPONS-ML] Falha ao verificar ' + p.codigo + ':', e.message); }

      // Reapareceu na conta: recusa antiga escrita pelo sync perde o sentido.
      const limpar = /^Desativado no sync/.test(p.observacao || '') ? { observacao:null } : {};
      // PENDING prova que o cupom esta na conta e utilizavel AGORA. Se a base
      // ainda carrega uma validade vencida (cupom que nunca aparece na pagina com
      // codigo legivel, entao nunca teve o prazo atualizado), confirmar sem mexer
      // nela devolve um cupom que cupomVigente reprova na hora seguinte.
      const revalidar = Date.parse(p.validadeAte || '') > Date.now()
        ? {} : { validadeAte: validadeDeTexto('amanha') };

      if (!r2) { indeterminados.push(p.codigo); }
      else if (r2.jaTinha) {
        atualizarCupomBase(p.chave, { ativo:true, confirmadoNoMl:true, ...limpar, ...revalidar });
        jaNaConta.push(p.codigo);
      } else if (r2.ok) {
        atualizarCupomBase(p.chave, { ativo:true, confirmadoNoMl:true, ...limpar, ...revalidar });
        ativadosAgora.push(p.codigo);
      } else if (r2.expirado) {
        // O ML devolve data e hora do vencimento: melhor fonte de validade que
        // a pagina, que esconde o prazo em card "esgotando".
        recusados.push({ ...p, mensagem: r2.mensagem, validadeAte: r2.venceuEm });
      } else if (r2.invalido || r2.esgotado) {
        recusados.push({ ...p, mensagem: r2.mensagem });
      } else if (r2.bloqueado) {
        // Limite de taxa. Insistir so aprofunda o bloqueio e nenhuma resposta
        // seguinte valeria nada: para a passada e devolve o resto para a proxima.
        bloqueio = true;
        for (const resto of paraVerificar.slice(i)) adiados.push(resto.codigo);
        console.warn('[CUPONS-ML] HTTP 403 em ' + p.codigo + ' — limite de taxa do ML. '
          + (paraVerificar.length - i) + ' cupom(ns) adiado(s) para a proxima passada.');
        break;
      } else if (r2.payloadRejeitado) {
        // INVALID_6: o ML nao entendeu a chamada. Nao diz nada sobre o cupom.
        pendentesAtivacao.push(p.codigo);
        console.warn('[CUPONS-ML] ' + p.codigo + ': o ML rejeitou o payload (INVALID_6) — '
          + 'a chamada esta quebrada, o cupom nao esta em julgamento.');
      } else {
        // Resposta que nao encaixa em nenhum caso conhecido: nao mexe na base e
        // deixa para o operador olhar.
        pendentesAtivacao.push(p.codigo);
        console.warn('[CUPONS-ML] Resposta inesperada para ' + p.codigo + ': ' + (r2.mensagem || r2.status));
      }
      // 800ms derrubava o endpoint por volta da 13a chamada seguida.
      await new Promise(r3 => setTimeout(r3, 2500));
    }

    // Sinal de vida do canal: pelo menos um cupom que o ML reconheceu (entrou
    // agora ou ja estava na conta). Sem isso, "invalido" nao distingue cupom
    // vencido de endpoint fora do ar, e a base fica como esta.
    const canalAtivacaoOk = ativadosAgora.length > 0 || jaNaConta.length > 0;
    if (canalAtivacaoOk) {
      for (const p of recusados) {
        const campos = { ativo:false,
          observacao: 'Desativado no sync: ' + (p.mensagem || 'o ML recusou o codigo') };
        if (p.validadeAte) campos.validadeAte = p.validadeAte;
        atualizarCupomBase(p.chave, campos);
        desativados.push(p.codigo);
      }
    } else if (recusados.length) {
      for (const p of recusados) pendentesAtivacao.push(p.codigo);
      console.warn('[CUPONS-ML] ' + recusados.length + ' recusa(s) ignorada(s): o ML nao reconheceu '
        + 'nenhum codigo nesta passada — canal de ativacao provavelmente fora do ar. Nada desativado.');
    }

    console.log('[CUPONS-ML] Sync — ' + atualizados.length + ' atualizado(s), '
      + criados.length + ' novo(s), ' + desativados.length + ' desativado(s), '
      + jaNaConta.length + ' ja na conta, ' + ativadosAgora.length + ' ativado(s) agora'
      + (leituraCompleta ? '' : ' [leitura parcial da pagina]')
      + (adiados.length ? ' [' + adiados.length + ' adiado(s) para a proxima passada'
                        + (bloqueio ? ' por limite de taxa' : '') + ']' : '')
      + (canalAtivacaoOk ? '' : ' [canal de ativacao mudo: recusas ignoradas]') + '.');

    res.json({ ok:true, naPagina:naPagina.length, semCodigo, totalDeclarado, leituraCompleta,
               canalAtivacaoOk, bloqueioTaxa: bloqueio,
               recusasIgnoradas: canalAtivacaoOk ? 0 : recusados.length,
               fontes, atualizados, criados, desativados, pendentesAtivacao,
               ativadosAgora, jaNaConta, indeterminados,
               naoAvaliados: adiados });
  } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
});

// ── BASE DE CUPONS ───────────────────────────────────────────────────────────
// Alimentada automaticamente pelo pipeline de cupons. Estes endpoints existem
// para o operador corrigir um valor mal extraido ou desligar um cupom que a
// loja derrubou antes da validade.
app.get('/cupons/base', (req, res) => {
  const itens = listarCuponsBase();
  const agora = Date.now();
  res.json({
    ok: true,
    total: itens.length,
    vigentes: itens.filter(c => c.ativo !== false && new Date(c.validadeAte).getTime() > agora).length,
    itens,
  });
});

// Criacao manual (um objeto ou um array). Usa o mesmo caminho de gravacao da
// captura automatica, entao um cupom semeado a mao e indistinguivel de um
// capturado do grupo — inclusive na validade de 2 dias.
app.post('/cupons/base', (req, res) => {
  const body = req.body;
  const lista = Array.isArray(body) ? body : [body];
  const criados = [], erros = [];

  for (const c of lista) {
    if (!c?.loja || !c?.codigo) { erros.push({ item: c, erro: 'loja e codigo sao obrigatorios' }); continue; }
    if (c.valor === undefined || c.valor === null || !isFinite(Number(c.valor)) || Number(c.valor) <= 0) {
      erros.push({ item: c, erro: 'valor deve ser numero maior que zero' }); continue;
    }
    try {
      const reg = registrarCupomBase(c);
      // Validade explicita sobrescreve o padrao de 2 dias.
      const final = c.validadeAte ? atualizarCupomBase(reg.chave, { validadeAte: c.validadeAte }) : reg;
      criados.push(final);
    } catch (e) { erros.push({ item: c, erro: e.message }); }
  }
  console.log('[CUPONS] Criacao manual — ' + criados.length + ' ok, ' + erros.length + ' erro(s).');
  res.status(erros.length && !criados.length ? 400 : 200).json({ ok: !!criados.length, criados, erros });
});

// Liga/desliga todos os cupons de uma loja de uma vez. Existe como endpoint (em
// vez de N chamadas do painel) para a operacao ser atomica no arquivo.
app.post('/cupons/loja/:loja', (req, res) => {
  if (typeof req.body?.ativo !== 'boolean') {
    return res.status(400).json({ ok:false, erro:'informe { ativo: true|false }' });
  }
  const n = definirAtivoPorLoja(req.params.loja, req.body.ativo);
  console.log('[CUPONS] ' + req.params.loja + ' — ' + n + ' cupom(ns) ' + (req.body.ativo ? 'ativado(s)' : 'desativado(s)') + '.');
  res.json({ ok:true, alterados:n });
});

app.post('/cupons/base/:chave', (req, res) => {
  const reg = atualizarCupomBase(req.params.chave, req.body || {});
  if (!reg) return res.status(404).json({ ok:false, erro:'Cupom nao encontrado: ' + req.params.chave });
  console.log('[CUPONS] Editado via painel — ' + reg.chave);
  res.json({ ok:true, cupom: reg });
});

app.delete('/cupons/base/:chave', (req, res) => {
  if (!removerCupomBase(req.params.chave)) return res.status(404).json({ ok:false, erro:'Cupom nao encontrado.' });
  res.json({ ok:true });
});

// ── VITRINE PUBLICA ──────────────────────────────────────────────────────────
// O site publico le arquivos estaticos no repositorio; estes endpoints existem
// para o operador conferir o estado e forcar uma republicacao sem esperar o
// ciclo de 30 minutos (util depois de corrigir um cupom a mao).
app.get('/publico/estado', (req, res) => {
  res.json({ ok: true, ...estadoFeedPublico() });
});

app.post('/publico/publicar', async (req, res) => {
  const r = await publicarAgora();
  res.status(r.ok ? 200 : 500).json(r);
});

// Diagnostico: descobre quais recursos a Creators API aceita para um ASIN.
app.post('/mkt/sonda', async (req, res) => {
  try {
    res.json(await sondarRecursos(req.body?.asin, req.body?.recursos || []));
  } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
});

// Sonda de rede: busca uma URL a partir do Railway e resume a resposta. Existe
// porque o bloqueio anti-bot depende do IP de origem — testar do meu ambiente
// nao diz nada sobre o que o servidor consegue acessar.
app.get('/sonda-url', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ ok:false, erro:'passe ?url=' });
  try {
    const r = await fetch(url, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
        'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none', 'Upgrade-Insecure-Requests': '1',
      },
      signal: AbortSignal.timeout(25000),
    });
    const html = await r.text();
    const titulo = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || null;
    const precos = [...html.matchAll(/"price"\s*:\s*"?([\d.,]+)/gi)].slice(0,4).map(m=>m[1]);
    res.json({
      ok: r.ok, status: r.status, urlFinal: r.url, tamanho: html.length, titulo,
      temNextData: html.includes('__NEXT_DATA__'),
      temLdJson: html.includes('application/ld+json'),
      bloqueado: /captcha|nao e possivel acessar|não é possível acessar|access denied/i.test(html),
      precosEncontrados: precos,
      amostra: html.slice(0, 260),
    });
  } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
});

// ── MERCADO LIVRE: OAuth ─────────────────────────────────────────────────────
app.get('/ml/status', (req, res) => res.json({ ok:true, ...estadoMl() }));

app.get('/ml/conectar', (req, res) => {
  if (!credenciaisMlOk()) {
    return res.status(400).send('<h3>ML_CLIENT_ID / ML_CLIENT_SECRET nao configurados no Railway.</h3>');
  }
  res.redirect(urlAutorizacao());
});

app.get('/ml/callback', async (req, res) => {
  if (req.query.error) {
    return res.status(400).send('<h3>Autorizacao negada: ' + String(req.query.error_description || req.query.error) + '</h3>');
  }
  if (!req.query.code) return res.status(400).send('<h3>Sem code na resposta do Mercado Livre.</h3>');
  try {
    const t = await trocarCodePorToken(String(req.query.code));
    console.log('[ML] Autorizado — user_id ' + t.user_id);
    res.send('<h2>Mercado Livre conectado.</h2><p>Pode fechar esta aba. '
      + 'O token sera renovado automaticamente.</p>');
  } catch (e) {
    console.error('[ML] Falha no callback:', e.message);
    res.status(500).send('<h3>Falha ao obter token: ' + e.message + '</h3>');
  }
});

// O ML exige uma URL de notificacoes ao criar a aplicacao. Nao usamos webhooks,
// mas respondemos 200 para o ML nao acumular erro de entrega.
app.post('/ml/webhook', (req, res) => res.sendStatus(200));
app.get('/ml/webhook', (req, res) => res.sendStatus(200));

// Estado do token de afiliados + verificacao sob demanda.
app.get('/ml/aff/status', async (req, res) => {
  if (req.query.verificar === '1' && tokenAffOk()) {
    await verificarTokenAff(ML_AFF_URL_TESTE, avisarTokenMlCaiu).catch(()=>{});
  }
  res.json({ ok:true, urlTeste: ML_AFF_URL_TESTE, ...saudeAff() });
});

app.get('/ml/aff/inspecionar', (req, res) => res.json({ ok:true, ...inspecionarTokenAff() }));

// Le uma URL de cupons e devolve o que o parser extrai — para comparar variantes.
app.get('/cupons/ler-ml', async (req, res) => {
  try { res.json(await lerCuponsAtivosMl(req.query.url || undefined)); }
  catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
});

// Sonda POST do painel de afiliados, para testar payloads do createLink.
app.post('/ml/aff/sonda', async (req, res) => {
  const { url, body } = req.body || {};
  if (!url) return res.status(400).json({ ok:false, erro:'informe url e body' });
  try {
    res.json(await chamarAff(url, {
      method: 'POST',
      body: JSON.stringify(body || {}),
      headers: {
        'Origin': 'https://www.mercadolivre.com.br',
        'Referer': 'https://www.mercadolivre.com.br/afiliados/linkbuilder',
        'x-requested-with': 'XMLHttpRequest',
      },
    }));
  } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
});

// Sonda do painel de afiliados: descobre quais endpoints o token abre.
app.get('/ml/aff/sonda', async (req, res) => {
  if (!req.query.url) return res.status(400).json({ ok:false, erro:'passe ?url=' });
  try { res.json(await chamarAff(req.query.url)); }
  catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
});

app.get('/ml/sonda', async (req, res) => {
  try { res.json(await sondarMl(req.query.caminho || '/users/me')); }
  catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
});

// Consulta crua de um item, para ver a resposta da API sem o pipeline no meio.
app.get('/ml/item', async (req, res) => {
  try { res.json({ ok:true, item: await buscarProdutoMl(req.query.id) }); }
  catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
});

app.post('/ml/testar', async (req, res) => {
  try { res.json({ ok:true, resultados: await processarTextoMl(req.body?.texto || '') }); }
  catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
});

// Diagnostico: despeja tudo que a pagina do produto fala sobre cupom, para
// escrever o parser contra o formato real. Nao aplica desconto nem publica nada.
app.get('/ml/diagnostico-cupom', async (req, res) => {
  if (!req.query.url) return res.status(400).json({ ok:false, erro:'passe ?url=' });
  try { res.json({ ok:true, ...await dumpCupomMl(req.query.url) }); }
  catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
});

// Diagnostico: procura campaign_id na pagina de cupons da conta. Se existir,
// o vinculo campanha -> codigo fica exato e a ambiguidade de dois cupons de
// mesmo percentual deixa de existir.
app.get('/ml/diagnostico-campanhas', async (req, res) => {
  try { res.json({ ok:true, ...await dumpCampanhasCupomMl() }); }
  catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
});

// Le os cupons da conta do ML e grava na base com codigo, campanhaId, minimo,
// teto e expiracao reais. O campanhaId e o que permite casar, sem ambiguidade,
// o cupom que a pagina do produto anuncia com o codigo que o membro digita.
// Consulta o mapa de campanhas aprendido pelo sync. Com ?id= responde uma so.
app.get('/ml/campanhas', (req, res) => {
  try {
    if (req.query.id) {
      const c = campanhaMlConhecida(req.query.id);
      return res.json({ ok:true, id:req.query.id, conhecida:!!c, campanha:c });
    }
    const lista = listarCampanhasMl();
    res.json({ ok:true, total: lista.length, campanhas: lista });
  } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
});

app.get('/ml/sync-cupons-conta', async (req, res) => {
  try { res.json({ ok:true, ...await sincronizarCuponsContaMl() }); }
  catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
});

app.post('/magalu/testar', async (req, res) => {
  try { res.json({ ok:true, loja: lojaMagalu(), resultados: await processarTextoMagalu(req.body?.texto || '') }); }
  catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
});

app.get('/magalu/converter', async (req, res) => {
  if (!req.query.url) return res.status(400).json({ ok:false, erro:'passe ?url=' });
  try {
    const r = await converterLinkMagalu(req.query.url);
    res.json(r ? { ok:true, ...r } : { ok:false, erro:'não foi possível extrair o código do produto' });
  } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
});

// Cola um link e ve a mensagem que sairia, sem enfileirar nem publicar nada.
app.post('/mkt/testar', async (req, res) => {
  try {
    const r = await processarTextoAmazon(req.body.texto || '', { ignorarDedup: true });
    res.json({ ok:true, resultados: r });
  } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
});

// ── MONTAR OFERTA A PARTIR DE UM LINK ────────────────────────────────────────
// Serve ao gerador de mensagens do TSP: o operador cola o link de um produto e
// recebe o preco verificado na fonte (nunca digitado a mao), o link de afiliado
// da nossa conta e os cupons vigentes daquela loja para vincular. So consulta —
// nao enfileira, nao dispara e nao marca dedup, entao pode ser chamado a
// vontade sem sujar o radar automatico.
function chaveLojaSimples(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function pipelineDoLink(texto) {
  if (ehLinkMl(texto))     return { loja: 'Mercado Livre',  run: t => processarTextoMl(t) };
  if (ehLinkShopee(texto)) return { loja: 'Shopee',         run: t => processarTextoShopee(t) };
  if (ehLinkMagalu(texto)) return { loja: 'Magazine Luiza', run: t => processarTextoMagalu(t) };
  // Rede Awin: cobre os 80+ anunciantes afiliados, cada um com sua propria
  // pagina de produto. Fica depois das lojas com API propria e antes do
  // fallback da Amazon, que so deve pegar o que ninguem reconheceu.
  const progAwin = programaAwinPorUrl((String(texto).match(/https?:\/\/[^\s]+/) || [''])[0]);
  if (progAwin) return {
    loja: String(progAwin.name).replace(/\s*\(?(BR|Global)\)?\s*$/i, '').trim(),
    run: t => processarTextoAwin(t),
  };
  return { loja: 'Amazon', run: t => processarTextoAmazon(t, { ignorarDedup: true, ignorarMinimo: true }) };
}

app.post('/mkt/montar', async (req, res) => {
  const link = String(req.body?.link || '').trim();
  if (!link) return res.status(400).json({ ok:false, erro:'informe { link }' });

  const pipe = pipelineDoLink(link);
  let resultados;
  try { resultados = await pipe.run(link); }
  catch (e) { return res.status(500).json({ ok:false, loja:pipe.loja, erro:e.message }); }

  // Um resultado descartado (dedup, desconto baixo) ainda traz o produto: aqui
  // quem decide o que divulgar e o operador, entao o descarte vira aviso.
  const achado = resultados.find(r => r.produto?.preco) || resultados[0];
  if (!achado) return res.status(404).json({ ok:false, loja:pipe.loja,
    erro:'nenhum produto reconhecido nesse link.' });

  const p = achado.produto;
  if (!p.preco) return res.status(422).json({ ok:false, loja:pipe.loja, produto:p,
    erro: achado.descartadoPor || 'nao foi possivel ler o preco do produto' });

  const loja = p.loja || pipe.loja;

  // Cupons vinculaveis: vigentes, da mesma loja e que realmente rendem desconto
  // neste preco — cupom com minimo acima do produto nem aparece na lista.
  const cupons = listarCuponsBase()
    .filter(cp => cupomVigente(cp) && chaveLojaSimples(cp.loja) === chaveLojaSimples(loja))
    .map(cp => ({ codigo:cp.codigo, tipo:cp.tipo, valor:cp.valor, minimo:cp.minimo,
                  maximo:cp.maximo, limite:cp.limite, validadeAte:cp.validadeAte,
                  descontoAplicado: calcularDesconto(cp, p.preco) }))
    .filter(cp => cp.descontoAplicado > 0)
    .sort((a, b) => b.descontoAplicado - a.descontoAplicado);

  // O cupom so entra se o operador pedir pelo codigo. Aplicar sozinho o "melhor
  // da base" anunciaria um desconto que ele nao escolheu.
  let cupom = null, avisoCupom = null;
  const codigo = String(req.body?.cupom || '').trim();
  if (codigo) {
    const reg = cupomPorCodigo(loja, codigo);
    if (!reg)                    avisoCupom = 'cupom ' + codigo + ' nao esta na base de ' + loja;
    else if (!cupomVigente(reg)) avisoCupom = 'cupom ' + codigo + ' expirado ou inativo';
    else {
      const desconto = calcularDesconto(reg, p.preco);
      if (desconto > 0) cupom = { reg, desconto, citado: true };
      else avisoCupom = 'cupom ' + codigo + ' nao se aplica a este preco'
        + (reg.minimo != null ? ' (minimo R$ ' + reg.minimo + ')' : '');
    }
  }

  const vars = varsDoProduto(p, cupom);
  vars.vendas       = p.vendas || '';
  vars.codigo_busca = p.codigoBusca || '';
  if (req.body?.gatilho) vars.gatilho = String(req.body.gatilho);

  res.json({
    ok: true,
    loja,
    produto: {
      titulo: p.titulo || '', marca: p.marca || '', link: p.link || link,
      imagemUrl: p.imagemUrl || null, preco: p.preco, precoDe: p.precoDe || null,
      desconto: p.desconto || 0, disponivel: p.disponivel !== false,
      vendedor: p.vendedor || null, nota: p.nota || null, avaliacoes: p.avaliacoes || null,
      asin: p.asin || null, codigoBusca: p.codigoBusca || null,
    },
    cupom: cupom ? { codigo: cupom.reg.codigo, tipo: cupom.reg.tipo, valor: cupom.reg.valor,
                     minimo: cupom.reg.minimo, maximo: cupom.reg.maximo, limite: cupom.reg.limite,
                     desconto: cupom.desconto } : null,
    avisoCupom,
    precoFinal: cupom ? Math.max(0, p.preco - cupom.desconto) : p.preco,
    cupons,
    // Mensagem pelo mesmo template da loja que o radar usa, para a oferta montada
    // a mao sair no formato identico ao das automaticas.
    mensagem: renderTemplate(templateDaLoja(loja)?.corpo || '', vars),
    avisos: resultados.filter(r => r.descartadoPor).map(r => r.descartadoPor),
  });
});

// Cola um link Shopee e ve a mensagem que sairia, sem enfileirar nem publicar.
app.post('/shopee/testar', async (req, res) => {
  if (!credenciaisShopeeOk()) {
    return res.status(400).json({ ok:false, erro:'SHOPEE_APP_ID / SHOPEE_SECRET nao configurados no Railway.' });
  }
  try {
    const r = await processarTextoShopee(req.body?.texto || '');
    res.json({ ok:true, resultados: r });
  } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
});

// Prova que o link gerado rende comissao para esta conta: confere procedencia,
// parametros de tracking e o sub id injetado.
app.get('/shopee/validar', async (req, res) => {
  if (!credenciaisShopeeOk()) {
    return res.status(400).json({ ok:false, erro:'SHOPEE_APP_ID / SHOPEE_SECRET nao configurados.' });
  }
  if (!req.query.url) return res.status(400).json({ ok:false, erro:'passe ?url= com o link do produto' });
  try {
    const subId = req.query.subId || ('cdvteste' + Date.now().toString().slice(-6));
    res.json(await validarAtribuicao(req.query.url, subId));
  } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
});

// Sonda de schema: executa uma query GraphQL crua contra a Open API da Shopee.
// Mesmo papel do /ml/aff/sonda — existe para descobrir o que a API expoe (ex.:
// se ha algo de voucher com prazo real) sem chutar campo no radar e derrubar o
// pipeline. So le: nao grava nada na base nem envia mensagem.
//
//   POST /shopee/sonda  { "query": "{ __schema { queryType { fields { name } } } }" }
app.post('/shopee/sonda', async (req, res) => {
  if (!credenciaisShopeeOk()) {
    return res.status(400).json({ ok:false, erro:'SHOPEE_APP_ID / SHOPEE_SECRET nao configurados.' });
  }
  const query = req.body?.query;
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ ok:false, erro:'passe {"query":"..."} com a operacao GraphQL' });
  }
  // Mutation aqui seria efeito colateral disfarcado de diagnostico.
  if (/^\s*mutation\b/i.test(query)) {
    return res.status(400).json({ ok:false, erro:'a sonda so aceita query, nao mutation' });
  }
  try {
    res.json({ ok:true, dados: await chamarShopee(query, req.body?.variables || null) });
  } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
});

// Diagnostico da credencial: uma consulta minima que prova assinatura e acesso.
app.get('/shopee/status', async (req, res) => {
  if (!credenciaisShopeeOk()) {
    return res.json({ ok:false, configurado:false, erro:'SHOPEE_APP_ID / SHOPEE_SECRET ausentes.' });
  }
  try {
    const ids = await extrairIdsShopee(req.query.url || '');
    if (!ids.length) return res.json({ ok:true, configurado:true, aviso:'passe ?url= com um link Shopee para testar a consulta.' });
    const node = await buscarProdutoShopee(ids[0]);
    res.json({ ok:true, configurado:true, produto: node ? normalizarShopee(node) : null });
  } catch(e) { res.json({ ok:false, configurado:true, erro:e.message }); }
});

app.get('/grupos', async (req, res) => {
  // ── Operador nao-padrao: lista os grupos da CONTA DELE, nunca os do socket
  // principal (que sao os grupos do telefone da operacao padrao).
  if (req.tenantId !== TENANT_PADRAO) {
    const idConta = contaConectadaDoTenant(req.tenantId);
    if (!idConta) return res.json({ ok:true, total:0, grupos:[], aviso:'Conecte um WhatsApp na aba Conexao para listar os seus grupos.' });
    try {
      const chats = await contasExtras.get(idConta).sock.groupFetchAllParticipating();
      const grupos = Object.values(chats)
        .map(g => ({ id: g.id, nome: g.subject || '(sem nome)' }))
        .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
      // Nomes tambem no cache global: paineis resolvem jid->nome por ele.
      for (const g of grupos) if (!NOMES_GRUPOS.has(g.id)) NOMES_GRUPOS.set(g.id, g.nome);
      return res.json({ ok:true, total:grupos.length, grupos });
    } catch (e) { return res.status(500).json({ ok:false, erro:e.message }); }
  }

  // groupFetchAllParticipating leva ~6s com 400 grupos e trava a aba a cada
  // abertura. O cache e preenchido na conexao e a lista muda raramente, entao
  // responde na hora e so busca de verdade com ?refresh=1 ou cache vazio.
  if (NOMES_GRUPOS.size && req.query.refresh !== '1') {
    const grupos = [...NOMES_GRUPOS.entries()]
      .map(([id, nome]) => ({ id, nome }))
      .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
    return res.json({ ok:true, total:grupos.length, grupos, doCache:true });
  }
  if (!sock || !conectado) {
    const ok = await aguardarSock(15000);
    if (!ok) return res.status(503).json({ ok:false, erro:'WhatsApp nao conectado.' });
  }
  try {
    const chats  = await sock.groupFetchAllParticipating();
    NOMES_GRUPOS.clear();
    for (const g of Object.values(chats)) NOMES_GRUPOS.set(g.id, g.subject || '(sem nome)');
    const grupos = Object.values(chats).map(g=>({id:g.id,nome:g.subject||'(sem nome)'})).sort((a,b)=>a.nome.localeCompare(b.nome,'pt-BR'));
    res.json({ ok:true, total:grupos.length, grupos });
  } catch(err) {
    if (err.message?.includes('Connection Closed') || err.message?.includes('Connection Terminated')) {
      console.warn('[GRUPOS] Conexão caiu durante fetch, aguardando reconexão...');
      const ok = await aguardarSock(20000);
      if (!ok) return res.status(503).json({ ok:false, erro:'WhatsApp reconectando, tente novamente.' });
      try {
        const chats  = await sock.groupFetchAllParticipating();
        const grupos = Object.values(chats).map(g=>({id:g.id,nome:g.subject||'(sem nome)'})).sort((a,b)=>a.nome.localeCompare(b.nome,'pt-BR'));
        return res.json({ ok:true, total:grupos.length, grupos });
      } catch(err2) { return res.status(500).json({ ok:false, erro:err2.message }); }
    }
    res.status(500).json({ ok:false, erro:err.message });
  }
});

// ── DISTRIBUIDOR DE ENTRADAS: metadados e convite de grupo ────────────────────
// Consumido pelo gerenciador de links do proxy CDV (/g/<slug>). Ele precisa de
// duas coisas que so o Baileys sabe: quantas pessoas ja estao no grupo (para
// parar de mandar gente quando encher) e o link de convite atual.
const _ggMetaCache    = new Map();   // jid -> { ts, nome, membros, souAdmin }
const _ggConviteCache = new Map();   // jid -> { ts, url }
const GG_META_TTL_MS    = 60 * 1000;
const GG_CONVITE_TTL_MS = 60 * 60 * 1000;

function _ggMeuNumero() {
  const id = sock?.user?.id || '';
  return String(id).split(':')[0].split('@')[0];
}

// Identidades da conta conectada. O WhatsApp migrou para enderecamento LID: os
// participantes chegam como <id>@lid em vez de <numero>@s.whatsapp.net, entao
// comparar so pelo telefone nunca casava e souAdmin ficava false ate em grupo
// criado pela propria conta. Junta telefone + lid num Set.
function _ggMinhasIds() {
  const ids = new Set();
  for (const v of [sock?.user?.id, sock?.user?.lid]) {
    const n = String(v || '').split(':')[0].split('@')[0].trim();
    if (n) ids.add(n);
  }
  return ids;
}

// Um participante pode vir identificado por qualquer um destes campos,
// dependendo da versao do Baileys e de o grupo ja ter migrado para LID.
function _ggIdsDoParticipante(p) {
  return [p?.id, p?.lid, p?.jid]
    .map(v => String(v || '').split(':')[0].split('@')[0].trim())
    .filter(Boolean);
}

async function _ggInfoGrupo(jid, forcar) {
  const c = _ggMetaCache.get(jid);
  if (!forcar && c && (Date.now() - c.ts) < GG_META_TTL_MS) return c;
  const md = await sock.groupMetadata(jid);
  const meus = _ggMinhasIds();
  const meu = (md.participants || []).find(p =>
    _ggIdsDoParticipante(p).some(n => meus.has(n)));
  const info = {
    ts: Date.now(),
    nome: md.subject || '(sem nome)',
    membros: (md.participants || []).length,
    souAdmin: !!(meu && meu.admin),
  };
  _ggMetaCache.set(jid, info);
  NOMES_GRUPOS.set(jid, info.nome);
  return info;
}

// Lote: o proxy manda todos os jids de um link de uma vez. Erro em um grupo nao
// derruba os outros — o distribuidor segue usando a ultima contagem conhecida.
app.get('/grupos/info', async (req, res) => {
  const jids = String(req.query.jids || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!jids.length) return res.status(400).json({ ok:false, erro:'informe ?jids=jid1,jid2' });
  if (!sock || !conectado) {
    const ok = await aguardarSock(15000);
    if (!ok) return res.status(503).json({ ok:false, erro:'WhatsApp nao conectado.' });
  }
  const forcar = req.query.refresh === '1';
  const grupos = [];
  for (const jid of jids.slice(0, 60)) {
    try {
      const i = await _ggInfoGrupo(jid, forcar);
      grupos.push({ jid, nome:i.nome, membros:i.membros, souAdmin:i.souAdmin });
    } catch (e) {
      grupos.push({ jid, nome: NOMES_GRUPOS.get(jid) || null, membros: null, erro: e.message });
    }
  }
  res.json({ ok:true, grupos });
});

// groupInviteCode exige que o numero conectado seja ADMIN do grupo.
app.get('/grupos/convite', async (req, res) => {
  const jid = String(req.query.jid || '').trim();
  if (!jid.endsWith('@g.us')) return res.status(400).json({ ok:false, erro:'informe ?jid=<id>@g.us' });
  // Operador nao-padrao: o convite sai da CONTA DELE — o socket principal nem
  // esta nos grupos dele, e um convite gerado pelo numero errado seria de outro
  // grupo homonimo ou simplesmente falharia.
  let sockConvite = null;
  if (req.tenantId !== TENANT_PADRAO) {
    const idConta = contaConectadaDoTenant(req.tenantId);
    if (!idConta) return res.status(503).json({ ok:false, erro:'WhatsApp do operador nao conectado.' });
    sockConvite = contasExtras.get(idConta).sock;
  } else {
    if (!sock || !conectado) {
      const ok = await aguardarSock(15000);
      if (!ok) return res.status(503).json({ ok:false, erro:'WhatsApp nao conectado.' });
    }
    sockConvite = sock;
  }
  const forcar = req.query.refresh === '1';
  const chaveCache = req.tenantId + '|' + jid;   // cache por operador: mesmo jid, contas diferentes
  const c = _ggConviteCache.get(chaveCache);
  if (!forcar && c && (Date.now() - c.ts) < GG_CONVITE_TTL_MS) {
    return res.json({ ok:true, jid, url:c.url, doCache:true });
  }
  try {
    const code = await sockConvite.groupInviteCode(jid);
    const url  = 'https://chat.whatsapp.com/' + code;
    _ggConviteCache.set(chaveCache, { ts: Date.now(), url });
    res.json({ ok:true, jid, url });
  } catch (e) {
    const bruto = e?.message || String(e);
    const erro = /forbidden|not-authorized|401|403/i.test(bruto)
      ? 'sem permissao — o numero conectado precisa ser ADMIN deste grupo'
      : bruto;
    res.status(500).json({ ok:false, jid, erro });
  }
});

// ── CENSO DE MEMBROS DOS GRUPOS DE DESTINO ───────────────────────────────────
// Fotografia diaria de quantas pessoas ha em cada grupo marcado como destino.
// Roda as 00:10 (SP) e fica gravada em disco: a leitura do painel e instantanea
// e nao depende de consultar 12+ grupos no WhatsApp a cada abertura da aba.
// A medicao logo depois da meia-noite fecha o ciclo do dia que terminou — por
// isso o ponto gravado pertence a ONTEM, e nao ao dia que esta comecando.
const CENSO_FILE = SESSAO_DIR + '/grupos_censo.json';
// Serie historica: uma linha por dia (SP), para o grafico de evolucao. Vive num
// arquivo separado porque e append-only e sobe para o GitHub — o censo do dia
// pode ser reescrito varias vezes, a serie nao.
const CENSO_HIST_ARQ  = 'grupos_censo_hist.json';
const CENSO_HIST_FILE = SESSAO_DIR + '/' + CENSO_HIST_ARQ;
const CENSO_HIST_DIAS = 400;
let _censo = { atualizadoEm: null, grupos: [] };
let _censoHist = { dias: {} };
let _censoRodando = false;

function _censoDia(iso) {
  if (!iso) return null;
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: TZ_SP }).format(new Date(iso)); }
  catch(_) { return null; }
}

// Dia a que a medicao pertence. Antes das 03:00 (SP) a foto ainda e o
// fechamento do dia anterior: o total das 00:10 de 15/03 e o saldo com que o
// dia 14/03 terminou, entao ele e gravado em 14/03. Medicao manual feita ao
// longo do dia continua caindo no dia corrente — e provisoria e sera
// sobrescrita pelo fechamento da madrugada seguinte.
const CENSO_HORA_FECHAMENTO = 3;
function _censoDiaRef() {
  const agora = new Date();
  const alvo  = horaSP() < CENSO_HORA_FECHAMENTO ? new Date(agora.getTime() - 86400000) : agora;
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ_SP }).format(alvo);
}

(function carregarCenso() {
  try {
    if (existsSync(CENSO_FILE)) _censo = JSON.parse(readFileSync(CENSO_FILE, 'utf-8'));
  } catch(e) { console.warn('[CENSO] Falha ao ler censo salvo:', e.message); }
})();

function salvarCenso() {
  try { writeFileSync(CENSO_FILE, JSON.stringify(_censo, null, 2), 'utf-8'); }
  catch(e) { console.error('[CENSO] Falha ao gravar censo:', e.message); }
}

(function carregarCensoHist() {
  try {
    if (existsSync(CENSO_HIST_FILE)) _censoHist = JSON.parse(readFileSync(CENSO_HIST_FILE, 'utf-8'));
    if (!_censoHist || typeof _censoHist !== 'object' || !_censoHist.dias) _censoHist = { dias: {} };
  } catch(e) { console.warn('[CENSO] Falha ao ler historico:', e.message); _censoHist = { dias: {} }; }
})();

// Uma medicao por dia: rodar o censo duas vezes no mesmo dia sobrescreve o
// ponto em vez de criar um segundo, senao o grafico ganharia degraus falsos.
function registrarHistoricoCenso(grupos) {
  const dia = _censoDiaRef();
  const porGrupo = {};
  for (const g of grupos) if (typeof g.membros === 'number') porGrupo[g.jid] = g.membros;
  _censoHist.dias[dia] = {
    total: Object.values(porGrupo).reduce((s, n) => s + n, 0),
    grupos: porGrupo,
    medidoEm: new Date().toISOString(),
  };
  // Poda: mantem pouco mais de um ano de serie.
  const chaves = Object.keys(_censoHist.dias).sort();
  while (chaves.length > CENSO_HIST_DIAS) delete _censoHist.dias[chaves.shift()];
  try {
    writeFileSync(CENSO_HIST_FILE, JSON.stringify(_censoHist, null, 2), 'utf-8');
    agendarPush(CENSO_HIST_ARQ);
  } catch(e) { console.error('[CENSO] Falha ao gravar historico:', e.message); }
}

// Grupo que falhar mantem a ultima contagem conhecida em vez de sumir da lista:
// um erro pontual de metadata nao pode zerar o historico do grupo.
async function recensearGrupos() {
  if (_censoRodando) return _censo;
  if (!sock || !conectado) {
    const ok = await aguardarSock(20000);
    if (!ok) throw new Error('WhatsApp nao conectado.');
  }
  _censoRodando = true;
  try {
    const destinos = radarDestinos();
    const anteriores = new Map((_censo.grupos || []).map(g => [g.jid, g]));
    const grupos = [];
    for (const jid of destinos) {
      const ant = anteriores.get(jid);
      try {
        const i = await _ggInfoGrupo(jid, true);
        grupos.push({
          jid, nome: i.nome, membros: i.membros,
          variacao: (ant && typeof ant.membros === 'number') ? i.membros - ant.membros : null,
          medidoEm: new Date().toISOString(),
        });
        await new Promise(r => setTimeout(r, 800));
      } catch(e) {
        grupos.push({
          jid, nome: NOMES_GRUPOS.get(jid) || ant?.nome || null,
          membros: ant?.membros ?? null, variacao: null,
          medidoEm: ant?.medidoEm || null, erro: e.message,
        });
      }
    }
    _censo = { atualizadoEm: new Date().toISOString(), grupos };
    salvarCenso();
    registrarHistoricoCenso(grupos);
    const total = grupos.reduce((s, g) => s + (g.membros || 0), 0);
    console.log('[CENSO] ' + grupos.length + ' grupo(s) de destino — ' + total + ' membro(s) no total.');
    return _censo;
  } finally { _censoRodando = false; }
}

// Agendador das 00:10 (SP). Checa de minuto em minuto e guarda o dia ja medido,
// entao um restart do container na madrugada nao dispara o censo de novo.
// A janela vai ate as 02:59 so como rede de seguranca: se o container estiver
// fora do ar as 00:10, a medicao ainda acontece e ainda conta como fechamento
// do dia anterior (CENSO_HORA_FECHAMENTO).
let _censoUltimoDia = _censoDia(_censo.atualizadoEm);
setInterval(() => {
  const h = horaSP(), m = minutoSP();
  const naJanela = (h === 0 && m >= 10) || h === 1 || h === 2;
  if (!naJanela) return;
  const dia = new Intl.DateTimeFormat('en-CA', { timeZone: TZ_SP }).format(new Date());
  if (_censoUltimoDia === dia) return;
  _censoUltimoDia = dia;
  recensearGrupos().catch(e => {
    console.error('[CENSO] Falha no censo da meia-noite:', e.message);
    _censoUltimoDia = null;   // libera nova tentativa ainda dentro da janela
  });
}, 60 * 1000);

// GET /grupos/censo — leitura do painel. Nunca consulta o WhatsApp: devolve a
// ultima fotografia. ?refresh=1 forca uma nova medicao na hora.
app.get('/grupos/censo', async (req, res) => {
  if (req.query.refresh === '1') {
    try { await recensearGrupos(); }
    catch(e) { return res.status(503).json({ ok:false, erro:e.message, atualizadoEm:_censo.atualizadoEm, grupos:_censo.grupos, total:_censo.grupos.reduce((s,g)=>s+(g.membros||0),0) }); }
  }
  const destinos = new Set(radarDestinos());
  // So grupos que continuam marcados como destino: se o papel foi retirado, o
  // grupo sai da lista sem precisar de um novo censo.
  const grupos = (_censo.grupos || []).filter(g => destinos.has(g.jid));
  const faltando = radarDestinos().filter(j => !grupos.some(g => g.jid === j))
    .map(j => ({ jid:j, nome: NOMES_GRUPOS.get(j) || null, membros:null, variacao:null, medidoEm:null }));
  const lista = [...grupos, ...faltando];
  res.json({
    ok: true,
    atualizadoEm: _censo.atualizadoEm,
    proximaMedicao: '00:10 (SP)',
    total: lista.reduce((s, g) => s + (g.membros || 0), 0),
    grupos: lista,
  });
});

// ── LEDGER DE ENTRADAS E SAIDAS DE MEMBROS ───────────────────────────────────
// O WhatsApp ja entrega o evento de entrada/saida para todo participante do
// grupo: o socket recebia e descartava. Aqui so passamos a gravar. E 100%
// passivo — nenhuma consulta extra ao servidor do WhatsApp, entao nao muda o
// perfil de risco da conta.
//
// Uso previsto: tempo de permanencia por pessoa (entrada -> saida) para medir
// retencao e LTV por grupo. Guarda o numero (sem nome, sem foto) porque sem ele
// nao da para cruzar com a base de membros.
const MEMBROS_LOG_ARQ  = 'grupos_membros_log.json';
const MEMBROS_LOG_FILE = SESSAO_DIR + '/' + MEMBROS_LOG_ARQ;
const MEMBROS_LOG_MAX  = 200000;
let _membrosLog = { eventos: [] };
let _membrosLogTimer = null;

(function carregarMembrosLog() {
  try {
    if (existsSync(MEMBROS_LOG_FILE)) _membrosLog = JSON.parse(readFileSync(MEMBROS_LOG_FILE, 'utf-8'));
    if (!_membrosLog?.eventos) _membrosLog = { eventos: [] };
    console.log('[MEMBROS] ' + _membrosLog.eventos.length + ' evento(s) no ledger.');
  } catch(e) { console.warn('[MEMBROS] Falha ao ler ledger:', e.message); _membrosLog = { eventos: [] }; }
})();

// Debounce na gravacao: uma entrada em massa (link divulgado) gera dezenas de
// eventos em segundos, e gravar a cada um seria desperdicio de I/O e de commit.
function salvarMembrosLog() {
  if (_membrosLogTimer) return;
  _membrosLogTimer = setTimeout(() => {
    _membrosLogTimer = null;
    try {
      if (_membrosLog.eventos.length > MEMBROS_LOG_MAX)
        _membrosLog.eventos = _membrosLog.eventos.slice(-MEMBROS_LOG_MAX);
      writeFileSync(MEMBROS_LOG_FILE, JSON.stringify(_membrosLog), 'utf-8');
      agendarPush(MEMBROS_LOG_ARQ);
    } catch(e) { console.error('[MEMBROS] Falha ao gravar ledger:', e.message); }
  }, 5000);
}

function _soNumero(jid) { return String(jid || '').split(':')[0].split('@')[0]; }

// Quem ja estava no grupo antes deste registro existir nao tem data de entrada:
// o WhatsApp nao expoe isso. A saida dessa pessoa fica marcada com
// entradaDesconhecida para nao contaminar a media de permanencia.
function _temEntrada(grupo, numero) {
  for (let i = _membrosLog.eventos.length - 1; i >= 0; i--) {
    const e = _membrosLog.eventos[i];
    if (e.g === grupo && e.n === numero && e.a === 'add') return true;
  }
  return false;
}

function registrarMovimentoMembros(grupo, participantes, acao, autor) {
  const destinos = new Set(radarDestinos());
  if (!destinos.has(grupo)) return;              // so grupos de destino
  if (acao !== 'add' && acao !== 'remove') return;
  const ts = new Date().toISOString();
  for (const p of (participantes || [])) {
    const n = _soNumero(p);
    if (!n) continue;
    const ev = { ts, g: grupo, n, a: acao };
    if (autor && _soNumero(autor) !== n) ev.por = _soNumero(autor);
    if (acao === 'remove' && !_temEntrada(grupo, n)) ev.entradaDesconhecida = true;
    _membrosLog.eventos.push(ev);
  }
  salvarMembrosLog();
  console.log('[MEMBROS] ' + acao + ' — ' + (participantes || []).length + ' em '
    + (NOMES_GRUPOS.get(grupo) || grupo));
}

// GET /grupos/membros/eventos?jid=&dias=30&limite=500 — leitura crua do ledger.
app.get('/grupos/membros/eventos', (req, res) => {
  const jid = String(req.query.jid || '').trim();
  const dias = Math.max(parseInt(req.query.dias || '30', 10) || 30, 1);
  const limite = Math.min(Math.max(parseInt(req.query.limite || '500', 10) || 500, 1), 5000);
  const corte = Date.now() - dias * 86400000;
  const eventos = _membrosLog.eventos
    .filter(e => (!jid || e.g === jid) && new Date(e.ts).getTime() >= corte)
    .slice(-limite)
    .map(e => ({ em: e.ts, jid: e.g, grupo: NOMES_GRUPOS.get(e.g) || null, numero: e.n,
                 acao: e.a, entradaDesconhecida: !!e.entradaDesconhecida }));
  res.json({ ok:true, total: eventos.length, totalNoLedger: _membrosLog.eventos.length, eventos });
});

// GET /grupos/membros/permanencia?jid= — pareia entrada com saida e devolve o
// tempo de permanencia de quem ja saiu, mais o resumo de entradas/saidas.
app.get('/grupos/membros/permanencia', (req, res) => {
  const jid = String(req.query.jid || '').trim();
  const abertos = new Map();     // "grupo|numero" -> ts de entrada
  const ciclos = [];
  let entradas = 0, saidas = 0, saidasSemEntrada = 0;

  for (const e of _membrosLog.eventos) {
    if (jid && e.g !== jid) continue;
    const chave = e.g + '|' + e.n;
    if (e.a === 'add') { abertos.set(chave, e.ts); entradas++; continue; }
    saidas++;
    const entrou = abertos.get(chave);
    if (!entrou) { saidasSemEntrada++; continue; }
    abertos.delete(chave);
    ciclos.push({
      jid: e.g, grupo: NOMES_GRUPOS.get(e.g) || null, numero: e.n,
      entrou, saiu: e.ts,
      dias: +((new Date(e.ts) - new Date(entrou)) / 86400000).toFixed(2),
    });
  }

  const media = ciclos.length ? +(ciclos.reduce((s, c) => s + c.dias, 0) / ciclos.length).toFixed(1) : null;
  const ordenados = ciclos.map(c => c.dias).sort((a, b) => a - b);
  const mediana = ordenados.length ? ordenados[Math.floor(ordenados.length / 2)] : null;
  res.json({
    ok: true,
    entradas, saidas, saidasSemEntrada,
    aindaDentro: abertos.size,
    ciclosCompletos: ciclos.length,
    permanenciaMediaDias: media,
    permanenciaMedianaDias: mediana,
    ciclos: ciclos.slice(-1000),
  });
});

// GET /grupos/censo/historico?dias=90 — serie diaria para o grafico de evolucao.
// Devolve o total do dia e a contagem por grupo, so dos grupos que ainda sao
// destino (grupo removido do papel some do grafico junto com a lista).
app.get('/grupos/censo/historico', (req, res) => {
  const dias = Math.min(Math.max(parseInt(req.query.dias || '90', 10) || 90, 2), CENSO_HIST_DIAS);
  const destinos = radarDestinos();
  const chaves = Object.keys(_censoHist.dias || {}).sort().slice(-dias);
  const serie = chaves.map(d => {
    const reg = _censoHist.dias[d] || {};
    const porGrupo = reg.grupos || {};
    // Ponto agregado (historico antigo) nao tem quebra por grupo: usa o total
    // que veio na importacao, senao a linha cairia para zero no inicio da serie.
    const total = reg.totalManual ? (reg.total || 0)
                                  : destinos.reduce((s, j) => s + (porGrupo[j] || 0), 0);
    return {
      dia: d, total, agregado: !!reg.totalManual,
      grupos: Object.fromEntries(destinos.map(j => [j, porGrupo[j] ?? null])),
    };
  });
  res.json({
    ok: true,
    dias: serie.length,
    grupos: destinos.map(j => ({ jid: j, nome: NOMES_GRUPOS.get(j) || null })),
    serie,
  });
});

// POST /grupos/censo/importar — carga de historico anterior ao censo automatico.
// Body: { registros:[{ dia:'YYYY-MM-DD', jid?|nome?, membros:N }], sobrescrever?:bool }
// Mescla na serie existente: por padrao NAO altera dia+grupo ja medido (a
// medicao real do servidor vale mais que planilha), a nao ser com sobrescrever.
// O grupo pode vir por jid ou por nome — o nome e resolvido contra os grupos
// conhecidos, e o que nao casar volta na resposta em vez de ser descartado calado.
app.post('/grupos/censo/importar', (req, res) => {
  const { registros, sobrescrever } = req.body || {};
  if (!Array.isArray(registros) || !registros.length)
    return res.status(400).json({ ok:false, erro:'registros obrigatorio (array nao vazio).' });

  const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const porNome = new Map();
  for (const [jid, nome] of NOMES_GRUPOS) porNome.set(norm(nome), jid);
  for (const g of (_censo.grupos || [])) if (g.nome) porNome.set(norm(g.nome), g.jid);

  let gravados = 0, ignorados = 0, invalidos = 0, agregados = 0;
  const semGrupo = new Set(), dias = new Set();

  for (const r of registros) {
    const dia = String(r?.dia || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) { invalidos++; continue; }

    // Registro agregado: historico antigo em que so existe o total do dia, sem
    // quebra por grupo. Fica marcado com totalManual para o grafico usar esse
    // numero em vez de somar grupos que nao existem naquele ponto da serie.
    const ehAgregado = r.jid == null && r.nome == null;
    const valor = Number(ehAgregado ? (r.total ?? r.membros) : r.membros);
    if (!Number.isFinite(valor) || valor < 0) { invalidos++; continue; }

    if (ehAgregado) {
      const reg = _censoHist.dias[dia];
      if (reg && !reg.totalManual && !sobrescrever) { ignorados++; continue; }
      _censoHist.dias[dia] = { total: Math.round(valor), grupos: (reg?.grupos || {}), totalManual: true, importado: true };
      agregados++; gravados++;
      continue;                       // total agregado nao entra no recalculo
    }

    const jid = String(r.jid || '').endsWith('@g.us') ? r.jid : porNome.get(norm(r.nome));
    if (!jid) { semGrupo.add(r.nome || r.jid || '(vazio)'); invalidos++; continue; }

    if (!_censoHist.dias[dia]) _censoHist.dias[dia] = { total: 0, grupos: {}, importado: true };
    const reg = _censoHist.dias[dia];
    if (reg.grupos[jid] != null && !sobrescrever) { ignorados++; continue; }
    reg.grupos[jid] = Math.round(valor);
    gravados++; dias.add(dia);
  }

  // Total recalculado em todos os dias tocados: importar um grupo novo num dia
  // antigo muda a soma daquele dia. Dia detalhado deixa de ser agregado.
  for (const d of dias) {
    const reg = _censoHist.dias[d];
    reg.total = Object.values(reg.grupos).reduce((s, n) => s + n, 0);
    delete reg.totalManual;
  }

  const chaves = Object.keys(_censoHist.dias).sort();
  while (chaves.length > CENSO_HIST_DIAS) delete _censoHist.dias[chaves.shift()];

  try {
    writeFileSync(CENSO_HIST_FILE, JSON.stringify(_censoHist, null, 2), 'utf-8');
    agendarPush(CENSO_HIST_ARQ);
  } catch(e) { return res.status(500).json({ ok:false, erro:'falha ao gravar: ' + e.message }); }

  console.log('[CENSO] Importacao — ' + gravados + ' ponto(s) em ' + dias.size + ' dia(s).');
  res.json({
    ok: true, gravados, agregados, ignorados, invalidos,
    dias: dias.size, totalDiasNaSerie: Object.keys(_censoHist.dias).length,
    gruposNaoResolvidos: [...semGrupo],
  });
});

// POST /grupos/censo/atualizar — mede agora, sob demanda do painel.
app.post('/grupos/censo/atualizar', async (req, res) => {
  try {
    const c = await recensearGrupos();
    const destinos = new Set(radarDestinos());
    const lista = (c.grupos || []).filter(g => destinos.has(g.jid));
    res.json({ ok:true, atualizadoEm:c.atualizadoEm, total: lista.reduce((s,g)=>s+(g.membros||0),0), grupos: lista });
  } catch(e) { res.status(503).json({ ok:false, erro:e.message }); }
});

// ── HUBLA WEBHOOK ─────────────────────────────────────────────────────────────

const MENSAGEM_BOAS_VINDAS = (nome) => `Olá, ${nome}! Seja muito bem-vindo ao Clube do Viajante Premium! ✈️

Estou muito feliz em ter você com a gente. A partir de agora, você terá acesso aos nossos conteúdos, grupos e oportunidades para aprender a acumular e usar melhor seus pontos e milhas.

Para começar da melhor forma, minha orientação é que o *seu primeiro passo* seja acessar a área de membros e *assistir*, pelo menos, ao *módulo de boas-vindas*.

Nele eu explico algumas instruções importantes sobre como aproveitar os conteúdos, como funcionam os grupos, onde encontrar cada informação e quais são os próximos passos para você tirar o máximo proveito da sua assinatura.

Além disso, *você já está participando do desafio 100 em 3*: quem assistir a todas as aulas em até 3 meses ganha um kit de viagens personalizado. Todos os detalhes sobre o desafio também estão explicados no módulo de boas-vindas.

Mais uma vez, que bom ter você aqui! Tenho certeza de que esse será um passo muito importante para você viajar melhor, economizar mais e aproveitar muito mais o mundo dos pontos e milhas. 🚀

Acesse a área de membros aqui: https://app.hub.la/m/5aPVHUjfhTa79XR2bWqC

Davi Leles`;

function formatarNumero(telefone) {
  const apenasDigitos = telefone.replace(/\D/g, '');
  const comDDI = apenasDigitos.startsWith('55') ? apenasDigitos : `55${apenasDigitos}`;
  return `${comDDI}@s.whatsapp.net`;
}

function extrairTelefone(payload) {
  const ev = payload.event; if (!ev) return null;
  return ev.member?.phone || ev.member?.user?.phone || ev.subscriber?.phone || ev.customer?.phone || ev.user?.phone || null;
}

function extrairNome(payload) {
  const ev = payload.event; if (!ev) return 'novo membro';
  const n = ev.member?.fullName || ev.member?.name || ev.member?.user?.name || ev.subscriber?.name || ev.customer?.name || ev.user?.name || null;
  return n ? n.split(' ')[0] : 'novo membro';
}

app.post('/webhook/hubla', async (req, res) => {
  try {
    const tokenRecebido = req.headers['x-hubla-token'];
    const tokenEsperado = process.env.HUBLA_TOKEN;
    if (!tokenEsperado) { console.error('[Hubla] HUBLA_TOKEN não configurado'); return res.status(500).json({ error: 'Configuração interna ausente' }); }
    if (!tokenRecebido || tokenRecebido !== tokenEsperado) { console.warn('[Hubla] Token inválido'); return res.status(401).json({ error: 'Token inválido' }); }
    const payload = req.body;
    const tipo = payload?.type;
    console.log(`[Hubla] Evento: ${tipo}`);
    if (tipo !== 'customer.member_added') return res.status(200).json({ status: 'ignorado', tipo });
    const telefone = extrairTelefone(payload);
    const nome = extrairNome(payload);
    if (!telefone) { console.warn('[Hubla] Telefone não encontrado'); return res.status(200).json({ status: 'sem_telefone' }); }
    const numeroFormatado = formatarNumero(telefone);
    console.log(`[Hubla] Enviando boas-vindas para ${nome} (${numeroFormatado})`);
    if (!conectado || !sock) { const ok = await aguardarSock(); if (!ok) return res.status(503).json({ error: 'WhatsApp não conectado' }); }
    // Mesmo motivo da campanha: quem manda no JID e o servidor do WhatsApp,
    // nao a montagem local do telefone (ver resolverJidWhatsApp).
    const alvoHubla = await resolverJidWhatsApp(telefone, numeroFormatado);
    if (!alvoHubla.existe) console.warn(`[Hubla] ${numeroFormatado} nao confirmado no WhatsApp — tentando mesmo assim.`);
    if (alvoHubla.jid !== numeroFormatado) console.log(`[Hubla] JID corrigido: ${numeroFormatado} → ${alvoHubla.jid}`);
    await enviarMensagem(alvoHubla.jid, { text: MENSAGEM_BOAS_VINDAS(nome) });
    console.log(`[Hubla] ✅ Enviado para ${nome}`);
    return res.status(200).json({ status: 'enviado', para: nome });
  } catch (err) { console.error('[Hubla] Erro:', err); return res.status(500).json({ error: 'Erro interno' }); }
});


app.post('/reset-sender-keys', async (req, res) => {
  console.log('[RESET] Cura cirúrgica de sender keys solicitada via endpoint.');
  await limparSenderKeys();
  res.json({ ok:true, mensagem:'Sender keys apagadas. Conexão mantida — os grupos voltam a decifrar conforme os remetentes redistribuírem as chaves (automático via retry receipt).' });
});

app.post('/reset-sessao', async (req, res) => {
  console.log('[RESET] Reset de sessão solicitado via endpoint.');
  res.json({ ok:true, mensagem:'Limpando sessão e reconectando...' });
  await limparSessaoEReconectar();
});

app.post('/reset-sessao-completo', async (req, res) => {
  console.log('[RESET] Reset COMPLETO de sessão solicitado via endpoint.');
  if (isResetting) {
    console.log('[RESET] Reset já em andamento, ignorando chamada duplicada.');
    return res.json({ ok:false, mensagem:'Reset já em andamento.' });
  }
  res.json({ ok:true, mensagem:'Apagando toda a sessão e reconectando...' });
  isResetting = true;
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  conectado = false;
  const sockRef = sock;
  sock = null;
  if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
  if (sockRef) { try { sockRef.end(new Error('reset-completo')); } catch(e) {} }
  try {
    const arquivos = await readdir(SESSAO_DIR);
    for (const arq of arquivos) {
      // Preserva tudo que NAO e credencial do WhatsApp. A pasta ./sessao guarda
      // dados de negocio junto com as chaves; apagar sem filtro custaria a base
      // de cupons e os papeis fonte/destino do radar, que sao trabalho manual.
      if (PRESERVAR_NO_RESET.has(arq)) continue;
      await unlink(SESSAO_DIR + '/' + arq).catch(() => {});
    }
    console.log('[RESET] Sessão apagada completamente. Aguardando novo QR...');
  } catch(e) { console.error('[RESET] Erro ao apagar sessão:', e.message); }
  errosDescripto = 0;
  _reconectarTentativas = 0;
  isResetting = false;

  _agendarReconexao(2000);
});
// ═══════════════════════════════════════════════════════════════════════════
// HISTÓRICO SEATS.AERO — BLOCO ÚNICO
//
// COMO APLICAR: cole TUDO abaixo no server.js, imediatamente ANTES da linha:
//
//     app.listen(PORT, () => {
//
// Não é preciso editar mais nada no arquivo. Este bloco só acrescenta.
// ═══════════════════════════════════════════════════════════════════════════


// ── HISTÓRICO SEATS.AERO (coleta diária) ─────────────────────────────────────
// Alimentado pelas tarefas programadas seats-aero-coleta-A/B/C (seg a sex).
// Diferente da fila de alertas: aqui NADA é enviado nem aprovado. É apenas
// série histórica de disponibilidade — inclusive dos dias em que não havia
// nada dentro do limite (registro com menorK null). Guardar a ausência é o
// que permite depois medir com que frequência uma rota abre assento; sem ela
// não dá para distinguir "não havia disponibilidade" de "a coleta não rodou".
const HIST_SEATS_PATH = SESSAO_DIR + '/historico_seats.json';
const HIST_SEATS_DIAS = 400; // retenção: descarta coletas mais antigas que isso

let historicoSeats = [];

function carregarHistoricoSeats() {
  try {
    if (existsSync(HIST_SEATS_PATH)) {
      historicoSeats = JSON.parse(readFileSync(HIST_SEATS_PATH, 'utf-8'));
      console.log('[HIST-SEATS] Carregados ' + historicoSeats.length + ' registros.');
    }
  } catch (e) {
    console.warn('[HIST-SEATS] Erro ao carregar:', e.message);
    historicoSeats = [];
  }
}

function salvarHistoricoSeats() {
  try {
    const limite = Date.now() - HIST_SEATS_DIAS * 24 * 60 * 60 * 1000;
    const antes = historicoSeats.length;
    historicoSeats = historicoSeats.filter(r => {
      const t = new Date(r.coletadoEm).getTime();
      return (!t || isNaN(t)) ? true : t >= limite;
    });
    if (antes !== historicoSeats.length) {
      console.log('[HIST-SEATS] Retenção: ' + (antes - historicoSeats.length) + ' registro(s) antigo(s) removido(s).');
    }
    writeFileSync(HIST_SEATS_PATH, JSON.stringify(historicoSeats), 'utf-8');
  } catch (e) {
    console.warn('[HIST-SEATS] Erro ao salvar:', e.message);
  }
}

carregarHistoricoSeats();

// Chave de deduplicação: uma linha por dia/rota/cabine/direção.
// Rodar o mesmo grupo duas vezes no mesmo dia SUBSTITUI em vez de duplicar.
function chaveHistSeats(r) {
  return [
    r.dia,
    (r.programa || '').toLowerCase(),
    (r.origem   || '').toUpperCase(),
    (r.destino  || '').toUpperCase(),
    (r.cabine   || '').toLowerCase(),
    (r.direcao  || '').toLowerCase(),
  ].join('|');
}

// ── PONTE COLETA → HISTÓRICO DE PASSAGENS (proxy CDV) ────────────────────────
// A coleta diária alimenta o mesmo /passagens/registrar que já produz o
// hist180 exibido nas mensagens ("MÍN. 180 DIAS" / "MÉDIA 180 DIAS").
// Antes desta ponte a base só continha emissões efetivamente divulgadas —
// amostra pequena e enviesada, porque só entrava o que já era bom o bastante
// para virar alerta. A coleta acrescenta ~300 pontos por semana das mesmas
// rotas, incluindo os patamares ruins, que é o que dá sentido ao "mínimo".
//
// Quatro normalizações são obrigatórias aqui, porque o proxy guarda os dados
// no formato das mensagens de alerta, não no formato do seats.aero:
//   1. origem/destino → NOME DE CIDADE, não IATA (o alerta grava "São Paulo",
//      não "GRU"). Sem converter, GRU e São Paulo viram buckets distintos.
//   2. pontos → número absoluto. menorK vem em milhares (92.5 = 92500).
//   3. cabine → "Economica" ou "Executiva" apenas. A coleta usa "Econômica",
//      "Business" e "Executiva"; sem mapear, "Business" vira um terceiro bucket.
//   4. valor → COM desconto Smiles. O hist180 atual é alimentado pelo texto da
//      mensagem, que já sai descontado. Enviar o valor cru criaria um degrau
//      artificial de ~10% na série das rotas Smiles.

// IATAs usados pela coleta que não estão em IATA_CIDADES. Fica aqui em vez de
// editar a tabela original para manter este bloco 100% aditivo.
const IATA_EXTRA_COLETA = { 'IAD': 'Washington', 'DCA': 'Washington', 'BWI': 'Baltimore' };

const cidadeColeta = (iata) =>
  IATA_EXTRA_COLETA[String(iata || '').toUpperCase()] || resolverCidade(iata, iata);

const CABINE_PROXY = (c) =>
  /exec|business|first|primeira/i.test(String(c || '')) ? 'Executiva' : 'Economica';

async function enviarColetaParaProxy(linhas) {
  let ok = 0, pulados = 0, falhas = 0;

  for (const r of linhas) {
    // Sem disponibilidade não é registro de preço — o dia vazio já está
    // guardado no historicoSeats local, que é onde ele tem significado.
    if (r.erro || r.menorK === null) { pulados++; continue; }

    const k = (r.menorKComDesconto !== null && r.menorKComDesconto !== undefined)
      ? r.menorKComDesconto
      : r.menorK;
    const pontos = Math.round(Number(k) * 1000);
    if (!pontos || pontos <= 0) { pulados++; continue; }

    const resultado = await registrarPassagemProxy({
      origem:      cidadeColeta(r.origem),
      destino:     cidadeColeta(r.destino),
      cia:         normalizarCia(r.cia),
      programa:    r.programa,
      pontos:      pontos,
      cabine:      CABINE_PROXY(r.cabine),
      datas_ida:   (r.datas || []).join(' '),
      datas_volta: '',
      fonte:       'coleta',
    });

    if (resultado === null) falhas++; else ok++;

    // Espaçamento leve: são até 20 chamadas por grupo, 3 grupos por dia.
    await new Promise(res => setTimeout(res, 300));
  }

  console.log('[HIST-SEATS→PROXY] ' + ok + ' registrada(s), '
    + pulados + ' pulada(s) (sem disponibilidade), ' + falhas + ' falha(s).');
}

// POST /historico-seats — grava uma coleta (um POST por grupo A/B/C)
// Body: { coletadoEm, grupo, registros: [ { cia, programa, programaColuna,
//         cabine, origem, destino, direcao, limiteK, menorK,
//         menorKComDesconto, totalDatas, datas, erro } ] }
app.post('/historico-seats', (req, res) => {
  const { coletadoEm, grupo, registros } = req.body || {};

  if (!Array.isArray(registros) || registros.length === 0) {
    return res.status(400).json({ ok: false, erro: 'registros obrigatório (array não vazio).' });
  }

  const tsValido = coletadoEm && !isNaN(new Date(coletadoEm).getTime());
  const ts = tsValido ? new Date(coletadoEm).toISOString() : new Date().toISOString();
  // Dia no fuso de São Paulo (en-CA devolve YYYY-MM-DD).
  const dia = new Intl.DateTimeFormat('en-CA', { timeZone: TZ_SP }).format(new Date(ts));

  const indice = new Map();
  historicoSeats.forEach((r, i) => indice.set(chaveHistSeats(r), i));

  const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return isNaN(n) ? null : n;
  };

  let novos = 0, atualizados = 0, invalidos = 0;
  const gravadas = [];

  for (const reg of registros) {
    if (!reg || !reg.origem || !reg.destino || !reg.programa || !reg.direcao) { invalidos++; continue; }

    const linha = {
      dia,
      coletadoEm: ts,
      grupo:      grupo || null,
      cia:        reg.cia || '',
      programa:   reg.programa,
      programaColuna: reg.programaColuna || '',
      cabine:     reg.cabine || 'Economica',
      origem:     String(reg.origem).toUpperCase().trim(),
      destino:    String(reg.destino).toUpperCase().trim(),
      direcao:    String(reg.direcao).toLowerCase().trim(),
      limiteK:    num(reg.limiteK),
      menorK:     num(reg.menorK),                   // valor cru do seats.aero
      menorKComDesconto: num(reg.menorKComDesconto), // Smiles já com -9%
      totalDatas: num(reg.totalDatas) || 0,
      datas:      Array.isArray(reg.datas) ? reg.datas : [],
      erro:       reg.erro === true,
    };

    const chave = chaveHistSeats(linha);
    if (indice.has(chave)) {
      historicoSeats[indice.get(chave)] = linha;
      atualizados++;
    } else {
      indice.set(chave, historicoSeats.length);
      historicoSeats.push(linha);
      novos++;
    }
    gravadas.push(linha);
  }

  salvarHistoricoSeats();
  console.log('[HIST-SEATS] Grupo ' + (grupo || '?') + ' (' + dia + ') — '
    + novos + ' novo(s), ' + atualizados + ' atualizado(s), '
    + invalidos + ' inválido(s). Total: ' + historicoSeats.length);

  res.json({ ok: true, dia, novos, atualizados, invalidos, total: historicoSeats.length });

  // Fan-out para o proxy DEPOIS de responder: a tarefa programada não fica
  // presa esperando até 20 chamadas HTTP, e uma falha do proxy nunca faz a
  // coleta local (que já está salva em disco) parecer ter falhado.
  enviarColetaParaProxy(gravadas)
    .catch(e => console.warn('[HIST-SEATS→PROXY] Erro no fan-out:', e.message));
});

// GET /historico-seats — consulta com filtros e estatísticas
// Ex: /historico-seats?origem=GRU&destino=CDG&cabine=Business&dias=180
app.get('/historico-seats', (req, res) => {
  const { origem, destino, programa, cabine, direcao, detalhe } = req.query;
  const janela = Number(req.query.dias) || 180;
  const limite = Date.now() - janela * 24 * 60 * 60 * 1000;

  const eq = (a, b) => String(a || '').toLowerCase().trim() === String(b || '').toLowerCase().trim();

  const filtrados = historicoSeats.filter(r => {
    const t = new Date(r.coletadoEm).getTime();
    if (t && !isNaN(t) && t < limite) return false;
    if (origem   && !eq(r.origem, origem))     return false;
    if (destino  && !eq(r.destino, destino))   return false;
    if (programa && !eq(r.programa, programa)) return false;
    if (cabine   && !eq(r.cabine, cabine))     return false;
    if (direcao  && !eq(r.direcao, direcao))   return false;
    return true;
  });

  const valores = filtrados.filter(r => r.menorK !== null && !r.erro).map(r => r.menorK);
  const diasColetados = new Set(filtrados.map(r => r.dia)).size;
  const diasComDisp   = new Set(filtrados.filter(r => r.menorK !== null).map(r => r.dia)).size;

  const stats = valores.length ? {
    minK:   Math.min(...valores),
    maxK:   Math.max(...valores),
    mediaK: Math.round((valores.reduce((s, v) => s + v, 0) / valores.length) * 10) / 10,
    amostras: valores.length,
  } : { minK: null, maxK: null, mediaK: null, amostras: 0 };

  res.json({
    ok: true,
    janelaDias: janela,
    diasColetados,
    diasComDisponibilidade: diasComDisp,
    // % dos dias coletados em que apareceu alguma disponibilidade no limite
    taxaDisponibilidade: diasColetados ? Math.round((diasComDisp / diasColetados) * 100) : 0,
    ...stats,
    registros: filtrados.length,
    detalhe: detalhe ? filtrados : undefined,
  });
});

// GET /historico-seats/rotas — combinações já coletadas e a última coleta de cada
app.get('/historico-seats/rotas', (req, res) => {
  const mapa = new Map();
  for (const r of historicoSeats) {
    const chave = [r.programa, r.cia, r.cabine, r.origem, r.destino, r.direcao].join(' | ');
    const atual = mapa.get(chave);
    if (!atual || r.dia > atual.ultimaColeta) {
      mapa.set(chave, {
        programa: r.programa, cia: r.cia, cabine: r.cabine,
        origem: r.origem, destino: r.destino, direcao: r.direcao,
        limiteK: r.limiteK, ultimaColeta: r.dia, ultimoMenorK: r.menorK,
      });
    }
  }
  const rotas = [...mapa.values()].sort((a, b) => a.origem.localeCompare(b.origem));
  res.json({ ok: true, total: rotas.length, totalRegistros: historicoSeats.length, rotas });
});

app.listen(PORT, () => {
  console.log('Servidor na porta '+PORT);
});

// Vitrine publica: carrega o historico do disco e liga a varredura periodica
// que mantem dados/feed.json e dados/cupons.json em dia no repositorio.
iniciarFeedPublico({ resolverLink: linkDoCupomTSP });

// Bot de criacao manual no Telegram. As funcoes reais do servidor sao injetadas
// para o bot nao guardar copia de nenhuma regra: o cupom criado no celular sai
// pelo MESMO caminho do capturado no monitoramento (template, dedup, base).
bootBotTsp({
  PORT,
  formatarCupomTSP,
  enfileirarCupomTSP,
  enviarCupomParaGrupos,
  enviarMensagem,
  radarDestinos,
  salvarFila,
}).catch(e => console.warn('[BOT-TSP] Falha no boot:', e.message));

// Conecta ao WhatsApp imediatamente no startup.
// Garante que mensagens dos grupos monitorados não sejam perdidas após deploy.
console.log("[SERVER] Iniciando conexão com WhatsApp...");
conectar();

// Retoma as contas secundarias que ja foram pareadas alguma vez. O atraso deixa
// a principal (que e quem le os grupos) subir primeiro: se o Railway derrubar o
// container no meio do boot, a conta que nao pode perder mensagem ja esta de pe.
setTimeout(async () => {
  try {
    const dirs = await readdir(CONTAS_DIR).catch(() => []);
    for (const id of dirs) {
      if (!existsSync(CONTAS_DIR + '/' + id + '/creds.json')) continue;
      console.log('[CONTA:' + id + '] credenciais encontradas, reconectando...');
      conectarConta(id).catch(() => {});
    }
  } catch (e) { console.warn('[CONTA] Falha ao retomar contas secundarias:', e.message); }
}, 20000);
