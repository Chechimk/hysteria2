#!/bin/sh

# Start a TCP listener on port 8080 to satisfy Cloud Run health checks
socat TCP-LISTEN:8080,fork,reuseaddr STDOUT &

# Start Hysteria server
exec /app/hysteria server -c /app/config.json
