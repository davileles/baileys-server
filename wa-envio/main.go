// wa-envio — motor de ENVIO para grupos do WhatsApp usando whatsmeow.
//
// Por que existe: no Baileys, a mensagem de grupo so leva a sender key para os
// aparelhos que o arquivo sender-key-memory-<grupo> diz que ainda nao a tem.
// Quando essa memoria diverge da realidade (membro trocou de aparelho, entrou
// pelo distribuidor, LID x telefone), o aparelho do membro recebe a mensagem
// cifrada com uma chave que ele nunca recebeu: "Aguardando mensagem".
//
// O whatsmeow nao tem essa memoria. Em TODA mensagem de grupo ele cifra a
// SenderKeyDistributionMessage para todos os aparelhos dos participantes
// (send.go: sendGroup -> prepareMessageNode -> encryptMessageForDevices).
// A classe de falha "memoria de sender key dessincronizada" nao existe aqui.
//
// Escopo: so ENVIO (texto, texto com card de link, imagem com legenda) e
// telemetria de retry receipts. Leitura de grupos, radar e toda regra de
// negocio (portao, trilhas, rodape, tag por grupo, marca d'agua, outbox)
// continuam no baileys-server — este servico e so o transporte.
package main

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	_ "image/png"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	_ "time/tzdata"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waCompanionReg"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
	"google.golang.org/protobuf/proto"
	_ "modernc.org/sqlite"
)

var (
	dataDir   = envOr("DATA_DIR", "/data")
	porta     = envOr("PORT", "8080")
	token     = os.Getenv("WA_ENVIO_TOKEN")
	nivelLog  = envOr("WA_LOG_NIVEL", "WARN")
	reContaID = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{1,31}$`)
	tzSP, _   = time.LoadLocation("America/Sao_Paulo")
)

func envOr(k, padrao string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return padrao
}

// ── CONTAS ───────────────────────────────────────────────────────────────────

type Conta struct {
	ID string

	mu        sync.Mutex // protege o ciclo de vida (container/cli/qr)
	envioMu   sync.Mutex // nunca dois SendMessage simultaneos pelo mesmo numero
	container *sqlstore.Container
	cli       *whatsmeow.Client
	qr        string
	qrEm      time.Time
	pareando  bool

	ultimoErro  string
	ultimoEnvio time.Time
	conectadoEm time.Time
	recriadoEm  time.Time
}

var (
	contasMu sync.Mutex
	contas   = map[string]*Conta{}
)

func conta(id string) *Conta {
	contasMu.Lock()
	defer contasMu.Unlock()
	c, ok := contas[id]
	if !ok {
		c = &Conta{ID: id}
		contas[id] = c
	}
	return c
}

func caminhoDB(id string) string { return filepath.Join(dataDir, id+".db") }

func (c *Conta) abrir(ctx context.Context) error {
	if c.cli != nil {
		return nil
	}
	dsn := "file:" + caminhoDB(c.ID) + "?_pragma=foreign_keys(1)&_pragma=busy_timeout(10000)&_pragma=journal_mode(WAL)"
	container, err := sqlstore.New(ctx, "sqlite", dsn, waLog.Stdout("DB:"+c.ID, nivelLog, false))
	if err != nil {
		return fmt.Errorf("abrir banco: %w", err)
	}
	dev, err := container.GetFirstDevice(ctx)
	if err != nil {
		_ = container.Close()
		return fmt.Errorf("ler aparelho: %w", err)
	}
	c.container, c.cli = container, novoCliente(c, dev)
	return nil
}

// novoCliente monta o whatsmeow.Client com a configuracao da conta. Usado na
// abertura e na renovacao de cache (recriarCliente).
func novoCliente(c *Conta, dev *store.Device) *whatsmeow.Client {
	cli := whatsmeow.NewClient(dev, &logConta{base: waLog.Stdout("WM:"+c.ID, nivelLog, false), c: c})
	cli.EnableAutoReconnect = true
	// Retry receipt costuma chegar horas depois (membro offline). O cache em
	// memoria do whatsmeow guarda so 256 mensagens e zera no restart; com o
	// store em banco (7 dias) o reenvio sempre encontra a mensagem original.
	cli.UseRetryMessageStore = true
	// Este aparelho so envia: nao baixa historico no pareamento.
	cli.ManualHistorySyncDownload = true
	cli.PreRetryCallback = func(r *events.Receipt, id types.MessageID, tentativa int, _ *waE2E.Message) bool {
		registrarRetry(c.ID, r, tentativa)
		return true
	}
	cli.AddEventHandler(func(evt any) { c.onEvento(evt) })
	return cli
}

// ── RENOVACAO DE CACHE ───────────────────────────────────────────────────────
// Quando o servidor devolve um participant hash diferente do calculado, parte
// dos aparelhos do grupo nao recebeu a sender key. O whatsmeow descarta o cache
// de PARTICIPANTES do grupo, mas mantem o cache de APARELHOS de cada usuario
// (send.go: "TODO also invalidate device list caches"). Quem trocou/adicionou
// aparelho segue fora da lista nos envios seguintes e pede reenvio a cada oferta.
// Os caches sao privados do Client: a unica forma de zera-los de fora e montar
// um Client novo sobre o mesmo device store (sessoes, chaves e o store de retry
// ficam no banco — nada se perde). Leva ~1s e so acontece nesse aviso.

type logConta struct {
	base waLog.Logger
	c    *Conta
}

func (l *logConta) Warnf(msg string, args ...any) {
	l.base.Warnf(msg, args...)
	if strings.Contains(msg, "different participant list hash") {
		grupo := ""
		if len(args) >= 3 {
			grupo = fmt.Sprint(args[2])
		}
		registrarPhash(l.c.ID, grupo)
		// Assincrono: o aviso sai de dentro do SendMessage, que roda com envioMu
		// travado; recriarCliente espera esse envio terminar.
		go l.c.recriarCliente("participant hash divergente em " + grupo)
	}
}
func (l *logConta) Errorf(msg string, args ...any) { l.base.Errorf(msg, args...) }
func (l *logConta) Infof(msg string, args ...any)  { l.base.Infof(msg, args...) }
func (l *logConta) Debugf(msg string, args ...any) { l.base.Debugf(msg, args...) }
func (l *logConta) Sub(module string) waLog.Logger {
	return &logConta{base: l.base.Sub(module), c: l.c}
}

func (c *Conta) recriarCliente(motivo string) {
	c.envioMu.Lock() // nenhum envio pela metade
	defer c.envioMu.Unlock()

	c.mu.Lock()
	antigo, container := c.cli, c.container
	if antigo == nil || container == nil || time.Since(c.recriadoEm) < 2*time.Minute {
		c.mu.Unlock()
		return
	}
	c.recriadoEm = time.Now()
	c.mu.Unlock()

	inicio := time.Now()
	antigo.Disconnect()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	dev, err := container.GetFirstDevice(ctx)
	if err != nil || dev.ID == nil {
		log.Printf("[CONTA:%s] renovacao de cache abortada (aparelho: %v) — reconectando o cliente antigo", c.ID, err)
		_ = antigo.Connect()
		return
	}
	novo := novoCliente(c, dev)
	c.mu.Lock()
	c.cli = novo
	c.mu.Unlock()
	// Connect que falha nao aciona a auto-reconexao (ela so age depois de uma
	// conexao que caiu): tenta de novo algumas vezes antes de desistir.
	for tentativa := 1; tentativa <= 6; tentativa++ {
		err := novo.Connect()
		if err == nil || novo.IsConnected() {
			break
		}
		log.Printf("[CONTA:%s] renovacao de cache: falha ao conectar (tentativa %d): %v", c.ID, tentativa, err)
		time.Sleep(time.Duration(tentativa) * 5 * time.Second)
	}
	log.Printf("[CONTA:%s] cache de aparelhos renovado em %s (%s)", c.ID, time.Since(inicio).Round(time.Millisecond), motivo)
	registrarEvento(c.ID, "cache-renovado", motivo)
}

func (c *Conta) onEvento(evt any) {
	switch e := evt.(type) {
	case *events.Connected:
		registrarEvento(c.ID, "conectou", "")
		c.mu.Lock()
		c.conectadoEm, c.qr, c.pareando, c.ultimoErro = time.Now(), "", false, ""
		c.mu.Unlock()
		log.Printf("[CONTA:%s] conectada", c.ID)
	case *events.PairSuccess:
		log.Printf("[CONTA:%s] pareada como %s", c.ID, e.ID)
	case *events.LoggedOut:
		log.Printf("[CONTA:%s] DESLOGADA (%v) — precisa parear de novo", c.ID, e.Reason)
		registrarEvento(c.ID, "logout", fmt.Sprint(e.Reason))
		go c.descartar("deslogada — pareie de novo")
	case *events.StreamReplaced:
		// Outra instancia abriu a mesma sessao (deploy com overlap). Sem
		// overlapSeconds=0 no railway.json isto vira loop.
		log.Printf("[CONTA:%s] stream substituido por outra instancia", c.ID)
		registrarEvento(c.ID, "stream-substituido", "")
		c.mu.Lock()
		c.ultimoErro = "sessao aberta em outra instancia"
		c.mu.Unlock()
	case *events.Disconnected:
		log.Printf("[CONTA:%s] desconectada (auto-reconexao ativa)", c.ID)
		registrarEvento(c.ID, "desconectou", "")
	}
}

// descartar fecha a conta e apaga o banco. Usado no logout: as credenciais que
// sobram no disco so servem para impedir um pareamento novo.
func (c *Conta) descartar(motivo string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cli != nil {
		c.cli.Disconnect()
	}
	if c.container != nil {
		_ = c.container.Close()
	}
	c.cli, c.container, c.qr, c.pareando = nil, nil, "", false
	c.ultimoErro = motivo
	for _, suf := range []string{"", "-wal", "-shm"} {
		_ = os.Remove(caminhoDB(c.ID) + suf)
	}
}

// conectar sobe o socket. Sem pareamento, abre o canal de QR (necessario
// tambem para o pareamento por codigo).
func (c *Conta) conectar(ctx context.Context) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.abrir(ctx); err != nil {
		c.ultimoErro = err.Error()
		return err
	}
	if c.cli.IsConnected() {
		return nil
	}
	if c.cli.Store.ID == nil {
		qrChan, err := c.cli.GetQRChannel(context.Background())
		if err != nil {
			return fmt.Errorf("canal de QR: %w", err)
		}
		c.pareando = true
		go func() {
			for item := range qrChan {
				c.mu.Lock()
				switch item.Event {
				case whatsmeow.QRChannelEventCode:
					c.qr, c.qrEm = item.Code, time.Now()
				default:
					c.qr, c.pareando = "", false
					if item.Error != nil {
						c.ultimoErro = item.Error.Error()
					}
					log.Printf("[CONTA:%s] pareamento: %s", c.ID, item.Event)
				}
				c.mu.Unlock()
			}
		}()
	}
	return c.cli.Connect()
}

type estadoConta struct {
	ID          string `json:"id"`
	Conectado   bool   `json:"conectado"`
	Logado      bool   `json:"logado"`
	Pareando    bool   `json:"pareando"`
	Numero      string `json:"numero,omitempty"`
	UltimoEnvio string `json:"ultimoEnvio,omitempty"`
	UltimoErro  string `json:"ultimoErro,omitempty"`
}

func (c *Conta) estado(comNumero bool) estadoConta {
	c.mu.Lock()
	defer c.mu.Unlock()
	e := estadoConta{ID: c.ID, Pareando: c.pareando, UltimoErro: c.ultimoErro}
	if c.cli != nil {
		e.Conectado = c.cli.IsConnected() && c.cli.IsLoggedIn()
		e.Logado = c.cli.Store.ID != nil
		if comNumero && c.cli.Store.ID != nil {
			e.Numero = c.cli.Store.ID.User
		}
	}
	if !c.ultimoEnvio.IsZero() {
		e.UltimoEnvio = c.ultimoEnvio.UTC().Format(time.RFC3339)
	}
	return e
}

func (c *Conta) cliente() *whatsmeow.Client {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.cli
}

// ── ENVIO ────────────────────────────────────────────────────────────────────

type pedidoEnvio struct {
	JID         string `json:"jid"`
	Texto       string `json:"texto"`
	LinkPreview *struct {
		URL         string `json:"url"`
		Titulo      string `json:"titulo"`
		Descricao   string `json:"descricao"`
		ThumbBase64 string `json:"thumbBase64"`
	} `json:"linkPreview"`
	Imagem *struct {
		Base64      string `json:"base64"`
		Mime        string `json:"mime"`
		ThumbBase64 string `json:"thumbBase64"`
	} `json:"imagem"`
}

// erroEnvio carrega a FASE da falha. So "envio" e ambigua (o no pode ter saido
// antes do erro): nas outras, nada chegou ao WhatsApp e o chamador pode tentar
// por outro caminho sem risco de duplicar a mensagem no grupo.
type erroEnvio struct {
	Fase   string
	Status int
	Err    error
}

func (e *erroEnvio) Error() string { return e.Err.Error() }

func (c *Conta) enviar(ctx context.Context, p pedidoEnvio) (whatsmeow.SendResponse, error) {
	// envioMu antes de pegar o cliente: uma renovacao de cache em curso termina
	// primeiro, e o envio usa o Client novo em vez do que acabou de ser fechado.
	c.envioMu.Lock()
	defer c.envioMu.Unlock()
	cli := c.cliente()
	if cli == nil || !cli.IsLoggedIn() {
		return whatsmeow.SendResponse{}, &erroEnvio{"conexao", 503, errors.New("conta nao pareada")}
	}
	if !cli.IsConnected() {
		return whatsmeow.SendResponse{}, &erroEnvio{"conexao", 503, errors.New("conta desconectada")}
	}
	jid, err := types.ParseJID(p.JID)
	if err != nil || jid.User == "" {
		return whatsmeow.SendResponse{}, &erroEnvio{"validacao", 400, fmt.Errorf("jid invalido: %q", p.JID)}
	}

	msg, errMsg := montarMensagem(ctx, cli, p)
	if errMsg != nil {
		return whatsmeow.SendResponse{}, errMsg
	}
	resp, err := cli.SendMessage(ctx, jid, msg)
	if err != nil {
		fase := "preparo"
		if errors.Is(err, whatsmeow.ErrNotConnected) || errors.Is(err, whatsmeow.ErrNotLoggedIn) {
			fase = "conexao"
		} else if strings.Contains(err.Error(), "failed to send message node") || errors.Is(err, context.DeadlineExceeded) {
			fase = "envio"
		}
		return resp, &erroEnvio{fase, 502, err}
	}
	c.mu.Lock()
	c.ultimoEnvio = time.Now()
	c.mu.Unlock()
	return resp, nil
}

func montarMensagem(ctx context.Context, cli *whatsmeow.Client, p pedidoEnvio) (*waE2E.Message, *erroEnvio) {
	if p.Imagem != nil {
		dados, err := base64.StdEncoding.DecodeString(p.Imagem.Base64)
		if err != nil || len(dados) == 0 {
			return nil, &erroEnvio{"validacao", 400, errors.New("imagem base64 invalida")}
		}
		dados, mime, larg, alt, err := normalizarImagem(dados)
		if err != nil {
			return nil, &erroEnvio{"validacao", 400, fmt.Errorf("imagem ilegivel: %w", err)}
		}
		thumb := decodificarOpcional(p.Imagem.ThumbBase64)
		if thumb == nil {
			thumb = gerarMiniatura(dados)
		}
		up, err := cli.Upload(ctx, dados, whatsmeow.MediaImage)
		if err != nil {
			return nil, &erroEnvio{"upload", 502, fmt.Errorf("upload da imagem: %w", err)}
		}
		im := &waE2E.ImageMessage{
			Mimetype:          proto.String(mime),
			URL:               proto.String(up.URL),
			DirectPath:        proto.String(up.DirectPath),
			MediaKey:          up.MediaKey,
			MediaKeyTimestamp: proto.Int64(time.Now().Unix()),
			FileEncSHA256:     up.FileEncSHA256,
			FileSHA256:        up.FileSHA256,
			FileLength:        proto.Uint64(up.FileLength),
			Width:             proto.Uint32(uint32(larg)),
			Height:            proto.Uint32(uint32(alt)),
			JPEGThumbnail:     thumb,
		}
		if p.Texto != "" {
			im.Caption = proto.String(p.Texto)
		}
		return &waE2E.Message{ImageMessage: im}, nil
	}
	if p.Texto == "" {
		return nil, &erroEnvio{"validacao", 400, errors.New("texto vazio")}
	}
	if lp := p.LinkPreview; lp != nil && lp.URL != "" {
		// O card so renderiza se o matchedText aparecer EXATAMENTE no corpo —
		// o baileys-server ja manda a URL como esta no texto (urlNaMensagem).
		ext := &waE2E.ExtendedTextMessage{
			Text:        proto.String(p.Texto),
			MatchedText: proto.String(lp.URL),
			PreviewType: waE2E.ExtendedTextMessage_NONE.Enum(),
		}
		if lp.Titulo != "" {
			ext.Title = proto.String(lp.Titulo)
		}
		if lp.Descricao != "" {
			ext.Description = proto.String(lp.Descricao)
		}
		if t := decodificarOpcional(lp.ThumbBase64); t != nil {
			ext.JPEGThumbnail = t
		}
		return &waE2E.Message{ExtendedTextMessage: ext}, nil
	}
	return &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{Text: proto.String(p.Texto)}}, nil
}

// comNonoDigito: o pareamento por codigo confere o numero COMO APARECE NO
// CELULAR. Contas antigas de celular brasileiro sao guardadas pelo WhatsApp sem
// o 9 (553190110150), e pedir o codigo nesse formato falha com "confira se voce
// inseriu o numero correto". Celular BR = 55 + DDD (sem zero) + 8 digitos
// comecando em 6-9; fixo (2-5) fica como veio.
func comNonoDigito(n string) (string, bool) {
	if len(n) != 12 || !strings.HasPrefix(n, "55") {
		return n, false
	}
	ddd, local := n[2:4], n[4:]
	if ddd[0] == '0' || ddd[1] == '0' || !strings.ContainsRune("6789", rune(local[0])) {
		return n, false
	}
	return "55" + ddd + "9" + local, true
}

func decodificarOpcional(s string) []byte {
	if s == "" {
		return nil
	}
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil || len(b) == 0 {
		return nil
	}
	return b
}

// normalizarImagem garante JPEG ou PNG (webp vira JPEG) e devolve as dimensoes.
func normalizarImagem(dados []byte) ([]byte, string, int, int, error) {
	cfg, formato, err := image.DecodeConfig(bytes.NewReader(dados))
	if err != nil {
		return nil, "", 0, 0, err
	}
	switch formato {
	case "jpeg":
		return dados, "image/jpeg", cfg.Width, cfg.Height, nil
	case "png":
		return dados, "image/png", cfg.Width, cfg.Height, nil
	}
	img, _, err := image.Decode(bytes.NewReader(dados))
	if err != nil {
		return nil, "", 0, 0, err
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 90}); err != nil {
		return nil, "", 0, 0, err
	}
	return buf.Bytes(), "image/jpeg", cfg.Width, cfg.Height, nil
}

// gerarMiniatura: o whatsmeow nao gera o thumb da imagem (o Baileys gerava).
// Sem ele a foto aparece como bloco cinza ate o membro baixar.
func gerarMiniatura(dados []byte) []byte {
	img, _, err := image.Decode(bytes.NewReader(dados))
	if err != nil {
		return nil
	}
	b := img.Bounds()
	const lado = 100
	w, h := b.Dx(), b.Dy()
	if w <= 0 || h <= 0 {
		return nil
	}
	if w >= h {
		h, w = h*lado/w, lado
	} else {
		w, h = w*lado/h, lado
	}
	dst := image.NewRGBA(image.Rect(0, 0, max(w, 1), max(h, 1)))
	draw.ApproxBiLinear.Scale(dst, dst.Bounds(), img, b, draw.Src, nil)
	var buf bytes.Buffer
	if jpeg.Encode(&buf, dst, &jpeg.Options{Quality: 60}) != nil {
		return nil
	}
	return buf.Bytes()
}

// ── TELEMETRIA ───────────────────────────────────────────────────────────────
// Retry receipt de participante de grupo = o aparelho dele nao decifrou a
// mensagem ("Aguardando mensagem"). Ocorrencia = primeiro pedido (tentativa 1)
// de um aparelho para uma mensagem; retries conta todos os pedidos.

type metGrupo struct {
	Envios      int            `json:"envios"`
	Ocorrencias int            `json:"ocorrencias"`
	Retries     int            `json:"retries"`
	Horas       map[string]int `json:"horas,omitempty"` // ocorrencias por hora SP ("00".."23")
	Phash       int            `json:"phash,omitempty"` // avisos de participant hash divergente
}

type metHora struct {
	Envios      int `json:"envios"`
	Falhas      int `json:"falhas"`
	Ocorrencias int `json:"ocorrencias"`
	Retries     int `json:"retries"`
}

type evento struct {
	Em      string `json:"em"`
	Hora    string `json:"hora"`
	Tipo    string `json:"tipo"`
	Detalhe string `json:"detalhe,omitempty"`
}

type metConta struct {
	Envios      int                  `json:"envios"`
	Falhas      int                  `json:"falhas"`
	Ocorrencias int                  `json:"ocorrencias"`
	Retries     int                  `json:"retries"`
	RetriesDM   int                  `json:"retriesDM"`
	Grupos      map[string]*metGrupo `json:"grupos"`
	// Por hora, para enxergar ONDAS de "Aguardando mensagem" e cruzar com
	// eventos (reconexao, deploy). Tentativas: distribuicao do count do retry.
	Horas      map[string]*metHora `json:"horas"`
	Tentativas map[string]int      `json:"tentativas"`
	Eventos    []evento            `json:"eventos"`
	Phash      int                 `json:"phash"`
}

var (
	metMu    sync.Mutex
	metricas = map[string]map[string]*metConta{} // dia SP -> conta -> metricas
	metSujo  bool
)

func diaSP() string  { return time.Now().In(tzSP).Format("2006-01-02") }
func horaSP() string { return time.Now().In(tzSP).Format("15") }

func metDe(contaID string) *metConta {
	d := diaSP()
	if metricas[d] == nil {
		metricas[d] = map[string]*metConta{}
	}
	m := metricas[d][contaID]
	if m == nil {
		m = &metConta{}
		metricas[d][contaID] = m
	}
	// Metricas gravadas antes destes campos existirem voltam com mapas nil.
	if m.Grupos == nil {
		m.Grupos = map[string]*metGrupo{}
	}
	if m.Horas == nil {
		m.Horas = map[string]*metHora{}
	}
	if m.Tentativas == nil {
		m.Tentativas = map[string]int{}
	}
	metSujo = true
	return m
}

func horaDe(m *metConta) *metHora {
	h := horaSP()
	x := m.Horas[h]
	if x == nil {
		x = &metHora{}
		m.Horas[h] = x
	}
	return x
}

func registrarEvento(contaID, tipo, detalhe string) {
	metMu.Lock()
	defer metMu.Unlock()
	m := metDe(contaID)
	agora := time.Now()
	m.Eventos = append(m.Eventos, evento{Em: agora.UTC().Format(time.RFC3339), Hora: agora.In(tzSP).Format("15:04"), Tipo: tipo, Detalhe: detalhe})
	if len(m.Eventos) > 200 {
		m.Eventos = m.Eventos[len(m.Eventos)-200:]
	}
}

func grupoDe(m *metConta, jid string) *metGrupo {
	g := m.Grupos[jid]
	if g == nil {
		g = &metGrupo{}
		m.Grupos[jid] = g
	}
	return g
}

func registrarEnvio(contaID, jid string, ok bool) {
	metMu.Lock()
	defer metMu.Unlock()
	m := metDe(contaID)
	h := horaDe(m)
	if !ok {
		m.Falhas++
		h.Falhas++
		return
	}
	m.Envios++
	h.Envios++
	if strings.HasSuffix(jid, "@g.us") {
		grupoDe(m, jid).Envios++
	}
}

func registrarPhash(contaID, grupo string) {
	metMu.Lock()
	m := metDe(contaID)
	m.Phash++
	if strings.HasSuffix(grupo, "@g.us") {
		grupoDe(m, grupo).Phash++
	}
	metMu.Unlock()
	registrarEvento(contaID, "phash-divergente", grupo)
}

func registrarRetry(contaID string, r *events.Receipt, tentativa int) {
	metMu.Lock()
	defer metMu.Unlock()
	m := metDe(contaID)
	if r.Chat.Server != types.GroupServer {
		m.RetriesDM++
		return
	}
	g := grupoDe(m, r.Chat.String())
	h := horaDe(m)
	m.Tentativas[strconv.Itoa(tentativa)]++
	m.Retries++
	g.Retries++
	h.Retries++
	if tentativa <= 1 {
		m.Ocorrencias++
		g.Ocorrencias++
		h.Ocorrencias++
		if g.Horas == nil {
			g.Horas = map[string]int{}
		}
		g.Horas[horaSP()]++
	}
}

func caminhoMetricas() string { return filepath.Join(dataDir, "metricas.json") }

func carregarMetricas() {
	b, err := os.ReadFile(caminhoMetricas())
	if err != nil {
		return
	}
	metMu.Lock()
	defer metMu.Unlock()
	_ = json.Unmarshal(b, &metricas)
}

func salvarMetricas(forcar bool) {
	metMu.Lock()
	if !metSujo && !forcar {
		metMu.Unlock()
		return
	}
	// Mantem 30 dias.
	dias := make([]string, 0, len(metricas))
	for d := range metricas {
		dias = append(dias, d)
	}
	sort.Strings(dias)
	for len(dias) > 30 {
		delete(metricas, dias[0])
		dias = dias[1:]
	}
	b, err := json.Marshal(metricas)
	metSujo = false
	metMu.Unlock()
	if err != nil {
		return
	}
	tmp := caminhoMetricas() + ".tmp"
	if os.WriteFile(tmp, b, 0o600) == nil {
		_ = os.Rename(tmp, caminhoMetricas())
	}
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

func responder(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func autenticado(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		recebido := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if token == "" || subtle.ConstantTimeCompare([]byte(recebido), []byte(token)) != 1 {
			responder(w, 401, map[string]any{"ok": false, "erro": "nao autorizado"})
			return
		}
		next(w, r)
	}
}

func contaDaRota(w http.ResponseWriter, r *http.Request) *Conta {
	id := strings.ToLower(r.PathValue("id"))
	if !reContaID.MatchString(id) {
		responder(w, 400, map[string]any{"ok": false, "erro": "id de conta invalido"})
		return nil
	}
	return conta(id)
}

func rotas() *http.ServeMux {
	mux := http.NewServeMux()

	// Sem autenticacao e sem numero: serve para monitor externo. Sempre 200 —
	// reiniciar o container nao cura logout (mesma licao do RUNBOOK).
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		contasMu.Lock()
		lista := make([]*Conta, 0, len(contas))
		for _, c := range contas {
			lista = append(lista, c)
		}
		contasMu.Unlock()
		out := []estadoConta{}
		for _, c := range lista {
			out = append(out, c.estado(false))
		}
		sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
		responder(w, 200, map[string]any{"ok": true, "contas": out})
	})

	mux.HandleFunc("GET /contas/{id}", autenticado(func(w http.ResponseWriter, r *http.Request) {
		if c := contaDaRota(w, r); c != nil {
			responder(w, 200, map[string]any{"ok": true, "conta": c.estado(true)})
		}
	}))

	mux.HandleFunc("POST /contas/{id}/conectar", autenticado(func(w http.ResponseWriter, r *http.Request) {
		c := contaDaRota(w, r)
		if c == nil {
			return
		}
		if err := c.conectar(r.Context()); err != nil {
			responder(w, 500, map[string]any{"ok": false, "erro": err.Error()})
			return
		}
		responder(w, 200, map[string]any{"ok": true, "conta": c.estado(true)})
	}))

	mux.HandleFunc("GET /contas/{id}/qr", autenticado(func(w http.ResponseWriter, r *http.Request) {
		c := contaDaRota(w, r)
		if c == nil {
			return
		}
		c.mu.Lock()
		qr := c.qr
		c.mu.Unlock()
		responder(w, 200, map[string]any{"ok": true, "qr": qr, "conta": c.estado(false)})
	}))

	// Pareamento por codigo de 8 digitos (sem camera).
	mux.HandleFunc("POST /contas/{id}/pair", autenticado(func(w http.ResponseWriter, r *http.Request) {
		c := contaDaRota(w, r)
		if c == nil {
			return
		}
		var corpo struct {
			Numero string `json:"numero"`
		}
		_ = json.NewDecoder(r.Body).Decode(&corpo)
		numero := regexp.MustCompile(`\D`).ReplaceAllString(corpo.Numero, "")
		if len(numero) < 12 {
			responder(w, 400, map[string]any{"ok": false, "erro": "numero com DDI e DDD, so digitos"})
			return
		}
		if n, mudou := comNonoDigito(numero); mudou {
			log.Printf("[CONTA:%s] pareamento: %s sem o nono digito — usando %s", c.ID, numero, n)
			numero = n
		}
		if err := c.conectar(r.Context()); err != nil {
			responder(w, 500, map[string]any{"ok": false, "erro": err.Error()})
			return
		}
		// O pareamento por codigo exige o socket aberto esperando pareamento:
		// o primeiro QR emitido e o sinal de que ele esta pronto.
		limite := time.Now().Add(20 * time.Second)
		for time.Now().Before(limite) {
			c.mu.Lock()
			pronto := c.qr != ""
			c.mu.Unlock()
			if pronto {
				break
			}
			time.Sleep(300 * time.Millisecond)
		}
		cli := c.cliente()
		if cli == nil || cli.Store.ID != nil {
			responder(w, 409, map[string]any{"ok": false, "erro": "conta ja pareada ou indisponivel"})
			return
		}
		codigo, err := cli.PairPhone(r.Context(), numero, true, whatsmeow.PairClientChrome, "Chrome (Linux)")
		if err != nil {
			responder(w, 500, map[string]any{"ok": false, "erro": err.Error()})
			return
		}
		responder(w, 200, map[string]any{"ok": true, "codigo": codigo, "numero": numero})
	}))

	mux.HandleFunc("POST /contas/{id}/logout", autenticado(func(w http.ResponseWriter, r *http.Request) {
		c := contaDaRota(w, r)
		if c == nil {
			return
		}
		if cli := c.cliente(); cli != nil && cli.IsLoggedIn() {
			_ = cli.Logout(r.Context())
		}
		c.descartar("logout manual")
		responder(w, 200, map[string]any{"ok": true})
	}))

	mux.HandleFunc("POST /contas/{id}/enviar", autenticado(func(w http.ResponseWriter, r *http.Request) {
		c := contaDaRota(w, r)
		if c == nil {
			return
		}
		var p pedidoEnvio
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 25<<20)).Decode(&p); err != nil {
			responder(w, 400, map[string]any{"ok": false, "fase": "validacao", "erro": "json invalido: " + err.Error()})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 110*time.Second)
		defer cancel()
		inicio := time.Now()
		resp, err := c.enviar(ctx, p)
		if err != nil {
			var ee *erroEnvio
			if !errors.As(err, &ee) {
				ee = &erroEnvio{"envio", 502, err}
			}
			if ee.Fase != "validacao" {
				registrarEnvio(c.ID, p.JID, false)
			}
			log.Printf("[ENVIO:%s] falha em %s (fase %s): %v", c.ID, p.JID, ee.Fase, ee.Err)
			responder(w, ee.Status, map[string]any{"ok": false, "fase": ee.Fase, "erro": ee.Error()})
			return
		}
		registrarEnvio(c.ID, p.JID, true)
		responder(w, 200, map[string]any{
			"ok": true, "id": resp.ID, "timestamp": resp.Timestamp.Unix(),
			"ms": time.Since(inicio).Milliseconds(),
		})
	}))

	mux.HandleFunc("GET /contas/{id}/grupos", autenticado(func(w http.ResponseWriter, r *http.Request) {
		c := contaDaRota(w, r)
		if c == nil {
			return
		}
		cli := c.cliente()
		if cli == nil || !cli.IsConnected() {
			responder(w, 503, map[string]any{"ok": false, "erro": "conta desconectada"})
			return
		}
		grupos, err := cli.GetJoinedGroups(r.Context())
		if err != nil {
			responder(w, 502, map[string]any{"ok": false, "erro": err.Error()})
			return
		}
		eu := map[string]bool{}
		if cli.Store.ID != nil {
			eu[cli.Store.ID.User] = true
		}
		if !cli.Store.LID.IsEmpty() {
			eu[cli.Store.LID.User] = true
		}
		type grupoOut struct {
			JID           string `json:"jid"`
			Nome          string `json:"nome"`
			Participantes int    `json:"participantes"`
			SoAdmins      bool   `json:"soAdmins"`
			SouAdmin      bool   `json:"souAdmin"`
		}
		out := make([]grupoOut, 0, len(grupos))
		for _, g := range grupos {
			o := grupoOut{JID: g.JID.String(), Nome: g.Name, Participantes: len(g.Participants), SoAdmins: g.IsAnnounce}
			for _, p := range g.Participants {
				if (eu[p.JID.User] || eu[p.PhoneNumber.User] || eu[p.LID.User]) && (p.IsAdmin || p.IsSuperAdmin) {
					o.SouAdmin = true
				}
			}
			out = append(out, o)
		}
		sort.Slice(out, func(i, j int) bool { return out[i].Nome < out[j].Nome })
		responder(w, 200, map[string]any{"ok": true, "grupos": out})
	}))

	mux.HandleFunc("GET /metricas", autenticado(func(w http.ResponseWriter, r *http.Request) {
		metMu.Lock()
		b, _ := json.Marshal(metricas)
		metMu.Unlock()
		var copia map[string]any
		_ = json.Unmarshal(b, &copia)
		responder(w, 200, map[string]any{"ok": true, "hoje": diaSP(), "dias": copia})
	}))

	mux.HandleFunc("GET /pair", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(paginaPair))
	})
	return mux
}

const paginaPair = `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>wa-envio · parear</title>
<style>body{font-family:system-ui;background:#0a0c12;color:#e8e8ea;max-width:420px;margin:40px auto;padding:0 16px}
input,button{width:100%;box-sizing:border-box;padding:12px;margin:6px 0;border-radius:8px;border:1px solid #2a2d38;background:#12151d;color:#e8e8ea;font-size:15px}
button{background:#1f6f4a;border:0;font-weight:600}#saida{font-size:28px;letter-spacing:4px;text-align:center;margin:20px 0;white-space:pre-wrap}small{color:#8a8d98}</style>
<h2>Parear conta (whatsmeow)</h2>
<input id="tk" type="password" placeholder="WA_ENVIO_TOKEN">
<input id="conta" placeholder="conta (ex.: tico-02)">
<input id="num" placeholder="numero com DDI (5531...)">
<button onclick="parear()">Gerar código de 8 dígitos</button>
<button onclick="estado()" style="background:#2a2d38">Ver estado</button>
<div id="saida"></div>
<small>WhatsApp → Dispositivos conectados → Conectar dispositivo → Conectar com número de telefone.</small>
<script>
function h(){return{'Authorization':'Bearer '+document.getElementById('tk').value,'Content-Type':'application/json'}}
function c(){return encodeURIComponent(document.getElementById('conta').value.trim().toLowerCase())}
async function parear(){var s=document.getElementById('saida');s.textContent='gerando…';
 var r=await fetch('/contas/'+c()+'/pair',{method:'POST',headers:h(),body:JSON.stringify({numero:document.getElementById('num').value})});
 var d=await r.json();s.textContent=d.ok?(d.codigo+'\n'+'('+d.numero+')'):('erro: '+d.erro)}
async function estado(){var r=await fetch('/contas/'+c(),{headers:h()});var d=await r.json();
 document.getElementById('saida').textContent=d.ok?JSON.stringify(d.conta,null,1):('erro: '+d.erro)}
</script></html>`

// ── BOOT ─────────────────────────────────────────────────────────────────────

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	if token == "" {
		log.Fatal("WA_ENVIO_TOKEN obrigatorio")
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		log.Fatalf("DATA_DIR: %v", err)
	}
	store.SetOSInfo("Tica Envio", [3]uint32{1, 0, 0})
	store.DeviceProps.PlatformType = waCompanionReg.DeviceProps_DESKTOP.Enum()
	carregarMetricas()

	// Retoma so as contas ja pareadas. Conta sem pareamento nao abre QR sozinha.
	arquivos, _ := filepath.Glob(filepath.Join(dataDir, "*.db"))
	for _, arq := range arquivos {
		id := strings.TrimSuffix(filepath.Base(arq), ".db")
		if !reContaID.MatchString(id) {
			continue
		}
		c := conta(id)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		c.mu.Lock()
		err := c.abrir(ctx)
		pareada := err == nil && c.cli.Store.ID != nil
		c.mu.Unlock()
		cancel()
		if err != nil {
			log.Printf("[CONTA:%s] falha ao abrir: %v", id, err)
			continue
		}
		if pareada {
			registrarEvento(id, "boot", "")
			log.Printf("[CONTA:%s] retomando sessao", id)
			if err := c.conectar(context.Background()); err != nil {
				log.Printf("[CONTA:%s] falha ao conectar: %v", id, err)
			}
		}
	}

	go func() {
		for range time.Tick(time.Minute) {
			salvarMetricas(false)
		}
	}()

	srv := &http.Server{Addr: ":" + porta, Handler: rotas(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		log.Printf("[WA-ENVIO] ouvindo em :%s (dados em %s)", porta, dataDir)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()

	sinal := make(chan os.Signal, 1)
	signal.Notify(sinal, syscall.SIGTERM, syscall.SIGINT)
	<-sinal
	log.Printf("[WA-ENVIO] encerrando…")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
	contasMu.Lock()
	for _, c := range contas {
		c.mu.Lock()
		if c.cli != nil {
			c.cli.Disconnect()
		}
		if c.container != nil {
			_ = c.container.Close()
		}
		c.mu.Unlock()
	}
	contasMu.Unlock()
	salvarMetricas(true)
}
