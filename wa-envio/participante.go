// participante.go — resolve quem esta por tras de um identificador LID.
//
// GET /contas/{id}/participante/{lid}?grupo=<jid>
// Usado para investigar aparelhos problematicos apontados pelo diagnostico de
// reenvio. Consulta (1) o mapa LID->telefone que o whatsmeow guarda e (2) a
// lista de participantes do grupo, que para admins costuma trazer o telefone.
package main

import (
	"context"
	"net/http"
	"strings"
	"time"

	"go.mau.fi/whatsmeow/types"
)

func rotaParticipante(w http.ResponseWriter, r *http.Request) {
	c := contaDaRota(w, r)
	if c == nil {
		return
	}
	cli := c.cliente()
	if cli == nil || !cli.IsConnected() {
		responder(w, 503, map[string]any{"ok": false, "erro": "conta desconectada"})
		return
	}
	bruto := strings.TrimSpace(r.PathValue("lid"))
	if !strings.Contains(bruto, "@") {
		bruto += "@lid"
	}
	lid, err := types.ParseJID(bruto)
	if err != nil || lid.Server != types.HiddenUserServer {
		responder(w, 400, map[string]any{"ok": false, "erro": "lid invalido"})
		return
	}
	lid = lid.ToNonAD()
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	out := map[string]any{"ok": true, "lid": lid.String()}
	if pn, err := cli.Store.LIDs.GetPNForLID(ctx, lid); err == nil && !pn.IsEmpty() {
		out["telefone"] = pn.User
		out["fonteTelefone"] = "mapa-lid"
	}

	if g := strings.TrimSpace(r.URL.Query().Get("grupo")); g != "" {
		gj, err := types.ParseJID(g)
		if err != nil || gj.Server != types.GroupServer {
			responder(w, 400, map[string]any{"ok": false, "erro": "grupo invalido"})
			return
		}
		info, err := cli.GetGroupInfo(ctx, gj)
		if err != nil {
			out["grupoErro"] = err.Error()
		} else {
			achado := map[string]any{"grupo": info.Name, "membro": false}
			for _, p := range info.Participants {
				if p.LID.User != lid.User && p.JID.User != lid.User {
					continue
				}
				achado["membro"] = true
				achado["admin"] = p.IsAdmin || p.IsSuperAdmin
				if !p.PhoneNumber.IsEmpty() {
					achado["telefone"] = p.PhoneNumber.User
					if _, ok := out["telefone"]; !ok {
						out["telefone"], out["fonteTelefone"] = p.PhoneNumber.User, "lista-do-grupo"
					}
				}
				if p.DisplayName != "" {
					achado["nomeExibido"] = p.DisplayName
				}
				break
			}
			out["noGrupo"] = achado
		}
	}

	if devs, err := cli.GetUserDevices(ctx, []types.JID{lid}); err == nil {
		lista := make([]string, 0, len(devs))
		for _, d := range devs {
			lista = append(lista, d.ADString())
		}
		out["aparelhos"] = lista
	}
	if _, ok := out["telefone"]; !ok {
		out["telefone"] = nil
		out["obs"] = "telefone nao exposto: fora do mapa LID e oculto na lista do grupo"
	}
	responder(w, 200, out)
}
