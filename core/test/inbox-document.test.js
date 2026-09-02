'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {
  InboxValidationError,
  deterministicUuid,
  fingerprintEnvelope,
  parseInboxEnvelope,
  storeAttachment,
  buildInboxNote,
} = require('../inbox-document');

function envelope(overrides = {}) {
  const attachment = Buffer.from('original document bytes');
  return {
    idempotency_key: 'folder:machine-catalogue:42',
    source_kind: 'document',
    original_name: '../../catalogue.pdf',
    mime_type: 'application/pdf',
    sha256: crypto.createHash('sha256').update(attachment).digest('hex'),
    size: attachment.length,
    attachment_base64: attachment.toString('base64'),
    title: 'Machine catalogue',
    content: 'Parsed searchable content',
    metadata: { project: 'machines', session_id: 'inbox-1', ignored: ['array'] },
    ...overrides,
  };
}

test('rejects a deliberately wrong attachment hash', () => {
  assert.throws(
    () => parseInboxEnvelope(envelope({ sha256: '0'.repeat(64) })),
    error => error instanceof InboxValidationError && error.status === 422,
  );
});

test('rejects unsupported source and oversized attachments', () => {
  assert.throws(() => parseInboxEnvelope(envelope({ source_kind: 'unknown' })), /source_kind/);
  assert.throws(() => parseInboxEnvelope(envelope(), 4), error => error.status === 413);
});

test('stores the original by sha256 and cannot traverse with original_name', async t => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'inbox-attachment-test-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const parsed = parseInboxEnvelope(envelope());
  const stored = await storeAttachment(dir, parsed);
  assert.equal(path.dirname(stored), dir);
  assert.equal(path.basename(stored), parsed.sha256);
  assert.equal((await fs.promises.readFile(stored)).toString(), 'original document bytes');
});

test('repeated attachment storage and note identity are idempotent', async t => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'inbox-idempotency-test-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const parsed = parseInboxEnvelope(envelope());
  assert.equal(await storeAttachment(dir, parsed), await storeAttachment(dir, parsed));
  assert.equal(
    deterministicUuid(`inbox:${parsed.idempotency_key}`),
    deterministicUuid(`inbox:${parsed.idempotency_key}`),
  );
});

test('idempotency fingerprint ignores metadata key order but detects changed content', () => {
  const first = parseInboxEnvelope(envelope({ metadata: { project: 'machines', session_id: 's1' } }));
  const reordered = parseInboxEnvelope(envelope({ metadata: { session_id: 's1', project: 'machines' } }));
  const changed = parseInboxEnvelope(envelope({ content: 'different parsed content' }));
  assert.equal(fingerprintEnvelope(first), fingerprintEnvelope(reordered));
  assert.notEqual(fingerprintEnvelope(first), fingerprintEnvelope(changed));
});

test('builds a private durable note with attachment provenance', () => {
  const parsed = parseInboxEnvelope(envelope());
  const note = buildInboxNote(parsed, 'human-inbox', '2026-08-30T20:00:00.000Z');
  assert.equal(note.visibility, 'user');
  assert.equal(note.expires_at, null);
  assert.equal(note.metadata.attachment_id, parsed.sha256);
  assert.equal(note.metadata.attachment_name, 'catalogue.pdf');
  assert.equal(note.metadata.kind, 'knowledge');
  assert.equal(note.metadata.project, 'machines');
});
