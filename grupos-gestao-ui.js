// grupos-gestao-ui.js — interface de administracao de grupos, servida pelo
// baileys-server em GET /grupos-gestao/ui.js e carregada sob demanda pelo
// gestor-cdv (operacao "cdv") e pelo painel Tica Promos (operacao "tsp").
// Uma implementacao so para as duas telas. Toda regra de seguranca mora no
// servidor; aqui e so a tela.
(function () {
  'use strict';
  if (window.GG && window.GG.versao) return;

  var CSS = ''
    + '.gg{font-size:13.5px;line-height:1.45;color:inherit}'
    + '.gg *{box-sizing:border-box}'
    + '.gg-card{border:1px solid rgba(127,127,127,.25);border-radius:12px;padding:14px;margin:0 0 14px}'
    + '.gg-tit{font-weight:700;font-size:14px;margin:0 0 8px}'
    + '.gg-ajuda{font-size:12.5px;opacity:.72;margin:0 0 10px}'
    + '.gg-linha{display:flex;gap:8px;flex-wrap:wrap;align-items:center}'
    + '.gg-campo{display:flex;flex-direction:column;gap:4px;margin:0 0 10px;flex:1;min-width:200px}'
    + '.gg-campo label{font-size:12px;opacity:.75;font-weight:600}'
    + '.gg input[type=text],.gg input[type=search],.gg select,.gg textarea{width:100%;padding:9px 10px;border-radius:8px;'
    +   'border:1px solid rgba(127,127,127,.35);background:rgba(127,127,127,.08);color:inherit;font:inherit}'
    + '.gg select option{color:#111;background:#fff}'
    + '.gg textarea{min-height:110px;resize:vertical}'
    + '.gg-btn{padding:8px 12px;border-radius:8px;border:1px solid rgba(127,127,127,.35);background:rgba(127,127,127,.12);'
    +   'color:inherit;font:inherit;font-size:12.5px;cursor:pointer;white-space:nowrap}'
    + '.gg-btn:hover{background:rgba(127,127,127,.22)}'
    + '.gg-btn:disabled{opacity:.45;cursor:not-allowed}'
    + '.gg-btn.pri{background:#2f6fed;border-color:#2f6fed;color:#fff}'
    + '.gg-btn.perigo{border-color:rgba(229,72,77,.6);color:#ff8a8d}'
    + '.gg-btn.mini{padding:4px 8px;font-size:11.5px}'
    + '.gg-estado{font-size:12.5px;opacity:.8;margin:6px 0}'
    + '.gg-ok{color:#3ddc84}.gg-erro{color:#ff8a8d}.gg-aviso{color:#ffc46b}'
    + '.gg-lista{max-height:260px;overflow:auto;border:1px solid rgba(127,127,127,.2);border-radius:8px;padding:4px 8px;margin:6px 0 10px}'
    + '.gg-item{display:flex;gap:8px;align-items:center;padding:5px 0;border-bottom:1px solid rgba(127,127,127,.12)}'
    + '.gg-item:last-child{border-bottom:0}'
    + '.gg-item .gg-nome{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}'
    + '.gg-sub{font-size:11px;opacity:.6;word-break:break-all}'
    + '.gg-selo{display:inline-block;font-size:10.5px;padding:1px 6px;border-radius:99px;margin-left:6px;border:1px solid rgba(127,127,127,.35);opacity:.9}'
    + '.gg-selo.adm{border-color:#2f6fed;color:#7aa5ff}.gg-selo.cri{border-color:#b58cff;color:#c9adff}.gg-selo.nos{border-color:#3ddc84;color:#3ddc84}'
    + '.gg-tarefa{border:1px solid rgba(47,111,237,.5);background:rgba(47,111,237,.08)}'
    + '.gg-res{font-size:12px;padding:4px 0;border-bottom:1px solid rgba(127,127,127,.12)}'
    + '.gg-res a{color:#7aa5ff;word-break:break-all}'
    + '.gg-cont{font-size:11.5px;opacity:.6;text-align:right}'
    + '.gg-foto{display:flex;gap:10px;align-items:center;margin:0 0 10px}'
    + '.gg-foto img{width:56px;height:56px;border-radius:50%;object-fit:cover;border:1px solid rgba(127,127,127,.35)}'
    + '.gg-plano{border:1px dashed rgba(127,127,127,.4);border-radius:8px;padding:10px;margin:10px 0}'
    + '.gg-plano div{padding:2px 0}';

  function injetarCss() {
    if (document.getElementById('gg-css')) return;
    var s = document.createElement('style');
    s.id = 'gg-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function digitos(v) { return String(v || '').replace(/\D/g, ''); }
  function telNormal(v) {
    var d = digitos(v);
    if (d.length === 10 || d.length === 11) d = '55' + d;
    return d;
  }
  function telFmt(d) {
    d = digitos(d);
    var m = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(d);
    return m ? '+55 ' + m[1] + ' ' + m[2] + '-' + m[3] : (d ? '+' + d : '');
  }
  function hora(iso) {
    try { return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; }
  }
  var ROT_ACAO = { add: 'Incluir', remove: 'Excluir', promote: 'Tornar admin', demote: 'Tirar admin',
    nome: 'Trocar nome', descricao: 'Trocar descrição', 'nome+descricao': 'Trocar nome e descrição',
    criar: 'Criar grupo', foto: 'Trocar foto' };

  // Le a imagem escolhida e reduz no navegador (lado maior 1024) antes de
  // mandar — o servidor ainda recorta em 640x640 para a foto do grupo.
  function lerImagem(arquivo) {
    return new Promise(function (ok, erro) {
      if (!arquivo) return ok(null);
      if (!/^image\/(png|jpe?g|webp)$/i.test(arquivo.type)) return erro(new Error('use uma imagem JPG, PNG ou WEBP'));
      var fr = new FileReader();
      fr.onerror = function () { erro(new Error('não consegui ler o arquivo')); };
      fr.onload = function () {
        var img = new Image();
        img.onerror = function () { erro(new Error('imagem inválida')); };
        img.onload = function () {
          var k = Math.min(1, 1024 / Math.max(img.width, img.height));
          var cv = document.createElement('canvas');
          cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
          var cx = cv.getContext('2d');
          cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height);
          cx.drawImage(img, 0, 0, cv.width, cv.height);
          ok(cv.toDataURL('image/jpeg', 0.9));
        };
        img.src = fr.result;
      };
      fr.readAsDataURL(arquivo);
    });
  }
  var COR_EST = { ok: 'gg-ok', pulado: '', convite: 'gg-aviso', bloqueado: 'gg-erro', falha: 'gg-erro' };

  function Tela(el, opt) {
    this.el = el;
    this.server = String(opt.server || '').replace(/\/+$/, '');
    this.op = opt.operacao;
    this.grupos = [];
    this.contas = [];
    this.sel = null;
    this.membros = [];
    this.marcados = {};
    this.descMarcados = {};
    this.todos = false;
    this.tarefaId = null;
    this.timer = null;
    this.contatoOk = null;
    this.novos = [];          // participantes do grupo novo: { telefone, admin }
    this.fotoNova = null;     // data URL da foto do grupo novo
    this.fotoTroca = null;    // data URL da foto para o grupo selecionado
    this.planoCriar = null;   // corpo revisado, pronto para confirmar
    this.render();
    this.carregar(false);
    this.retomarTarefa();
  }

  Tela.prototype.api = async function (caminho, opcoes) {
    var r = await fetch(this.server + caminho, Object.assign({ cache: 'no-cache' }, opcoes || {}));
    var j = null;
    try { j = await r.json(); } catch (e) { throw new Error('resposta inválida do servidor (' + r.status + ')'); }
    if (!r.ok || !j.ok) { var er = new Error((j && j.erro) || ('erro ' + r.status)); er.dados = j; er.status = r.status; throw er; }
    return j;
  };

  Tela.prototype.$ = function (sel) { return this.el.querySelector(sel); };

  Tela.prototype.render = function () {
    var me = this;
    var id = 'gg-' + me.op;
    me.el.innerHTML = ''
      + '<div class="gg" id="' + id + '">'
      +   '<div class="gg-card gg-tarefa" data-r="tarefa" style="display:none"></div>'
      +   '<div class="gg-card">'
      +     '<div class="gg-tit">🆕 Criar grupo</div>'
      +     '<div class="gg-linha">'
      +       '<div class="gg-campo"><label>Conta que cria (fica como criadora)</label><select data-r="cr-conta"></select></div>'
      +       '<div class="gg-campo"><label>Nome do grupo</label><input type="text" data-r="cr-nome" maxlength="100"/></div>'
      +     '</div>'
      +     '<div class="gg-foto"><img data-r="cr-foto-ver" alt="" style="display:none"/>'
      +       '<div class="gg-campo" style="margin:0"><label>Foto do grupo (opcional)</label><input type="file" accept="image/jpeg,image/png,image/webp" data-r="cr-foto"/></div></div>'
      +     '<div class="gg-campo"><label>Descrição (opcional) <span data-r="cr-desc-cont"></span></label><textarea data-r="cr-desc" maxlength="2048"></textarea></div>'
      +     '<label class="gg-ajuda" style="display:flex;gap:6px;align-items:center;margin:0 0 4px"><input type="checkbox" data-r="cr-anuncio"/> Só admins enviam mensagens</label>'
      +     '<label class="gg-ajuda" style="display:flex;gap:6px;align-items:center"><input type="checkbox" data-r="cr-trava"/> Só admins editam nome, foto e descrição</label>'
      +     '<p class="gg-ajuda" style="margin-top:8px"><b>Números da casa</b> que entram e viram admin (sem trava de mensagem):</p>'
      +     '<div class="gg-lista" data-r="cr-casa" style="max-height:160px"></div>'
      +     '<p class="gg-ajuda"><b>Participantes</b> — com DDI e DDD. Entra direto quem mandou mensagem nas últimas 24h para a conta que cria '
      +       'ou para um número da casa marcado acima; os demais recebem o link de convite na tela.</p>'
      +     '<div class="gg-linha" style="align-items:flex-end">'
      +       '<div class="gg-campo"><label>Telefone</label><input type="text" data-r="cr-tel" placeholder="55 31 99999-8888" autocomplete="off"/></div>'
      +       '<label class="gg-ajuda" style="display:flex;gap:6px;align-items:center;margin-bottom:18px"><input type="checkbox" data-r="cr-tel-adm"/> admin</label>'
      +       '<button class="gg-btn" data-a="cr-add" style="margin-bottom:10px">➕ Adicionar</button>'
      +     '</div>'
      +     '<div class="gg-lista" data-r="cr-parts" style="max-height:200px"></div>'
      +     '<button class="gg-btn pri" data-a="cr-revisar">🔎 Revisar</button>'
      +     '<div data-r="cr-plano"></div>'
      +   '</div>'

      +   '<div class="gg-card">'
      +     '<div class="gg-linha">'
      +       '<div class="gg-campo" style="margin:0"><label>Grupo</label><select data-r="grupo"></select></div>'
      +       '<button class="gg-btn" data-a="atualizar" style="align-self:flex-end">🔄 Atualizar</button>'
      +     '</div>'
      +     '<label class="gg-ajuda" style="display:flex;gap:6px;align-items:center;margin:8px 0 0">'
      +       '<input type="checkbox" data-r="todos"/> Mostrar todos os grupos em que um número nosso é admin</label>'
      +     '<div class="gg-estado" data-r="estado">Carregando grupos…</div>'
      +   '</div>'

      +   '<div class="gg-card">'
      +     '<div class="gg-tit">✏️ Nome, foto e descrição</div>'
      +     '<div class="gg-foto"><img data-r="tr-foto-ver" alt="" style="display:none"/>'
      +       '<div class="gg-campo" style="margin:0"><label>Nova foto do grupo</label><input type="file" accept="image/jpeg,image/png,image/webp" data-r="tr-foto"/></div>'
      +       '<button class="gg-btn pri" data-a="salvar-foto" style="align-self:flex-end">Trocar foto</button></div>'
      +     '<div class="gg-linha" style="align-items:flex-end">'
      +       '<div class="gg-campo"><label>Nome do grupo</label><input type="text" data-r="nome" maxlength="100"/></div>'
      +       '<button class="gg-btn pri" data-a="salvar-nome" style="margin-bottom:10px">Salvar nome</button>'
      +     '</div>'
      +     '<div class="gg-campo"><label>Descrição <span data-r="desc-cont"></span></label><textarea data-r="desc" maxlength="2048"></textarea></div>'
      +     '<p class="gg-ajuda">Aplicar a mesma descrição também em outros grupos (opcional):</p>'
      +     '<div class="gg-linha"><button class="gg-btn mini" data-a="desc-todos">Marcar todos</button>'
      +       '<button class="gg-btn mini" data-a="desc-nenhum">Desmarcar</button></div>'
      +     '<div class="gg-lista" data-r="desc-lista"></div>'
      +     '<button class="gg-btn pri" data-a="salvar-desc">Salvar descrição</button>'
      +     '<p class="gg-ajuda" style="margin-top:8px">Cada alteração avisa o grupo inteiro. Em vários grupos, roda um por vez com pausa de 30–60s.</p>'
      +   '</div>'

      +   '<div class="gg-card">'
      +     '<div class="gg-tit">📱 Por número</div>'
      +     '<div class="gg-linha" style="align-items:flex-end">'
      +       '<div class="gg-campo"><label>Telefone — com DDI e DDD</label><input type="text" data-r="tel" placeholder="55 31 99999-8888" autocomplete="off"/></div>'
      +       '<button class="gg-btn" data-a="verificar" style="margin-bottom:10px">✉️ Verificar mensagem</button>'
      +     '</div>'
      +     '<div class="gg-estado" data-r="contato"></div>'
      +     '<p class="gg-ajuda">Grupos onde aplicar:</p>'
      +     '<div class="gg-linha"><button class="gg-btn mini" data-a="num-todos">Marcar todos</button>'
      +       '<button class="gg-btn mini" data-a="num-nenhum">Desmarcar</button></div>'
      +     '<div class="gg-lista" data-r="num-lista"></div>'
      +     '<div class="gg-linha">'
      +       '<button class="gg-btn pri" data-a="num-add" disabled>➕ Incluir</button>'
      +       '<button class="gg-btn perigo" data-a="num-remove">➖ Excluir</button>'
      +       '<button class="gg-btn" data-a="num-promote">⭐ Tornar admin</button>'
      +       '<button class="gg-btn" data-a="num-demote">↩️ Tirar admin</button>'
      +     '</div>'
      +     '<p class="gg-ajuda" style="margin-top:8px">Para <b>incluir</b>: peça para a pessoa salvar o número que vai adicioná-la e mandar uma mensagem. '
      +       'Depois clique em Verificar. Sem essa mensagem o servidor recusa a inclusão.</p>'
      +   '</div>'

      +   '<div class="gg-card">'
      +     '<div class="gg-linha" style="justify-content:space-between">'
      +       '<div class="gg-tit" style="margin:0">👥 Membros <span data-r="mem-total"></span></div>'
      +       '<button class="gg-btn mini" data-a="mem-atualizar">🔄 Recarregar</button>'
      +     '</div>'
      +     '<div class="gg-campo" style="margin:10px 0 6px"><input type="search" data-r="mem-filtro" placeholder="Filtrar por número"/></div>'
      +     '<div data-r="membros" class="gg-estado">Escolha um grupo.</div>'
      +   '</div>'
      + '</div>';

    me.$('[data-r=grupo]').addEventListener('change', function () { me.escolher(this.value); });
    me.$('[data-r=todos]').addEventListener('change', function () { me.todos = this.checked; me.carregar(false); });
    me.$('[data-r=desc]').addEventListener('input', function () { me.contarDesc(); });
    me.$('[data-r=mem-filtro]').addEventListener('input', function () { me.renderMembros(); });
    me.$('[data-r=tel]').addEventListener('input', function () { me.contatoOk = null; me.pintarContato(null); });
    me.$('[data-r=cr-desc]').addEventListener('input', function () { me.$('[data-r=cr-desc-cont]').textContent = '(' + this.value.length + '/2048)'; me.descartarPlano(); });
    me.$('[data-r=cr-nome]').addEventListener('input', function () { me.descartarPlano(); });
    me.$('[data-r=cr-conta]').addEventListener('change', function () { me.renderCasa(); me.descartarPlano(); });
    me.$('[data-r=cr-tel]').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); me.addNovo(); } });
    me.$('[data-r=cr-foto]').addEventListener('change', function () { me.escolherFoto(this, 'cr'); });
    me.$('[data-r=tr-foto]').addEventListener('change', function () { me.escolherFoto(this, 'tr'); });
    me.renderNovos();
    me.el.addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-a]');
      if (!b || !me.el.contains(b)) return;
      me.clique(b.getAttribute('data-a'), b);
    });
    me.el.addEventListener('change', function (ev) {
      var t = ev.target;
      if (t.matches('[data-desc]')) me.descMarcados[t.getAttribute('data-desc')] = t.checked;
      if (t.matches('[data-num]')) me.marcados[t.getAttribute('data-num')] = t.checked;
      if (t.matches('[data-casa]') || t.matches('[data-r=cr-anuncio]') || t.matches('[data-r=cr-trava]')) me.descartarPlano();
      if (t.matches('[data-novo-adm]')) { var n = me.novos[+t.getAttribute('data-novo-adm')]; if (n) n.admin = t.checked; me.descartarPlano(); }
    });
  };

  Tela.prototype.clique = function (a, b) {
    var me = this;
    if (a === 'atualizar') return me.carregar(true);
    if (a === 'salvar-nome') return me.salvarNome();
    if (a === 'salvar-desc') return me.salvarDesc();
    if (a === 'desc-todos' || a === 'desc-nenhum') { me.grupos.forEach(function (g) { if (!g.bloqueado) me.descMarcados[g.jid] = a === 'desc-todos'; }); return me.renderListas(); }
    if (a === 'num-todos' || a === 'num-nenhum') { me.grupos.forEach(function (g) { if (!g.bloqueado) me.marcados[g.jid] = a === 'num-todos'; }); return me.renderListas(); }
    if (a === 'verificar') return me.verificar();
    if (a.indexOf('num-') === 0) return me.porNumero(a.slice(4));
    if (a === 'mem-atualizar') return me.carregarMembros(true);
    if (a === 'mem-acao') return me.acaoMembro(b.getAttribute('data-acao'), b.getAttribute('data-id'), b.getAttribute('data-rot'));
    if (a === 'salvar-foto') return me.salvarFoto();
    if (a === 'cr-add') return me.addNovo();
    if (a === 'cr-tirar') { me.novos.splice(+b.getAttribute('data-i'), 1); me.descartarPlano(); return me.renderNovos(); }
    if (a === 'cr-revisar') return me.revisarCriar();
    if (a === 'cr-confirmar') return me.confirmarCriar();
    if (a === 'copiar') { try { navigator.clipboard.writeText(b.getAttribute('data-link')); b.textContent = 'Copiado'; } catch (e) {} }
  };

  Tela.prototype.carregar = async function (forcar) {
    var me = this;
    var est = me.$('[data-r=estado]');
    est.className = 'gg-estado';
    est.textContent = 'Carregando grupos…';
    try {
      var j = await me.api('/grupos-gestao/grupos?operacao=' + me.op + (me.todos ? '&todos=1' : '') + (forcar ? '&forcar=1' : '') + '&t=' + Date.now());
      me.grupos = j.grupos || [];
      me.contas = j.contas || [];
      var bloq = me.grupos.filter(function (g) { return g.bloqueado; }).length;
      est.textContent = me.grupos.length + ' grupo(s)' + (bloq ? ' — ' + bloq + ' sem número nosso como admin' : '')
        + '. Contas conectadas: ' + me.contas.map(function (c) { return c.id + (c.numero ? ' (' + telFmt(c.numero) + ')' : ''); }).join(', ') + '.';
      me.renderCasa();
      var sel = me.$('[data-r=grupo]');
      sel.innerHTML = me.grupos.map(function (g) {
        return '<option value="' + esc(g.jid) + '">' + esc(g.nome || g.jid) + (g.bloqueado ? ' — sem admin nosso' : '') + '</option>';
      }).join('');
      if (!me.grupos.length) { sel.innerHTML = '<option value="">Nenhum grupo</option>'; }
      var alvo = me.sel && me.grupos.some(function (g) { return g.jid === me.sel; }) ? me.sel : (me.grupos[0] && me.grupos[0].jid);
      if (alvo) { sel.value = alvo; me.escolher(alvo, forcar); }
      me.renderListas();
    } catch (e) {
      est.className = 'gg-estado gg-erro';
      est.textContent = 'Não consegui carregar: ' + e.message;
    }
  };

  Tela.prototype.grupo = function (jid) {
    for (var i = 0; i < this.grupos.length; i++) if (this.grupos[i].jid === jid) return this.grupos[i];
    return null;
  };

  Tela.prototype.escolher = function (jid, forcar) {
    var me = this;
    var trocou = me.sel !== jid;
    me.sel = jid;
    var g = me.grupo(jid);
    me.$('[data-r=nome]').value = g ? (g.nome || '') : '';
    me.$('[data-r=desc]').value = g ? (g.descricao || '') : '';
    me.contarDesc();
    if (trocou) {
      me.marcados = {}; me.descMarcados = {};
      if (g && !g.bloqueado) me.marcados[jid] = true;
      me.renderListas();
    }
    me.carregarMembros(forcar);
  };

  Tela.prototype.contarDesc = function () {
    var n = this.$('[data-r=desc]').value.length;
    this.$('[data-r=desc-cont]').textContent = '(' + n + '/2048)';
  };

  Tela.prototype.renderListas = function () {
    var me = this;
    function lista(attr, marcados, excluirSel) {
      return me.grupos.map(function (g) {
        if (excluirSel && g.jid === me.sel) return '';
        var off = g.bloqueado;
        return '<label class="gg-item"><input type="checkbox" ' + attr + '="' + esc(g.jid) + '"' + (marcados[g.jid] && !off ? ' checked' : '') + (off ? ' disabled' : '') + '/>'
          + '<span class="gg-nome">' + esc(g.nome || g.jid)
          + (off ? ' <span class="gg-selo">sem admin nosso</span>' : ' <span class="gg-sub">' + esc((g.executores || []).join(', ')) + ' • ' + g.membros + ' membros</span>')
          + '</span></label>';
      }).join('') || '<div class="gg-estado">Nenhum grupo.</div>';
    }
    me.$('[data-r=desc-lista]').innerHTML = lista('data-desc', me.descMarcados, true);
    me.$('[data-r=num-lista]').innerHTML = lista('data-num', me.marcados, false);
  };

  Tela.prototype.carregarMembros = async function (forcar) {
    var me = this;
    var alvo = me.$('[data-r=membros]');
    if (!me.sel) { alvo.textContent = 'Escolha um grupo.'; return; }
    var jid = me.sel;
    alvo.className = 'gg-estado';
    alvo.textContent = 'Carregando membros…';
    try {
      var j = await me.api('/grupos-gestao/membros?jid=' + encodeURIComponent(jid) + (forcar ? '&forcar=1' : '') + '&t=' + Date.now());
      if (me.sel !== jid) return;
      me.membros = j.membros || [];
      me.$('[data-r=mem-total]').textContent = '(' + me.membros.length + ')';
      alvo.className = '';
      me.renderMembros();
    } catch (e) {
      if (me.sel !== jid) return;
      me.membros = [];
      me.$('[data-r=mem-total]').textContent = '';
      alvo.className = 'gg-estado gg-erro';
      alvo.textContent = 'Não consegui carregar os membros: ' + e.message;
    }
  };

  Tela.prototype.renderMembros = function () {
    var me = this;
    var alvo = me.$('[data-r=membros]');
    if (!me.membros.length) return;
    var f = digitos(me.$('[data-r=mem-filtro]').value);
    var g = me.grupo(me.sel);
    var podeAgir = g && !g.bloqueado;
    var lista = me.membros.filter(function (m) { return !f || String(m.telefone || '').indexOf(f) >= 0 || String(m.lid || '').indexOf(f) >= 0; });
    var LIM = 300;
    var html = lista.slice(0, LIM).map(function (m) {
      var rot = m.telefone ? telFmt(m.telefone) : ('LID ' + (m.lid || m.id));
      var selos = (m.admin === 'superadmin' ? '<span class="gg-selo cri">criador</span>' : m.admin ? '<span class="gg-selo adm">admin</span>' : '')
        + (m.conta ? '<span class="gg-selo nos">' + esc(m.conta) + '</span>' : '');
      var bts = '';
      // Conta nossa fica sem botao: tirar o admin (ou excluir) o proprio executor
      // deixaria o grupo sem ninguem para agir por aqui.
      if (podeAgir && m.admin !== 'superadmin' && !m.conta) {
        bts = (m.admin
            ? '<button class="gg-btn mini" data-a="mem-acao" data-acao="demote" data-id="' + esc(m.id) + '" data-rot="' + esc(rot) + '">Tirar admin</button>'
            : '<button class="gg-btn mini" data-a="mem-acao" data-acao="promote" data-id="' + esc(m.id) + '" data-rot="' + esc(rot) + '">Tornar admin</button>')
          + '<button class="gg-btn mini perigo" data-a="mem-acao" data-acao="remove" data-id="' + esc(m.id) + '" data-rot="' + esc(rot) + '">Excluir</button>';
      }
      return '<div class="gg-item"><span class="gg-nome">' + esc(rot) + selos + '</span>' + bts + '</div>';
    }).join('');
    if (lista.length > LIM) html += '<div class="gg-estado">Mostrando ' + LIM + ' de ' + lista.length + ' — use o filtro.</div>';
    alvo.innerHTML = '<div class="gg-lista" style="max-height:420px">' + (html || '<div class="gg-estado">Nenhum membro com esse filtro.</div>') + '</div>';
  };

  Tela.prototype.pintarContato = function (j, erro) {
    var el = this.$('[data-r=contato]');
    var bt = this.$('[data-a=num-add]');
    if (erro) { el.className = 'gg-estado gg-erro'; el.textContent = erro; bt.disabled = true; return; }
    if (!j) { el.className = 'gg-estado'; el.textContent = ''; bt.disabled = true; return; }
    if (j.recebida) {
      var c = (j.contas || []).filter(function (x) { return x.id === j.conta; })[0];
      el.className = 'gg-estado gg-ok';
      el.textContent = '✓ Mensagem recebida às ' + hora(j.em) + ' pela conta ' + j.conta
        + (c && c.numero ? ' (' + telFmt(c.numero) + ')' : '') + '. A inclusão sai por ela'
        + (c ? ' — ' + c.inclusoesHoje + '/' + j.limiteInclusoesDia + ' inclusões hoje.' : '.');
      bt.disabled = false;
    } else {
      el.className = 'gg-estado gg-aviso';
      el.innerHTML = 'Ainda não chegou mensagem desse número nas últimas ' + j.janelaHoras + 'h. Peça para a pessoa salvar e mandar um "oi" para: '
        + (j.contas || []).map(function (x) { return '<b>' + esc(telFmt(x.numero)) + '</b> (' + esc(x.id) + ')'; }).join(' ou ')
        + '. A inclusão sai pela conta que receber a mensagem, e só nos grupos em que ela é admin.';
      bt.disabled = true;
    }
  };

  Tela.prototype.verificar = async function () {
    var me = this;
    var tel = telNormal(me.$('[data-r=tel]').value);
    if (tel.length < 12) return me.pintarContato(null, 'Informe o telefone com DDI e DDD.');
    me.$('[data-r=contato]').className = 'gg-estado';
    me.$('[data-r=contato]').textContent = 'Verificando…';
    try {
      var j = await me.api('/grupos-gestao/contato?telefone=' + tel + '&t=' + Date.now());
      me.contatoOk = j.recebida ? tel : null;
      me.pintarContato(j);
    } catch (e) { me.pintarContato(null, 'Não consegui verificar: ' + e.message); }
  };

  Tela.prototype.selecionados = function (mapa) {
    var me = this;
    return me.grupos.filter(function (g) { return mapa[g.jid] && !g.bloqueado; }).map(function (g) { return g.jid; });
  };

  Tela.prototype.porNumero = async function (acao) {
    var me = this;
    var tel = telNormal(me.$('[data-r=tel]').value);
    if (tel.length < 12) return me.pintarContato(null, 'Informe o telefone com DDI e DDD.');
    var jids = me.selecionados(me.marcados);
    if (!jids.length) return alert('Marque ao menos um grupo.');
    if (acao === 'add' && me.contatoOk !== tel) return me.pintarContato(null, 'Clique em "Verificar mensagem" antes de incluir.');
    var pausa = acao === 'add' ? 70 : 30;
    var min = Math.max(1, Math.round((jids.length - 1) * pausa / 60));
    if (!confirm(ROT_ACAO[acao] + ' ' + telFmt(tel) + ' em ' + jids.length + ' grupo(s)?\n\nRoda um grupo por vez, com pausa entre eles'
      + (jids.length > 1 ? ' — cerca de ' + min + ' min.' : '.') + ' Você pode fechar a aba: a tarefa continua no servidor.')) return;
    me.iniciarTarefa('/grupos-gestao/participante', { operacao: me.op, acao: acao, telefone: tel, jids: jids });
  };

  Tela.prototype.acaoMembro = function (acao, id, rot) {
    if (!this.sel) return;
    var g = this.grupo(this.sel);
    if (!confirm(ROT_ACAO[acao] + ': ' + rot + '\nGrupo: ' + (g ? g.nome : this.sel) + '?')) return;
    this.iniciarTarefa('/grupos-gestao/participante', { operacao: this.op, acao: acao, participante: id, jids: [this.sel] });
  };

  Tela.prototype.salvarNome = function () {
    var nome = this.$('[data-r=nome]').value.trim();
    var g = this.grupo(this.sel);
    if (!g) return;
    if (!nome) return alert('O nome não pode ficar vazio.');
    if (nome === (g.nome || '')) return alert('O nome está igual ao atual.');
    if (!confirm('Trocar o nome de "' + (g.nome || g.jid) + '" para "' + nome + '"?')) return;
    this.iniciarTarefa('/grupos-gestao/info', { operacao: this.op, jids: [g.jid], nome: nome });
  };

  Tela.prototype.salvarDesc = function () {
    var me = this;
    var desc = me.$('[data-r=desc]').value;
    var g = me.grupo(me.sel);
    if (!g) return;
    var jids = [g.jid].concat(me.selecionados(me.descMarcados).filter(function (j) { return j !== g.jid; }));
    var min = Math.max(1, Math.round((jids.length - 1) * 45 / 60));
    if (!confirm('Atualizar a descrição em ' + jids.length + ' grupo(s)?' + (jids.length > 1 ? '\n\nUm por vez, com pausa — cerca de ' + min + ' min.' : ''))) return;
    me.iniciarTarefa('/grupos-gestao/info', { operacao: me.op, jids: jids, descricao: desc });
  };

  // ── Criar grupo ──────────────────────────────────────────────────────────
  Tela.prototype.contasOrdenadas = function () {
    return this.contas.slice().sort(function (a, b) { return String(a.id).localeCompare(String(b.id), 'pt-BR'); });
  };

  Tela.prototype.renderCasa = function () {
    var me = this;
    var sel = me.$('[data-r=cr-conta]');
    var atual = sel.value;
    var contas = me.contasOrdenadas();
    sel.innerHTML = contas.map(function (c) {
      return '<option value="' + esc(c.id) + '">' + esc(c.id) + (c.numero ? ' — ' + esc(telFmt(c.numero)) : '') + '</option>';
    }).join('') || '<option value="">Nenhuma conta conectada</option>';
    if (atual && contas.some(function (c) { return c.id === atual; })) sel.value = atual;
    var marcadas = {};
    me.el.querySelectorAll('[data-casa]').forEach(function (x) { if (x.checked) marcadas[x.getAttribute('data-casa')] = true; });
    me.$('[data-r=cr-casa]').innerHTML = contas.filter(function (c) { return c.id !== sel.value; }).map(function (c) {
      return '<label class="gg-item"><input type="checkbox" data-casa="' + esc(c.id) + '"' + (marcadas[c.id] ? ' checked' : '') + '/>'
        + '<span class="gg-nome">' + esc(c.id) + ' <span class="gg-sub">' + esc(telFmt(c.numero)) + '</span></span></label>';
    }).join('') || '<div class="gg-estado">Nenhuma outra conta conectada.</div>';
  };

  Tela.prototype.addNovo = function () {
    var inp = this.$('[data-r=cr-tel]');
    var tel = telNormal(inp.value);
    if (tel.length < 12 || tel.length > 15) return alert('Informe o telefone com DDI e DDD.');
    var adm = this.$('[data-r=cr-tel-adm]').checked;
    var ja = this.novos.filter(function (n) { return n.telefone === tel; })[0];
    if (ja) ja.admin = ja.admin || adm; else this.novos.push({ telefone: tel, admin: adm });
    inp.value = ''; this.$('[data-r=cr-tel-adm]').checked = false; inp.focus();
    this.descartarPlano();
    this.renderNovos();
  };

  Tela.prototype.renderNovos = function () {
    this.$('[data-r=cr-parts]').innerHTML = this.novos.map(function (n, i) {
      return '<div class="gg-item"><span class="gg-nome">' + esc(telFmt(n.telefone)) + '</span>'
        + '<label class="gg-ajuda" style="display:flex;gap:4px;align-items:center;margin:0"><input type="checkbox" data-novo-adm="' + i + '"' + (n.admin ? ' checked' : '') + '/> admin</label>'
        + '<button class="gg-btn mini perigo" data-a="cr-tirar" data-i="' + i + '">Tirar</button></div>';
    }).join('') || '<div class="gg-estado">Nenhum participante ainda.</div>';
  };

  Tela.prototype.escolherFoto = async function (inp, qual) {
    var me = this;
    var ver = me.$('[data-r=' + qual + '-foto-ver]');
    try {
      var url = await lerImagem(inp.files && inp.files[0]);
      if (qual === 'cr') { me.fotoNova = url; me.descartarPlano(); } else me.fotoTroca = url;
      ver.src = url || ''; ver.style.display = url ? 'block' : 'none';
    } catch (e) {
      inp.value = '';
      if (qual === 'cr') me.fotoNova = null; else me.fotoTroca = null;
      ver.style.display = 'none';
      alert('Foto: ' + e.message);
    }
  };

  Tela.prototype.corpoCriar = function () {
    var me = this;
    var casa = [];
    me.el.querySelectorAll('[data-casa]').forEach(function (x) { if (x.checked) casa.push(x.getAttribute('data-casa')); });
    return { operacao: me.op, conta: me.$('[data-r=cr-conta]').value, nome: me.$('[data-r=cr-nome]').value.trim(),
      descricao: me.$('[data-r=cr-desc]').value, imagem: me.fotoNova || null,
      participantes: me.novos.slice(), contasCasa: casa,
      soAdminsEnviam: me.$('[data-r=cr-anuncio]').checked, soAdminsEditam: me.$('[data-r=cr-trava]').checked };
  };

  Tela.prototype.descartarPlano = function () {
    if (!this.planoCriar) return;
    this.planoCriar = null;
    this.$('[data-r=cr-plano]').innerHTML = '';
  };

  Tela.prototype.revisarCriar = async function () {
    var me = this;
    var corpo = me.corpoCriar();
    var box = me.$('[data-r=cr-plano]');
    if (!corpo.conta) return alert('Nenhuma conta conectada para criar o grupo.');
    if (!corpo.nome) return alert('Dê um nome ao grupo.');
    var pend = digitos(me.$('[data-r=cr-tel]').value);
    if (pend.length >= 10 && !confirm('O telefone digitado ainda não foi adicionado à lista. Revisar mesmo assim?')) return;
    box.innerHTML = '<div class="gg-estado">Conferindo…</div>';
    try {
      var j = await me.api('/grupos-gestao/criar', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({}, corpo, { simular: true })) });
      var p = j.plano;
      var linhas = [];
      linhas.push('<div><b>' + esc(corpo.nome) + '</b> — criado por <b>' + esc(p.criador.id) + '</b> (' + esc(telFmt(p.criador.numero)) + ')</div>');
      linhas.push('<div>' + (corpo.imagem ? '🖼️ com foto' : 'sem foto') + ' • ' + (corpo.descricao.trim() ? '📝 com descrição' : 'sem descrição')
        + (corpo.soAdminsEnviam ? ' • só admins enviam' : '') + (corpo.soAdminsEditam ? ' • só admins editam' : '') + '</div>');
      p.casa.forEach(function (c) { linhas.push('<div class="gg-ok">⭐ ' + esc(c.id) + ' (' + esc(telFmt(c.numero)) + ') — número da casa, entra como admin</div>'); });
      p.externos.forEach(function (e) {
        linhas.push(e.modo === 'incluir'
          ? '<div class="gg-ok">➕ ' + esc(telFmt(e.telefone)) + (e.admin ? ' ⭐ admin' : '') + ' — entra direto por ' + esc(e.por) + '</div>'
          : '<div class="gg-aviso">🔗 ' + esc(telFmt(e.telefone)) + (e.admin ? ' ⭐ admin' : '') + ' — recebe convite: ' + esc(e.motivo) + '</div>');
      });
      (p.avisos || []).forEach(function (a) { linhas.push('<div class="gg-sub">' + esc(a) + '</div>'); });
      if (!p.casa.length && !p.externos.length) linhas.push('<div class="gg-sub">Sem participantes: o grupo nasce só com a conta que cria.</div>');
      linhas.push('<div class="gg-sub" style="margin-top:6px">Roda em segundo plano, um passo por vez com pausas. Você pode fechar a aba.</div>');
      me.planoCriar = corpo;
      box.innerHTML = '<div class="gg-plano">' + linhas.join('') + '</div><button class="gg-btn pri" data-a="cr-confirmar">✅ Confirmar e criar</button>';
    } catch (e) {
      me.planoCriar = null;
      box.innerHTML = '<div class="gg-estado gg-erro">' + esc(e.message) + '</div>';
    }
  };

  Tela.prototype.confirmarCriar = function () {
    if (!this.planoCriar) return this.revisarCriar();
    var corpo = this.planoCriar;
    this.descartarPlano();
    this.iniciarTarefa('/grupos-gestao/criar', corpo);
  };

  Tela.prototype.limparCriar = function () {
    this.novos = []; this.fotoNova = null; this.planoCriar = null;
    ['cr-nome', 'cr-desc', 'cr-tel', 'cr-foto'].forEach(function (k) { var x = this.$('[data-r=' + k + ']'); if (x) x.value = ''; }, this);
    ['cr-anuncio', 'cr-trava'].forEach(function (k) { this.$('[data-r=' + k + ']').checked = false; }, this);
    this.el.querySelectorAll('[data-casa]').forEach(function (x) { x.checked = false; });
    this.$('[data-r=cr-foto-ver]').style.display = 'none';
    this.$('[data-r=cr-desc-cont]').textContent = '';
    this.$('[data-r=cr-plano]').innerHTML = '';
    this.renderNovos();
  };

  Tela.prototype.salvarFoto = function () {
    var g = this.grupo(this.sel);
    if (!g) return;
    if (!this.fotoTroca) return alert('Escolha a imagem primeiro.');
    if (!confirm('Trocar a foto de "' + (g.nome || g.jid) + '"?')) return;
    this.iniciarTarefa('/grupos-gestao/foto', { operacao: this.op, jids: [g.jid], imagem: this.fotoTroca });
  };

  Tela.prototype.iniciarTarefa = async function (caminho, corpo) {
    var me = this;
    try {
      var j = await me.api(caminho, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
      me.acompanhar(j.jobId);
    } catch (e) {
      if (e.dados && e.dados.jobId) { alert(e.message); return me.acompanhar(e.dados.jobId); }
      if (e.dados && e.dados.codigo === 'sem-mensagem') { me.contatoOk = null; return me.pintarContato({ recebida: false, janelaHoras: 24, contas: e.dados.contas || [] }); }
      alert('Não deu: ' + e.message);
    }
  };

  Tela.prototype.retomarTarefa = async function () {
    try {
      var j = await this.api('/grupos-gestao/tarefa-ativa?t=' + Date.now());
      if (j.tarefa) this.acompanhar(j.tarefa.id);
    } catch (e) {}
  };

  Tela.prototype.acompanhar = function (id) {
    var me = this;
    me.tarefaId = id;
    if (me.timer) clearTimeout(me.timer);
    var passo = async function () {
      if (me.tarefaId !== id) return;
      if (!document.body.contains(me.el)) return;
      try {
        var j = await me.api('/grupos-gestao/tarefa/' + encodeURIComponent(id) + '?t=' + Date.now());
        me.pintarTarefa(j.tarefa);
        if (j.tarefa.estado === 'rodando') { me.timer = setTimeout(passo, 3000); }
        else {
          var t = j.tarefa;
          if (t.tipo === 'criar' && t.grupo && t.grupo.jid && me.ultimoCriado !== t.grupo.jid) {
            // Grupo novo nao e da lista da operacao: liga "todos" e ja seleciona.
            me.ultimoCriado = t.grupo.jid;
            me.todos = true; me.$('[data-r=todos]').checked = true;
            me.sel = t.grupo.jid; me.marcados = {}; me.descMarcados = {};
            me.limparCriar();
          }
          if (t.acao === 'foto' && t.feitos) { me.fotoTroca = null; me.$('[data-r=tr-foto]').value = ''; me.$('[data-r=tr-foto-ver]').style.display = 'none'; }
          me.carregar(true);
        }
      } catch (e) {
        var box = me.$('[data-r=tarefa]');
        box.style.display = 'block';
        box.innerHTML = '<div class="gg-erro">Perdi o acompanhamento da tarefa: ' + esc(e.message) + '</div>';
      }
    };
    passo();
  };

  Tela.prototype.pintarTarefa = function (t) {
    var box = this.$('[data-r=tarefa]');
    box.style.display = 'block';
    var feitos = t.resultados.length;
    var criar = t.tipo === 'criar';
    var cab;
    if (t.estado === 'rodando') {
      cab = '⏳ <b>' + esc(ROT_ACAO[t.acao] || t.acao) + '</b>' + (t.alvo ? ' ' + esc(criar ? '"' + t.alvo + '"' : /^\d+$/.test(t.alvo) ? telFmt(t.alvo) : 'membro') : '')
        + ' — ' + (criar ? Math.min(feitos, t.total) + '/' + t.total + ' passo(s)' : feitos + '/' + t.total + ' grupo(s)')
        + (t.proximaEm ? ' • próximo às ' + hora(t.proximaEm) : t.atual ? ' • agora em ' + esc(t.atual) : '');
    } else if (t.estado === 'erro') {
      cab = '<span class="gg-erro">✗ Tarefa interrompida: ' + esc(t.erro) + '</span>';
    } else {
      cab = '✓ <b>' + esc(ROT_ACAO[t.acao] || t.acao) + '</b> concluído — ' + t.feitos + ' feito(s), ' + t.pulados + ' pulado(s), ' + t.falhas + ' pendência(s).';
    }
    var res = t.resultados.map(function (x) {
      return '<div class="gg-res"><b>' + esc(x.nome || x.jid) + '</b> — <span class="' + (COR_EST[x.estado] || '') + '">' + esc(x.estado) + '</span>: '
        + esc(x.detalhe || '') + (x.por ? ' <span class="gg-sub">(por ' + esc(x.por) + ')</span>' : '')
        + (x.link ? '<div><a href="' + esc(x.link) + '" target="_blank" rel="noopener">' + esc(x.link) + '</a> '
          + '<button class="gg-btn mini" data-a="copiar" data-link="' + esc(x.link) + '">Copiar</button></div>' : '')
        + '</div>';
    }).join('');
    if (criar && t.grupo && t.grupo.link) {
      cab += '<div style="margin-top:4px">Convite do grupo: <a href="' + esc(t.grupo.link) + '" target="_blank" rel="noopener">' + esc(t.grupo.link) + '</a> '
        + '<button class="gg-btn mini" data-a="copiar" data-link="' + esc(t.grupo.link) + '">Copiar</button></div>';
    }
    box.innerHTML = '<div style="margin-bottom:6px">' + cab + '</div>' + res;
  };

  window.GG = {
    versao: 2,
    montar: function (el, opt) {
      if (!el) return null;
      injetarCss();
      if (el._gg && el._gg.op === opt.operacao) {   // reabrir a aba: so atualiza
        el._gg.carregar(false);
        el._gg.retomarTarefa();
        return el._gg;
      }
      el._gg = new Tela(el, opt || {});
      return el._gg;
    },
  };
})();
