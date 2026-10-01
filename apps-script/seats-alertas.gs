/**
 * Alertas Seats.aero → WhatsApp
 *
 * Roda na conta Gmail que recebe os alertas (script.google.com → Novo projeto).
 * A cada 5 minutos lê os e-mails novos de alerts@seats.aero e manda para o
 * baileys-server, que publica um resumo no grupo "Alertas Seats.aero".
 *
 * Instalação (uma vez só):
 *   1. Cole este arquivo inteiro no editor e preencha SEGREDO (o mesmo valor da
 *      variável SEATS_ALERTA_SEGREDO do baileys-server no Railway).
 *   2. Escolha a função "instalar" no menu de cima e clique em Executar.
 *      Autorize o acesso ao Gmail e a serviços externos quando o Google pedir.
 *   Pronto: o gatilho de 5 min fica criado e a primeira leitura já acontece.
 *
 * Controle de "já lido": guardado por e-mail nas propriedades do script (não
 * por marcador de conversa, porque o Gmail junta vários alertas na mesma
 * conversa e um marcador esconderia os próximos). Um e-mail só conta como lido
 * quando o servidor confirma; se o Railway estiver fora, tenta de novo depois.
 */

const SERVIDOR  = 'https://baileys-server-production-ebfe.up.railway.app/seats-alertas/email';
const SEGREDO   = 'COLE_AQUI_O_SEGREDO';
const BUSCA     = 'from:alerts@seats.aero newer_than:2d';
const LOTE      = 10;      // e-mails por chamada ao servidor
const MAX_IDS   = 400;     // ids lembrados (cabe no limite de 9 KB da propriedade)
const PROP_IDS  = 'seats_ids_processados';

function instalar() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'verificarSeatsAlertas')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('verificarSeatsAlertas').timeBased().everyMinutes(5).create();
  verificarSeatsAlertas();
}

function verificarSeatsAlertas() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;               // rodada anterior ainda em curso
  try {
    const props = PropertiesService.getScriptProperties();
    const lidos = JSON.parse(props.getProperty(PROP_IDS) || '[]');
    const vistos = new Set(lidos);

    const novos = [];
    GmailApp.search(BUSCA, 0, 30).forEach(thread => {
      thread.getMessages().forEach(msg => {
        if (vistos.has(msg.getId())) return;
        if (!/alerts@seats\.aero/i.test(msg.getFrom())) return;
        novos.push(msg);
      });
    });
    if (!novos.length) return;
    novos.sort((a, b) => a.getDate() - b.getDate());

    for (let i = 0; i < novos.length; i += LOTE) {
      const lote = novos.slice(i, i + LOTE).map(msg => ({
        id:     msg.getId(),
        assunto: msg.getSubject(),
        data:   msg.getDate().toISOString(),
        html:   String(msg.getBody() || '').slice(0, 150000),
        texto:  String(msg.getPlainBody() || '').slice(0, 20000),
      }));
      const resp = UrlFetchApp.fetch(SERVIDOR, {
        method: 'post',
        contentType: 'application/json',
        headers: { 'X-Seats-Segredo': SEGREDO },
        payload: JSON.stringify({ emails: lote }),
        muteHttpExceptions: true,
      });
      const codigo = resp.getResponseCode();
      let corpo = {};
      try { corpo = JSON.parse(resp.getContentText()); } catch (e) {}
      if (codigo !== 200 || !corpo.ok) {
        console.warn('Servidor recusou o lote (' + codigo + '): ' + (corpo.erro || resp.getContentText().slice(0, 200)));
        break;                                   // tenta de novo na próxima rodada
      }
      (corpo.processados || []).forEach(id => { if (!vistos.has(id)) { vistos.add(id); lidos.push(id); } });
      props.setProperty(PROP_IDS, JSON.stringify(lidos.slice(-MAX_IDS)));
      console.log('Lote ok: ' + corpo.enviados + ' enviado(s), ' + corpo.duplicados + ' repetido(s).');
    }
  } finally {
    lock.releaseLock();
  }
}
