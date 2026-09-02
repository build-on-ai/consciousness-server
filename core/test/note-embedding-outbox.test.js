'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  NOTE_EMBEDDING_OUTBOX_KEY,
  defaultNoteTtlSeconds,
  buildNoteEmbeddingPayload,
  createOutboxRecord,
  persistNoteWithOutbox,
  retryDelayMs,
  createNoteEmbeddingOutbox,
} = require('../note-embedding-outbox');

class FakeRedis {
  constructor(records = {}) {
    this.records = { ...records };
    this.isReady = true;
  }

  async hGetAll(key) {
    assert.equal(key, NOTE_EMBEDDING_OUTBOX_KEY);
    return { ...this.records };
  }

  async hSet(key, id, value) {
    assert.equal(key, NOTE_EMBEDDING_OUTBOX_KEY);
    this.records[id] = value;
  }

  async hDel(key, id) {
    assert.equal(key, NOTE_EMBEDDING_OUTBOX_KEY);
    delete this.records[id];
  }
}

const silentLogger = { log() {}, warn() {}, error() {} };

function sampleNote() {
  return {
    id: 'note-1',
    agent: 'agent-a',
    type: 'decision',
    title: 'Keep knowledge durable',
    content: 'Notes must be searchable.',
    tags: ['not-sent-to-chroma'],
    metadata: { session_id: 'session-7', project: 'cs', ignored: ['array'] },
    created_at: '2026-08-30T12:00:00.000Z',
  };
}

test('builds an idempotent notes upsert with scalar metadata only', () => {
  const payload = buildNoteEmbeddingPayload(sampleNote());
  assert.deepEqual(payload, {
    collection: 'notes',
    id: 'note-1',
    text: 'Keep knowledge durable\n\nNotes must be searchable.',
    metadata: {
      session_id: 'session-7',
      project: 'cs',
      agent: 'agent-a',
      kind: 'knowledge',
      created_at: '2026-08-30T12:00:00.000Z',
      created_epoch: 1788091200,
    },
  });
  assert.ok(Object.values(payload.metadata).every(value => ['string', 'number', 'boolean'].includes(typeof value)));
});

test('retains knowledge notes and expires telemetry after 30 days', () => {
  assert.equal(defaultNoteTtlSeconds({ agent: 'agent-a' }), null);
  assert.equal(defaultNoteTtlSeconds({ agent: 'machines-monitor' }), 30 * 24 * 3600);
  assert.equal(defaultNoteTtlSeconds({ agent: 'machines-monitor', expires_at: '2026-09-01T00:00:00Z' }), null);
});

test('uses safe scalar defaults when optional note metadata is absent', () => {
  const payload = buildNoteEmbeddingPayload({
    id: 'note-2', agent: 'agent-b', type: 'observation', title: 'Title', content: '',
    metadata: null, created_at: 'invalid',
  });
  assert.equal(payload.metadata.session_id, '');
  assert.equal(payload.metadata.project, '');
  assert.equal(payload.metadata.kind, 'knowledge');
  assert.equal(payload.metadata.created_epoch, 0);
});

test('classifies checkpoint-shaped content as transcript unless explicitly overridden', () => {
  const note = sampleNote();
  note.content = '[USER] question\n[ASSISTANT] answer';
  assert.equal(buildNoteEmbeddingPayload(note).metadata.kind, 'transcript');
  note.metadata.kind = 'knowledge';
  assert.equal(buildNoteEmbeddingPayload(note).metadata.kind, 'knowledge');
});

test('persists the note and outbox atomically in one Redis transaction', () => {
  const calls = [];
  const transaction = {
    set: (...args) => calls.push(['set', ...args]),
    expire: (...args) => calls.push(['expire', ...args]),
    hSet: (...args) => calls.push(['hSet', ...args]),
  };
  persistNoteWithOutbox(transaction, sampleNote(), { ttlSeconds: 3600, nowMs: 1000 });
  assert.equal(calls[0][0], 'set');
  assert.deepEqual(calls[1], ['expire', 'note:note-1', 3600]);
  assert.equal(calls[2][0], 'hSet');
  assert.equal(calls[2][1], NOTE_EMBEDDING_OUTBOX_KEY);
  assert.equal(JSON.parse(calls[2][3]).note_id, 'note-1');
});

test('retry delay is exponential and capped', () => {
  assert.equal(retryDelayMs(1, 1000, 5000), 1000);
  assert.equal(retryDelayMs(2, 1000, 5000), 2000);
  assert.equal(retryDelayMs(9, 1000, 5000), 5000);
});

test('successful delivery removes the durable outbox record', async () => {
  const record = createOutboxRecord(sampleNote(), 1000);
  const redis = new FakeRedis({ 'note-1': JSON.stringify(record) });
  let request;
  const worker = createNoteEmbeddingOutbox({
    redisClient: redis,
    getEmbedUrl: () => 'http://semantic:3037/api/embed',
    signHeaders: () => ({ 'X-Test-Signature': 'yes' }),
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, text: async () => '' };
    },
    logger: silentLogger,
    now: () => 1000,
  });

  assert.equal(await worker.drainOnce(), 1);
  assert.deepEqual(redis.records, {});
  assert.equal(request.url, 'http://semantic:3037/api/embed');
  assert.equal(request.options.headers['X-Test-Signature'], 'yes');
  assert.deepEqual(JSON.parse(request.options.body), record.payload);
});

test('failed delivery remains durable with persisted exponential backoff', async () => {
  const record = createOutboxRecord(sampleNote(), 1000);
  const redis = new FakeRedis({ 'note-1': JSON.stringify(record) });
  const worker = createNoteEmbeddingOutbox({
    redisClient: redis,
    getEmbedUrl: () => 'http://semantic:3037/api/embed',
    fetchImpl: async () => ({ ok: false, status: 503, text: async () => 'ollama down' }),
    logger: silentLogger,
    now: () => 1000,
    initialBackoffMs: 250,
    maxBackoffMs: 1000,
  });

  assert.equal(await worker.drainOnce(), 0);
  const pending = JSON.parse(redis.records['note-1']);
  assert.equal(pending.attempts, 1);
  assert.equal(pending.next_attempt_at, 1250);
  assert.match(pending.last_error, /HTTP 503/);
});

test('a persisted failure can be delivered by a new worker after restart', async () => {
  const record = { ...createOutboxRecord(sampleNote(), 1000), attempts: 3, next_attempt_at: 2000 };
  const redis = new FakeRedis({ 'note-1': JSON.stringify(record) });
  const worker = createNoteEmbeddingOutbox({
    redisClient: redis,
    getEmbedUrl: () => 'http://semantic:3037/api/embed',
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '' }),
    logger: silentLogger,
    now: () => 2000,
  });

  assert.equal(await worker.drainOnce(), 1);
  assert.deepEqual(redis.records, {});
});
