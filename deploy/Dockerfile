# Build context: server/ (see docker-compose.yml).
FROM --platform=$BUILDPLATFORM golang:1.27-alpine AS build
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /out/cross-tab-sync ./cmd/cross-tab-sync \
    && mkdir -p /out/data

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/cross-tab-sync /cross-tab-sync
COPY --from=build --chown=nonroot:nonroot /out/data /data
ENV CTS_ADDR=:8080 \
    CTS_DB_PATH=/data/cts.db
VOLUME ["/data"]
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/cross-tab-sync"]
CMD ["serve"]
