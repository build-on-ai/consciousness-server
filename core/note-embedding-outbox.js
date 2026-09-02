'use strict';

const NOTE_EMBEDDING_OUTBOX_KEY = 'outbox:note-embedding';
const NOTE_TTL_30_DAYS = 30 * 24 * 3600;
const NOTE_TTL_TELEMETRY_AGENTS = new Set(['machines-monitor']);

function defaultNoteTtlSeconds(note) {
  return note && !note.expires_at && NOTE_TTL_TELEMETRY_AGENTS.has(note.agent)
    ? NOTE_TTL_30_DAYS
    : null;
}

function scalarString(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function buildNoteEmbeddingPayload(note) {
  const source = note && note.metadata && typeof note.metadata === 'object' && !Array.isArray(note.metadata)
    ? note.metadata
    : {};
  const createdAt = scalarString(note.created_at);
  const parsedEpoch = Date.parse(createdAt);
  const explicitKind = scalarString(source.kind);
  const content = scalarString(note.content);
  const inferredKind = content.includes('[USER]') || content.includes('[ASSISTANT]')
    ? 'transcript'
    : 'knowledge';

  return {
    collection: 'notes',
    id: note.id,
    text: [scalarString(note.title), content]
      .filter(Boolean)
      .join('\n\n'),
    metadata: {
      session_id: scalarString(source.session_id),
      project: scalarString(source.project),
      agent: scalarString(note.agent),
      kind: explicitKind === 'knowledge' || explicitKind === 'transcript'
        ? explicitKind
        : inferredKind,
      created_at: createdAt,
      created_epoch: Number.isFinite(parsedEpoch) ? Math.floor(parsedEpoch / 1000) : 0,
    },
  };
}

function persistNoteWithOutbox(transaction, note, options = {}) {
  const { ttlSeconds = null, nowMs = Date.now() } = options;
  const record = createOutboxRecord(note, nowMs);
  transaction.set(`note:${note.id}`, JSON.stringify(note));
  if (Number.isFinite(ttlSeconds) && ttlSeconds > 0) {
    transaction.expire(`note:${note.id}`, ttlSeconds);
  }
  transaction.hSet(NOTE_EMBEDDING_OUTBOX_KEY, note.id, JSON.stringify(record));
  return record;
}

function createOutboxRecord(note, nowMs = Date.now()) {
  return {
    version: 1,
    note_id: note.id,
    payload: buildNoteEmbeddingPayload(note),
    attempts: 0,
    next_attempt_at: nowMs,
    last_error: null,
    enqueued_at: new Date(nowMs).toISOString(),
  };
}

function retryDelayMs(attempts, initialBackoffMs, maxBackoffMs) {
  return Math.min(initialBackoffMs * (2 ** Math.max(0, attempts - 1)), maxBackoffMs);
}

function createNoteEmbeddingOutbox(options) {
  const {
    redisClient,
    getEmbedUrl,
    signHeaders = () => ({}),
    fetchImpl = globalThis.fetch,
    logger = console,
    now = () => Date.now(),
    initialBackoffMs = 1000,
    maxBackoffMs = 5 * 60 * 1000,
    pollIntervalMs = 1000,
    requestTimeoutMs = 35 * 1000,
    batchSize = 10,
  } = options;

  let timer = null;
  let draining = false;

  async function deliver(record) {
    const embedUrl = getEmbedUrl();
    if (!embedUrl) throw new Error('semantic-search URL is invalid');

    const body = JSON.stringify(record.payload);
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), requestTimeoutMs);
    try {
      const response = await fetchImpl(embedUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...signHeaders(null, 'POST', new URL(embedUrl).pathname, body),
        },
        body,
        signal: ctrl.signal,
      });
      if (!response.ok) {
        const detail = typeof response.text === 'function' ? await response.text() : '';
        throw new Error(`semantic-search HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  async function markFailure(id, record, error) {
    const attempts = Number(record.attempts || 0) + 1;
    const updated = {
      ...record,
      attempts,
      next_attempt_at: now() + retryDelayMs(attempts, initialBackoffMs, maxBackoffMs),
      last_error: String(error && (error.message || error)).slice(0, 1000),
    };
    await redisClient.hSet(NOTE_EMBEDDING_OUTBOX_KEY, id, JSON.stringify(updated));
    logger.warn(`[notes-outbox] ${id} attempt ${attempts} failed; retry scheduled: ${updated.last_error}`);
  }

  async function drainOnce() {
    if (draining || !redisClient.isReady) return 0;
    draining = true;
    let delivered = 0;
    try {
      const pending = await redisClient.hGetAll(NOTE_EMBEDDING_OUTBOX_KEY);
      const due = Object.entries(pending)
        .map(([id, raw]) => {
          try {
            return [id, JSON.parse(raw)];
          } catch (error) {
            logger.error(`[notes-outbox] invalid record ${id}: ${error.message}`);
            return null;
          }
        })
        .filter(Boolean)
        .filter(([, record]) => Number(record.next_attempt_at || 0) <= now())
        .sort((a, b) => Number(a[1].next_attempt_at || 0) - Number(b[1].next_attempt_at || 0))
        .slice(0, batchSize);

      for (const [id, record] of due) {
        try {
          await deliver(record);
          await redisClient.hDel(NOTE_EMBEDDING_OUTBOX_KEY, id);
          delivered += 1;
          logger.log(`[notes-outbox] embedded ${id}`);
        } catch (error) {
          try {
            await markFailure(id, record, error);
          } catch (persistError) {
            logger.error(`[notes-outbox] could not persist retry for ${id}: ${persistError.message}`);
          }
        }
      }
    } catch (error) {
      logger.error(`[notes-outbox] drain failed: ${error.message}`);
    } finally {
      draining = false;
    }
    return delivered;
  }

  function start() {
    if (timer) return;
    timer = setInterval(drainOnce, pollIntervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    setImmediate(drainOnce);
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  function wake() {
    setImmediate(drainOnce);
  }

  return { drainOnce, start, stop, wake };
}

module.exports = {
  NOTE_EMBEDDING_OUTBOX_KEY,
  defaultNoteTtlSeconds,
  buildNoteEmbeddingPayload,
  createOutboxRecord,
  persistNoteWithOutbox,
  retryDelayMs,
  createNoteEmbeddingOutbox,
};
