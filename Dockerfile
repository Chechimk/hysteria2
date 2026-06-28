FROM alpine:latest
WORKDIR /app
RUN apk add --no-cache wget unzip nginx && \
    wget https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip -O /tmp/xray.zip && \
    unzip /tmp/xray.zip -d /app && \
    chmod +x /app/xray && \
    rm /tmp/xray.zip && \
    mkdir -p /run/nginx

COPY config.json /app/config.json
COPY nginx.conf /etc/nginx/http.d/default.conf

RUN printf '#!/bin/sh\n/app/xray run -config /app/config.json &\nnginx -g "daemon off;"\n' > /app/start.sh && \
    chmod +x /app/start.sh

EXPOSE 8080
ENTRYPOINT ["/app/start.sh"]
