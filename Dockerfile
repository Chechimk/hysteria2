FROM alpine:latest
WORKDIR /app
RUN apk add --no-cache wget unzip && \
    wget https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip -O /tmp/xray.zip && \
    unzip /tmp/xray.zip -d /app && \
    chmod +x /app/xray && \
    rm /tmp/xray.zip
COPY config.json /app/config.json
EXPOSE 8080
ENTRYPOINT ["/app/xray", "run", "-config", "/app/config.json"]
