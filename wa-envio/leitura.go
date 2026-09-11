// leitura.go — repasse das mensagens RECEBIDAS ao baileys-server.
//
// Os aparelhos do wa-envio sao dispositivos vinculados: ja recebem e decifram
// tudo o que chega nos grupos das contas. Aqui repassamos ao server.js as
// mensagens dos grupos que ele le (fontes do radar TSP e monitorados do CDV),
// no formato do protobuf (mesmos nomes de campo que o Baileys usa), com a
// imagem ja baixada. Primeira fase: MODO SOMBRA — o servidor so compara com o
// que o Baileys recebeu; nada entra no pipeline.
//
// Desligado sem LEITURA_URL. Contas que repassam: LEITURA_CONTAS (ex.: principal).
package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

const (
	leituraFilaMax    = 5000
	leituraImagemMax  = 8 << 20
	leituraTentativas = 3
)

type itemLeitura struct {
	Conta        string          `json:"conta"`
	ID           string          `json:"id"`
	Chat         string          `json:"chat"`
	Sender       string          `json:"sender"`
	SenderAlt    string          `json:"senderAlt,omitempty"`
	FromMe       bool            `json:"fromMe"`
	PushName     string          `json:"pushName,omitempty"`
	Timestamp    int64           `json:"timestamp"`
	Edicao       bool            `json:"edicao,omitempty"`
	Indecifravel bool            `json:"indecifravel,omitempty"`
	Message      json.RawMessage `json:"message,omitempty"`
	ImagemBase64 string          `json:"imagemBase64,omitempty"`
	ImagemErro   string          `json:"imagemErro,omitempty"`
	RecebidaEm   int64           `json:"recebidaEm"`

	imagem *waE2E.ImageMessage
}

type estadoLeitura struct {
	Ativa        bool   `json:"ativa"`
	Contas       string `json:"contas"`
	Grupos       int    `json:"grupos"`
	GruposEm     string `json:"gruposAtualizadosEm,omitempty"`
	Enfileiradas int64  `json:"enfileiradas"`
	Entregues    int64  `json:"entregues"`
	Falhas       int64  `json:"falhas"`
	Descartadas  int64  `json:"descartadas"`
	Imagens      int64  `json:"imagens"`
	ImagensErro  int64  `json:"imagensErro"`
	NaFila       int    `json:"naFila"`
	UltimoErro   string `json:"ultimoErro,omitempty"`
	UltimaEm     string `json:"ultimaEntregaEm,omitempty"`
}

var leitura = struct {
	url    string
	contas map[string]bool
	fila   chan *itemLeitura

	mu       sync.RWMutex
	grupos   map[string]bool
	gruposEm time.Time

	enfileiradas, entregues, falhas, descartadas, imagens, imagensErro atomic.Int64

	erroMu     sync.Mutex
	ultimoErro string
	ultimaEm   time.Time
}{}

var httpLeitura = &http.Client{Timeout: 30 * time.Second}

func iniciarLeitura() {
	leitura.url = strings.TrimRight(envOr("LEITURA_URL", ""), "/")
	if leitura.url == "" {
		return
	}
	leitura.contas = map[string]bool{}
	for _, c := range strings.Split(envOr("LEITURA_CONTAS", "principal"), ",") {
		if c = strings.TrimSpace(strings.ToLower(c)); c != "" {
			leitura.contas[c] = true
		}
	}
	leitura.fila = make(chan *itemLeitura, leituraFilaMax)
	go func() {
		for {
			atualizarGruposLeitura()
			time.Sleep(time.Minute)
		}
	}()
	go workerLeitura()
	log.Printf("[LEITURA] repasse ligado para %s (contas: %s)", leitura.url, envOr("LEITURA_CONTAS", "principal"))
}

func leituraAtiva(contaID string) bool {
	return leitura.fila != nil && leitura.contas[contaID]
}

func atualizarGruposLeitura() {
	req, _ := http.NewRequest("GET", leitura.url+"/interno/wa-leitura/grupos", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := httpLeitura.Do(req)
	if err != nil {
		registrarErroLeitura("grupos: " + err.Error())
		return
	}
	defer resp.Body.Close()
	var corpo struct {
		OK     bool     `json:"ok"`
		Grupos []string `json:"grupos"`
	}
	if resp.StatusCode != 200 || json.NewDecoder(resp.Body).Decode(&corpo) != nil || !corpo.OK {
		registrarErroLeitura(fmt.Sprintf("grupos: HTTP %d", resp.StatusCode))
		return
	}
	novo := make(map[string]bool, len(corpo.Grupos))
	for _, j := range corpo.Grupos {
		novo[j] = true
	}
	leitura.mu.Lock()
	leitura.grupos, leitura.gruposEm = novo, time.Now()
	leitura.mu.Unlock()
}

func grupoLido(jid types.JID) bool {
	if jid.Server != types.GroupServer {
		return false
	}
	leitura.mu.RLock()
	defer leitura.mu.RUnlock()
	return leitura.grupos[jid.String()]
}

func enfileirarLeitura(it *itemLeitura) {
	select {
	case leitura.fila <- it:
		leitura.enfileiradas.Add(1)
	default:
		leitura.descartadas.Add(1)
	}
}

// Chamado do handler de eventos da conta: NAO pode bloquear (o whatsmeow
// entrega os eventos em ordem, num unico fluxo). Download e HTTP ficam no worker.
func (c *Conta) repassarEvento(evt any) {
	if !leituraAtiva(c.ID) {
		return
	}
	switch e := evt.(type) {
	case *events.Message:
		if !grupoLido(e.Info.Chat) {
			return
		}
		raw := e.RawMessage
		if raw == nil {
			raw = e.Message
		}
		// O whatsmeow emite UM evento por parte decifrada: a parte 1:1 (so a
		// sender key) e a parte de grupo (o conteudo), com o MESMO id. O Baileys
		// junta as duas numa mensagem so. Repassar a parte da chave faria o
		// servidor ver "senderKeyDistributionMessage" e — pior, no modo ativo —
		// o dedup por id descartaria o conteudo que chega logo depois.
		if soProtocoloDeChave(raw) {
			return
		}
		corpo, err := protojson.Marshal(raw)
		if err != nil {
			return
		}
		it := baseItem(c.ID, e.Info)
		it.Edicao = e.IsEdit
		it.Message = corpo
		it.imagem = e.Message.GetImageMessage()
		enfileirarLeitura(it)
	case *events.UndecryptableMessage:
		if !grupoLido(e.Info.Chat) {
			return
		}
		it := baseItem(c.ID, e.Info)
		it.Indecifravel = true
		enfileirarLeitura(it)
	}
}

// soProtocoloDeChave: true quando a mensagem carrega apenas a distribuicao da
// sender key e/ou metadados, sem nenhum conteudo.
func soProtocoloDeChave(m *waE2E.Message) bool {
	if m == nil {
		return true
	}
	if ds := m.GetDeviceSentMessage().GetMessage(); ds != nil {
		m = ds
	}
	c := proto.Clone(m).(*waE2E.Message)
	c.SenderKeyDistributionMessage = nil
	c.MessageContextInfo = nil
	return proto.Size(c) == 0
}

func baseItem(conta string, info types.MessageInfo) *itemLeitura {
	it := &itemLeitura{
		Conta: conta, ID: info.ID, Chat: info.Chat.String(), Sender: info.Sender.String(),
		FromMe: info.IsFromMe, PushName: info.PushName, Timestamp: info.Timestamp.Unix(),
		RecebidaEm: time.Now().UnixMilli(),
	}
	if !info.SenderAlt.IsEmpty() {
		it.SenderAlt = info.SenderAlt.String()
	}
	return it
}

func workerLeitura() {
	for it := range leitura.fila {
		if it.imagem != nil {
			baixarImagemLeitura(it)
		}
		entregarLeitura(it)
	}
}

func baixarImagemLeitura(it *itemLeitura) {
	defer func() { it.imagem = nil }()
	if it.imagem.GetFileLength() > leituraImagemMax {
		it.ImagemErro = "imagem acima de 8 MB"
		return
	}
	c := conta(it.Conta)
	cli := c.cliente()
	if cli == nil {
		it.ImagemErro = "conta sem cliente"
		leitura.imagensErro.Add(1)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	dados, err := cli.Download(ctx, it.imagem)
	if err != nil {
		it.ImagemErro = err.Error()
		leitura.imagensErro.Add(1)
		return
	}
	it.ImagemBase64 = base64.StdEncoding.EncodeToString(dados)
	leitura.imagens.Add(1)
}

func entregarLeitura(it *itemLeitura) {
	corpo, err := json.Marshal(it)
	if err != nil {
		leitura.falhas.Add(1)
		return
	}
	for tentativa := 1; tentativa <= leituraTentativas; tentativa++ {
		req, _ := http.NewRequest("POST", leitura.url+"/interno/wa-leitura/mensagens", bytes.NewReader(corpo))
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		resp, err := httpLeitura.Do(req)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == 200 {
				leitura.entregues.Add(1)
				leitura.erroMu.Lock()
				leitura.ultimaEm = time.Now()
				leitura.erroMu.Unlock()
				return
			}
			err = fmt.Errorf("HTTP %d", resp.StatusCode)
			if resp.StatusCode >= 400 && resp.StatusCode < 500 {
				tentativa = leituraTentativas // erro do pedido: repetir nao muda nada
			}
		}
		registrarErroLeitura(err.Error())
		if tentativa < leituraTentativas {
			time.Sleep(time.Duration(tentativa*2) * time.Second)
		}
	}
	leitura.falhas.Add(1)
}

func registrarErroLeitura(msg string) {
	leitura.erroMu.Lock()
	leitura.ultimoErro = time.Now().In(tzSP).Format("15:04:05") + " " + msg
	leitura.erroMu.Unlock()
}

func estadoAtualLeitura() estadoLeitura {
	e := estadoLeitura{Ativa: leitura.fila != nil, Contas: envOr("LEITURA_CONTAS", "principal")}
	if !e.Ativa {
		return e
	}
	leitura.mu.RLock()
	e.Grupos = len(leitura.grupos)
	if !leitura.gruposEm.IsZero() {
		e.GruposEm = leitura.gruposEm.In(tzSP).Format("15:04:05")
	}
	leitura.mu.RUnlock()
	e.Enfileiradas, e.Entregues = leitura.enfileiradas.Load(), leitura.entregues.Load()
	e.Falhas, e.Descartadas = leitura.falhas.Load(), leitura.descartadas.Load()
	e.Imagens, e.ImagensErro = leitura.imagens.Load(), leitura.imagensErro.Load()
	e.NaFila = len(leitura.fila)
	leitura.erroMu.Lock()
	e.UltimoErro = leitura.ultimoErro
	if !leitura.ultimaEm.IsZero() {
		e.UltimaEm = leitura.ultimaEm.In(tzSP).Format("15:04:05")
	}
	leitura.erroMu.Unlock()
	return e
}
