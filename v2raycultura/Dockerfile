FROM alpine:latest
EXPOSE 8080/udp
WORKDIR /app
RUN apk add --no-cache openssl && \
    wget https://github.com/apernet/hysteria/releases/latest/download/hysteria-linux-amd64 -O /app/hysteria && \
    chmod +x /app/hysteria && \
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -days 3650 -nodes \
    -keyout /app/server.key -out /app/server.crt -subj "/CN=bing.com"
COPY config.json /app/config.json
ENTRYPOINT ["/app/hysteria", "server", "-c", "/app/config.json"]
