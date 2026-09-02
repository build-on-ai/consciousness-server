'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { DAY_MS, createChatArchive } = require('../chat-archive');

const silentLogger = { log() {}, warn() {}, error() {} };

function message(index, day = '2026-08-30') {
  return {
    id: `msg-${index}`,
    from: 'test-agent',
    content: `message ${index}`,
    mentions: [],
    timestamp: `${day}T12:${String(index % 60).padStart(2, '0')}:00.000Z`,
  };
}

async function fixture(t, options = {}) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'chat-archive-test-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  return { dir, archive: createChatArchive({ archiveDir: dir, logger: silentLogger, ...options }) };
}

async function readSnapshot(dir, day = '2026-08-30') {
  const body = await fs.promises.readFile(path.join(dir, 'daily', `${day}.jsonl`), 'utf8');
  return body.trim() ? body.trim().split('\n').map(JSON.parse) : [];
}

test('archives every message rather than the API default of 50', async t => {
  const { dir, archive } = await fixture(t);
  const messages = Array.from({ length: 581 }, (_, index) => message(index));
  const result = await archive.run(messages);
  assert.equal(result.snapshot_messages, 581);
  const snapshot = await readSnapshot(dir);
  assert.equal(snapshot.length, 581);
  assert.equal(new Set(snapshot.map(item => item.id)).size, 581);
});

test('repeated runs are idempotent by message id', async t => {
  const { dir, archive } = await fixture(t);
  const messages = [message(1), message(2), message(3)];
  await archive.run(messages);
  await archive.run(messages);
  assert.deepEqual((await readSnapshot(dir)).map(item => item.id), ['msg-1', 'msg-2', 'msg-3']);
  const manifest = JSON.parse(await fs.promises.readFile(path.join(dir, 'daily', '2026-08-30.manifest.json')));
  assert.equal(manifest.count, 3);
  assert.match(manifest.sha256, /^[a-f0-9]{64}$/);
});

test('a message arriving around a snapshot is durable and included on reconciliation', async t => {
  const { dir, archive } = await fixture(t);
  await archive.run([message(1)]);
  await archive.journal(message(2));
  assert.equal(JSON.parse(await fs.promises.readFile(path.join(dir, 'entries', '2026-08-30', 'msg-2.json'))).id, 'msg-2');
  await archive.run([]);
  assert.deepEqual((await readSnapshot(dir)).map(item => item.id), ['msg-1', 'msg-2']);
});

test('journal survives worker restart and is snapshotted by the next instance', async t => {
  const { dir, archive } = await fixture(t);
  await archive.journal(message(7));
  const restarted = createChatArchive({ archiveDir: dir, logger: silentLogger });
  await restarted.run([]);
  assert.deepEqual((await readSnapshot(dir)).map(item => item.id), ['msg-7']);
});

test('unconfigured archive is explicitly disabled and does not report an outage', async () => {
  let clock = Date.parse('2026-08-30T00:00:00Z');
  const archive = createChatArchive({ archiveDir: '', logger: silentLogger, now: () => clock });
  assert.equal(await archive.journal(message(1)), false);
  assert.equal((await archive.run([message(1)])).state, 'disabled');
  assert.equal(archive.getStatus().configured, false);
  assert.equal(archive.getStatus().state, 'disabled');
  assert.equal(archive.getStatus().last_error, null);
  assert.equal(archive.getStatus().overdue, false);

  clock += DAY_MS * 2;
  assert.equal(archive.getStatus().overdue, false);
});

test('a filesystem failure remains visible and a later run is not stuck', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'chat-archive-error-test-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const notDirectory = path.join(root, 'not-a-directory');
  await fs.promises.writeFile(notDirectory, 'x');
  const archive = createChatArchive({ archiveDir: notDirectory, logger: silentLogger });

  await assert.rejects(archive.run([message(1)]));
  assert.equal(archive.getStatus().state, 'error');
  assert.ok(archive.getStatus().last_attempt_at);
  await assert.rejects(archive.run([message(1)]));
});

test('a direct journal failure is immediately visible to health state', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'chat-journal-error-test-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const notDirectory = path.join(root, 'not-a-directory');
  await fs.promises.writeFile(notDirectory, 'x');
  const archive = createChatArchive({ archiveDir: notDirectory, logger: silentLogger });

  await assert.rejects(archive.journal(message(1)));
  assert.equal(archive.getStatus().state, 'error');
  assert.equal(archive.getStatus().last_error_source, 'journal');
  assert.ok(archive.getStatus().last_error);
  assert.equal(archive.getStatus().overdue, true);
});
