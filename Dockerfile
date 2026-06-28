FROM node:20-alpine
WORKDIR /app

RUN apk add --no-cache nginx wget unzip && \
    mkdir -p /run/nginx && \
    wget https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip -O /tmp/xray.zip && \
    unzip /tmp/xray.zip -d /app && \
    chmod +x /app/xray && \
    rm /tmp/xray.zip

COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
COPY nginx.conf /etc/nginx/http.d/default.conf

RUN printf '#!/bin/sh\nnginx\nexec node /app/server.js\n' > /app/start.sh && chmod +x /app/start.sh

EXPOSE 8080
ENTRYPOINT ["/app/start.sh"]
