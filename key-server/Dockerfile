FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache curl

COPY key-server/package.json key-server/package-lock.json ./
RUN npm ci --omit=dev

COPY key-server/server.js ./
COPY key-server/auth ./auth
COPY lib/ports.js ./middleware/

ENV KEY_SERVER_PORT=3040 \
    KEY_SERVER_HOST=0.0.0.0

EXPOSE 3040

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:${KEY_SERVER_PORT}/health || exit 1

CMD ["node", "server.js"]
