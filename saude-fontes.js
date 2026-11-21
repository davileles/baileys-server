// ═════════════════════════════════════════════════════════════════════════════
// saude-fontes.js — saude das fontes externas de historico de preco
// (Keepa e Descontinho), 21/11/2026.
//
// Regra do Davi: se uma fonte cair, as ofertas continuam saindo normalmente
// (quem chama nunca espera a fonte por mais que alguns segundos e segue sem ela),
// mas o grupo do operador recebe UM aviso de que ela caiu e um quando voltou.
//
// "Caiu" = falhas seguidas (rede, timeout, 5xx, chave/assinatura recusada)
// por um periodo, nao uma falha solta. "Produto nao encontrado" e resposta
// normal da fonte e conta como sucesso.
// ═════════════════════════════════════════════════════════════════════════════

const FALHAS_PARA_CAIR = 3;
const MIN_PARA_CAIR_MS = 5 * 60000;

const _fontes = {};
let _alertar = null;   // async ({ nivel, chave, titulo, corpo, origem }) => void

/** Liga o aviso ao grupo do operador (server.js passa registrarAlerta). */
export function definirAlertaFontes(fn) { _alertar = typeof fn === 'function' ? fn : null; }

function estado(fonte) {
  return _fontes[fonte] || (_fontes[fonte] = {
    fonte, fora: false, falhasSeguidas: 0, primeiraFalhaEm: null, ultimaFalhaEm: null,
    ultimoErro: null, ultimoOkEm: null, caiuEm: null, voltouEm: null, okTotal: 0, falhasTotal: 0,
  });
}

const fmtHora = ts => new Date(ts).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo',
  day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function avisar(a) {
  if (!_alertar) return;
  Promise.resolve().then(() => _alertar(a)).catch(e => console.warn('[FONTES] Falha ao avisar o operador:', e.message));
}

/** A fonte respondeu (inclusive "produto nao encontrado"). */
export function registrarOkFonte(fonte, { nome = fonte } = {}) {
  const s = estado(fonte);
  s.okTotal++;
  s.ultimoOkEm = Date.now();
  s.falhasSeguidas = 0;
  s.primeiraFalhaEm = null;
  if (s.fora) {
    s.fora = false;
    s.voltouEm = Date.now();
    const durMin = s.caiuEm ? Math.round((s.voltouEm - s.caiuEm) / 60000) : null;
    console.log('[FONTES] ' + nome + ' voltou' + (durMin !== null ? ' (fora por ~' + durMin + ' min)' : ''));
    avisar({ nivel: 'atencao', origem: 'precos', chave: 'fonte:' + fonte + ':voltou', janelaMs: 0,
      titulo: nome + ' voltou a responder',
      corpo: '✅ *' + nome + ' voltou a responder*\n\n'
        + (durMin !== null ? 'Ficou fora por cerca de ' + durMin + ' min (desde ' + fmtHora(s.caiuEm) + ').\n' : '')
        + 'O histórico de preço desta fonte volta a ser usado no julgamento das ofertas.' });
  }
}

/**
 * A fonte falhou. `grave` = falha que nao se resolve sozinha (chave recusada,
 * assinatura vencida): avisa ja na primeira.
 */
export function registrarFalhaFonte(fonte, erro, { nome = fonte, grave = false, efeito = '' } = {}) {
  const s = estado(fonte);
  const agora = Date.now();
  s.falhasTotal++;
  s.falhasSeguidas++;
  s.primeiraFalhaEm = s.primeiraFalhaEm || agora;
  s.ultimaFalhaEm = agora;
  s.ultimoErro = String(erro?.message || erro || 'erro').slice(0, 200);
  if (s.fora) return;
  const caiu = grave || (s.falhasSeguidas >= FALHAS_PARA_CAIR && agora - s.primeiraFalhaEm >= MIN_PARA_CAIR_MS);
  if (!caiu) return;
  s.fora = true;
  s.caiuEm = s.primeiraFalhaEm;
  console.error('[FONTES] ' + nome + ' caiu — ' + s.falhasSeguidas + ' falha(s) seguida(s): ' + s.ultimoErro);
  avisar({ nivel: 'critico', origem: 'precos', chave: 'fonte:' + fonte + ':caiu', janelaMs: 0,
    titulo: nome + ' fora do ar',
    corpo: '⚠️ *' + nome + ' fora do ar*\n\n'
      + 'Falhando desde ' + fmtHora(s.primeiraFalhaEm) + ' (' + s.falhasSeguidas + ' tentativa(s) seguida(s)).\n'
      + 'Erro: ' + s.ultimoErro + '\n\n'
      + 'As ofertas *continuam saindo normalmente*' + (efeito ? ', ' + efeito : '') + '.\n'
      + 'Aviso de novo aqui quando ela voltar.' });
}

/** Fonte marcada como fora: quem chama nao deve esperar por ela. */
export function fonteFora(fonte) { return !!_fontes[fonte]?.fora; }

export function estadoFontes() {
  const out = {};
  for (const [k, s] of Object.entries(_fontes)) {
    out[k] = { ...s,
      primeiraFalhaEm: s.primeiraFalhaEm ? new Date(s.primeiraFalhaEm).toISOString() : null,
      ultimaFalhaEm: s.ultimaFalhaEm ? new Date(s.ultimaFalhaEm).toISOString() : null,
      ultimoOkEm: s.ultimoOkEm ? new Date(s.ultimoOkEm).toISOString() : null,
      caiuEm: s.caiuEm ? new Date(s.caiuEm).toISOString() : null,
      voltouEm: s.voltouEm ? new Date(s.voltouEm).toISOString() : null };
  }
  return out;
}

/**
 * Espera `promessa` no maximo `ms`. Estourou o prazo: devolve `padrao` e a
 * promessa segue em segundo plano (o resultado ainda e aproveitado por quem a
 * criou). Nunca lanca.
 */
export async function comPrazo(promessa, ms, padrao = null) {
  let t;
  const prazo = new Promise(r => { t = setTimeout(() => r(padrao), ms); });
  try { return await Promise.race([Promise.resolve(promessa).catch(() => padrao), prazo]); }
  finally { clearTimeout(t); }
}
