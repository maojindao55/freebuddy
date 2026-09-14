# syntax=docker/dockerfile:1.7

FROM golang:1.27-alpine AS builder

ARG TARGETOS=linux
ARG TARGETARCH

WORKDIR /src

COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download

COPY cmd/relay ./cmd/relay
COPY internal ./internal

RUN --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags="-s -w" -o /out/remote-relay ./cmd/relay

FROM alpine:3.22

RUN apk add --no-cache ca-certificates wget \
    && addgroup -S -g 10001 relay \
    && adduser -S -D -H -u 10001 -G relay relay \
    && install -d -o relay -g relay -m 0700 /data

COPY --from=builder /out/remote-relay /usr/local/bin/remote-relay

ENV LISTEN_ADDR=:8080 \
    SQLITE_PATH=/data/relay.db \
    LOG_FORMAT=json

USER 10001:10001
WORKDIR /data

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q -T 2 -O /dev/null http://127.0.0.1:8080/readyz || exit 1

ENTRYPOINT ["/usr/local/bin/remote-relay"]
