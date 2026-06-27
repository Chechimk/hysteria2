FROM alpine:latest
EXPOSE 8080/udp
EXPOSE 8080/tcp
WORKDIR /app
RUN apk add --no-cache openssl socat && \
    wget https://github.com/apernet/hysteria/releases/latest/download/hysteria-linux-amd64 -O /app/hysteria && \
    chmod +x /app/hysteria && \
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -days 3650 -nodes \
    -keyout /app/server.key -out /app/server.crt -subj "/CN=bing.com"
COPY config.json /app/config.json
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh
ENTRYPOINT ["/app/start.sh"]
