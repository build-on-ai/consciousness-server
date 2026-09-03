'use strict';

const HOUR_SECONDS = 3600;
const DAY_SECONDS = 24 * HOUR_SECONDS;

// null means the key never expires.
const RETENTION_SECONDS = Object.freeze({
  agent: HOUR_SECONDS,
  brainstorm: null,
  chat: 30 * DAY_SECONDS,
  conversation: 90 * DAY_SECONDS,
  'inbox.result': null,
  log: 7 * DAY_SECONDS,
  note: null,
  'note.telemetry': 7 * DAY_SECONDS,
  summary: 90 * DAY_SECONDS,
  task: null,
  'task.finished': 30 * DAY_SECONDS,
  training: null,
});

// Agents whose notes are machine telemetry rather than knowledge.
const TELEMETRY_AGENTS = new Set(['machines-monitor']);

// Throws rather than returning undefined, which a caller would read as "no expiry".
function retentionSeconds(kind) {
  if (!Object.prototype.hasOwnProperty.call(RETENTION_SECONDS, kind)) {
    throw new Error(`unknown retention kind: ${kind}`);
  }
  return RETENTION_SECONDS[kind];
}

// An explicit expires_at is the caller's own deadline; do not add a second one.
function noteRetentionSeconds(note) {
  const telemetry = Boolean(note) && !note.expires_at && TELEMETRY_AGENTS.has(note.agent);
  return retentionSeconds(telemetry ? 'note.telemetry' : 'note');
}

function taskRetentionSeconds(task) {
  const finished = Boolean(task) && (task.status === 'DONE' || task.status === 'FAILED');
  return retentionSeconds(finished ? 'task.finished' : 'task');
}

module.exports = {
  RETENTION_SECONDS,
  TELEMETRY_AGENTS,
  retentionSeconds,
  noteRetentionSeconds,
  taskRetentionSeconds,
};
