// diagretry.go — diagnostico dos pedidos de reenvio (retry receipts) de grupos
// escolhidos. Liga com LOG_RETRY_GRUPOS=jid1,jid2. Imprime, so para esses
// grupos: o recibo cru que o aparelho mandou (<receipt type="retry">, com
// contador, erro, registration e se veio pacote de chaves), o motivo pelo qual
// o whatsmeow buscou prekeys e a confirmacao de cada reenvio. Serve para
// entender por que alguns aparelhos seguem pedindo mesmo apos 5 reenvios.
package main

import (
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	waBinary "go.mau.fi/whatsmeow/binary"
)

const diagMaxPorHora = 3000

var diagRetry = struct {
	grupos map[string]bool
	mu     sync.Mutex
	hora   int64
	linhas int
}{}

func iniciarDiagRetry() {
	for _, j := range strings.Split(envOr("LOG_RETRY_GRUPOS", ""), ",") {
		if j = strings.TrimSpace(j); strings.HasSuffix(j, "@g.us") {
			if diagRetry.grupos == nil {
				diagRetry.grupos = map[string]bool{}
			}
			diagRetry.grupos[j] = true
		}
	}
	if diagRetry.grupos != nil {
		log.Printf("[DIAG-RETRY] ligado para %d grupo(s)", len(diagRetry.grupos))
	}
}

func diagImprimir(conta, linha string) {
	diagRetry.mu.Lock()
	h := time.Now().Unix() / 3600
	if h != diagRetry.hora {
		diagRetry.hora, diagRetry.linhas = h, 0
	}
	diagRetry.linhas++
	n := diagRetry.linhas
	diagRetry.mu.Unlock()
	if n > diagMaxPorHora {
		return
	}
	if len(linha) > 900 {
		linha = linha[:900] + "…"
	}
	log.Printf("[DIAG-RETRY:%s] %s", conta, linha)
}

// Chamado para todo Debugf do whatsmeow: precisa ser barato no caso comum.
func diagDebug(conta, modulo, msg string, args []any) {
	if diagRetry.grupos == nil {
		return
	}
	switch modulo {
	case "Recv":
		if len(args) != 1 {
			return
		}
		n, ok := args[0].(*waBinary.Node)
		if !ok || n.Tag != "receipt" {
			return
		}
		if tipo, _ := n.Attrs["type"].(string); tipo != "retry" {
			return
		}
		if !diagRetry.grupos[fmt.Sprint(n.Attrs["from"])] {
			return
		}
		diagImprimir(conta, "recibo: "+resumoRecibo(n))
	case "":
		if !strings.Contains(msg, "retry") && !strings.Contains(msg, "prekeys") {
			return
		}
		linha := fmt.Sprintf(msg, args...)
		// "Fetching prekeys ..." nao traz o grupo; entra sempre (vem logo apos o recibo)
		if strings.HasPrefix(msg, "Fetching prekeys") || diagContemGrupo(linha) {
			diagImprimir(conta, linha)
		}
	}
}

func diagContemGrupo(s string) bool {
	for j := range diagRetry.grupos {
		if strings.Contains(s, j) {
			return true
		}
	}
	return false
}

// resumoRecibo: atributos do recibo e dos filhos, sem despejar os bytes das chaves.
func resumoRecibo(n *waBinary.Node) string {
	var b strings.Builder
	fmt.Fprintf(&b, "id=%v participant=%v t=%v", n.Attrs["id"], n.Attrs["participant"], n.Attrs["t"])
	for _, c := range n.GetChildren() {
		switch c.Tag {
		case "retry":
			fmt.Fprintf(&b, " retry{count=%v v=%v error=%v t=%v}", c.Attrs["count"], c.Attrs["v"], c.Attrs["error"], c.Attrs["t"])
		case "registration":
			if bs, ok := c.Content.([]byte); ok {
				fmt.Fprintf(&b, " registration=%x", bs)
			}
		case "keys":
			tipos := []string{}
			for _, k := range c.GetChildren() {
				tipos = append(tipos, k.Tag)
			}
			fmt.Fprintf(&b, " keys{%s}", strings.Join(tipos, ","))
		default:
			fmt.Fprintf(&b, " %s%v", c.Tag, c.Attrs)
		}
	}
	return b.String()
}
