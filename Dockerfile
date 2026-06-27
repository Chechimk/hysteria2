FROM alpine:latest
EXPOSE 8080/udp
EXPOSE 8080/tcp
WORKDIR /app
RUN apk add --no-cache openssl busybox-extras && \
    wget https://github.com/apernet/hysteria/releases/latest/download/hysteria-linux-amd64 -O /app/hysteria && \
    chmod +x /app/hysteria && \
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -days 3650 -nodes \
    -keyout /app/server.key -out /app/server.crt -subj "/CN=bing.com"
COPY config.json /app/config.json
# Inline start script to avoid CRLF issues from Windows
RUN printf '#!/bin/sh\nmkdir -p /app/www\necho "OK" > /app/www/index.html\nhttpd -p 8080 -h /app/www &\nexec /app/hysteria server -c /app/config.json\n' > /app/start.sh && \
    chmod +x /app/start.sh
ENTRYPOINT ["/app/start.sh"]
