import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  initAuthCreds,
  BufferJSON,
  proto,
  signedKeyPair,
  jidNormalizedUser,
} from '@whiskeysockets/baileys';
import express from 'express';
import cors from 'cors';
import pino from 'pino';
import multer from 'multer';
import { Boom } from '@hapi/boom';
import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { readdir, unlink, writeFile as writeFileAsync, readFile as readFileAsync, rename as renameAsync, mkdir as mkdirAsync, rm as rmAsync, stat as statAsync } from 'fs/promises';
import { join } from 'path';
import QRCode from 'qrcode';

// ── RADAR DE MARKETPLACE (Amazon hoje; ML e Shopee entram pelo mesmo pipeline) ─
import {
  carregarRadarConfig, salvarRadarConfig, radarConfig,
  radarFontes, radarDestinos, ehFonteRadar,
  trilhas, salvarTrilhas, destinosGerais, destinosDasTrilhas, destinosDaOferta, explicarRoteamento,
  ehDestinoDeNicho,
  comRodapeExtra, rodapeExtraParaGrupo,
  comTagDoGrupo, previewComTagDoGrupo,
  processarTextoAmazon,
  registrarCupomBase, listarCuponsBase, atualizarCupomBase, removerCupomBase, definirAtivoPorLoja,
  cupomPorCodigo, cupomVigente, calcularDesconto, melhorCupomAplicavel,
  cupomExpirado, cupomRestrito, cupomGeralDisponivel, desativarExpirados,
  cupomCitadoDesconhecido,
  janelaCupom, salvarJanelaCupom, dentroDaJanelaCupom,
  espacamentoGrupos, salvarEspacamentoGrupos, msEntreGrupos,
  turnosTsp, salvarTurnosTsp, contaDoTurno,
  numerosGrupo, salvarNumerosGrupo, contaDoGrupo, removerContaDosGrupos,
  gruposOrfaos, cargaPorNumero,
  listarTemplates, templateDaLoja, salvarTemplate, removerTemplate,
  templateCupom, templateCupomLote, templateCupomLoteItem, templateCupomLoteItemExcecao,
  templateAwin, templateProprioDaLoja,
  renderTemplate, varsDoProduto, VARIAVEIS_TEMPLATE, VARIAVEIS_CUPOM,
  resolverLinhaVitrine, listarVitrine, salvarItemVitrine, removerItemVitrine,
  buscarProdutos, normalizar,
  itemVitrine, marcarDisparo, montarOfertasVitrine,
  listarPoolRastreio, salvarPoolRastreio, listarAtribuicoes,
  repararAsinAtribuicoes, urlsNoAsinDeAtribuicoes,
  listarPoolMl, salvarPoolMl,
  listarListas, listaPorId, salvarLista, removerLista, atualizarExecucaoLista, cupomDaLista,
  listarMonitor, monitorDoGrupo, salvarMonitor, removerMonitor,
  podeCapturar, LOJAS_MONITORAVEIS, semearMonitorDasFontes,
  jaDivulgado, registrarVisto, descontoMinimoRadar, horasDedup,
  podeLerPreco, registrarLeitura, leituraForaJanelaAtiva,
  carregarCuponsBase, carregarTemplates, carregarVitrine, sondarRecursos,
  recarregarRadarTenants, refDeterministico,
  sondarApiAmazon, apiAmazonIndisponivel, estadoApiAmazon, disparoSemApiLiberado,
  contasAmazonSeparadas,
} from './radar-amazon.js';

// ── CATEGORIZACAO DE PRODUTO (grupos de nicho) ────────────────────────────────
import {
  carregarCategorias, categoriasConfig, salvarCategorias,
  classificarProduto, categoriaConfiavel, espelhaNoOperador,
  explicarClassificacao, semearCacheTrilhas,
} from './categorizador.js';

// ── MONITOR DE QUEDA DE PRECO (Shopee / Mercado Livre) ────────────────────────
// Vigia a vitrine, guarda a serie diaria de precos e dispara sozinho quando o
// preco cai contra o proprio historico — nao contra o "de" que a loja anuncia.
import {
  iniciarMonitorPrecos, configMonitorPrecos, salvarConfigMonitorPrecos,
  estadoMonitorPrecos, listarMonitorados, historicoDe, varrer as varrerPrecos,
  simular as simularPrecos, descartarCandidato, publicarAgora as publicarPrecoAgora,
  carregarMonitorPrecos, LOJAS_MONITORAVEIS_PRECO,
  semearVitrinePorDesempenho, rankingEpc, estadoEpc,
  registrarLeituraPreco, vigiarProdutoDivulgado, expurgarVigilancia, estatisticas as estatisticasPreco,
} from './monitor-precos.js';

// ── SINCRONIZACAO COM O GITHUB ────────────────────────────────────────────────
import {
  baixarDoGitHub, pushImediato, estadoSync, sincronizacaoAtiva, testarAcesso, agendarPush,
  flushPushesPendentes, pushesPendentes, baixarArquivoDoGitHub,
} from './sync-github.js';

// ── VITRINE PUBLICA (tudosobrepromos.com) ─────────────────────────────────────
import {
  iniciarFeedPublico, registrarPublicacao, publicarAgora, estadoFeedPublico,
} from './feed-publico.js';

// ── CONFIG DA OPERACAO TSP (editavel pelo painel) ─────────────────────────────
import {
  carregarConfigTsp, configTsp, salvarConfigTsp,
  linksTsp,
  registrarResolvedorDeNome,
  gruposTspCupons, grupoOperadorTsp, tgIgnoradosConfig, contaLeitoraTsp,
  estadoCredenciais, aplicarCredenciais,
  modoAutoEnvioCupom, modoAutoEnvioOferta, origemAutoEnvio,
} from './config-tsp.js';

// ── CONFIG DA OPERACAO CDV (editavel pela aba Config do gerador) ──────────────
// Irmao do config-tsp para o outro lado da casa. Ate esta versao os grupos do
// CDV eram hardcode aqui embaixo; agora sao cadastro em tela, como no TSP.
import {
  carregarConfigCdv, configCdv, salvarConfigCdv, PAPEIS_CDV,
  grupoOfertasCdv, grupoEmissaoCdv, grupoAvisosCdv,
  gruposMonitoradosCdv, monitoradosCdv, ehMonitoradoCdv,
  contaEnvioCdv, contaLeitoraCdv, ehGrupoCdv, adminsCdv, telefonesAvisoCdv, papeisDoEmailCdv,
} from './config-cdv.js';

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
import { bootBotTsp, tratarUpdateBotTsp, BOT_TSP_PATH, notificarAdminsTelegram } from './bot-tsp.js';
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
  buscarDadosProdutoMl, resolverLinkMl, idProdutoMl,
  verificarPaginaProdutoMl, saudePaginaMl, estadoAntibotMl, cookieAff,
  estadoOrigemSocialMl,
  definirValidadeAntibotMs, estadoAntibotLogadoMl, coberturaApiMl, estadoSocialMl,
} from './radar-ml.js';

// URL usada para testar a validade do token do painel de afiliados. Fica em
// variavel porque o endpoint interno pode mudar sem aviso.
// Testa a pagina do proprio linkbuilder: exige sessao valida e nao gera link
// nenhum. Cookie caido redireciona para login, o que muda o status.
const ML_AFF_URL_TESTE = process.env.ML_AFF_URL_TESTE
  || 'https://www.mercadolivre.com.br/afiliados/linkbuilder';

// ── ESPACAMENTO ENQUANTO O ANTIBOT ESTA ATIVO ────────────────────────────────
// Cada requisicao recusada realimenta o proprio bloqueio: e exatamente o padrao
// que o antibot mede. Duas rotinas alem da sonda leem pagina do ML — o teste do
// token (linkbuilder) e o sync de cupons —, e enquanto estiverem sendo barradas
// vale espacar em vez de suspender: cupom que envelhece na base faz o radar
// anunciar preco que nao se aplica no checkout, o que seria pior que o bloqueio.
//
// O gatilho e o bloqueio das paginas LOGADAS, nao o do PDP publico. Os dois sao
// independentes: em 27/08 toda pagina de produto estava barrada com /cupons e
// /afiliados/linkbuilder abrindo normalmente (verificado em producao — 30, 31,
// 50 e 44 cards lidos com o antibot do PDP confirmado). Amarrado ao estado do
// PDP, o sync caia para 4 passadas por dia por causa de um bloqueio que nao o
// atingia: a base envelhecia de graca, sem poupar uma unica requisicao recusada.
const ML_ESPACO_BLOQUEADO = {
  token:  3 * 60 * 60 * 1000,   // teste do linkbuilder (1 pagina por passada)
  cupons: 6 * 60 * 60 * 1000,   // sync de cupons (4 paginas por passada)
};
const _ultimoToqueMl = { token: 0, cupons: 0 };
function mlPodeTocarPagina(chave) {
  if (!estadoAntibotLogadoMl().confirmadoAgora) return true;
  if (Date.now() - (_ultimoToqueMl[chave] || 0) < (ML_ESPACO_BLOQUEADO[chave] || 0)) {
    return false;
  }
  _ultimoToqueMl[chave] = Date.now();
  return true;
}

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
    await registrarAlerta({ nivel:'critico', origem:'ml', chave:'ml:aff-token',
      titulo:'Token de afiliado do Mercado Livre parou de funcionar', corpo:texto });
    console.error('[ML-AFF] Operador avisado: token caiu (' + motivo + ')');
  } catch (e) { console.error('[ML-AFF] Falha ao avisar operador:', e.message); }
}

// Antibot do ML: a pagina de produto vem como tela de verificacao (HTTP 200,
// sem dados) enquanto o linkbuilder segue normal — o teste do token nao
// enxerga. Em 25/08 o radar ML passou o dia descartando tudo em silencio.
// Um aviso por 6h basta: o bloqueio dura horas e cada leitura barrada passa
// por aqui.
let _avisoAntibotMl = 0;
async function avisarAntibotMl(detalhe) {
  if (Date.now() - _avisoAntibotMl < 6 * 60 * 60 * 1000) return;
  _avisoAntibotMl = Date.now();
  const api = estadoMl();
  const texto = '⚠️ *Mercado Livre bloqueando a leitura de páginas (antibot)*\n\n'
    + 'Detalhe: ' + detalhe + '\n\n'
    + (api.autorizado
        ? 'A API oficial está autorizada: preço e estoque seguem por ela enquanto a página estiver bloqueada.'
        : 'Fallback pela API oficial DESLIGADO — sem ele, ofertas ML do radar são descartadas e itens ML das listas ficam adiados.\n'
          + 'Autorize em ' + ML_REDIRECT_URI.replace(/\/ml\/callback$/, '/ml/conectar'))
    + '\n\nAmazon, Shopee e Magalu seguem normalmente.';
  try {
    await registrarAlerta({ nivel:'critico', origem:'ml', chave:'ml:token-oauth',
      titulo:'Token do Mercado Livre parou de funcionar', corpo:texto });
    console.error('[ML] Operador avisado: antibot (' + detalhe + ')');
  } catch (e) { console.error('[ML] Falha ao avisar operador sobre antibot:', e.message); }
}

// Pagina usada pela sonda do antibot: variavel para trocar sem deploy; sem ela,
// um item ML da propria vitrine (e o que o radar e as listas de fato leem).
function urlSondaProdutoMl() {
  if (process.env.ML_URL_TESTE_PRODUTO) return process.env.ML_URL_TESTE_PRODUTO;
  // So pagina de produto direta (/p/MLB ou /up/MLBU). O encurtador meli.la
  // abre o perfil social do afiliado, que nao tem JSON-LD de produto nem a
  // tela antibot — a sonda passaria em falso com o bloqueio ativo.
  const direto = listarVitrine().find(i => i.loja === 'Mercado Livre'
    && /mercadolivre\.com\.br\/.*\/(?:p|up)\/MLBU?\d{6,}/i.test(i.url || ''));
  return direto?.url || 'https://www.mercadolivre.com.br/p/MLB38655102';
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
  if (!mlPodeTocarPagina('cupons')) {
    console.log('[CUPONS-ML] Sync agendado adiado — antibot nas paginas logadas (proxima passada em ate 6h).');
    return;
  }
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
      await registrarAlerta({ nivel:'info', origem:'ml', chave:'ml:cupons-desativados',
        titulo:'Cupons do Mercado Livre desativados (' + d.desativados.length + ')',
        corpo: '🎫 *Cupons do Mercado Livre desativados*\n\n'
            + d.desativados.map(c => '• ' + c).join('\n')
            + '\n\nO ML recusou o código na hora de ativar — vencido ou esgotado. '
            + 'Saíram da base e não entram mais nas ofertas. Nada a fazer.'
      }).catch(() => {});
    }

    // Cupom que o sync conseguiu adicionar sozinho na conta. Vale avisar: a
    // partir dai o ML passa a informar validade e esgotamento dele.
    if ((d.ativadosAgora || []).length) {
      await registrarAlerta({ nivel:'info', origem:'ml', chave:'ml:cupons-ativados',
        titulo:'Cupons ativados na conta do ML (' + d.ativadosAgora.length + ')',
        corpo: '✅ *Cupons ativados na sua conta do ML*\n\n'
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
        await registrarAlerta({ nivel:'critico', origem:'ml', chave:'ml:ativacao-cupom-fora',
          titulo:'Ativação de cupom no ML fora do ar',
          corpo: '⚠️ *Ativação de cupom no ML fora do ar*\n\n'
              + 'O ML recusou os ' + d.recusasIgnoradas + ' código(s) testados nesta passada, '
              + 'inclusive os que estão ativos na conta. Nenhum cupom foi desativado.\n\n'
              + 'Cupom novo do Telegram não está entrando na sua conta até isso voltar.'
        }).catch(() => {});
      }
    } else if ((d.pendentesDetalhe || d.pendentesAtivacao || []).length) {
      const detalhe = d.pendentesDetalhe
        || (d.pendentesAtivacao || []).map(c => ({ codigo: c }));
      // Pedir para adicionar a mao um cupom que o proprio ML ja disse estar
      // vencido ou esgotado gasta o tempo do operador para nada. So vale a pena
      // quando a resposta e realmente desconhecida.
      const semSentido = /venceu|esgot|expirou|encerrad/i;
      const vale = detalhe.filter(x => !semSentido.test(x.mensagem || '')
        && !(Date.parse(x.validadeAte || '') < Date.now()));

      for (const x of detalhe.filter(x => !vale.includes(x))) {
        console.log('[CUPONS-ML] ' + x.codigo + ' nao vai para o operador: ' + (x.mensagem || 'ja vencido na base'));
      }

      if (vale.length) {
        await registrarAlerta({ nivel:'info', origem:'ml', chave:'ml:cupons-conferir',
          titulo:'Cupons do ML para conferir (' + vale.length + ')',
          corpo: '➕ *Confira estes cupons no Mercado Livre*\n\n'
              + vale.map(x => '• ' + x.codigo + (x.mensagem ? ' — _' + x.mensagem + '_' : '')).join('\n')
              + '\n\nO ML respondeu algo que o sync não reconhece. Tente em: '
              + 'mercadolivre.com.br/cupons → Inserir código.'
        }).catch(() => {});
      }
    }
  } catch (e) { console.warn('[CUPONS-ML] Sync agendado — erro:', e.message); }
}
setInterval(sincronizarCuponsMlAgendado, 60 * 60 * 1000);
setTimeout(sincronizarCuponsMlAgendado, 120000);   // primeira passada apos o boot
// O mapa de campanhas e pre-requisito para aplicar cupom sem codigo, entao nao
// espera os 2 minutos do sync de cupons: sobe assim que o socket estabiliza.
setTimeout(() => sincronizarCampanhasMlAgendado().catch(() => {}), 20000);

// Saude do token: de hora em hora, respeitando o espacamento quando o antibot
// esta ativo. Nao toca na pagina de produto — essa e a sonda separada abaixo.
function rotinaSaudeMl() {
  if (!tokenAffOk()) return;
  if (mlPodeTocarPagina('token')) {
    verificarTokenAff(ML_AFF_URL_TESTE, avisarTokenMlCaiu).catch(()=>{});
  }
}
setInterval(rotinaSaudeMl, 60 * 60 * 1000);
setTimeout(rotinaSaudeMl, 45000);

// ── SONDA DA PAGINA DE PRODUTO ───────────────────────────────────────────────
// Ritmo proprio, separado do teste do token, porque os dois medem coisas
// diferentes e pagam precos diferentes: a sonda e a UNICA rotina que segue
// tocando a pagina mesmo com o bloqueio confirmado. Cada requisicao recusada
// realimenta o antibot — e exatamente o padrao que ele mede —, entao insistir
// de hora em hora adia a propria saida do bloqueio. Uma vez por dia basta: com
// a API oficial autorizada, preco e estoque seguem normalmente enquanto a
// pagina estiver fechada, e o unico custo do espacamento e demorar mais para
// perceber a liberacao. Configuravel por ML_SONDA_PAGINA_H para apertar o ritmo
// sem deploy (ex.: 1 logo depois de trocar de IP, para confirmar a saida).
const ML_SONDA_PAGINA_MS = Number(process.env.ML_SONDA_PAGINA_H || 24) * 60 * 60 * 1000;
// A validade do diagnostico precisa cobrir o intervalo da sonda com folga: se
// vencer antes da proxima passada, o desvio para a API oficial cai e cada
// produto capturado volta a bater na pagina bloqueada. 25% de folga cobre
// atraso de timer e a passada perdida no redeploy.
definirValidadeAntibotMs(ML_SONDA_PAGINA_MS * 1.25);
// Trava de cadencia com memoria DURAVEL. O carimbo vive em ./sessao mas o
// filesystem do Railway nao sobrevive a restart — a durabilidade real vem do
// sync com o repo de dados (ml_sonda_pagina.json esta em NOMES_SINCRONIZAVEIS:
// baixado no boot, push apos gravar). Sem isso, todo restart espontaneo do
// Railway zerava o carimbo e a sonda do boot rodava de novo — em 28/08 a
// "uma consulta por dia" virou duas sem nenhum deploy no meio.
//
// O carimbo tambem guarda o ULTIMO VEREDITO ({bloqueado, bloqueadoDesde}),
// porque o estado do antibot em memoria zera junto com o processo: sem uma
// memoria duravel, cada reconfirmacao parecia bloqueio NOVO e saia como alerta
// critico de "token parou de funcionar" — tres sustos por dia para dizer a
// mesma coisa. Com o veredito anterior em maos da para distinguir os tres
// casos que interessam: continuou bloqueado (informativo), bloqueou agora
// (critico) e LIBEROU (a noticia que a sonda existe para dar).
function marcaSondaPath() { return SESSAO_DIR + '/ml_sonda_pagina.json'; }

function lerMarcaSondaMl() {
  try {
    if (!existsSync(marcaSondaPath())) return null;
    return JSON.parse(readFileSync(marcaSondaPath(), 'utf-8')) || null;
  } catch (e) { return null; }
}

function gravarMarcaSondaMl(m) {
  try {
    escreverAtomico(marcaSondaPath(), JSON.stringify(m), 'utf-8');
    agendarPush('ml_sonda_pagina.json');
  } catch (e) {}
}

async function rotinaSondaPaginaMl({ forcar = false } = {}) {
  if (!tokenAffOk()) return { pulada: 'sem token de afiliado' };
  const marca = lerMarcaSondaMl();
  const desde = Date.now() - Number(marca?.em || 0);
  if (!forcar && desde < ML_SONDA_PAGINA_MS) {
    const faltamMin = Math.ceil((ML_SONDA_PAGINA_MS - desde) / 60000);
    console.log('[ML] Sonda da pagina adiada: proxima em ~' + faltamMin + ' min');
    return { pulada: 'cadencia', faltamMin };
  }
  // Carimba ANTES de sondar, preservando o veredito anterior: se a requisicao
  // travar ou o processo cair no meio, o proximo boot nao pode ler isso como
  // "nunca sondei". Perder uma passada custa 24h; repetir custa reputacao.
  gravarMarcaSondaMl({ ...(marca || {}), em: Date.now() });
  console.log('[ML] Sonda da pagina de produto: 1 requisicao (cadencia '
    + (ML_SONDA_PAGINA_MS / 3600e3) + 'h)');

  const quando = (t) => new Date(t).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  let r;
  try {
    // O aviso e decidido AQUI, com o veredito anterior em maos — nao no
    // callback generico, que nao sabe se o bloqueio e novidade.
    r = await verificarPaginaProdutoMl(urlSondaProdutoMl(), async (detalhe) => {
      if (marca?.bloqueado) {
        const d0 = marca.bloqueadoDesde || marca.em || Date.now();
        await registrarAlerta({
          nivel: 'atencao', origem: 'ml', chave: 'ml:antibot-sonda',
          titulo: 'Sonda diaria: pagina do ML segue bloqueada',
          corpo: '\u23f3 *Sonda diaria do ML: bloqueio segue ativo*\n\n'
            + 'Bloqueado desde ' + quando(d0) + '. Nenhuma acao necessaria: '
            + 'o pipeline nao le pagina (ML_SO_API) e a proxima verificacao e em '
            + (ML_SONDA_PAGINA_MS / 3600e3) + 'h.\n\n'
            + 'A API oficial segue atendendo os itens de catalogo normalmente.',
        }).catch(() => {});
        return;
      }
      await avisarAntibotMl(detalhe);
    });
  } catch (e) { r = { erro: e.message }; }

  const bloqueadoAgora = r && r.ok === false && /antibot/i.test(String(r.erro || ''));
  const liberouAgora   = r && r.ok === true && marca?.bloqueado;
  if (liberouAgora) {
    await registrarAlerta({
      nivel: 'atencao', origem: 'ml', chave: 'ml:antibot-liberado',
      titulo: 'ML liberou a leitura de paginas',
      corpo: '\u2705 *A pagina de produto do ML voltou a abrir*\n\n'
        + 'Bloqueio durou desde ' + quando(marca.bloqueadoDesde || marca.em) + '.\n'
        + 'O pipeline continua em modo so-API (ML_SO_API) — nada volta a ler '
        + 'pagina sozinho. Se quiser reavaliar, a decisao e sua.',
    }).catch(() => {});
  }
  gravarMarcaSondaMl({
    em: Date.now(),
    bloqueado: !!bloqueadoAgora,
    bloqueadoDesde: bloqueadoAgora ? (marca?.bloqueadoDesde || Date.now()) : null,
    ultimoOk: r?.ok ?? null,
  });
  return r;
}
setInterval(() => { rotinaSondaPaginaMl().catch(()=>{}); }, ML_SONDA_PAGINA_MS);
setTimeout(() => { rotinaSondaPaginaMl().catch(()=>{}); }, 45000);


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
      carregarCategorias(); carregarMonitorPrecos();
      carregarCensoHist(); carregarMembrosLog();
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

// ── ENCERRAMENTO: FLUSH DO PUSH PENDENTE ─────────────────────────────────────
// O push tem debounce de 10s. No redeploy o Railway manda SIGTERM e mata o
// processo logo depois, entao toda gravacao dos ultimos 10s fica so no disco do
// container. No boot seguinte baixarDoGitHub() reescreve o disco com a versao
// do repositorio e a gravacao desaparece — o registro reaparece num estado
// anterior, com atualizadoEm no passado. Era esta a origem das edicoes perdidas
// na base de cupons durante os redeploys, e nao uma segunda rotina escrevendo
// por cima.
let _encerrando = false;
// `codigo` decide se o Railway ressuscita o container. SIGTERM/SIGINT saem com
// 0 (encerramento pedido pela plataforma). Ja o restart de autocura PRECISA
// sair com codigo != 0: com exit(0) o Railway entende que o processo terminou
// com sucesso e NAO sobe container novo — foi o que derrubou o servico das
// 12:46 do dia 22/08/2026 (degrau 3 do watchdog matou o processo e ninguem
// subiu no lugar; todo o painel ficou em 502 ate o proximo deploy).
async function encerrarComFlush(sinal, codigo = 0) {
  if (_encerrando) return;                 // SIGTERM seguido de SIGINT nao reentra
  _encerrando = true;
  // Primeiro a sessao Signal, sempre: e o unico estado que, perdido, corrompe
  // entregas futuras (replay -> "Aguardando mensagem"). Teto curto: 3s cobrem
  // qualquer rajada de gravacoes e cabem folgados no draining de 25s.
  try { await _flushTodasSessoes(3000); }
  catch (e) { console.error('[AUTH] Falha ao drenar sessao no encerramento:', e.message); }
  const pendentes = pushesPendentes();
  if (!pendentes.length) { console.log('[SYNC] ' + sinal + ' — nada no debounce.'); process.exit(codigo); }

  console.log('[SYNC] ' + sinal + ' — enviando ' + pendentes.length + ' arquivo(s) do debounce: '
    + pendentes.join(', '));
  // Teto proprio: se o GitHub estiver lento, e melhor perder a gravacao do que
  // ficar pendurado ate o SIGKILL, que perderia do mesmo jeito e sem log.
  const estourou = Symbol('timeout');
  try {
    const r = await Promise.race([
      flushPushesPendentes(),
      new Promise(res => setTimeout(() => res(estourou), 20000)),
    ]);
    if (r === estourou) console.error('[SYNC] Flush nao terminou em 20s — pode haver perda: ' + pendentes.join(', '));
    else console.log('[SYNC] Flush concluido no encerramento.');
  } catch (e) { console.error('[SYNC] Falha no flush de encerramento:', e.message); }
  process.exit(codigo);
}
process.on('SIGTERM', () => encerrarComFlush('SIGTERM'));
process.on('SIGINT',  () => encerrarComFlush('SIGINT'));

// ── GRUPOS DE DESTINO ─────────────────────────────────────────────────────────
// Os grupos do TSP (padrao, so-cupons e operador) vem da config editavel pelo
// painel (aba Configuracoes) — getters para toda leitura ver o valor atual.
// Os grupos do CDV vinham fixos aqui — pertenciam a outra operacao, fora deste
// painel. Passaram a sair de config-cdv.js, editavel na aba Config do gerador:
// mesmos getters, mesma razao (gravar em tela vale na proxima leitura, sem
// restart e sem deploy).
const GRUPOS = {
  // Grupos exclusivos de cupons — recebem copia de todo cupom_tsp com rodape
  // convidando para o grupo de ofertas (convite cruzado). Nunca recebem oferta
  // de produto. Podem ser varios.
  get tsp_cupons() { return gruposTspCupons(); },
  get cdv_ofertas() { return grupoOfertasCdv(); },
  get cdv_emissao() { return grupoEmissaoCdv(); },
  // Grupo interno do operador — avisos operacionais que NAO vao para clientes
  // (novo cupom capturado, falha de coleta, etc).
  get operador()   { return grupoOperadorTsp(); },
};
// Os 20 grupos que ficavam listados aqui viraram cadastro em config-cdv.js
// (./sessao/config_cdv.json), ligaveis e desligaveis na aba Config do gerador.
// A lista de partida e identica a que estava neste ponto — quem nao mexer em
// nada continua monitorando exatamente os mesmos grupos.
//
// As regras de EXTRACAO por grupo continuam logo abaixo, no codigo:
// GRUPOS_FILTRO_DATAS_MIN, GRUPO_APENAS_IMAGEM, GRUPO_EXECUTIVA e
// GRUPOS_TEXTO_ESTRUTURADO. Sao decisao de parsing, nao de operacao — um valor
// torto ali nao desliga o grupo, faz o grupo capturar errado em silencio.
// Grupo cadastrado pela tela e que nao aparece em nenhuma dessas regras e
// tratado no fluxo padrao.
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
  '120363230586056001@g.us': 5, // TSM - ALERTAS FORTALEZA
  '120363211276624072@g.us': 5, // TSM - ALERTAS SALVADOR
  '120363416996630307@g.us': 5, // TSM - ALERTAS BRASÍLIA #3
  '120363427410900900@g.us': 5, // TSM - ALERTAS RECIFE #2
  '120363423603571989@g.us': 5, // TSM - ALERTAS UBERLÂNDIA
  '120363428018752970@g.us': 5, // TSM - ALERTAS CAMPO GRANDE #2
  '120363281681293673@g.us': 5, // TSM - ALERTAS ARACAJU
  '120363231330746034@g.us': 5, // TSM - ALERTAS BELÉM
  '120363428522283420@g.us': 5, // TSM - ALERTAS JOÃO PESSOA/CAMPINA GRANDE
  '120363284038160631@g.us': 5, // TSM - ALERTAS SÃO LUÍS
};

const PORT          = process.env.PORT || 3001;
// Funcao, nao const: a chave pode ser gravada pelo painel depois do boot e
// precisa valer na proxima chamada, sem restart.
function anthropicKey() { return process.env.ANTHROPIC_API_KEY; }
const SESSAO_DIR    = './sessao';
const UPLOAD_DIR    = './tmp-uploads';

[SESSAO_DIR, UPLOAD_DIR].forEach(d => { if (!existsSync(d)) mkdirSync(d, { recursive: true }); });

// ── ESCRITA ATOMICA DE ARQUIVOS DE ESTADO ────────────────────────────────────
// Grava em <arquivo>.tmp e faz rename() — no MESMO diretorio, para o rename ser
// atomico (rename entre filesystems diferentes nao e). Um SIGKILL/ENOSPC no meio
// de um write nunca mais deixa JSON truncado (a causa raiz classica de Bad MAC
// e de fila/agendamentos corrompidos apos redeploy). O .tmp orfao, se sobrar, e
// varrido pela faxina periodica (filtro *.tmp). Serve para qualquer conteudo
// (JSON ou string de sessao). A sessao do WhatsApp ja usa escrita atomica
// propria (useAuthStateAtomico); este helper cobre o RESTO dos JSONs de estado.
function escreverAtomico(caminho, dados, encoding = 'utf-8') {
  const tmp = caminho + '.tmp';
  writeFileSync(tmp, dados, encoding);
  renameSync(tmp, caminho);
}

// ── CENTRAL DE ALERTAS ────────────────────────────────────────────────────────
// Antes: 29 pontos espalhados chamavam enviarMensagem(GRUPOS.operador) ou
// _avisarOperador direto, cada um com seu proprio Map de throttle, e TUDO caia
// no mesmo grupo. O volume de aviso informativo (sync de cupom, sonda liberada,
// espelho de categoria) afogava o que exige acao — token caido, oferta retida.
//
// Aqui todo alerta vira um registro com NIVEL, e o nivel decide o destino:
//   critico  — a operacao parou. Vai para o grupo do operador.
//   atencao  — dinheiro na mesa, exige decisao sua. Vai para o grupo.
//   info     — registro. NAO vai para o WhatsApp: so aparece na tela.
// Os tres aparecem em GET /alertas. Quando existir um segundo grupo, basta
// apontar DESTINO_POR_NIVEL para ele — nenhum ponto de chamada muda.
const ALERTAS_PATH = SESSAO_DIR + '/alertas.json';
const ALERTAS_MAX  = 500;
const NIVEIS_ALERTA = ['critico', 'atencao', 'info'];

// Grupo por nivel. null = nao envia no WhatsApp, so registra para a tela.
// Fase de teste: o operador recebe critico e atencao; info fica so na pagina.
const DESTINO_POR_NIVEL = { critico: 'operador', atencao: 'operador', info: null };

let alertas = [];
try {
  if (existsSync(ALERTAS_PATH)) alertas = JSON.parse(readFileSync(ALERTAS_PATH, 'utf-8')) || [];
} catch (e) { alertas = []; }

function salvarAlertas() {
  try { escreverAtomico(ALERTAS_PATH, JSON.stringify(alertas), 'utf-8'); }
  catch (e) { console.error('[ALERTA] Falha ao salvar:', e.message); }
}

// Throttle central: a chave identifica o alerta (ex. 'ml:antibot',
// 'cupom-sem-base:Amazon:XPTO'). Repeticao dentro da janela nao vira mensagem
// nova — mas o registro em tela ganha um contador, para o volume nao sumir.
const _ULTIMO_ALERTA = new Map();
const JANELA_ALERTA_PADRAO_MS = 6 * 3600e3;

function gerarIdAlerta() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/**
 * Registra um alerta e, conforme o nivel, entrega no WhatsApp.
 * @param {object} a
 *   nivel     'critico' | 'atencao' | 'info'
 *   chave     identidade para throttle e agrupamento na tela
 *   titulo    uma linha, sem markdown
 *   corpo     texto ja formatado que vai para o WhatsApp
 *   origem    rotulo curto da area (ml, radar, watchdog, whatsapp, amazon...)
 *   ofertaId  liga o alerta a uma oferta da fila, quando houver
 *   janelaMs  throttle proprio; 0 desliga
 */
async function registrarAlerta(a = {}) {
  const nivel = NIVEIS_ALERTA.includes(a.nivel) ? a.nivel : 'info';
  const chave = String(a.chave || (a.origem || 'geral') + ':' + (a.titulo || ''));
  const janela = a.janelaMs === 0 ? 0 : (Number(a.janelaMs) || JANELA_ALERTA_PADRAO_MS);
  const agora = Date.now();

  // Repetido dentro da janela: soma no registro que ja existe em vez de criar
  // outro. A tela mostra "3x" e o grupo nao recebe nada de novo.
  const anterior = _ULTIMO_ALERTA.get(chave);
  const repetido = janela > 0 && anterior && (agora - anterior) < janela;
  if (repetido) {
    const reg = alertas.find(x => x.chave === chave);
    if (reg) {
      reg.repeticoes = (reg.repeticoes || 1) + 1;
      reg.ultimaEm = new Date(agora).toISOString();
      salvarAlertas();
    }
    return { registrado: false, enviado: false, repetido: true };
  }
  _ULTIMO_ALERTA.set(chave, agora);

  const reg = {
    id: gerarIdAlerta(),
    em: new Date(agora).toISOString(),
    ultimaEm: new Date(agora).toISOString(),
    nivel, chave,
    origem: a.origem || 'geral',
    titulo: String(a.titulo || '').slice(0, 200),
    corpo: String(a.corpo || '').slice(0, 4000),
    ofertaId: a.ofertaId != null ? String(a.ofertaId) : null,
    repeticoes: 1,
    lido: false,
    enviado: false,
  };
  alertas.unshift(reg);
  if (alertas.length > ALERTAS_MAX) alertas.length = ALERTAS_MAX;

  const destino = a.soRegistrar ? null : DESTINO_POR_NIVEL[nivel];
  if (destino && GRUPOS[destino]) {
    try {
      await enviarMensagem(GRUPOS[destino], { text: reg.corpo || reg.titulo });
      reg.enviado = true;
    } catch (e) { console.error('[ALERTA] Falha ao entregar (' + nivel + '):', e.message); }
  }
  salvarAlertas();
  console.log('[ALERTA] ' + nivel.toUpperCase() + ' ' + chave
    + (reg.enviado ? ' — no grupo' : destino ? ' — falhou no grupo' : ' — so na tela'));
  return { registrado: true, enviado: reg.enviado, repetido: false };
}

// ── PULSO POR LOJA: PLATAFORMA QUE PAROU DE RENDER OFERTA ───────────────────
// Grupo-fonte que para de trazer oferta de uma loja e falha silenciosa: o radar
// segue "no ar", o watchdog segue verde, e simplesmente nao sai mais nada
// daquela plataforma. Sem esta medida ninguem percebe ate o faturamento cair.
const PULSO_PATH = SESSAO_DIR + '/pulso_lojas.json';
const PULSO_LIMITE_MS   = 12 * 3600e3;   // silencio que vira alerta
const PULSO_ESQUECER_MS = 7 * 24 * 3600e3; // loja parada ha uma semana nao e novidade
let pulsoLojas = {};
// Segunda via do pulso: qualquer despacho da loja, venha do radar de grupo ou
// nao (fila cadenciada, vitrine, lista, bot). Sem ela o alerta media so um dos
// caminhos e gritava "loja parada" enquanto a loja faturava por outro — foi o
// que aconteceu com a Shopee em 27/08: o radar de grupo parou as 09:37 e as
// ofertas seguiram saindo ate as 17:45, mas o alerta contou as 8h como parada.
let pulsoDespacho = {};
try {
  if (existsSync(PULSO_PATH)) {
    const bruto = JSON.parse(readFileSync(PULSO_PATH, 'utf-8')) || {};
    // Formato antigo: mapa plano loja -> timestamp. Migra sem perder historico.
    if (bruto.radar || bruto.despacho) {
      pulsoLojas    = bruto.radar    || {};
      pulsoDespacho = bruto.despacho || {};
    } else {
      pulsoLojas = bruto;
    }
  }
} catch (e) { pulsoLojas = {}; pulsoDespacho = {}; }

function salvarPulso() {
  try {
    escreverAtomico(PULSO_PATH,
      JSON.stringify({ radar: pulsoLojas, despacho: pulsoDespacho }), 'utf-8');
  } catch (e) {}
}

function registrarPulsoLoja(loja) {
  const nome = String(loja || '').trim();
  if (!nome) return;
  pulsoLojas[nome] = Date.now();
  salvarPulso();
}

/** Prova de vida do DESPACHO: a loja publicou, por qualquer caminho. */
function registrarPulsoDespacho(loja) {
  const nome = String(loja || '').trim();
  if (!nome) return;
  pulsoDespacho[nome] = Date.now();
  salvarPulso();
}

async function verificarPulsoLojas() {
  const agora = Date.now();
  for (const [loja, ts] of Object.entries(pulsoLojas)) {
    const parado = agora - Number(ts || 0);
    if (parado < PULSO_LIMITE_MS) continue;
    // Loja que nunca mais apareceu deixou de ser operada: alertar todo dia sobre
    // ela seria ruido permanente.
    if (parado > PULSO_ESQUECER_MS) continue;
    const horas = Math.floor(parado / 3600e3);

    // O radar de grupo parou — mas a loja parou mesmo? Se ela seguiu publicando
    // por outro caminho, o problema e de CAPTURA, nao da plataforma, e o alerta
    // nao pode ser critico: alerta critico que se repete sem a loja estar parada
    // treina o operador a ignorar o canal justamente quando ele for verdadeiro.
    const tsDesp     = Number(pulsoDespacho[loja] || 0);
    const lojaViva   = tsDesp > 0 && (agora - tsDesp) < PULSO_LIMITE_MS;
    const quando     = (t) => new Date(Number(t)).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

    if (lojaViva) {
      await registrarAlerta({
        nivel: 'atencao', origem: 'radar', chave: 'pulso-radar:' + loja,
        titulo: 'Radar de grupo sem ' + loja + ' ha ' + horas + 'h',
        corpo: '⚠️ *Radar de grupo sem ' + loja + ' ha ' + horas + 'h*\n\n'
          + 'A loja NAO esta parada: o ultimo despacho foi ' + quando(tsDesp) + '.\n'
          + 'O que parou foi a captura em grupo monitorado, desde ' + quando(ts) + '.\n\n'
          + 'Vale conferir: janela de captura na aba Grupos e se os grupos-fonte '
          + 'continuam publicando produto desta loja (cupom generico nao conta).',
      }).catch(() => {});
      continue;
    }

    await registrarAlerta({
      nivel: 'critico', origem: 'radar', chave: 'pulso:' + loja,
      titulo: loja + ' sem oferta ha ' + horas + 'h',
      corpo: '🛑 *' + loja + ' parada ha ' + horas + 'h*\n\n'
        + 'Nenhuma oferta desta loja saiu de grupo monitorado desde ' + quando(ts) + '.\n'
        + (tsDesp ? 'E nenhum despacho por qualquer caminho desde ' + quando(tsDesp) + '.\n' : '')
        + '\nVale conferir: janela de captura na aba Grupos, antibot/token da loja '
        + 'e se os grupos-fonte continuam publicando.',
    }).catch(() => {});
  }
}
setInterval(() => { verificarPulsoLojas().catch(() => {}); }, 30 * 60 * 1000);

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
    // Drena a cadeia de escrita ate estabilizar (ou ate maxMs). Usado antes de
    // QUALQUER process.exit: keys.set() ja faz await da gravacao, mas um exit que
    // chega com esse await em voo perde session-*/sender-key-* ja avancados na
    // memoria — e no proximo boot o bot cifra com contador repetido, que o
    // destinatario descarta como replay ("Aguardando mensagem").
    flush: async (maxMs = 3000) => {
      const fim = Date.now() + maxMs;
      let ultima = null;
      while (Date.now() < fim) {
        const atual = cadeiaEscrita;
        if (atual === ultima) break;      // ninguem enfileirou nada desde a ultima espera
        ultima = atual;
        await Promise.race([atual, new Promise(r => setTimeout(r, Math.max(0, fim - Date.now())))]);
      }
    },
  };
}

// Registro dos flushes de sessao (principal + contas secundarias), por pasta:
// reconexao substitui o anterior em vez de acumular cadeias mortas.
const _flushsSessao = new Map();   // pasta -> flush()
async function _flushTodasSessoes(maxMs = 3000) {
  const fns = [..._flushsSessao.values()];
  if (!fns.length) return;
  const t0 = Date.now();
  await Promise.all(fns.map(f => f(maxMs).catch(() => {})));
  console.log('[AUTH] Sessao(oes) drenada(s) antes do exit em ' + (Date.now() - t0) + ' ms (' + fns.length + ' pasta(s)).');
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

// ── PAREAMENTO POR CODIGO (sem QR) ──────────────────────────────────────────
// Alternativa ao QR para quando so ha o celular em maos: o WhatsApp aceita
// vincular um dispositivo digitando um codigo de 8 caracteres em
// Dispositivos conectados > Conectar dispositivo > Conectar com numero de
// telefone. Exige sessao NAO registrada — por isso /pair reseta antes.
let pairNumero   = null;   // numero alvo, so digitos, com DDI (ex 5511999999999)
let pairCodigo   = null;   // codigo de 8 caracteres devolvido pelo WhatsApp
let pairErro     = null;   // ultima falha ao solicitar o codigo
let pairPedidoEm = 0;      // timestamp do pedido (expira em 10 min)

// ── GERENCIADOR DE CONEXÃO ────────────────────────────────────────────────────
// Flag que indica se já existe um processo de conexão ativo.
// Evita instâncias duplas de sock sem complexidade de Promises aninhadas.
let _conexaoPromise = null; // apenas para expor no /status

// Aguarda sock disponível com polling leve.
// Dispara conectar() uma única vez se não estiver conectando.
// Instante do ultimo 'open' da conta principal. Logo apos o open o Baileys
// ainda processa o lote offline e o app-state sync; enviar nesse primeiro
// segundo compete com isso e e a janela mais fragil para cifrar. Pre-keys NAO
// sao o motivo (o Baileys as sobe ANTES de emitir open) — e so estabilizacao.
let _abertoEm = 0;
const ESTABILIZACAO_POS_OPEN_MS = 3000;
function _sockEstavel() {
  return conectado && !!sock && (Date.now() - _abertoEm) >= ESTABILIZACAO_POS_OPEN_MS;
}

async function aguardarSock(ms = 20000) {
  if (_sockEstavel()) return true;
  if (!(conectado && sock)) {
    console.log('[WA] aguardarSock: aguardando conexão...');
    if (!isConnecting && !sock) conectar();
  }
  const inicio = Date.now();
  while (!_sockEstavel() && Date.now() - inicio < ms) {
    await new Promise(r => setTimeout(r, 500));
  }
  return _sockEstavel();
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
    escreverAtomico(CUPONS_VISTOS_PATH, JSON.stringify(_cuponsVistos), 'utf-8');
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
      retomarEnviosInterrompidos();
    }
  } catch(e) { console.log('[FILA] Erro ao carregar fila:', e.message); }
}

// Um envio tem tres desfechos, nao dois: concluiu, deu erro — ou o processo
// sumiu no meio. Os dois primeiros o worker trata; o terceiro deixava o item
// parado em 'enviando' para sempre, invisivel tanto para o worker (que so olha
// 'pendente') quanto para a aba Aprovacao. Aqui ele volta para aprovacao
// manual, NUNCA para auto-envio: o cupom pode ter saido em parte dos grupos, e
// reenviar sozinho duplicaria a mensagem em quem ja recebeu. O rastro de
// enviadosParciais garante que o reenvio manual pule esses grupos.
function retomarEnviosInterrompidos() {
  let n = 0;
  for (const o of filaPendentes) {
    if (o.status !== 'enviando') continue;
    const entregues = Array.isArray(o.enviadosParciais) ? o.enviadosParciais.length : 0;
    o.status = 'pendente';
    o.envioInterrompido = true;
    o.gruposEntregues = entregues;
    delete o.autoAgendado;
    delete o.enviandoDesde;
    if (o.autoAvaliacao) {
      o.autoAvaliacao.motivo += ' — envio interrompido'
        + (entregues ? ` apos ${entregues} grupo(s)` : '') + ', requer conferencia manual';
    }
    n++;
    console.warn(`[FILA] Cupom #${o.id} estava em envio quando o processo parou`
      + (entregues ? ` (${entregues} grupo(s) ja receberam)` : '') + ' — devolvido para aprovacao manual.');
  }
  if (n) salvarFila();
}

// Tipos que o painel Gestao TSP trata como oferta de marketplace. Amazon hoje;
// ML e Shopee entram aqui sem mudar mais nada no roteamento.
const TIPOS_OFERTA_MARKETPLACE = new Set(['oferta_amazon', 'oferta_ml', 'oferta_shopee', 'oferta_magalu', 'oferta_awin']);

// Rede de seguranca: qualquer tipo 'oferta_*' e conteudo TSP e vai para os
// grupos de destino do TSP. Sem isso, uma loja nova (foi o caso da Awin) cai no
// fallback de emissao e vaza no grupo Emissoes CDV.
function ehOfertaMarketplace(tipo) {
  const t = String(tipo || '');
  return TIPOS_OFERTA_MARKETPLACE.has(t) || t.indexOf('oferta_') === 0;
}
function ehConteudoTsp(tipo) {
  return String(tipo || '') === 'cupom_tsp' || ehOfertaMarketplace(tipo);
}

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
    escreverAtomico(FILA_PATH, JSON.stringify(filaPendentes), 'utf-8');
  } catch(e) { console.log('[FILA] Erro ao salvar fila:', e.message); }
}

const filaPendentes = [];
carregarFila();

// ── OUTBOX DE ENTREGAS QUE FALHARAM (Fase 2: nenhum disparo se perde) ────────
// Nos despachos para varios grupos (oferta do radar, cupom), uma falha num
// destino era SO registrada em `falhas` e devolvida ao chamador — que apenas
// logava. Se o socket caia no destino 13 de 33, os 21 restantes falhavam um a
// um e esses grupos NUNCA recebiam a oferta, com a funcao devolvendo "sucesso"
// porque 12 sairam. Faturamento perdido em silencio.
//
// Esta outbox guarda, em disco, SO o que falhou, e um worker retenta com
// backoff quando o socket volta. O caminho feliz (socket ok) nao muda uma
// linha — a outbox so existe na excecao.
//
// Garantias e limites, de proposito:
//   - Idempotente por (id, jid): o mesmo destino da mesma oferta entra uma vez.
//     Quem ja recebeu no despacho original nunca esta aqui.
//   - So o TENANT PADRAO entra. O retry roda fora do AsyncLocalStorage da
//     requisicao original; retentar item de operador secundario sairia pelo
//     numero ERRADO — a pior falha do modelo hospedado. Secundarios mantem o
//     comportamento antigo (falha devolvida ao chamador).
//   - Reenvia SO TEXTO: card de link (linkPreview, com thumbnail em bytes) e
//     imagem de cupom nao sao persistidos. O link segue no texto e gera
//     comissao igual; perder o card no retry e trivial perto de perder a oferta.
//   - TTL: item com mais de OUTBOX_TTL_H horas e descartado sem enviar.
//     Promocao que falhou ontem nao ressuscita hoje com preco/cupom vencido.
//   - Teto de tentativas: destino envenenado (bot removido do grupo, grupo
//     extinto) nao gira para sempre — desiste e avisa o operador.
//   - Risco assumido: envio que falhou por 'timed out' mas foi entregue gera
//     duplicata no retry. E o mesmo tradeoff do retry ja existente em
//     enviarMensagem, e a alternativa (perder 21 grupos) e claramente pior.
const OUTBOX_PATH           = SESSAO_DIR + '/outbox_falhas.json';
const OUTBOX_MAX_TENTATIVAS = 12;
const OUTBOX_TTL_MS         = Math.max(1, parseInt(process.env.OUTBOX_TTL_H || '6', 10)) * 60 * 60 * 1000;
const outboxFalhas = [];   // { id, jid, texto, conta, origem, tentativas, proximaEm, criadoEm, ultimoErro }
let _outboxRodando = false;

// Backoff em minutos por tentativa: 1, 2, 5, 10, 20, 30, 30... (socket que
// cai costuma voltar em minutos; nao adianta martelar a cada 10s).
function outboxBackoffMs(tentativa) {
  const m = [1, 2, 5, 10, 20, 30];
  return m[Math.min(Math.max(tentativa, 1) - 1, m.length - 1)] * 60 * 1000;
}

function salvarOutbox() {
  try { escreverAtomico(OUTBOX_PATH, JSON.stringify(outboxFalhas)); }
  catch (e) { console.error('[OUTBOX] Erro ao salvar:', e.message); }
}

function carregarOutbox() {
  try {
    if (!existsSync(OUTBOX_PATH)) return;
    const lista = JSON.parse(readFileSync(OUTBOX_PATH, 'utf-8'));
    if (Array.isArray(lista)) {
      outboxFalhas.push(...lista.filter(x => x && x.jid && x.texto));
      if (outboxFalhas.length) console.log('[OUTBOX] ' + outboxFalhas.length + ' entrega(s) pendente(s) recuperada(s) do disco.');
    }
  } catch (e) { console.error('[OUTBOX] Erro ao carregar:', e.message); }
}

// Chamado no catch dos despachos. Devolve true se enfileirou.
function outboxEnfileirar({ id, jid, texto, conta, origem, erro }) {
  try {
    if (!jid || !texto) return false;
    if ((tenantContexto() || TENANT_PADRAO) !== TENANT_PADRAO) return false;   // ver cabecalho
    const chaveId = String(id || '');
    if (outboxFalhas.some(x => x.id === chaveId && x.jid === jid)) return false; // idempotente
    outboxFalhas.push({
      id: chaveId, jid, texto,
      conta: (conta && conta !== 'principal') ? conta : null,
      origem: origem || 'envio',
      tentativas: 0,
      proximaEm: Date.now() + outboxBackoffMs(1),
      criadoEm: Date.now(),
      ultimoErro: erro || null,
    });
    salvarOutbox();
    _outboxContar('enfileiradas');
    console.warn('[OUTBOX] Entrega guardada para retry: ' + (origem || 'envio') + ' #' + chaveId + ' -> ' + jid + ' (' + outboxFalhas.length + ' pendente(s)).');
    return true;
  } catch (e) { console.error('[OUTBOX] Erro ao enfileirar:', e.message); return false; }
}

async function outboxWorker() {
  if (_outboxRodando) return;
  _outboxRodando = true;
  try {
    const agora = Date.now();
    // TTL primeiro: o que envelheceu sai sem ser enviado.
    let mudou = false;
    for (let i = outboxFalhas.length - 1; i >= 0; i--) {
      const it = outboxFalhas[i];
      if (agora - (it.criadoEm || agora) > OUTBOX_TTL_MS) {
        console.warn('[OUTBOX] Descartando entrega expirada (' + Math.round(OUTBOX_TTL_MS / 3600000) + 'h): ' + it.origem + ' #' + it.id + ' -> ' + it.jid);
        outboxFalhas.splice(i, 1); mudou = true;
      }
    }
    if (mudou) salvarOutbox();
    if (!outboxFalhas.length) return;
    if (!conectado || !sock) return;   // socket caido: os itens esperam o proximo ciclo

    const prontos = outboxFalhas.filter(x => (x.proximaEm || 0) <= agora);
    for (const item of prontos) {
      if (!conectado || !sock) break;  // caiu no meio: para e volta no proximo ciclo
      try {
        await enviarMensagem(item.jid, { text: item.texto }, 0, item.conta ? { conta: item.conta } : {});
        const idx = outboxFalhas.indexOf(item);
        if (idx >= 0) outboxFalhas.splice(idx, 1);
        salvarOutbox();
        _outboxContar('recuperadas');
        console.log('[OUTBOX] ✓ Entrega recuperada: ' + item.origem + ' #' + item.id + ' -> ' + item.jid
          + ' (tentativa ' + (item.tentativas + 1) + '; ' + outboxFalhas.length + ' restante(s)).');
        if (outboxFalhas.length) await new Promise(r => setTimeout(r, msEntreGrupos()));
      } catch (e) {
        item.tentativas = (item.tentativas || 0) + 1;
        item.ultimoErro = e.message;
        if (item.tentativas >= OUTBOX_MAX_TENTATIVAS) {
          const idx = outboxFalhas.indexOf(item);
          if (idx >= 0) outboxFalhas.splice(idx, 1);
          _outboxContar('desistidas');
          console.error('[OUTBOX] ✗ Desistindo apos ' + item.tentativas + ' tentativas: ' + item.origem + ' #' + item.id + ' -> ' + item.jid + ': ' + e.message);
          _avisarOperador('Outbox: desisti de entregar ' + item.origem + ' #' + item.id + ' no grupo '
            + (NOMES_GRUPOS.get(item.jid) || item.jid) + ' apos ' + item.tentativas + ' tentativas.\nUltimo erro: ' + e.message
            + '\nSe o bot foi removido do grupo, ajuste os destinos na aba Grupos.').catch(() => {});
        } else {
          item.proximaEm = Date.now() + outboxBackoffMs(item.tentativas);
          console.warn('[OUTBOX] Falha (' + item.tentativas + '/' + OUTBOX_MAX_TENTATIVAS + ') ' + item.origem + ' #' + item.id + ' -> ' + item.jid
            + ': ' + e.message + '. Proxima em ' + Math.round(outboxBackoffMs(item.tentativas) / 60000) + ' min.');
        }
        salvarOutbox();
      }
    }
  } catch (e) { console.error('[OUTBOX] Erro no ciclo:', e.message); }
  finally { _outboxRodando = false; }
}

carregarOutbox();
setInterval(() => { outboxWorker().catch(() => {}); }, 60 * 1000).unref?.();
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

// Recolocar na fila de envio ofertas que foram aprovadas mas nao enviadas.
// Roda no boot E em varredura periodica: filaEnvio vive so em memoria, entao
// todo restart do Railway (deploy, crash, sleep) apagava a fila e as ofertas ja
// marcadas 'aprovado' ficavam presas nesse estado para sempre — nada as devolvia.
// Tres cuidados alem do requeue em si:
//  - aceita mensagemFormatada como fallback: o auto-envio de alerta
//    (entregarOfertaAlerta) marca 'aprovado' sem passar por /painel/aprovar,
//    entao a oferta nao tinha mensagemFinal e o filtro antigo a ignorava —
//    era a razao de TODA injecao manual e todo alerta auto-aprovado morrer
//    em 'aprovado' depois de um restart;
//  - deduplica contra a filaEnvio, senao a varredura periodica reenfileiraria
//    o mesmo item a cada rodada e a mensagem sairia repetida no grupo;
//  - ignora conteudo TSP (cupom/oferta de loja), que tem grupos de destino
//    proprios e nunca pode cair no grupo de emissoes do CDV.
function requeueAprovadas(motivo = 'após restart') {
  const naFila = new Set(filaEnvio.map(i => String(i.ofertaId)));
  const aprovadas = filaPendentes.filter(o =>
    o.status === 'aprovado'
    && !ehConteudoTsp(o.tipoConteudo)
    && !ehOfertaMarketplace(o.tipoConteudo)
    && (o.mensagemFinal || o.mensagemFormatada)
    && !naFila.has(String(o.id)));
  if (aprovadas.length === 0) return 0;
  console.log('[FILA] Reenfileirando ' + aprovadas.length + ' oferta(s) aprovada(s) ' + motivo + '...');
  for (const o of aprovadas) {
    if (!o.mensagemFinal) o.mensagemFinal = o.mensagemFormatada;
    filaEnvio.push({ ofertaId: o.id, mensagem: o.mensagemFinal,
                     destino: GRUPOS[GRUPO_DESTINO_PASSAGENS],
                     dados: o.dadosExtraidos || null });
    console.log('[FILA] Reenfileirada oferta #' + o.id);
  }
  try { salvarFila(); } catch(_) {}
  workerFila().catch(e => { console.error('[FILA] Worker erro:', e.message); workerRodando = false; });
  return aprovadas.length;
}
const bufferAgrupamento = new Map();

// ── FILA DE ENVIO CDV (intervalo de 5 min, janela 08h–21h, fuso SP) ──────────
const INTERVALO_ENVIO_MS = 10 * 60 * 1000;
// Teto de tentativas por item. Sem isto, um item que falha sempre (grupo
// invalido, mensagem rejeitada) fica na CABECA da fila em retry eterno e
// bloqueia todas as ofertas atras dele — a fila inteira para de andar.
const FILA_MAX_TENTATIVAS = 5;
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
    const { state, saveCreds, flush: flushSessao } = await useAuthStateAtomico(dir);
    _flushsSessao.set(dir, flushSessao);
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
      getMessage: async (key) => c.enviadas.get(key?.id) || obterMensagemEnviada(key?.id),
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
        if (s._closeTratado) return;                   // duplicata do mesmo socket
        s._closeTratado = true;
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
    // Handler de leitura da conta secundaria. ENXUTO de proposito: nada de
    // reset de sessao, contagem global de erros de decifracao, health timer ou
    // resposta de campanha — tudo isso pertence ao socket principal, e disparar
    // a partir daqui derrubaria a sessao da principal por um evento que nao e
    // dela. Aqui so entra o que a operacao dona precisa: pulso e pipeline.
    c.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify' && type !== 'append') return;
      registrarPulsoLeitor(id);
      const ctx = { contaId: id, sock: c.sock };
      for (const msg of (messages || [])) {
        if (!msg.message) continue;
        try { await despacharParaPipeline(msg, ctx); }
        catch (e) { console.error('[CONTA:' + id + '] Falha ao processar mensagem:', e.message); }
      }
    });
  } catch (e) {
    c.conectando = false;
    c.ultimoErro = e.message;
    console.error('[CONTA:' + id + '] falha ao conectar:', e.message);
  }
  return c;
}

// ── TETO DE TEMPO NO ENVIO (evita worker pendurado) ─────────────────────────
// sock.sendMessage pode ficar pendurado indefinidamente num socket zumbi que
// nao rejeitou a promessa (TCP meio-aberto sem close limpo). Isso trava o
// worker da fila e nenhum disparo sai — o modo de falha que estamos atacando.
// O teto e GENEROSO de proposito: o keepalive do Baileys ja mata socket morto
// em ~35s emitindo close (que rejeita o envio com erro de conexao, retryable).
// 60s fica ACIMA dessa janela, entao no caso normal o keepalive rejeita antes;
// este teto so pega o envio que ficou preso mesmo. A mensagem de erro inclui
// 'timed out' de proposito: cai no MESMO ramo retryable que enviarMensagem ja
// trata, sem inventar um caminho novo de falha (e sem aumentar risco de envio
// duplicado alem do que ja existe hoje).
const ENVIO_TIMEOUT_MS = 60000;
function _enviarComTeto(promessaEnvio) {
  return Promise.race([
    promessaEnvio,
    new Promise((_, rej) => setTimeout(
      () => rej(new Error('sendMessage timed out (' + Math.round(ENVIO_TIMEOUT_MS/1000) + 's)')),
      ENVIO_TIMEOUT_MS)),
  ]);
}

async function enviarPelaConta(id, destino, conteudo) {
  const c = contasExtras.get(id);
  if (!c?.conectado || !c.sock) throw new Error('conta ' + id + ' nao conectada');
  const r = await _enviarComTeto(c.sock.sendMessage(destino, conteudo));
  try {
    if (r?.key?.id && r?.message) {
      c.enviadas.set(r.key.id, r.message);
      if (c.enviadas.size > 300) c.enviadas.delete(c.enviadas.keys().next().value);
    }
  } catch (e) {}
  guardarMensagemEnviada(r);
  c.ultimoEnvio = new Date().toISOString();
  return r;
}

async function enviarMensagem(destino, conteudo, tentativa = 0, opcoes = {}) {
  // Marca d'agua: so na primeira passada. O retry mais abaixo se rechama com
  // `tentativa + 1` e o conteudo JA marcado — remarcar empilharia uma faixa
  // sobre a outra a cada reenvio.
  if (tentativa === 0) conteudo = await conteudoComMarca(destino, conteudo);

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

  // Destino do CDV sem conta explicita usa a conta configurada na aba Config do
  // gerador. Quem chamou pedindo uma conta especifica (a escala de turnos do
  // TSP) continua mandando — este default so preenche o que estava vazio.
  let contaId = opcoes.conta;
  if (!contaId && ehGrupoCdv(destino)) {
    const apelidoCdv = contaEnvioCdv();
    if (apelidoCdv) contaId = contaIdDe(TENANT_PADRAO, apelidoCdv);
  }

  // Conta escolhida pela escala de turnos. Falha ou indisponibilidade cai na
  // principal em vez de abortar: a mensagem sair pelo numero "errado" e menos
  // grave do que nao sair.
  if (contaId && contaId !== 'principal' && tentativa === 0) {
    if (contaDisponivel(contaId)) {
      try {
        const _r = await enviarPelaConta(contaId, destino, conteudo);
        registrarPublicacaoHealth(destino);
        return _r;
      }
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
    const resultado = await _enviarComTeto(sock.sendMessage(destino, conteudo));
    guardarMensagemEnviada(resultado);
    registrarPublicacaoHealth(destino);
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

/**
 * Aviso operacional do CDV: vai para o grupo de avisos (se cadastrado) e para
 * o WhatsApp de cada admin com o papel 'avisos'. Nunca lanca — um aviso que
 * falha nao pode derrubar o fluxo que o gerou.
 */
async function avisarAdminsCdv(texto) {
  const alvos = [];
  const grupo = grupoAvisosCdv();
  if (grupo) alvos.push(grupo);
  for (const tel of telefonesAvisoCdv()) {
    try {
      // Nunca montar o JID somando '@s.whatsapp.net' ao telefone — ver
      // resolverJidWhatsApp logo abaixo (conversa fantasma).
      const { jid } = await resolverJidWhatsApp(tel);
      if (jid) alvos.push(jid);
    } catch (e) { console.warn('[CDV] Nao resolvi o JID do admin ' + tel + ': ' + e.message); }
  }
  if (!alvos.length) return 0;
  let ok = 0;
  for (const jid of alvos) {
    try { await enviarMensagem(jid, { text: texto }); ok++; }
    catch (e) { console.warn('[CDV] Falha ao avisar ' + jid + ': ' + e.message); }
  }
  return ok;
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
      if (item.registrar !== false && de.origem && de.destino && de.programa && ofertaEnviada?.tipoConteudo !== 'cupom_tsp') {
        registrarPassagemProxy({
          origem:      de.origem,
          destino:     de.destino,
          cia:         de.cia || '',
          programa:    de.programa,
          pontos:      Number(de.pontos) || 0,
          cabine:      de.cabine || 'Economica',
          datas_ida:   de.datasIda || '',
          datas_volta: de.datasVolta || '',
          // 'emissao' = gerado a mao na aba Emissao do gerador (agendado);
          // 'alerta'   = veio do radar de grupos monitorados.
          fonte:       item.fonte || 'alerta',
          // Distingue disparo automatico (AUTO_ENVIO_ALERTA=on + veredito
          // positivo) de envio liberado na aprovacao manual do gerador.
          auto:        item.fonte === 'emissao' ? false : !!ofertaEnviada?.autoEnviado,
          // 'coleta' separa o auto-envio da varredura seats.aero do auto-envio
          // de captura em grupo monitorado. null nao e gravado pelo proxy.
          captura:     capturaDaOferta(ofertaEnviada) || item.captura || null,
        }).catch(() => {});
      }

      console.log('[FILA] ✓ Oferta #' + item.ofertaId + ' enviada.');
    } catch(e) {
      item.tentativas = (item.tentativas || 0) + 1;
      console.error('[FILA] ✗ Erro ao enviar oferta #' + item.ofertaId
        + ' (tentativa ' + item.tentativas + '/' + FILA_MAX_TENTATIVAS + '):', e.message);
      if (item.tentativas >= FILA_MAX_TENTATIVAS) {
        filaEnvio.shift();
        const ofertaFalha = filaPendentes.find(o => String(o.id) === String(item.ofertaId));
        if (ofertaFalha && ofertaFalha.status === 'aprovado') {
          ofertaFalha.status = 'pendente';
          ofertaFalha.motivoFila = 'falha no envio após ' + item.tentativas + ' tentativas: ' + e.message;
          salvarFila();
        }
        console.error('[FILA] Oferta #' + item.ofertaId + ' removida da fila e devolvida para aprovação manual.');
        avisarAdminsCdv('⚠️ CDV — a oferta #' + item.ofertaId + ' falhou ' + item.tentativas
          + ' vez(es) e voltou para aprovação manual no gerador.\n\nÚltimo erro: ' + e.message)
          .catch(() => {});
      }
      await new Promise(r => setTimeout(r, 10000));
      continue;
    }
  }
  workerRodando = false;
  console.log('[FILA] Worker encerrado (fila vazia).');
}

function enfileirarEnvio(ofertaId, mensagem, grupoAlvo, dados, opts) {
  const destino = grupoAlvo || GRUPOS[GRUPO_DESTINO_PASSAGENS];
  const posicao = filaEnvio.length;
  // dados: snapshot de dadosExtraidos usado como fallback no registro de passagem
  // quando a oferta já saiu de filaPendentes (agendamentos de mais de 24h).
  // opts.fonte: 'alerta' (padrao) | 'emissao' — vai para passagens.json e define
  //   como a aba "Enviadas hoje" classifica a coluna Envio.
  // opts.registrar:false → o item ja foi registrado por quem chamou (emissao
  //   manual imediata registra client-side no gerador); evita linha duplicada.
  const o = opts || {};
  // opts.captura: 'coleta' quando a oferta nasceu da varredura seats.aero
  //   injetada em /injetar. Guardado aqui para o registro em passagens.json
  //   funcionar mesmo quando a oferta ja saiu de filaPendentes.
  filaEnvio.push({ ofertaId, mensagem, destino, dados: dados || null,
                   fonte: o.fonte || null,
                   captura: o.captura || null,
                   registrar: o.registrar === false ? false : true });
  console.log('[FILA] Oferta #' + ofertaId + ' enfileirada na posição ' + (posicao + 1));
  workerFila().catch(e => {
    console.error('[FILA] Worker encerrou com erro:', e.message);
    workerRodando = false;
  });
}

requeueAprovadas();

// Rede de seguranca: a cada 5 min devolve para a fila de envio qualquer oferta
// que esteja 'aprovado' sem estar enfileirada. Cobre restart do Railway no meio
// do caminho, worker encerrado por erro e auto-aprovacao que nao chegou a
// enfileirar. Idempotente (dedup por ofertaId), entao rodar de novo nao duplica.
setInterval(() => {
  try { requeueAprovadas('em varredura periódica'); }
  catch (e) { console.warn('[FILA] Varredura de aprovados falhou:', e.message); }
}, 5 * 60 * 1000);

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
  try { escreverAtomico(AGEND_PATH, JSON.stringify(agendamentos), 'utf-8'); } catch(e) {}
}

carregarAgendamentos();

// Envio de um agendamento simples. Existe separado do setInterval porque montar
// o link preview e assincrono (baixa a thumbnail) e o loop nao pode esperar.
// Falha ao montar o card nao cancela o envio: a mensagem sai sem preview.
async function despacharAgendamento(ag, grupoId) {
  // Tag de afiliado do destino, pelo mesmo motivo do envio imediato: agendamento
  // para um grupo com tag propria precisa sair com ela. Grupo fora do mapa
  // recebe a mensagem original. O caminho multi-grupo nao passa por aqui — ele
  // cai em enviarManualParaGrupos, que ja faz a troca destino a destino.
  const msg = comTagDoGrupo(ag.mensagem || '', grupoId);

  // Anexo agendado: os bytes viajam dentro do proprio agendamento (o painel
  // manda em base64), entao o disparo nao depende de nenhum arquivo em disco
  // nem de baixar nada na hora. Imagem vai com legenda; qualquer outro mime
  // vai como documento, mesma regra do envio imediato.
  if (ag.anexo && ag.anexo.base64) {
    const buffer = Buffer.from(String(ag.anexo.base64).replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (!buffer.length) throw new Error('Anexo do agendamento vazio ou base64 invalido.');
    const mt = String(ag.anexo.mimetype || '');
    if (!mt || mt.indexOf('image/') === 0) {
      const conteudo = { image: buffer, caption: msg };
      if (mt) conteudo.mimetype = mt;
      return enviarMensagem(grupoId, conteudo);
    }
    const conteudo = { document: buffer, mimetype: mt, fileName: ag.anexo.nomeArquivo || 'arquivo' };
    if (msg && msg.trim()) conteudo.caption = msg;
    return enviarMensagem(grupoId, conteudo);
  }

  let lp = null;
  if (ag.preview?.link) {
    try { lp = previewComTagDoGrupo(await montarLinkPreviewManual(ag.preview, msg), grupoId); }
    catch (e) { console.warn('[AGEND] Nao montou o preview de #' + ag.id + ':', e.message); }
  }
  return enviarMensagem(grupoId, lp ? { text: msg, linkPreview: lp } : { text: msg });
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
    mensagem:   ag.mensagem,
    tipo:       ag.tipo || null,
    imagem,
    preview:    ag.preview || null,
    categoria:  ag.categoria || null,
    trilhasIds: ag.trilhas || null,
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
      enfileirarEnvio(ag.ofertaId ?? ('ag-'+ag.id), ag.mensagem, grupoId, ag.dados || null,
                      { fonte: ag.fonteRegistro || null });
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
//
// TEMPORARIO (28/08/2026): ir.clubedoviajante.com.br NAO esta cadastrado como
// custom domain no Railway -- o plano permite 2 e os slots estao ocupados por
// grupo.tudosobrepromos.com e ir.ticapromos.com.br. Enquanto isso os links saem
// no dominio nativo do proxy: mesmos slugs, mesmo links.json, mesmos cliques em
// /ir-stats, mesmos params bo/bd/bi de busca. So perde a mascara. Quando
// grupo.tudosobrepromos.com for desligado, cadastre ir.clubedoviajante.com.br no
// Railway, ajuste o CNAME na Hostinger e reverta esta linha.
// ESPELHAR a reversao em gerador-cdv/index.html (IR_BASE), que tem a mesma const.
const IR_BASE = 'https://cdv-proxy-production.up.railway.app/ir/';
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

// ── DESCARTES SILENCIOSOS DO PIPELINE DE ALERTAS ─────────────────────────────
// Todo descarte daqui até a fila só existia como linha de log no Railway. Na
// prática isso significa que "esse alerta não foi pego" vira investigação: sem
// registro consultável não dá para distinguir mensagem que não chegou, extração
// que falhou e emissão que o filtro cortou de propósito.
//
// Ring buffer em memória, não arquivo: é material de diagnóstico das últimas
// horas, e persistir traria sync, crescimento e uma decisão de retenção que o
// caso não justifica. Reinício limpa, e tudo bem.
const DESCARTES_MAX = 200;
const _descartesCdv = [];

function registrarDescarteCdv({ jid, motivo, detalhe, dados, texto }) {
  const de = dados || {};
  _descartesCdv.unshift({
    em: new Date().toISOString(),
    jid: jid || null,
    grupo: (jid && NOMES_GRUPOS.get(jid)) || null,
    motivo,                                  // categoria curta, para filtrar
    detalhe: detalhe || '',                  // números que explicam a decisão
    origem: de.origem || de.origemCodigo || null,
    destino: de.destino || de.destinoCodigo || null,
    programa: de.programa || null,
    cabine: de.cabine || null,
    pontos: Number(de.pontos) || null,
    // Só o começo do texto: o suficiente para você reconhecer a mensagem no
    // grupo sem transformar o ring buffer num arquivo de conversas.
    trecho: String(texto || '').replace(/\s+/g, ' ').trim().slice(0, 220),
  });
  if (_descartesCdv.length > DESCARTES_MAX) _descartesCdv.length = DESCARTES_MAX;
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
    const det = pts.toLocaleString('pt-BR') + ' pts > limite ' + limite.toLocaleString('pt-BR')
      + ' (média ' + hist180.mediaPts.toLocaleString('pt-BR') + ' × ' + fator + ', '
      + hist180.count + ' amostra(s), ' + (nacional ? 'nacional' : 'internacional') + ')';
    console.log('[FILTRO-180D] Fora da curva: ' + det);
    // Guardado para quem chamou anexar ao registro do descarte: recalcular o
    // texto no chamador duplicaria a regra dos fatores em cinco lugares.
    precoForaDaCurva.ultimoDetalhe = det;
    return true;
  }
  return false;
}

// ── AUTO-ENVIO DE ALERTAS DE PASSAGEM ────────────────────────────────────────
// AUTO_ENVIO_ALERTA: 'off' (tudo vai para fila) | 'sombra' (avalia e loga o
// veredito, mas tudo vai para fila) | 'on' (dentro do teto → envia sem
// aprovação manual).
// Teto: média 180d × 1.10 em Econômica, × 1.05 em Executiva (mesma chave do
// hist180: origem|destino|programa|cabine|cia). Sem histórico (count < 1) ou
// acima do teto → fila de aprovação (fluxo atual). O filtro precoForaDaCurva
// continua rodando ANTES: muito acima da média nem chega aqui.
const AUTO_ENVIO_ALERTA_MODO = (process.env.AUTO_ENVIO_ALERTA || 'on').toLowerCase();

// GATE_ASSIMETRICO: 'off' (padrão — teto pela média cheia, como sempre) |
// 'sombra' (decide como hoje e só loga quando o critério novo divergiria) |
// 'on' (teto pela referência assimétrica calculada no proxy). Ver
// refGateAssimetrica() em painel-cdv/index.js para a regra de elegibilidade.
const GATE_ASSIMETRICO_MODO = (process.env.GATE_ASSIMETRICO || 'off').toLowerCase();

// ── PROCEDENCIA DA CAPTURA ───────────────────────────────────────────────────
// 'coleta' = achado da varredura seats.aero (Cowork) injetado em /injetar.
// Ausencia do campo = captura em grupo/canal monitorado (comportamento antigo).
// Existe porque as duas coisas saiam com o mesmo rotulo "Auto (grupo)" na aba
// Enviadas hoje do gerador, e o auto-envio da varredura nao passou por grupo
// nenhum — o tooltip afirmava algo falso sobre a origem da oferta.
const PREFIXO_INJECAO_COLETA = 'coleta_seats_';

function capturaDaOferta(oferta) {
  const g = String(oferta?.grupoOrigem || '');
  return g.startsWith(PREFIXO_INJECAO_COLETA) ? 'coleta' : null;
}

// Campo só conta como preenchido se tiver valor real: vazio, '?', '-', 'N/A',
// 'desconhecido(a)', 'não identificado(a)', 'indefinido(a)' etc. reprovam.
function campoAlertaValido(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return false;
  const n = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (/^[-?.]+$/.test(n)) return false;
  if (/desconhecid|nao identificad|nao informad|indefinid|indisponivel|^n\/?a$|^nd$|^null$|^undefined$/.test(n)) return false;
  return true;
}

function avaliarAutoEnvioAlerta(oferta, hist180) {
  const de  = oferta?.dadosExtraidos || {};
  const pts = Number(de.pontos) || 0;
  // Completude: auto-envio só com TODOS os campos identificados de fato —
  // origem, destino, cia, programa, pontos, cabine e datas de ida. Qualquer
  // campo vazio ou "desconhecido" derruba para a fila de aprovação.
  const obrigatorios = { origem: de.origem, destino: de.destino, cia: de.cia, programa: de.programa, cabine: de.cabine, datas: de.datasIda };
  const faltando = Object.keys(obrigatorios).filter(k => !campoAlertaValido(obrigatorios[k]));
  if (faltando.length) return { auto: false, motivo: 'campo(s) incompleto(s): ' + faltando.join(', ') };
  if (pts <= 0) return { auto: false, motivo: 'pontos inválidos' };
  if (!hist180 || !hist180.mediaPts || hist180.count < 1) return { auto: false, motivo: 'sem histórico' };
  const cab = String(de.cabine || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const tol  = cab === 'executiva' ? 0.05 : 0.10;
  // GATE_ASSIMETRICO=on usa a referência calculada pelo proxy (refGate), que
  // ignora no cálculo do teto os auto-envios que passaram só por estarem abaixo
  // do teto vigente. Sem o flag, ou sem refGate no payload, mantém a média
  // cheia — comportamento idêntico ao anterior.
  const usaGate = GATE_ASSIMETRICO_MODO === 'on' && hist180.refGate > 0;
  const ref     = usaGate ? hist180.refGate : hist180.mediaPts;
  const rotulo  = usaGate
    ? (hist180.baseGate === 'assimetrica' ? 'mediana elegível' : 'média')
    : 'média';
  const nRef  = usaGate ? (hist180.countGate || hist180.count) : hist180.count;
  const teto  = Math.round(ref * (1 + tol));
  const det   = pts.toLocaleString('pt-BR') + ' pts vs teto ' + teto.toLocaleString('pt-BR')
    + ' (' + rotulo + ' ' + ref.toLocaleString('pt-BR') + ' +' + Math.round(tol * 100) + '%, ' + nRef + ' reg(s))';
  const vered = pts <= teto ? { auto: true, motivo: det } : { auto: false, motivo: 'acima do teto — ' + det };

  // Modo sombra do gate: decide pelo critério ANTIGO e só registra no log
  // quando o novo teria decidido diferente. Serve para medir o impacto real
  // antes de ligar GATE_ASSIMETRICO=on, sem alterar nenhum envio.
  if (GATE_ASSIMETRICO_MODO === 'sombra' && hist180.refGate > 0) {
    const tetoNovo  = Math.round(hist180.refGate * (1 + tol));
    const autoNovo  = pts <= tetoNovo;
    if (autoNovo !== vered.auto) {
      console.log('[GATE-ASSIM][SOMBRA] divergência: ' + pts.toLocaleString('pt-BR') + ' pts — '
        + 'hoje ' + (vered.auto ? 'ENVIA' : 'FILA') + ' (teto ' + teto.toLocaleString('pt-BR') + ')'
        + ' / assimétrico ' + (autoNovo ? 'ENVIARIA' : 'FILA') + ' (teto ' + tetoNovo.toLocaleString('pt-BR')
        + ', base ' + (hist180.baseGate || '?') + ', ' + (hist180.countGate || 0) + ' elegíveis, '
        + (hist180.descartadosGate || 0) + ' descartado(s))');
    }
  }
  return vered;
}

// Ponto único de entrega de oferta de alerta de passagem. A oferta SEMPRE
// entra em filaPendentes (auditoria no painel, mesmo padrão do auto-envio de
// ofertas de marketplace). Com AUTO_ENVIO_ALERTA=on e veredito positivo, é
// marcada 'aprovado' e enfileirada — o worker envia e registra em
// passagens.json (único ponto de gravação definitiva), exatamente como na
// aprovação manual.
function entregarOfertaAlerta(oferta, hist180) {
  filaPendentes.unshift(oferta);
  try {
    if (!ehConteudoTsp(oferta.tipoConteudo) && AUTO_ENVIO_ALERTA_MODO !== 'off') {
      const v    = avaliarAutoEnvioAlerta(oferta, hist180);
      const de   = oferta.dadosExtraidos || {};
      const rota = (de.origem || '?') + '->' + (de.destino || '?') + ' ' + (de.programa || '') + '/' + (de.cabine || '');
      if (AUTO_ENVIO_ALERTA_MODO === 'sombra') {
        console.log('[AUTO-ALERTA][SOMBRA] ' + (v.auto ? 'ENVIARIA' : 'FILA') + ': ' + rota + ' — ' + v.motivo);
        // Persiste o motivo para o painel exibir por que o alerta caiu na fila
        oferta.motivoFila = v.auto ? 'modo sombra — seria enviado automaticamente (' + v.motivo + ')' : v.motivo;
      } else if (AUTO_ENVIO_ALERTA_MODO === 'on' && v.auto) {
        console.log('[AUTO-ALERTA] Envio automático: ' + rota + ' — ' + v.motivo);
        oferta.status = 'aprovado';
        oferta.autoEnviado = true;
        // mensagemFinal e o que requeueAprovadas() usa para recuperar a oferta
        // apos um restart. Sem gravar aqui, o auto-envio ficava dependente de a
        // filaEnvio (em memoria) sobreviver ate o disparo.
        oferta.mensagemFinal = oferta.mensagemFormatada;
        enfileirarEnvio(oferta.id, oferta.mensagemFormatada, null, oferta.dadosExtraidos || null,
                        { captura: capturaDaOferta(oferta) });
      } else if (AUTO_ENVIO_ALERTA_MODO === 'on') {
        console.log('[AUTO-ALERTA] Para aprovação: ' + rota + ' — ' + v.motivo);
        // Persiste o motivo para o painel exibir por que o alerta caiu na fila
        oferta.motivoFila = v.motivo;
      }
    } else if (!ehConteudoTsp(oferta.tipoConteudo) && AUTO_ENVIO_ALERTA_MODO === 'off') {
      oferta.motivoFila = 'auto-envio de alertas desativado (AUTO_ENVIO_ALERTA=off)';
    }
  } catch (e) {
    console.error('[AUTO-ALERTA] Falha na avaliação (oferta segue na fila):', e.message);
    oferta.motivoFila = 'falha na avaliação do auto-envio: ' + e.message;
  }
  salvarFila();
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
// Dinheiro na mensagem: inteiro sai sem casas, quebrado sai com virgula. Antes
// um minimo de 9.9 virava "R$ 9.9" no grupo — ponto decimal e duas casas
// faltando sao o tipo de detalhe que faz a mensagem parecer automatica.
function brlCupom(n) {
  const v = Number(n);
  if (!isFinite(v)) return String(n);
  const [inteiro, dec] = Number.isInteger(v) ? [String(v), null] : v.toFixed(2).split('.');
  const comMilhar = inteiro.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return dec ? comMilhar + ',' + dec : comMilhar;
}

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

  // Com teto de desconto, a compra "ideal" e aquela em que o percentual bate
  // exatamente no teto. Com teto de PRODUTO, o desconto maximo e simplesmente o
  // percentual sobre esse teto — sao contas diferentes e a mensagem tem de dizer
  // qual delas esta mostrando.
  // Teto UTIL do cupom: a partir dele o percentual ja bateu no limite e cada
  // real a mais compra desconto nenhum. E a conta que o cliente faz de cabeca
  // errado ("25% com limite de R$ 100" nao diz sozinho que a compra ideal e de
  // R$ 400), entao a mensagem faz por ele.
  const tetoUtil = (isPct && limite && Number(valor) > 0)
    ? (() => {
        const ideal = Math.ceil(100 * Number(limite) / Number(valor));
        return maximo ? Math.min(ideal, Number(maximo)) : ideal;
      })()
    : null;
  // Quanto o cliente economiza NA MELHOR HIPOTESE. "Limite de R$ 100 de
  // desconto" e "desconto de até R$ 100" dizem a mesma coisa para quem ja
  // entendeu que existe um teto — e nada para quem nao entendeu. Anunciar o par
  // (compra ideal, desconto maximo) e o que torna o teto visivel: um numero
  // explica o outro. Com teto de produto junto, o desconto alcancavel pode ser
  // MENOR que o limite bruto (25% com limite R$ 100 mas produto ate R$ 300 rende
  // R$ 75), e e esse numero — nao o limite do regulamento — que vai na mensagem.
  const descontoMax = (isPct && tetoUtil)
    ? Math.min(Number(limite), Math.floor(Number(tetoUtil) * Number(valor) / 100))
    : null;

  const partes = [];
  if (temMin) partes.push(`em compras acima de R$ ${brlCupom(minimo)}`);
  if (maximo) partes.push(`em produtos de até R$ ${brlCupom(maximo)}`);
  // Com teto util calculado, o "limite de R$ X de desconto" sai daqui: a frase
  // de teto (teto_str) ja informa o mesmo limite E a compra em que ele e
  // atingido. Mantido apenas quando nao ha teto calculavel.
  if (isPct && limite && !tetoUtil) partes.push(`com limite de R$ ${brlCupom(limite)} de desconto`);

  // "Sem valor minimo" e uma AFIRMACAO. So pode ser feita quando a fonte disse
  // que nao ha minimo. Quando ela apenas nao informou (caso comum nas ofertas
  // da rede), a mensagem manda conferir as condicoes em vez de prometer algo.
  const validade = partes.length
    ? 'Válido ' + partes.join(', ') + '.'
    : (dados.minimoDesconhecido
        ? 'Confira as condições de uso na página da loja.'
        : 'Válido sem valor mínimo de compra.');

  const teto_str = tetoUtil
    ? (descontoMax
        ? `Bom para compras de até R$ ${brlCupom(tetoUtil)} e desconto de até R$ ${brlCupom(descontoMax)}`
        : `Bom para compras de até R$ ${brlCupom(tetoUtil)}`)
    : '';

  let importante = '';
  if (tetoUtil) {
    importante = descontoMax
      ? `Ideal para compras de até R$ ${brlCupom(tetoUtil)} — desconto máximo de R$ ${brlCupom(descontoMax)}.`
      : `Ideal para compras de até R$ ${brlCupom(tetoUtil)}.`;
  } else if (isPct && maximo) {
    const economia = Math.floor(Number(maximo) * Number(valor) / 100);
    importante = `Só vale para produtos de até R$ ${brlCupom(maximo)} — economia máxima de R$ ${economia}.`;
  }

  // Versao enxuta das MESMAS condicoes, para a linha que fica embaixo do codigo
  // dentro de um lote. Numa lista de oito cupons a frase completa repetia
  // "Válido em compras acima de / com limite de / de desconto" oito vezes e
  // dobrava a altura da mensagem sem acrescentar informacao.
  const curtas = [];
  if (temMin) curtas.push(`Acima de R$ ${brlCupom(minimo)}`);
  if (maximo && !tetoUtil) curtas.push(`produtos até R$ ${brlCupom(maximo)}`);
  // Com teto calculado, ele entra no lugar do "limite de R$ X": os dois dizem a
  // mesma coisa e o teto e o que orienta a compra. Sem teto (cupom de valor
  // fixo em reais), o limite bruto e tudo o que ha para informar.
  if (tetoUtil) {
    curtas.push(`bom para compras de até R$ ${brlCupom(tetoUtil)}`);
    if (descontoMax) curtas.push(`desconto de até R$ ${brlCupom(descontoMax)}`);
  }
  else if (isPct && limite) curtas.push(`limite de R$ ${brlCupom(limite)}`);
  const condicao_curta = curtas.length
    ? curtas.join(' · ')
    : (dados.minimoDesconhecido ? 'Confira as condições na loja' : 'Sem valor mínimo');

  return {
    gatilho:    String(dados.gatilho || '').trim(),
    loja,
    loja_upper: loja.toUpperCase(),
    valor:      String(valor),
    valor_str:  `${valor}${tipoStr}`,
    validade,
    condicao_curta,
    teto_str,
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

// Teto de cupons por mensagem. Acima disso a lista vira duas mensagens: um
// bloco muito longo no WhatsApp e lido pela metade e as ultimas linhas somem
// atras do "Ler mais".
const CUPOM_LOTE_MAX = 8;

// Monta a mensagem UNICA de um lote de cupons da MESMA loja. Cada cupom e
// renderizado pelo template de item (que ja aplica toda a regra de validade e
// teto) e o resultado entra no envelope. O link e um so, da loja — repetir o
// link de afiliado linha a linha nao muda o destino e polui a mensagem.
// Campos do cupom individual (codigo, valor_str, validade) sao zerados de
// proposito no envelope: se sobrassem, um template editado poderia anunciar no
// cabecalho o dado de UM cupom como se valesse para todos.
// Assinatura das CONDICOES de um cupom (nao do desconto): dois cupons com a
// mesma assinatura sao aplicaveis exatamente nas mesmas compras, ainda que um
// desconte 25% e o outro 18%.
function assinaturaCondicaoCupom(c) {
  return [c.minimo ?? '', c.maximo ?? '', c.limite ?? ''].join('|');
}

// Assinatura que vale para a maior parte da mensagem. Exige pelo menos dois
// cupons: uma condicao que so um cupom tem nao e regra geral de nada, e subir
// ela para o cabecalho faria os outros parecerem seguir uma condicao alheia.
function condicaoComumDoLote(lista) {
  const cont = new Map();
  for (const c of lista) {
    const k = assinaturaCondicaoCupom(c);
    cont.set(k, (cont.get(k) || 0) + 1);
  }
  let melhor = null, n = 0;
  for (const [k, v] of cont) if (v > n) { melhor = k; n = v; }
  return n >= 2 ? melhor : null;
}

// Monta a mensagem UNICA de um lote de cupons da MESMA loja.
//
// A condicao que a maioria compartilha sobe para uma frase no cabecalho e cada
// cupom vira uma linha de codigo e desconto; quem foge dela declara a propria
// regra logo abaixo, com a seta que o cabecalho referencia. Repetir "acima de
// R$ 29, limite R$ 500" em oito linhas seguidas mais que dobrava a mensagem
// para nao dizer nada de novo.
//
// A frase do cabecalho muda conforme o caso: "Todos válidos ..." so pode ser
// dito quando NAO ha excecao na lista. Com excecao, vira ressalva — anunciar
// uma condicao que nao vale para parte dos cupons e o erro mais caro possivel
// numa mensagem de cupom.
//
// O link e um so, da loja: repetir o link de afiliado linha a linha nao muda o
// destino e polui a mensagem.
//
// Campos do cupom individual (codigo, valor_str, validade) sao zerados de
// proposito no envelope: se sobrassem, um template editado poderia anunciar no
// cabecalho o dado de UM cupom como se valesse para todos.
function formatarCupomLoteTSP(lista) {
  const comum = condicaoComumDoLote(lista);
  const corpoItem    = (templateCupomLoteItem()?.corpo || '').trim();
  const corpoExcecao = (templateCupomLoteItemExcecao()?.corpo || '').trim();

  const itens = lista
    .map(c => renderTemplate(
      (comum && assinaturaCondicaoCupom(c) === comum) ? corpoItem : corpoExcecao,
      varsDoCupomTSP(c)))
    .filter(t => t && t.trim())
    // Linha em branco entre um cupom e outro: colados, oito codigos viravam um
    // paredao onde nao dava para saber qual condicao pertencia a qual codigo.
    .join('\n\n');

  const refComum = comum ? lista.find(c => assinaturaCondicaoCupom(c) === comum) : null;
  const temExcecao = !!comum && lista.some(c => assinaturaCondicaoCupom(c) !== comum);
  const condicao_comum = refComum
    ? varsDoCupomTSP(refComum).validade
        .replace(/^Válido /, temExcecao ? 'Válidos ' : 'Todos válidos ')
        .replace(/\.$/, temExcecao ? ' — exceto onde indicado abaixo do código.' : '.')
    : '';

  const base = varsDoCupomTSP(lista[0]);
  const corpo = (templateCupomLote()?.corpo || '').trim();
  return renderTemplate(corpo, {
    ...base,
    codigo: '', valor_str: '', valor: '', validade: '', condicao_curta: '',
    teto_str: '', importante: '', aviso: '',
    minimo: '', maximo: '', limite: '',
    itens, condicao_comum,
    qtd: String(lista.length),
    codigos: lista.map(c => String(c.codigo || '').toUpperCase()).filter(Boolean).join(', '),
  });
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
        // Sem isto, uma conexao presa com a API prende o worker de classificacao
        // por ate ~5min (default do undici). 45s corta e a proxima tentativa assume.
        signal: AbortSignal.timeout(45000),
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
// Modo do cupom: 'off' (tudo vai para fila) | 'sombra' (avalia e loga, mas
// continua indo para fila) | 'on' (envia direto quando passa em todos os gates).
// Definido na aba Configuracoes -> Negocio; a env AUTO_ENVIO_CUPOM so vale
// enquanto a config estiver vazia (default 'sombra').
// LIDO A CADA DECISAO (nunca congelado numa const de boot): a fonte da verdade
// e a config do painel (aba Configuracoes -> Negocio), com a env do Railway
// valendo so como fallback de quem nunca salvou nada na tela. Como const, o
// valor era fixado no boot e salvar no painel nao tinha efeito nenhum.
function autoEnvioModo()       { return modoAutoEnvioCupom(); }
// Ofertas de marketplace (Amazon/Shopee/ML/Magalu). Diferente dos cupons, aqui
// nao ha modo 'sombra': ou vai direto, ou vai para a fila.
function autoEnvioModoOferta() { return modoAutoEnvioOferta(); }
// Retrato para o painel: o modo que esta valendo agora e se ele veio da tela
// ou ainda da env do Railway.
function autoEnvioEstado(tenantId) {
  return {
    cupom:  modoAutoEnvioCupom(tenantId),
    oferta: modoAutoEnvioOferta(tenantId),
    origem: origemAutoEnvio(tenantId),
  };
}
// Intervalo minimo entre auto-envios. Vem da janela de cupons (aba Cupons do
// painel) para o operador ajustar o ritmo sem redeploy.
function intervaloAutoEnvioMs() { return (janelaCupom().intervaloSeg ?? 90) * 1000; }
const AUTO_ENVIO_TEXTO_MIN  = 20;        // texto curto demais = info provavelmente na imagem
const AUTO_ENVIO_MAX_ESPERA = 30 * 60 * 1000; // agendado ha mais que isso = cupom provavelmente vencido, vira aprovacao manual
const ENVIANDO_TRAVADO_MS   = 5 * 60 * 1000;  // preso em 'enviando' por mais que isso = envio pendurado, nao envio em curso
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
// Gate TEMPORAL isolado: janela de publicacao e intervalo minimo entre envios.
// Vive separado porque numa mensagem com varios cupons ele e do LOTE, nao do
// item — avaliado por cupom, so o primeiro passaria e o agrupamento nasceria
// com uma unica linha, que e exatamente o que ele existe para evitar.
function avaliarTemporalAutoEnvio() {
  const janela = dentroDaJanelaCupom();
  if (!janela.ok) return { auto:false, motivo: janela.motivo };
  const intervalo = intervaloAutoEnvioMs();
  const desde = Date.now() - _ultimoAutoEnvio;
  if (desde < intervalo)
    return { auto:false, motivo:`intervalo minimo (faltam ${Math.ceil((intervalo-desde)/1000)}s)` };
  return { auto:true, motivo:'aprovado' };
}

function avaliarAutoEnvio(cupom, textoOriginal, tinhaMultiplos, codigosIrmaos = [], opcoes = {}) {
  let t = textoOriginal || '';

  if (autoEnvioModo() === 'off')          return { auto:false, motivo:'modo off' };
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

  // Janela de publicacao (nada de cupom as 3h) e anti-flood. Quem monta lote
  // pede para pular esta parte e avalia uma vez so para a mensagem inteira.
  if (!opcoes.ignorarTemporal) {
    const temporal = avaliarTemporalAutoEnvio();
    if (!temporal.auto) return temporal;
  }

  return { auto:true, motivo:'aprovado' };
}

// ── SENTINELA: leitora secundaria surda ─────────────────────────────────────
// O watchdog principal so enxerga _health.ultimoUpsertEm, que e da principal.
// Uma leitora secundaria pode parar de receber sem que nada dispare: os grupos
// dela ficam cegos e a operacao inteira parece saudavel. Esta sentinela existe
// exatamente para esse buraco.
//
// Nao escala para restart: derrubar o processo por causa de uma secundaria
// tiraria a principal do ar junto. Reconecta a conta (degrau 1) e alerta —
// a decisao de trocar a leitora volta a ser de quem opera.
const LEITOR_SILENCIO_MS   = 6 * 3600e3;   // 6h sem inbound
const LEITOR_CHECAGEM_MS   = 30 * 60e3;
setInterval(async () => {
  const hora = horaSP();
  // Fora de 8h-22h SP o silencio e esperado: alertar de madrugada so ensina a
  // ignorar alerta.
  if (hora < 8 || hora >= 22) return;
  const agora = Date.now();
  for (const id of contasLeitorasAtivas()) {
    if (id === 'principal') continue;
    const ct = contasExtras.get(id);
    const apelido = apelidoDaConta(id);
    const grupos = (contaLeitoraCdv() && _idDaConta(contaLeitoraCdv()) === id) ? 'do CDV' : 'do radar';

    if (!ct || !ct.conectado) {
      await registrarAlerta({
        nivel: 'critico', origem: 'whatsapp', chave: 'leitor-caido:' + apelido,
        titulo: 'Conta leitora "' + apelido + '" desconectada',
        corpo: 'A conta que le os grupos ' + grupos + ' esta fora do ar. A principal '
             + 'assumiu a leitura, entao nada foi perdido — mas os dois conjuntos voltaram '
             + 'a ser lidos pelo mesmo numero. Pareie o QR de "' + apelido + '" para restaurar a separacao.',
      });
      if (ct && !ct.conectando) conectarConta(id).catch(() => {});
      continue;
    }

    const ultimo = _pulsoLeitores.get(id) || _bootEm;
    const silencio = agora - ultimo;
    if (silencio < LEITOR_SILENCIO_MS) continue;
    const horas = Math.round(silencio / 3600e3);
    await registrarAlerta({
      nivel: 'critico', origem: 'whatsapp', chave: 'leitor-surdo:' + apelido,
      titulo: 'Conta leitora "' + apelido + '" sem receber ha ' + horas + 'h',
      corpo: 'A conta esta conectada mas nao recebe mensagem ha ' + horas + 'h em horario '
           + 'comercial. Os grupos ' + grupos + ' podem estar cegos: a principal NAO assume '
           + 'enquanto a conta se declara conectada. Confira se o numero continua nos grupos '
           + 'e, se preciso, aponte a leitura de volta para a principal na aba Config.',
    });
    // Aviso tambem no canal do CDV quando a leitora surda e a dele: o alerta
    // padrao vai para o grupo do operador do TSP, que e outro publico.
    if (contaLeitoraCdv() && _idDaConta(contaLeitoraCdv()) === id) {
      avisarAdminsCdv('⚠️ CDV — o número que lê os grupos de passagem ("' + apelido
        + '") está há ' + horas + 'h sem receber nada. Os alertas de milhas podem não estar chegando.')
        .catch(() => {});
    }
  }
}, LEITOR_CHECAGEM_MS);

// ── SENTINELA: grupo so-admins sem a conta do turno como admin ───────────────
// O WhatsApp descarta EM SILENCIO mensagem de nao-admin em grupo "somente
// admins": o sendMessage nao lanca erro, entao nem o fallback pela principal
// nem o alerta de "cupom nao entregue" disparam — o grupo fica seco e o
// servidor acredita que entregou (foi exatamente o que aconteceu com o
// SO CUPONS #11). Esta checagem roda ANTES do despacho e avisa o operador.
// Nunca bloqueia o envio: metadados indisponiveis ou grupo aberto seguem o
// fluxo normal. Throttle de 30 min por grupo para nao inundar o operador.
const _alertaAdminCache = new Map();   // jid -> ts do ultimo alerta
const ALERTA_ADMIN_INTERVALO_MS = 30 * 60 * 1000;

function _idsDaContaSock(s) {
  const ids = new Set();
  for (const v of [s?.user?.id, s?.user?.lid]) {
    const n = String(v || '').split(':')[0].split('@')[0].trim();
    if (n) ids.add(n);
  }
  return ids;
}

async function verificarAdminGruposCupons() {
  const grupos = GRUPOS['tsp_cupons'] || [];
  if (!grupos.length) return;
  for (const jid of grupos) {
    // Com numero fixo por grupo, quem precisa ser admin muda de grupo para
    // grupo: checar uma conta so daria falso negativo em metade da lista.
    const contaId = contaDoGrupo(jid);
    const s = (contaId && contaId !== 'principal')
      ? contasExtras.get(contaId)?.sock
      : sock;
    if (!s) continue;
    const meus = _idsDaContaSock(s);
    try {
      const md = await s.groupMetadata(jid);
      if (!md?.announce) continue;   // grupo aberto: qualquer membro posta
      const eu = (md.participants || []).find(p =>
        _ggIdsDoParticipante(p).some(n => meus.has(n)));
      if (eu && eu.admin) continue;
      const agora = Date.now();
      if (agora - (_alertaAdminCache.get(jid) || 0) < ALERTA_ADMIN_INTERVALO_MS) continue;
      _alertaAdminCache.set(jid, agora);
      const nome = NOMES_GRUPOS.get(jid) || md.subject || jid;
      console.warn('[CUPONS] Grupo "' + nome + '" em modo so-admins e conta '
        + (contaId || 'principal') + ' sem admin — o WhatsApp vai descartar o envio.');
      try {
        await enviarMensagem(GRUPOS.operador, { text:
          '*Cupom pode nao chegar em "' + nome + '"* \u26a0\ufe0f\n\n'
          + 'O grupo esta em modo *somente admins* e a conta do turno ('
          + (contaId || 'principal') + ') NAO e admin dele. O WhatsApp descarta a '
          + 'mensagem sem acusar erro — o cupom sai nos outros grupos, mas nesse nao.\n\n'
          + 'Promova o numero a admin do grupo para resolver.' });
      } catch(_) {}
    } catch (e) {
      // Checagem nunca pode impedir o despacho: metadados fora do ar, so loga.
      console.warn('[CUPONS] Nao deu para checar admin em ' + jid + ': ' + e.message);
    }
  }
}

// Envia um cupom para TODOS os grupos de destino configurados (radarDestinos)
// mais os grupos so-cupons. Todos recebem exatamente a mesma mensagem — a
// regra do rodape de convite cruzado foi removida. Falha isolada em um grupo
// NAO derruba os outros: loga, segue para o proximo e avisa o operador ao final.
// `oferta` e opcional e serve so ao rastro de entrega: com ela, cada grupo que
// recebe fica gravado em disco na hora (oferta.enviadosParciais). Distribuir
// para todos os grupos leva cerca de um minuto — se o processo cair no meio, e
// esse rastro que permite retomar sem mandar o mesmo cupom duas vezes para quem
// ja recebeu.
async function enviarCupomParaGrupos(mensagem, imagem, oferta) {
  // A conta e decidida POR GRUPO (contaDoGrupo): grupo com numero atribuido sai
  // sempre pelo mesmo remetente, e o resto segue o turno. O que nao pode variar
  // e o remetente DENTRO de um grupo — entre grupos diferentes, variar e o
  // proprio objetivo de dividir a carga.
  const _execId = oferta?.id ? String(oferta.id) : ('c_' + Date.now());
  // Sentinela do modo so-admins: detecta o descarte silencioso antes do despacho.
  await verificarAdminGruposCupons();
  // Cupom e de LOJA, nao de produto: nao tem categoria para casar com nicho.
  // Vai para os destinos gerais mais os so-cupons — mandar cupom generico no
  // grupo de bebidas descaracterizaria o nicho.
  const destinos = destinosGerais();
  const soCupons = GRUPOS['tsp_cupons'];
  const alvos = [...new Set([...destinos, ...soCupons])];
  const jaRecebeu = new Set(Array.isArray(oferta?.enviadosParciais) ? oferta.enviadosParciais : []);
  const enviados = [], falhas = [], pulados = [];

  for (const jid of alvos) {
    if (jaRecebeu.has(jid)) { pulados.push(jid); continue; }
    const op = { conta: contaDoGrupo(jid) };
    // Rodape extra por grupo: cupom nao tem categoria, entao so casam regras
    // sem filtro de categoria. Sem regra aplicavel, `texto` e a mensagem original.
    // Tag de afiliado do destino: grupo com tag propria recebe o link com ela,
    // os demais seguem com a tag do pool. Sem grupo no mapa, `texto` e a
    // mensagem original, byte a byte.
    const texto = comTagDoGrupo(comRodapeExtra(mensagem, { jid, tipo: 'cupom' }), jid);
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
      // Grava o progresso a cada grupo, nao no fim: o valor do rastro esta
      // justamente em sobreviver a uma queda no meio da distribuicao.
      if (oferta) {
        oferta.enviadosParciais = [...jaRecebeu, ...enviados];
        salvarFila();
      }
      // Espacamento entre grupos: mesmo padrao das ofertas do radar, evita
      // rajada identica em varios grupos no mesmo segundo.
      if (alvos.length > 1) await new Promise(r => setTimeout(r, msEntreGrupos()));
    } catch(e) {
      console.error('[CUPONS] Falha ao enviar em ' + jid + ':', e.message);
      falhas.push({ jid, erro: e.message });
      outboxEnfileirar({ id: _execId, jid, texto, conta: op.conta, origem: 'cupom', erro: e.message });
    }
  }

  // Reenvio em que todos os grupos ja tinham recebido nao e falha: nao ha o que
  // mandar, e o item deve seguir para 'enviado' normalmente.
  if (!enviados.length && !pulados.length) throw new Error('Nenhum grupo recebeu o cupom.');
  if (falhas.length) {
    try {
      await enviarMensagem(GRUPOS.operador, { text: '*Cupom nao entregue em ' + falhas.length + ' grupo(s)* \u26a0\ufe0f\n\n'
        + falhas.map(f => (NOMES_GRUPOS.get(f.jid) || f.jid) + ': ' + f.erro).join('\n') });
    } catch(_) {}
  }
  if (enviados.length) _despachoContar();
  return { enviados, falhas, pulados };
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
// LIMITE DA MINIATURA. O jpegThumbnail viaja INLINE no protobuf da mensagem, e
// o WhatsApp descarta o campo quando ele passa de ~64KB — junto com o card
// inteiro, nao so a foto. O teto estava em 100KB, o que deixava passar imagem
// grande demais: a oferta saia sem preview nenhum e sem erro nenhum no log.
// 60KB fica com folga abaixo do ponto de corte observado.
const THUMB_MAX_BYTES = 60 * 1024;

// ── MARCA D'AGUA NAS IMAGENS ─────────────────────────────────────────────────
// Faixa com o @ do canal no rodape de toda imagem que sai para grupo do TSP —
// tanto a foto enviada como imagem quanto a miniatura do card de link.
//
// Motivo: rodape de TEXTO o concorrente apaga em dois segundos; pixel nao. Se
// ele encaminhar a nossa mensagem, a marca aparece no grupo dele.
// O que isso NAO faz: nao existe punicao do WhatsApp por repostar imagem
// marcada. O efeito e so a atribuicao ficar visivel.
//
// O texto e desenhado como PATH vetorial, nao como <text>: renderizar texto em
// SVG depende de fontconfig e de fonte instalada no container, que o Railway
// nao garante — sem fonte o <text> sai INVISIVEL e ninguem percebe. O path sai
// identico em qualquer maquina. Gerado da DejaVu Sans Bold, caixa alta; para trocar o
// texto e preciso gerar outro path, nao basta mudar a string.
//
// sharp entra por import dinamico e falha em silencio: se o binario nativo nao
// subir no deploy, a imagem sai sem marca em vez de o envio inteiro quebrar.
const MARCA_ATIVA = String(process.env.MARCA_DAGUA ?? '1') !== '0';
const MARCA_BOX   = { x: 135, y: -1520, w: 17083, h: 1876 };  // caixa do path, em unidades da fonte
const MARCA_PATH  = 'M831 -539Q831 -416 883.5 -345.0Q936 -274 1026 -274Q1115 -274 1168.0 -345.5Q1221 -417 1221 -539Q1221 -660 1167.5 -730.5Q1114 -801 1024 -801Q936 -801 883.5 -730.5Q831 -660 831 -539ZM1241 -238Q1211 -167 1144.5 -127.5Q1078 -88 989 -88Q817 -88 709.5 -212.5Q602 -337 602 -537Q602 -737 710.0 -862.0Q818 -987 989 -987Q1078 -987 1144.5 -947.0Q1211 -907 1241 -836V-967H1450V-274Q1574 -293 1645.0 -393.5Q1716 -494 1716 -651Q1716 -751 1687.0 -838.5Q1658 -926 1599 -999Q1504 -1121 1361.5 -1187.0Q1219 -1253 1053 -1253Q937 -1253 831.0 -1222.5Q725 -1192 635 -1133Q487 -1035 404.5 -879.5Q322 -724 322 -543Q322 -394 375.5 -263.5Q429 -133 530 -33Q630 65 759.5 116.5Q889 168 1036 168Q1162 168 1288.0 121.0Q1414 74 1503 -6L1610 156Q1485 253 1337.5 304.5Q1190 356 1038 356Q853 356 689.0 290.5Q525 225 397 100Q269 -25 202.0 -189.5Q135 -354 135 -543Q135 -725 203.0 -890.0Q271 -1055 397 -1180Q523 -1304 690.5 -1372.0Q858 -1440 1038 -1440Q1262 -1440 1445.0 -1354.5Q1628 -1269 1751 -1108Q1826 -1010 1864.5 -895.5Q1903 -781 1903 -655Q1903 -384 1740.0 -234.0Q1577 -84 1280 -84H1241Z M2058 -1493H3434V-1202H2939V0H2554V-1202H2058Z M3633 -1493H4018V0H3633Z M5579 -82Q5473 -27 5358.0 1.0Q5243 29 5118 29Q4745 29 4527.0 -179.5Q4309 -388 4309 -745Q4309 -1103 4527.0 -1311.5Q4745 -1520 5118 -1520Q5243 -1520 5358.0 -1492.0Q5473 -1464 5579 -1409V-1100Q5472 -1173 5368.0 -1207.0Q5264 -1241 5149 -1241Q4943 -1241 4825.0 -1109.0Q4707 -977 4707 -745Q4707 -514 4825.0 -382.0Q4943 -250 5149 -250Q5264 -250 5368.0 -284.0Q5472 -318 5579 -391Z M6804 -272H6202L6107 0H5720L6273 -1493H6732L7285 0H6898ZM6298 -549H6707L6503 -1143Z M7483 -1493H8122Q8407 -1493 8559.5 -1366.5Q8712 -1240 8712 -1006Q8712 -771 8559.5 -644.5Q8407 -518 8122 -518H7868V0H7483ZM7868 -1214V-797H8081Q8193 -797 8254.0 -851.5Q8315 -906 8315 -1006Q8315 -1106 8254.0 -1160.0Q8193 -1214 8081 -1214Z M9531 -831Q9652 -831 9704.5 -876.0Q9757 -921 9757 -1024Q9757 -1126 9704.5 -1170.0Q9652 -1214 9531 -1214H9369V-831ZM9369 -565V0H8984V-1493H9572Q9867 -1493 10004.5 -1394.0Q10142 -1295 10142 -1081Q10142 -933 10070.5 -838.0Q9999 -743 9855 -698Q9934 -680 9996.5 -616.5Q10059 -553 10123 -424L10332 0H9922L9740 -371Q9685 -483 9628.5 -524.0Q9572 -565 9478 -565Z M11243 -1241Q11067 -1241 10970.0 -1111.0Q10873 -981 10873 -745Q10873 -510 10970.0 -380.0Q11067 -250 11243 -250Q11420 -250 11517.0 -380.0Q11614 -510 11614 -745Q11614 -981 11517.0 -1111.0Q11420 -1241 11243 -1241ZM11243 -1520Q11603 -1520 11807.0 -1314.0Q12011 -1108 12011 -745Q12011 -383 11807.0 -177.0Q11603 29 11243 29Q10884 29 10679.5 -177.0Q10475 -383 10475 -745Q10475 -1108 10679.5 -1314.0Q10884 -1520 11243 -1520Z M12302 -1493H12792L13132 -694L13474 -1493H13963V0H13599V-1092L13255 -287H13011L12667 -1092V0H12302Z M15022 -1241Q14846 -1241 14749.0 -1111.0Q14652 -981 14652 -745Q14652 -510 14749.0 -380.0Q14846 -250 15022 -250Q15199 -250 15296.0 -380.0Q15393 -510 15393 -745Q15393 -981 15296.0 -1111.0Q15199 -1241 15022 -1241ZM15022 -1520Q15382 -1520 15586.0 -1314.0Q15790 -1108 15790 -745Q15790 -383 15586.0 -177.0Q15382 29 15022 29Q14663 29 14458.5 -177.0Q14254 -383 14254 -745Q14254 -1108 14458.5 -1314.0Q14663 -1520 15022 -1520Z M17120 -1446V-1130Q16997 -1185 16880.0 -1213.0Q16763 -1241 16659 -1241Q16521 -1241 16455.0 -1203.0Q16389 -1165 16389 -1085Q16389 -1025 16433.5 -991.5Q16478 -958 16595 -934L16759 -901Q17008 -851 17113.0 -749.0Q17218 -647 17218 -459Q17218 -212 17071.5 -91.5Q16925 29 16624 29Q16482 29 16339.0 2.0Q16196 -25 16053 -78V-403Q16196 -327 16329.5 -288.5Q16463 -250 16587 -250Q16713 -250 16780.0 -292.0Q16847 -334 16847 -412Q16847 -482 16801.5 -520.0Q16756 -558 16620 -588L16471 -621Q16247 -669 16143.5 -774.0Q16040 -879 16040 -1057Q16040 -1280 16184.0 -1400.0Q16328 -1520 16598 -1520Q16721 -1520 16851.0 -1501.5Q16981 -1483 17120 -1446Z';
// Grupos do CDV ficam de fora: outra operacao, outro @. Redundante com a
// allowlist de ehGrupoTsp — e de proposito: se um grupo do CDV for cadastrado
// por engano como destino de trilha, este bloqueio ainda segura.
// (era um Set montado no boot; virou ehGrupoCdv(), lido a cada envio)

/**
 * O destino e grupo do Tica Promos? ALLOWLIST, nao lista de excecoes: so leva
 * marca o que esta declarado como grupo do TSP (destino de trilha, grupo de
 * cupom ou o grupo do operador). Tudo o mais — CDV, concierge, conversa avulsa,
 * grupo passado por JID direto no /enviar-imagem — sai limpo.
 *
 * A diferenca importa: com lista de excecoes, todo grupo novo do CDV nasceria
 * marcado ate alguem lembrar de adiciona-lo. Aqui, grupo novo nasce sem marca,
 * e so ganha a faixa quando for cadastrado no painel como destino do TSP.
 */
function ehGrupoTsp(jid) {
  if (!jid || !jid.endsWith('@g.us')) return false;
  try {
    if (grupoOperadorTsp() === jid) return true;
    if ((gruposTspCupons() || []).includes(jid)) return true;
    if ((radarDestinos() || []).includes(jid)) return true;    // retrato das trilhas
    // Leitura direta das trilhas: cobre destino de nicho que ainda nao entrou
    // no retrato de papeis (trilha recem-criada, antes da sincronizacao).
    if (trilhas().some(t => (t.destinos || []).includes(jid))) return true;
  } catch (e) {
    console.warn('[MARCA] Nao consegui classificar o grupo ' + jid + ':', e.message);
  }
  return false;   // duvida nao marca
}

let _sharp = null, _sharpTentado = false;
async function carregarSharp() {
  if (_sharpTentado) return _sharp;
  _sharpTentado = true;
  try { _sharp = (await import('sharp')).default; console.log('[MARCA] sharp carregado — marca d\'agua ativa.'); }
  catch (e) { console.warn('[MARCA] sharp indisponivel (' + e.message + ') — imagens saem sem marca.'); _sharp = null; }
  return _sharp;
}

// Aquecimento no boot: carrega o binario nativo agora, com o log visivel na
// subida, em vez de descobrir no primeiro envio que ele nao esta la.
if (MARCA_ATIVA) carregarSharp();

function svgFaixaMarca(largura, faixaH) {
  const alturaTexto = Math.round(faixaH * 0.50);
  // Duas travas: a altura desejada e 88% da largura da imagem. A segunda existe
  // para foto larga e baixa (banner 16:9), onde a altura sozinha deixaria o
  // texto encostando nas bordas.
  const s  = Math.min(alturaTexto / MARCA_BOX.h, (largura * 0.88) / MARCA_BOX.w);
  const tx = (largura - MARCA_BOX.w * s) / 2 - MARCA_BOX.x * s;
  const ty = faixaH / 2 + (MARCA_BOX.h * s) / 2 - (MARCA_BOX.y + MARCA_BOX.h) * s;
  return Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + largura + '" height="' + faixaH + '">' +
    '<rect width="100%" height="100%" fill="#0b0d12" fill-opacity="0.85"/>' +
    '<g transform="translate(' + tx.toFixed(2) + ',' + ty.toFixed(2) + ') scale(' + s.toFixed(6) + ')">' +
    '<path d="' + MARCA_PATH + '" fill="#ffffff"/></g></svg>'
  );
}

/**
 * Devolve a imagem com a faixa no rodape. Nunca lanca: qualquer problema
 * devolve o buffer original — imagem sem marca e um contratempo, envio
 * quebrado e um incidente.
 * `maxBytes` existe para a miniatura do card: acima do teto o WhatsApp descarta
 * o preview INTEIRO, entao se a versao marcada nao couber nem na menor
 * qualidade, volta a original sem marca.
 */
async function marcarImagem(buffer, opcoes = {}) {
  const { maxBytes = 0, larguraMax = 0, rotulo = 'imagem' } = opcoes;
  if (!MARCA_ATIVA || !Buffer.isBuffer(buffer) || !buffer.length) return buffer;
  const sh = await carregarSharp();
  if (!sh) return buffer;
  try {
    // rotate() sem argumento aplica a orientacao do EXIF: sem isso a faixa
    // pode acabar na lateral de foto tirada com o celular deitado.
    let base = sh(buffer, { failOn: 'none' }).rotate();
    const meta = await base.metadata();
    let w = meta.width, h = meta.height;
    if (!w || !h) return buffer;
    if (larguraMax && w > larguraMax) {
      base = base.resize({ width: larguraMax });
      h = Math.round(h * (larguraMax / w));
      w = larguraMax;
    }
    const corpo  = await base.toBuffer();           // ja rotacionado e redimensionado
    const faixaH = Math.max(20, Math.round(h * 0.13));
    const svg    = svgFaixaMarca(w, faixaH);
    for (const q of [85, 72, 58, 45]) {
      const saida = await sh(corpo)
        .composite([{ input: svg, gravity: 'south' }])
        .jpeg({ quality: q })
        .toBuffer();
      if (!maxBytes || saida.length <= maxBytes) return saida;
    }
    console.log('[MARCA] ' + rotulo + ': versao marcada nao coube em '
      + Math.round(maxBytes / 1024) + 'KB — segue sem marca.');
    return buffer;
  } catch (e) {
    console.warn('[MARCA] ' + rotulo + ': falhou (' + e.message + ') — segue sem marca.');
    return buffer;
  }
}

/**
 * Passagem unica antes do envio. Fica aqui, e nao em cada rotina que monta
 * imagem, porque TODO caminho (cupom, manual, agendamento, radar) desemboca em
 * enviarMensagem — marcar em cinco lugares seria cinco lugares para esquecer.
 * So passa pela marca o que vai para grupo declarado do Tica Promos: conversa
 * 1-a-1 (campanhas, concierge), grupos do CDV e qualquer grupo nao cadastrado
 * seguem byte a byte como chegaram.
 */
async function conteudoComMarca(destino, conteudo) {
  try {
    if (!MARCA_ATIVA || !conteudo) return conteudo;
    // Operador hospedado tem o @ dele, nao o nosso.
    if ((tenantContexto() || TENANT_PADRAO) !== TENANT_PADRAO) return conteudo;
    const jid = String(destino || '');
    if (ehGrupoCdv(jid) || !ehGrupoTsp(jid)) return conteudo;

    let saida = conteudo, mudou = false;
    if (Buffer.isBuffer(conteudo.image)) {
      const m = await marcarImagem(conteudo.image, { rotulo: 'imagem ' + jid });
      if (m !== conteudo.image) { saida = { ...saida, image: m, mimetype: 'image/jpeg' }; mudou = true; }
    }
    const thumb = conteudo.linkPreview && conteudo.linkPreview.jpegThumbnail;
    if (Buffer.isBuffer(thumb)) {
      const m = await marcarImagem(thumb, { maxBytes: THUMB_MAX_BYTES, larguraMax: 500, rotulo: 'card ' + jid });
      if (m !== thumb) {
        saida = { ...saida, linkPreview: { ...conteudo.linkPreview, jpegThumbnail: m } };
        mudou = true;
      }
    }
    return mudou ? saida : conteudo;
  } catch (e) {
    console.warn('[MARCA] Nao marcou o envio para ' + destino + ':', e.message);
    return conteudo;
  }
}

function ehJpegBuffer(buf) {
  return !!buf && buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
}

/**
 * Versoes menores da MESMA imagem no CDN da loja. Em vez de simplesmente
 * desistir da foto quando a original estoura o limite, pedimos ao proprio CDN
 * uma variante reduzida — sem redimensionar nada aqui dentro e sem dependencia
 * nova. Se nenhuma couber, o preview vai sem foto (card simples), que ainda e
 * melhor que mensagem sem card.
 */
function variantesMiniatura(url) {
  const u = String(url || '');
  if (!u) return [];
  const lista = [];
  if (/mlstatic\.com/i.test(u)) {
    // Mercado Livre: o sufixo antes da extensao e o tamanho (-O grande, -V/-I/-S menores).
    const base = u.replace(/\.webp(\?|$)/i, '.jpg$1').replace(/D_NQ_NP_2X_/i, 'D_NQ_NP_');
    for (const s of ['-V', '-I', '-S', '-N']) {
      lista.push(base.replace(/-[A-Z]\.jpg/i, s + '.jpg'));
    }
  } else if (/media-amazon\.com|images-amazon\.com/i.test(u)) {
    // Amazon: os modificadores entre pontos controlam o lado maior da imagem.
    const limpo = u.replace(/\._[^.]+_\./, '.');
    for (const s of ['_SL400_', '_SL300_', '_SL200_']) {
      lista.push(limpo.replace(/\.(jpg|jpeg|png)(\?|$)/i, '.' + s + '.$1$2'));
    }
  } else if (/shopee|susercontent\.com/i.test(u)) {
    lista.push(u.replace(/(\?.*)?$/, '_tn'));
  }
  return [...new Set(lista.filter(x => x && x !== u))];
}

/**
 * Miniatura pronta para o preview, ja dentro do limite. Ordem: o que veio na
 * captura (sem rede) -> variantes menores do CDN -> nenhuma.
 */
async function miniaturaDoPreview(imagemBase64, imagemUrl, rotulo, reservaBase64 = null) {
  if (imagemBase64) {
    const buf = Buffer.from(imagemBase64, 'base64');
    // Precisa ser JPEG de verdade: um buffer webp (padrao do Mercado Livre)
    // rotulado como jpegThumbnail faz o cliente descartar o card inteiro.
    if (!ehJpegBuffer(buf)) {
      console.log('[PREVIEW] ' + rotulo + ': miniatura nao e JPEG — tentando variante do CDN.');
    } else if (buf.length <= THUMB_MAX_BYTES) {
      return buf;
    } else {
      console.log('[PREVIEW] ' + rotulo + ': miniatura de ' + Math.round(buf.length / 1024)
        + 'KB acima do limite de ' + Math.round(THUMB_MAX_BYTES / 1024) + 'KB — buscando variante menor.');
    }
  }
  for (const alvo of variantesMiniatura(imagemUrl)) {
    try {
      const res = await fetch(alvo, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (!ehJpegBuffer(buf) || buf.length > THUMB_MAX_BYTES) continue;
      console.log('[PREVIEW] ' + rotulo + ': usando variante de ' + Math.round(buf.length / 1024) + 'KB.');
      return buf;
    } catch (e) { /* variante indisponivel: tenta a proxima */ }
  }
  // Ultimo recurso: a miniatura que o PROPRIO post do grupo-fonte trazia no
  // card. Vale quando a pagina do produto esta sob antibot e a API oficial nao
  // devolve foto (catalogo unificado MLBU: /products/{MLBU} e 403 e /items de
  // terceiro tambem) — sem isso a oferta sai sem card nenhum. E a foto do CDN
  // da propria loja, ja em JPEG e ja pequena, nao imagem editada por terceiro.
  if (reservaBase64) {
    const buf = Buffer.from(reservaBase64, 'base64');
    if (ehJpegBuffer(buf) && buf.length <= THUMB_MAX_BYTES) {
      console.log('[PREVIEW] ' + rotulo + ': usando a miniatura do post de origem ('
        + Math.round(buf.length / 1024) + 'KB).');
      return buf;
    }
  }
  console.log('[PREVIEW] ' + rotulo + ': nenhuma miniatura coube — card vai sem foto.');
  return null;
}

// O rastreio troca a marcacao de afiliado na hora de montar a mensagem (pool
// rotativo da Amazon, sub_id da Shopee), entao a URL no texto pode diferir da
// URL registrada na oferta. O WhatsApp so renderiza o card quando o
// matched-text aparece EXATAMENTE no corpo — por isso o preview precisa usar a
// URL que esta de fato na mensagem, e o link original vira apenas reserva.
function urlNaMensagem(url, mensagem) {
  try {
    const alvo = new URL(url);
    const candidatas = String(mensagem || '').match(/https?:\/\/[^\s`"'<>]+/g) || [];
    const achada = candidatas.find(u => {
      try { const x = new URL(u); return x.hostname === alvo.hostname && x.pathname === alvo.pathname; }
      catch { return false; }
    });
    return achada || url;
  } catch { return url; }
}

async function montarLinkPreview(oferta, mensagem) {
  const d = oferta.dadosExtraidos || {};
  const url = d.link ? urlNaMensagem(d.link, mensagem) : null;
  if (!url) return null;

  const preview = {
    'canonical-url': url,
    'matched-text': url,
    title: d.titulo || d.loja || 'Oferta',
    description: [d.precoFinal != null ? 'R$ ' + Number(d.precoFinal).toFixed(2).replace('.', ',') : null,
                  d.loja].filter(Boolean).join(' · '),
  };

  const img = (oferta.imagens || [])[0];
  const thumb = await miniaturaDoPreview(img?.imagemBase64 || null, d.imagemUrl || null,
    'oferta #' + (oferta.id || '?'), oferta.miniaturaFonte || null);
  if (thumb) preview.jpegThumbnail = thumb;
  return preview;
}

// Mesma ideia do montarLinkPreview, mas a partir de campos soltos: o gerador
// manual nao tem uma oferta na fila, so o produto que o operador acabou de
// consultar. A thumbnail passa pelo baixarImagemProduto para herdar a conversao
// de webp -> jpg do Mercado Livre.
async function montarLinkPreviewManual(dados, mensagem) {
  let url = String(dados?.link || '').trim();
  if (!url) return null;
  if (mensagem) url = urlNaMensagem(url, mensagem);
  const preview = {
    'canonical-url': url,
    'matched-text': url,
    title: dados.titulo || dados.loja || 'Oferta',
    description: dados.descricao || '',
  };
  if (dados.imagemUrl) {
    const img = await baixarImagemProduto(dados.imagemUrl);
    const thumb = await miniaturaDoPreview(img?.imagemBase64 || null, dados.imagemUrl, 'envio manual');
    if (thumb) preview.jpegThumbnail = thumb;
  }
  return preview;
}

// ── ESPELHO DE CATEGORIA NO GRUPO DO OPERADOR ────────────────────────────────
// Copia de diagnostico das categorias em observacao (categorias.json ->
// espelhoOperador). Mostra a mensagem como ela sairia num grupo de nicho, mais
// o rodape com o que decidiu a classificacao. Serve para medir o acerto do
// classificador ANTES de existir grupo de nicho de verdade — nao altera em nada
// o destino das ofertas nos grupos de cliente.
async function espelharCategoriaNoOperador(oferta, cls) {
  try {
    const jid = GRUPOS['operador'];
    if (!jid) return;
    const d = oferta.dadosExtraidos || {};
    const cabecalho =
        '\u{1F9EA} *TESTE DE CATEGORIA \u2014 ' + String(cls.nome || cls.categoria).toUpperCase() + '*\n'
      + '`' + explicarClassificacao(cls) + '`\n'
      + '`origem: ' + (oferta.grupoOrigemNome || oferta.grupoOrigem || 'radar') + ' \u00b7 ' + (d.loja || '?') + '`\n'
      + '`' + (categoriaConfiavel(cls)
                ? 'acima do limiar \u2014 iria para o grupo de nicho'
                : 'abaixo do limiar \u2014 ficaria so no grupo geral') + '`\n\n';
    const preview = await montarLinkPreview(oferta, oferta.mensagemFormatada);
    const corpo = cabecalho + oferta.mensagemFormatada;
    // Espelho e diagnostico do classificador, nao acao: na fase de teste dos
    // niveis ele fica so na tela, para nao competir com o que exige decisao.
    // O card do preview so existe no WhatsApp, entao o registro guarda o texto.
    if (DESTINO_POR_NIVEL.info) {
      await enviarMensagem(jid, preview ? { text: corpo, linkPreview: preview } : { text: corpo });
    }
    registrarAlerta({
      nivel: 'info', origem: 'categorias',
      chave: 'espelho:' + (oferta?.id || cls.categoria),
      titulo: 'Espelho de categoria — ' + String(cls.nome || cls.categoria),
      corpo, ofertaId: oferta?.id || null, soRegistrar: true,
    }).catch(() => {});
    console.log('[CAT] Espelho "' + cls.categoria + '" enviado ao operador \u2014 oferta #' + oferta.id);
  } catch (e) {
    console.warn('[CAT] Falha ao espelhar no operador:', e.message);
  }
}

async function enviarOfertaParaDestinos(mensagem, imagem, oferta, opcoes = {}) {
  // Sem fallback: oferta vai para os grupos marcados como DESTINO na aba
  // Grupos, e para mais nenhum. Se nao ha destino marcado, o envio falha com
  // uma mensagem que diz o que fazer — antes isso caia num grupo fixo que o
  // operador nao tinha escolhido.
  // Roteamento por TRILHA: a oferta vai para os destinos das trilhas que tem a
  // fonte dela. Trilha geral entrega tudo o que capturou; trilha de nicho so
  // entrega quando o classificador confirmou a categoria — sem isso, o grupo de
  // bebidas receberia "produto que talvez seja bebida".
  const _rota = {
    fonte: oferta?.grupoOrigem || null,
    categoria: oferta?.dadosExtraidos?.categoria || null,
    categoriaConfiavel: categoriaConfiavel({
      categoria: oferta?.dadosExtraidos?.categoria || null,
      confianca: oferta?.dadosExtraidos?.categoriaConfianca || 0,
    }),
  };
  let alvos = destinosDaOferta(_rota);
  console.log('[MKT] Oferta #' + (oferta?.id || '?') + ' roteamento: ' + explicarRoteamento(_rota)
    + ' -> ' + alvos.length + ' grupo(s).');

  // ── RECORTE POR TIPO DE DESTINO ──
  // Usado pelo monitor de precos quando o produto e curado e o desconto nao foi
  // fundo o bastante para interromper o grupo geral: a MESMA oferta sai, so que
  // num subconjunto dos destinos. Sem opcoes, nada muda — todos os outros
  // caminhos de envio continuam recebendo a lista inteira.
  if (opcoes.somenteNicho) {
    const antes = alvos.length;
    alvos = alvos.filter(jid => ehDestinoDeNicho(jid, opcoes.categoriaNicho || null));
    console.log('[MKT] Oferta #' + (oferta?.id || '?') + ' restrita ao nicho '
      + (opcoes.categoriaNicho || '(qualquer)') + ' — ' + alvos.length + ' de ' + antes + ' grupo(s).');
    if (!alvos.length) {
      throw new Error('Nenhum grupo de nicho' + (opcoes.categoriaNicho ? ' "' + opcoes.categoriaNicho + '"' : '')
        + ' entre os destinos desta oferta — confira as trilhas na aba Grupos.');
    }
  }

  if (!alvos.length) {
    throw new Error(trilhas().length
      ? 'Nenhuma trilha entrega esta oferta — confira as fontes e destinos na aba Grupos.'
      : 'Nenhuma trilha configurada na aba Grupos.');
  }
  // Grupo so-cupons nao recebe oferta de produto, mesmo que esteja marcado
  // como destino por engano.
  const soCupons = new Set(GRUPOS['tsp_cupons']);
  const enviados = [], falhas = [];
  const preview = oferta ? await montarLinkPreview(oferta, mensagem) : null;
  // Um id por despacho: todos os destinos desta execucao compartilham a chave
  // de idempotencia da outbox (id, jid).
  const _execId = oferta?.id ? String(oferta.id) : ('o_' + Date.now());

  for (const jid of alvos) {
    if (soCupons.has(jid)) continue;
    // Numero fixo do grupo quando houver; senao, o turno vigente.
    const op = { conta: contaDoGrupo(jid) };
    // Rodape extra decidido AQUI, ja sabendo o destino: e o que permite a mesma
    // oferta de bebida sair no grupo geral com o convite para o grupo de bebidas
    // e sair sem ele dentro do proprio grupo de bebidas.
    const texto = comTagDoGrupo(comRodapeExtra(mensagem, {
      jid, tipo: 'oferta',
      categoria: _rota.categoria,
      categoriaConfiavel: _rota.categoriaConfiavel,
    }), jid);
    // O card e clicavel e carrega a propria URL: sem reescrever o preview, o
    // texto sairia com a tag do grupo e o card levaria o clique para a antiga.
    const lpDoGrupo = previewComTagDoGrupo(preview, jid);
    try {
      await enviarMensagem(jid, lpDoGrupo ? { text: texto, linkPreview: lpDoGrupo } : { text: texto }, 0, op);
      enviados.push(jid);
      if (alvos.length > 1) await new Promise(r => setTimeout(r, msEntreGrupos()));
    } catch (e) {
      console.error('[MKT] Falha ao enviar em ' + jid + ':', e.message);
      falhas.push({ jid, erro: e.message });
      outboxEnfileirar({ id: _execId, jid, texto, conta: op.conta, origem: 'oferta', erro: e.message });
    }
  }
  if (!enviados.length) throw new Error('Nenhum grupo recebeu a oferta.');
  // Vitrine publica: so entra o que realmente saiu em algum grupo. Chamada aqui
  // (e nao nos dois callers) para cobrir tanto o auto-envio quanto a aprovacao
  // manual pelo painel, sem risco de um dos caminhos ficar de fora.
  if (oferta) registrarPublicacao(oferta, enviados.length);
  if (enviados.length) _despachoContar();
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
// Multipart nao tem array: o painel manda as trilhas como JSON ou separadas por
// virgula. Entrada torta vira lista vazia (= grupos gerais), nunca excecao.
function parseTrilhasForm(v) {
  if (Array.isArray(v)) return v;
  const s = String(v || '').trim();
  if (!s) return [];
  if (s[0] === '[') { try { const a = JSON.parse(s); return Array.isArray(a) ? a : []; } catch { return []; } }
  return s.split(',').map(x => x.trim()).filter(Boolean);
}

async function enviarManualParaGrupos({ mensagem, tipo, imagem, preview, categoria, trilhasIds }) {
  const ehCupom  = String(tipo || '').toLowerCase() === 'cupom';
  // Sem escolha explicita, mensagem escrita a mao vai para os GERAIS — nicho e
  // territorio do radar, que sabe a categoria do produto, e texto livre sem
  // classificacao cairia em todos os grupos de nicho ao mesmo tempo.
  // Com trilhas marcadas no painel, quem manda e o operador: ele viu o produto.
  const escolhidos = destinosDasTrilhas(trilhasIds);
  const destinos = escolhidos.length ? escolhidos : destinosGerais();
  const soCupons = new Set(GRUPOS['tsp_cupons'] || []);
  const alvos = ehCupom
    ? [...new Set([...destinos, ...soCupons])]
    : destinos.filter(j => !soCupons.has(j));
  if (!alvos.length) {
    throw new Error(escolhidos.length
      ? 'As trilhas escolhidas nao tem grupo de destino cadastrado.'
      : 'Nenhum grupo marcado como destino na aba Grupos.');
  }

  // Card de link so vale quando nao ha imagem — o WhatsApp mostra um ou outro.
  let lp = null;
  if (!imagem?.imagemBase64 && preview?.link) {
    try { lp = await montarLinkPreviewManual(preview, mensagem); }
    catch (e) { console.warn('[MANUAL] Nao montou o preview:', e.message); }
  }

  const enviados = [], falhas = [];
  // Mensagem escrita a mao nao passa pelo classificador: a categoria so existe
  // se o painel mandar explicitamente. Sem ela, casam apenas as regras de
  // rodape que nao filtram por categoria.
  const catManual = String(categoria || '').trim();
  for (const jid of alvos) {
    // Remetente do grupo: fixo se atribuido, senao o do turno.
    const op = { conta: contaDoGrupo(jid) };
    const texto = comTagDoGrupo(comRodapeExtra(mensagem, {
      jid,
      tipo: ehCupom ? 'cupom' : 'manual',
      categoria: catManual || null,
      categoriaConfiavel: !!catManual,
    }), jid);
    const lpGrupo = previewComTagDoGrupo(lp, jid);
    try {
      if (imagem?.imagemBase64) {
        await enviarMensagem(jid, {
          image:    Buffer.from(imagem.imagemBase64, 'base64'),
          caption:  texto || '',
          mimetype: imagem.mime || 'image/jpeg',
        }, 0, op);
      } else {
        await enviarMensagem(jid, lpGrupo ? { text: texto, linkPreview: lpGrupo } : { text: texto }, 0, op);
      }
      enviados.push(jid);
      // Espacamento entre grupos: mesmo padrao do radar. Disparo simultaneo em
      // varios grupos e justamente o que o WhatsApp usa para achar automacao.
      if (alvos.length > 1) await new Promise(r => setTimeout(r, msEntreGrupos()));
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

  // Rastro na filaPendentes: sem isto o envio manual saia sem deixar registro
  // e a secao "Enviados recentemente" da aba Fila so mostrava o fluxo
  // automatico — parecia que o disparo manual nunca tinha acontecido.
  // Status 'enviado' entra no mesmo ciclo de limpeza dos processados (24h /
  // teto de 20 em limparFila), entao nao acumula.
  try {
    const agoraIso = new Date().toISOString();
    const primeiraLinha = String(mensagem || '').split('\n').find(l => l.trim()) || '';
    const rastroManual = {
      id:                gerarId(),
      tipoConteudo:      'manual_tsp',
      status:            'enviado',
      timestamp:         agoraIso,
      enviadoEm:         agoraIso,
      gruposEnviados:    enviados.slice(),
      origem:            null, // origem vazia = etiqueta "manual" no painel
      mensagemFormatada: String(mensagem || '').slice(0, 1200),
      dadosExtraidos: {
        titulo:  (primeiraLinha.replace(/[*_~`]/g, '').trim().slice(0, 90))
                   || (imagem ? 'Imagem sem legenda' : 'Mensagem'),
        subtipo: ehCupom ? 'cupom'
               : String(tipo || '').toLowerCase() === 'oferta' ? 'oferta'
               : 'mensagem',
      },
    };
    filaPendentes.push(rastroManual);
    salvarFila();
    registrarEnvioHistorico(rastroManual);
  } catch (e) { console.warn('[MANUAL] Nao registrou rastro na fila:', e.message); }

  return { enviados, falhas };
}

// Envia um cupom aprovado pelo gate para os grupos de cupons e marca a oferta
// como enviada. Lanca excecao se o envio principal falhar (caller decide o fallback).
async function despacharCupomAuto(oferta) {
  await enviarCupomParaGrupos(oferta.mensagemFormatada, oferta.imagens?.[0], oferta);
  _ultimoAutoEnvio     = Date.now();
  oferta.status        = 'enviado';
  oferta.mensagemFinal = oferta.mensagemFormatada;
  oferta.autoEnviado   = true;
  delete oferta.autoAgendado;
  delete oferta.enviandoDesde;
  delete oferta.enviadosParciais;
  delete oferta.envioInterrompido;
  registrarEnvioHistorico(oferta);
}

// ── HISTÓRICO DURÁVEL DE ENVIOS TSP ──────────────────────────────────────────
// filaPendentes é operacional: limparFila() descarta processados em 24h (teto
// de 20) e o rastro some. Este registro é o que FICA — a base para avaliar no
// futuro se uma oferta/cupom foi bom, cruzando com rastreio.json (cliques) e
// comissoes-afiliados.json (vendas). Shard mensal para nunca passar do ~1MB
// que a Contents API devolve na leitura; persistência via sync-github com o
// mesmo debounce dos demais JSONs do repositório de dados.
const _histEnvioCache = new Map(); // caminho local -> array de registros

function shardHistoricoAtual(tenant) {
  const ym = new Intl.DateTimeFormat('en-CA', { timeZone: TZ_SP, year: 'numeric', month: '2-digit' })
    .format(new Date()); // "2026-08"
  const nome = 'historico_envios_' + ym + '.json';
  return (!tenant || tenant === TENANT_PADRAO) ? nome : 'tenants/' + tenant + '/' + nome;
}

async function _registrosDoShard(local) {
  if (_histEnvioCache.has(local)) return _histEnvioCache.get(local);
  const caminho = SESSAO_DIR + '/' + local;
  let regs = null;
  try { if (existsSync(caminho)) regs = JSON.parse(readFileSync(caminho, 'utf-8')).registros || []; } catch {}
  if (!regs) {
    // Volume novo (deploy zerou o disco): restaura o shard do mês antes do
    // primeiro append, senão o envio sobrescreveria o histórico já no repo.
    try {
      if (await baixarArquivoDoGitHub(local) && existsSync(caminho)) {
        regs = JSON.parse(readFileSync(caminho, 'utf-8')).registros || [];
      }
    } catch {}
  }
  if (!regs) regs = [];
  _histEnvioCache.set(local, regs);
  return regs;
}

// Dos grupos que de fato receberam, quais sao destino de trilha de NICHO.
// Devolve null quando nao ha lista de enviados (registro sem rastro de grupo)
// para nao confundir "nenhum nicho" com "nao sei".
function jidsDeNicho(gruposEnviados) {
  if (!Array.isArray(gruposEnviados)) return null;
  try { return gruposEnviados.filter(j => ehDestinoDeNicho(j)); }
  catch { return null; }
}

async function registrarEnvioHistorico(oferta) {
  try {
    if (!oferta || oferta.status !== 'enviado') return;
    const d = oferta.dadosExtraidos || {};
    const local = shardHistoricoAtual(oferta.tenant);
    const regs = await _registrosDoShard(local);
    // Idempotente por id: aprovação manual e worker podem disputar o mesmo item.
    if (regs.some(r => String(r.id) === String(oferta.id))) return;

    // LOTE: um registro POR CUPOM, todos com o mesmo loteId. Gravar so um
    // registro pela mensagem faria a contagem de cupons por loja despencar sem
    // que nada tivesse deixado de ser publicado. O campo 'mensagens' (1 apenas
    // no primeiro item) e o que permite medir o volume real de disparos —
    // somar registros passa a contar cupons, somar 'mensagens' conta mensagens.
    if (Array.isArray(oferta.loteCupons) && oferta.loteCupons.length) {
      const loteId = String(oferta.id);
      if (regs.some(r => String(r.loteId) === loteId)) return;
      const quando = oferta.enviadoEm || new Date().toISOString();
      oferta.loteCupons.forEach((c, i) => {
        regs.push({
          id:            loteId + '-' + i,
          loteId,
          loteTamanho:   oferta.loteCupons.length,
          mensagens:     i === 0 ? 1 : 0,
          enviadoEm:     quando,
          tipoConteudo:  'cupom_tsp',
          subtipo:       c.subtipo || null,
          loja:          c.loja || null,
          titulo:        null,
          codigo:        c.codigo || null,
          valor:         c.valor ?? null,
          tipo:          c.tipo ?? null,
          preco:         null,
          precoFinal:    null,
          desconto:      null,
          asin:          null,
          link:          null,
          origem:        oferta.grupoOrigem || oferta.origem || null,
          gruposDestino: Array.isArray(oferta.gruposEnviados) ? oferta.gruposEnviados.length : null,
          gruposNicho:   jidsDeNicho(oferta.gruposEnviados),
          categoria:     c.categoria || null,
          autoEnviado:   !!oferta.autoEnviado,
          temImagem:     Array.isArray(oferta.imagens) && oferta.imagens.length > 0,
        });
      });
      const caminhoLote = SESSAO_DIR + '/' + local;
      const dirLote = caminhoLote.slice(0, caminhoLote.lastIndexOf('/'));
      if (!existsSync(dirLote)) mkdirSync(dirLote, { recursive: true });
      escreverAtomico(caminhoLote, JSON.stringify({ registros: regs }), 'utf-8');
      agendarPush(local);
      return;
    }

    // Prova de vida do despacho: alimenta a segunda via do pulso por loja, para
    // que "loja parada" so vire alerta critico quando a loja de fato parou —
    // e nao quando apenas o radar de grupo deixou de trazer produto dela.
    if (d.loja) registrarPulsoDespacho(d.loja);

    regs.push({
      id:            oferta.id,
      enviadoEm:     oferta.enviadoEm || new Date().toISOString(),
      tipoConteudo:  oferta.tipoConteudo,
      subtipo:       d.subtipo || null,
      loja:          d.loja || null,
      titulo:        String(d.titulo || '').slice(0, 120) || null,
      codigo:        d.codigo || (d.cupom && d.cupom.codigo) || null,
      valor:         d.valor ?? null,           // cupom: 12 / 'pct' ou 30 / 'reais'
      tipo:          d.tipo ?? null,
      // ── PRECOS ──
      // Ate aqui so 'preco' e 'precoFinal' eram gravados, e 'desconto' misturava
      // duas unidades: REAIS quando havia cupom, PERCENTUAL quando nao havia.
      // Consequencia: em toda oferta com cupom o de->por era sobrescrito e
      // perdido — 262 das 297 ofertas ML de agosto ficaram sem ele. Sem o
      // de->por nao ha como calibrar o piso de desconto com numero real.
      // O campo 'desconto' fica como estava para nao quebrar consumidor antigo.
      precoDe:       d.precoDe ?? null,          // de (etiqueta da loja)
      preco:         d.preco ?? null,            // por (praticado)
      precoFinal:    d.precoFinal ?? null,       // com cupom
      desconto:      (d.cupom && d.cupom.desconto) ?? d.desconto ?? null,
      descontoPct:   (Number(d.precoDe) > 0 && Number(d.preco) > 0 && d.precoDe > d.preco)
                       ? Math.round(1000 * (d.precoDe - d.preco) / d.precoDe) / 10 : null,
      cupomReais:    (d.cupom && Number(d.cupom.desconto) > 0) ? Number(d.cupom.desconto) : null,
      cupomPct:      (d.cupom && Number(d.cupom.desconto) > 0 && Number(d.preco) > 0)
                       ? Math.round(1000 * d.cupom.desconto / d.preco) / 10 : null,
      descontoTotalPct: (Number(d.precoDe) > 0 && Number(d.precoFinal) > 0 && d.precoDe > d.precoFinal)
                       ? Math.round(1000 * (d.precoDe - d.precoFinal) / d.precoDe) / 10 : null,
      precoDeReferencia: !!d.precoDeReferencia,  // 'de' que veio do texto do grupo, nao de fonte verificavel
      asin:          d.asin || null,
      link:          d.link || d.urlLoja || null,
      origem:        oferta.grupoOrigem || oferta.origem || null,
      gruposDestino: Array.isArray(oferta.gruposEnviados) ? oferta.gruposEnviados.length
                   : Array.isArray(oferta.destinos)       ? oferta.destinos.length : null,
      // Contar quantos grupos receberam nao diz QUAIS. Sem isto, medir volume
      // por grupo de nicho so era possivel por inferencia (reclassificar o
      // titulo e comparar contagens), e falha parcial de envio ja bastava para
      // errar o numero. Guardamos so os JIDs de nicho, nao a lista inteira: 30
      // JIDs por registro somariam ~750 KB no shard do mes e estourariam o
      // ~1 MB que a Contents API devolve na leitura.
      gruposNicho:   jidsDeNicho(oferta.gruposEnviados),
      categoria:     d.categoria || null,
      categoriaConfianca: d.categoriaConfianca ?? null,
      autoEnviado:   !!oferta.autoEnviado,
      temImagem:     Array.isArray(oferta.imagens) && oferta.imagens.length > 0,
      mensagens:     1,
    });
    const caminho = SESSAO_DIR + '/' + local;
    const dir = caminho.slice(0, caminho.lastIndexOf('/'));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    escreverAtomico(caminho, JSON.stringify({ registros: regs }), 'utf-8');
    agendarPush(local);

    // ── DIVULGADO: marca o dedup e coloca o produto sob vigilancia de preco ──
    // Este e o unico ponto por onde TODA oferta enviada passa, venha da fila,
    // do auto-envio ou de uma lista. Marcar o dedup aqui e nao na captura e
    // deliberado: produto capturado e descartado nao consumiu divulgacao
    // nenhuma e precisa continuar elegivel.
    if (ehOfertaMarketplace(oferta.tipoConteudo) && d.asin) {
      try { registrarVisto({ asin: d.asin, loja: d.loja, preco: d.preco }); }
      catch (e) { console.warn('[DEDUP] Falha ao marcar ' + d.asin + ':', e.message); }
      // Vigilancia de preco: entra pela DIVULGACAO, nao pela captura. Captura
      // sao ~100 produtos/dia e a lista estouraria; divulgado sao ~20 distintos.
      try {
        vigiarProdutoDivulgado({
          asin: d.asin, loja: d.loja, nome: d.titulo,
          url: d.link || d.urlLoja || null,
          preco: Number(d.preco), precoDe: Number(d.precoDe),
        });
      } catch (e) { console.warn('[PRECOS] Falha ao vigiar ' + d.asin + ':', e.message); }
    }
  } catch (e) {
    console.warn('[HIST-ENVIOS] Falha ao registrar #' + (oferta && oferta.id) + ':', e.message);
  }
}

// ── WORKER DE ESPACAMENTO DO AUTO-ENVIO ──────────────────────────────────────
// Cupons que passaram em TODAS as regras de conteudo mas foram bloqueados por
// motivo apenas temporal (janela de horario ou intervalo minimo entre envios)
// ficam na fila com autoAgendado=true. Este worker envia um por vez, sempre
// respeitando a janela e o intervalo de 90s. Cupons agendados ha mais de
// AUTO_ENVIO_MAX_ESPERA viram aprovacao manual (provavelmente ja venceram).
let _workerAutoRodando = false;
setInterval(async () => {
  if (autoEnvioModo() !== 'on') return;
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
    const rotulo = Array.isArray(oferta.loteCupons) && oferta.loteCupons.length > 1
      ? `${nomeLojaExibicao(d.loja)} · lote de ${oferta.loteCupons.length} cupons`
      : `${nomeLojaExibicao(d.loja)} ${d.valor}${d.tipo === 'pct' ? '%' : ' R$'}${d.codigo ? ' · '+d.codigo : ''}`;

    // Marca como 'enviando' antes do await para o card sumir do painel e
    // reduzir a janela de corrida com uma aprovacao manual simultanea.
    // O carimbo permite a aba Fila distinguir "saindo agora" de um envio que
    // travou: sem ele, um item preso em 'enviando' ficaria eternamente com
    // cara de normal.
    oferta.status        = 'enviando';
    oferta.enviandoDesde = new Date().toISOString();
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
      delete oferta.enviandoDesde;
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
    motivoRetencao = null,
    jaRegistrado = false,
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

  // jaRegistrado: veio do montador de lote, que ja passou pelo dedup e ja
  // gravou na base. Repetir aqui faria cupomJaVisto() acusar duplicata do
  // proprio cupom e descartar em silencio o item que so precisava cair na fila.
  if (!jaRegistrado) {
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
  }

  const veredito = avaliarAutoEnvio(c, textoOriginal, tinhaMultiplos, codigosLista);
  const rotulo   = `${nomeLojaExibicao(c.loja)} ${c.valor}${c.tipo === 'pct' ? '%' : ' R$'}${c.codigo ? ' · '+c.codigo : ''}`;

  // Veredito fica gravado na oferta para aparecer no card da fila (o log do
  // Railway sozinho nao serve: em modo sombra o operador precisa comparar a
  // decisao do gate com a propria aprovacao manual, cupom a cupom.
  oferta.autoAvaliacao = {
    auto: veredito.auto,
    motivo: veredito.motivo,
    modo: autoEnvioModo(),
    avaliadoEm: new Date().toISOString(),
  };

  // Bloqueio APENAS temporal (janela/intervalo): todas as regras de conteudo
  // passaram. Em modo 'on', em vez de exigir aprovacao manual, o cupom entra
  // agendado e o worker de espacamento envia quando a condicao liberar.
  const bloqueioTemporal = !veredito.auto && /^(fora da janela|intervalo minimo)/.test(veredito.motivo);
  if (autoEnvioModo() === 'on' && bloqueioTemporal && !somenteFila) oferta.autoAgendado = true;

  // Retencao por idade: o gate de CONTEUDO pode ter dito 'aprovado', mas o item
  // nao vai sair sozinho — e o card precisa dizer por que, senao o operador ve
  // 'aprovado' num cupom parado e nao entende o que aconteceu.
  if (somenteFila && motivoRetencao) {
    oferta.autoAvaliacao.auto   = false;
    oferta.autoAvaliacao.motivo = motivoRetencao;
    oferta.retidoPorIdade       = true;
  }

  // MODO SOMBRA: decide e loga, mas nao envia. Serve para medir a taxa de
  // acerto do gate contra a aprovacao manual antes de ligar 'on'.
  if (autoEnvioModo() === 'sombra') {
    console.log(`[AUTO-SOMBRA] ${veredito.auto ? 'ENVIARIA' : 'BLOQUEADO'} — ${rotulo} — ${veredito.motivo}`);
  }

  // Entra na fila ANTES de comecar a distribuicao (e nao depois, como era):
  // sao ~1 min passando por todos os grupos, e um processo que morre no meio
  // deixava o cupom sem nenhum registro em disco — parcialmente publicado e
  // invisivel para o operador.
  let jaNaFila = false;
  if (autoEnvioModo() === 'on' && veredito.auto && !somenteFila) {
    oferta.status        = 'enviando';
    oferta.enviandoDesde = new Date().toISOString();
    filaPendentes.unshift(oferta);
    salvarFila();
    jaNaFila = true;
    try {
      await despacharCupomAuto(oferta);
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
      oferta.status = 'pendente';
      delete oferta.enviandoDesde;
      salvarFila();
      console.error(`[AUTO] Falha no envio automatico, caindo para fila: ${err.message}`);
    }
  }

  if (!jaNaFila) filaPendentes.unshift(oferta);
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
      text: (oferta.retidoPorIdade
              ? `*Cupom retido (mensagem antiga)* ⏸️\n\n${rotulo}\n${oferta.autoAvaliacao.motivo}\n\n`
              : '*Novo cupom capturado* ✅\n\n')
            + 'Aprove aqui: https://davileles.github.io/tudo-sobre-promos/'
    });
  } catch(e) { console.warn('[FILA] Falha ao enviar alerta de cupom:', e.message); }

  return { oferta, veredito, enviado: false };
}

// ── LOTE DE CUPONS: UMA MENSAGEM POR MENSAGEM DE ORIGEM ──────────────────────
// Canal de cupom manda a lista inteira de UMA loja numa mensagem so. Antes cada
// item virava um disparo proprio, espacado pelo intervalo de anti-flood: uma
// lista de 13 cupons ocupava meia hora do grupo do cliente e mandava 13
// mensagens para dizer o que cabia em uma.
//
// O que NAO muda: dedup, gravacao em cupons_base.json, ativacao no ML e o gate
// de conteudo continuam por cupom. Agrupar e uma decisao de APRESENTACAO — a
// base de cupons segue com um registro por codigo, que e o que o casamento com
// as ofertas do radar consulta.
async function despacharBlocoCupons(bloco, ctx = {}) {
  const { origem = 'desconhecida', textoOriginal = '', imagens = [],
          somenteFila = false, motivoRetencao = null } = ctx;

  const oferta = {
    id: gerarId(),
    timestamp: new Date().toISOString(),
    grupoOrigem: origem,
    tipoConteudo: 'cupom_tsp',
    conteudoOriginal: textoOriginal,
    imagens,
    mensagemFormatada: formatarCupomLoteTSP(bloco),
    // dadosExtraidos fica com o primeiro cupom para o painel e o histórico
    // continuarem achando loja/valor/tipo onde sempre estiveram; a lista
    // completa vive em loteCupons.
    dadosExtraidos: { ...bloco[0], codigosLote: bloco.map(c => c.codigo || null) },
    loteCupons: bloco,
    status: 'pendente',
    tenant: tenantContexto() || TENANT_PADRAO,
  };

  const rotulo = `${nomeLojaExibicao(bloco[0].loja)} · lote de ${bloco.length} cupons`;
  const temporal = avaliarTemporalAutoEnvio();
  oferta.autoAvaliacao = {
    auto: temporal.auto,
    motivo: temporal.auto ? `aprovado (lote de ${bloco.length})` : temporal.motivo,
    modo: autoEnvioModo(),
    avaliadoEm: new Date().toISOString(),
  };

  // Retencao por idade vence o agendamento: sem autoAgendado o worker de
  // espacamento nao pega o item, entao ele fica esperando aprovacao manual.
  if (somenteFila) {
    oferta.autoAvaliacao.auto   = false;
    oferta.autoAvaliacao.motivo = motivoRetencao || 'retido: mensagem antiga (backlog)';
    oferta.retidoPorIdade       = true;
    filaPendentes.unshift(oferta);
    salvarFila();
    console.warn(`[TG-BACKLOG] Lote #${oferta.id} retido para aprovacao manual — ${rotulo}`);
    try {
      await enviarMensagem(GRUPOS.operador, {
        text: `*Lote de cupons retido (mensagem antiga)* ⏸️\n\n${rotulo}\n${oferta.autoAvaliacao.motivo}`
          + '\n\nAprove aqui: https://davileles.github.io/tudo-sobre-promos/'
      });
    } catch(e) { console.warn('[FILA] Falha ao avisar operador do lote retido:', e.message); }
    return { oferta, retido: true };
  }

  // Bloqueio temporal: o lote inteiro fica agendado e o worker de espacamento
  // manda quando liberar. Nada de quebrar o lote so porque o relogio nao ajudou.
  if (!temporal.auto) {
    oferta.autoAgendado = true;
    filaPendentes.unshift(oferta);
    salvarFila();
    console.log(`[AUTO-FILA] Lote #${oferta.id} agendado — ${rotulo} (${temporal.motivo})`);
    return { oferta, agendado: true };
  }

  oferta.status        = 'enviando';
  oferta.enviandoDesde = new Date().toISOString();
  filaPendentes.unshift(oferta);
  salvarFila();
  try {
    await despacharCupomAuto(oferta);
    salvarFila();
    console.log(`[AUTO] Lote #${oferta.id} ENVIADO automaticamente — ${rotulo}`);
    try {
      await enviarMensagem(GRUPOS.operador, {
        text: `*Lote de cupons enviado automaticamente* 🤖\n\n${rotulo}\n`
          + bloco.map(c => `· ${c.codigo || 'sem código'} — ${c.valor}${c.tipo === 'pct' ? '%' : ' R$'}`).join('\n')
          + `\n\nOrigem: ${origem}`
      });
    } catch(e) { console.warn('[AUTO] Falha ao avisar operador:', e.message); }
    return { oferta, enviado: true };
  } catch(err) {
    // Falha no envio: vira aprovacao manual em vez de perder a lista.
    oferta.status = 'pendente';
    delete oferta.enviandoDesde;
    salvarFila();
    console.error(`[AUTO] Falha no envio do lote #${oferta.id}: ${err.message} — caindo para fila`);
    try {
      await enviarMensagem(GRUPOS.operador, {
        text: '*Novo lote de cupons capturado* ✅\n\nAprove aqui: https://davileles.github.io/tudo-sobre-promos/'
      });
    } catch(e) { console.warn('[FILA] Falha ao enviar alerta de lote:', e.message); }
    return { oferta, enviado: false };
  }
}

async function enfileirarLoteCupomTSP(lista, ctx = {}) {
  const { origem = 'desconhecida', textoOriginal = '', codigosLista = [] } = ctx;

  // 1. Dedup, base e ativacao no ML — POR CUPOM, antes de qualquer envio.
  const novos = [];
  for (const c of lista) {
    if (cupomJaVisto(c)) {
      console.log(`[DEDUP] Cupom do lote ignorado (duplicata): ${c.loja} | ${c.codigo || 'sem código'}`);
      continue;
    }
    registrarCupomVisto(c);
    let regBase = null;
    try { regBase = registrarCupomBase(c); }
    catch(e) { console.warn('[CUPONS] Falha ao gravar na base:', e.message); }
    ativarCupomCapturadoMl(c, regBase);
    novos.push(c);
  }
  if (!novos.length) return { ignorado: true, motivo: 'todos duplicatas' };

  // 2. Gate de CONTEUDO por cupom (teto, minimo, codigo confere no bloco dele).
  //    Um cupom sem regra de aplicacao completa nao entra na mensagem: ele iria
  //    junto com os validos e sairia sem revisao nenhuma, que e justamente o que
  //    o gate existe para impedir.
  const modo = autoEnvioModo();
  const aprovados = [], reprovados = [];
  for (const c of novos) {
    const v = avaliarAutoEnvio(c, textoOriginal, true, codigosLista, { ignorarTemporal: true });
    if (v.auto && modo === 'on') aprovados.push(c);
    else reprovados.push({ c, v });
  }

  const resultados = [];

  // 3. Reprovados seguem o caminho individual de sempre: fila para aprovacao
  //    manual, com o motivo visivel no card.
  for (const { c } of reprovados) {
    try {
      resultados.push(await enfileirarCupomTSP(c, { ...ctx, tinhaMultiplos: true, jaRegistrado: true }));
    } catch(e) {
      console.error(`[LOTE] Falha ao enfileirar cupom ${c.codigo || 'sem código'}: ${e.message}`);
    }
  }

  // 4. Aprovados em blocos de ate CUPOM_LOTE_MAX. Bloco de um unico cupom sai
  //    no formato de cupom normal — envelope de lote para um item so anuncia
  //    "1 cupons" e desperdica o cabecalho.
  for (let i = 0; i < aprovados.length; i += CUPOM_LOTE_MAX) {
    const bloco = aprovados.slice(i, i + CUPOM_LOTE_MAX);
    try {
      if (bloco.length === 1) {
        resultados.push(await enfileirarCupomTSP(bloco[0], { ...ctx, tinhaMultiplos: true, jaRegistrado: true }));
      } else {
        resultados.push(await despacharBlocoCupons(bloco, ctx));
      }
    } catch(e) {
      console.error(`[LOTE] Falha no bloco de ${bloco.length} cupons: ${e.message}`);
    }
  }

  console.log(`[LOTE] ${lista.length} cupom(ns) da mensagem de ${origem}: `
    + `${novos.length} novo(s), ${aprovados.length} agrupado(s), ${reprovados.length} para fila manual.`);
  return { lote: true, resultados };
}

// ── PROCESSAR MENSAGEM DO TELEGRAM ────────────────────────────────────────────
// Serializacao: o gate de dedup so roda DEPOIS da chamada a Anthropic (1-3s).
// Sem mutex, o mesmo cupom chegando pelos dois canais com poucos segundos de
// diferenca passa duas vezes pelo gate — e com auto-envio isso vira mensagem
// duplicada no grupo de clientes. Uma cadeia de promises basta (processo unico).
let _tgChain = Promise.resolve();

function processarMensagemTelegram(texto, canalUsername = 'desconhecido', imagemBase64 = null, postadoEm = null) {
  _tgChain = _tgChain
    .then(() => _processarMensagemTelegram(texto, canalUsername, imagemBase64, postadoEm))
    .catch(e => console.error('[TG] Erro na cadeia:', e.message));
  return _tgChain;
}

async function _processarMensagemTelegram(texto, canalUsername = 'desconhecido', imagemBase64 = null, postadoEm = null) {
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

    // Mensagem antiga = backlog de reconexao/redeploy, nao noticia. NUNCA sai
    // sozinha: vai para a fila como pendente. Descartar perderia cupom que ainda
    // pode estar valido; auto-enviar foi o que jogou nos grupos, as 6h20, um
    // cupom que o canal tinha postado a meia-noite.
    const idadeMs  = postadoEm ? Date.now() - postadoEm : 0;
    const idadeMin = Math.round(idadeMs / 60000);
    const atrasado = !!postadoEm && idadeMs > TG_IDADE_MAX_MS;
    if (atrasado) {
      console.warn(`[TG-BACKLOG] Mensagem de ${idadeMin} min atras — retida para aprovacao manual: ${texto.slice(0, 60)}`);
    }

    // Captura conta da PUBLICACAO, nao do momento em que o servidor conseguiu
    // ler. Sem isto o TTL de 24h renasce inteiro a cada replay e um cupom ja
    // vencido volta a figurar como vigente na base.
    if (postadoEm) {
      const isoPost = new Date(postadoEm).toISOString();
      for (const c of lista) if (!c.capturadoEm) c.capturadoEm = isoPost;
    }

    const ctxCupom = {
      origem: `telegram:@${canalUsername}`,
      textoOriginal: texto,
      imagens: imagemBase64 ? [{ imagemBase64, mime: 'image/jpeg' }] : [],
      tinhaMultiplos, codigosLista,
      somenteFila: atrasado,
      motivoRetencao: atrasado ? `retido: mensagem de ${idadeMin} min atras (backlog)` : null,
    };

    // Mensagem com varios cupons vira UMA mensagem no grupo, nao N. O canal
    // nao mistura lojas na mesma mensagem — a lista e sempre de uma loja so —,
    // entao o agrupamento sai por mensagem de origem. Se algum dia vier
    // misturada, cada loja vira seu proprio lote.
    if (lista.length > 1) {
      const porLoja = new Map();
      for (const c of lista) {
        const k = String(c.loja || 'sem-loja');
        if (!porLoja.has(k)) porLoja.set(k, []);
        porLoja.get(k).push(c);
      }
      for (const [loja, doLoja] of porLoja) {
        try {
          if (doLoja.length > 1) await enfileirarLoteCupomTSP(doLoja, ctxCupom);
          else await enfileirarCupomTSP(doLoja[0], ctxCupom);
        } catch (e) {
          console.error(`[TG] Falha no lote de ${loja}: ${e.message} — seguindo.`);
        }
      }
      return;
    }

    // try/catch POR ITEM: antes um cupom que estourasse derrubava o catch geral
    // e os seguintes da mesma mensagem nunca eram processados — perda silenciosa
    // proporcional ao tamanho da lista.
    for (const c of lista) {
      try {
        await enfileirarCupomTSP(c, ctxCupom);
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
// Corte do polling PERSISTIDO. Em memoria, um redeploy zerava o mapa e as 20
// ultimas mensagens do canal voltavam a valer como novas: foi assim que um
// cupom postado a meia-noite saiu nos grupos as 6h20 da manha.
const TG_ULTIMOS_IDS_PATH = SESSAO_DIR + '/tg_ultimos_ids.json';
// Acima disto a mensagem e backlog (reconexao/redeploy), nao noticia. Nao e
// descartada — vai para a fila como pendente, com o motivo visivel no card.
const TG_IDADE_MAX_MS = 45 * 60 * 1000;

function carregarUltimosMsgIds() {
  try {
    if (existsSync(TG_ULTIMOS_IDS_PATH)) {
      const m = JSON.parse(readFileSync(TG_ULTIMOS_IDS_PATH, 'utf-8'));
      console.log('[TG] Corte do polling carregado:', Object.keys(m).length, 'canal(is)');
      return m;
    }
  } catch (e) { console.warn('[TG] Erro ao carregar tg_ultimos_ids:', e.message); }
  return {};
}

function salvarUltimosMsgIds(mapa) {
  try {
    if (!existsSync(SESSAO_DIR)) mkdirSync(SESSAO_DIR, { recursive: true });
    escreverAtomico(TG_ULTIMOS_IDS_PATH, JSON.stringify(mapa), 'utf-8');
  } catch (e) { console.warn('[TG] Erro ao salvar tg_ultimos_ids:', e.message); }
}

// gramJS entrega msg.date em SEGUNDOS. Normaliza para ms e devolve null quando
// o campo nao vier — sem data, o gate de idade nao opina (comportamento atual).
function msgDateMs(msg) {
  const d = Number(msg?.date);
  if (!Number.isFinite(d) || d <= 0) return null;
  return d < 1e12 ? d * 1000 : d;
}
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

// ── CANAIS DO TELEGRAM COMO FONTE DO RADAR ───────────────────────────────────
// A aba Grupos do painel grava a fonte como 'tg:<channelId>' na trilha. O cache
// de entidades evita resolver o mesmo canal a cada polling; o de dialogos poupa
// o getDialogs (lento) a cada abertura da aba no painel.
const _tgEntidadesPorId = new Map();          // channelId (string) -> entity
let _tgCanaisCache = { ts: 0, canais: [] };   // resposta do GET /tg/canais
function tgFontesRadar() { return radarFontes().filter(j => j.startsWith('tg:')); }
async function _tgEntityPorId(cid) {
  if (_tgEntidadesPorId.has(cid)) return _tgEntidadesPorId.get(cid);
  if (!tgClient) return null;
  try {
    const ent = await tgClient.getInputEntity(Number(cid));
    _tgEntidadesPorId.set(cid, ent);
    return ent;
  } catch (e) { return null; }
}

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
  escreverAtomico(TG_SESSION_PATH, sessionSalva, 'utf-8');
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

  // Canais marcados como FONTE do radar no painel: mesma ativacao explicita,
  // resolvendo pelo channelId (a trilha grava 'tg:<id>', nao username).
  for (const tgFonte of tgFontesRadar()) {
    const cid = tgFonte.slice(3);
    try {
      const ent = await _tgEntityPorId(cid);
      if (!ent) { console.warn(`[TG] Fonte do radar ${tgFonte} nao resolvida — a conta segue este canal?`); continue; }
      await tgClient.getMessages(ent, { limit: 1 });
      console.log(`[TG] Canal fonte do radar ativo: ${tgFonte}`);
    } catch(e) { console.warn(`[TG] Falha ao ativar fonte do radar ${tgFonte}: ${e.message}`); }
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
  const _ultimosMsgIds = carregarUltimosMsgIds(); // channelId → último msgId processado
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
          salvarUltimosMsgIds(_ultimosMsgIds);
          // Verificar blacklist
          const bloqueado = _ignoradosIds.has(cid) ||
            TG_CANAIS_IGNORADOS_RAW().some(t => canal.includes(t));
          if (bloqueado) continue;
          // Checar deduplicação — evita reprocessar msg já capturada pelo NewMessage
          const dedupKeyPolling = `${cid}:${msg.id}`;
          if (_msgProcessadas.has(dedupKeyPolling)) continue;
          _msgProcessadas.set(dedupKeyPolling, Date.now());
          console.log(`[TG] Polling ACEITA @${canal} msgId=${msg.id}: ${msg.message.slice(0,60)}`);
          await processarMensagemTelegram(msg.message, canal, null, msgDateMs(msg));
        }
      } catch(e) { /* silencioso — canal pode estar temporariamente inacessível */ }
    }

    // Backstop das FONTES do radar no Telegram: mesmo corte por _ultimosMsgIds
    // e mesma deduplicacao do NewMessage, mas roteado direto para o radar de
    // marketplace — cupom destes canais ja e coberto pela captura geral.
    for (const tgFonte of tgFontesRadar()) {
      const cid = tgFonte.slice(3);
      try {
        const ent = await _tgEntityPorId(cid);
        if (!ent) continue;
        const msgs = await tgClient.getMessages(ent, { limit: 20 });
        for (const msg of msgs.reverse()) {
          if (!msg.message?.trim()) continue;
          const ultimoId = _ultimosMsgIds[cid] || 0;
          if (msg.id <= ultimoId) continue;
          _ultimosMsgIds[cid] = msg.id;
          salvarUltimosMsgIds(_ultimosMsgIds);
          const dedupKeyRadar = `${cid}:${msg.id}`;
          if (_msgProcessadas.has(dedupKeyRadar)) continue;
          _msgProcessadas.set(dedupKeyRadar, Date.now());
          console.log(`[TG-RADAR] Polling ACEITA ${tgFonte} msgId=${msg.id}: ${msg.message.slice(0,60)}`);
          ultimaCapturaPorGrupo.set(tgFonte, Date.now());
          registrarCapturaBruta(tgFonte, { key: { id: 'tg-' + msg.id },
            message: { telegram: { msgId: msg.id, temMidia: !!msg.media } } },
            msg.message, 'telegram-polling', false);
          await processarRadarMarketplace(tgFonte, msg.message, {});
        }
      } catch(e) { /* silencioso — canal pode estar temporariamente inacessivel */ }
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

      // Canal marcado como FONTE na aba Grupos do painel: alimenta o radar de
      // marketplace pela mesma esteira das fontes de WhatsApp — so muda a
      // origem. O pipeline de cupons abaixo segue valendo para o mesmo canal.
      const tgFonte = peerChannelId ? ('tg:' + peerChannelId) : null;
      if (tgFonte && ehFonteRadar(tgFonte)) {
        if (entity?.title) NOMES_GRUPOS.set(tgFonte, entity.title);
        ultimaCapturaPorGrupo.set(tgFonte, Date.now());
        registrarCapturaBruta(tgFonte, { key: { id: 'tg-' + msg.id },
          message: { telegram: { msgId: msg.id, temMidia: !!msg.media } } },
          texto, 'telegram', false);
        processarRadarMarketplace(tgFonte, texto, {})
          .catch(e => console.error('[TG-RADAR] Falha no pipeline:', e.message));
      }

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
      await processarMensagemTelegram(texto, username, imagemBase64, msgDateMs(msg));
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
    escreverAtomico(p, client.session.save(), 'utf-8');
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
        await comContextoTenant(tenantId, () => processarMensagemTelegram(texto, username || title, imagemBase64, msgDateMs(msg)));
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

// Prefixos dos avisos que o proprio servidor publica no grupo do operador.
// Ver filtro em processarMensagem: sem isto o sistema le os proprios recados.
const _EH_AVISO_DO_SISTEMA = /^\s*(\*?(Entrega suspeita|Cupom nao entregue|Envio manual nao entregue|Watchdog)|CRITICO —|OK — Watchdog|\u26a0\ufe0f Watchdog|Heartbeat)/;

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
      registrarDescarteCdv({ motivo: 'programa bloqueado',
        detalhe: r.programa + ' não alimenta a aba Alertas', dados: r });
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
      registrarDescarteCdv({ jid: mesclada.grupoOrigem, motivo: 'preço fora da curva',
        detalhe: precoForaDaCurva.ultimoDetalhe, dados: mesclada.dadosExtraidos,
        texto: mesclada.conteudoOriginal });
      return true; // consumido (descartado)
    }
    mesclada.mensagemFormatada = appendHistoricoMensagem(formatarMensagemCDV({ ...mesclada.dadosExtraidos }), hist180Par);
    mesclada.tipoConteudo = mesclada.imagens.length > 1 ? mesclada.imagens.length+' imagens' : mesclada.imagens.length === 1 ? 'imagem' : 'texto';
    entregarOfertaAlerta(mesclada, hist180Par);
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
            registrarDescarteCdv({ jid: oferta.grupoOrigem, motivo: 'preço fora da curva',
              detalhe: precoForaDaCurva.ultimoDetalhe, dados: oferta.dadosExtraidos,
              texto: oferta.conteudoOriginal });
            return;
          }
          if (hist180) oferta.mensagemFormatada = appendHistoricoMensagem(oferta.mensagemFormatada, hist180);
          entregarOfertaAlerta(oferta, hist180);
        })
        .catch(() => { entregarOfertaAlerta(oferta, null); });
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
    if (validas.length === 0) {
      console.log('Nenhuma oferta encontrada.');
      // O caso mais confuso de todos: a mensagem chegou, passou pela IA e não
      // virou nada. Sem este registro o alerta simplesmente some.
      for (const it of itens) {
        registrarDescarteCdv({ jid: grupoId, motivo: 'não reconhecido como emissão',
          detalhe: 'a extração não identificou rota/milhas neste conteúdo', texto: it.texto });
      }
      return;
    }

    const gruposMesclagem = new Set([GRUPO_APENAS_IMAGEM, GRUPO_EXECUTIVA, ...GRUPOS_TEXTO_ESTRUTURADO]);
    if (gruposMesclagem.has(grupoId)) {
      validas = mesclarParesIdaVolta(validas);
    }

    const minDatas = GRUPOS_FILTRO_DATAS_MIN[grupoId];
    if (minDatas) {
      const validasFiltradas = validas.filter(v => {
        const total = contarDatas(v.datasIda) + contarDatas(v.datasVolta);
        if (total <= minDatas) {
          console.log('   [FILTRO] Descartada por poucas datas ('+total+'): '+v.origemCodigo+'->'+v.destinoCodigo);
          registrarDescarteCdv({ jid: grupoId, motivo: 'poucas datas',
            detalhe: total + ' data(s), mínimo do grupo é ' + (minDatas + 1), dados: v });
          return false;
        }
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
          registrarDescarteCdv({ jid: grupoId, motivo: 'preço fora da curva',
            detalhe: precoForaDaCurva.ultimoDetalhe, dados, texto: textos });
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
          entregarOfertaAlerta(oferta, hist180Bypass);
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
        registrarDescarteCdv({ jid: grupoId, motivo: 'preço fora da curva',
          detalhe: precoForaDaCurva.ultimoDetalhe, dados: emissao, texto: textosFinal });
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
        entregarOfertaAlerta(oferta, hist180Normal);
      }
    }
  } catch (err) { console.error('Erro ao processar buffer:', err.message); }
}

// ── LISTENER WHATSAPP ─────────────────────────────────────────────────────────
// ── FILA SERIAL POR GRUPO ─────────────────────────────────────────────────────
// Garante que mensagens do mesmo grupo são processadas uma por vez, em ordem.
// Grupos diferentes processam em paralelo entre si.
const _filaGrupo = new Map(); // jid → Promise (última tarefa na fila)

// Dedup de mensagens ja processadas. Necessario desde que upserts 'append'
// (sync/reconexao) tambem alimentam o pipeline: a MESMA mensagem pode chegar
// como 'append' e depois como 'notify', e sem isto seria extraida duas vezes
// (duas chamadas de IA, duas ofertas na fila).
const _idsVistos = new Map();          // key.id -> timestamp
const IDS_VISTOS_TTL_MS = 15 * 60 * 1000;
const IDS_VISTOS_MAX    = 800;

function _jaProcessado(msg) {
  const id = msg?.key?.id;
  if (!id) return false;               // sem id nao da para deduplicar: deixa passar
  const agora = Date.now();
  if (_idsVistos.has(id)) return true;
  _idsVistos.set(id, agora);
  if (_idsVistos.size > IDS_VISTOS_MAX) {
    for (const [k, t] of _idsVistos) if (agora - t > IDS_VISTOS_TTL_MS) _idsVistos.delete(k);
    while (_idsVistos.size > IDS_VISTOS_MAX) {
      const k = _idsVistos.keys().next().value;
      _idsVistos.delete(k);
    }
  }
  return false;
}

// Buffer circular de diagnostico dos ultimos upserts recebidos (ver /debug-upserts).
const _debugUpserts = [];

// Contagem de "Aguardando mensagem" RECEBIDOS (messageStubType === 2). E a
// forma silenciosa de indecifravel: nao lanca excecao de decodificacao, entao
// errosDescripto nunca ve — em 28/08/2026 o /status jurava errosDecodificacao=0
// enquanto 4 de 5 stubs no buffer vinham justo de grupo monitorado/fonte do
// radar. Distingue "nao recebo nada" (surdez de transporte) de "recebo e nao
// leio" (chaveiro quebrado — em geral autoinfligido por reset de sessao).
const _stub2PorGrupo = new Map();   // jid -> { n, ultimaEm }
let _stub2Total = 0;

// jid -> nome do grupo. Preenchido sob demanda para o painel mostrar de onde
// veio cada oferta sem depender de uma chamada extra ao WhatsApp.
const NOMES_GRUPOS = new Map();
// As regras de afiliado por prefixo de nome (config_tsp.afiliados.regrasPorNome)
// precisam do nome do grupo, que so existe aqui. Registrado uma vez: o mapa e
// mutavel, entao a config sempre le o cache mais recente.
registrarResolvedorDeNome((jid) => NOMES_GRUPOS.get(jid) || '');

// Cache alimentado por TODAS as contas leitoras, nao so pela principal: com
// leitura separada, um grupo pode ser visto apenas pela secundaria, e sem isto
// ele apareceria sem nome em toda tela do ecossistema.
async function atualizarNomesGrupos() {
  const fontes = [];
  if (sock && conectado) fontes.push({ id: 'principal', sock });
  for (const id of contasLeitorasAtivas()) {
    if (id === 'principal') continue;
    const ct = contasExtras.get(id);
    if (ct?.conectado && ct.sock) fontes.push({ id, sock: ct.sock });
  }
  if (!fontes.length) return;
  let lidas = 0;
  for (const f of fontes) {
    try {
      const chats = await f.sock.groupFetchAllParticipating();
      for (const g of Object.values(chats)) NOMES_GRUPOS.set(g.id, g.subject || '(sem nome)');
      lidas++;
    } catch (e) {
      console.warn('[GRUPOS] Falha ao ler grupos de ' + f.id + ':', e.message);
    }
  }
  console.log('[GRUPOS] Cache de nomes atualizado — ' + NOMES_GRUPOS.size
    + ' grupo(s), de ' + lidas + '/' + fontes.length + ' conta(s) leitora(s).');
}

// ── LEITURA POR OPERACAO ─────────────────────────────────────────────────────
// Ate esta versao havia UM socket com handler de mensagens: a conta principal
// lia tudo — grupos monitorados do CDV e grupos-fonte do radar do TSP. As
// secundarias subiam de proposito sem handler, porque estavam nos MESMOS
// grupos e processar em duas dobraria o pipeline inteiro (inclusive as
// chamadas de IA) para publicar a mesma coisa.
//
// Agora cada operacao declara sua conta leitora, escolhida do mesmo pool de
// contas pareadas. O motivo do bloqueio deixa de valer porque existe DONO: a
// conta que recebeu a mensagem so a processa se for a leitora daquele grupo.
// Duas contas no mesmo grupo continuam sem duplicar — uma ignora.
//
// Fora dos dois conjuntos (conversa direta, bot, resposta de campanha) a
// principal segue sendo a unica leitora. Nao ha operacao dona dessas mensagens
// e mudar isso quebraria a campanha e o bot sem nenhum ganho.

function _idDaConta(apelido) {
  const a = String(apelido || '').trim();
  if (!a || a === 'principal') return 'principal';
  return contaIdDe(TENANT_PADRAO, a);
}

function _leitorVivo(id) {
  if (id === 'principal') return !!(conectado && sock);
  const ct = contasExtras.get(id);
  return !!(ct?.conectado && ct.sock);
}

/**
 * Qual conta deve processar mensagens deste grupo AGORA.
 *
 * A leitora configurada que estiver fora do ar devolve a leitura para a
 * principal: um grupo cego perde ofertas para sempre, enquanto ser lido pelo
 * numero "errado" nao muda nada do que chega ao assinante — a leitura nao
 * aparece para ninguem.
 */
function contaLeitoraDe(jid) {
  const j = String(jid || '');
  let desejada = null;
  if (ehMonitoradoCdv(j))      desejada = _idDaConta(contaLeitoraCdv());
  else if (ehFonteRadar(j))    desejada = _idDaConta(contaLeitoraTsp());
  else                         return 'principal';
  if (desejada !== 'principal' && !_leitorVivo(desejada)) return 'principal';
  return desejada;
}

/** Contas configuradas como leitoras (independente de estarem vivas). */
function contasLeitorasAtivas() {
  return [...new Set([_idDaConta(contaLeitoraCdv()), _idDaConta(contaLeitoraTsp())])];
}

// Pulso de inbound POR conta leitora. O watchdog historico vigia um unico
// _health.ultimoUpsertEm: com leitura separada, o numero do CDV poderia ficar
// surdo por horas enquanto o do TSP recebe normalmente — e a escada de
// autocura nunca dispararia, porque o pulso global continuaria vivo. Silencio
// que parece saude e a pior falha possivel aqui.
const _pulsoLeitores = new Map();   // contaId -> timestamp do ultimo inbound
function registrarPulsoLeitor(id) { _pulsoLeitores.set(id, Date.now()); }

// Ponto unico de entrada no pipeline, para principal e secundarias. A guarda de
// dono fica AQUI e nao dentro de processarMensagem, porque o dedup por key.id e
// global: se as duas contas estiverem no mesmo grupo, a que nao e dona precisa
// desistir ANTES de marcar o id como visto, senao ela consumiria a mensagem da
// outra e o grupo ficaria sem processamento nenhum.
async function despacharParaPipeline(msg, ctx) {
  const jid = msg.key?.remoteJid;
  if (contaLeitoraDe(jid) !== ctx.contaId) return false;
  if (_jaProcessado(msg)) return false;
  if (jid) enfileirarPorGrupo(jid, () => processarMensagem(msg, ctx));
  else await processarMensagem(msg, ctx);
  return true;
}

// Contexto da principal: `sock` e reatribuido a cada reconexao, entao precisa
// ser getter — guardar a referencia congelaria um socket morto.
const CTX_PRINCIPAL = { contaId: 'principal', get sock() { return sock; } };

// Arquivos de ./sessao que sobrevivem a um reset completo: nao sao credenciais
// do WhatsApp e nao se regeneram sozinhos. Ao criar um arquivo novo nessa pasta,
// avaliar se ele pertence a esta lista.
const PRESERVAR_NO_RESET = new Set([
  'fila_pendentes.json',    // fila de aprovacao
  'agendamentos.json',      // envios agendados
  'telegram_session.txt',   // sessao do Telegram (independente do WhatsApp)
  'ml_token.json',          // OAuth da API oficial do ML (refresh token) — sem ele o fallback de preco volta a "nao autorizado"
  'cupons_base.json',       // base de cupons — cadastro manual/capturado
  'radar_config.json',      // papeis fonte/destino dos grupos do radar
  'config_tsp.json',        // config da operacao (afiliados, rodapes, grupos)
  'config_cdv.json',        // config do CDV (destinos, monitorados, admins, conta)
  'tenants.json',           // registro dos operadores do modelo hospedado
  'cupons_vistos.json',     // dedup de cupons
  'radar_vistos.json',      // dedup do radar
  'msgs-enviadas.json',     // dedup de mensagens enviadas
  'publicadas.json',        // historico da vitrine publica
  'rastreio.json',          // ledger ref -> produto (rastreio de desempenho)
  'health.json',            // marcos de saude do inbound (regua do watchdog)
  'capturas_brutas.json',   // diario cru das capturas do radar (diagnostico)
  'alertas.json',           // central de alertas (tela + historico)
  'pulso_lojas.json',       // ultima oferta por loja (alerta de plataforma parada)
  'categorias.json',        // taxonomia de categorias (grupos de nicho)
  'categorias_cache.json',  // cache asin -> trilha de categoria
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
// Miniatura que o post do grupo-fonte ja trazia no proprio card de link. E a
// unica foto disponivel quando a pagina do produto esta sob antibot e a API
// oficial nao devolve imagem — caso dos catalogos unificados (MLBU) do Mercado
// Livre, que em 26/08 passaram a sair sem card nenhum.
const THUMB_FONTE_MAX_BYTES = 60 * 1024;

function miniaturaDaMensagem(m) {
  const ext = m?.extendedTextMessage;
  if (!ext?.jpegThumbnail) return null;
  try {
    const buf = Buffer.from(ext.jpegThumbnail);
    if (!buf.length || buf.length > THUMB_FONTE_MAX_BYTES) return null;
    // JPEG de verdade: buffer com outro formato rotulado como jpegThumbnail faz
    // o cliente descartar o card inteiro (mesma regra de miniaturaDoPreview).
    if (!(buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF)) return null;
    return { base64: buf.toString('base64'), url: ext.matchedText || ext.canonicalUrl || null };
  } catch (e) { return null; }
}

// ── DIARIO DE CAPTURAS BRUTAS DO RADAR ──────────────────────────────────────
// Guarda o payload como o Baileys entregou, ANTES de qualquer interpretacao
// nossa. Existe porque em 26/08 uma oferta saiu sem o cupom que o print do
// grupo mostrava, e nao havia como decidir entre "o texto chegou incompleto",
// "foi edicao de mensagem" ou "erro nosso" — o texto interpretado era a unica
// evidencia, e ela e justamente a que estava sob suspeita. Anel de 200: e
// diagnostico, nao historico.
const CAPTURAS_PATH = SESSAO_DIR + '/capturas_brutas.json';
const CAPTURAS_MAX  = 200;
let capturasBrutas = [];

// Corta binario e texto longo: jpegThumbnail sozinho estoura o arquivo, e o que
// interessa aqui e a ESTRUTURA da mensagem, nao a midia.
function _podarPayload(_chave, valor) {
  if (typeof valor === 'string' && valor.length > 400) return valor.slice(0, 400) + '…[' + valor.length + ']';
  if (valor && valor.type === 'Buffer' && Array.isArray(valor.data)) return '[buffer ' + valor.data.length + 'B]';
  return valor;
}

function carregarCapturasBrutas() {
  try {
    if (existsSync(CAPTURAS_PATH)) capturasBrutas = JSON.parse(readFileSync(CAPTURAS_PATH, 'utf-8')) || [];
  } catch (e) { capturasBrutas = []; }
}
carregarCapturasBrutas();

function registrarCapturaBruta(jid, msg, texto, tipo, ehEdicao) {
  try {
    capturasBrutas.unshift({
      em: new Date().toISOString(),
      jid, grupo: NOMES_GRUPOS.get(jid) || null,
      msgId: msg?.key?.id || null,
      edicao: !!ehEdicao,
      tipo: tipo || null,
      // Texto EXATAMENTE como sera entregue ao pipeline, com escapes visiveis.
      texto: String(texto || ''),
      // Estrutura crua: as chaves que o Baileys entregou, sem midia.
      payload: JSON.parse(JSON.stringify(msg?.message || {}, _podarPayload)),
    });
    if (capturasBrutas.length > CAPTURAS_MAX) capturasBrutas.length = CAPTURAS_MAX;
    escreverAtomico(CAPTURAS_PATH, JSON.stringify(capturasBrutas), 'utf-8');
  } catch (e) { /* diagnostico nunca segura a captura */ }
}

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

async function avisarCupomDesconhecido(loja, codigos, p, jid, foiParaFila = false) {
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
    + (foiParaFila
        ? 'A oferta foi para a fila de aprovação — pelo preço cheio ela não sai sem revisão. '
          + 'Cadastre o cupom na base antes de aprovar para o radar aplicar o desconto.'
        : 'Outro cupom da base já cobriu esta oferta. Cadastre o citado para o radar '
          + 'considerar nas próximas.');

  try {
    await registrarAlerta({
      nivel: foiParaFila ? 'atencao' : 'info', origem: 'radar',
      chave: 'cupom-sem-base:' + loja + ':' + novos.join(','),
      titulo: 'Cupom citado fora da base — ' + loja + ' (' + novos.join(', ') + ')',
      corpo: texto, ofertaId: p?.id || null,
    });
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

async function avisarCupomAnuncioSemBase(aviso, p, jid, foiParaFila = false) {
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
    + (foiParaFila
        ? 'A oferta foi para a fila de aprovação: o anúncio confirma o desconto, mas sem o '
          + 'código na base não há o que passar ao membro. Rode /ml/sync-cupons-conta '
          + 'para importar os cupons da conta com código e campanha.'
        : 'Outro cupom da base já cobriu esta oferta. Rode /ml/sync-cupons-conta '
          + 'para importar os cupons da conta com código e campanha.');

  try {
    await registrarAlerta({
      nivel: foiParaFila ? 'atencao' : 'info', origem: 'radar',
      chave: 'cupom-anuncio:' + (aviso.idCampanhaLoja || aviso.percentual),
      titulo: 'Cupom no anúncio fora da base — ' + aviso.percentual,
      corpo: texto, ofertaId: p?.id || null,
    });
    console.log('[CUPOM-ANUNCIO] ' + aviso.percentual + ' campanha ' + (aviso.idCampanhaLoja || '—'));
  } catch (e) { console.error('[CUPOM-ANUNCIO] Falha ao avisar operador:', e.message); }
}

// ── PRECO DECLARADO NO POST x PRECO QUE VAMOS PUBLICAR ──────────────────────
// O grupo-fonte escreve o preco que o comprador realmente paga. Se o nosso
// calculo fica bem acima dele, alguma condicao nao foi capturada — cupom que
// nao chegou no texto, campanha do anuncio que a pagina nao entregou, preco que
// mudou entre o post e a leitura. Em 26/08 o post dizia R$ 2.971,59 e saiu
// R$ 3.399,99 para 30 grupos sem que nada reclamasse.
//
// Calibrado contra as capturas reais do dia: piso de 10% e a faixa util. Abaixo
// disso o ruido domina (desconto Pix de 5%, 'de' desatualizado no post) e o
// gate reteria uma oferta em cada cinco. Divergencia maior que 60% quase sempre
// e outro numero no texto (frete, parcela, brinde), nao o preco do produto.
const DIVERGENCIA_PRECO_MIN = 0.10;
const DIVERGENCIA_PRECO_MAX = 0.60;

// Condicoes que EXPLICAM um preco menor no post sem haver cupom nenhum. Post de
// recorrencia da Amazon anuncia o valor com 'Programe e Poupe' aplicado; cobrar
// alarme disso seria alarme diario e o operador para de ler.
const RE_PRECO_EXPLICADO = /programe e poupe|recorr[êe]ncia|assinatur|assine|primeira compra|1[ªa]\s*compra|cashback|clube/i;

function precosDeclaradosNoTexto(texto) {
  // Parcela nunca e preco do produto: '12x de R$ 99' viraria divergencia de 90%.
  const limpo = String(texto || '').replace(/\d+\s*x\s*(?:de\s*)?R\$\s*[\d.]+,?\d*/gi, ' ');
  return [...limpo.matchAll(/R\$\s*([\d.]{1,12},\d{2}|\d{2,7})(?![\d,])/gi)]
    .map(m => Number(m[1].replace(/\./g, '').replace(',', '.')))
    .filter(v => Number.isFinite(v) && v > 0);
}

/**
 * Divergencia relevante entre o preco do post e o que vamos publicar, ou null.
 * So olha ofertas SEM cupom aplicado: quando o cupom entrou, a diferenca que
 * sobra e desconto de meio de pagamento, e ai o post e que esta otimista.
 */
function divergenciaPrecoPost(texto, precoFinal, temCupom) {
  if (temCupom) return null;
  const final = Number(precoFinal);
  if (!Number.isFinite(final) || final <= 0) return null;
  if (RE_PRECO_EXPLICADO.test(String(texto || ''))) return null;
  const declarados = precosDeclaradosNoTexto(texto);
  if (!declarados.length) return null;
  const declarado = Math.min(...declarados);
  const queda = 1 - declarado / final;
  if (queda < DIVERGENCIA_PRECO_MIN || queda > DIVERGENCIA_PRECO_MAX) return null;
  return {
    declarado, calculado: Math.round(final * 100) / 100,
    diferencaPct: Math.round(queda * 1000) / 10,
  };
}

const AVISOS_PRECO_DIVERGENTE = new Map();
const AVISO_PRECO_DIVERGENTE_TTL_MS = 6 * 3600e3;

async function avisarPrecoDivergente(div, p, jid) {
  const chave = 'div:' + (p.asin || p.titulo || '?');
  const agora = Date.now();
  const visto = AVISOS_PRECO_DIVERGENTE.get(chave);
  if (visto && agora - visto < AVISO_PRECO_DIVERGENTE_TTL_MS) return;
  AVISOS_PRECO_DIVERGENTE.set(chave, agora);

  const brl = (v) => 'R$ ' + Number(v).toFixed(2).replace('.', ',');
  const grupo = jid ? (NOMES_GRUPOS.get(jid) || jid.split('@')[0]) : '—';
  const texto = '💸 *Post anuncia preço menor que o nosso*\n\n'
    + '*Oferta* ' + (p.titulo || p.asin || '—') + '\n'
    + '*No post* ' + brl(div.declarado) + '\n'
    + '*Nosso cálculo* ' + brl(div.calculado) + ' (' + div.diferencaPct + '% acima)\n'
    + (p.link ? '*Link* ' + p.link + '\n' : '')
    + '*Grupo de origem* ' + grupo + '\n\n'
    + 'Nenhum cupom foi aplicado nesta oferta. Provável cupom ou condição que não '
    + 'chegou no texto capturado. Ela está na fila de aprovação e não auto-envia.';

  try {
    await registrarAlerta({
      nivel: 'atencao', origem: 'radar', chave: chave,
      titulo: 'Post anuncia R$ ' + div.declarado + ' e calculamos R$ ' + div.calculado,
      corpo: texto, ofertaId: p?.id || null,
    });
    console.log('[PRECO-DIV] ' + (p.asin || '?') + ' — post ' + div.declarado + ' x nosso ' + div.calculado);
  } catch (e) { console.error('[PRECO-DIV] Falha ao avisar operador:', e.message); }
}

// ── CUPOM ML CITADO FORA DA BASE: TENTAR INCORPORAR ANTES DO PIPELINE ────────
// Regra da operacao: oferta de grupo com cupom que a base nao conhece NAO sai
// pelo preco cheio. Para o ML da para resolver sozinho: ativa o codigo na conta
// (mesmo canal do botao "Inserir codigo"), le a regra (tipo, valor, minimo,
// teto) na pagina de cupons e grava na base ANTES do processarTextoMl rodar —
// que entao aplica o desconto e formata a mensagem normalmente. Se qualquer
// etapa falhar, o codigo continua fora da base e a oferta cai para a fila de
// aprovacao pelo gate de auto-envio (cupomForaDaBase).
//
// Throttle de 30 min por codigo: o mesmo cupom aparece em dezenas de posts no
// mesmo dia, e reativar/reler a pagina a cada mensagem estouraria o limite de
// taxa do ML (o sync horario ja usa espera de 2,5s por chamada).
const _TENTATIVAS_CUPOM_ML = new Map();
const TENTATIVA_CUPOM_ML_TTL_MS = 30 * 60 * 1000;

async function incorporarCupomMlDesconhecido(texto) {
  const codigos = cupomCitadoDesconhecido('Mercado Livre', texto);
  if (!codigos.length) return;
  if (!tokenAffOk()) {
    console.warn('[CUPONS-ML] Cupom citado fora da base (' + codigos.join(', ')
      + ') mas o token de afiliados esta fora do ar — oferta vai para aprovacao.');
    return;
  }

  const agora = Date.now();
  const ativados = [];
  for (const codigo of codigos) {
    const visto = _TENTATIVAS_CUPOM_ML.get(codigo);
    if (visto && agora - visto < TENTATIVA_CUPOM_ML_TTL_MS) continue; // tentativa recente falhou
    _TENTATIVAS_CUPOM_ML.set(codigo, agora);
    let r = null;
    try { r = await ativarCupomMl(codigo); }
    catch (e) { console.warn('[CUPONS-ML] Falha ao ativar ' + codigo + ' na captura do radar:', e.message); }
    if (r && (r.ok || r.jaTinha)) ativados.push(codigo);
    else if (r) console.warn('[CUPONS-ML] ' + codigo + ' recusado na captura do radar: '
      + (r.mensagem || r.status || 'sem detalhe') + ' — oferta vai para aprovacao.');
    if (codigos.length > 1) await new Promise(r2 => setTimeout(r2, 2500));
  }
  if (!ativados.length) return;

  // A ativacao so confirma que o codigo existe; a regra (percentual, minimo,
  // teto, validade) vem da pagina de cupons da conta.
  let pagina = null;
  try { pagina = await lerTodosCuponsMl(); }
  catch (e) {
    console.warn('[CUPONS-ML] Ativei ' + ativados.join(', ') + ' mas nao consegui ler a regra: '
      + e.message + ' — oferta vai para aprovacao.');
    return;
  }
  const porCodigo = new Map((pagina.cupons || []).map(x => [String(x.codigo).toUpperCase(), x]));
  for (const codigo of ativados) {
    const card = porCodigo.get(codigo);
    if (!card || card.valor == null) {
      console.warn('[CUPONS-ML] ' + codigo + ' ativado, mas a pagina nao mostrou a regra — oferta vai para aprovacao.');
      continue;
    }
    let reg = null;
    try { reg = registrarCupomBase({ loja: 'Mercado Livre', ...card, confirmadoNoMl: true }); }
    catch (e) { console.warn('[CUPONS-ML] Falha ao gravar ' + codigo + ' na base:', e.message); continue; }
    // Mesmo fallback do sync: card "esgotando" nao traz prazo, e cupom recem-
    // lido da conta nao pode nascer com validade menor que a do proprio card.
    const validade = card.expiraEm || validadeDeTexto(card.venceTexto) || validadeDeTexto('amanha');
    if (validade && reg) { try { atualizarCupomBase(reg.chave, { validadeAte: validade }); } catch (e) {} }
    console.log('[CUPONS-ML] ' + codigo + ' incorporado na captura do radar — '
      + card.valor + (card.tipo === 'pct' ? '%' : ' R$')
      + (card.minimo != null ? ', min R$ ' + card.minimo : '')
      + (card.limite != null ? ', teto R$ ' + card.limite : '') + '.');
  }
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

/**
 * Doa para a serie de precos o que uma leitura fora da janela encontrou.
 *
 * Duas coisas que esta funcao NAO faz, de proposito:
 *   1. nao chama registrarVisto() — o dedup e do DISPARO. Se a leitura das 03h
 *      marcasse o produto como visto, ele entraria na janela das 09h ja
 *      descartado, e a leitura teria custado uma divulgacao.
 *   2. nao enfileira nem avalia gatilho — leitura e so leitura.
 */
async function lerPrecosParaSerie(produtos, jid, motivo) {
  let gravados = 0, freados = 0;
  for (const p of produtos || []) {
    if (!p?.asin || !Number.isFinite(p.preco)) continue;
    const freio = podeLerPreco(p);
    if (!freio.ok) { freados++; continue; }
    registrarLeitura(p);
    try {
      registrarLeituraPreco(p.asin, {
        nome: p.titulo, loja: p.loja, preco: p.preco,
        precoDe: p.precoDe ?? null, disponivel: p.disponivel !== false,
      });
      gravados++;
    } catch (e) { console.warn('[LEITURA] Falha ao gravar serie de ' + p.asin + ':', e.message); }
  }
  if (gravados || freados) {
    console.log('[LEITURA] ' + jid.split('@')[0] + ' (' + motivo + ') — '
      + gravados + ' preco(s) na serie' + (freados ? ', ' + freados + ' freado(s)' : '') + '.');
  }
  return { gravados, freados };
}

// ── ENCURTADORES GENERICOS ────────────────────────────────────────────────────
// Canal de oferta costuma mascarar o destino num encurtador proprio (cutt.ly,
// bit.ly...). Nenhum ehLink*() casa com esse dominio, entao a mensagem inteira
// morria em silencio no radar: sem pipeline, sem log, sem motivo. Um canal do
// Telegram usado como fonte chegou a perder ~45% dos posts assim. Aqui a URL
// curta e resolvida ANTES do roteamento e o texto segue para os gates de loja
// ja com o destino no lugar dela.
//
// Encurtador DE LOJA (meli.la, amzn.to, s.shopee) NAO entra nesta lista: cada
// pipeline ja sabe resolver o seu, com pausa e cuidado de antibot proprios.
const ENCURTADORES_GENERICOS = /^(?:www\.)?(cutt\.ly|bit\.ly|tinyurl\.com|is\.gd|t\.ly|rebrand\.ly|ow\.ly|shorturl\.at|encurtador\.com\.br|l1nq\.com|acesse\.one|shre\.ink|encr\.pw|goo\.su|abrir\.link)$/i;
const _cacheEncurtador = new Map();          // url curta -> { destino, em }
const ENCURTADOR_TTL_MS = 24 * 60 * 60 * 1000;
const ENCURTADOR_CACHE_MAX = 500;

function _hostSemWww(u) {
  try { return new URL(u).hostname.replace(/^www\./i, '').toLowerCase(); }
  catch (e) { return ''; }
}

async function resolverEncurtadorGenerico(url) {
  const emCache = _cacheEncurtador.get(url);
  if (emCache && Date.now() - emCache.em < ENCURTADOR_TTL_MS) return emCache.destino;
  let destino = null;
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      signal: AbortSignal.timeout(8000),
    });
    destino = res.url || null;
    // Encurtador que entrega HTML com meta refresh ou JS nao move res.url — o
    // destino real esta no corpo.
    if (destino && _hostSemWww(destino) === _hostSemWww(url)) {
      const corpo = await res.text().catch(() => '');
      const m = corpo.match(/(?:url=|location(?:\.href)?\s*=\s*)["']?(https?:\/\/[^"'\s>]+)/i);
      destino = m ? m[1] : null;
    }
    if (destino && (!/^https?:\/\//i.test(destino) || _hostSemWww(destino) === _hostSemWww(url))) destino = null;
  } catch (e) {
    console.warn('[ENCURTADOR] Nao resolveu ' + url + ': ' + e.message);
  }
  if (_cacheEncurtador.size >= ENCURTADOR_CACHE_MAX) {
    _cacheEncurtador.delete(_cacheEncurtador.keys().next().value);
  }
  _cacheEncurtador.set(url, { destino, em: Date.now() });
  return destino;
}

async function expandirEncurtadores(texto) {
  const urls = String(texto || '').match(/https?:\/\/[^\s<>"')]+/g) || [];
  const alvos = [...new Set(urls.filter(u => ENCURTADORES_GENERICOS.test(_hostSemWww(u))))];
  if (!alvos.length) return texto;
  let saida = texto;
  for (const curta of alvos) {
    const destino = await resolverEncurtadorGenerico(curta);
    if (!destino) continue;
    console.log('[ENCURTADOR] ' + curta + ' -> ' + destino.slice(0, 140));
    saida = saida.split(curta).join(destino);
  }
  return saida;
}

async function processarRadarMarketplace(jid, texto, opcoes = {}) {
  if (!texto) return;

  // Encurtador generico esconde a loja de destino de todos os gates abaixo.
  texto = await expandirEncurtadores(texto);

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
    if (podeAmazon.modo === 'leitura' && leituraForaJanelaAtiva()) {
      // O pipeline da Amazon nao gera link de afiliado (a tag e aplicada depois,
      // no envio), entao ele ja serve de leitura sem nenhuma adaptacao.
      try {
        const lidos = await processarTextoAmazon(texto);
        // Em modo sem API o preco vem do texto do grupo. Alimentar a serie com
        // numero digitado por terceiro envenenaria a mediana — mesma razao pela
        // qual Magalu e Awin nunca entram. So le quando veio da API.
        // Amazon esta fora da vigilancia de precos neste momento: a leitura fora
        // da janela nao tem serie para alimentar.
        await lerPrecosParaSerie([], jid, podeAmazon.motivo);
      } catch (e) { console.warn('[LEITURA] Amazon:', e.message); }
    } else {
      console.log('[MONITOR] Amazon ignorada em ' + jid.split('@')[0] + ' — ' + podeAmazon.motivo);
    }
  }

  if (ehLinkMl(texto)) {
    const podeMl = podeCapturar(jid, 'Mercado Livre');
    if (!podeMl.ok && podeMl.modo === 'leitura' && leituraForaJanelaAtiva() && credenciaisMlOk()) {
      // Fora da janela: le preco e alimenta a serie, mas NAO gera link nem
      // enfileira. Sem incorporar cupom — cupom so importa para quem vai sair.
      try {
        const lidos = await processarTextoMl(texto, { leitura: true });
        await lerPrecosParaSerie(lidos.map(r => r.produto), jid, podeMl.motivo);
      } catch (e) { console.warn('[LEITURA] ML:', e.message); }
    } else if (!podeMl.ok) {
      console.log('[MONITOR] ML ignorado em ' + jid.split('@')[0] + ' — ' + podeMl.motivo);
    } else if (!credenciaisMlOk()) {
      console.warn('[ML] Link detectado mas ML_CLIENT_ID/ML_CLIENT_SECRET nao configurados.');
    } else {
      // Cupom ML citado que a base nao conhece: tentar ativar na conta e gravar
      // a regra ANTES do pipeline, para a oferta ja sair com o desconto.
      try { await incorporarCupomMlDesconhecido(texto); }
      catch (e) { console.warn('[CUPONS-ML] Incorporacao de cupom citado falhou:', e.message); }
      try { resultados.push(...await processarTextoMl(texto)); }
      catch (e) { console.error('[ML] Falha no pipeline:', e.message); }
    }
  }

  // Magalu e Awin NAO tem modo leitura, e nao e omissao. O preco delas nao vem
  // de API: o da Magalu e extraido do TEXTO do grupo (por isso a flag
  // precoDeReferencia) e o da Awin so se conhece no momento do disparo. Alimentar
  // a serie com numero digitado por terceiro em mensagem de WhatsApp envenenaria
  // a mediana justamente na estatistica que existe para NAO depender do 'de'
  // declarado. E a mesma razao pela qual LOJAS_MONITORAVEIS_PRECO ja exclui as
  // duas do monitor de precos — ler sem poder confiar na leitura nao e ler.
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
    if (!podeShopee.ok && podeShopee.modo === 'leitura' && leituraForaJanelaAtiva() && credenciaisShopeeOk()) {
      try {
        const lidos = await processarTextoShopee(texto, { leitura: true });
        await lerPrecosParaSerie(lidos.map(r => r.produto), jid, podeShopee.motivo);
      } catch (e) { console.warn('[LEITURA] Shopee:', e.message); }
    } else if (!podeShopee.ok) {
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
    const lojaAwin = String(prog?.name || 'Awin').replace(/\s*\(?(BR(\s*&\s*LATAM)?|LATAM|Global)\)?\s*$/i, '').trim();
    const podeAwin = podeCapturar(jid, lojaAwin);
    if (!podeAwin.ok) {
      console.log('[MONITOR] ' + lojaAwin + ' ignorada em ' + jid.split('@')[0] + ' — ' + podeAwin.motivo);
    } else {
      try { resultados.push(...await processarTextoAwin(texto, { clickref: 'grupo' })); }
      catch (e) { console.error('[AWIN] Falha no pipeline:', e.message); }
    }
  }

  if (!resultados.length) {
    // Ate aqui o descarte era mudo. Sem o dominio no log nao da para saber se a
    // mensagem nao tinha link, se a loja e desconhecida ou se um encurtador
    // novo entrou em cena.
    const _doms = [...new Set((String(texto).match(/https?:\/\/[^\/\s]+/g) || [])
      .map(u => u.replace(/^https?:\/\//i, '')))];
    if (_doms.length) {
      console.log('[MKT] ' + String(jid).split('@')[0] + ' — nenhum pipeline reconheceu o link: ' + _doms.join(', '));
    }
    return;
  }

  // A miniatura do post so pode virar reserva quando a mensagem trata de UM
  // produto: com dois links no mesmo texto, o card do post e de um deles e a
  // foto sairia trocada na outra oferta.
  const _umProdutoSo = resultados.filter(x => x.mensagem).length === 1;

  for (const r of resultados) {
    if (!r.mensagem) {
      console.log('[MKT] ' + (r.produto?.asin || r.produto?.itemId || '?') + ' descartado — ' + r.descartadoPor);
      // Descarte por antibot nao e do produto: o operador precisa saber que o
      // radar ML esta cego, nao que um item ficou sem preco.
      if (/antibot/i.test(r.descartadoPor || '')) avisarAntibotMl(r.descartadoPor).catch(() => {});
      continue;
    }
    const p = r.produto;

    // ── SERIE DE PRECOS ───────────────────────────────────────────────────
    // Dentro da janela tambem se le: o dado ja esta na mao, e a serie fica com
    // pontos intradiarios que a varredura horaria sozinha nao pega.
    try {
      // p.semApi: preco lido do texto do grupo, nao de fonte verificavel.
      // Amazon: leitura de catalogo restrita a montagem da oferta — nao alimenta
      // serie (ver LOJAS_MONITORAVEIS_PRECO em monitor-precos.js).
      if (!p.semApi && p.loja !== 'Amazon') {
        registrarLeituraPreco(p.asin, {
          nome: p.titulo, loja: p.loja, preco: p.preco,
          precoDe: p.precoDe ?? null, disponivel: p.disponivel !== false,
        });
      }
    } catch (e) { /* serie e conveniencia: nunca segura o pipeline */ }

    // ── GATE CENTRAL: DEDUP + PISO DE DESCONTO ────────────────────────────
    // Estes dois gates sairam dos pipelines de loja com a promessa de subirem
    // para ca e NUNCA subiram: jaDivulgado/registrarVisto ficaram exportados e
    // sem nenhum chamador, radar_vistos.json nunca foi escrito, e
    // 'descontoMinimo'/'dedupHoras' seguiam editaveis em tela sem fazer nada.
    // O custo apareceu em 21/08: 7 pares do mesmo produto ML sairam para os
    // mesmos 22 grupos com 2 a 4 minutos de intervalo.
    // Edicao passa pelo dedup de proposito: a versao corrigida do post e
    // justamente a que traz o cupom/preco que faltava, e jaDivulgado() compara
    // preco BRUTO — cupom novo nao muda o preco de tabela, entao a correcao
    // seria descartada em silencio. Ela nunca auto-envia: vai para aprovacao.
    if (jaDivulgado(p) && !opcoes.edicao) {
      console.log('[MKT] ' + (p.asin || '?') + ' descartado — ja divulgado nas ultimas '
        + horasDedup() + 'h (' + (p.titulo || '').slice(0, 50) + ')');
      continue;
    }
    const _pisoDesc = descontoMinimoRadar();
    // O piso media so a etiqueta da loja (precoDe -> p.desconto). Sob ML_SO_API
    // a pagina do ML nao e aberta e a API oficial quase nunca traz
    // original_price: precoDe vem null, p.desconto vem 0 e TODA oferta do ML era
    // descartada aqui — inclusive as que tinham 10-15% de cupom vigente na base.
    // Foi o que zerou o ML em 30/08 (antibot na pagina desde 27/08 16:18).
    // O desconto do cupom so existe em r.precoFinal, calculado ANTES deste gate
    // mas nunca lido por ele. Agora as duas medidas sao comparadas e vence a
    // maior: etiqueta da loja OU preco final com cupom. O piso continua o mesmo,
    // e teto de cupom (calcularDesconto) entra no calculo — item caro com cupom
    // de teto baixo segue barrado, como deve.
    const _descEfetivo = (Number(p.preco) > 0 && Number(r.precoFinal) > 0 && r.precoFinal < p.preco)
      ? Math.round((1 - r.precoFinal / p.preco) * 100) : 0;
    const _descGate = Math.max(Number(p.desconto || 0), _descEfetivo);
    if (!p.ehDeal && _descGate < _pisoDesc) {
      console.log('[MKT] ' + (p.asin || '?') + ' descartado — desconto '
        + _descGate + '% (etiqueta ' + Number(p.desconto || 0) + '%, com cupom '
        + _descEfetivo + '%) abaixo do piso de ' + _pisoDesc + '%');
      continue;
    }

    // Cupom citado no post original que nao existe na base: sem a regra
    // (percentual, minimo, teto) o radar nao calcula o desconto e a oferta sai
    // pelo preco cheio. Aviso ao operador, sem travar o envio.
    const _cupSemBase = cupomCitadoDesconhecido(p.loja, texto);
    // Regra da operacao: oferta com cupom nao rastreado (citado no post ou
    // declarado no anuncio) que sairia pelo PRECO CHEIO nunca e auto-enviada.
    // No ML a incorporacao automatica ja tentou resolver antes do pipeline; se
    // o codigo continua fora da base, o destino e a fila de aprovacao. Se um
    // OUTRO cupom da base ja cobriu a oferta (r.cupom), ela nao esta cheia e o
    // fluxo normal segue.
    const _cupomForaDaBase = !r.cupom && (_cupSemBase.length > 0 || !!r.avisoCupomPagina);
    if (_cupSemBase.length) avisarCupomDesconhecido(p.loja, _cupSemBase, p, jid, _cupomForaDaBase).catch(() => {});

    // Cupom declarado pelo proprio anuncio sem correspondente na base.
    if (r.avisoCupomPagina) avisarCupomAnuncioSemBase(r.avisoCupomPagina, p, jid, _cupomForaDaBase).catch(() => {});

    // O post declara um preco bem abaixo do que vamos publicar e nenhum cupom
    // entrou: sinal de condicao nao capturada. Nao auto-envia e avisa.
    const _divPreco = divergenciaPrecoPost(texto, r.precoFinal ?? p.preco, !!r.cupom);
    if (_divPreco) avisarPrecoDivergente(_divPreco, p, jid).catch(() => {});

    const imagem = await baixarImagemProduto(p.imagemUrl);
    // Sem foto propria (antibot na pagina + API sem imagem), a miniatura do post
    // de origem e o que salva o card. Fica FORA de oferta.imagens de proposito:
    // ali ela viraria a foto principal de um envio como imagem, e e pequena
    // demais para isso. So o link preview usa.
    const _reservaThumb = (!imagem && _umProdutoSo && opcoes.thumbFonte?.base64)
      ? opcoes.thumbFonte.base64 : null;
    if (_reservaThumb) {
      console.log('[MKT] ' + (p.asin || '?') + ' sem foto da loja — miniatura do post de origem vira reserva do card.');
    }

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
        // Amazon em modo sem API: preco tambem vem do texto, mas a operacao
        // decidiu publicar direto enquanto a conta nao fica elegivel. Sem este
        // campo o gate abaixo mandaria tudo para a fila.
        autoEnvioMesmoSemVerificar: !!r.autoEnvioMesmoSemVerificar,
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

    // ── CATEGORIA DO PRODUTO (grupos de nicho) ─────────────────────────────
    // A classificacao entra na oferta ANTES de qualquer decisao de destino:
    // roteamento por nicho, vitrine publica e relatorio leem daqui. Nunca lanca
    // e nunca faz rede — categoria indefinida e um resultado valido e esperado.
    // Trilha lida da pagina do produto (hoje: Mercado Livre) entra no cache
    // ANTES da classificacao, para que este mesmo item ja decida por breadcrumb
    // e nao por palavra no titulo. Amazon tem caminho proprio (enriquecimento
    // em background); aqui a pagina ja foi aberta pelo radar, entao e de graca.
    if (p.trilha?.caminho && p.asin) {
      try { semearCacheTrilhas({ [p.asin]: { ...p.trilha, fonte: 'pagina-' + String(p.loja || '').toLowerCase() } }); }
      catch (e) { /* cache e conveniencia: falha aqui nunca segura o pipeline */ }
    }

    // ── VEREDITO PELO HISTORICO DE PRECO (SOMBRA) ─────────────────────────
    // Anexa a estatistica do proprio produto e diz se ele PASSARIA num gate por
    // historico — sem descartar nada. O 'de' da loja e etiqueta declarada; a
    // mediana de 30 dias e o que o produto realmente custou. Em sombra por
    // desenho: enquanto a serie nao tiver maturidade, quase tudo cai em
    // 'sem serie' e um gate ligado agora cortaria no escuro. Ausencia de dado
    // nunca pode virar sinal.
    try {
      const _st = estatisticasPreco(p.asin);
      if (_st) {
        const _ref = _st.mediana30 ?? null;
        const _final = Number(r.precoFinal ?? p.preco);
        oferta.dadosExtraidos.stats = {
          dias: _st.dias, min90: _st.min90, mediana30: _st.mediana30,
          dePor: _st.dePor || null,
          quedaVsMediana: (_ref > 0 && Number.isFinite(_final))
            ? Math.round(1000 * (_ref - _final) / _ref) / 10 : null,
          veredito: _st.dias < 5 ? 'sem maturidade'
                  : (_ref > 0 && _final >= _ref) ? 'REPROVARIA: nao caiu contra a mediana de 30d'
                  : 'passaria',
          modo: 'sombra',
        };
        console.log('[SOMBRA] ' + (p.asin || '?') + ' — ' + oferta.dadosExtraidos.stats.veredito
          + ' (serie ' + _st.dias + 'd, mediana30 ' + (_ref ?? '—')
          + ', agora ' + _final + ')');
      } else {
        oferta.dadosExtraidos.stats = { dias: 0, veredito: 'sem serie', modo: 'sombra' };
      }
    } catch (e) { /* sombra nunca segura o pipeline */ }

    const _cls = classificarProduto({ titulo: p.titulo, asin: p.asin, loja: p.loja });
    oferta.dadosExtraidos.categoria          = _cls.categoria;
    oferta.dadosExtraidos.categoriaNome      = _cls.nome;
    oferta.dadosExtraidos.categoriaConfianca = _cls.confianca;
    oferta.dadosExtraidos.categoriaSinal     = _cls.sinal;
    console.log('[CAT] Oferta #' + oferta.id + ' ' + (p.asin || '?') + ' -> ' + explicarClassificacao(_cls));

    // Modo observacao (fase 1): categoria listada em espelhoOperador sai tambem
    // no grupo interno. Fire-and-forget para nunca segurar o pipeline.
    if (espelhaNoOperador(_cls)) espelharCategoriaNoOperador(oferta, _cls).catch(() => {});

    // Marca visivel no card da fila: explica por que a oferta nao auto-enviou
    // mesmo com o auto-envio de oferta ligado.
    if (_cupomForaDaBase) {
      oferta.cupomForaDaBase = { codigos: _cupSemBase, anuncio: !!r.avisoCupomPagina };
    }
    // Post com varios cupons de categoria e nenhum casando com o bloco deste
    // link: sai pelo preco cheio enquanto o post promete desconto. Segura na
    // fila, como cupomForaDaBase.
    if (r.cupomAmbiguo) oferta.cupomAmbiguo = r.cupomAmbiguo;
    // Procedencia do produto quando o link veio de perfil de afiliado.
    // 'vitrine' = o item saiu do casamento por og:title numa pagina SEM CTA de
    // produto, isto e, pode ser um card qualquer de uma lista de cupons. Nesta
    // fase e so marcacao para medir volume — nao segura nada.
    if (p.origemProduto) oferta.dadosExtraidos.origemProduto = p.origemProduto;
    // Prova de vida da plataforma: chegou a virar oferta de grupo monitorado.
    registrarPulsoLoja(p.loja);
    if (_reservaThumb) oferta.miniaturaFonte = _reservaThumb;
    if (_divPreco) oferta.precoDivergente = _divPreco;
    // Versao corrigida de um post que ja saiu: sempre passa pelo operador.
    if (opcoes.edicao) oferta.revisaoDeEdicao = true;

    // Cruzamento com os desejos de compra registrados. Fire-and-forget: roda em
    // paralelo e nunca lanca, para nao interferir no pipeline de ofertas.
    casarDesejosComOferta(oferta, {
      enviarAviso: (texto) => registrarAlerta({
        nivel: 'atencao', origem: 'desejos',
        chave: 'desejo:' + (p.asin || oferta.id),
        titulo: 'Oferta casou com desejo de cliente — ' + (p.titulo || '').slice(0, 60),
        corpo: texto, ofertaId: oferta.id,
      })
    }).catch(() => {});

    // Modo da oferta: 'off' (tudo para a fila, padrao) | 'on' (dispara direto
    // nos destinos). Existe para validar o fluxo completo com grupo de teste;
    // apontar para grupo de cliente exige voltar para 'off' no Railway.
    // Uma oferta so chega aqui depois de passar por TODOS os filtros: preco
    // confirmado pela API, em estoque, desconto acima do minimo e fora do dedup.
    // Excecao: precoDeReferencia marca oferta cujo preco veio do TEXTO do grupo
    // e nao de fonte verificavel (caso da Magalu). Anunciar valor nao conferido
    // sem revisao humana ja produziu 'De/Por' inexistente — essas vao para a fila.
    // Preco nao verificado segura a oferta na fila — salvo quando o proprio
    // pipeline marcou que pode sair assim (Amazon sem API). A Magalu nao marca,
    // entao continua exigindo aprovacao manual como antes.
    const _seguraPorPreco = oferta.dadosExtraidos.precoDeReferencia
                         && !oferta.dadosExtraidos.autoEnvioMesmoSemVerificar;
    if (autoEnvioModoOferta() === 'on' && !_seguraPorPreco && !oferta.cupomForaDaBase
        && !oferta.cupomAmbiguo
        && !oferta.precoDivergente && !oferta.revisaoDeEdicao) {
      try {
        const r = await enviarOfertaParaDestinos(oferta.mensagemFormatada, null, oferta);
        oferta.status = 'enviado';
        oferta.enviadoEm = new Date().toISOString();
        oferta.gruposEnviados = r.enviados;
        // Continua entrando na fila, agora como historico: alimenta o painel e
        // preserva o rastro de tudo que saiu.
        filaPendentes.unshift(oferta);
        salvarFila();
        registrarEnvioHistorico(oferta);
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
    const _motivoFila = autoEnvioModoOferta() !== 'on' ? ''
      : oferta.cupomForaDaBase ? ' — cupom fora da base, exige aprovacao manual'
      : oferta.cupomAmbiguo ? ' — post cita ' + oferta.cupomAmbiguo.codigos.length
          + ' cupons e nenhum e do bloco deste link, exige aprovacao manual'
      : oferta.precoDivergente ? ' — post anuncia R$ ' + oferta.precoDivergente.declarado
          + ' e calculamos R$ ' + oferta.precoDivergente.calculado + ', exige aprovacao manual'
      : oferta.revisaoDeEdicao ? ' — versao editada do post, exige aprovacao manual'
      : _seguraPorPreco ? ' — preco nao verificado, exige aprovacao manual'
      : '';
    console.log('[MKT] Oferta #' + oferta.id + ' na fila — ' + p.asin + ' R$ ' + p.preco + ' (' + p.desconto + '% off)' + _motivoFila);
  }
}

// ctx = { contaId, sock } da conta que RECEBEU a mensagem. Importa para a
// midia: o reupload precisa do socket que tem a sessao daquela mensagem —
// pedir pelo principal uma imagem que chegou na secundaria falha.
async function processarMensagem(msg, ctx = CTX_PRINCIPAL) {
  try {
    const jid    = msg.key.remoteJid;
    // Dois monitoramentos convivem: os monitorados do CDV alimentam o pipeline de
    // emissoes CDV; os grupos marcados como 'fonte' no painel alimentam o radar
    // de marketplace. Um grupo pode estar so em um dos dois.
    const _ehRadar = ehFonteRadar(jid);
    if (!ehMonitoradoCdv(jid) && !_ehRadar) return;
    // Edicao de mensagem no grupo-fonte: o WhatsApp entrega a versao nova
    // dentro de protocolMessage.editedMessage. Sem este desembrulho o tipo caia
    // em 'protocolMessage', que esta em _TIPOS_IGNORADOS, e a correcao sumia sem
    // log — inclusive quando ela era exatamente o cupom que faltava no post.
    let m = desembrulharMessage(msg.message);
    const _editado  = m?.protocolMessage?.editedMessage;
    const _ehEdicao = !!_editado;
    if (_ehEdicao) m = desembrulharMessage(_editado);
    const tipo = _TIPOS_TRATADOS.find(t => m && m[t]) || Object.keys(m || {})[0];
    let texto = '', imagemB64 = null, _thumbFonte = null;
    if (tipo === 'conversation') { texto = m.conversation; }
    else if (tipo === 'extendedTextMessage') {
      texto = m.extendedTextMessage.text;
      _thumbFonte = miniaturaDaMensagem(m);
    }
    else if (tipo === 'imageMessage') {
      texto = m.imageMessage.caption || '';
      try {
        const sockMidia = ctx?.sock || sock;
        const buffer = await downloadMediaMessage(msg,'buffer',{},{ logger:pino({level:'silent'}), reuploadRequest:sockMidia.updateMediaMessage });
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

    console.log('[MSG] Capturada de', jid.split('@')[0], '— tipo:', tipo + (_ehEdicao ? ' (EDICAO)' : ''), texto ? '| texto: '+texto.slice(0,60) : '| imagem');
    ultimaCapturaPorGrupo.set(jid, Date.now());
    registrarCapturaHealth();

    // Avisos que o PROPRIO servidor publica no grupo do operador chegam de
    // volta como mensagem (fromMe) e entravam no pipeline de emissoes: cada
    // alerta operacional virava uma chamada de IA inutil. Filtramos pelo texto,
    // e nao por fromMe puro, para NAO bloquear teste manual do proprio numero.
    if (msg.key?.fromMe && texto && _EH_AVISO_DO_SISTEMA.test(texto)) {
      console.log('[MSG] Aviso do proprio sistema em ' + jid.split('@')[0] + ' — ignorado (nao vai para a IA).');
      return;
    }

    if (texto && (
      texto.includes('Dica de emissao encontrada por @davileles') ||
      texto.includes('Dica de emissão encontrada por @davileles') ||
      texto.includes('Faca parte do Balcao clicando aqui') ||
      texto.includes('Faça parte do Balcão clicando aqui')
    )) { return; }

    // Radar de marketplace: sai antes do buffer de agrupamento, que e do
    // pipeline de emissoes CDV e nao sabe lidar com link de produto.
    if (_ehRadar) {
      registrarCapturaBruta(jid, msg, texto, tipo, _ehEdicao);
      await processarRadarMarketplace(jid, texto, { edicao: _ehEdicao, thumbFonte: _thumbFonte });
      if (!ehMonitoradoCdv(jid)) return;
    }

    if (!bufferAgrupamento.has(jid)) bufferAgrupamento.set(jid, { itens:[], timer:null });
    const entrada = bufferAgrupamento.get(jid);
    if (entrada.timer) clearTimeout(entrada.timer);
    entrada.timer = setTimeout(() => processarBuffer(jid), JANELA_AGRUPAMENTO_MS);
    // A janela e um DEBOUNCE: cada mensagem nova reinicia a contagem, entao em
    // grupo que posta em rajada o alerta espera a rajada acabar. Guardar o
    // horario previsto de fechamento e o que permite a tela explicar a espera
    // em vez de o operador achar que a mensagem se perdeu.
    entrada.fechaEm = Date.now() + JANELA_AGRUPAMENTO_MS;
    if (!entrada.desdeEm) entrada.desdeEm = Date.now();
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
  // Delegado a forcarReconexao: mesma limpeza (inclui healthTimer, que a
  // versao antiga esquecia) e agendamento unico — sem caminho paralelo.
  forcarReconexao('health: ' + motivo);
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

// ── CONTAGEM DE INDECIFRAVEIS POR GRUPO ──────────────────────────────────────
// errosDescripto e GLOBAL e zera com qualquer mensagem decifrada de QUALQUER
// grupo: de dia isso mascara (raramente chega a 8), de madrugada com um unico
// grupo ativo chega facil — e a cura apagava as sender keys de TODOS os grupos
// por culpa de um so, disparando tempestade de redistribuicao em dezenas de
// grupos e uma janela de surdez geral. Isso e "Aguardando mensagem" que NOS
// causamos. Agora a cura cirurgica e POR GRUPO (so o grupo com chave velha e
// tocado) e o reset global so acontece quando a sessao esta SISTEMICAMENTE
// quebrada: varios grupos distintos falhando ao mesmo tempo.
const _indecifraveisPorGrupo = new Map();   // jid -> { n, curas, ultimaEm }
const ERROS_GRUPO_SOFT      = 8;            // 8 seguidas DO MESMO grupo -> cura so desse grupo
const ERROS_GRUPO_CURAS_MAX = 3;            // apos 3 curas sem resolver, para e avisa (o remetente nao redistribui)
const ERROS_GRUPOS_HARD_MIN = 3;            // reset global exige >= 3 grupos distintos falhando (janela 10 min)
var isResetting     = false; // true durante limpeza de sessão — bloqueia conexões/timers concorrentes
var _reconnectTimer = null;  // referência única do timer de reconexão pendente (evita corrida)

// Agenda uma única reconexão, cancelando qualquer timer pendente anterior.
function _agendarReconexao(delay) {
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); }
  _reconnectTimer = setTimeout(() => { _reconnectTimer = null; conectar(); }, delay);
}

// ── FAXINA DE DISCO DO VOLUME ────────────────────────────────────────────────
// O Baileys grava um arquivo por sessao (`session-<user>.<device>.json`) e um
// por chave de grupo (`sender-key-...json`). Com 34 grupos e milhares de
// participantes esses arquivos so crescem: nada no Baileys os expira. Em
// 21/08/2026 o volume do Railway bateu 100% e o processo entrou em ENOSPC —
// nao conseguia mais gravar creds, o watchdog escalou ate o degrau 3 e o
// servico ficou 502 ate alguem intervir a mao.
//
// A faxina apaga por IDADE, nao por quantidade: sessao que nao e tocada ha
// semanas e de contato que nao fala com a gente. Vale a mesma regra do reset:
// `session-*` e `sender-key-*` sao seguros (o remetente redistribui via retry
// receipt); `pre-key-*`, `creds.json` e `app-state-sync-*` NUNCA sao tocados,
// sob pena de "Bad MAC" permanente ate novo QR.
const FAXINA_DIAS   = Number(process.env.FAXINA_DIAS || 21);
const FAXINA_INTERV = 6 * 60 * 60 * 1000;   // 6h

// Sobra de escrita atomica: `writeFile(tmp)` + `rename` deixa .tmp para tras
// se o processo morre no meio — foi o caso do enviadas.json.tmp de 117 MB que
// sobreviveu ao ENOSPC e continuou ocupando metade do volume depois.
// Feeds da Awin sao cache: o proximo /awin/feeds/atualizar rebaixa tudo.
async function faxinaAuxiliar() {
  let n = 0, bytes = 0;
  const agora = Date.now();
  const alvos = [
    { dir: SESSAO_DIR,            filtro: a => a.endsWith('.tmp'), idadeH: 1  },
    { dir: SESSAO_DIR + '/feeds', filtro: a => a.endsWith('.csv.gz'), idadeH: 48 },
    { dir: UPLOAD_DIR,            filtro: () => true,              idadeH: 6  },
  ];
  for (const alvo of alvos) {
    try {
      for (const arq of await readdir(alvo.dir)) {
        if (!alvo.filtro(arq)) continue;
        const caminho = alvo.dir + '/' + arq;
        try {
          const st = await statAsync(caminho);
          if (!st.isFile()) continue;
          if (agora - st.mtimeMs < alvo.idadeH * 3600 * 1000) continue;
          bytes += st.size;
          await unlink(caminho).catch(() => {});
          n++;
        } catch (e) {}
      }
    } catch (e) {}
  }
  if (n) console.log('[FAXINA] Auxiliar: ' + n + ' arquivo(s) temporario(s)/cache removido(s) (' +
    Math.round(bytes / 1048576) + ' MB).');
  return { apagados: n, bytes };
}

async function faxinaDisco(motivo = 'periodica') {
  const corte = Date.now() - FAXINA_DIAS * 24 * 60 * 60 * 1000;
  let apagados = 0, mantidos = 0, bytes = 0;
  await faxinaAuxiliar();
  try {
    // Inclui as contas extras: 'paulo' sozinho tinha 22 mil sessions (45 MB),
    // trinta vezes mais que a conta principal — sao elas que crescem sem freio.
    const pastas = [SESSAO_DIR];
    try {
      for (const c of await readdir(CONTAS_DIR)) pastas.push(CONTAS_DIR + '/' + c);
    } catch (e) {}
    for (const pasta of pastas)
    for (const arq of await readdir(pasta)) {
      if (!(arq.startsWith('session-') || arq.startsWith('sender-key'))) continue;
      const caminho = pasta + '/' + arq;
      try {
        const st = await statAsync(caminho);
        if (st.mtimeMs < corte) {
          bytes += st.size;
          await unlink(caminho).catch(() => {});
          apagados++;
        } else { mantidos++; }
      } catch (e) { /* arquivo sumiu no meio da varredura */ }
    }
    console.log('[FAXINA] ' + motivo + ': ' + apagados + ' arquivo(s) com mais de ' +
      FAXINA_DIAS + ' dia(s) apagado(s) (' + Math.round(bytes / 1024) + ' KB), ' +
      mantidos + ' mantido(s).');
  } catch (e) {
    console.error('[FAXINA] Erro:', e.message);
  }
  return { apagados, mantidos, bytes };
}

// Faxina de emergencia: ignora a idade e apaga do mais antigo para o mais novo
// ate sobrar `alvo` arquivos. So e chamada quando o disco ja estourou — nesse
// ponto perder segmentacao de sessao e barato perto de ficar fora do ar.
async function faxinaEmergencia(alvo = 500) {
  try {
    const lista = [];
    const pastas = [SESSAO_DIR];
    try {
      for (const c of await readdir(CONTAS_DIR)) pastas.push(CONTAS_DIR + '/' + c);
    } catch (e) {}
    for (const pasta of pastas)
    for (const arq of await readdir(pasta)) {
      if (!(arq.startsWith('session-') || arq.startsWith('sender-key'))) continue;
      try {
        const st = await statAsync(pasta + '/' + arq);
        lista.push({ arq: pasta + '/' + arq, mtime: st.mtimeMs });
      } catch (e) {}
    }
    if (lista.length <= alvo) return { apagados: 0, total: lista.length };
    lista.sort((a, b) => a.mtime - b.mtime);
    const cortar = lista.slice(0, lista.length - alvo);
    for (const item of cortar) await unlink(item.arq).catch(() => {});
    console.warn('[FAXINA] EMERGENCIA: ' + cortar.length + ' arquivo(s) apagado(s) — ' +
      lista.length + ' passou do alvo de ' + alvo + '.');
    return { apagados: cortar.length, total: lista.length };
  } catch (e) {
    console.error('[FAXINA] Erro na emergencia:', e.message);
    return { apagados: 0, total: 0 };
  }
}

// Endpoint manual: util quando o disco ja encheu e o painel e a unica via.
// Raio-x do volume: agrega por FAMILIA de arquivo (o nome carrega o tipo) e
// lista os maiores. Sem isso a unica pista de disco cheio e o ENOSPC no log,
// que diz que acabou mas nao diz quem gastou.
function _familiaDe(nome) {
  if (nome.startsWith('session-'))          return 'session-*';
  if (nome.startsWith('sender-key-memory')) return 'sender-key-memory-*';
  if (nome.startsWith('sender-key'))        return 'sender-key-*';
  if (nome.startsWith('pre-key-'))          return 'pre-key-*';
  if (nome.startsWith('app-state-sync-'))   return 'app-state-sync-*';
  return nome;
}

async function _varrer(dir, prefixo, acc) {
  let itens = [];
  try { itens = await readdir(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const item of itens) {
    const caminho = dir + '/' + item.name;
    if (item.isDirectory()) { await _varrer(caminho, prefixo + item.name + '/', acc); continue; }
    try {
      const st = await statAsync(caminho);
      const fam = prefixo + _familiaDe(item.name);
      const cur = acc.familias.get(fam) || { arquivos: 0, bytes: 0 };
      cur.arquivos++; cur.bytes += st.size;
      acc.familias.set(fam, cur);
      acc.total += st.size; acc.arquivos++;
      acc.maiores.push({ arquivo: prefixo + item.name, kb: Math.round(st.size / 1024), em: st.mtime });
    } catch (e) {}
  }
}

app.get('/manutencao/disco', async (_req, res) => {
  const acc = { familias: new Map(), maiores: [], total: 0, arquivos: 0 };
  await _varrer(SESSAO_DIR, '', acc);
  await _varrer(UPLOAD_DIR, 'tmp-uploads/', acc);
  const familias = [...acc.familias.entries()]
    .map(([nome, v]) => ({ nome, arquivos: v.arquivos, mb: +(v.bytes / 1048576).toFixed(2) }))
    .sort((a, b) => b.mb - a.mb).slice(0, 25);
  const maiores = acc.maiores.sort((a, b) => b.kb - a.kb).slice(0, 15);
  res.json({ ok: true, totalMB: +(acc.total / 1048576).toFixed(2), arquivos: acc.arquivos, familias, maiores });
});

app.post('/manutencao/faxina', async (req, res) => {
  const emergencia = req.body?.emergencia === true;
  const alvo = Number(req.body?.alvo || 500);
  const r = emergencia ? await faxinaEmergencia(alvo) : await faxinaDisco('manual');
  res.json({ ok: true, emergencia, ...r });
});

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
  errosDescripto = 0; _indecifraveisPorGrupo.clear();
  isResetting = false;
  _agendarReconexao(3000);
}

// Cura cirúrgica: apaga SOMENTE as sender keys (chaves de decodificação de grupos),
// sem derrubar a conexão e sem tocar em sessions/pre-keys. Como o auth state lê as
// chaves do disco sob demanda, o efeito é imediato: na próxima mensagem de cada
// grupo o Baileys envia retry receipt e o remetente redistribui a chave nova.
// Teto da cura cirurgica. Em 17/08/2026 uma rajada de indecifraveis disparou o
// apagamento de 72 sender keys de uma vez; segundos depois o stream caiu com
// erro 500 e o socket ficou surdo por 2h. Apagar o chaveiro inteiro nao e
// cirurgia — e trauma. Acima do teto, o problema nao e de chave de grupo:
// escalamos para reset de sessao, que reconstroi o estado de forma ordenada.
const SENDER_KEYS_TETO = 25;

// Cura cirurgica POR GRUPO: apaga as sender keys dos remetentes DESTE grupo
// (o bot manda retry receipt e eles redistribuem) e a memory de distribuicao
// da NOSSA key para este grupo (o proximo envio redistribui). Nenhum outro
// grupo e tocado. Nome no disco: sender-key-<grupo>--<remetente>--<device>.json
// e sender-key-memory-<grupo>.json (fixFileName troca ':' por '-').
async function limparSenderKeysDoGrupo(jid, cura) {
  try {
    const fix = (x) => x.replace(/\//g, '__').replace(/:/g, '-');
    const prefKeys = fix('sender-key-' + jid) + '--';
    const arqMem   = fix('sender-key-memory-' + jid) + '.json';
    const arquivos = await readdir(SESSAO_DIR);
    let n = 0;
    for (const arq of arquivos) {
      if (arq.startsWith(prefKeys) || arq === arqMem) { await unlink(SESSAO_DIR + '/' + arq).catch(() => {}); n++; }
    }
    console.log('[WA] Cura cirúrgica do grupo ' + (NOMES_GRUPOS.get(jid) || jid) + ' (ciclo ' + cura + '): ' + n + ' arquivo(s) de sender key apagado(s). Conexão mantida; só este grupo redistribui.');
    if (cura >= ERROS_GRUPO_CURAS_MAX) {
      // So avisa se o grupo e de LEITURA (fonte do radar ou monitorado). Em grupo
      // de DESTINO o bot nao le nada: indecifravel ali e conversa de membro que
      // nunca seria processada — avisar gera alarme falso e induz o operador a
      // "sair e entrar" de um grupo saudavel (perdendo admin e a base de membros).
      if (!(ehFonteRadar(jid) || ehMonitoradoCdv(jid))) {
        console.log('[WA] ' + (NOMES_GRUPOS.get(jid) || jid) + ' segue indecifravel apos ' + cura
          + ' cura(s), mas e grupo de DESTINO (nao lemos dele) — nenhuma captacao afetada, sem aviso ao operador.');
        return;
      }
      _avisarOperador('Watchdog — grupo indecifrável: ' + (NOMES_GRUPOS.get(jid) || jid)
        + ' segue com mensagens que o bot não decifra após ' + cura + ' curas. O remetente não está redistribuindo a chave.'
        + '\nSe for grupo-fonte, a captação dele está parada. Verifique se o bot segue no grupo; em último caso, sair e entrar.').catch(() => {});
    }
  } catch (e) { console.error('[WA] Erro na cura por grupo:', e.message); }
}

async function limparSenderKeys() {
  try {
    const arquivos = await readdir(SESSAO_DIR);
    const chaves = arquivos.filter(a => a.startsWith('sender-key'));
    if (chaves.length > SENDER_KEYS_TETO) {
      console.warn('[WA] Cura cirúrgica ABORTADA: ' + chaves.length + ' sender keys (teto ' + SENDER_KEYS_TETO + '). Apagar tudo degrada o socket — escalando para reset de sessão.');
      await limparSessaoEReconectar();
      return;
    }
    let n = 0;
    for (const arq of chaves) {
      await unlink(SESSAO_DIR + '/' + arq).catch(() => {});
      n++;
    }
    console.log('[WA] Cura cirúrgica: ' + n + ' sender keys apagadas (conexão mantida, remetentes redistribuirão as chaves).');
  } catch(e) { console.error('[WA] Erro na cura cirúrgica:', e.message); }
}

const _retriesPorUser = new Map();   // user (so digitos) -> { n, ultimoEm }
const RETRY_LIMITE_AUTOCURA = 2;

// ── AVISO DE ENTREGA SUSPEITA AO OPERADOR ────────────────────────────────────
// Retry receipt é o único sinal de "Aguardando mensagem" do outro lado — sem
// aviso, o operador só descobre quando o cliente reclama. Dedup de 6h por alvo
// para um contato problemático não virar spam no grupo do operador.
const _avisosEntrega = new Map();    // alvo -> ultimoAvisoEm (ms)
const AVISO_ENTREGA_DEDUP_MS = 6 * 60 * 60 * 1000;

// Cooldown pós-autocura: o WhatsApp manda UM retry receipt POR MENSAGEM
// travada. Um contato com 10 mensagens presas gera uma rajada de 10 retries —
// e cada um, sem isto, disparava autocura + alerta de novo (dezenas de avisos
// no operador). Depois da cura, os retries seguintes do mesmo alvo são ecos
// das mensagens antigas: a sessão nova só vale a partir do PRÓXIMO envio.
// Ignoramos o alvo por 10 min.
const _autocuraEm = new Map();       // alvo -> ts da última autocura
const AUTOCURA_COOLDOWN_MS = 10 * 60 * 1000;

function _emCooldownAutocura(alvo) {
  return Date.now() - (_autocuraEm.get(alvo) || 0) < AUTOCURA_COOLDOWN_MS;
}

// Válvula global: independente do dedup por alvo, nunca mais que 5 avisos de
// entrega por hora no grupo do operador. Ao estourar, UM aviso de supressão.
let _avisosEntregaJanela = { inicio: 0, n: 0, suprimidos: 0, avisou: false };
const AVISOS_ENTREGA_MAX_HORA = 5;

function _passaValvulaAvisos() {
  const agora = Date.now();
  if (agora - _avisosEntregaJanela.inicio > 60 * 60 * 1000) {
    _avisosEntregaJanela = { inicio: agora, n: 0, suprimidos: 0, avisou: false };
  }
  if (_avisosEntregaJanela.n < AVISOS_ENTREGA_MAX_HORA) {
    _avisosEntregaJanela.n++;
    return true;
  }
  _avisosEntregaJanela.suprimidos++;
  if (!_avisosEntregaJanela.avisou) {
    _avisosEntregaJanela.avisou = true;
    enviarMensagem(GRUPOS.operador, { text: '*Avisos de entrega silenciados por 1h* \ud83d\udd15\n\n'
      + 'Limite de ' + AVISOS_ENTREGA_MAX_HORA + ' avisos/hora atingido. As autocuras '
      + 'continuam rodando normalmente — só os avisos estão suprimidos. Detalhe completo em /entregas-suspeitas e nos logs [ENTREGA].' })
      .catch(() => {});
  }
  console.warn('[ENTREGA] Aviso suprimido pela válvula (' + _avisosEntregaJanela.suprimidos + ' na janela).');
  return false;
}

function _podeAvisarEntrega(alvo) {
  const ultimo = _avisosEntrega.get(alvo) || 0;
  if (Date.now() - ultimo < AVISO_ENTREGA_DEDUP_MS) return false;
  _avisosEntrega.set(alvo, Date.now());
  return true;
}

function notificarOperadorEntrega(texto) {
  if (!_passaValvulaAvisos()) return;
  // Fire-and-forget: aviso nunca pode derrubar o handler de retry.
  enviarMensagem(GRUPOS.operador, { text: texto })
    .catch(e => console.error('[ENTREGA] Falha ao avisar operador:', e.message));
}

// ── SESSAO E2E POR CONTATO ───────────────────────────────────────────────────
// "Aguardando mensagem. Essa acao pode levar alguns instantes." no aparelho do
// destinatario NAO e falha de envio: o sendMessage retorna sucesso, a mensagem
// sai com um check e o aparelho dele simplesmente nao consegue decifrar. A
// causa e o registro de sessao Signal daquele contato ter ficado velho do nosso
// lado — ele trocou de aparelho, reinstalou o WhatsApp, ou o ratchet
// dessincronizou depois de um restart. Enquanto a sessao velha existir, TODA
// mensagem para ele sai cifrada com chave que ele nao tem: reenviar o mesmo
// texto nao adianta.
//
// Apagar session-<numero>.<device>.json obriga o Baileys a buscar um pre-key
// bundle novo e reabrir a sessao do zero no proximo envio. E cirurgico: nao
// derruba a conexao, nao pede QR e nao mexe nas sessoes dos outros contatos —
// ao contrario de /reset-sessao, que custa reconexao inteira.
// Desde a migracao de identidade do WhatsApp, a sessao Signal de um contato
// pode estar gravada sob o LID dele (identificador interno) em vez do telefone.
// Apagar so por telefone entao nao encontra nada e o problema continua: por isso
// resolvemos o LID via onWhatsApp e limpamos os dois enderecos.
async function lidDoContato(digitos) {
  try {
    if (!conectado || !sock) return null;
    const r = await sock.onWhatsApp(digitos);
    const achado = Array.isArray(r) ? r.find(x => x && x.exists) : null;
    const lid = achado?.lid ? String(achado.lid).split('@')[0].split(':')[0] : null;
    return lid && /^\d+$/.test(lid) ? lid : null;
  } catch (e) {
    console.warn('[SESSAO] Nao foi possivel resolver o LID de ' + digitos + ':', e.message);
    return null;
  }
}

async function resetarSessaoContato(alvo) {
  const digitos = String(alvo || '').replace(/\D/g, '');
  if (!digitos) return { apagados: 0, arquivos: [], users: [] };
  const users = new Set([digitos]);
  const lid = await lidDoContato(digitos);
  if (lid) users.add(lid);
  const arquivos = [];
  try {
    // O id da sessao e `<user>.<device>` (ProtocolAddress), entao o prefixo com
    // ponto pega todos os aparelhos do contato sem pegar numero parecido.
    for (const arq of await readdir(SESSAO_DIR)) {
      if ([...users].some(u => arq.startsWith('session-' + u + '.'))) {
        await unlink(SESSAO_DIR + '/' + arq).catch(() => {});
        arquivos.push(arq);
      }
    }
  } catch (e) {
    console.error('[SESSAO] Erro ao resetar contato ' + digitos + ':', e.message);
  }
  users.forEach(u => _retriesPorUser.delete(u));
  console.log('[SESSAO] Contato ' + digitos + (lid ? ' (lid ' + lid + ')' : '') + ': ' +
    arquivos.length + ' registro(s) de sessao apagado(s) — proxima mensagem abre sessao nova.');
  return { apagados: arquivos.length, arquivos, users: [...users], lid };
}

// ── RETRY RECEIPT = AVISO DE NAO-ENTREGA ─────────────────────────────────────
// Quando o destinatario nao decifra, o aparelho dele pede reenvio (receipt
// type=retry). Esse e o UNICO sinal que temos de que a mensagem travou em
// "Aguardando mensagem" — o sendMessage ja retornou sucesso ha muito tempo.
// Um retry isolado e normal (o Baileys reenvia via getMessage e resolve). A
// partir do segundo, a sessao esta viciada: apagamos ela na hora, para que a
// PROXIMA mensagem para esse contato ja saia por uma sessao limpa.
function registrarRetryReceipt(node) {
  try {
    const de = node?.attrs?.from || '';
    const user = String(de).split('@')[0].split(':')[0].replace(/\D/g, '');
    if (!user) return;
    // Retry vindo de grupo: participante sem a nossa sender key — autocura própria.
    if (String(de).includes('@g.us')) { registrarRetryGrupo(String(de), node?.attrs?.participant); return; }
    // Rajada pós-autocura: ecos de mensagens antigas travadas. Ignorar.
    if (_emCooldownAutocura('user:' + user)) return;
    const reg = _retriesPorUser.get(user) || { n: 0, ultimoEm: 0 };
    reg.n++;
    reg.ultimoEm = Date.now();
    _retriesPorUser.set(user, reg);
    console.warn('[ENTREGA] Retry #' + reg.n + ' de ' + user + ' — ele nao conseguiu decifrar nossa mensagem.');
    if (reg.n >= RETRY_LIMITE_AUTOCURA) {
      console.warn('[ENTREGA] ' + user + ' atingiu ' + reg.n + ' retries — apagando a sessao dele (autocura).');
      // Zera o contador AGORA (síncrono) e arma o cooldown: o delete que existe
      // dentro do resetarSessaoContato é async e chegava tarde numa rajada.
      _retriesPorUser.delete(user);
      _autocuraEm.set('user:' + user, Date.now());
      resetarSessaoContato(user).catch(() => {});
      if (!_podeAvisarEntrega('cura:user:' + user)) return;
      notificarOperadorEntrega('*Entrega suspeita — autocura aplicada* \u26a0\ufe0f\n\n'
        + 'O contato *' + user + '* nao conseguiu decifrar nossas mensagens '
        + '(' + reg.n + ' pedidos de reenvio — "Aguardando mensagem" do lado dele).\n\n'
        + 'A sessao E2E dele foi resetada: a proxima mensagem sai por sessao nova. '
        + 'Se era mensagem importante (concierge/campanha), vale *reenviar agora*.');
    } else if (_podeAvisarEntrega('user:' + user)) {
      notificarOperadorEntrega('*Entrega suspeita* \u26a0\ufe0f\n\n'
        + 'O contato *' + user + '* pediu reenvio de uma mensagem nossa '
        + '(possivel "Aguardando mensagem" do lado dele).\n\n'
        + 'O reenvio automatico ja foi feito. Se acumular, a sessao sera resetada sozinha.');
    }
  } catch (e) {}
}

// Guarda as últimas mensagens ENVIADAS para responder retry receipts (getMessage).
// PERSISTENTE EM DISCO (sessao/enviadas.json): o Map puro em memória zerava a
// cada restart/redeploy do Railway. Retry receipt costuma chegar MINUTOS ou
// HORAS depois do envio (destinatário offline na hora). Se chegasse após um
// restart, getMessage devolvia undefined, o reenvio do Baileys falhava e o
// destinatário ficava preso em "Aguardando mensagem" PARA SEMPRE. Agora o
// store sobrevive a restarts, com TTL de 48h e escrita atômica (tmp + rename),
// no mesmo padrão do auth state. Cobre a conta principal e as contas extras.
const ENVIADAS_PATH   = SESSAO_DIR + '/enviadas.json';
const ENVIADAS_TTL_MS = 48 * 60 * 60 * 1000;
const ENVIADAS_MAX    = 4000;
// Teto de BYTES, nao so de contagem. Oferta e mensagem com imagem, e o
// jpegThumbnail vai junto no objeto — em base64 cada uma passava de 30 KB.
// 4000 delas viraram 121 MB de enviadas.json e estouraram o volume de 500 MB
// em 21/08/2026. A contagem sozinha nao protege: o que enche disco e tamanho.
const ENVIADAS_MAX_MB = Number(process.env.ENVIADAS_MAX_MB || 20);

// A thumbnail existe so para preview no chat de quem envia; o reenvio por
// retry receipt nao depende dela (a midia real vive no CDN do WhatsApp, o
// destinatario baixa por directPath). Guardar o thumb no store e pagar 30 KB
// por mensagem para nada.
//
// A poda acontece na SERIALIZACAO, nao no objeto. A versao anterior clonava a
// mensagem campo a campo para tirar o thumb — e o clone virava objeto simples,
// perdendo o prototipo do protobuf do Baileys. Na hora de gravar, quebrava com
// "this.constructor.toObject is not a function" e o enviadas.json parou de ser
// persistido inteiro (22/08/2026). Um replacer descarta a chave no JSON e
// deixa o objeto em memoria intacto para o getMessage.
function _replacerSemThumb(chave, valor) {
  if (chave === 'jpegThumbnail' || chave === 'thumbnail') return undefined;
  return BufferJSON.replacer.call(this, chave, valor);
}

// Segunda camada, agora para a MEMORIA. O replacer acima protege o disco, mas
// o objeto guardado no Map continuava com o thumb: 4000 mensagens x ~30 KB sao
// ~120 MB de RAM parada. Aqui a poda e IN-PLACE (delete no proprio objeto), sem
// clonar: o clone da versao de 21/08 destruia o prototipo do protobuf e
// quebrava a gravacao com "this.constructor.toObject is not a function".
// Deletar depois do envio e inofensivo — a thumbnail so serve ao preview de
// quem envia, e o reenvio por retry receipt busca a midia real no CDN.
function _podarThumbInPlace(m, prof = 0) {
  if (!m || typeof m !== 'object' || Buffer.isBuffer(m) || prof > 8) return m;
  for (const k of Object.keys(m)) {
    if (k === 'jpegThumbnail' || k === 'thumbnail') { try { delete m[k]; } catch (e) {} continue; }
    const v = m[k];
    if (v && typeof v === 'object' && !Buffer.isBuffer(v)) _podarThumbInPlace(v, prof + 1);
  }
  return m;
}

const mensagensEnviadas = new Map(); // id -> { m: mensagem, em: ms }

function obterMensagemEnviada(id) {
  const reg = id ? mensagensEnviadas.get(id) : null;
  return reg ? reg.m : undefined;
}

let _enviadasSaveTimer = null;
function _agendarSalvarEnviadas() {
  if (_enviadasSaveTimer) return;
  _enviadasSaveTimer = setTimeout(async () => {
    _enviadasSaveTimer = null;
    try {
      const agora = Date.now();
      for (const [id, r] of mensagensEnviadas) {
        if (agora - (r.em || 0) > ENVIADAS_TTL_MS) mensagensEnviadas.delete(id);
      }
      while (mensagensEnviadas.size > ENVIADAS_MAX) {
        mensagensEnviadas.delete(mensagensEnviadas.keys().next().value);
      }
      // Serializa, mede e, se passar do teto, descarta do mais ANTIGO para o
      // mais novo ate caber. Retry receipt de mensagem velha e raro; ficar sem
      // disco derruba o servidor inteiro.
      const limite = ENVIADAS_MAX_MB * 1048576;
      let payload;
      for (;;) {
        const obj = {};
        for (const [id, r] of mensagensEnviadas) obj[id] = { em: r.em, m: r.m };
        payload = JSON.stringify(obj, _replacerSemThumb);
        if (Buffer.byteLength(payload) <= limite || mensagensEnviadas.size <= 50) break;
        const descartar = Math.max(1, Math.floor(mensagensEnviadas.size * 0.2));
        for (let i = 0; i < descartar; i++) {
          mensagensEnviadas.delete(mensagensEnviadas.keys().next().value);
        }
      }
      const tmp = ENVIADAS_PATH + '.tmp';
      await writeFileAsync(tmp, payload);
      await renameAsync(tmp, ENVIADAS_PATH);
    } catch (e) { console.error('[ENTREGA] Erro ao persistir enviadas.json:', e.message); }
  }, 3000);
}

// Restaura o store no boot: é isto que faz o retry receipt pós-redeploy
// encontrar a mensagem e o reenvio funcionar.
(async () => {
  try {
    const raw = await readFileAsync(ENVIADAS_PATH, 'utf-8');
    const obj = JSON.parse(raw, BufferJSON.reviver);
    const agora = Date.now();
    let n = 0;
    for (const id in obj) {
      const r = obj[id];
      // Enxuga na restauracao tambem: o arquivo gravado por versoes antigas tem
      // as thumbnails dentro e e ele que precisa encolher — sem isso o store so
      // seria podado no proximo envio, e o disco cheio nao espera.
      if (r?.m && agora - (r.em || 0) <= ENVIADAS_TTL_MS) {
        // Arquivo gravado por versao antiga pode trazer thumbnail dentro: poda
        // aqui tambem, senao a RAM carrega o legado ate o TTL expirar.
        mensagensEnviadas.set(id, { em: r.em, m: _podarThumbInPlace(r.m) });
        n++;
      }
    }
    if (n) console.log('[ENTREGA] ' + n + ' mensagens enviadas restauradas do disco (getMessage sobrevive a restart).');
    // Reescreve ja no arranque aplicando teto de bytes e a poda de thumbnail.
    _agendarSalvarEnviadas();
  } catch {}
})();

function guardarMensagemEnviada(info) {
  try {
    if (info?.key?.id && info.message) {
      mensagensEnviadas.set(info.key.id, { m: _podarThumbInPlace(info.message), em: Date.now() });
      _agendarSalvarEnviadas();
    }
  } catch(e) {}
}

// ── AUTOCURA DE GRUPO ────────────────────────────────────────────────────────
// "Aguardando mensagem" DENTRO de grupo (caso do concierge, que envia para o
// grupo do cliente): um participante não tem a NOSSA sender key — ele trocou
// de aparelho, entrou depois, ou a sessão 1:1 pela qual o SKDM viaja viciou.
// O Baileys reenvia via getMessage no primeiro retry; se o MESMO grupo acumula
// retries, apagamos sender-key-memory-<grupo> (o próximo envio redistribui a
// nossa chave a TODOS os participantes) e resetamos a sessão 1:1 do
// participante que reclamou (o SKDM novo viaja por ela).
const _retriesPorGrupo = new Map(); // grupoJid -> { n, ultimoEm }
const RETRY_GRUPO_AUTOCURA = 2;

async function curarSenderKeyGrupo(grupoJid) {
  try {
    const nome = ('sender-key-memory-' + grupoJid + '.json').replace(/\//g, '__').replace(/:/g, '-');
    await unlink(SESSAO_DIR + '/' + nome).catch(() => {});
    console.warn('[ENTREGA] sender-key-memory de ' + grupoJid + ' apagado — próximo envio redistribui a sender key a todos.');
  } catch (e) { console.error('[ENTREGA] Falha ao curar sender key de ' + grupoJid + ':', e.message); }
}

function registrarRetryGrupo(grupoJid, participante) {
  // Rajada pós-autocura: ecos das mensagens antigas travadas do grupo. Ignorar.
  if (_emCooldownAutocura('grupo:' + grupoJid)) return;
  const reg = _retriesPorGrupo.get(grupoJid) || { n: 0, ultimoEm: 0 };
  reg.n++;
  reg.ultimoEm = Date.now();
  _retriesPorGrupo.set(grupoJid, reg);
  const quem = String(participante || '').split('@')[0].split(':')[0].replace(/\D/g, '');
  console.warn('[ENTREGA] Retry de GRUPO #' + reg.n + ' em ' + grupoJid + (quem ? ' (participante ' + quem + ')' : '') + '.');
  // Retry vindo do PROPRIO grupo do operador jamais gera aviso: o aviso sairia
  // para o mesmo grupo com problema e poderia realimentar o ciclo de retries.
  const ehGrupoOperador = grupoJid === GRUPOS.operador;
  const nomeGrupo = NOMES_GRUPOS.get(grupoJid) || grupoJid;
  if (reg.n >= RETRY_GRUPO_AUTOCURA) {
    _retriesPorGrupo.delete(grupoJid);
    _autocuraEm.set('grupo:' + grupoJid, Date.now());
    curarSenderKeyGrupo(grupoJid);
    if (quem) resetarSessaoContato(quem).catch(() => {});
    if (!ehGrupoOperador && _podeAvisarEntrega('cura:grupo:' + grupoJid)) {
      notificarOperadorEntrega('*Entrega suspeita em grupo — autocura aplicada* \u26a0\ufe0f\n\n'
        + 'Grupo: *' + nomeGrupo + '*'
        + (quem ? '\nParticipante: *' + quem + '*' : '') + '\n\n'
        + 'Participante(s) sem a nossa sender key ("Aguardando mensagem" no aparelho deles). '
        + 'A chave sera redistribuida a todos no proximo envio ao grupo. '
        + 'Se era mensagem importante (ex.: concierge), vale *reenviar agora*.');
    }
  } else if (!ehGrupoOperador && _podeAvisarEntrega('grupo:' + grupoJid)) {
    notificarOperadorEntrega('*Entrega suspeita em grupo* \u26a0\ufe0f\n\n'
      + 'Grupo: *' + nomeGrupo + '*'
      + (quem ? '\nParticipante: *' + quem + '*' : '') + '\n\n'
      + 'Um participante pediu reenvio de mensagem nossa (possivel "Aguardando mensagem"). '
      + 'O reenvio automatico ja foi feito. Se acumular, a sender key do grupo sera redistribuida sozinha.');
  }
}

// Última mensagem capturada por grupo monitorado (observabilidade em /status).
const ultimaCapturaPorGrupo = new Map();

// ── WATCHDOG DE INBOUND 2.0 ───────────────────────────────────────────────────
// Incidentes de 13-14/08/2026 (2x em 24h): o registro do device no servidor do
// WhatsApp vicia e TODAS as mensagens param de chegar (zero upserts), com a
// conexao aparentando saude total — envio ok, /status ok. A v1 deste watchdog
// falhou em avisar porque (a) so olhava capturas de grupos monitorados na
// janela 08-20h e a surdez comecou 19h59, (b) a referencia era o boot, entao
// cada restart renovava a carencia inteira, e (c) o aviso saia apenas pelo
// proprio WhatsApp. A v2 corrige os tres pontos:
//   1. Sinal primario: upserts CRUS de QUALQUER conversa (trafego quase
//      continuo em horario util). 20 min de silencio total = socket surdo.
//   2. Marcos persistidos em sessao/health.json — restart nao zera a regua.
//   3. Autocura: 1 reconexao soft automatica; se 10 min depois continuar
//      surdo, alerta CRITICO por Telegram (bot admins) + WhatsApp operador,
//      reaviso a cada 60 min e mensagem de recuperacao quando voltar.
// O sinal de capturas (60 min sem captura de monitorados, 08-20h) permanece
// como secundario: pega pipeline quebrado com socket vivo.
const HEALTH_PATH = SESSAO_DIR + '/health.json';

const WATCHDOG_INICIO_H    = 8;                  // janela do sinal de capturas (hora SP)
const WATCHDOG_FIM_H       = 20;
const WATCHDOG_SILENCIO_MS = 60 * 60 * 1000;     // 60 min sem captura de monitorados
const WATCHDOG_REAVISO_MS  = 2 * 60 * 60 * 1000;

const SURDEZ_INICIO_H      = 7;                  // horario util (hora SP): limiar curto + reavisos
const SURDEZ_FIM_H         = 22;
const SURDEZ_SILENCIO_MS   = 20 * 60 * 1000;     // horario util: 20 min sem NENHUM upsert = surdo
// 28/08/2026: a escada passou a rodar 24h. A janela 7-22h existia para nao
// confundir madrugada quieta com surdez, mas custou caro em 27/08: a surdez
// comecou 22h03 SP (3 min depois de a janela fechar) e ficou 9h30 sem cura.
// Com ~58 grupos de promo o trafego noturno nao e zero — de noite muda so o
// LIMIAR (mais folgado) e os REAVISOS (silenciados para nao acordar ninguem).
const SURDEZ_SILENCIO_NOITE_MS = 45 * 60 * 1000; // madrugada: 45 min de silencio = surdo
const SURDEZ_POS_CURA_MS   = 6 * 60 * 1000;      // espera pos-cura antes de escalar (com o eco ativo, 6 min ja provam falha)
const SURDEZ_REAVISO_MS    = 60 * 60 * 1000;
// Valvula de escape: SURDEZ_EXIT=off desliga APENAS o degrau 3 (matar o
// processo). Os degraus 1 e 2 e os alertas continuam. Serve para os casos em
// que reiniciar custa mais caro que ficar surdo por algumas horas.
const SURDEZ_EXIT_LIGADO   = String(process.env.SURDEZ_EXIT || 'on').toLowerCase() !== 'off';

const _bootEm = Date.now();
let _watchdogAvisoEm = 0;

// Marcos persistidos: sobrevivem a restart para o deploy nao renovar carencia.
let _health = { ultimoUpsertEm: 0, ultimaCapturaEm: 0 };
try { _health = { ..._health, ...JSON.parse(readFileSync(HEALTH_PATH, 'utf-8')) }; }
catch (e) { /* primeira execucao — arquivo ainda nao existe */ }

let _healthGravadoEm = 0;
function _salvarHealth() {
  const agora = Date.now();
  if (agora - _healthGravadoEm < 60 * 1000) return; // throttle: 1 write/min
  _healthGravadoEm = agora;
  try { escreverAtomico(HEALTH_PATH, JSON.stringify(_health), 'utf-8'); }
  catch (e) { console.warn('[WATCHDOG] Falha ao gravar health.json:', e.message); }
}

// Escada de autocura da surdez (17/08/2026: 4 tentativas manuais de socket novo
// falharam; so o novo pareamento resolveu). Cada degrau alcanca uma camada mais
// profunda, e so escala se o anterior nao resolveu em SURDEZ_POS_CURA_MS:
//   ok -> cura1 (reconexao de socket)
//      -> cura2 (reconexao dura: fecha o websocket na marra; chaveiro INTACTO)
//      -> (process.exit no proprio degrau 2+: Railway sobe container novo)
//      -> alertado (esgotou o automatico; so novo QR resolve)
// Voltar a receber upsert em qualquer degrau derruba o estado para 'ok'.
// 22/08/2026: a escada vivia SO em memoria. Como o degrau 3 e o proprio deploy
// reiniciam o processo, todo restart devolvia o estado para 'ok' e a regua
// recomecava do zero (20 min + 10 + 10 = 40 min de silencio novo a cada
// restart) — foi assim que um dia inteiro de surdez passou sem alerta. Agora os
// marcos vivem em health.json e sobrevivem ao container novo.
let _surdezEstado  = _health.surdezEstado  || 'ok';
let _surdezCuraEm  = _health.surdezCuraEm  || 0;
let _surdezAvisoEm = _health.surdezAvisoEm || 0;

function _persistirSurdez() {
  _health.surdezEstado  = _surdezEstado;
  _health.surdezCuraEm  = _surdezCuraEm;
  _health.surdezAvisoEm = _surdezAvisoEm;
  _healthGravadoEm = 0;   // marco de escada e raro: grava na hora, sem throttle
  _salvarHealth();
}

// ── LOGOUT (401) ────────────────────────────────────────────────────────────
// Caso distinto da surdez e sem escada de autocura: sessao encerrada do lado do
// WhatsApp so volta com novo pareamento. Ate 22/08/2026 o ramo loggedOut era um
// console.log solitario, e como os dois watchdogs comecam com
// `if (!conectado || !sock) return` — ambos existem para socket VIVO e surdo —
// ninguem cobria a queda real. Resultado: 20h mudo com /status dizendo 'ok'.
//
// Declarado aqui, acima do ciclo do watchdog, porque o reaviso le estas
// variaveis. Persistido em health.json pelo mesmo motivo da escada acima: sem
// isso um restart zera o relogio e o reaviso de 60 min nunca chega.
let _logoutEm            = _health.logoutEm || 0;
let _logoutAvisoEm       = _health.logoutAvisoEm || 0;
let _logoutSocketTentado = !!_health.logoutSocketTentado;
let _logout401Seguidos   = _health.logout401Seguidos || 0;   // 401 seguidos sem 'open' no meio

function _persistirLogout() {
  _health.logoutEm            = _logoutEm;
  _health.logoutAvisoEm       = _logoutAvisoEm;
  _health.logoutSocketTentado = _logoutSocketTentado;
  _health.logout401Seguidos   = _logout401Seguidos;
  _healthGravadoEm = 0;
  _salvarHealth();
}

// Guarda contra restart em loop: se o creds.json estiver mesmo morto, o degrau
// o degrau 3 se repetiria a cada ciclo eternamente. Um exit por hora, no maximo —
// depois disso a escada para em 'alertado' e espera intervencao humana.
const EXIT_COOLDOWN_MS = 60 * 60 * 1000;

// E-mail: terceiro canal, e o unico que NAO depende de nenhum dos dois sistemas
// que podem estar quebrados. Em 17/08/2026 o alerta saiu apenas pelo WhatsApp
// (o bot do Telegram estava sem TELEGRAM_BOT_TOKEN, entao notificarAdmins
// retornava false silenciosamente) e ficou 2h sem ser visto no grupo.
const ALERTA_EMAIL = process.env.ALERTA_EMAIL || 'davileles@gmail.com';

async function _avisarPorEmail(texto) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !ALERTA_EMAIL) return false;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({
        from:    'CDV Servidor <alertas@clubedoviajante.com.br>',
        to:      [ALERTA_EMAIL],
        subject: 'CDV — alerta do servidor WhatsApp',
        text:    texto,
      }),
    });
    if (!res.ok) { console.error('[WATCHDOG] Resend HTTP ' + res.status); return false; }
    return true;
  } catch (e) { console.error('[WATCHDOG] E-mail falhou:', e.message); return false; }
}

async function _avisarOperador(texto, opcoes = {}) {
  // Tres canais independentes. O e-mail so entra em alertas criticos para nao
  // virar ruido — mas nesses, ele e o que garante que a mensagem chega mesmo
  // com WhatsApp surdo e bot do Telegram desligado.
  //
  // O registro na central e feito AQUI e nao em cada chamador: sao 15 pontos de
  // watchdog, e um deles ficar de fora significa uma falha de infra que nao
  // aparece na tela. Aviso de normalizacao ('OK — ...') e info: e o fim de um
  // incidente, nao um novo. Este canal nunca depende so do WhatsApp, entao o
  // envio continua sendo feito abaixo, fora de registrarAlerta.
  try {
    const _normalizou = /^OK\b|^\u2705/.test(String(texto || '').trim());
    const _prim = String(texto || '').split('\n').find(l => l.trim()) || 'Alerta do servidor';
    registrarAlerta({
      nivel: _normalizou ? 'info' : (opcoes.critico ? 'critico' : 'atencao'),
      origem: 'watchdog',
      chave: 'watchdog:' + _prim.replace(/[^a-zA-Z ]/g, '').trim().slice(0, 60),
      soRegistrar: true,
      titulo: _prim.replace(/[*_`]/g, '').slice(0, 160),
      corpo: texto,
      // O envio e feito por este proprio canal (Telegram + WhatsApp + e-mail),
      // entao a central so registra.
      janelaMs: 30 * 60 * 1000,
    }).catch(() => {});
  } catch (e) { /* registro nunca segura o alerta */ }

  let entregue = false;
  let viaTelegram = false, viaWhats = false, viaEmail = false;
  try { viaTelegram = !!(await notificarAdminsTelegram(texto)); entregue = entregue || viaTelegram; }
  catch (e) { console.error('[WATCHDOG] Telegram falhou:', e.message); }
  try { await enviarMensagem(GRUPOS.operador, { text: texto }); viaWhats = true; entregue = true; }
  catch (e) { console.error('[WATCHDOG] WhatsApp operador falhou:', e.message); }
  if (opcoes.critico) {
    viaEmail = await _avisarPorEmail(texto);
    entregue = entregue || viaEmail;
  }
  console.log('[WATCHDOG] Alerta — telegram:' + viaTelegram + ' whatsapp:' + viaWhats + ' email:' + viaEmail);
  return entregue;
}

function registrarUpsertHealth() {
  _health.ultimoUpsertEm = Date.now();
  _ecoFalhas = 0; _ecoAguardando = null;   // qualquer upsert prova inbound vivo
  _salvarHealth();
  if (_surdezEstado !== 'ok') {
    const estadoAnterior = _surdezEstado;
    _surdezEstado = 'ok';
    _surdezCuraEm = 0; _surdezAvisoEm = 0;
    _persistirSurdez();
    console.log('[WATCHDOG] Inbound recebendo upserts de novo (estava: ' + estadoAnterior + ').');
    if (estadoAnterior === 'alertado') {
      _avisarOperador('OK — Watchdog: inbound do WhatsApp voltou a receber mensagens. Sistema normalizado.').catch(() => {});
    }
  }
}

function registrarCapturaHealth() {
  _health.ultimaCapturaEm = Date.now();
  _salvarHealth();
}

function _ultimaCapturaGlobal() {
  let max = _health.ultimaCapturaEm || 0;
  for (const t of ultimaCapturaPorGrupo.values()) if (t > max) max = t;
  return max || _bootEm;
}

// ── ECO DE INBOUND (deteccao ativa de surdez) ────────────────────────────────
// A deteccao passiva (20/45 min sem upsert) e lenta e depende do trafego dos
// outros. O eco transforma isso em teste ativo: passado um silencio curto, o
// servidor manda uma mensagem PARA O PROPRIO numero. Mensagem propria volta
// pelo mesmo caminho servidor→device de qualquer outra: se o roteamento
// inbound esta vivo, ela vira upsert em segundos (e o proprio eco zera o
// relogio de silencio — correto, ja que inbound funcionando e exatamente o
// que ele prova). Dois ecos ENVIADOS com sucesso e nao recebidos = surdez
// confirmada em ~11 min do inicio do silencio, contra 20-45 min da regua
// passiva — e a escada dispara na hora, sem esperar o limiar. O envio do eco
// falhar nao conta como falha de inbound: queda de envio ja tem tratamento
// proprio (close/ping leve).
const ECO_APOS_MS     = 8 * 60 * 1000;   // silencio que dispara o primeiro eco
const ECO_ESPERA_MS   = 75 * 1000;       // prazo para o eco virar upsert
const ECO_FALHAS_CONF = 2;               // 2 ecos perdidos = surdo confirmado
let _ecoEnviadoEm  = 0;                  // quando o ultimo eco saiu
let _ecoAguardando = null;               // { id, em } do eco em transito
let _ecoFalhas     = 0;                  // ecos enviados e nao recebidos, seguidos
let _ecoUpsertRef  = 0;                  // ultimoUpsertEm no momento do envio

setInterval(async () => {
  try {
    if (!conectado || !sock) { _ecoAguardando = null; return; }
    const agora = Date.now();
    if (_ecoAguardando) {
      if ((_health.ultimoUpsertEm || 0) > _ecoUpsertRef) { _ecoAguardando = null; return; }  // chegou algo (o proprio eco conta)
      if (agora - _ecoAguardando.em < ECO_ESPERA_MS) return;                                 // ainda no prazo
      _ecoFalhas++;
      _ecoAguardando = null;
      console.warn('[ECO] Eco nao virou upsert em ' + Math.round(ECO_ESPERA_MS / 1000) + 's (' + _ecoFalhas + '/' + ECO_FALHAS_CONF + '). Inbound suspeito.');
    }
    if (agora - _bootEm < 5 * 60 * 1000) return;          // carencia pos-boot
    const silencio = agora - ((_health.ultimoUpsertEm) || _bootEm);
    if (silencio < ECO_APOS_MS) { _ecoFalhas = 0; return; }
    if (_ecoFalhas >= ECO_FALHAS_CONF) return;            // confirmado; a escada assume
    if (agora - _ecoEnviadoEm < 2 * 60 * 1000) return;    // espacamento entre ecos
    const jidProprio = sock.user?.id ? jidNormalizedUser(sock.user.id) : null;
    if (!jidProprio) return;
    _ecoEnviadoEm = agora;
    _ecoUpsertRef = _health.ultimoUpsertEm || 0;
    const r = await _enviarComTeto(sock.sendMessage(jidProprio, { text: '\u00b7' }));
    _ecoAguardando = { id: r?.key?.id || null, em: Date.now() };
    console.log('[ECO] Silencio de ' + Math.round(silencio / 60000) + ' min — eco de inbound enviado para o proprio numero.');
    // Limpeza best-effort: apaga o eco da conversa consigo mesmo dali a pouco.
    if (r?.key) setTimeout(() => { try { sock?.sendMessage(jidProprio, { delete: r.key }); } catch (e) {} }, 90 * 1000);
  } catch (e) { console.warn('[ECO] Falha ao enviar eco:', e.message); }
}, 60 * 1000).unref?.();

// Ciclo da surdez (sinal primario): a cada 60s. Era 5 min; com a escada
// dependendo dele para escalar degraus, cada ciclo largo somava ate 5 min de
// latencia POR degrau. As checagens iniciais sao baratas — rodar por minuto
// nao custa nada e corta a espera.
setInterval(async () => {
  try {
    const h = horaSP();
    const emHorarioUtil = (h >= SURDEZ_INICIO_H && h < SURDEZ_FIM_H);

    // ── REAVISO DE LOGOUT ────────────────────────────────────────────────
    // Precisa vir ANTES do bail de !conectado: logout e exatamente o caso em
    // que conectado=false, e era por isso que o alerta nunca se repetia.
    // Nao ha escada de autocura aqui — logout so se resolve com novo pareamento.
    if (_logoutEm && !conectado) {
      if (emHorarioUtil && Date.now() - _logoutAvisoEm >= SURDEZ_REAVISO_MS) {
        _logoutAvisoEm = Date.now();
        _persistirLogout();
        const min = Math.round((Date.now() - _logoutEm) / 60000);
        console.warn('[WATCHDOG] Logout persiste ha ' + min + ' min. Reavisando operador.');
        await _avisarOperador(
          'CRITICO — WhatsApp ainda DESCONECTADO ha ' + min + ' min (logout).\n\n'
          + 'Captura, radar e envio seguem parados. Fila acumulando: '
          + filaPendentes.length + ' item(ns).\n\n'
          + 'So se resolve pareando de novo: /pair (codigo de 8 digitos, so o celular) '
          + 'ou /qr. Se o QR vier vazio, POST /reset-sessao-completo antes.',
          { critico: true }
        ).catch(() => {});
      }
      return;   // sem escada: nao ha o que curar sozinho num logout
    }

    if (!conectado || !sock) return;              // queda real tem tratamento proprio
    const agora = Date.now();
    if (agora - _bootEm < 10 * 60 * 1000) return; // carencia de aquecimento pos-boot
    // NAO usar Math.max(..., _bootEm) aqui: isso fazia cada restart renovar a
    // carencia inteira — exatamente o defeito (c) que a v2 dizia ter corrigido.
    // O boot so serve de referencia quando nunca houve upsert nenhum.
    const ref      = _health.ultimoUpsertEm || _bootEm;
    const silencio = agora - ref;
    // Surdez confirmada pelo eco dispensa a regua passiva: 2 mensagens para o
    // proprio numero ja se perderam — nao ha por que esperar 20/45 min.
    const surdoConfirmado = _ecoFalhas >= ECO_FALHAS_CONF;
    if (!surdoConfirmado && silencio < (emHorarioUtil ? SURDEZ_SILENCIO_MS : SURDEZ_SILENCIO_NOITE_MS)) return;

    // ── Degrau 1: reconexao dura (websocket derrubado na marra) ──────────
    // A reconexao "soft" que morava aqui nao curou UMA surdez sequer nos 6
    // incidentes de ago/2026 — a dura (antigo degrau 2) foi promovida a
    // primeiro degrau.
    if (_surdezEstado === 'ok') {
      _surdezEstado = 'cura1';
      _surdezCuraEm = agora;
      _persistirSurdez();
      console.warn('[WATCHDOG] Socket surdo (' + (surdoConfirmado ? 'confirmado por eco; ' : '') + Math.round(silencio / 60000) + ' min sem upsert). Degrau 1: reconexao dura...');
      try {
        conectado = false;
        isConnecting = false;
        _reconectarTentativas = 0;
        if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
        if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
        const sockRef = sock;
        sock = null;
        if (sockRef) {
          try { sockRef.ws?.close?.(); } catch (e) {}
          try { sockRef.end(new Error('watchdog-surdez-degrau1')); } catch (e) {}
        }
        _agendarReconexao(5000);
      } catch (e) { console.error('[WATCHDOG] Degrau 1 falhou:', e.message); }
      // Confirmacao zerada: o eco reenvia apos a reconexao e so uma NOVA
      // dupla de ecos perdidos (ou a regua passiva) escala ao degrau 2 —
      // escalar sem reconfirmar transformaria um falso positivo em cura
      // invasiva.
      _ecoFalhas = 0; _ecoEnviadoEm = 0; _ecoAguardando = null;
      return;
    }

    // ── Degrau 2: reconexao dura (chaveiro INTACTO) ──────────────────────
    // 28/08/2026: este degrau chamava limparSessaoEReconectar(), que apaga
    // TODAS as sessions e sender keys. So que o gatilho da escada e "zero
    // upserts crus": se NADA chega, o problema e transporte/registro do device
    // — chave de grupo nao pode ser a causa, e apagar o chaveiro inteiro so
    // garantia tempestade de "Aguardando mensagem" (stub 2) quando a conexao
    // voltasse. Foi a surdez pos-cura de 27-28/08 — o mesmo trauma ja
    // documentado na cura do errosDescripto, que la virou cirurgia por grupo.
    // Aqui a licao e mais simples: com zero upserts nao ha cirurgia a fazer.
    // O degrau 2 agora e uma reconexao mais dura que o degrau 1 (fecha o
    // websocket na marra, zera timers e espera mais antes de religar),
    // preservando as chaves. Reset de sessao segue existindo, mas so manual
    // (POST /reset-sessao).
    if (_surdezEstado === 'cura1') {
      if (agora - _surdezCuraEm < SURDEZ_POS_CURA_MS) return;
      _surdezEstado = 'cura2';
      _surdezCuraEm = agora;
      _persistirSurdez();
      // ── Degrau 2: renovacao de identidade (pareamento preservado) ──────
      // Reproducao deliberada da UNICA cura que funcionou nos incidentes de
      // ago/2026: creds preservado, resto da identidade zerado, signed
      // pre-key renovado e bundle novo subido no login seguinte. Ver
      // renovarIdentidadeSessao().
      console.warn('[WATCHDOG] Reconexao dura nao resolveu. Degrau 2: renovacao de identidade (pareamento preservado)...');
      _avisarOperador('Watchdog: socket surdo ha ' + Math.round((agora - ref) / 60000) + ' min. Reconexao nao resolveu — renovando a identidade da sessao junto ao servidor do WhatsApp, SEM novo pareamento (degrau 2 de 3). Alguns "aguardando mensagem" transitorios sao esperados nos proximos minutos. Sem acao necessaria.').catch(() => {});
      try { await renovarIdentidadeSessao('watchdog-surdez-degrau2'); }
      catch (e) { console.error('[WATCHDOG] Degrau 2 falhou:', e.message); }
      _ecoFalhas = 0; _ecoEnviadoEm = 0; _ecoAguardando = null;
      return;
    }

    // ── Degrau 3: processo novo (Railway ressuscita o container) ──────────
    if (_surdezEstado === 'cura2') {
      if (agora - _surdezCuraEm < SURDEZ_POS_CURA_MS) return;
      const ultimoExit = _health.ultimoExitEm || 0;
      if (!SURDEZ_EXIT_LIGADO) {
        console.warn('[WATCHDOG] Degrau 3 desligado por SURDEZ_EXIT=off. Indo direto para alerta.');
        _surdezEstado  = 'alertado';
        _surdezAvisoEm = agora;
        _persistirSurdez();
      } else if (agora - ultimoExit < EXIT_COOLDOWN_MS) {
        console.warn('[WATCHDOG] Degrau 3 pulado: ja houve restart ha menos de 60 min. Indo direto para alerta.');
        _surdezEstado  = 'alertado';
        _surdezAvisoEm = agora;
        _persistirSurdez();
      } else {
        console.warn('[WATCHDOG] Renovacao de identidade nao resolveu. Degrau 3: encerrando o processo para o Railway subir um container novo.');
        _health.ultimoExitEm = agora;
        _healthGravadoEm = 0;              // forca o write, ignorando o throttle
        _salvarHealth();
        await _avisarOperador(
          'Watchdog: socket surdo ha ' + Math.round((agora - ref) / 60000) + ' min.\n\n'
          + 'Reconexao e renovacao de identidade nao resolveram. Reiniciando o processo '
          + '(degrau 3 de 3) — o Railway sobe um container novo em segundos.\n\n'
          + 'Se ainda assim nao voltar, sera necessario novo pareamento (QR).',
          { critico: true }
        ).catch(() => {});
        // encerrarComFlush faz o flush da fila e chama process.exit.
        // Codigo 1: sem isso o Railway trata a saida como sucesso e o container
        // nao volta — o remedio vira a doenca.
        setTimeout(() => { encerrarComFlush('watchdog-surdez-degrau3', 1); }, 1500);
        return;
      }
    } else if (!emHorarioUtil || agora - _surdezAvisoEm < SURDEZ_REAVISO_MS) {
      return;
    } else {
      _surdezAvisoEm = agora;
      _persistirSurdez();
    }
    const min = Math.round((Date.now() - ref) / 60000);
    console.warn('[WATCHDOG] Surdez persiste apos a escada completa (' + min + ' min). Alertando operador.');
    await _avisarOperador(
      'CRITICO — WhatsApp SURDO\n\n'
      + 'O servidor nao recebe NENHUMA mensagem ha ' + min + ' min (zero upserts crus). '
      + 'A escada automatica ja tentou TUDO: reconexao dura, renovacao de '
      + 'identidade da sessao e restart do processo.\n\n'
      + 'O envio pode continuar funcionando, mas captura de grupos e radar estao MORTOS.\n\n'
      + 'Correcao (exige celular em maos):\n'
      + '1) No WhatsApp do celular, desconecte o dispositivo antigo em Dispositivos conectados\n'
      + '2) POST /reset-sessao-completo\n'
      + '3) Escanear o QR em https://baileys-server-production-ebfe.up.railway.app/qr\n'
      + '   OU, so com o celular: https://baileys-server-production-ebfe.up.railway.app/pair (codigo de 8 digitos)\n\n'
      + '(Este aviso se repete a cada 60 min enquanto persistir.)',
      { critico: true }
    );
  } catch (e) { console.error('[WATCHDOG] Erro no ciclo de surdez:', e.message); }
}, 60 * 1000);

// ── WATCHDOG DE SAIDA: OFERTAS PARARAM DE SER PUBLICADAS ────────────────────
// 22/08/2026: o servidor ficou surdo as 20h07 e passou o dia inteiro sem
// publicar UMA oferta. Toda a instrumentacao existente media ENTRADA (upserts,
// capturas) — nada media o unico numero que representa faturamento: quantas
// ofertas sairam para os grupos de destino. Enquanto a escada de surdez se
// reiniciava a cada restart, ninguem foi avisado de que a operacao estava
// parada.
//
// Este ciclo e proposital e deliberadamente BURRO: nao interessa a causa
// (surdez, radar desligado, classificador quebrado, quota estourada, fila
// travada, sender key ruim). Se em horario comercial nao sai oferta nenhuma
// por PUBLICACAO_SILENCIO_MIN, alerta. Silencio de saida e sempre anomalia.
const PUBLICACAO_INICIO_H     = 8;                        // hora SP
const PUBLICACAO_FIM_H        = 22;
const PUBLICACAO_SILENCIO_MS  = Math.max(30, parseInt(process.env.PUBLICACAO_SILENCIO_MIN || '120', 10)) * 60 * 1000;
const PUBLICACAO_REAVISO_MS   = 60 * 60 * 1000;
let _publicacaoAvisoEm = _health.publicacaoAvisoEm || 0;

// Conjunto de destinos que contam como "oferta publicada". Avisos internos
// (grupo operador), respostas e mensagens de teste NAO entram — se entrassem,
// o proprio alerta do watchdog silenciaria o watchdog.
function _ehDestinoDeReceita(destino) {
  try {
    if (!destino || typeof destino !== 'string' || !destino.endsWith('@g.us')) return false;
    const alvos = new Set([...(radarDestinos() || []), ...(GRUPOS['tsp_cupons'] || [])]);
    return alvos.has(destino);
  } catch (e) { return false; }
}

function registrarPublicacaoHealth(destino) {
  try {
    // So a operacao padrao: envio de outro operador nao mede a saude desta.
    if ((tenantContexto() || TENANT_PADRAO) !== TENANT_PADRAO) return;
    if (!_ehDestinoDeReceita(destino)) return;
    const agora = Date.now();
    _health.ultimaPublicacaoEm = agora;
    const hoje = new Date(agora).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
    if (!_health.publicacoesDia || _health.publicacoesDia.data !== hoje) {
      _health.publicacoesDia = { data: hoje, n: 0 };
    }
    _health.publicacoesDia.n++;
    _salvarHealth();
    if (_publicacaoAvisoEm) {
      _publicacaoAvisoEm = 0;
      _health.publicacaoAvisoEm = 0;
      _healthGravadoEm = 0; _salvarHealth();
      _avisarOperador('OK — Watchdog de saida: ofertas voltaram a ser publicadas nos grupos.').catch(() => {});
    }
  } catch (e) { console.warn('[WATCHDOG-SAIDA] Falha ao registrar publicacao:', e.message); }
}

function publicacoesHoje() {
  const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
  return (_health.publicacoesDia && _health.publicacoesDia.data === hoje) ? _health.publicacoesDia.n : 0;
}

// ── CONTADORES DIARIOS DA OUTBOX (persistidos em health.json) ─────────────────
// Mesmo padrao de publicacoesDia: viram na data de SP, sobrevivem a restart.
// Alimentam o resumo diario; sem eles o operador so veria "pendentes agora" e
// nao saberia quantas entregas o retry salvou (ou perdeu) ao longo do dia.
function _outboxContar(campo) {
  try {
    const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
    if (!_health.outboxDia || _health.outboxDia.data !== hoje) {
      _health.outboxDia = { data: hoje, enfileiradas: 0, recuperadas: 0, desistidas: 0 };
    }
    _health.outboxDia[campo] = (_health.outboxDia[campo] || 0) + 1;
    _salvarHealth();
  } catch (e) { /* contador nunca derruba o fluxo de envio */ }
}
function outboxHoje() {
  const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
  const d = (_health.outboxDia && _health.outboxDia.data === hoje) ? _health.outboxDia : {};
  return { enfileiradas: d.enfileiradas || 0, recuperadas: d.recuperadas || 0, desistidas: d.desistidas || 0 };
}

// ── DESPACHOS DISTINTOS DO DIA ───────────────────────────────────────────────
// publicacoesDia conta ENTREGAS (uma por grupo que recebeu) — e o que o
// watchdog de saida precisa medir, mas le-lo como "ofertas" engana: uma
// oferta em 30 grupos soma 30. Este contador e o par dele: 1 por despacho
// (oferta do radar ou cupom), independente de quantos grupos. Juntos dao a
// leitura honesta: "120 entregas · 4 despachos".
function _despachoContar() {
  try {
    if ((tenantContexto() || TENANT_PADRAO) !== TENANT_PADRAO) return;
    const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
    if (!_health.despachosDia || _health.despachosDia.data !== hoje) {
      _health.despachosDia = { data: hoje, n: 0 };
    }
    _health.despachosDia.n++;
    _salvarHealth();
  } catch (e) { /* contador nunca derruba o fluxo de envio */ }
}
function despachosHoje() {
  const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
  return (_health.despachosDia && _health.despachosDia.data === hoje) ? _health.despachosDia.n : 0;
}

// ── RESUMO DIARIO AO OPERADOR ────────────────────────────────────────────────
// Uma mensagem por dia, depois das RESUMO_DIARIO_HORA (padrao 21h SP, fim da
// janela de envio do CDV), com o que importa: publicacoes, o que a outbox
// guardou/recuperou/perdeu, fila de aprovacao e saude da conexao.
// Disparo por "ja passou da hora E ainda nao mandei hoje" (marca persistida em
// health.json), nao por minuto exato: um restart no minuto certo nao perde o
// resumo, e um restart depois nao manda duas vezes.
// Comeca com "Watchdog —" de proposito: e o prefixo que _EH_AVISO_DO_SISTEMA
// reconhece, entao o proprio resumo, ao voltar como upsert do grupo operador,
// nao entra no pipeline de IA como se fosse mensagem capturada.
const RESUMO_HORA_SP = Math.min(23, Math.max(0, parseInt(process.env.RESUMO_DIARIO_HORA || '21', 10)));
setInterval(async () => {
  try {
    if (Date.now() - _bootEm < 2 * 60 * 1000) return;          // carencia pos-boot
    if (horaSP() < RESUMO_HORA_SP) return;
    const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
    if (_health.resumoDiarioData === hoje) return;
    // Marca ANTES de enviar: se todos os canais falharem perde-se um resumo,
    // o que e melhor do que repetir a cada 10 min ate alguem acordar.
    _health.resumoDiarioData = hoje;
    _healthGravadoEm = 0; _salvarHealth();

    const ob = outboxHoje();
    const minInbound = _health.ultimoUpsertEm ? Math.round((Date.now() - _health.ultimoUpsertEm) / 60000) : null;
    const pendAprov = filaPendentes.filter(o => o.status === 'pendente' && !o.autoAgendado).length;
    const conexao = conectado ? 'conectado' : (_logoutEm ? 'LOGOUT (precisa parear)' : 'DESCONECTADO');
    const [d, m] = hoje.split('-').slice(1).reverse();
    const uptimeH = ((Date.now() - _bootEm) / 3600000).toFixed(1);

    const texto = 'Watchdog — resumo do dia ' + d + '/' + m + '\n\n'
      + '📤 Entregas: ' + publicacoesHoje() + ' mensagem(ns) em grupos · ' + despachosHoje() + ' despacho(s) distinto(s)\n'
      + '🔁 Outbox: ' + ob.enfileiradas + ' guardada(s), ' + ob.recuperadas + ' recuperada(s), '
        + ob.desistidas + ' perdida(s) — ' + outboxFalhas.length + ' pendente(s) agora\n'
      + '📥 Fila de aprovacao: ' + pendAprov + ' pendente(s)\n'
      + '📡 Conexao: ' + conexao + ' · surdez ' + _surdezEstado
        + (minInbound != null ? ' · ultima msg ha ' + minInbound + ' min' : '') + '\n'
      + '⏱ Uptime: ' + uptimeH + ' h'
      + (ob.desistidas ? '\n\n⚠️ Houve entrega(s) perdida(s) hoje: confira se o bot ainda esta nos grupos de destino.' : '');
    await _avisarOperador(texto);
    console.log('[RESUMO] Resumo diario enviado.');
  } catch (e) { console.error('[RESUMO] Erro:', e.message); }
}, 10 * 60 * 1000).unref?.();

setInterval(async () => {
  try {
    const h = horaSP();
    if (h < PUBLICACAO_INICIO_H || h >= PUBLICACAO_FIM_H) return;
    const agora = Date.now();
    if (agora - _bootEm < 15 * 60 * 1000) return;     // carencia de aquecimento
    if (radarConfig().ativo === false) return;        // radar desligado de proposito
    const ref      = _health.ultimaPublicacaoEm || _bootEm;
    const silencio = agora - ref;
    if (silencio < PUBLICACAO_SILENCIO_MS) return;
    if (_publicacaoAvisoEm && (agora - _publicacaoAvisoEm) < PUBLICACAO_REAVISO_MS) return;

    _publicacaoAvisoEm = agora;
    _health.publicacaoAvisoEm = agora;
    _healthGravadoEm = 0; _salvarHealth();

    const min = Math.round(silencio / 60000);
    const horas = (min / 60).toFixed(1);
    // Diagnostico junto do alerta: sem isso o operador recebe "parou" e ainda
    // precisa abrir /status para descobrir por onde comecar.
    const minInbound = _health.ultimoUpsertEm ? Math.round((agora - _health.ultimoUpsertEm) / 60000) : null;
    let causa;
    if (!conectado || !sock)            causa = 'WhatsApp DESCONECTADO (parear em /pair ou /qr).';
    else if (_surdezEstado !== 'ok')    causa = 'socket SURDO (escada em: ' + _surdezEstado + ') — nada entra, logo nada sai.';
    else if (minInbound && minInbound > 30) causa = 'nao chega mensagem ha ' + minInbound + ' min, apesar de conectado — provavel surdez.';
    else                                causa = 'inbound OK — o problema esta no pipeline (radar, classificador, quotas ou fila).';

    await _avisarOperador(
      'CRITICO — NENHUMA OFERTA PUBLICADA ha ' + horas + 'h\n\n'
      + 'Ofertas publicadas hoje: ' + publicacoesHoje() + '.\n'
      + 'Ultima publicacao: ' + (_health.ultimaPublicacaoEm ? new Date(_health.ultimaPublicacaoEm).toLocaleString('pt-BR', { timeZone:'America/Sao_Paulo' }) : 'nenhuma desde o boot') + '.\n\n'
      + 'Diagnostico: ' + causa + '\n\n'
      + 'Enquanto isso a operacao esta sem gerar comissao.\n'
      + '(Reaviso a cada 60 min ate voltar a publicar.)',
      { critico: true }
    );
    console.warn('[WATCHDOG-SAIDA] Alerta enviado: ' + min + ' min sem publicar.');
  } catch (e) { console.error('[WATCHDOG-SAIDA] Erro no ciclo:', e.message); }
}, 10 * 60 * 1000);

// ── HEARTBEAT ATIVO (opt-in) ─────────────────────────────────────────────────
// A surdez so e detectada pela AUSENCIA de upserts — sinal ambiguo: grupo
// parado de madrugada parece socket morto. O heartbeat remove a ambiguidade:
// uma conta secundaria manda uma mensagem curta no grupo do operador e o
// socket principal PRECISA receber o upsert dela. Se dois ciclos seguidos nao
// voltarem, a surdez e certa e a escada e acionada sem esperar os 20 min.
// Desligado por padrao: definir HEARTBEAT_MIN (ex.: 15) para ligar.
const HEARTBEAT_MIN   = parseInt(process.env.HEARTBEAT_MIN || '0', 10);
const HEARTBEAT_CONTA = process.env.HEARTBEAT_CONTA || 'paulo';
let _hbFalhasSeguidas = 0;

if (HEARTBEAT_MIN > 0) {
  console.log('[HEARTBEAT] Ligado — ' + HEARTBEAT_MIN + ' min, via conta "' + HEARTBEAT_CONTA + '".');
  setInterval(async () => {
    try {
      if (!conectado || !sock) return;
      const h = horaSP();
      if (h < SURDEZ_INICIO_H || h >= SURDEZ_FIM_H) return;
      const marco = Date.now();
      const destino = GRUPOS.operador;
      if (!destino) return;
      await enviarMensagem(destino, { text: 'Heartbeat ' + new Date().toISOString() }, 0, { conta: HEARTBEAT_CONTA });
      // Espera a volta: o socket principal deve ver o upsert desta mensagem.
      await new Promise(r => setTimeout(r, 45 * 1000));
      if ((_health.ultimoUpsertEm || 0) >= marco) {
        if (_hbFalhasSeguidas > 0) console.log('[HEARTBEAT] Voltou a fechar o ciclo (ida e volta ok).');
        _hbFalhasSeguidas = 0;
        return;
      }
      _hbFalhasSeguidas++;
      console.warn('[HEARTBEAT] Mensagem enviada mas nao retornou como upsert (' + _hbFalhasSeguidas + ' seguida(s)).');
      if (_hbFalhasSeguidas >= 2 && _surdezEstado === 'ok') {
        console.warn('[HEARTBEAT] Duas falhas seguidas — acionando a escada de autocura sem esperar o silencio de 20 min.');
        _surdezEstado = 'cura1';
        _surdezCuraEm = Date.now();
        try { forcarReconexao('heartbeat-sem-volta'); } catch (e) { console.error('[HEARTBEAT] Reconexao falhou:', e.message); }
      }
    } catch (e) { console.error('[HEARTBEAT] Erro no ciclo:', e.message); }
  }, HEARTBEAT_MIN * 60 * 1000);
}

// Ciclo de capturas (sinal secundario): a cada 10 min.
setInterval(async () => {
  try {
    const h = horaSP();
    if (h < WATCHDOG_INICIO_H || h >= WATCHDOG_FIM_H) return;
    if (!conectado || !sock) return;
    const agora = Date.now();
    if (agora - _bootEm < 10 * 60 * 1000) return;
    const silencio = agora - _ultimaCapturaGlobal();
    if (silencio < WATCHDOG_SILENCIO_MS) return;
    if (agora - _watchdogAvisoEm < WATCHDOG_REAVISO_MS) return;
    if (_surdezEstado !== 'ok') return;           // surdez total ja esta alertando
    _watchdogAvisoEm = agora;
    const min = Math.round(silencio / 60000);
    console.warn('[WATCHDOG] Nenhuma captura de grupos monitorados ha ' + min + ' min (janela 08-20h SP). Avisando operador.');
    await _avisarOperador(
      'Watchdog de monitoramento\n\n'
      + 'Nenhuma mensagem capturada dos grupos monitorados ha ' + min + ' min '
      + '(janela 08h-20h), embora o socket receba trafego de outras conversas.\n\n'
      + 'Possiveis causas: grupos sem postagem (raro nesse intervalo) ou pipeline de captura quebrado. '
      + 'Verifique /debug-upserts e /debug-fila.'
    );
  } catch (e) { console.error('[WATCHDOG] Erro no ciclo:', e.message); }
}, 10 * 60 * 1000);

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
    const { state, saveCreds, flush: flushSessao } = await useAuthStateAtomico(SESSAO_DIR);
    _flushsSessao.set(SESSAO_DIR, flushSessao);
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
      getMessage: async (key) => obterMensagemEnviada(key?.id),
      // Ignora status e newsletters: reduz drasticamente o volume de decodificação
      // (e de erros Bad MAC) de conteúdo que o servidor nunca usa.
      shouldIgnoreJid: (jid) => jid === 'status@broadcast' || (typeof jid === 'string' && jid.endsWith('@newsletter')),
      // Keepalive agressivo para detectar quedas mais rápido
      keepAliveIntervalMs: 30000,
    });
    sock = novaSock;
    sock.ev.on('creds.update', saveCreds);
    // Pareamento por codigo: so faz sentido enquanto a sessao nao esta
    // registrada. O socket precisa de alguns segundos de websocket aberto
    // antes de aceitar o pedido, por isso o retry espacado.
    if (pairNumero && !novaSock.authState?.creds?.registered) {
      const numeroAlvo = pairNumero;
      (async () => {
        for (let tentativa = 1; tentativa <= 4; tentativa++) {
          await new Promise(r => setTimeout(r, tentativa === 1 ? 4000 : 4000));
          if (novaSock !== sock) return;
          if (novaSock.authState?.creds?.registered) return;
          if (pairNumero !== numeroAlvo) return;
          if (pairCodigo) return;
          try {
            const codigo = await novaSock.requestPairingCode(numeroAlvo);
            pairCodigo = String(codigo || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
            pairErro   = null;
            console.log('[WA] Codigo de pareamento gerado: ' + pairCodigo);
            return;
          } catch (e) {
            pairErro = e?.message || String(e);
            console.warn('[WA] Falha ao gerar codigo de pareamento (tentativa ' + tentativa + '): ' + pairErro);
          }
        }
      })();
    }
    // Escuta o no bruto de retry: e o aviso de que alguem nao decifrou o que
    // mandamos. Sem isso, uma campanha inteira pode nao chegar sem deixar
    // rastro nenhum no log — todo sendMessage tera retornado sucesso.
    try {
      if (typeof novaSock.ws?.on === 'function') {
        novaSock.ws.on('CB:receipt,type:retry', (node) => registrarRetryReceipt(node));
      }
    } catch (e) { console.warn('[ENTREGA] Nao foi possivel escutar retry receipts:', e.message); }
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) { qrAtual = await QRCode.toDataURL(qr); }
      if (connection === 'open') {
        conectado = true;
        _abertoEm = Date.now();
        qrAtual = null;
        pairNumero = null; pairCodigo = null; pairErro = null; pairPedidoEm = 0;
        errosDescripto = 0; _indecifraveisPorGrupo.clear();
        isConnecting = false;
        _reconectarTentativas = 0;
        _erros500Consecutivos = 0;
        _logout401Seguidos = 0;
        if (_logoutEm) {
          const min = Math.round((Date.now() - _logoutEm) / 60000);
          _logoutEm = 0; _logoutAvisoEm = 0; _logoutSocketTentado = false;
          _persistirLogout();
          _avisarOperador('OK — WhatsApp reconectado apos ' + min + ' min de logout. Captura e radar normalizados.').catch(() => {});
        }
        resetarHealthTimer();
        console.log('[WA] ✓ WhatsApp conectado!');
        // Aquece o cache de nomes: a fila mostra de qual grupo veio cada oferta.
        atualizarNomesGrupos().catch(()=>{});
        // Pos-renovacao de identidade: sobe o bundle novo (registration +
        // identity + pre-keys novas + signed pre-key novo — o mesmo no IQ do
        // registro inicial). E isto que renova o cadastro do device no
        // servidor sem novo pareamento; sem o upload, a renovacao local nao
        // teria efeito nenhum do lado de la.
        if (_renovacaoPendenteUpload) {
          _renovacaoPendenteUpload = false;
          (async () => {
            try {
              await Promise.race([
                novaSock.uploadPreKeys(),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 30s')), 30000)),
              ]);
              console.log('[RENOVACAO] Bundle novo enviado ao servidor (uploadPreKeys ok).');
            } catch (e) {
              console.error('[RENOVACAO] uploadPreKeys pos-renovacao falhou:', e.message);
            }
          })();
        }
      }
      if (connection === 'close') {
        // Um socket processa o PROPRIO close UMA unica vez. Sem esta trava, o
        // segundo evento 'close' do mesmo socket passava pela guarda de baixo
        // (sock ja esta null nessa hora) e era tratado como uma NOVA queda —
        // foi assim que 2 eventos do mesmo fechamento viraram "2 401 seguidos"
        // em 2s na noite de 28/08 e confirmaram um logout que nao existia,
        // apagando credenciais de uma sessao viva.
        if (novaSock._closeTratado) {
          console.log('[WA] Evento de close duplicado do mesmo socket ignorado.');
          return;
        }
        novaSock._closeTratado = true;
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
          // ── LOGOUT (401) ────────────────────────────────────────────────
          // Ate 22/08/2026 este ramo era so um console.log, e por isso o
          // servico ficou 20h mudo sem ninguem saber: o watchdog de surdez e o
          // de capturas comecam com `if (!conectado || !sock) return`, porque
          // ambos existem para pegar socket VIVO e surdo — queda real estava
          // delegada a este ramo, que nao avisava nada. Os tres sinais
          // concordavam em ficar quietos e /status seguia com surdezEstado 'ok'.
          // 28/08/2026: um 401 sozinho NAO prova sessao morta. Em 27 e 28/08
          // o 401 chegou ~1h depois do degrau 3 da escada e a conexao voltou
          // SOZINHA em 1 minuto — logout real so volta com novo pareamento;
          // era 401 transitorio pos-churn de reconexao. E este ramo apagava
          // creds.json + pre-keys na PRIMEIRA ocorrencia: o pareamento so
          // sobreviveu porque o flush do auth state em memoria regravou o
          // creds.json depois do delete (corrida ganha por sorte). Agora o
          // 1o 401 reconecta com as credenciais atuais; so o 2o 401 SEGUIDO
          // (sem 'open' no meio) confirma a sessao revogada — e ai sim
          // apagamos tudo e subimos o socket de QR.
          _reconectarTentativas = 0;
          _logout401Seguidos++;
          _logoutEm = Date.now();
          _logoutAvisoEm = Date.now();
          _persistirLogout();

          if (_logout401Seguidos < 2) {
            console.log('[WA] 401 recebido (1a ocorrencia). Tentando reconectar com as credenciais atuais antes de assumir logout.');
            _avisarOperador(
              'Atencao — WhatsApp caiu com codigo 401 (possivel logout).\n\n'
              + 'Pode ser transitorio (pos-instabilidade): vou reconectar com as '
              + 'credenciais atuais. Se vier um segundo 401 em seguida, a sessao '
              + 'morreu de verdade e o QR sera preparado automaticamente.'
            ).catch(() => {});
            _agendarReconexao(8000);
            return;
          }

          console.log('[WA] Logout confirmado (2o 401 seguido). Escaneie o QR novamente em /qr');
          _avisarOperador(
            'CRITICO — WhatsApp DESCONECTADO (logout)\n\n'
            + 'A sessao foi encerrada do lado do WhatsApp. Reconexao automatica NAO '
            + 'se aplica: e preciso parear de novo.\n\n'
            + 'Captura de grupos, radar e envio estao PARADOS. O Telegram segue '
            + 'funcionando e a fila continua acumulando.\n\n'
            + 'Correcao — caminho preferido (SO o celular, sem Wi-Fi):\n'
            + '1) Abrir /pair e informar o numero com DDI\n'
            + '2) No celular: WhatsApp > Dispositivos conectados > Conectar com numero de telefone\n'
            + '3) Digitar o codigo de 8 digitos\n\n'
            + 'Alternativa por QR (precisa de tela e Wi-Fi): abrir /qr. '
            + 'Se o QR vier vazio, POST /reset-sessao-completo antes.\n\n'
            + '(Este aviso se repete a cada 60 min entre 7h e 22h enquanto persistir.)',
            { critico: true }
          ).catch(() => {});

          // UMA tentativa de socket novo, so para existir QR em /qr.
          // Sem isto o qrAtual fica null para sempre (o evento 'qr' so vem de um
          // socket vivo) e a propria instrucao acima nao funciona: o operador
          // abre /qr e encontra tela vazia.
          // Tentativa UNICA de proposito: se o WhatsApp derrubou a sessao do
          // lado dele, insistir em loop pode ser lido como abuso. Se este
          // socket tambem cair, nada e reagendado — resta o /reset-sessao-completo.
          if (!_logoutSocketTentado) {
            _logoutSocketTentado = true;
            _persistirLogout();
            // Apagar as credenciais ANTES de subir o socket e obrigatorio: com
            // creds.registered=true no disco o Baileys nao emite o evento 'qr'
            // — ele tenta autenticar com chaves ja revogadas, leva 401 de novo
            // e qrAtual fica null para sempre. Em 27/08/2026 o servico passou
            // ~10h assim: o socket subia, /status mostrava sockAtivo=true com
            // qrDisponivel=false, e /qr repetia 'Gerando QR...' sem parar. Sem
            // esta limpeza a promessa do comentario acima nao se cumpre.
            console.log('[WA] Logout — apagando credenciais e subindo socket unico para gerar QR.');
            // A cadeia de escrita da sessao morta pode regravar creds.json
            // DEPOIS do apagao (corrida de 27-28/08: ora salvou o pareamento
            // por sorte, ora ressuscitou credenciais revogadas e deixou /qr
            // vazio por 10h). Drena e DESREGISTRA o flush: apagao deterministico.
            try {
              const _f = _flushsSessao.get(SESSAO_DIR);
              _flushsSessao.delete(SESSAO_DIR);
              if (_f) await _f(2000);
            } catch (e) {}
            await limparCredenciaisSessao();
            _agendarReconexao(5000);
          }
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
            monitorado: ehMonitoradoCdv(mm.key?.remoteJid),
            fonteRadar: ehFonteRadar(mm.key?.remoteJid),
            chaves: mm.message ? Object.keys(mm.message) : null,
            stub: mm.messageStubType ?? null,
          });
          if (_debugUpserts.length > 60) _debugUpserts.shift();
          if (mm.messageStubType === 2) {
            _stub2Total++;
            const jid2 = mm.key?.remoteJid || '(sem jid)';
            const r2 = _stub2PorGrupo.get(jid2) || { n: 0, ultimaEm: 0 };
            r2.n++; r2.ultimaEm = Date.now();
            _stub2PorGrupo.set(jid2, r2);
          }
        }
      } catch (e) {}
      registrarUpsertHealth();
      registrarPulsoLeitor('principal');
      if (conectado) resetarHealthTimer();
      if (type !== 'notify') {
        // Upserts 'append' (sync/reconexao) eram DESCARTADOS — e com eles:
        //   a) toda mensagem que chegava durante uma reconexao (janela em que
        //      os grupos mais postam, porque a reconexao costuma vir depois de
        //      instabilidade), e
        //   b) qualquer mensagem enviada pelo PROPRIO celular vinculado, que o
        //      WhatsApp entrega como 'append' — o que tornava impossivel testar
        //      o pipeline mandando mensagem a mao (incidente de 17/08/2026).
        // Agora processamos os de grupos monitorados; o dedup por key.id evita
        // processar de novo se a mesma mensagem voltar como 'notify'.
        const dosMonitorados = (messages || []).filter(mm => ehMonitoradoCdv(mm.key?.remoteJid));
        if (dosMonitorados.length > 0) {
          const comConteudo = dosMonitorados.filter(mm => mm.message);
          console.log('[WA] Upsert tipo "' + type + '" com ' + dosMonitorados.length + ' msg(s) de grupos monitorados: ' + comConteudo.length + ' processada(s), ' + (dosMonitorados.length - comConteudo.length) + ' sem conteudo.');
          for (const msg of comConteudo) {
            // Grupo cuja leitora e outra conta sai aqui, sem consumir o dedup.
            await despacharParaPipeline(msg, CTX_PRINCIPAL);
          }
        }
        return;
      }
      for (const msg of messages) {
        if (msg.messageStubType === 2 || (msg.message === null && !msg.key.fromMe)) {
          const jidInd = msg.key?.remoteJid || '?';
          errosDescripto++;                                          // global: /status e gatilho do hard
          const g = _indecifraveisPorGrupo.get(jidInd) || { n: 0, curas: 0, ultimaEm: 0 };
          g.n++; g.ultimaEm = Date.now();
          _indecifraveisPorGrupo.set(jidInd, g);
          console.warn('[WA] Mensagem indecifrável de ' + jidInd + ' (' + g.n + ' seguidas neste grupo; ' + errosDescripto + ' no total). Baileys enviou retry receipt ao remetente.');
          // Cura POR GRUPO a cada 8 seguidas dele, ate ERROS_GRUPO_CURAS_MAX; depois
          // so avisa — apagar mais nao adianta se o remetente nao redistribui.
          if (g.n % ERROS_GRUPO_SOFT === 0 && g.curas < ERROS_GRUPO_CURAS_MAX) { g.curas++; limparSenderKeysDoGrupo(jidInd, g.curas); }
          // Reset global SO com falha sistemica: >= ERROS_GRUPOS_HARD_MIN grupos
          // distintos acima do limiar nos ultimos 10 min. Um grupo so, por mais
          // que falhe, nunca derruba a sessao dos outros.
          const agoraInd = Date.now();
          const gruposFalhando = [..._indecifraveisPorGrupo.values()]
            .filter(x => x.n >= ERROS_GRUPO_SOFT && (agoraInd - x.ultimaEm) < 10 * 60 * 1000).length;
          if (errosDescripto >= ERROS_DESCR_MAX && gruposFalhando >= ERROS_GRUPOS_HARD_MIN) {
            console.error('[WA] Falha sistêmica de decifração: ' + gruposFalhando + ' grupos distintos. Resetando sessão.');
            errosDescripto = 0; _indecifraveisPorGrupo.clear();
            await limparSessaoEReconectar(); return;
          }
          continue;
        }
        if (msg.message) {
          errosDescripto = 0;                                        // decifrou → sessão saudável
          if (msg.key?.remoteJid) _indecifraveisPorGrupo.delete(msg.key.remoteJid); // e ESTE grupo voltou a falar
        }
        // Campanha: resposta de um contato cancela o follow-up dele na hora.
        // Sem isto o sistema cobra quem ja respondeu — o pior erro possivel
        // numa campanha de recuperacao.
        campanhaMarcarResposta(msg).catch(() => {});
        // Enfileira por grupo: mesmo grupo = sequencial, grupos distintos =
        // paralelo. Dedup por key.id (pode ja ter vindo via 'append') e guarda
        // de dono vivem dentro do despacho.
        await despacharParaPipeline(msg, CTX_PRINCIPAL);
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

// ── CANAIS DO TELEGRAM (aba Grupos do painel) ────────────────────────────────
// Lista os canais/grupos que a conta conectada segue, no formato que a trilha
// grava como fonte ('tg:<channelId>'). getDialogs e lento, entao a resposta sai
// de cache por 10 min — ?refresh=1 forca a leitura.
app.get('/tg/canais', async (req, res) => {
  if (!tgConectado || !tgClient) return res.status(503).json({ ok:false, erro:'Telegram nao conectado.' });
  const TTL = 10 * 60 * 1000;
  if (_tgCanaisCache.canais.length && req.query.refresh !== '1' && Date.now() - _tgCanaisCache.ts < TTL) {
    return res.json({ ok:true, total:_tgCanaisCache.canais.length, canais:_tgCanaisCache.canais, doCache:true });
  }
  try {
    const dialogs = await tgClient.getDialogs({ limit: 500 });
    const canais = [];
    for (const d of dialogs) {
      const ent = d.entity;
      if (!ent) continue;
      if (!(d.isChannel || d.isGroup)) continue;   // conversa privada nao e fonte
      const cid = ent.id?.toString();
      if (!cid) continue;
      const nome = ent.title || ent.username || ('canal ' + cid);
      canais.push({ id: 'tg:' + cid, nome, username: ent.username || null });
      _tgEntidadesPorId.set(cid, ent);
      NOMES_GRUPOS.set('tg:' + cid, nome);
    }
    canais.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
    _tgCanaisCache = { ts: Date.now(), canais };
    res.json({ ok:true, total:canais.length, canais });
  } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
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
  res.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>CDV Server</title><style>body{font-family:sans-serif;background:#0d0d0d;color:#f0f0f0;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;gap:16px;margin:0}h1{color:#ffa500}p{color:#aaa;font-size:14px}.links{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;margin-top:8px}a{color:#ffa500;text-decoration:none;border:1px solid #333;padding:9px 20px;border-radius:8px;font-size:14px}a:hover{border-color:#ffa500}</style></head><body><h1>CDV Baileys Server</h1><p>${statusWA}</p><p>${statusTG}</p>${emBuffer>0?'<p>'+emBuffer+' item(ns) na janela</p>':''}<div class="links">${!conectado?'<a href="/qr">Escanear QR WhatsApp</a>':''}${!conectado?'<a href="/pair">Conectar por codigo</a>':''}${!tgConectado?'<a href="/tg-auth">Conectar Telegram</a>':''}<a href="/painel">Painel${pendentes>0?' ('+pendentes+')':''}</a><a href="/status">Status</a><a href="/grupos">Grupos</a></div></body></html>`);
});

app.get('/qr', (req, res) => {
  if (conectado) return res.send('<html><body style="background:#0d0d0d;color:#ffa500;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:16px"><h2>WhatsApp ja conectado!</h2><a href="/" style="color:#ffa500">Voltar</a></body></html>');
  // Dispara conexão se ainda não estiver conectando (modo lazy)
  if (!isConnecting && !sock) iniciarConexao();
  if (!qrAtual)  return res.send('<html><head><meta http-equiv="refresh" content="3"></head><body style="background:#0d0d0d;color:#f0f0f0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh"><h2>Gerando QR...</h2></body></html>');
  res.send('<html><head><title>QR</title><meta http-equiv="refresh" content="15"><style>body{background:#0d0d0d;color:#f0f0f0;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;gap:16px;margin:0}h2{color:#ffa500}img{border:4px solid #ffa500;border-radius:12px;width:260px}p{color:#aaa;font-size:.9rem;text-align:center}</style></head><body><h2>Escanear QR Code</h2><img src="'+qrAtual+'" alt="QR"/><p>WhatsApp - Dispositivos conectados - Conectar dispositivo</p></body></html>');
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
    numerosGrupo: numerosGrupo(),
    // A aba Conexao monta os papeis de cada numero a partir DESTE endpoint. Sem
    // os dois campos abaixo ela nao tinha como saber quem le e quem dispara o
    // CDV: o seletor de leitor voltava para "principal" a cada refresh (mesmo
    // com a config gravada) e todo numero fora da escala aparecia "sem papel".
    leitores: estadoLeitores(),
    envioCdv: contaEnvioCdv() || 'principal',
  });
});

// ── NUMERO FIXO POR GRUPO DE DESTINO ─────────────────────────────────────────
// Responde as duas perguntas da tela de balanceamento: "quantos grupos cada
// numero carrega" e "que grupo ficou sem dono". Com ?conferir=1 tambem checa se
// o numero atribuido esta DENTRO do grupo — atribuicao para um numero que nao
// participa e um orfao disfarcado: nao aparece na lista de faltantes e so falha
// na hora do disparo, caindo no principal em silencio.
//
// A checagem custa UMA chamada por conta conectada (groupFetchAllParticipating),
// nao uma por grupo: por isso e opcional e nao roda no carregamento da aba.
app.get('/contas/grupos-numeros', async (req, res) => {
  if (!NOMES_GRUPOS.size) atualizarNomesGrupos().catch(() => {});
  const { ativo, mapa } = numerosGrupo();
  const soCupons = new Set(GRUPOS['tsp_cupons'] || []);
  const destinos = [...new Set([...radarDestinos(), ...soCupons])];

  const disponiveis = ['principal', ...[...contasExtras.values()]
    .filter(c => tenantDaConta(c.id) === req.tenantId)
    .map(c => apelidoDaConta(c.id))];
  const conectadas = new Set(
    (conectado ? ['principal'] : []).concat([...contasExtras.values()]
      .filter(c => tenantDaConta(c.id) === req.tenantId && c.conectado)
      .map(c => apelidoDaConta(c.id))));

  // Participacao por conta, so quando pedido.
  let participacao = null;
  if (String(req.query.conferir || '') === '1') {
    participacao = {};
    const usadas = [...new Set(Object.values(mapa))].filter(a => conectadas.has(a));
    if (conectadas.has('principal') && !usadas.includes('principal')) usadas.push('principal');
    for (const apelido of usadas) {
      try {
        const s = apelido === 'principal' ? sock
          : contasExtras.get(contaIdDe(req.tenantId, apelido))?.sock;
        if (!s) continue;
        participacao[apelido] = new Set(Object.keys(await s.groupFetchAllParticipating()));
      } catch (e) {
        console.warn('[NUM-GRUPO] Nao deu para listar grupos de ' + apelido + ': ' + e.message);
      }
    }
  }

  const grupos = destinos.map(jid => {
    const conta = mapa[jid] || null;
    const contaViva = conta ? conectadas.has(conta) : null;
    const contaExiste = conta ? disponiveis.includes(conta) : null;
    let participa = null;
    if (participacao && conta && participacao[conta]) participa = participacao[conta].has(jid);
    return {
      jid,
      nome: NOMES_GRUPOS.get(jid) || null,
      soCupons: soCupons.has(jid),
      conta,
      contaExiste,
      contaConectada: contaViva,
      participa,
      // Orfao = ninguem responde por ele. Sem atribuicao com o modo ligado,
      // atribuicao para conta que nao existe mais, ou conta que nao esta no
      // grupo: nos tres casos o disparo cai no fallback sem ninguem saber.
      orfao: ativo && (!conta || contaExiste === false || participa === false),
    };
  }).sort((a, b) => (a.nome || a.jid).localeCompare(b.nome || b.jid, 'pt-BR'));

  res.json({
    ok: true,
    ativo,
    contas: disponiveis,
    conectadas: [...conectadas],
    contaAgora: contaDoTurno(),
    turnoAtivo: turnosTsp().ativo,
    grupos,
    carga: cargaPorNumero(destinos),
    orfaos: grupos.filter(g => g.orfao).map(g => g.jid),
    semAtribuicao: gruposOrfaos(destinos),
    conferido: !!participacao,
  });
});

app.post('/contas/grupos-numeros', (req, res) => {
  try {
    const nova = salvarNumerosGrupo(req.body || {});
    const destinos = [...new Set([...radarDestinos(), ...(GRUPOS['tsp_cupons'] || [])])];
    const carga = cargaPorNumero(destinos);
    console.log('[NUM-GRUPO] Mapa gravado — ' + (nova.ativo ? 'ATIVO' : 'desligado') + ', '
      + Object.keys(nova.mapa).length + ' grupo(s) atribuido(s), '
      + gruposOrfaos(destinos).length + ' sem numero. '
      + carga.map(x => (x.conta || 'sem numero') + '=' + x.grupos).join(' '));
    res.json({ ok: true, numerosGrupo: nova, carga, semAtribuicao: gruposOrfaos(destinos) });
  } catch (e) {
    res.status(400).json({ ok: false, erro: e.message });
  }
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

  // Grupos atribuidos a ela viram orfaos EXPLICITOS: sem isto o mapa apontaria
  // para uma conta inexistente e o disparo cairia no fallback em silencio —
  // exatamente o que a aba de balanceamento existe para denunciar.
  const gruposLiberados = removerContaDosGrupos(apelidoDaConta(id));

  // Mesma razao para os papeis de leitura e de disparo do CDV: apontados para
  // uma conta que nao existe mais, contaLeitoraDe() devolve a principal e o
  // envio cai no fallback — tudo continua funcionando, e o operador nunca
  // entende por que a separacao que ele configurou "parou de valer".
  const apel = apelidoDaConta(id);
  const papeisLimpos = [];
  try {
    if (contaLeitoraCdv() === apel) { salvarConfigCdv({ leitura: { conta: '' } }); papeisLimpos.push('leitura do CDV'); }
    if (contaEnvioCdv()   === apel) { salvarConfigCdv({ envio:   { conta: '' } }); papeisLimpos.push('disparo do CDV'); }
    if (contaLeitoraTsp() === apel) { salvarConfigTsp({ leitura: { conta: '' } }); papeisLimpos.push('leitura do TSP'); }
  } catch (e) { console.warn('[CONTA:' + id + '] Falha ao limpar papeis:', e.message); }

  console.log('[CONTA:' + id + '] removida' + (desvinculou ? ' (dispositivo desvinculado)' : '')
    + (turnosRemovidos ? ' — ' + turnosRemovidos + ' turno(s) descartado(s)' : '')
    + (gruposLiberados ? ' — ' + gruposLiberados + ' grupo(s) sem numero atribuido' : '')
    + (papeisLimpos.length ? ' — devolvido(s) para a principal: ' + papeisLimpos.join(', ') : '') + '.');
  res.json({ ok:true, desvinculou, turnosRemovidos, gruposLiberados, papeisLimpos });
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
          conferidos: gruposMonitoradosCdv().length,
          faltando: ausentes(gruposMonitoradosCdv()),
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

// Confere se a conta secundaria e ADMIN em cada grupo de destino. Estar no
// grupo (endpoint acima) nao basta: sem admin ela nao gera link de convite nem
// administra o grupo no turno dela. Somente leitura; consulta em serie com
// pausa porque groupMetadata em lote derruba a conta em rate-overlimit.
app.get('/contas/:id/admin', async (req, res) => {
  const id = contaIdReq(req);
  const c = contasExtras.get(id);
  if (!c?.conectado || !c.sock) return res.status(503).json({ ok:false, erro:'conta ' + id + ' nao conectada' });

  const meus = new Set();
  for (const v of [c.sock?.user?.id, c.sock?.user?.lid]) {
    const n = String(v || '').split(':')[0].split('@')[0].trim();
    if (n) meus.add(n);
  }

  const alvos = [...new Set([...radarDestinos(), ...GRUPOS['tsp_cupons']])];
  const pausaMs = Math.min(Math.max(parseInt(req.query.pausa || '900', 10) || 900, 0), 5000);
  const grupos = [];
  for (const jid of alvos) {
    try {
      const md = await c.sock.groupMetadata(jid);
      const meu = (md.participants || []).find(p => _ggIdsDoParticipante(p).some(n => meus.has(n)));
      grupos.push({
        jid,
        nome: md.subject || NOMES_GRUPOS.get(jid) || null,
        membro: !!meu,
        admin: !!(meu && meu.admin),
        nivel: meu?.admin || null,
      });
    } catch (e) {
      grupos.push({ jid, nome: NOMES_GRUPOS.get(jid) || null, membro:null, admin:null, erro:e.message });
    }
    if (pausaMs) await new Promise(r => setTimeout(r, pausaMs));
  }

  res.json({
    ok: true,
    conta: apelidoDaConta(id),
    conferidos: alvos.length,
    admin: grupos.filter(g => g.admin === true).length,
    semAdmin: grupos.filter(g => g.admin === false).map(g => ({ jid:g.jid, nome:g.nome })),
    erros: grupos.filter(g => g.erro).map(g => ({ jid:g.jid, nome:g.nome, erro:g.erro })),
    grupos,
  });
});

// Nucleo da reconexao soft: usado pelo endpoint manual e pela autocura do
// watchdog de surdez. Declarada como function para valer por hoisting no
// watchdog, que fica acima neste arquivo.
function forcarReconexao(motivo) {
  console.log('[RECONEXAO] Forçada (' + (motivo || 'manual') + ')');
  conectado = false;
  isConnecting = false;
  _reconectarTentativas = 0;

  const sockRef = sock;
  sock = null;
  if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
  if (sockRef) { try { sockRef.end(new Error(motivo || 'manual-reconnect')); } catch(e) {} }
  _agendarReconexao(1000);
}

// ── CURA POR CONFLITO (takeover) ───────────────────────────────────────────── (redeploy 00:16Z)
// 28/08/2026, terceiro incidente do dia: a renovacao de identidade reconecta
// mas NAO cura a surdez — nem o eco para o proprio numero chega. Isso isolou o
// ingrediente ativo da unica cura ja observada: nao era o apagao local de
// chaves, era o 401 VINDO DO SERVIDOR imediatamente antes. Quando o servidor
// encerra a sessao do lado dele, a reconexao seguinte monta um estado de
// entrega NOVO; uma reconexao comum faz resume do estado viciado — por isso
// socket novo, reset de chaves e ate restart de container nunca resolveram.
//
// Nao ha como pedir um 401 sem perder o pareamento, mas o protocolo tem um
// takeover nativo: conectar um SEGUNDO socket com as mesmas credenciais faz o
// servidor derrubar o antigo com stream conflict (440 replaced) e religar a
// entrega na conexao nova — mesmo efeito de desmonte server-side, pareamento
// intacto. E o que acontece num restart rapido; aqui e feito de proposito:
// abrir o novo SEM fechar o velho.
function curarPorConflito(motivo) {
  const sockVelho = sock;
  if (!sockVelho) { forcarReconexao(motivo || 'curar-conflito-sem-sock'); return; }
  console.warn('[CONFLITO] Cura por takeover (' + (motivo || 'manual') + '): abrindo socket novo SEM fechar o atual; o servidor derruba o antigo com replaced.');
  // Listeners do velho removidos JA: evita corrida de creds.update entre os
  // dois sockets e processamento fantasma de eventos duplicados. O close 440
  // que o servidor mandar para ele seria ignorado pela guarda de sock antigo
  // de qualquer forma.
  try { sockVelho.ev.removeAllListeners('creds.update'); } catch (e) {}
  try { sockVelho.ev.removeAllListeners('connection.update'); } catch (e) {}
  try { sockVelho.ev.removeAllListeners('messages.upsert'); } catch (e) {}
  conectado = false;
  isConnecting = false;
  _reconectarTentativas = 0;
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
  // NAO fazer sockVelho.end() aqui — o desmonte precisa vir do SERVIDOR.
  conectar();
  // Teto de seguranca: se em 60s o servidor tolerou as duas conexoes (nao
  // deveria), encerra o velho localmente para nao vazar socket.
  setTimeout(() => {
    try { if (sockVelho && sockVelho !== sock) sockVelho.end(new Error('conflito-teto-60s')); } catch (e) {}
  }, 60000);
}

// ── SUPERVISOR DE ESTADO DO WEBSOCKET (socket-zumbi) ─────────────────────────
// A escada de surdez detecta o zumbi so pela AUSENCIA de upsert (20 min). Este
// supervisor e um sinal ORTOGONAL e mais rapido, baseado no estado REAL do
// websocket. O zumbi classico: o keepalive do Baileys mata o socket morto e
// emite 'close', mas o handler o descarta como "sock antigo" (novaSock !== sock)
// e retorna SEM restaurar o estado — fica 'conectado=true' com o WS fechado, e
// nenhuma reconexao e agendada. Ninguem recebe nada e nada avisa.
//
// Seguranca (o risco aqui e derrubar conexao SAUDAVEL):
//   - readyState de TCP meio-aberto ainda aparece OPEN; quem vira 'close' e o
//     keepalive. Por isso NAO tentamos adivinhar meio-aberto — checamos so o
//     estado CLOSED explicito (o zumbi ja com close mal-tratado).
//   - CONNECTING/CLOSING ficam de fora: sao transicoes normais de handshake e
//     reconexao. Agir nelas criaria tempestade de reconexao.
//   - So age quando ACREDITAMOS estar conectados (conectado===true, marcado so
//     no evento 'open') mas o WS esta CLOSED — contradicao genuina.
//   - Exige 2 leituras seguidas (60s) e pula se ja ha reconexao em voo
//     (isConnecting / _reconnectTimer / isResetting), para nao brigar com uma
//     reconexao legitima em andamento.
//   - So a conta PRINCIPAL. As secundarias tem ciclo proprio (conectarConta).
let _wsZumbiPolls = 0;
const _WS_ZUMBI_POLLS_ACAO = 2;   // 2 leituras seguidas = ~60s de inconsistencia
setInterval(() => {
  try {
    if (Date.now() - _bootEm < 60 * 1000) return;   // carencia pos-boot
    if (isConnecting || _reconnectTimer || isResetting) { _wsZumbiPolls = 0; return; }
    const wsFechado = !!(sock && sock.ws && sock.ws.isClosed);
    // Contradicao: cremos conectados, mas nao ha socket OU o WS esta CLOSED.
    const inconsistente = conectado === true && (!sock || wsFechado);
    if (!inconsistente) { _wsZumbiPolls = 0; return; }
    _wsZumbiPolls++;
    if (_wsZumbiPolls < _WS_ZUMBI_POLLS_ACAO) {
      console.warn('[SUPERVISOR-WS] Estado inconsistente (conectado=true, WS '
        + (sock ? 'CLOSED' : 'ausente') + '). Confirmacao ' + _wsZumbiPolls + '/' + _WS_ZUMBI_POLLS_ACAO + '...');
      return;
    }
    _wsZumbiPolls = 0;
    console.error('[SUPERVISOR-WS] Socket-zumbi confirmado: conectado=true com o websocket fechado. Forcando reconexao.');
    forcarReconexao('supervisor-ws-zumbi');
  } catch (e) { console.error('[SUPERVISOR-WS] Erro no ciclo:', e.message); }
}, 30 * 1000).unref?.();

// ── REABASTECIMENTO PERIODICO DE PRE-KEYS ────────────────────────────────────
// O Baileys so confere/reabastece as pre-keys no evento 'open'. Numa conexao
// que fica dias de pe, com membros entrando e reinstalando em dezenas de
// grupos, as 30 pre-keys do servidor se esgotam — e o handshake de um aparelho
// novo com o bot fica sem one-time pre-key. Conferir a cada hora custa 1 IQ de
// leitura (+1 de upload so se restarem <= 5). Cobre principal e secundarias,
// porque contaDoTurno() alterna quem despacha.
setInterval(async () => {
  const alvos = [];
  if (conectado && sock) alvos.push({ nome: 'principal', s: sock });
  for (const [id, c] of contasExtras) if (c?.conectado && c.sock) alvos.push({ nome: id, s: c.sock });
  for (const { nome, s } of alvos) {
    try {
      if (typeof s.uploadPreKeysToServerIfRequired !== 'function') continue;
      await Promise.race([
        s.uploadPreKeysToServerIfRequired(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 30s')), 30000)),
      ]);
    } catch (e) { console.warn('[PREKEYS] ' + nome + ': conferencia falhou — ' + e.message); }
  }
}, 60 * 60 * 1000).unref?.();

app.post('/reconectar', async (req, res) => {
  forcarReconexao('endpoint-/reconectar');
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
  res.json({ conectado, sockAtivo:!!sock, qrDisponivel:!!qrAtual, telegramConectado:tgConectado, telegramAuthState:tgAuthState, telegramGrupos:TG_CANAIS_MONITORADOS, tgFontesRadar:tgFontesRadar(), autoEnvioCupom:autoEnvioModo(), telegramConta:tgConta, grupos:Object.keys(GRUPOS), gruposMonitorados:gruposMonitoradosCdv(), leitores:estadoLeitores(), radarFontes:radarFontes(), radarDestinos:radarDestinos(), mlOrigemProduto:estadoOrigemSocialMl(), radarAtivo:radarConfig().ativo!==false, bufferAtivo:emBuffer, filaPendentes:filaPendentes.filter(o=>o.status==='pendente'&&!o.autoAgendado).length, filaTotal:filaPendentes.length, reconectarTentativas:_reconectarTentativas, conexaoEmAndamento:!!_conexaoPromise, errosDecodificacao:errosDescripto, indecifraveisStub:_stub2Total, indecifraveisStubGrupos:[..._stub2PorGrupo].sort((a,b)=>b[1].n-a[1].n).slice(0,10).map(([j,r])=>({jid:j,n:r.n,ultimaEm:new Date(r.ultimaEm).toISOString()})), entregasSuspeitas:_retriesPorUser.size, ultimoUpsertEm:(_health.ultimoUpsertEm?new Date(_health.ultimoUpsertEm).toISOString():null), surdezEstado:_surdezEstado, ultimaPublicacaoEm:(_health.ultimaPublicacaoEm?new Date(_health.ultimaPublicacaoEm).toISOString():null), publicacoesHoje:publicacoesHoje(), ultimasCapturas:Object.fromEntries([...ultimaCapturaPorGrupo].map(([j,t])=>[j, new Date(t).toISOString()])) });
});

// ── HEALTH CHECK PARA MONITOR EXTERNO ─────────────────────────────────────────
// Endpoint simples para um monitor externo (UptimeRobot, BetterStack, etc)
// pingar a cada poucos minutos e AVISAR UM HUMANO quando o WhatsApp cai — o
// terceiro sinal, fora dos watchdogs internos. Diferente do /status (que sempre
// responde 200 com o retrato detalhado), aqui o CODIGO HTTP carrega o veredito:
//   200  saudavel  — socket conectado, recebendo, sem logout pendente
//   503  degradado — desconectado, surdo (escada != ok) ou logout ativo
// PROPOSITO: alerta a humano. NAO e para o Railway usar como healthcheck de
// deploy: reiniciar nao cura logout (so novo pareamento) e um healthcheck que
// derruba o container a cada queda do WhatsApp viraria loop. Por isso o
// railway.json NAO aponta healthcheckPath para ca — o restart fica com o
// crash-only + a escada de surdez.
app.get('/health', (req, res) => {
  const agora = Date.now();
  const minSemUpsert = _health.ultimoUpsertEm
    ? Math.round((agora - _health.ultimoUpsertEm) / 60000) : null;
  const logoutMin = _logoutEm ? Math.round((agora - _logoutEm) / 60000) : null;

  const saudavel = conectado && !!sock && _surdezEstado === 'ok' && !_logoutEm;

  // Motivo legivel para o painel do monitor (aparece no corpo da resposta).
  let motivo = 'ok';
  if (!conectado || !sock)          motivo = 'whatsapp desconectado';
  else if (_logoutEm)               motivo = 'logout — precisa parear (/pair ou /qr)';
  else if (_surdezEstado !== 'ok')  motivo = 'socket surdo (escada: ' + _surdezEstado + ')';

  res.status(saudavel ? 200 : 503).json({
    ok: saudavel,
    motivo,
    conectado,
    sockAtivo: !!sock,
    surdezEstado: _surdezEstado,
    logout: !!_logoutEm,
    logoutMin,
    minSemUpsert,
    telegramConectado: tgConectado,
    publicacoesHoje: publicacoesHoje(),
    despachosHoje: despachosHoje(),
    filaTotal: filaPendentes.length,
    uptimeSeg: Math.round((agora - _bootEm) / 1000),
  });
});

app.get('/fila-envio', (req, res) => {
  // Devolve dados estruturados + previsao de horario para a aba "Enviadas hoje"
  // do gerador conseguir montar a lista de PROGRAMADAS (aprovadas mas ainda nao
  // publicadas) com as mesmas colunas das ja enviadas.
  const itens = filaEnvio.map((item, idx) => {
    const oferta = filaPendentes.find(o => String(o.id) === String(item.ofertaId));
    const de     = oferta?.dadosExtraidos || item.dados || null;
    const prev   = calcularPosicaoFila(idx);
    return {
      posicao:  idx + 1,
      ofertaId: item.ofertaId,
      destino:  item.destino,
      preview:  item.mensagem.substring(0, 80) + (item.mensagem.length > 80 ? '...' : ''),
      // origem do envio: 'auto' (captura em grupo monitorado, automatico)
      // | 'coleta' (varredura seats.aero, automatico) | 'aprovacao' | 'emissao'
      origemEnvio: item.fonte === 'emissao' ? 'emissao'
                 : (oferta?.autoEnviado
                     ? ((capturaDaOferta(oferta) || item.captura) === 'coleta' ? 'coleta' : 'auto')
                     : 'aprovacao'),
      auto:         !!oferta?.autoEnviado,
      tipoConteudo: oferta?.tipoConteudo || null,
      dados: de ? {
        origem:     de.origem     || '',
        destino:    de.destino    || '',
        cia:        de.cia        || '',
        programa:   de.programa   || '',
        pontos:     Number(de.pontos) || 0,
        cabine:     de.cabine     || '',
        datasIda:   de.datasIda   || de.datas_ida   || '',
        datasVolta: de.datasVolta || de.datas_volta || '',
      } : null,
      previsaoMin:     prev.tempoMin,
      previsaoHorario: prev.horario,
    };
  });
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

// Forca o reenfileiramento de tudo que esta 'aprovado' e nao esta na fila.
// A automacao (Cowork) pode chamar como ultimo passo, depois de injetar, para
// nao depender da varredura de 5 min.
app.post('/fila-envio/reenfileirar', (req, res) => {
  const n = requeueAprovadas('por chamada manual');
  res.json({ ok: true, reenfileiradas: n, total: filaEnvio.length, workerAtivo: workerRodando });
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

// Fase 2: a filaRadar vivia SO em memoria — qualquer restart (deploy, crash,
// degrau 3 do watchdog) descartava tudo que estava esperando o intervalo de
// 3 min, e o retry desistia em 30s (3x10s): exatamente quando o socket cai por
// alguns minutos, a oferta era jogada fora. Agora persiste (escrita atomica) a
// cada mudanca e retenta com o mesmo backoff da outbox, com teto para nao girar
// para sempre num destino envenenado.
const FILA_RADAR_PATH = SESSAO_DIR + '/fila_radar.json';
const RADAR_MAX_TENTATIVAS = 12;
function salvarFilaRadar() {
  try { escreverAtomico(FILA_RADAR_PATH, JSON.stringify(filaRadar)); }
  catch (e) { console.error('[RADAR] Erro ao salvar fila:', e.message); }
}
function carregarFilaRadar() {
  try {
    if (!existsSync(FILA_RADAR_PATH)) return;
    const lista = JSON.parse(readFileSync(FILA_RADAR_PATH, 'utf-8'));
    if (Array.isArray(lista)) {
      filaRadar.push(...lista.filter(x => x && x.mensagem && x.grupo));
      if (filaRadar.length) console.log('[RADAR] ' + filaRadar.length + ' item(ns) recuperado(s) do disco.');
    }
  } catch (e) { console.error('[RADAR] Erro ao carregar fila:', e.message); }
}
carregarFilaRadar();
// Retoma o worker depois que o socket do boot teve tempo de subir.
if (filaRadar.length) {
  setTimeout(() => { radarWorker().catch(e => { console.error('[RADAR] Worker erro:', e.message); radarWorkerRodando = false; }); }, 15000);
}

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
      salvarFilaRadar();
      radarUltimoEnvioMs = Date.now();
      console.log('[RADAR] ✓ Oferta "' + item.id + '" enviada. Restam ' + filaRadar.length + '.');
    } catch(e) {
      console.error('[RADAR] ✗ Erro ao enviar "' + item.id + '":', e.message);
      item.tentativas = (item.tentativas || 0) + 1;
      if (item.tentativas >= RADAR_MAX_TENTATIVAS) {
        console.error('[RADAR] Desistindo após ' + item.tentativas + ' tentativas: ' + item.id);
        filaRadar.shift();
        salvarFilaRadar();
        _avisarOperador('Radar CDV: desisti de enviar "' + item.id + '" para ' + (NOMES_GRUPOS.get(item.grupo) || item.grupo)
          + ' apos ' + item.tentativas + ' tentativas. Ultimo erro: ' + e.message).catch(() => {});
        continue;
      }
      salvarFilaRadar();
      // Backoff crescente (1, 2, 5, 10, 20, 30 min): socket caido costuma voltar
      // em minutos; martelar a cada 10s so queimava as tentativas.
      const esperaRetry = outboxBackoffMs(item.tentativas);
      console.log('[RADAR] Proxima tentativa em ' + Math.round(esperaRetry / 60000) + ' min.');
      await new Promise(r => setTimeout(r, esperaRetry));
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
  salvarFilaRadar();

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

// Diario cru das capturas do radar. Serve para responder "o que o WhatsApp
// realmente entregou?" sem depender do texto ja interpretado.
// ── TELA DE ALERTAS ─────────────────────────────────────────────────────────
app.get('/alertas', (req, res) => {
  const nivel = String(req.query.nivel || '').trim();
  const origem = String(req.query.origem || '').trim();
  const busca = String(req.query.busca || '').toLowerCase().trim();
  const n = Math.min(Number(req.query.n) || 100, ALERTAS_MAX);
  let itens = alertas;
  if (nivel && NIVEIS_ALERTA.includes(nivel)) itens = itens.filter(x => x.nivel === nivel);
  if (origem) itens = itens.filter(x => x.origem === origem);
  if (busca) itens = itens.filter(x => (x.titulo + ' ' + x.corpo).toLowerCase().includes(busca));
  const naoLidos = { critico: 0, atencao: 0, info: 0 };
  for (const x of alertas) if (!x.lido && naoLidos[x.nivel] != null) naoLidos[x.nivel]++;
  res.json({
    ok: true, total: alertas.length, naoLidos,
    origens: [...new Set(alertas.map(x => x.origem))].sort(),
    destinoPorNivel: DESTINO_POR_NIVEL,
    itens: itens.slice(0, n),
  });
});

app.post('/alertas/lido/:id', (req, res) => {
  const alvo = alertas.find(x => String(x.id) === String(req.params.id));
  if (!alvo) return res.status(404).json({ ok:false, erro:'alerta nao encontrado' });
  alvo.lido = req.body?.lido === false ? false : true;
  salvarAlertas();
  res.json({ ok:true, alerta: alvo });
});

app.post('/alertas/lidos', (req, res) => {
  const nivel = String(req.body?.nivel || '').trim();
  let n = 0;
  for (const x of alertas) {
    if (nivel && x.nivel !== nivel) continue;
    if (!x.lido) { x.lido = true; n++; }
  }
  salvarAlertas();
  res.json({ ok:true, marcados: n });
});

// Pulso das plataformas: quando cada loja rendeu oferta pela ultima vez. E o
// que sustenta o alerta de "plataforma parada" e serve de painel na tela.
app.get('/alertas/pulso', (req, res) => {
  const agora = Date.now();
  // As duas vias lado a lado: sem elas nao da para distinguir, na tela, "loja
  // parada" de "captura em grupo parada" — que pedem acoes diferentes.
  const lojas = new Set([...Object.keys(pulsoLojas), ...Object.keys(pulsoDespacho)]);
  const horas = (ts) => ts ? Math.floor((agora - Number(ts)) / 3600e3) : null;
  const itens = [...lojas]
    .map((loja) => {
      const tsRadar = Number(pulsoLojas[loja] || 0);
      const tsDesp  = Number(pulsoDespacho[loja] || 0);
      const radarParado = tsRadar > 0 && (agora - tsRadar) >= PULSO_LIMITE_MS;
      const despParado  = tsDesp  > 0 && (agora - tsDesp)  >= PULSO_LIMITE_MS;
      return {
        loja,
        ultimaEm:     tsRadar ? new Date(tsRadar).toISOString() : null,
        horasParada:  horas(tsRadar),
        parada:       radarParado,
        despacho: {
          ultimaEm:    tsDesp ? new Date(tsDesp).toISOString() : null,
          horasParada: horas(tsDesp),
          parada:      despParado,
        },
        // 'ok' = tudo fluindo | 'so-radar' = captura parou, loja viva
        // 'parada' = nada saiu por caminho nenhum
        situacao: !radarParado ? 'ok'
                : (tsDesp && !despParado) ? 'so-radar'
                : 'parada',
      };
    })
    .sort((a, b) => (b.horasParada || 0) - (a.horasParada || 0));
  res.json({ ok:true, limiteHoras: PULSO_LIMITE_MS / 3600e3, itens });
});

app.get('/radar/capturas', (req, res) => {
  const n = Math.min(Number(req.query.n) || 20, CAPTURAS_MAX);
  const busca = String(req.query.busca || '').toLowerCase();
  let itens = capturasBrutas;
  if (busca) itens = itens.filter(x => (x.texto || '').toLowerCase().includes(busca)
                                    || (x.msgId || '').toLowerCase().includes(busca));
  res.json({ ok: true, total: capturasBrutas.length, itens: itens.slice(0, n) });
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
      // Cupom agendado para auto-envio pertence a aba Fila (/operacao/fila),
      // nao a Aprovacao: enquanto o worker de espacamento nao envia, o item
      // fica fora deste payload. Se expirar ou falhar, o worker deleta o
      // autoAgendado e ele volta a aparecer aqui para aprovacao manual.
      .filter(o => !(o.autoAgendado && (o.status === 'pendente' || o.status === 'enviando')))
      .slice(0,50).map(o => ({ ...o, conteudoOriginal: typeof o.conteudoOriginal==='string'?o.conteudoOriginal:(Array.isArray(o.conteudoOriginal)?o.conteudoOriginal.join('\n'):''), imagens:Array.isArray(o.imagens)?o.imagens:[] }));
    // Detalhe do buffer por grupo: sem isto a aba Alertas so sabe que existem N
    // itens em algum lugar, que e quase tao opaco quanto nao saber nada.
    const buffer = [...bufferAgrupamento.entries()].map(([jid, e]) => ({
      jid,
      grupo: NOMES_GRUPOS.get(jid) || null,
      itens: e.itens.length,
      desdeEm: e.desdeEm ? new Date(e.desdeEm).toISOString() : null,
      fechaEm: e.fechaEm ? new Date(e.fechaEm).toISOString() : null,
    })).sort((a, b) => String(a.fechaEm).localeCompare(String(b.fechaEm)));
    res.json({ ok:true, bufferAtivo:emBuffer, janelaMin: JANELA_AGRUPAMENTO_MS / 60000, buffer, ofertas });
  } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
});

// Descartes do pipeline de alertas: o que chegou, foi processado e nao virou
// item na fila. Serve para responder "por que esse alerta nao apareceu?" sem
// abrir o log do Railway.
app.get('/cdv/descartes', (req, res) => {
  const limite = Math.min(Number(req.query.limite) || 60, DESCARTES_MAX);
  const motivo = String(req.query.motivo || '').trim().toLowerCase();
  const jid    = String(req.query.jid || '').trim();
  let lista = _descartesCdv;
  if (motivo) lista = lista.filter(d => d.motivo.toLowerCase().includes(motivo));
  if (jid)    lista = lista.filter(d => d.jid === jid);
  const porMotivo = {};
  for (const d of _descartesCdv) porMotivo[d.motivo] = (porMotivo[d.motivo] || 0) + 1;
  res.json({ ok: true, total: _descartesCdv.length, porMotivo, itens: lista.slice(0, limite) });
});

// Resumo da campanha ativa para a aba Fila. Cache de 60s porque a aba recarrega
// a cada poucos segundos e cada leitura aqui e uma ida ao proxy CDV — sem o
// cache, abrir a aba viraria uma rajada de requisicoes no proxy.
let _cacheCampFila = { em: 0, dados: null };
async function resumoCampanhaFila() {
  if (!CAMPANHAS_KEY) return null;
  if (Date.now() - _cacheCampFila.em < 60000) return _cacheCampFila.dados;
  let dados = null;
  try {
    const { campanha } = await campApi('/campanhas/ativa');
    if (campanha) {
      const cfg = campanha.config || {};
      const por = { fila:0, enviado:0, respondido:0, erro:0, optout:0 };
      (campanha.contatos || []).forEach(ct => { if (por[ct.status] !== undefined) por[ct.status]++; });
      dados = {
        id:             campanha.id,
        nome:           campanha.nome,
        naFila:         por.fila,
        enviados:       por.enviado,
        respondidos:    por.respondido,
        enviosHoje:     campEnviosHoje(campanha),
        limiteDiario:   cfg.limiteDiario || null,
        dentroDaJanela: campDentroDaJanela(cfg),
        janelas:        Array.isArray(cfg.janelas) ? cfg.janelas.map(j => j[0] + '-' + j[1]).join(', ') : '',
        pausaLongaAte:  _campPausaAte > Date.now() ? new Date(_campPausaAte).toISOString() : null,
      };
    }
  } catch (e) {
    // Campanha e um extra desta aba: se o proxy nao responder, os cupons e as
    // listas ainda precisam aparecer.
    console.warn('[OPERACAO] Resumo de campanha indisponivel:', e.message);
  }
  _cacheCampFila = { em: Date.now(), dados };
  return dados;
}

// ── FILA DE ENVIO DO TSP (somente leitura) ───────────────────────────────────
// O que ja passou por TODAS as regras de conteudo e so espera a hora de sair:
// bloqueio temporal (janela de horario ou intervalo minimo entre mensagens).
// Sao os cupons marcados com autoAgendado pelo gate — ou seja, itens que VAO
// para o grupo sem nova decisao humana. A aba Fila do painel so exibe; quem
// aprova ou rejeita e a aba Aprovacao, que continua em /painel-json.
// Imagem de um item da fila, buscada so quando o operador abre a previa.
// Fica fora do payload de /operacao/fila porque a aba recarrega a cada 12s e
// base64 de imagem em cada ciclo pesaria o polling sem necessidade.
app.get('/operacao/fila/imagem/:id', (req, res) => {
  try {
    const id = String(req.params.id || '');
    const o = filaPendentes.find(x =>
      String(x.id) === id && (x.tenant || TENANT_PADRAO) === req.tenantId);
    if (!o) return res.status(404).json({ ok:false, erro:'item não encontrado' });
    const img = Array.isArray(o.imagens) && o.imagens[0] ? o.imagens[0] : null;
    if (!img || !img.imagemBase64) return res.json({ ok:true, temImagem:false });
    res.json({ ok:true, temImagem:true, mime: img.mime || 'image/jpeg', base64: img.imagemBase64 });
  } catch (e) { res.status(500).json({ ok:false, erro:e.message }); }
});

// Leitura do histórico durável de envios. ?mes=YYYY-MM (padrão: mês atual SP).
// Serve o painel e qualquer análise futura de desempenho de ofertas.
app.get('/operacao/historico-envios', async (req, res) => {
  try {
    const mes = /^\d{4}-\d{2}$/.test(String(req.query.mes || ''))
      ? String(req.query.mes)
      : new Intl.DateTimeFormat('en-CA', { timeZone: TZ_SP, year:'numeric', month:'2-digit' }).format(new Date());
    const nome = 'historico_envios_' + mes + '.json';
    const local = (req.tenantId === TENANT_PADRAO) ? nome : 'tenants/' + req.tenantId + '/' + nome;
    const regs = await _registrosDoShard(local);
    res.json({ ok: true, mes, total: regs.length, registros: regs });
  } catch (e) { res.status(500).json({ ok:false, erro: e.message }); }
});

// ── BACKFILL DO HISTORICO DE ENVIOS ──────────────────────────────────────────
// Reparo de lacunas: ate o commit fb053c9 o disparo por LISTA e o disparo
// avulso da vitrine nao chamavam registrarEnvioHistorico, entao saiam sem
// deixar registro. A reconstrucao vem de fontes que gravaram no momento do
// disparo (rastreio.json e o ultimoDisparo da vitrine), nunca de estimativa.
//
// Passa pelo servidor, e nao por commit direto no repo, de proposito: o shard
// vive em cache de memoria e no disco do container, e uma edicao so no GitHub
// seria sobrescrita no proximo append. Aqui o append entra pelo MESMO caminho
// dos envios reais.
//
// Cada registro entra com backfill:true — o dado reconstruido nunca se confunde
// com o gravado ao vivo. Idempotente por id: repetir a chamada nao duplica.
app.post('/operacao/historico-envios/backfill', async (req, res) => {
  try {
    const mes  = String(req.body?.mes || '').trim();
    const itens = Array.isArray(req.body?.registros) ? req.body.registros : [];
    if (!/^\d{4}-\d{2}$/.test(mes)) return res.status(400).json({ ok:false, erro:'mes deve ser YYYY-MM' });
    if (!itens.length) return res.status(400).json({ ok:false, erro:'nenhum registro enviado' });

    const local = 'historico_envios_' + mes + '.json';
    const regs  = await _registrosDoShard(local);
    const jaTem = new Set(regs.map(r => String(r.id)));

    const inseridos = [], repetidos = [];
    for (const it of itens) {
      const id = String(it.id || '').trim();
      if (!id) continue;
      if (jaTem.has(id)) { repetidos.push(id); continue; }
      jaTem.add(id);
      regs.push({
        id,
        enviadoEm:     it.enviadoEm || null,
        tipoConteudo:  it.tipoConteudo || null,
        subtipo:       it.subtipo ?? null,
        loja:          it.loja ?? null,
        titulo:        it.titulo ? String(it.titulo).slice(0, 120) : null,
        codigo:        it.codigo ?? null,
        valor:         it.valor ?? null,
        tipo:          it.tipo ?? null,
        precoDe:       it.precoDe ?? null,
        preco:         it.preco ?? null,
        precoFinal:    it.precoFinal ?? it.preco ?? null,
        desconto:      it.desconto ?? null,
        descontoPct:   it.descontoPct ?? null,
        asin:          it.asin ?? null,
        link:          it.link ?? null,
        origem:        it.origem ?? null,
        gruposDestino: it.gruposDestino ?? null,
        autoEnviado:   !!it.autoEnviado,
        temImagem:     !!it.temImagem,
        mensagens:     it.mensagens ?? 1,
        // Procedencia do registro: reconstruido, e de onde veio o numero.
        backfill:      true,
        backfillFonte: it.backfillFonte || 'nao informado',
        backfillEm:    new Date().toISOString(),
      });
      inseridos.push(id);
    }

    regs.sort((a, b) => String(a.enviadoEm || '').localeCompare(String(b.enviadoEm || '')));

    const caminho = SESSAO_DIR + '/' + local;
    const dir = caminho.slice(0, caminho.lastIndexOf('/'));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    escreverAtomico(caminho, JSON.stringify({ registros: regs }), 'utf-8');
    agendarPush(local);

    console.log('[BACKFILL] ' + local + ' — ' + inseridos.length + ' inserido(s), '
      + repetidos.length + ' ja existia(m). Total no shard: ' + regs.length + '.');
    res.json({ ok:true, mes, inseridos: inseridos.length, repetidos: repetidos.length,
               totalNoShard: regs.length });
  } catch (e) { res.status(500).json({ ok:false, erro: e.message }); }
});

// conteudoOriginal chega como string (captura unica) ou array (itens que o
// agrupador juntou). A aba Fila precisa do texto cru da fonte para comparar
// com a mensagem formatada — e a unica forma de flagrar no painel um cupom
// que saiu com codigo diferente do que o post/anuncio dizia.
function originalDaFila(o) {
  const c = o && o.conteudoOriginal;
  const t = Array.isArray(c) ? c.filter(Boolean).join('\n\n') : String(c || '');
  return t.slice(0, 4000);
}

app.get('/operacao/fila', async (req, res) => {
  try {
    const agora        = Date.now();
    const janela       = dentroDaJanelaCupom();
    const intervaloMs  = intervaloAutoEnvioMs();
    // Sem envio anterior nesta instancia, o proximo esta liberado agora.
    const liberadoEm   = _ultimoAutoEnvio ? _ultimoAutoEnvio + intervaloMs : agora;

    const aguardando = filaPendentes
      .filter(o => (o.tenant || TENANT_PADRAO) === req.tenantId)
      .filter(o => o.autoAgendado && (o.status === 'pendente' || o.status === 'enviando'))
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    // Previsao em cascata: o primeiro sai quando o intervalo liberar, os demais
    // um intervalo depois do anterior. Fora da janela nao ha previsao honesta
    // (a janela pode virar o dia), entao devolve null e o painel diz o motivo.
    let cursor = Math.max(agora, liberadoEm);
    const itens = aguardando.map(o => {
      const d  = o.dadosExtraidos || {};
      const ts = new Date(o.timestamp).getTime();
      const saindo = o.status === 'enviando';
      const previsao = (janela.ok && !saindo) ? cursor : null;
      if (janela.ok && !saindo) cursor += intervaloMs;
      // Envio que passou de ENVIANDO_TRAVADO_MS nao esta saindo: alguma coisa
      // ficou pendurada no meio do caminho e ninguem seria avisado.
      const desde = o.enviandoDesde ? Date.parse(o.enviandoDesde) : null;
      const travado = saindo && (!desde || agora - desde > ENVIANDO_TRAVADO_MS);
      const rotuloCupom = `${nomeLojaExibicao(d.loja)} ${d.valor ?? ''}${d.tipo === 'pct' ? '%' : (d.valor ? ' R$' : '')}${d.codigo ? ' · ' + d.codigo : ''}`;
      return {
        id:           o.id,
        tipoConteudo: o.tipoConteudo,
        titulo:       (o.tipoConteudo === 'cupom_tsp' ? rotuloCupom : (d.titulo || nomeLojaExibicao(d.loja) || 'Oferta')).trim(),
        loja:         d.loja || null,
        codigo:       d.codigo || null,
        origem:       o.grupoOrigem || o.origem || null,
        status:       o.status,
        travado,
        enviandoDesde: o.enviandoDesde || null,
        timestamp:    o.timestamp,
        motivo:       (o.autoAvaliacao && o.autoAvaliacao.motivo) || '',
        // Mensagem completa (limite de seguranca 4096): a previa da aba Fila
        // precisa mostrar exatamente o que vai sair no grupo, sem corte.
        mensagem:     String(o.mensagemFormatada || '').slice(0, 4096),
        original:     originalDaFila(o),
        temImagem:    Array.isArray(o.imagens) && o.imagens.length > 0,
        previsaoEm:   previsao ? new Date(previsao).toISOString() : null,
        expiraEm:     ts && !isNaN(ts) ? new Date(ts + AUTO_ENVIO_MAX_ESPERA).toISOString() : null,
      };
    });

    // Listas em disparo: a outra origem de mensagem que ja esta liberada e so
    // espera a hora. Vem daqui (e nao de /listas no painel) para a aba fazer uma
    // chamada so — ela recarrega a cada poucos segundos.
    const listas = listarListas()
      .filter(l => l.execucao)
      .map(l => {
        const ex        = l.execucao;
        const total     = (l.produtos || []).length;
        const restantes = Math.max(0, total - (ex.indice || 0));
        const proximoEm = Math.max(Number(ex.proximoEm) || agora, agora);
        const jan       = janelaEnvioLista(l);
        return {
          id:             l.id,
          nome:           l.nome,
          total,
          restantes,
          pausada:        !!ex.pausada,
          proximoEm:      new Date(proximoEm).toISOString(),
          intervaloMin:   l.intervaloMin || null,
          dentroDaJanela: jan.ok,
          janelas:        jan.janelas,
          terminaAs:      dataHoraSP(previsaoTerminoLista(l, proximoEm, restantes).terminaEm),
        };
      });

    // Campanha e da operacao principal: nao ha campanha por operador hoje.
    const campanha = req.tenantId === TENANT_PADRAO ? await resumoCampanhaFila() : null;

    // Enviados recentes: rastro do que ja saiu e DE ONDE veio. Sem isto a aba
    // Fila so mostrava o que espera a vez; capturas de grupo com auto-envio
    // ligado saem na hora e nunca apareciam — parecia que nada era enviado
    // (incidente de 13/08/2026: horas de duvida sobre represamento vs captura).
    const enviados = filaPendentes
      .filter(o => (o.tenant || TENANT_PADRAO) === req.tenantId)
      .filter(o => o.status === 'enviado')
      // Aba Fila do TSP: rastro so de conteudo TSP (cupom/oferta de loja)
      // mais os disparos manuais feitos pelo proprio painel (manual_tsp).
      // Emissoes CDV e campanhas aprovadas no gerador tambem viram 'enviado'
      // na filaPendentes, mas nao pertencem a este painel.
      .filter(o => ehConteudoTsp(o.tipoConteudo) || o.tipoConteudo === 'manual_tsp')
      .sort((a, b) => new Date(b.enviadoEm || b.timestamp) - new Date(a.enviadoEm || a.timestamp))
      .slice(0, 20)
      .map(o => {
        const d = o.dadosExtraidos || {};
        const origem = o.grupoOrigem || o.origem || null;
        const rotuloCupom = `${nomeLojaExibicao(d.loja)} ${d.valor ?? ''}${d.tipo === 'pct' ? '%' : (d.valor ? ' R$' : '')}${d.codigo ? ' \u00b7 ' + d.codigo : ''}`;
        return {
          id:            o.id,
          tipoConteudo:  o.tipoConteudo,
          subtipo:       d.subtipo || null,
          titulo:        (o.tipoConteudo === 'cupom_tsp' ? rotuloCupom : (d.titulo || nomeLojaExibicao(d.loja) || 'Oferta')).trim(),
          loja:          d.loja || null,
          origem,
          origemNome:    (origem && origem.endsWith && origem.endsWith('@g.us')) ? (NOMES_GRUPOS.get(origem) || null) : null,
          capturadoEm:   o.timestamp || null,
          enviadoEm:     o.enviadoEm || null,
          gruposDestino: Array.isArray(o.gruposEnviados) ? o.gruposEnviados.length : null,
          // Previa da aba Fila tambem vale para o que ja saiu: mesma mensagem
          // e mesma flag de imagem dos itens aguardando.
          mensagem:      String(o.mensagemFormatada || '').slice(0, 4096),
          original:      originalDaFila(o),
          temImagem:     Array.isArray(o.imagens) && o.imagens.length > 0,
        };
      });

    const totalNaFila = itens.length
      + listas.reduce((s, l) => s + l.restantes, 0)
      + (campanha ? campanha.naFila : 0);

    res.json({
      ok:                true,
      agoraSP:           new Intl.DateTimeFormat('pt-BR', { timeZone: TZ_SP, dateStyle:'short', timeStyle:'short' }).format(new Date()),
      modo:              autoEnvioModo(),
      janela:            { ...janelaCupom(), ok: janela.ok, motivo: janela.motivo },
      intervaloSeg:      Math.round(intervaloMs / 1000),
      ultimoEnvioEm:     _ultimoAutoEnvio ? new Date(_ultimoAutoEnvio).toISOString() : null,
      proximoLiberadoEm: new Date(Math.max(agora, liberadoEm)).toISOString(),
      maxEsperaMin:      Math.round(AUTO_ENVIO_MAX_ESPERA / 60000),
      total:             itens.length,
      totalNaFila,
      itens,
      listas,
      enviados,
      campanha,
    });
  } catch (e) { res.status(500).json({ ok:false, erro:e.message }); }
});

app.post('/painel/aprovar/:id', async (req, res) => {
  const id     = parseInt(req.params.id);
  const oferta = filaPendentes.find(o => String(o.id)===String(id));
  if (!oferta) return res.status(404).json({ ok:false, erro:'Oferta nao encontrada.' });
  // Dono: agir em item de outro operador e proibido (defesa alem do filtro de listagem).
  if ((oferta.tenant || TENANT_PADRAO) !== req.tenantId) return res.status(404).json({ ok:false, erro:'Oferta nao encontrada.' });
  // Clique duplo ou aba desatualizada: item ja saindo ou ja enviado nao pode
  // ser aprovado de novo — duplicaria a mensagem nos grupos.
  if (oferta.status === 'enviando') return res.status(409).json({ ok:false, erro:'Este item ja esta sendo enviado agora.' });
  if (oferta.status === 'enviado')  return res.status(409).json({ ok:false, erro:'Este item ja foi enviado.' });
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
    // Agendamento por esta rota sempre aponta para cdv_emissao. Conteudo TSP
    // (cupom ou oferta de loja) nao pode passar por aqui — usar o agendamento
    // do painel TSP, que respeita os grupos de destino.
    if (ehConteudoTsp(oferta.tipoConteudo)) {
      return res.status(400).json({ ok:false, erro:'Item TSP não pode ser agendado por esta rota (iria para o grupo de emissões).' });
    }
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
    // Mesmo padrao do auto-envio: 'enviando' ANTES do await tira o card do
    // painel na hora (o envio com espacamento entre grupos pode levar minutos,
    // e com o item ainda 'pendente' ele continuava na tela apos aprovar).
    // Se o processo cair no meio, retomarEnviosInterrompidos() devolve para
    // aprovacao manual com o rastro de enviadosParciais.
    oferta.status = 'enviando';
    oferta.enviandoDesde = new Date().toISOString();
    salvarFila();
    try {
      await enviarCupomParaGrupos(mensagem, oferta.imagens?.[0], oferta);
      oferta.status = 'enviado'; oferta.mensagemFinal = mensagem;
      oferta.enviadoEm = new Date().toISOString();
      delete oferta.enviadosParciais; delete oferta.envioInterrompido; delete oferta.enviandoDesde;
      salvarFila();
      registrarEnvioHistorico(oferta);
      res.json({ ok:true });
    } catch(err) {
      oferta.status = 'pendente';
      delete oferta.enviandoDesde;
      salvarFila();
      res.status(500).json({ ok:false, erro: err.message });
    }
    return;
  }

  if (ehOfertaMarketplace(oferta.tipoConteudo)) {
    oferta.status = 'enviando';
    oferta.enviandoDesde = new Date().toISOString();
    salvarFila();
    try {
      const r = await enviarOfertaParaDestinos(mensagem, oferta.imagens?.[0], oferta);
      oferta.status = 'enviado'; oferta.mensagemFinal = mensagem;
      oferta.enviadoEm = new Date().toISOString();
      oferta.destinos = r.enviados; oferta.falhas = r.falhas;
      delete oferta.enviandoDesde;
      salvarFila();
      registrarEnvioHistorico(oferta);
      res.json({ ok:true, enviados:r.enviados.length, falhas:r.falhas });
    } catch(err) {
      oferta.status = 'pendente';
      delete oferta.enviandoDesde;
      salvarFila();
      res.status(500).json({ ok:false, erro: err.message });
    }
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
        auto:        !!oferta.autoEnviado,
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
  // origem: 'coleta' (padrao) | 'manual'. Marca DE ONDE veio o texto injetado.
  // Hoje o unico chamador de /injetar e a varredura seats.aero do Cowork, por
  // isso o padrao e 'coleta' — nenhuma mudanca e necessaria do lado da
  // automacao. Injecao feita a mao deve mandar origem:'manual' para nao ser
  // contabilizada como achado da varredura.
  const { texto, origem } = req.body;
  if (!texto?.trim()) return res.status(400).json({ ok:false, erro:'Texto vazio.' });
  // Cada injeção manual recebe seu PRÓPRIO grupo (id único) e é processada
  // isoladamente. Assim 1 injeção = 1 oferta: não há janela de 3 min
  // compartilhada (que quebrava as injeções em lotes conforme o tempo) nem
  // risco de o agrupamento por IA fundir rotas diferentes enviadas em sequência.
  // O prefixo do id carrega a procedencia ate passagens.json sem precisar de um
  // campo novo em cada ponto do pipeline: grupoOrigem ja e propagado.
  const prefixo = String(origem || '').toLowerCase() === 'manual'
    ? 'injecao_manual_' : PREFIXO_INJECAO_COLETA;
  const grupoFake = prefixo + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
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
  // categoria + trilhas: escolha de nicho feita no gerador manual. 'trilhas' e a
  // lista de ids da aba Grupos; 'categoria' vale para as regras de rodape.
  // dados: snapshot estruturado da emissao (origem/destino/programa/pontos...).
  // Enviado pela aba Emissao do gerador para (a) a fila de envio conseguir
  // exibir a rota na programacao e (b) o agendamento registrar a passagem no
  // disparo — antes, emissao agendada nunca entrava em passagens.json.
  const { grupo, mensagem, agendarEm, direto, preview, anexo, tipo, categoria, dados, trilhas: trilhasEnvio } = req.body;

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
                        dados: dados || null,
                        fonteRegistro: dados ? 'emissao' : null,
                        categoria: categoria || null,
                        trilhas: Array.isArray(trilhasEnvio) ? trilhasEnvio : null,
                        preview: preview?.link ? preview : null,
                        anexo: anexoGuardado,
                        criadoEm: new Date().toISOString() });
    salvarAgendamentos();
    const horario = new Intl.DateTimeFormat('pt-BR',{timeZone:TZ_SP,dateStyle:'short',timeStyle:'short'}).format(new Date(dispararEm));
    return res.json({ ok:true, agendado:true, id, horario });
  }

  if (multi) {
    try {
      const r = await enviarManualParaGrupos({ mensagem, tipo, preview, categoria, trilhasIds: trilhasEnvio });
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
    // Id unico por item: com o literal 'manual' duas emissoes na fila colidiam e
    // DELETE /fila-envio/manual removia sempre a primeira.
    // registrar:false — o gerador ja grava passagens.json no retorno deste POST.
    enfileirarEnvio('man-' + Date.now().toString(36), mensagemComprimida, grupoId,
                    dados || null, { fonte:'emissao', registrar:false });
    res.json({ ok:true, posicao:info.posicao, tempoMin:info.tempoMin, horario:info.horario });
  } else {
    try {
      const lp = preview?.link ? await montarLinkPreviewManual(preview, mensagem) : null;
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
        mensagem:   legenda || '',
        tipo:       tipoEnvio,
        imagem:     { imagemBase64: buf.toString('base64'), mime: mtMulti || 'image/jpeg' },
        categoria:  req.body?.categoria || null,
        trilhasIds: parseTrilhasForm(req.body?.trilhas),
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
    // Trilhas: cada uma com as proprias fontes e destinos. A aba Grupos edita
    // isto; `papeis` acima e so o retrato derivado, para quem ja lia de la.
    trilhas: trilhas(),
    destinosGerais: destinosGerais(),
    credenciaisOk: !!(process.env.AMZ_CLIENT_ID && process.env.AMZ_CLIENT_SECRET),
    credenciaisShopeeOk: credenciaisShopeeOk(),
    autoEnvioOferta: autoEnvioModoOferta(),
    matchDesejos: MODO_DESEJOS,
    autoEnvioCupom: autoEnvioModo(),
    janelaCupom: janelaCupom(),
    espacamentoGrupos: espacamentoGrupos(),
    turnosTsp: turnosTsp(),
    contaAgora: contaDoTurno(),
    // Quem le o que, para o painel do TSP nao continuar afirmando que a
    // principal "le e envia" e as demais "so enviam" — deixou de ser verdade
    // quando a leitura passou a ser escolhida por operacao.
    leitores: estadoLeitores(),
    envioCdv: contaEnvioCdv() || 'principal',
  });
});

app.post('/mkt/config', (req, res) => {
  try {
    const permitido = {};
    // `papeis` nao entra mais: e derivado das trilhas. Mandar os dois deixaria
    // a marcacao da tela e a do disco discordando.
    for (const k of ['ativo','descontoMinimo','dedupHoras','partnerTag','gatilhoPadrao']) {
      if (req.body[k] !== undefined) permitido[k] = req.body[k];
    }
    // Trilhas tem gravacao propria: valida nome, JID, categoria existente e o
    // conflito fonte/destino ANTES de gravar, porque trilha torta aqui vira
    // oferta no grupo errado.
    if (req.body.trilhas !== undefined) {
      const taxo = categoriasConfig().categorias || {};
      salvarTrilhas(req.body.trilhas || [], (cat) => Object.prototype.hasOwnProperty.call(taxo, cat));
      console.log('[MKT] Trilhas atualizadas — ' + trilhas().map(t => t.nome
        + ' (' + t.fontes.length + 'f/' + t.destinos.length + 'd)').join(', '));
    }
    const cfg = salvarRadarConfig(permitido);
    // Janela de cupons tem gravacao propria (valida os horarios antes de salvar).
    let janela = janelaCupom();
    if (req.body.janelaCupom !== undefined) {
      janela = salvarJanelaCupom(req.body.janelaCupom || {});
      console.log('[CUPONS] Janela de publicacao — ' + janela.inicio + '-' + janela.fim
        + ' (' + janela.dias + '), intervalo ' + janela.intervaloSeg + 's.');
    }
    // Espacamento entre grupos: gravacao propria porque a faixa precisa ser
    // validada (max < min viraria pausa zero sem ninguem perceber).
    let espac = espacamentoGrupos();
    if (req.body.espacamentoGrupos !== undefined) {
      espac = salvarEspacamentoGrupos(req.body.espacamentoGrupos || {});
      console.log('[MKT] Espacamento entre grupos — ' + espac.minSeg + 's a ' + espac.maxSeg + 's.');
    }
    let turnos = turnosTsp();
    if (req.body.turnosTsp !== undefined) {
      turnos = salvarTurnosTsp(req.body.turnosTsp || {});
      console.log('[TSP] Escala de numeros — ' + (turnos.ativo ? turnos.turnos.length + ' turno(s)' : 'desligada')
        + '. Agora: ' + contaDoTurno() + '.');
    }
    console.log('[MKT] Config atualizada — ' + radarFontes().length + ' fonte(s), ' + radarDestinos().length + ' destino(s).');
    res.json({ ok:true, papeis: radarConfig().papeis, fontes: radarFontes(), destinos: radarDestinos(),
               trilhas: trilhas(), destinosGerais: destinosGerais(),
               janelaCupom: janela, espacamentoGrupos: espac,
               turnosTsp: turnos, contaAgora: contaDoTurno() });
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
    // Modo EFETIVO (config do painel > env do Railway) + de onde ele veio. Sem
    // isto o painel nao tinha o que aplicar nos selects e eles ficavam sempre
    // na primeira opcao ('Desligado'), mesmo com auto-envio ligado na config.
    autoEnvio: autoEnvioEstado(req.tenantId),
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
    res.json({ ok: true, config: saida, autoEnvio: autoEnvioEstado(req.tenantId),
               credenciais: estadoCredenciais() });
  } catch (e) {
    res.status(400).json({ ok: false, erro: e.message });
  }
});

// Simulacao do rodape extra: para um tipo de mensagem e uma categoria, diz o
// que CADA grupo de destino receberia no fim da mensagem. Somente leitura — nao
// envia nada e nao grava nada. Existe para o operador conferir a regra antes de
// ela valer num disparo real, que e onde o erro custaria caro.
app.get('/config-tsp/rodape-preview', (req, res) => {
  try {
    const tipo      = String(req.query.tipo || 'oferta').toLowerCase();
    const categoria = String(req.query.categoria || '').trim();
    const destinos = radarDestinos().map(jid => ({
      jid,
      nome: NOMES_GRUPOS.get(jid) || jid,
      rodape: rodapeExtraParaGrupo({
        jid, tipo,
        categoria: categoria || null,
        categoriaConfiavel: !!categoria,
      }),
    }));
    res.json({ ok: true, tipo, categoria, destinos });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// ── REGISTRO DE OPERADORES ───────────────────────────────────────────────────
// Leitura publica MASCARADA: sem e-mails (endpoints do painel sao abertos; a
// gestao completa do registro entra junto do login por operador, na fase 2.5).
// ── CONFIG DO CDV ────────────────────────────────────────────────────────────
// Espelho de /config-tsp para o gerador. GET devolve a config inteira mais o
// que a tela precisa para montar os seletores: nomes dos grupos conhecidos e
// contas conectadas (para escolher quem dispara).
// Quem le o que, agora. Inclui o efetivo (contaLeitoraDe devolve a principal
// quando a configurada esta fora do ar), porque a diferenca entre configurado
// e efetivo e justamente o que explica "troquei a conta e nada mudou".
function estadoLeitores() {
  const montar = (apelidoCfg, rotulo) => {
    const id = _idDaConta(apelidoCfg);
    const vivo = _leitorVivo(id);
    return {
      operacao: rotulo,
      configurada: apelidoCfg || 'principal',
      efetiva: (id === 'principal' || vivo) ? apelidoDaConta(id) : 'principal',
      conectada: vivo,
      ultimoInboundEm: _pulsoLeitores.get(id) ? new Date(_pulsoLeitores.get(id)).toISOString() : null,
    };
  };
  return [montar(contaLeitoraCdv(), 'cdv'), montar(contaLeitoraTsp(), 'tsp')];
}

app.get('/config-cdv', (req, res) => {
  if (!NOMES_GRUPOS.size) atualizarNomesGrupos().catch(() => {});
  const cfg = configCdv();
  const contas = [...contasExtras.values()]
    .filter(c => tenantDaConta(c.id) === TENANT_PADRAO)
    .map(c => ({ id: apelidoDaConta(c.id), conectado: c.conectado }));
  res.json({
    ok: true,
    config: cfg,
    papeis: PAPEIS_CDV,
    // Nome atual de cada grupo monitorado, direto do WhatsApp: o cadastro
    // guarda o nome do dia em que foi salvo, e grupo renomeado ficaria com um
    // rotulo velho na tela para sempre.
    nomes: Object.fromEntries(NOMES_GRUPOS),
    contas,
    // A conta principal entra na MESMA lista da tela: para quem opera, ela e
    // so mais um numero com papeis. A diferenca (ser o socket que sustenta
    // resolucao de JID, bot, campanha e autocura) e interna e nao deveria
    // aparecer como hierarquia no seletor.
    principal: { id:'principal', conectado, conectando: isConnecting, qrDisponivel: !!qrAtual },
    contaEmUso: contaEnvioCdv() || 'principal',
    // As duas leituras vao juntas, mas so como INFORMACAO: a tela do CDV usa
    // para etiquetar os numeros ("lê fontes do Tica") e nao deixar um numero
    // ocupado parecer livre. Quem ESCOLHE a leitora do TSP e o painel do TSP —
    // cada operacao manda na propria leitura.
    leitores: estadoLeitores(),
  });
});

app.post('/config-cdv', (req, res) => {
  try {
    // Este endpoint grava SO a config do CDV. A leitora do TSP mora no
    // config_tsp e e escolhida na aba Conexao do painel do TSP: uma tela que
    // muda a operacao vizinha e um lugar a mais para quebrar o Tica sem querer.
    const novo = salvarConfigCdv(req.body || {});
    const ativos = novo.monitorados.filter(m => m.ativo).length;
    console.log('[CFG-CDV] Leitura — cdv=' + (novo.leitura.conta || 'principal')
      + ' tsp=' + (contaLeitoraTsp() || 'principal') + '.');
    console.log('[CFG-CDV] Config gravada pelo painel — ofertas=' + novo.grupos.ofertas
      + ' emissao=' + novo.grupos.emissao + ' monitorados=' + ativos + '/' + novo.monitorados.length
      + ' admins=' + novo.admins.length + ' conta=' + (novo.envio.conta || 'principal') + '.');
    res.json({ ok: true, config: novo });
  } catch (e) {
    res.status(400).json({ ok: false, erro: e.message });
  }
});

// A conta escolhida para disparar o CDV esta nos grupos que precisa?
//
// Estar PAREADA nao basta: um numero fora do grupo de destino falha o envio na
// hora — e como o fallback manda pela principal, a mensagem sai pelo numero
// errado e ninguem percebe. Melhor descobrir aqui.
//
// Separa deliberadamente as duas listas, porque as exigencias sao diferentes:
//   destinos    — a conta de disparo PRECISA estar neles (ofertas, emissao e,
//                 se cadastrado, o grupo de avisos).
//   monitorados — quem LE e sempre a conta principal. Faltar aqui nao afeta o
//                 disparo; so importa para responder "posso promover esta conta
//                 a principal sem cegar o radar de milhas?".
app.get('/config-cdv/conta/:id/grupos', async (req, res) => {
  const apelido = String(req.params.id || '').trim();
  const ehPrincipal = !apelido || apelido === 'principal';

  let daConta;
  try {
    if (ehPrincipal) {
      if (!conectado || !sock) return res.status(503).json({ ok:false, erro:'conta principal nao conectada' });
      daConta = Object.keys(await sock.groupFetchAllParticipating());
    } else {
      const id = contaIdDe(TENANT_PADRAO, apelido);
      const ct = contasExtras.get(id);
      if (!ct?.conectado || !ct.sock) {
        return res.status(503).json({ ok:false, erro:'conta "' + apelido + '" nao esta conectada — pareie o QR antes de conferir' });
      }
      daConta = Object.keys(await ct.sock.groupFetchAllParticipating());
    }
  } catch (e) { return res.status(500).json({ ok:false, erro:e.message }); }

  const noGrupo = new Set(daConta);
  const ausentes = (lista) => [...new Set(lista.filter(Boolean))]
    .filter(j => !noGrupo.has(j))
    .map(j => ({ jid:j, nome: NOMES_GRUPOS.get(j) || null }));

  const destinos = [grupoOfertasCdv(), grupoEmissaoCdv(), grupoAvisosCdv()].filter(Boolean);
  const monitorados = gruposMonitoradosCdv();
  res.json({
    ok: true,
    conta: ehPrincipal ? 'principal' : apelido,
    total: daConta.length,
    destinos:    { conferidos: destinos.length,    faltando: ausentes(destinos) },
    monitorados: { conferidos: monitorados.length, faltando: ausentes(monitorados) },
  });
});

// Papeis de um e-mail. O gerador ainda NAO tem login, entao isto responde
// "o que esta cadastrado para este e-mail", nao "quem e voce" — organiza a
// operacao, nao autentica. Vira cadeado de verdade quando o gerador ganhar o
// OTP que o painel-cdv ja tem.
app.get('/config-cdv/permissoes', (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  res.json({ ok: true, email, papeis: papeisDoEmailCdv(email), autenticado: false });
});

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
    carregarCategorias(); carregarMonitorPrecos();
    recarregarRadarTenants();
    res.json({ ok:true, ...r });
  } catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
});

// ── CATEGORIAS / GRUPOS DE NICHO ─────────────────────────────────────────────
// Estado da taxonomia e do modo observacao.
app.get('/tsp/categorias', (req, res) => {
  const cfg = categoriasConfig();
  // Taxonomia inteira: a aba Configuracoes edita keyword a keyword, entao a
  // versao resumida nao serve. Nao ha segredo aqui — sao termos de negocio.
  res.json({
    ok: true,
    versao: cfg.versao || 0,
    atualizadoEm: cfg.atualizadoEm || null,
    limiarConfianca: cfg.limiarConfianca ?? 0.7,
    espelhoOperador: cfg.espelhoOperador || [],
    categorias: cfg.categorias || {},
  });
});

// Grava a taxonomia editada no painel. Substitui o conjunto inteiro: a tela
// manda sempre o estado completo, entao merge parcial so criaria divergencia
// entre o que o operador ve e o que o classificador usa.
app.post('/tsp/categorias', (req, res) => {
  const { categorias, limiarConfianca, espelhoOperador } = req.body || {};
  if (!categorias || typeof categorias !== 'object' || Array.isArray(categorias)) {
    return res.status(400).json({ ok:false, erro:'"categorias" deve ser um objeto id -> definicao.' });
  }

  const RE_ID = /^[a-z][a-z0-9_]{1,30}$/;
  const limpo = {};
  for (const [id, def] of Object.entries(categorias)) {
    if (!RE_ID.test(id)) {
      return res.status(400).json({ ok:false, erro:'Identificador invalido: "' + id
        + '". Use minusculas, numeros e _ (ex: bebidas, pet_shop).' });
    }
    if (!def || typeof def !== 'object') return res.status(400).json({ ok:false, erro:'Definicao invalida em "' + id + '".' });
    const lista = (v) => [...new Set((Array.isArray(v) ? v : [])
      .map(x => String(x || '').trim()).filter(Boolean))];
    const nome = String(def.nome || '').trim();
    if (!nome) return res.status(400).json({ ok:false, erro:'A categoria "' + id + '" precisa de um nome.' });
    // Prioridade resolve sobreposicao legitima entre prateleiras (sandalia
    // infantil e moda E infantil); marcas sao sinal mais forte que keyword.
    // Ausentes no corpo, os dois preservam o valor atual em vez de zerar: o
    // painel antigo nao manda estes campos e nao pode apagar a taxonomia.
    const atual = categoriasConfig().categorias?.[id] || {};
    limpo[id] = {
      nome,
      emoji:             String(def.emoji || '').trim(),
      prioridade:        Number.isFinite(Number(def.prioridade)) ? Number(def.prioridade)
                                                                 : (Number(atual.prioridade) || 0),
      segmentosAmazon:   lista(def.segmentosAmazon),
      segmentosBloqueio: lista(def.segmentosBloqueio),
      marcas:            def.marcas !== undefined ? lista(def.marcas) : lista(atual.marcas),
      keywords:          lista(def.keywords),
      bloqueio:          lista(def.bloqueio),
    };
  }

  let limiar = Number(limiarConfianca);
  if (!Number.isFinite(limiar) || limiar <= 0 || limiar > 1) limiar = categoriasConfig().limiarConfianca ?? 0.7;

  const espelho = (Array.isArray(espelhoOperador) ? espelhoOperador : []).filter(x => limpo[x]);

  const cfg = salvarCategorias({
    categorias: limpo,
    limiarConfianca: limiar,
    espelhoOperador: espelho,
    versao: (categoriasConfig().versao || 0) + 1,
  });
  console.log('[CAT] Taxonomia salva pelo painel — ' + Object.keys(limpo).length
    + ' categoria(s), espelho: ' + (espelho.join(', ') || 'nenhum'));
  res.json({ ok:true, versao: cfg.versao, categorias: cfg.categorias,
             limiarConfianca: cfg.limiarConfianca, espelhoOperador: cfg.espelhoOperador });
});

// Classifica sem enviar nada. Serve para conferir a taxonomia contra titulos
// reais antes de confiar nela para rotear grupo.
app.post('/tsp/categorizar', (req, res) => {
  const { titulo, titulos, asin, loja } = req.body || {};
  const lista = Array.isArray(titulos) ? titulos : (titulo ? [titulo] : []);
  if (!lista.length) return res.status(400).json({ ok:false, erro:'Informe "titulo" ou "titulos".' });
  const itens = lista.slice(0, 300).map(t => {
    const alvo = typeof t === 'string' ? { titulo: t, asin, loja } : t;
    const cls = classificarProduto(alvo);
    return { titulo: alvo.titulo, categoria: cls.categoria, nome: cls.nome,
             confianca: cls.confianca, sinal: cls.sinal, confiavel: categoriaConfiavel(cls) };
  });
  res.json({ ok:true, total: itens.length, itens });
});

// Liga/desliga o espelho no grupo do operador sem deploy.
// Diagnostico da trilha do Mercado Livre: abre o anuncio com o cookie de
// afiliado, mostra o breadcrumb lido e o que o classificador decide com ele.
// Existe porque o seletor de breadcrumb e HTML de terceiro — a unica forma
// honesta de saber se ainda funciona e perguntar a producao, nao supor.
app.get('/tsp/trilha-ml', async (req, res) => {
  const url = String(req.query.url || '').trim();
  if (!url) return res.status(400).json({ ok:false, erro:'Informe ?url= do anuncio.' });
  try {
    const d = await buscarDadosProdutoMl(url);
    const id = String(req.query.id || '').trim() || null;
    if (d.trilha?.caminho && id) semearCacheTrilhas({ [id]: d.trilha });
    const cls = classificarProduto({ titulo: d.titulo, asin: id, loja: 'Mercado Livre' });
    res.json({
      ok: true,
      titulo: d.titulo,
      trilha: d.trilha,
      classificacao: { ...cls, confiavel: categoriaConfiavel(cls), explicacao: explicarClassificacao(cls) },
    });
  } catch (e) {
    res.status(500).json({ ok:false, erro: e.message });
  }
});

app.post('/tsp/categorias/espelho', (req, res) => {
  const { categorias } = req.body || {};
  if (!Array.isArray(categorias)) return res.status(400).json({ ok:false, erro:'"categorias" deve ser um array.' });
  const validas = Object.keys(categoriasConfig().categorias || {});
  const desconhecidas = categorias.filter(x => !validas.includes(x));
  if (desconhecidas.length) return res.status(400).json({ ok:false, erro:'Categoria desconhecida: ' + desconhecidas.join(', ') });
  salvarCategorias({ espelhoOperador: categorias });
  res.json({ ok:true, espelhoOperador: categorias });
});

// Retrato imediato: reclassifica o que ja passou pela fila e manda o resumo no
// grupo do operador. Existe para nao ter que esperar novas capturas para ver o
// classificador trabalhando sobre o material real da operacao.
app.post('/tsp/categorias/simular', async (req, res) => {
  const alvo  = String(req.body?.categoria || '').trim();
  const envia = req.body?.enviar !== false;
  if (!alvo) return res.status(400).json({ ok:false, erro:'Informe "categoria".' });
  if (!categoriasConfig().categorias?.[alvo]) return res.status(400).json({ ok:false, erro:'Categoria desconhecida: ' + alvo });

  const vistos = new Set();
  const casados = [], indefinidos = [];
  for (const o of filaPendentes) {
    const d = o.dadosExtraidos || {};
    if (!d.titulo || vistos.has(d.titulo)) continue;
    vistos.add(d.titulo);
    const cls = classificarProduto({ titulo: d.titulo, asin: d.asin, loja: d.loja });
    if (cls.categoria === alvo) casados.push({ titulo: d.titulo, loja: d.loja, preco: d.precoFinal ?? d.preco, sinal: cls.sinal, confiavel: categoriaConfiavel(cls) });
    else if (!cls.categoria && cls.confianca > 0) indefinidos.push({ titulo: d.titulo, sinal: cls.sinal });
  }

  if (envia && GRUPOS['operador']) {
    const nome = categoriasConfig().categorias[alvo].nome || alvo;
    const linhas = casados.length
      ? casados.slice(0, 30).map(x => '\u2022 ' + String(x.titulo).slice(0, 70)
          + (x.preco != null ? ' \u2014 R$ ' + Number(x.preco).toFixed(2).replace('.', ',') : '')
          + '\n  `' + x.sinal + (x.confiavel ? '' : ' \u00b7 abaixo do limiar') + '`').join('\n')
      : '_nenhuma oferta da fila atual caiu nesta categoria._';
    const rodape = indefinidos.length
      ? '\n\n\u26a0\ufe0f *' + indefinidos.length + ' item(ns) barrado(s) por bloqueio* (acessorio, nao o produto):\n'
        + indefinidos.slice(0, 8).map(x => '\u2022 ' + String(x.titulo).slice(0, 60) + '\n  `' + x.sinal + '`').join('\n')
      : '';
    const texto = '\u{1F9EA} *SIMULACAO DE CATEGORIA \u2014 ' + String(nome).toUpperCase() + '*\n'
      + '`' + vistos.size + ' titulo(s) analisado(s) da fila \u00b7 ' + casados.length + ' casado(s)`\n\n'
      + linhas + rodape;
    try { await enviarMensagem(GRUPOS['operador'], { text: texto }); }
    catch (e) { return res.status(500).json({ ok:false, erro:'Classificou mas nao enviou: ' + e.message, analisados: vistos.size, casados }); }
  }

  res.json({ ok:true, categoria: alvo, analisados: vistos.size, casados, indefinidos });
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
      // Link curto (tidd.ly) via Link Builder; o aw_deep_link do feed (longo)
      // fica de plano B se a quota estourar ou o anunciante nao liberar.
      // Identidade por PRODUTO (antes era 'AWIN-{id}-feed', uma chave coletiva
      // por anunciante): sem isso o ledger nao distingue os itens do feed.
      const asinFeed = chaveVitrineAwin(c.advertiserId, c.urlLoja || c.linkAfiliado || '');
      const refFeed = refDeterministico(asinFeed);
      let linkEnvio = c.linkAfiliado;
      try {
        const l = await gerarLinkAwin({ url: c.urlLoja, advertiserId: c.advertiserId, clickref: refFeed });
        linkEnvio = l.shortUrl || l.url || linkEnvio;
      } catch {}
      const p = {
        asin: asinFeed,
        codigo: c.urlLoja || '',
        titulo: c.titulo || '',
        preco: c.preco,
        precoDe: c.precoDe,
        precoTexto: 'R$ ' + c.preco.toFixed(2).replace('.', ','),
        precoDeTexto: c.precoDe ? 'R$ ' + c.precoDe.toFixed(2).replace('.', ',') : null,
        desconto: c.desconto,
        disponivel: true,
        link: linkEnvio,
        imagemUrl: c.imagem || null,
        vendedor: null, marca: c.marca || '', nota: null, avaliacoes: null,
        dealTermina: null, ehDeal: false,
        loja: c.loja.replace(/\s*\(?(BR(\s*&\s*LATAM)?|LATAM|Global)\)?\s*$/i, '').trim(),
        precoDeReferencia: true,   // preco de feed, nao lido do site agora
      };

      // Cupom vigente da propria loja, se algum se aplicar a este preco. E o
      // ganho de juntar as duas pontas: os cupons da Awin ja estao na base.
      const mc = melhorCupomAplicavel(p.loja, p.preco);
      const cupom = mc ? { reg: mc.reg, desconto: mc.desconto, citado: true } : null;
      // Simulacao nao pode sujar o ledger de rastreio com produtos nao enviados.
      const mensagem = formatarOfertaAwin(p, { cupom, rastrear: !simular });

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
          registrarEnvioHistorico(oferta);
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
app.post('/awin/ofertas/cadastrar', async (req, res) => {
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
      // Link curto (tidd.ly) primeiro; aw_deep_link/deeplink manual de plano B.
      let linkVitrine = c.linkAfiliado || deeplinkAwin(c.advertiserId, c.urlLoja);
      try {
        const l = await gerarLinkAwin({ url: c.urlLoja, advertiserId: c.advertiserId, clickref: 'vitrine' });
        linkVitrine = l.shortUrl || l.url || linkVitrine;
      } catch {}
      salvos.push({ ...salvarItemVitrine({
        asin, loja: c.loja,
        nome: (c.titulo || (c.loja + ' — produto')).slice(0, 140),
        // 'url' e o link de afiliado que vai na mensagem; 'urlProduto' e a
        // pagina da loja, que permite reconsultar o preco no disparo.
        url: linkVitrine,
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
  try { escreverAtomico(AWIN_VISTOS_PATH, JSON.stringify(_awinVistos)); }
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
    autoEnvio: autoEnvioModo(),
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
  // O historico durvel e o unico ponto por onde toda oferta enviada deve
  // passar: alem da contagem, e la que rodam registrarVisto (dedup) e
  // vigiarProdutoDivulgado. Sem isto, produto disparado por lista continuava
  // elegivel no radar e saia duas vezes no mesmo dia.
  oferta.status         = 'enviado';
  oferta.enviadoEm      = new Date().toISOString();
  oferta.gruposEnviados = r.enviados;
  oferta.falhas         = r.falhas;
  registrarEnvioHistorico(oferta);
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
      // Bloqueio do antibot e da infra, nao do item: adia 10 min em vez de
      // consumir a fila (25/08: uma lista inteira virou "pulado" em sequencia).
      // Depois de 3 tentativas (30 min) desiste deste item e segue: o bloqueio
      // dura horas, e um item sem cobertura da API (anuncio de terceiro, /up/)
      // travando a lista por 1h custava mais que pula-lo.
      if (!r.ok && /antibot/i.test(r.motivo || '') && (ex.bloqueios || 0) < 3) {
        ex.bloqueios = (ex.bloqueios || 0) + 1;
        ex.proximoEm = Date.now() + 10 * 60000;
        atualizarExecucaoLista(lista.id, ex);
        console.warn('[LISTA] "' + lista.nome + '" — item ' + (ex.indice + 1) + '/' + lista.produtos.length
          + ' adiado 10 min (' + ex.bloqueios + '/3): ' + r.motivo);
        avisarAntibotMl(r.motivo).catch(() => {});
        return;
      }
      ex.bloqueios = 0;
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

// ── COBERTURA DE PRECO ANTES DE DISPARAR ────────────────────────────────────
// Item do ML sem catalogo nao tem preco enquanto a leitura de pagina estiver
// desligada: ele entra na fila, espera a vez e vira "pulado" 20 min depois. Aqui
// o operador descobre ANTES de confirmar, quando ainda da para trocar o produto.
// So o ML precisa do teste — Amazon e Shopee leem preco por outra via.
const COBERTURA_MAX_ITENS = 40;   // teto: 1 requisicao por item, na hora do clique

async function itensSemCoberturaMl(produtos) {
  const fora = [];
  for (const asin of (produtos || []).slice(0, COBERTURA_MAX_ITENS)) {
    const it = itemVitrine(asin);
    if (!it || String(it.loja || '') !== 'Mercado Livre') continue;
    try {
      const r = await coberturaApiMl(asin, it.url);
      if (!r.coberto) fora.push({ asin, nome: it.nome || asin, motivo: r.motivo });
    } catch (e) { /* soluco de infra nao acusa o item */ }
  }
  return fora;
}

// Chamado pelo painel antes do confirm() do disparo. Nao altera nada.
app.post('/listas/checar-cobertura', async (req, res) => {
  const produtos = Array.isArray(req.body?.produtos) ? req.body.produtos.filter(Boolean) : [];
  if (!produtos.length) return res.json({ ok:true, semCobertura: [] });
  try { res.json({ ok:true, conferidos: Math.min(produtos.length, COBERTURA_MAX_ITENS),
                   semCobertura: await itensSemCoberturaMl(produtos) }); }
  catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
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
  // Aviso, nao bloqueio: quem dispara decide se troca o produto ou toca assim.
  let semCobertura = [];
  try { semCobertura = await itensSemCoberturaMl(lista.produtos); } catch (e) {}
  if (semCobertura.length) console.warn('[LISTA] "' + lista.nome + '" — ' + semCobertura.length
    + ' item(ns) do ML sem cobertura de preco; serao pulados: '
    + semCobertura.map(x => x.asin).join(', '));
  const minutos  = (lista.produtos.length - 1) * lista.intervaloMin;
  const inicioTs = aguardando ? inicio : Date.now();
  const prev     = previsaoTerminoLista(lista, inicioTs, lista.produtos.length);
  console.log('[LISTA] "' + lista.nome + '" ' + (aguardando ? 'agendada para ' + relogioSP(inicio) + ' SP' : 'iniciada manualmente')
    + ' — ' + lista.produtos.length + ' produto(s), ' + lista.intervaloMin + ' min de intervalo, termina '
    + dataHoraSP(prev.terminaEm) + ' SP' + (prev.cabeNoDia ? '' : ' (fila vira o dia)') + '.');
  res.json({ ok:true, lista: atualizada, produtos: lista.produtos.length, duracaoMin: minutos,
             semCobertura,
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
    let semCobertura = [];
    try { semCobertura = await itensSemCoberturaMl(produtos); } catch (e) {}
    if (semCobertura.length) console.warn('[LISTA] Envio unico — ' + semCobertura.length
      + ' item(ns) do ML sem cobertura de preco; serao pulados: '
      + semCobertura.map(x => x.asin).join(', '));
    res.json({ ok:true, lista: atualizada, produtos: produtos.length,
               duracaoMin: (produtos.length - 1) * lista.intervaloMin,
               semCobertura,
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

// ── NICHO CURADO ─────────────────────────────────────────────────────────────
// A lista de nichos validos e a propria taxonomia do classificador, nao uma
// segunda lista mantida a mao: duas listas divergem no primeiro nicho novo, e o
// produto curado para um nicho que o roteamento nao conhece nao chega a grupo
// nenhum. 'geral' entra porque e um destino legitimo de curadoria ("este
// produto e bom, mas nao e de nicho").
function nichosDisponiveis() {
  return ['geral', ...Object.keys(categoriasConfig().categorias || {})];
}

function nichoValido(id) {
  return nichosDisponiveis().includes(String(id || '').trim());
}

app.get('/vitrine/nichos', (_req, res) => {
  const taxo = categoriasConfig().categorias || {};
  res.json({ ok:true, nichos: nichosDisponiveis().map(id => ({
    id,
    nome: id === 'geral' ? 'Geral (sem nicho)' : (taxo[id]?.nome || id),
    emoji: id === 'geral' ? '📦' : (taxo[id]?.emoji || ''),
  })) });
});

// Marcacao em MASSA de itens ja cadastrados. Existe porque a vitrine ja tem 221
// produtos de antes desta camada — sem isto, so produto novo poderia ser
// curado, e os que ja estao la ficariam para sempre a merce do classificador.
// { asins:[...], nicho:'ferramentas' } — nicho '' limpa a curadoria.
app.post('/vitrine/nicho', (req, res) => {
  const asins = Array.isArray(req.body?.asins) ? req.body.asins.map(a => String(a || '').trim()).filter(Boolean) : [];
  if (!asins.length) return res.status(400).json({ ok:false, erro:'informe { asins:[...] }' });
  const nicho = String(req.body?.nicho || '').trim();
  if (nicho && !nichoValido(nicho)) {
    return res.status(400).json({ ok:false,
      erro:'nicho "' + nicho + '" nao existe na taxonomia — use um dos: ' + nichosDisponiveis().join(', ') });
  }
  const atualizados = [], faltando = [];
  for (const asin of asins) {
    if (!itemVitrine(asin)) { faltando.push(asin); continue; }
    // String vazia LIMPA (salvarItemVitrine trata '' como null); undefined preservaria.
    atualizados.push(salvarItemVitrine({ asin, nicho }));
  }
  console.log('[VITRINE] Nicho "' + (nicho || '(limpo)') + '" aplicado a ' + atualizados.length + ' item(ns).');
  res.json({ ok:true, nicho: nicho || null, atualizados: atualizados.length, faltando });
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

// ── POOL DE IDS DE RASTREAMENTO (AMAZON) ────────────────────────────────────
// A Amazon nao reporta clique por link, so por ID de rastreamento, e a conta
// tem teto de IDs. Estes IDs sao criados A MAO no painel Associados — nao ha
// API para isso — e cadastrados aqui para o disparo poder rodizia-los.

app.get('/rastreio/pool', (_req, res) => {
  res.json({ ok:true, ...listarPoolRastreio() });
});

// Aceita { tags:[...] } ou { prefixo, de, ate, digitos } para gerar a serie.
// A geracao existe so por conveniencia de digitacao: o que vale e o ID existir
// de verdade na conta Associados. ID inexistente = link sem afiliado valido =
// comissao perdida, entao o formato e recusado, nunca corrigido.
app.post('/rastreio/pool', (req, res) => {
  let tags = Array.isArray(req.body?.tags) ? req.body.tags : null;
  if (!tags && req.body?.prefixo) {
    const de = Number(req.body.de || 1);
    const ate = Number(req.body.ate || de);
    const dig = Number(req.body.digitos || 3);
    if (!(ate >= de) || (ate - de) > 500) {
      return res.status(400).json({ ok:false, erro:'intervalo invalido' });
    }
    tags = [];
    for (let i = de; i <= ate; i++) {
      tags.push(String(req.body.prefixo) + String(i).padStart(dig, '0') + '-20');
    }
  }
  if (!tags) return res.status(400).json({ ok:false, erro:'informe { tags } ou { prefixo, de, ate }' });
  const r = salvarPoolRastreio(tags);
  res.json({ ok:true, total:r.pool.length, pool:r.pool, recusados:r.recusados });
});

// Pool de tags do Mercado Livre. Diferente da Amazon, a tag NAO gira por dia:
// ela e grudada no produto na primeira geracao de link e fica, porque o
// relatorio do ML nao separa resultado por data de disparo.
//
// A tag precisa existir na conta de afiliado — criada a mao no painel do ML.
// Tag inventada faz o createLink devolver error_code 109 e o link e refeito
// com a tag da conta (perde segmentacao, nunca a comissao).
//
// Pool vazio = comportamento anterior. Enquanto ninguem POSTar tags aqui,
// nada muda no disparo.
app.get('/rastreio/pool-ml', (_req, res) => {
  res.json({ ok:true, ...listarPoolMl() });
});

// Recebe { porCategoria: { bebidas:'bebidas', '':'geral', ... } }. A chave vazia
// e o balde de quem nao tem categoria confiavel — sem ela, produto nao
// classificado sai com a tag da conta e some da medicao por nicho.
app.post('/rastreio/pool-ml', (req, res) => {
  const entrada = req.body?.porCategoria ?? req.body?.tags;
  if (!entrada) return res.status(400).json({ ok:false, erro:'informe { porCategoria: {...} }' });
  const r = salvarPoolMl(entrada);
  res.json({ ok:true, porCategoria:r.porCategoria, recusados:r.recusados,
             categorias: Object.keys(r.porCategoria).length });
});

// Etiquetas sugeridas: cruza a taxonomia carregada com o mapa ja gravado, para
// o painel montar a tela sem inventar categoria que o classificador nao conhece.
app.get('/rastreio/pool-ml/sugestao', (_req, res) => {
  const cfg = categoriasConfig();
  const atual = listarPoolMl().porCategoria || {};
  const linhas = Object.entries(cfg.categorias || {}).map(([id, c]) => ({
    categoria: id, nome: c.nome || id, emoji: c.emoji || '', etiqueta: atual[id] || '',
  }));
  linhas.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  // O balde geral fica por ultimo: e o destino de quem nao casou em nenhuma.
  linhas.push({ categoria: '', nome: 'Sem categoria confiável (geral)', emoji: '📦',
                etiqueta: atual[''] || '' });
  res.json({ ok:true, linhas });
});

// Ledger ref -> produto. O coletor de comissoes le este mesmo conteudo pelo
// arquivo sincronizado; aqui serve para conferencia rapida no painel.
app.get('/rastreio/atribuicoes', (req, res) => {
  const desde = String(req.query?.desde || '') || null;
  const lista = listarAtribuicoes(desde);
  res.json({ ok:true, total:lista.length, atribuicoes:lista.slice(-500) });
});

// ── BACKFILL: asin de URL curta -> MLB/MLBU ─────────────────────────────────
// Repara o estrago de radar-ml.js:879, que gravava o meli.la no campo asin
// quando idDeUrl() nao casava o id (todo produto de catalogo unificado, MLBU).
// Em agosto foram 68 de 297 registros ML, 23%.
//
// Por que endpoint e nao commit direto no repo de dados: o shard vive em TRES
// lugares — _histEnvioCache (memoria), ./sessao no volume do Railway e o
// GitHub. _registrosDoShard le a memoria primeiro e o disco depois, e so cai no
// GitHub se nao achar nenhum dos dois. Editar o repo por fora seria sobrescrito
// no proximo envio, sem erro nenhum e sem aviso.
//
// Idempotente: so toca em asin que comeca com http. Rodar duas vezes nao muda
// nada na segunda.
//
// GET  /manutencao/asin-ml            previa, sem escrever
// POST /manutencao/asin-ml            aplica  (body: { meses:['2026-08'] })
const _MESES_BACKFILL_MAX = 6;

function _mesesDeBackfill(pedidos) {
  if (Array.isArray(pedidos) && pedidos.length) {
    return pedidos.map(m => String(m).slice(0, 7)).filter(m => /^\d{4}-\d{2}$/.test(m))
                  .slice(0, _MESES_BACKFILL_MAX);
  }
  const out = [];
  const hoje = new Date();
  for (let i = 0; i < _MESES_BACKFILL_MAX; i++) {
    out.push(new Intl.DateTimeFormat('en-CA', { timeZone: TZ_SP, year: 'numeric', month: '2-digit' })
      .format(new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() - i, 15))));
  }
  return out;
}

async function _levantarBackfillAsinMl(meses) {
  const achados = [];      // { mes, local, reg }
  const urls = new Set();
  for (const mes of meses) {
    const local = 'historico_envios_' + mes + '.json';
    let regs;
    try { regs = await _registrosDoShard(local); } catch (e) { continue; }
    for (const r of (regs || [])) {
      if (r.tipoConteudo !== 'oferta_ml') continue;
      const a = String(r.asin || '');
      if (!a.startsWith('http')) continue;
      achados.push({ mes, local, reg: r });
      urls.add(a);
    }
  }
  for (const u of urlsNoAsinDeAtribuicoes()) urls.add(u);
  return { achados, urls: [...urls] };
}

/**
 * meli.la -> MLB/MLBU. Sequencial e com pausa: sao redirects na infra do ML e
 * uma rajada de dezenas em paralelo e o padrao que rende bloqueio de IP.
 */
async function _resolverUrlsMl(urls, { pausaMs = 700 } = {}) {
  const mapa = {}, falhas = {};
  for (const u of urls) {
    try {
      const alvo = await resolverLinkMl(u);
      const id = idProdutoMl(alvo);
      if (id) mapa[u] = id;
      else falhas[u] = 'sem id de produto apos resolver: ' + String(alvo).slice(0, 90);
    } catch (e) { falhas[u] = e.message; }
    await new Promise(r => setTimeout(r, pausaMs));
  }
  return { mapa, falhas };
}

app.get('/manutencao/asin-ml', async (req, res) => {
  try {
    const meses = _mesesDeBackfill(String(req.query?.meses || '').split(',').filter(Boolean));
    const { achados, urls } = await _levantarBackfillAsinMl(meses);
    const porMes = {};
    for (const a of achados) porMes[a.mes] = (porMes[a.mes] || 0) + 1;
    res.json({ ok:true, simulacao:true, meses, registrosAfetados:achados.length, porMes,
               urlsUnicas:urls.length,
               amostra: achados.slice(0, 10).map(a => ({ mes:a.mes, id:a.reg.id,
                 asin:a.reg.asin, titulo:String(a.reg.titulo || '').slice(0, 60) })) });
  } catch (e) { res.status(500).json({ ok:false, erro:e.message }); }
});

app.post('/manutencao/asin-ml', async (req, res) => {
  try {
    const meses = _mesesDeBackfill(req.body?.meses);
    const { achados, urls } = await _levantarBackfillAsinMl(meses);
    if (!achados.length && !urls.length) {
      return res.json({ ok:true, nada:true, meses, mensagem:'nenhum asin de URL encontrado' });
    }

    console.log('[BACKFILL-ASIN] Resolvendo ' + urls.length + ' URL(s) curta(s)...');
    const { mapa, falhas } = await _resolverUrlsMl(urls);

    // ── Historico de envios ──
    const shardsTocados = new Set();
    let reparados = 0, semMapa = 0;
    for (const { local, reg } of achados) {
      const novo = mapa[String(reg.asin)];
      if (!novo) { semMapa++; continue; }
      reg.asinAntigo = reg.asin;   // rastro do reparo, para auditoria
      reg.asin = novo;
      shardsTocados.add(local);
      reparados++;
    }
    for (const local of shardsTocados) {
      const regs = _histEnvioCache.get(local);
      if (!regs) continue;
      const caminho = SESSAO_DIR + '/' + local;
      const dir = caminho.slice(0, caminho.lastIndexOf('/'));
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      escreverAtomico(caminho, JSON.stringify({ registros: regs }), 'utf-8');
      agendarPush(local);
    }

    // ── Ledger de atribuicoes ──
    const led = repararAsinAtribuicoes(mapa);

    console.log('[BACKFILL-ASIN] ' + reparados + ' registro(s) e ' + led.reparadas
      + ' atribuicao(oes) reparada(s) em ' + shardsTocados.size + ' shard(s).');
    res.json({ ok:true, meses, urlsResolvidas:Object.keys(mapa).length,
               historico:{ afetados:achados.length, reparados, semMapa,
                           shards:[...shardsTocados] },
               ledger:led, falhas });
  } catch (e) {
    console.error('[BACKFILL-ASIN] Falhou:', e.message);
    res.status(500).json({ ok:false, erro:e.message });
  }
});

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
  // NICHO CURADO da leva inteira. Quem cola 40 links de furadeira ja sabe que
  // sao 40 ferramentas — pedir para o classificador redescobrir isso titulo a
  // titulo e trocar certeza por palpite. Vazio = comportamento historico.
  const nicho = String(req.body?.nicho || '').trim() || null;
  if (nicho && !nichoValido(nicho)) {
    return res.status(400).json({ ok:false,
      erro:'nicho "' + nicho + '" nao existe na taxonomia — use um dos: ' + nichosDisponiveis().join(', ') });
  }
  const salvos = [], erros = [];

  // ── AGRUPAMENTO POR LINHA ──
  // Linha com DUAS OU MAIS URLs = o mesmo produto em lojas diferentes. Os itens
  // entram na base separados (cada loja tem seu preco e seu identificador), mas
  // compartilham um `grupo` — e e o grupo que o monitor usa para o historico, o
  // cooldown e a escolha da loja mais barata no disparo.
  //
  // Uma URL por linha continua funcionando exatamente como antes, inclusive o
  // formato do Magalu (`Nome | link | preco | precoDe`), que usa '|' para outra
  // coisa. A deteccao e pela CONTAGEM de URLs, nao pela presenca do separador.
  const RE_URL_LINHA = /https?:\/\/[^\s|]+/g;
  const expandidas = [];
  for (const linha of linhas) {
    const urls = linha.match(RE_URL_LINHA) || [];
    if (urls.length < 2) { expandidas.push({ linha, grupo: null }); continue; }
    const nomeGrupo = linha.slice(0, linha.indexOf(urls[0])).replace(/[|;]\s*$/, '').trim();
    const grupo = 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    for (const u of urls) {
      expandidas.push({ linha: nomeGrupo ? nomeGrupo + ' | ' + u : u, grupo });
    }
  }
  const grupos = new Set(expandidas.filter(e => e.grupo).map(e => e.grupo));

  for (const { linha, grupo } of expandidas) {
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
          cupom, nicho, grupo,
        }), jaExistia: jaTinha });
        continue;
      }
      // Magazine Luiza: link vira link de afiliado por transformacao de URL, sem
      // rede. Preco vem da propria linha porque nao ha fonte para consultar.
      if (ehLinkMagalu(linha)) {
        const rmg = await resolverLinhaVitrineMagalu(linha);
        if (!rmg || rmg.erro) { erros.push({ linha, erro: rmg?.erro || 'falhou' }); continue; }
        const jaTinhaMg = !!itemVitrine(rmg.asin);
        salvos.push({ ...salvarItemVitrine({ ...rmg, cupom, nicho, grupo }), jaExistia: jaTinhaMg });
        continue;
      }
      // Mercado Livre: identificador e MLB, nao ASIN, e o link de afiliado so
      // e gerado no disparo — por isso nao passa pelo resolvedor da Amazon.
      if (ehLinkMl(linha)) {
        if (!tokenAffOk()) { erros.push({ linha, erro: 'Mercado Livre nao configurado (ML_AFF_TOKEN)' }); continue; }
        const rml = await resolverLinhaVitrineMl(linha);
        if (!rml || rml.erro) { erros.push({ linha, erro: rml?.erro || 'falhou' }); continue; }
        const jaTinhaMl = !!itemVitrine(rml.asin);
        salvos.push({ ...salvarItemVitrine({ ...rml, cupom, nicho, grupo }), jaExistia: jaTinhaMl });
        continue;
      }
      // Rede Awin: qualquer anunciante afiliado. Vem antes do fallback da
      // Amazon, que so deve receber o que nenhuma outra loja reconheceu.
      if (ehLinkAwin(linha)) {
        const raw = await resolverLinhaVitrineAwin(linha);
        if (!raw || raw.erro) { erros.push({ linha, erro: raw?.erro || 'falhou' }); continue; }
        const jaTinhaAw = !!itemVitrine(raw.asin);
        salvos.push({ ...salvarItemVitrine({ ...raw, cupom, nicho, grupo }), jaExistia: jaTinhaAw,
          aviso: raw.precoManual ? 'preco informado a mao — a loja bloqueou a leitura automatica' : null });
        continue;
      }
      const r = await resolverLinhaVitrine(linha);
      if (!r || r.erro) { erros.push({ linha, erro: r?.erro || 'falhou' }); continue; }
      const jaTinha = !!itemVitrine(r.asin);
      salvos.push({ ...salvarItemVitrine({ ...r, cupom, nicho, grupo }), jaExistia: jaTinha });
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

  console.log('[VITRINE] Cadastro — ' + salvos.length + ' ok, ' + erros.length + ' erro(s)'
    + (nicho ? ', nicho curado: ' + nicho : '') + '.');
  res.json({ ok: salvos.length > 0, salvos, erros, nicho, grupos: grupos.size });
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
      // Mesma razao de dispararProdutoDaLista: sem o registro no historico o
      // disparo avulso nao conta, nao marca dedup e nao entra na vigilancia.
      oferta.status         = 'enviado';
      oferta.enviadoEm      = new Date().toISOString();
      oferta.gruposEnviados = r.enviados;
      oferta.falhas         = r.falhas;
      registrarEnvioHistorico(oferta);
      enviados.push({ asin:o.asin, nome:o.nome, grupos:r.enviados.length,
                      cupom:o.cupom?.codigo || null, aviso:o.avisoCupom || null });
    } catch (e) {
      falhas.push({ asin:o.asin, nome:o.nome, erro:e.message });
    }
    // Mesmo espacamento do radar: rajada em varios grupos e o padrao que o
    // WhatsApp usa para identificar automacao.
    if (montado.prontos.length > 1) await new Promise(r => setTimeout(r, msEntreGrupos()));
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

// ── MONITOR DE QUEDA DE PRECO ────────────────────────────────────────────────
// Toda configuracao e feita por estes endpoints — nao ha decisao de operacao
// escondida em constante de codigo nem em variavel de ambiente.

// Painel completo: config, fila de candidatos, cotas do dia, ultima varredura.
app.get('/monitor-precos', (req, res) => {
  res.json({ ok:true, ...estadoMonitorPrecos() });
});

app.get('/monitor-precos/config', (req, res) => {
  res.json({ ok:true, config: configMonitorPrecos(), lojas: LOJAS_MONITORAVEIS_PRECO });
});

app.post('/monitor-precos/config', (req, res) => {
  try { res.json({ ok:true, config: salvarConfigMonitorPrecos(req.body || {}) }); }
  catch (e) { res.status(400).json({ ok:false, erro:e.message }); }
});

// Tabela de monitorados com a estatistica de cada um (serie, min90, mediana30).
app.get('/monitor-precos/produtos', (req, res) => {
  res.json({ ok:true, produtos: listarMonitorados() });
});

// Serie completa de um produto — alimenta o grafico de historico no painel.
app.get('/monitor-precos/produto/:asin', (req, res) => {
  const h = historicoDe(req.params.asin);
  if (!h) return res.status(404).json({ ok:false, erro:'sem serie para este produto' });
  res.json({ ok:true, ...h });
});

// Varredura sob demanda. Sincrona de proposito: o operador clicou para VER o
// resultado, e a resposta traz o resumo por motivo de reprovacao.
app.post('/monitor-precos/varrer', async (req, res) => {
  try { res.json(await varrerPrecos({ manual: true })); }
  catch (e) { res.status(500).json({ ok:false, erro:e.message }); }
});

// Simulacao sobre a serie ja gravada: mexe nas regras e ve quantos passariam,
// sem tocar em rede e sem enviar nada. E como se calibra o limiar sem cobaia.
app.post('/monitor-precos/simular', (req, res) => {
  try { res.json({ ok:true, ...simularPrecos(req.body?.regras || null) }); }
  catch (e) { res.status(400).json({ ok:false, erro:e.message }); }
});

// ── DESEMPENHO REAL (ganho por clique) ──
// O ledger epc-produtos.json e escrito pelo coletor no GitHub Actions; aqui ele
// so e lido. Sem o arquivo, tudo isto responde vazio e o monitor segue igual.
app.get('/monitor-precos/epc', (req, res) => {
  res.json({ ok:true, estado: estadoEpc(),
             ranking: rankingEpc({ limite: Math.min(Number(req.query.limite) || 100, 400) }) });
});

// Previa da semeadura: mostra exatamente o que entraria, sem cadastrar nada.
app.post('/monitor-precos/semear/previa', (req, res) => {
  try { res.json({ ok:true, ...semearVitrinePorDesempenho({ simular: true }) }); }
  catch (e) { res.status(500).json({ ok:false, erro:e.message }); }
});

// Semeadura sob demanda. Roda tambem sozinha a cada varredura, quando ligada.
app.post('/monitor-precos/semear', (req, res) => {
  try { res.json({ ok:true, ...semearVitrinePorDesempenho() }); }
  catch (e) { res.status(500).json({ ok:false, erro:e.message }); }
});

app.delete('/monitor-precos/fila/:asin', (req, res) => {
  res.json({ ok: descartarCandidato(req.params.asin) });
});

// Publica um candidato agora, ignorando janela e espacamento (a cota continua
// valendo — furar cota em tela seria furar a propria cadencia).
app.post('/monitor-precos/fila/:asin/publicar', async (req, res) => {
  try {
    const r = await publicarPrecoAgora(req.params.asin);
    res.json({ ok: !!r.ok, ...r });
  } catch (e) { res.status(500).json({ ok:false, erro:e.message }); }
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
      link:'https://www.amazon.com.br/dp/B0H6N6K239?tag=davileles-20',
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

    // Detalhe do que o ML respondeu. Sem isso a mensagem ao operador vira uma
    // lista de codigos sem explicacao, e ele precisa abrir o navegador e testar
    // um por um so para descobrir o que o sync ja sabia.
    const pendentesDetalhe = [];
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
        // INVALID_6: o ML nao entendeu a chamada. Nao diz nada sobre o cupom, e
        // tambem nao e tarefa manual — nenhum operador resolve payload errado.
        console.error('[CUPONS-ML] ' + p.codigo + ': o ML rejeitou o payload (INVALID_6) — '
          + 'a chamada esta quebrada, o cupom nao esta em julgamento.');
      } else {
        // Resposta que nao encaixa em nenhum caso conhecido: nao mexe na base.
        pendentesAtivacao.push(p.codigo);
        pendentesDetalhe.push({ codigo: p.codigo, rc: r2.rc || null, mensagem: r2.mensagem || null,
                                validadeAte: p.validadeAte || null });
        console.warn('[CUPONS-ML] Resposta inesperada para ' + p.codigo + ': '
          + (r2.rc ? r2.rc + ' — ' : '') + (r2.mensagem || r2.status));
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
      for (const p of recusados) {
        pendentesAtivacao.push(p.codigo);
        pendentesDetalhe.push({ codigo: p.codigo, rc: null, mensagem: p.mensagem || null,
                                validadeAte: p.validadeAte || null });
      }
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
               fontes, atualizados, criados, desativados, pendentesAtivacao, pendentesDetalhe,
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
    // Restritos sao vigentes que ficam fora da escolha automatica: o painel
    // precisa distinguir os dois numeros para o operador nao contar com um
    // cupom que o robo nunca vai usar sozinho.
    restritos: itens.filter(c => cupomRestrito(c)).length,
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
  // atualizarCupomBase lanca quando o painel tenta ligar um cupom vencido. O
  // 409 carrega a explicacao: o operador precisa saber que o caminho e mexer na
  // validade, nao insistir no interruptor.
  let reg;
  try {
    reg = atualizarCupomBase(req.params.chave, req.body || {});
  } catch (e) {
    console.log('[CUPONS] Edicao recusada — ' + req.params.chave + ': ' + e.message);
    return res.status(409).json({ ok:false, erro: e.message });
  }
  if (!reg) return res.status(404).json({ ok:false, erro:'Cupom nao encontrado: ' + req.params.chave });
  console.log('[CUPONS] Editado via painel — ' + reg.chave
    + (reg.restrito ? ' (restrito a produtos especificos)' : ''));
  res.json({ ok:true, cupom: reg });
});

// Forca a sincronizacao de expirados sem esperar a proxima listagem. Existe
// para o painel poder pedir a limpeza explicitamente depois de uma virada de
// dia com a aba aberta.
app.post('/cupons/expirados/sincronizar', (req, res) => {
  const n = desativarExpirados();
  res.json({ ok:true, desativados:n });
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
app.get('/ml/status', (req, res) => res.json({ ok:true, ...estadoMl(),
  antibot: estadoAntibotMl(), antibotLogado: estadoAntibotLogadoMl(),
  // Leitor de perfil de afiliado: e por ele que todo link de grupo-fonte vira
  // produto hoje, entao seu estado precisa aparecer no mesmo lugar do resto.
  social: estadoSocialMl() }));

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
    await verificarPaginaProdutoMl(urlSondaProdutoMl(), avisarAntibotMl).catch(()=>{});
  }
  // paginaProduto e independente do token: o linkbuilder pode estar ok com
  // toda pagina de produto bloqueada pelo antibot.
  res.json({ ok:true, urlTeste: ML_AFF_URL_TESTE, ...saudeAff(),
             paginaProduto: saudePaginaMl(), paginasLogadas: estadoAntibotLogadoMl() });
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

// Sonda de PAGINA com o cookie de afiliado: devolve trechos que casam com
// ?grep= (regex) e uma amostra, para inspecionar paginas do painel (wishlist,
// listas) sem despejar o HTML inteiro. Mesma exposicao de /ml/aff/sonda.
app.get('/ml/aff/pagina', async (req, res) => {
  const url = String(req.query.url || '');
  if (!url) return res.status(400).json({ ok:false, erro:'passe ?url=' });
  const cookie = cookieAff();
  if (!cookie) return res.status(400).json({ ok:false, erro:'ML_AFF_TOKEN nao configurado' });
  try {
    const r = await fetch(url, {
      redirect: 'follow',
      headers: {
        'Cookie': cookie,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9',
      },
      signal: AbortSignal.timeout(25000),
    });
    const html = await r.text();
    const trechos = [];
    if (req.query.grep) {
      let re; try { re = new RegExp(String(req.query.grep), 'gi'); } catch (e) { re = null; }
      if (re) {
        const ctx = Math.min(Number(req.query.ctx) || 80, 400);
        let m; while ((m = re.exec(html)) && trechos.length < 40) {
          trechos.push(html.slice(Math.max(0, m.index - ctx), m.index + m[0].length + ctx));
          if (m[0].length === 0) re.lastIndex++;
        }
      }
    }
    res.json({ ok: r.ok, status: r.status, urlFinal: r.url, tamanho: html.length,
               titulo: (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || null,
               bloqueado: /captcha\/wall|abuse-captcha|account-verification/i.test(r.url + html.slice(0, 5000)),
               trechos, amostra: html.slice(0, Math.min(Number(req.query.amostra) || 0, 3000)) });
  } catch (e) { res.status(500).json({ ok:false, erro:e.message }); }
});

// Sonda do painel de afiliados: descobre quais endpoints o token abre.
app.get('/ml/aff/sonda', async (req, res) => {
  if (!req.query.url) return res.status(400).json({ ok:false, erro:'passe ?url=' });
  try { res.json(await chamarAff(req.query.url)); }
  catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
});

// Sonda da pagina sob demanda, para quando o IP mudar e valer confirmar na hora.
// ?forcar=1 ignora a cadencia diaria — e a unica forma de gastar leitura extra.
app.get('/ml/sonda-pagina', async (req, res) => {
  const r = await rotinaSondaPaginaMl({ forcar: req.query.forcar === '1' });
  const m = lerMarcaSondaMl();
  res.json({ ok:true, cadenciaHoras: ML_SONDA_PAGINA_MS / 3600e3,
             ultimaEm: m?.em ? new Date(m.em).toISOString() : null,
             bloqueado: m?.bloqueado ?? null,
             bloqueadoDesde: m?.bloqueadoDesde ? new Date(m.bloqueadoDesde).toISOString() : null,
             resultado: r });
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

// leitura=1 para aqui antes do createLink: da para conferir preco e titulo de um
// link de grupo sem gerar link de afiliado — o que grudaria a etiqueta de nicho
// num produto que talvez nem seja divulgado.
app.post('/ml/testar', async (req, res) => {
  const leitura = req.body?.leitura === true || String(req.query.leitura || '') === '1';
  try { res.json({ ok:true, leitura,
                   resultados: await processarTextoMl(req.body?.texto || '', { leitura }) }); }
  catch(e) { res.status(500).json({ ok:false, erro:e.message }); }
});

// Diagnostico: despeja tudo que a pagina do produto fala sobre cupom, para
// escrever o parser contra o formato real. Nao aplica desconto nem publica nada.
app.get('/ml/diagnostico-cupom', async (req, res) => {
  if (!req.query.url) return res.status(400).json({ ok:false, erro:'passe ?url=' });
  try { res.json({ ok:true, ...await dumpCupomMl(req.query.url, { forcar: req.query.forcar === '1' }) }); }
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
  // viaNossoLink: link colado a mao pode ser anuncio classico, que hoje so tem
  // preco pelo card do nosso proprio perfil social. Vale aqui e nao no radar
  // porque o operador ja decidiu divulgar este item.
  if (ehLinkMl(texto))     return { loja: 'Mercado Livre',  run: t => processarTextoMl(t, { viaNossoLink: true }) };
  if (ehLinkShopee(texto)) return { loja: 'Shopee',         run: t => processarTextoShopee(t) };
  if (ehLinkMagalu(texto)) return { loja: 'Magazine Luiza', run: t => processarTextoMagalu(t) };
  // Rede Awin: cobre os 80+ anunciantes afiliados, cada um com sua propria
  // pagina de produto. Fica depois das lojas com API propria e antes do
  // fallback da Amazon, que so deve pegar o que ninguem reconheceu.
  const progAwin = programaAwinPorUrl((String(texto).match(/https?:\/\/[^\s]+/) || [''])[0]);
  if (progAwin) return {
    loja: String(progAwin.name).replace(/\s*\(?(BR(\s*&\s*LATAM)?|LATAM|Global)\)?\s*$/i, '').trim(),
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
      // Procedencia: de onde saiu o preco e a categoria. Com a pagina do ML
      // bloqueada ha varias fontes possiveis, e o operador precisa saber se
      // esta olhando dado da API oficial ou de card de perfil.
      trilha: p.trilha || null, fonteDados: p.fonteDados || null,
      trilhaFonte: p.trilhaFonte || null, precoDeFonte: p.precoDeFonte || null,
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

// ── SAUDE DOS CONVITES DO DISTRIBUIDOR ───────────────────────────────────────
// Um convite revogado no WhatsApp nao quebra nada do lado do servidor: o link
// segue gravado, o distribuidor entrega normalmente e quem clica cai num "o
// link foi redefinido". O /gg/saude nao ve isso — ele checa se o ESTADO
// carregou, nao se os convites estao vivos. Resultado: a fatia da campanha
// roteada para aquele grupo se perde em silencio ate alguem reclamar.
//
// Aqui a verificacao e ativa: percorre os grupos ativos e pede o codigo de
// convite a cada um. O WhatsApp responde 'gone' quando o codigo foi
// invalidado, que e exatamente o sintoma que o usuario final enxerga.
const GG_CHECK_MS = 6 * 60 * 60 * 1000;   // 4x ao dia; cada rodada e uma chamada por grupo

// Estado dos alertas ja emitidos, para nao repetir o mesmo aviso a cada rodada
// (4x ao dia viraria ruido e o operador pararia de ler). Guarda so o jid ->
// quando alertou; quando o convite volta, o jid sai daqui e um novo problema
// futuro volta a alertar.
const _ggConvitesQuebrados = new Map();

// Ultimo resultado, para o painel mostrar o estado sem re-disparar a varredura.
// A badge abre junto com a aba: se ela chamasse a verificacao, cada abertura
// viraria 40+ chamadas de grupo ao WhatsApp e alguns segundos de espera.
let _ggUltimaVerificacao = null;

function _ggConviteGone(msg) {
  return /\bgone\b|not-authorized|forbidden|404|item-not-found/i.test(String(msg || ''));
}

async function verificarConvitesDistribuidor(opcoes = {}) {
  const chave = process.env.CAMPANHAS_KEY || '';
  if (!chave) return { ok:false, erro:'CAMPANHAS_KEY nao configurada' };
  if (!sock || !conectado) return { ok:false, erro:'WhatsApp nao conectado' };

  let lista = [];
  try {
    const r = await fetch(CDV_PROXY_URL + '/gg/grupos-ativos', {
      headers: { 'X-CDV-Op': chave },
      signal: AbortSignal.timeout(20000),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) throw new Error(d.erro || ('status ' + r.status));
    lista = d.grupos || [];
  } catch (e) {
    console.error('[GG-CHECK] Falha ao listar grupos ativos:', e.message);
    return { ok:false, erro:e.message };
  }

  const quebrados = [], recuperados = [];
  let checados = 0;
  for (const g of lista) {
    try {
      // Sem cache de proposito: o objetivo e justamente detectar a revogacao,
      // e um convite em cache responderia com o codigo velho, que e o proprio
      // link morto que estamos tentando encontrar.
      await sock.groupInviteCode(g.jid);
      checados++;
      if (_ggConvitesQuebrados.has(g.jid)) {
        _ggConvitesQuebrados.delete(g.jid);
        recuperados.push(g);
      }
    } catch (e) {
      checados++;
      const msg = e?.message || String(e);
      if (!_ggConviteGone(msg)) {
        // Erro transitorio (timeout, socket instavel) nao e convite morto:
        // alertar aqui geraria falso positivo toda vez que a conexao oscilasse.
        console.warn('[GG-CHECK] ' + (g.nome || g.jid) + ': erro transitorio — ' + msg);
        continue;
      }
      if (!_ggConvitesQuebrados.has(g.jid)) {
        _ggConvitesQuebrados.set(g.jid, Date.now());
        quebrados.push({ ...g, erro: msg });
      }
    }
    await new Promise(r => setTimeout(r, 700));   // respiro entre chamadas
  }

  if (quebrados.length) {
    const txt = '*Convite quebrado no distribuidor* \u26A0\uFE0F\n\n'
      + quebrados.map(g => '\u00b7 ' + (g.nome || g.jid) + '  (link: ' + g.slug + ')').join('\n')
      + '\n\nQuem clicar e roteado para esse grupo recebe "o link foi redefinido".'
      + '\nAbra o grupo no WhatsApp, gere o convite de novo e rode a sincronizacao do distribuidor.';
    await _avisarOperador(txt).catch(() => {});
  }
  if (recuperados.length) {
    await _avisarOperador('OK — convite normalizado: '
      + recuperados.map(g => g.nome || g.jid).join(', ')).catch(() => {});
  }

  console.log('[GG-CHECK] ' + checados + '/' + lista.length + ' grupos checados — '
    + quebrados.length + ' novo(s) quebrado(s), ' + recuperados.length + ' recuperado(s), '
    + _ggConvitesQuebrados.size + ' em estado quebrado.');

  // Nomes junto do jid: a badge precisa DIZER qual grupo quebrou. Um jid cru
  // nao ajuda ninguem a achar o grupo no WhatsApp.
  const quebradosAgora = lista
    .filter(g => _ggConvitesQuebrados.has(g.jid))
    .map(g => ({ jid:g.jid, nome:g.nome || g.jid, slug:g.slug }));

  _ggUltimaVerificacao = {
    verificadoEm: new Date().toISOString(),
    total: lista.length, checados,
    quebrados: quebradosAgora,
  };

  return { ok:true, total:lista.length, checados,
           quebrados: quebrados.map(g => ({ jid:g.jid, nome:g.nome, slug:g.slug, erro:g.erro })),
           recuperados: recuperados.map(g => ({ jid:g.jid, nome:g.nome })),
           emEstadoQuebrado: quebradosAgora };
}

// Leitura barata do ultimo resultado, para a badge do painel. Nunca dispara a
// varredura: quem quer forcar usa o POST abaixo.
app.get('/gg/convites-status', (req, res) => {
  if (!_ggUltimaVerificacao) {
    return res.json({ ok:true, verificado:false,
      motivo: conectado ? 'primeira verificacao ainda nao rodou' : 'WhatsApp nao conectado' });
  }
  res.json({ ok:true, verificado:true, ..._ggUltimaVerificacao });
});

// Verificacao manual pelo painel/curl, alem do ciclo automatico.
app.post('/gg/checar-convites', async (req, res) => {
  try { res.json(await verificarConvitesDistribuidor()); }
  catch (e) { res.status(500).json({ ok:false, erro:e.message }); }
});

// Primeira rodada 5 min depois do boot: da tempo do WhatsApp conectar e evita
// disparar 12+ chamadas de grupo durante o restabelecimento da sessao.
setTimeout(() => { verificarConvitesDistribuidor().catch(() => {}); }, 5 * 60 * 1000).unref?.();
setInterval(() => { verificarConvitesDistribuidor().catch(() => {}); }, GG_CHECK_MS).unref?.();

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
  try { escreverAtomico(CENSO_FILE, JSON.stringify(_censo, null, 2), 'utf-8'); }
  catch(e) { console.error('[CENSO] Falha ao gravar censo:', e.message); }
}

// Declaracao (nao IIFE) porque o boot precisa chamar de novo DEPOIS do
// baixarDoGitHub(): no import o volume do Railway pode estar vazio, e uma
// memoria vazia gravando por cima apaga a serie inteira no repositorio.
function carregarCensoHist() {
  try {
    if (existsSync(CENSO_HIST_FILE)) _censoHist = JSON.parse(readFileSync(CENSO_HIST_FILE, 'utf-8'));
    if (!_censoHist || typeof _censoHist !== 'object' || !_censoHist.dias) _censoHist = { dias: {} };
    console.log('[CENSO] ' + Object.keys(_censoHist.dias).length + ' dia(s) na serie historica.');
  } catch(e) { console.warn('[CENSO] Falha ao ler historico:', e.message); _censoHist = { dias: {} }; }
}
carregarCensoHist();

// Uma medicao por dia: rodar o censo duas vezes no mesmo dia sobrescreve o
// ponto em vez de criar um segundo, senao o grafico ganharia degraus falsos.
function registrarHistoricoCenso(grupos) {
  // Defesa em profundidade: rele o disco e mescla antes de gravar. Se por
  // qualquer motivo a memoria estiver mais pobre que o arquivo (volume que
  // subiu depois do import, restauracao tardia do GitHub), a serie do disco
  // prevalece nos dias que a memoria nao tem — gravar por cima nunca apaga.
  try {
    if (existsSync(CENSO_HIST_FILE)) {
      const emDisco = JSON.parse(readFileSync(CENSO_HIST_FILE, 'utf-8'));
      for (const [d, reg] of Object.entries(emDisco?.dias || {}))
        if (!_censoHist.dias[d]) _censoHist.dias[d] = reg;
    }
  } catch(e) { console.warn('[CENSO] Falha ao mesclar historico do disco:', e.message); }

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
    escreverAtomico(CENSO_HIST_FILE, JSON.stringify(_censoHist, null, 2), 'utf-8');
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

// Mesma razao de carregarCensoHist(): o boot rechama apos o download.
function carregarMembrosLog() {
  try {
    if (existsSync(MEMBROS_LOG_FILE)) _membrosLog = JSON.parse(readFileSync(MEMBROS_LOG_FILE, 'utf-8'));
    if (!_membrosLog?.eventos) _membrosLog = { eventos: [] };
    console.log('[MEMBROS] ' + _membrosLog.eventos.length + ' evento(s) no ledger.');
  } catch(e) { console.warn('[MEMBROS] Falha ao ler ledger:', e.message); _membrosLog = { eventos: [] }; }
}
carregarMembrosLog();

// Debounce na gravacao: uma entrada em massa (link divulgado) gera dezenas de
// eventos em segundos, e gravar a cada um seria desperdicio de I/O e de commit.
function salvarMembrosLog() {
  if (_membrosLogTimer) return;
  _membrosLogTimer = setTimeout(() => {
    _membrosLogTimer = null;
    try {
      if (_membrosLog.eventos.length > MEMBROS_LOG_MAX)
        _membrosLog.eventos = _membrosLog.eventos.slice(-MEMBROS_LOG_MAX);
      escreverAtomico(MEMBROS_LOG_FILE, JSON.stringify(_membrosLog), 'utf-8');
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
    escreverAtomico(CENSO_HIST_FILE, JSON.stringify(_censoHist, null, 2), 'utf-8');
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


// Cura cirurgica de UM contato: use quando o cliente relata "Aguardando
// mensagem". Nao derruba a conexao nem pede QR.
app.post('/reset-sessao-contato', async (req, res) => {
  const alvo = req.body?.telefone || req.body?.jid || '';
  if (!alvo) return res.status(400).json({ ok: false, erro: 'informe telefone ou jid' });
  const r = await resetarSessaoContato(alvo);
  res.json({
    ok: true,
    apagados: r.apagados,
    arquivos: r.arquivos,
    lid: r.lid || null,
    enderecosLimpos: r.users,
    mensagem: r.apagados
      ? 'Sessao apagada. Reenvie a mensagem: ela abrira uma sessao nova e chegara decifravel.'
      : 'Nenhum registro de sessao encontrado para esse numero (ja estava limpo — reenvie normalmente).',
  });
});

// Diagnostico do diretorio de sessao: mostra COMO as sessoes estao endereçadas
// (telefone ou LID) e o que existe para um contato. Devolve apenas nomes de
// arquivo e contagens — nunca conteudo de chave.
app.get('/sessao/diagnostico', async (req, res) => {
  try {
    const alvo = String(req.query.telefone || '').replace(/\D/g, '');
    const arquivos = await readdir(SESSAO_DIR);
    const sessions = arquivos.filter(a => a.startsWith('session-'));
    const porTipo = {};
    for (const a of arquivos) {
      const t = a.split('-').slice(0, 2).join('-');
      porTipo[t] = (porTipo[t] || 0) + 1;
    }
    let contato = null;
    if (alvo) {
      const lid = await lidDoContato(alvo);
      const users = [alvo, lid].filter(Boolean);
      contato = {
        telefone: alvo,
        lid,
        sessoes: sessions.filter(a => users.some(u => a.startsWith('session-' + u + '.'))),
      };
    }
    res.json({
      ok: true,
      totalArquivos: arquivos.length,
      totalSessoes: sessions.length,
      porTipo,
      amostraSessoes: sessions.slice(0, 25),
      contato,
    });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

// Diagnostico: quem pediu reenvio (ou seja, nao conseguiu decifrar) e quando.
app.get('/entregas-suspeitas', (req, res) => {
  const itens = [..._retriesPorUser].map(([user, r]) => ({
    user, retries: r.n, ultimoEm: new Date(r.ultimoEm).toISOString(),
  })).sort((a, b) => b.retries - a.retries);
  res.json({ ok: true, total: itens.length, limiteAutocura: RETRY_LIMITE_AUTOCURA, itens });
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
  errosDescripto = 0; _indecifraveisPorGrupo.clear();
  _reconectarTentativas = 0;
  isResetting = false;

  _agendarReconexao(2000);
});

// ── CONECTAR SEM QR: PAREAMENTO POR CODIGO ──────────────────────────────────
// Cenario alvo: operador com o celular na mao e sem computador. O QR exige uma
// segunda tela; o codigo de 8 caracteres nao. Como o WhatsApp so aceita o
// pedido de codigo com a sessao ainda NAO registrada, este fluxo apaga as
// credenciais antes (mesmo filtro de preservacao do reset completo) e so
// entao sobe o socket pedindo o codigo.

async function limparCredenciaisSessao() {
  try {
    const arquivos = await readdir(SESSAO_DIR);
    for (const arq of arquivos) {
      if (PRESERVAR_NO_RESET.has(arq)) continue;
      await unlink(SESSAO_DIR + '/' + arq).catch(() => {});
    }
    console.log('[PAIR] Credenciais apagadas. Sessao pronta para novo pareamento.');
    return true;
  } catch (e) {
    console.error('[PAIR] Erro ao apagar sessao:', e.message);
    return false;
  }
}

// ── RENOVACAO DE IDENTIDADE (cura da surdez preservando o pareamento) ────────
// Historico (13, 17, 22, 27 e 2x 28/08/2026): o socket fica surdo — conectado,
// enviando, ping de presenca ok, ZERO upserts — e NADA da escada antiga curava:
// nem reconexao, nem limpar sessions/sender-keys (degrau 2 antigo, falhou em
// 28/08 de manha), nem restart de container (degrau 3, falhou 2x em 28/08).
// A cura, em todas as ocorrencias documentadas, veio do mesmo ACIDENTE: um 401
// transitorio caia no ramo de logout, que apagava a identidade inteira, e o
// creds.json era ressuscitado pela corrida do flush em memoria. Efeito liquido:
// pareamento preservado + resto da identidade zerado + reconexao = upserts de
// volta em ~1 min. Sintoma e cura batem com o issue #2271 do Baileys ("must
// delete the session and reconnect"): o cadastro do device vicia no servidor.
// Esta funcao reproduz a cura de proposito, sem depender de corrida:
//   1. drena e DESREGISTRA o flush (nada regrava por cima depois);
//   2. guarda o creds em memoria e apaga todos os arquivos da sessao
//      (sessions, sender keys, pre-keys, app-state), como no reset completo;
//   3. RENOVA o signed pre-key (keyId+1) e alinha os contadores de pre-key
//      (as one-time antigas morreram no apagao — nada fica "pendente");
//   4. regrava o creds.json renovado, deterministicamente;
//   5. reconecta; no 'open', uploadPreKeys() sobe o bundle novo e o servidor
//      renova o cadastro do device sem novo pareamento.
// Custo esperado e transitorio: sessoes 1:1 e sender keys se refazem sozinhas
// via retry receipt (alguns "aguardando mensagem" por minutos, como os 9 stubs
// de 28/08 a noite). App-state-sync se perde — sem efeito em mensagens, e
// syncFullHistory ja e false.
let _renovacaoPendenteUpload = false;

async function renovarIdentidadeSessao(motivo) {
  if (isResetting) { console.log('[RENOVACAO] Reset em andamento, ignorando.'); return false; }
  isResetting = true;
  console.warn('[RENOVACAO] Renovando identidade da sessao (' + motivo + ') — pareamento preservado.');
  try {
    if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
    conectado = false;
    isConnecting = false;
    _reconectarTentativas = 0;
    if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
    const sockRef = sock;
    sock = null;
    if (sockRef) {
      try { sockRef.ws?.close?.(); } catch (e) {}
      try { sockRef.end(new Error('renovacao-identidade')); } catch (e) {}
    }

    // Flush drenado e DESREGISTRADO: a partir daqui nenhuma escrita da sessao
    // antiga regrava arquivo apagado (a corrida de 27-28/08).
    try {
      const _f = _flushsSessao.get(SESSAO_DIR);
      _flushsSessao.delete(SESSAO_DIR);
      if (_f) await _f(3000);
    } catch (e) {}

    // creds para a memoria ANTES do apagao. Sem creds legivel e registrado,
    // renovar viraria perder o pareamento — nesse caso aborta e so reconecta.
    let creds = null;
    try { creds = JSON.parse(await readFileAsync(SESSAO_DIR + '/creds.json', 'utf-8'), BufferJSON.reviver); }
    catch (e) { creds = null; }
    if (!creds?.registered || !creds?.signedIdentityKey) {
      console.error('[RENOVACAO] creds.json ilegivel ou sem registro — abortando para nao perder o pareamento.');
      isResetting = false;
      _agendarReconexao(3000);
      return false;
    }

    // Apagao identico ao do pareamento (preserva so os arquivos de negocio).
    await limparCredenciaisSessao();

    // Signed pre-key NOVO + contadores alinhados.
    try {
      creds.signedPreKey = signedKeyPair(creds.signedIdentityKey, (creds.signedPreKey?.keyId || 1) + 1);
      creds.firstUnuploadedPreKeyId = creds.nextPreKeyId || 1;
    } catch (e) { console.error('[RENOVACAO] Falha ao renovar signed pre-key:', e.message); }

    await writeFileAsync(SESSAO_DIR + '/creds.json', JSON.stringify(creds, BufferJSON.replacer));
    console.log('[RENOVACAO] creds.json regravado (signedPreKey keyId ' + (creds.signedPreKey?.keyId || '?') + '). Reconectando para subir o bundle novo...');

    errosDescripto = 0; _indecifraveisPorGrupo.clear();
    _renovacaoPendenteUpload = true;
    isResetting = false;
    _agendarReconexao(2500);
    return true;
  } catch (e) {
    console.error('[RENOVACAO] Erro:', e.message);
    isResetting = false;
    _agendarReconexao(3000);
    return false;
  }
}

app.post('/curar-conflito', (req, res) => {
  try {
    curarPorConflito('endpoint-manual');
    res.json({ ok: true, mensagem: 'Takeover disparado: socket novo subindo por cima do atual. Acompanhe /status.' });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.post('/renovar-identidade', async (req, res) => {
  const ok = await renovarIdentidadeSessao('endpoint-manual');
  res.json({ ok, mensagem: ok
    ? 'Identidade renovada; reconectando e subindo bundle novo. Acompanhe /status.'
    : 'Nao foi possivel renovar agora — veja os logs.' });
});

app.post('/pair', async (req, res) => {
  const bruto  = String(req.body?.numero || req.query?.numero || '');
  const numero = bruto.replace(/\D/g, '');
  if (numero.length < 10 || numero.length > 15) {
    return res.status(400).json({ ok:false, erro:'numero invalido: use DDI + DDD + numero, so digitos (ex 5511999999999)' });
  }
  if (isResetting) return res.status(409).json({ ok:false, erro:'reset em andamento, tente em alguns segundos' });

  console.log('[PAIR] Pareamento por codigo solicitado para ' + numero);
  isResetting = true;
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  conectado = false;
  qrAtual   = null;
  const sockRef = sock;
  sock = null;
  if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
  if (sockRef) { try { sockRef.end(new Error('pair-codigo')); } catch(e) {} }

  await limparCredenciaisSessao();

  pairNumero   = numero;
  pairCodigo   = null;
  pairErro     = null;
  pairPedidoEm = Date.now();
  errosDescripto = 0; _indecifraveisPorGrupo.clear();
  _reconectarTentativas = 0;
  isResetting = false;

  _agendarReconexao(1500);
  res.json({ ok:true, mensagem:'Gerando codigo para ' + numero + '. Consulte /pair/status.' });
});

app.get('/pair/status', (req, res) => {
  const expirado = pairPedidoEm > 0 && (Date.now() - pairPedidoEm) > 10 * 60 * 1000;
  res.json({
    ok: true,
    conectado,
    numero: pairNumero,
    codigo: expirado ? null : pairCodigo,
    erro: pairErro,
    expirado,
    aguardando: !!pairNumero && !pairCodigo && !pairErro && !expirado,
  });
});

app.get('/pair', (req, res) => {
  res.type('html').send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Conectar por codigo</title><style>
*{box-sizing:border-box}body{background:#0d0d0d;color:#f0f0f0;font-family:-apple-system,BlinkMacSystemFont,sans-serif;margin:0;padding:24px;display:flex;flex-direction:column;align-items:center;gap:14px}
h1{color:#ffa500;font-size:1.3rem;margin:8px 0 0}
.card{width:100%;max-width:420px;background:#151515;border:1px solid #2a2a2a;border-radius:14px;padding:18px}
label{display:block;font-size:.85rem;color:#aaa;margin-bottom:6px}
input{width:100%;padding:14px;font-size:1.1rem;border-radius:10px;border:1px solid #333;background:#0d0d0d;color:#fff}
button{width:100%;margin-top:12px;padding:14px;font-size:1rem;font-weight:600;border:0;border-radius:10px;background:#ffa500;color:#111}
button:disabled{opacity:.5}
#codigo{font-size:2.1rem;letter-spacing:.28em;color:#ffa500;text-align:center;font-weight:700;margin:10px 0}
ol{color:#ccc;font-size:.9rem;line-height:1.6;padding-left:18px}
.msg{font-size:.9rem;color:#aaa;text-align:center}
.err{color:#ff6b6b}.ok{color:#4ade80}
</style></head><body>
<h1>Conectar WhatsApp por codigo</h1>
<div class="card">
  <label>Numero da conta (DDI + DDD + numero)</label>
  <input id="num" type="tel" inputmode="numeric" placeholder="5511999999999">
  <button id="btn">Gerar codigo</button>
  <p class="msg" id="msg"></p>
  <div id="codigo"></div>
</div>
<div class="card">
  <ol>
    <li>Antes de tudo: no WhatsApp do celular, va em <b>Dispositivos conectados</b> e desconecte o dispositivo antigo.</li>
    <li>Digite o numero acima e toque em <b>Gerar codigo</b>.</li>
    <li>No WhatsApp: <b>Dispositivos conectados > Conectar dispositivo > Conectar com numero de telefone</b>.</li>
    <li>Digite o codigo de 8 caracteres que aparecer aqui. Ele vale poucos minutos.</li>
  </ol>
</div>
<script>
var t=null;
function msg(txt,cls){var m=document.getElementById('msg');m.textContent=txt;m.className='msg '+(cls||'');}
document.getElementById('btn').onclick=async function(){
  var n=document.getElementById('num').value.replace(/\D/g,'');
  if(n.length<10){msg('Numero invalido.','err');return;}
  this.disabled=true;document.getElementById('codigo').textContent='';
  msg('Reiniciando a sessao e pedindo o codigo...');
  try{
    var r=await fetch('/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({numero:n})});
    var j=await r.json();
    if(!j.ok){msg(j.erro||'Falhou.','err');this.disabled=false;return;}
    if(t)clearInterval(t);
    t=setInterval(checar,2500);
  }catch(e){msg('Erro: '+e.message,'err');this.disabled=false;}
};
async function checar(){
  try{
    var r=await fetch('/pair/status');var j=await r.json();
    if(j.conectado){clearInterval(t);msg('WhatsApp conectado!','ok');document.getElementById('codigo').textContent='';return;}
    if(j.codigo){document.getElementById('codigo').textContent=j.codigo.replace(/(.{4})(.{4})/,'$1-$2');msg('Digite este codigo no WhatsApp.');return;}
    if(j.erro){msg('Erro: '+j.erro,'err');document.getElementById('btn').disabled=false;return;}
    msg('Aguardando o codigo...');
  }catch(e){}
}
checar();
</script></body></html>`);
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
    escreverAtomico(HIST_SEATS_PATH, JSON.stringify(historicoSeats), 'utf-8');
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

// Faxina do volume: uma no arranque (antes que o disco aperte de novo) e uma a
// cada 6h. Roda solta de proposito — nada no boot deve esperar por ela.
faxinaDisco('arranque').then(r => {
  // Volume ja estourado no arranque: o corte por idade nao adiantou, entao
  // apara pelo excedente. Sem isso o processo volta a ENOSPC em minutos.
  if (r.apagados === 0 && r.mantidos > 2000) return faxinaEmergencia(500);
}).catch(() => {});
setInterval(() => { faxinaDisco('periodica').catch(() => {}); }, FAXINA_INTERV);

// ── SONDA DE LIBERACAO DA CREATORS API (AMAZON) ──────────────────────────────
// A conta de Associados esta sem elegibilidade e o getItems devolve 403. Em vez
// de descobrir a liberacao por acaso, uma sonda barata (1 ASIN, 1 chamada) bate
// de tempos em tempos e avisa o operador no minuto em que a API voltar. Sucesso
// ja limpa a marca de indisponibilidade dentro do modulo, entao o pipeline
// retoma o caminho com API sozinho — este aviso e so para o humano saber.
const AMZ_SONDA_MS = Number(process.env.AMZ_SONDA_MIN || 30) * 60 * 1000;
let _amzAvisado = false;

async function sondaApiAmazon() {
  // Com contas separadas, a leitura vem de uma conta que ja responde 200 — a
  // marca de indisponibilidade nunca acende e a sonda precisa rodar assim
  // mesmo, porque quem esta sendo medida e a conta de divulgacao.
  if (!contasAmazonSeparadas() && !apiAmazonIndisponivel()) return;
  const r = await sondarApiAmazon();
  if (!r.ok) {
    _amzAvisado = false;   // segue fora do ar: proximo sucesso volta a avisar
    console.log('[AMZ-SONDA] Creators API ainda indisponivel — HTTP ' + r.status);
    return;
  }
  if (_amzAvisado) return;
  _amzAvisado = true;
  console.log('[AMZ-SONDA] Creators API LIBERADA — pipeline voltou ao caminho com API.');
  try {
    await registrarAlerta({ nivel:'info', origem:'amazon', chave:'amazon:api-liberada',
      titulo:'Creators API da Amazon liberada', corpo:
      '\u2705 *Creators API da Amazon liberada*\n\n'
      + 'A conta de Associados passou a responder ao getItems. '
      + 'O radar ja voltou sozinho ao caminho com API: preco conferido, imagem, '
      + 'estoque e nota.\n\n'
      + 'A oferta Amazon volta a sair pelo auto-envio normal, com todos os '
      + 'filtros de sempre (preco confirmado, em estoque, piso de desconto e dedup).\n\n'
      + 'Lembretes:\n'
      + '\u2022 desligar a divulgacao Amazon na ferramenta externa, para nao duplicar\n'
      + '\u2022 REMOVER as variaveis AMZ_*_LEITURA do Railway: a leitura volta a\n'
      + '  sair da propria conta e as duas deixam de se cruzar\n'
      + '\u2022 reativar a Amazon no monitor de precos (LOJAS_MONITORAVEIS_PRECO)' });
  } catch (e) { console.warn('[AMZ-SONDA] Falha ao avisar o operador:', e.message); }
}

setInterval(() => { sondaApiAmazon().catch(() => {}); }, AMZ_SONDA_MS).unref?.();
// Uma sondagem no arranque, depois que o socket teve tempo de abrir.
setTimeout(() => { sondaApiAmazon().catch(() => {}); }, 90000).unref?.();

// Estado da API Amazon para o painel/diagnostico.
app.get('/mkt/amazon/estado', (req, res) => {
  res.json({ ok: true, api: estadoApiAmazon(), disparoSemApi: disparoSemApiLiberado(),
             contasSeparadas: contasAmazonSeparadas(), sondaMin: AMZ_SONDA_MS / 60000 });
});
app.post('/mkt/amazon/sondar', async (req, res) => {
  res.json({ ok: true, resultado: await sondarApiAmazon(), api: estadoApiAmazon() });
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
  // Operacao pelo celular: /reconectar (com confirmacao) e /status no proprio bot.
  forcarReconexao,
  status: () => ({
    conectado, sockAtivo: !!sock,
    surdezEstado: _surdezEstado,
    logout: !!_logoutEm,
    logoutMin: _logoutEm ? Math.round((Date.now() - _logoutEm) / 60000) : null,
    minSemUpsert: _health.ultimoUpsertEm ? Math.round((Date.now() - _health.ultimoUpsertEm) / 60000) : null,
    telegramConectado: tgConectado,
    publicacoesHoje: publicacoesHoje(),
    despachosHoje: despachosHoje(),
    filaTotal: filaPendentes.length,
    filaPendentes: filaPendentes.filter(o => o.status === 'pendente' && !o.autoAgendado).length,
    uptimeMin: Math.round((Date.now() - _bootEm) / 60000),
  }),
}).catch(e => console.warn('[BOT-TSP] Falha no boot:', e.message));

// Monitor de queda de preco. As funcoes de montagem e envio sao injetadas em
// vez de importadas: o modulo precisa do caminho REAL de envio (template, cupom,
// rodape por nicho, roteamento por trilha) sem criar ciclo de import com este
// arquivo. whatsappPronto evita consumir a fila com o socket caido.
iniciarMonitorPrecos({
  enviarOferta:   enviarOfertaParaDestinos,
  montarShopee:   montarOfertasShopeeVitrine,
  montarMl:       montarOfertasMlVitrine,
  montarAmazon:   montarOfertasVitrine,
  baixarImagem:   baixarImagemProduto,
  gerarId,
  whatsappPronto: () => !!(conectado && sock),
});

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
