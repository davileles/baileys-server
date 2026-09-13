// recuperacao.go — separa RECUPERACAO de fila de problema de entrega.
//
// Celular que passa a madrugada fora do ar pede, ao voltar, o reenvio de toda a
// fila acumulada: um unico aparelho chega a 86 pedidos numa hora. Isso nao mede
// a nossa entrega — a mensagem saiu certa, o aparelho e que nao estava la para
// receber. Pedido de mensagem com mais de RECUP_MIN minutos entra em conta
// separada; o pedido rapido (aparelho online que nao decifrou) continua sendo o
// indicador de entrega.
package main

import (
	"sync"
	"time"

	"go.mau.fi/whatsmeow/types"
)

const (
	recupIdadeMin = 30 * time.Minute // acima disso e recuperacao de fila
	enviadasMax   = 20000
	enviadasTTL   = 30 * time.Hour
)

// id da mensagem -> quando a enviamos. So para medir a idade no pedido de retry.
var enviadas = struct {
	sync.Mutex
	em map[types.MessageID]time.Time
}{em: map[types.MessageID]time.Time{}}

func marcarEnviada(id types.MessageID) {
	if id == "" {
		return
	}
	agora := time.Now()
	enviadas.Lock()
	defer enviadas.Unlock()
	if len(enviadas.em) >= enviadasMax {
		for k, t := range enviadas.em {
			if agora.Sub(t) > enviadasTTL || len(enviadas.em) >= enviadasMax {
				delete(enviadas.em, k)
			}
		}
	}
	enviadas.em[id] = agora
}

// idadeNoPedido: ha quanto tempo a mensagem foi enviada. ok=false quando nao
// sabemos (mensagem de antes do boot) — nesse caso nao classificamos.
func idadeNoPedido(id types.MessageID) (time.Duration, bool) {
	enviadas.Lock()
	defer enviadas.Unlock()
	t, ok := enviadas.em[id]
	if !ok {
		return 0, false
	}
	return time.Since(t), true
}

// classe do pedido, usada nas metricas e no resumo.
const (
	pedidoEntrega      = "entrega"     // aparelho online, mensagem recente
	pedidoRecuperacao  = "recuperacao" // fila acumulada (aparelho estava fora)
	pedidoDesconhecido = "desconhecido"
)

func classePedido(id types.MessageID) string {
	idade, ok := idadeNoPedido(id)
	if !ok {
		return pedidoDesconhecido
	}
	if idade >= recupIdadeMin {
		return pedidoRecuperacao
	}
	return pedidoEntrega
}
