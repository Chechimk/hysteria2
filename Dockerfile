FROM node:20-alpine
WORKDIR /app

RUN apk add --no-cache wget unzip && \
    wget https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip -O /tmp/xray.zip && \
    unzip /tmp/xray.zip -d /app && \
    chmod +x /app/xray && \
    rm /tmp/xray.zip

COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

EXPOSE 8080
CMD ["node", "server.js"]
