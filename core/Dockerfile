FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache curl

COPY core/package.json core/package-lock.json ./
RUN npm ci --omit=dev

COPY core/server.js ./
COPY core/note-embedding-outbox.js core/chat-archive.js core/inbox-document.js core/services-registry.js ./
COPY core/db ./db
COPY lib/ports.js lib/sign-outbound.js lib/verify-signed.js ./middleware/
COPY core/generated ./generated

ENV PORT=3032 \
    CONSCIOUSNESS_HOST=0.0.0.0 \
    REDIS_HOST=redis \
    REDIS_PORT=6379 \
    AGENTS_DIR=/data/agents \
    SEMANTIC_SEARCH_URL=http://semantic-search:3037

EXPOSE 3032

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:${PORT}/health || exit 1

CMD ["node", "server.js"]
