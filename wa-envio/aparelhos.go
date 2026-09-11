// aparelhos.go — separa "falha nossa" de "celular do membro com problema".
//
// Cada pedido de reenvio traz o registration id do aparelho que pediu. Esse
// numero so muda quando o WhatsApp daquele aparelho e ativado de novo
// (reinstalacao, numero ativado em outro celular, app que refaz o registro).
// Um aparelho reativado mais de uma vez no mesmo dia (3+ registration ids ou 2+
// trocas de identidade) nao consegue decifrar o que chega entre uma ativacao e
// outra, por melhor que seja o envio. Esses aparelhos ficam marcados como
// INSTAVEIS e os pedidos deles saem da conta de "problema de entrega".
//
// Tambem guarda os pedidos por aparelho, para enxergar concentracao: 80
// ocorrencias num grupo podem ser 80 membros ou um celular so.
package main

import (
	"encoding/hex"
	"fmt"
	"sort"
	"time"

	waBinary "go.mau.fi/whatsmeow/binary"
)

const (
	aparelhosMaxPorDia      = 8000
	aparelhosDiasDetalhe    = 7
	registrosMaxPorAparelho = 6
)

type metAparelho struct {
	Registros   []string       `json:"registros,omitempty"`
	Identidades int            `json:"identidades,omitempty"`
	Ocorrencias int            `json:"ocorrencias"`
	Retries     int            `json:"retries"`
	Grupos      map[string]int `json:"grupos,omitempty"` // ocorrencias por grupo
	Ultimo      string         `json:"ultimo,omitempty"`
	Instavel    bool           `json:"instavel,omitempty"`
}

// chamar com metMu travado
func aparelhoDe(m *metConta, jid string) *metAparelho {
	if m.Aparelhos == nil {
		m.Aparelhos = map[string]*metAparelho{}
	}
	a := m.Aparelhos[jid]
	if a == nil {
		a = &metAparelho{}
		if len(m.Aparelhos) < aparelhosMaxPorDia {
			m.Aparelhos[jid] = a
		}
	}
	return a
}

// marcarSeInstavel: devolve true na transicao (para registrar o evento uma vez)
func marcarSeInstavel(a *metAparelho) bool {
	// Uma reativacao isolada (troca de celular, reinstalacao) e normal: gera 2
	// registration ids e 1 troca de identidade. Instavel e quem reativa de novo.
	if a.Instavel || (len(a.Registros) < 3 && a.Identidades < 2) {
		return false
	}
	a.Instavel = true
	return true
}

// observarRecibo: chamado para TODO Debugf do whatsmeow — precisa ser barato.
func observarRecibo(contaID, modulo string, args []any) {
	if modulo != "Recv" || len(args) != 1 {
		return
	}
	n, ok := args[0].(*waBinary.Node)
	if !ok || n.Tag != "receipt" {
		return
	}
	if tipo, _ := n.Attrs["type"].(string); tipo != "retry" {
		return
	}
	var reg string
	for _, c := range n.GetChildren() {
		if c.Tag == "registration" {
			if bs, ok := c.Content.([]byte); ok {
				reg = hex.EncodeToString(bs)
			}
		}
	}
	part := fmt.Sprint(n.Attrs["participant"])
	if reg == "" || part == "" || part == "<nil>" {
		return
	}
	metMu.Lock()
	a := aparelhoDe(metDe(contaID), part)
	novo := true
	for _, r := range a.Registros {
		if r == reg {
			novo = false
			break
		}
	}
	if novo && len(a.Registros) < registrosMaxPorAparelho {
		a.Registros = append(a.Registros, reg)
	}
	virou := marcarSeInstavel(a)
	metMu.Unlock()
	if virou {
		registrarEvento(contaID, "aparelho-instavel", part+" (registration mudou)")
	}
}

func registrarIdentidade(contaID, jid string) {
	metMu.Lock()
	a := aparelhoDe(metDe(contaID), jid)
	a.Identidades++
	virou := marcarSeInstavel(a)
	metMu.Unlock()
	if virou {
		registrarEvento(contaID, "aparelho-instavel", jid+" (identidade mudou)")
	}
}

// chamar com metMu travado (de dentro de registrarRetry)
func contarPedidoAparelho(m *metConta, sender, grupo string, tentativa int) {
	a := aparelhoDe(m, sender)
	a.Retries++
	a.Ultimo = time.Now().In(tzSP).Format("15:04")
	if tentativa <= 1 {
		a.Ocorrencias++
		if a.Grupos == nil {
			a.Grupos = map[string]int{}
		}
		a.Grupos[grupo]++
	}
}

// resumoAparelhos: calculado na leitura, entao reclassifica tambem os pedidos
// que o aparelho fez ANTES de ser marcado como instavel.
func resumoAparelhos(m *metConta) (map[string]any, map[string][2]int) {
	type item struct {
		jid string
		a   *metAparelho
	}
	var todos, instaveis []item
	porGrupo := map[string][2]int{} // jid -> {aparelhos com pedido, ocorrencias de instaveis}
	ocInst := 0
	for jid, a := range m.Aparelhos {
		if a.Ocorrencias == 0 {
			continue
		}
		todos = append(todos, item{jid, a})
		for g, n := range a.Grupos {
			v := porGrupo[g]
			v[0]++
			if a.Instavel {
				v[1] += n
			}
			porGrupo[g] = v
		}
		if a.Instavel {
			instaveis = append(instaveis, item{jid, a})
			ocInst += a.Ocorrencias
		}
	}
	ordena := func(l []item) {
		sort.Slice(l, func(i, j int) bool { return l[i].a.Ocorrencias > l[j].a.Ocorrencias })
	}
	ordena(todos)
	ordena(instaveis)
	lista := func(l []item, max int) []map[string]any {
		out := []map[string]any{}
		for i, it := range l {
			if i >= max {
				break
			}
			out = append(out, map[string]any{
				"aparelho": it.jid, "ocorrencias": it.a.Ocorrencias, "retries": it.a.Retries,
				"registros": len(it.a.Registros), "identidades": it.a.Identidades,
				"instavel": it.a.Instavel, "grupos": it.a.Grupos, "ultimo": it.a.Ultimo,
			})
		}
		return out
	}
	semInst := m.Ocorrencias - ocInst
	if semInst < 0 {
		semInst = 0
	}
	return map[string]any{
		"aparelhosComPedido":      len(todos),
		"instaveis":               len(instaveis),
		"ocorrenciasInstaveis":    ocInst,
		"ocorrenciasSemInstaveis": semInst,
		"listaInstaveis":          lista(instaveis, 30),
		"topAparelhos":            lista(todos, 15),
	}, porGrupo
}

// metricasParaResposta: copia das metricas com o resumo por aparelho injetado.
// O detalhe cru por aparelho so vai com ?aparelhos=1 (pode ser grande).
func metricasParaResposta(comDetalhe bool) map[string]any {
	metMu.Lock()
	defer metMu.Unlock()
	saida := map[string]any{}
	for dia, contas := range metricas {
		porConta := map[string]any{}
		for id, m := range contas {
			var copia map[string]any
			b, _ := jsonMarshal(m)
			_ = jsonUnmarshal(b, &copia)
			if copia == nil {
				continue
			}
			resumo, porGrupo := resumoAparelhos(m)
			copia["resumoAparelhos"] = resumo
			if gs, ok := copia["grupos"].(map[string]any); ok {
				for jid, v := range porGrupo {
					if g, ok := gs[jid].(map[string]any); ok {
						g["aparelhos"] = v[0]
						g["ocorrenciasInstaveis"] = v[1]
					}
				}
			}
			if !comDetalhe {
				delete(copia, "aparelhos")
			}
			porConta[id] = copia
		}
		saida[dia] = porConta
	}
	return saida
}

// podarAparelhos: detalhe por aparelho so dos ultimos dias (chamar com metMu travado)
func podarAparelhos(diasOrdenados []string) {
	if len(diasOrdenados) <= aparelhosDiasDetalhe {
		return
	}
	for _, d := range diasOrdenados[:len(diasOrdenados)-aparelhosDiasDetalhe] {
		for _, m := range metricas[d] {
			m.Aparelhos = nil
		}
	}
}
