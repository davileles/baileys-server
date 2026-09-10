# wa-envio — motor de envio whatsmeow (Go). Build estatico, sem CGO:
# o SQLite e o modernc.org/sqlite (Go puro), entao a imagem final nao precisa
# de libc nem de toolchain.
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /wa-envio .

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /wa-envio /usr/local/bin/wa-envio
ENV DATA_DIR=/data
EXPOSE 8080
CMD ["wa-envio"]
