'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RETENTION_SECONDS,
  retentionSeconds,
  noteRetentionSeconds,
  taskRetentionSeconds,
} = require('../retention');

test('retains knowledge notes and expires telemetry after 7 days', () => {
  assert.equal(noteRetentionSeconds({ agent: 'agent-a' }), null);
  assert.equal(noteRetentionSeconds({ agent: 'machines-monitor' }), 7 * 24 * 3600);
  assert.equal(noteRetentionSeconds({ agent: 'machines-monitor', expires_at: '2026-09-01T00:00:00Z' }), null);
});

test('expires a task only once it is finished', () => {
  assert.equal(taskRetentionSeconds({ status: 'IN_PROGRESS' }), null);
  assert.equal(taskRetentionSeconds({ status: 'DONE' }), 30 * 24 * 3600);
  assert.equal(taskRetentionSeconds({ status: 'FAILED' }), 30 * 24 * 3600);
});

test('rejects an unknown kind', () => {
  assert.throws(() => retentionSeconds('nope'), /unknown retention kind: nope/);
  assert.throws(() => retentionSeconds('toString'), /unknown retention kind/);
});

test('states a term for every persisted kind', () => {
  const persisted = ['agent', 'brainstorm', 'chat', 'conversation', 'inbox.result', 'log', 'note', 'summary', 'task', 'training'];
  for (const kind of persisted) {
    const seconds = retentionSeconds(kind);
    assert.ok(seconds === null || seconds > 0, `${kind} has no usable term`);
  }
});

test('keeps the table immutable at runtime', () => {
  assert.throws(() => { RETENTION_SECONDS.chat = 1; }, TypeError);
});
