'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DAY_MS = 24 * 60 * 60 * 1000;

function dayOf(timestamp) {
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.getTime())) throw new Error('chat message timestamp is invalid');
  return parsed.toISOString().slice(0, 10);
}

function safeId(id) {
  const value = String(id || '');
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('chat message id is invalid');
  return value;
}

async function writeAtomic(filename, content) {
  await fs.promises.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.promises.open(temporary, 'wx', 0o600);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(temporary, filename);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.promises.unlink(temporary).catch(() => {});
  }
}

function createChatArchive(options = {}) {
  const archiveDir = options.archiveDir || '';
  const logger = options.logger || console;
  const now = options.now || (() => Date.now());
  const intervalMs = options.intervalMs || 60 * 60 * 1000;
  const entriesDir = archiveDir ? path.join(archiveDir, 'entries') : '';
  const snapshotsDir = archiveDir ? path.join(archiveDir, 'daily') : '';
  const statusPath = archiveDir ? path.join(archiveDir, 'status.json') : '';
  let timer = null;
  let running = null;
  let status = {
    configured: Boolean(archiveDir),
    state: archiveDir ? 'pending' : 'disabled',
    last_attempt_at: null,
    last_success_at: null,
    last_error: null,
    last_error_source: null,
    archived_messages: 0,
    snapshot_messages: 0,
  };

  async function persistStatus() {
    if (!archiveDir) return;
    await writeAtomic(statusPath, `${JSON.stringify(status, null, 2)}\n`);
  }

  async function loadStatus() {
    if (!archiveDir) return;
    try {
      status = { ...status, ...JSON.parse(await fs.promises.readFile(statusPath, 'utf8')) };
    } catch (error) {
      if (error.code !== 'ENOENT') logger.warn(`[chat-archive] status read failed: ${error.message}`);
    }
  }

  async function journal(message) {
    if (!archiveDir) return false;
    const id = safeId(message && message.id);
    const day = dayOf(message && message.timestamp);
    const filename = path.join(entriesDir, day, `${id}.json`);
    try {
      try {
        await fs.promises.access(filename, fs.constants.F_OK);
        return false;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await writeAtomic(filename, `${JSON.stringify(message)}\n`);
      if (status.last_error_source === 'journal') {
        status = {
          ...status,
          state: status.last_success_at ? 'ok' : 'pending',
          last_error: null,
          last_error_source: null,
        };
        await persistStatus();
      }
      return true;
    } catch (error) {
      status = {
        ...status,
        state: 'error',
        last_attempt_at: new Date(now()).toISOString(),
        last_error: String(error.message || error),
        last_error_source: 'journal',
      };
      await persistStatus().catch(() => {});
      throw error;
    }
  }

  async function listDays() {
    try {
      return (await fs.promises.readdir(entriesDir, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
        .map(entry => entry.name)
        .sort();
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async function snapshotDay(day) {
    const dir = path.join(entriesDir, day);
    const names = (await fs.promises.readdir(dir))
      .filter(name => name.endsWith('.json'))
      .sort();
    const messages = [];
    for (const name of names) {
      messages.push(JSON.parse(await fs.promises.readFile(path.join(dir, name), 'utf8')));
    }
    messages.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)) || String(a.id).localeCompare(String(b.id)));
    const body = messages.map(message => JSON.stringify(message)).join('\n') + (messages.length ? '\n' : '');
    const digest = crypto.createHash('sha256').update(body).digest('hex');
    await writeAtomic(path.join(snapshotsDir, `${day}.jsonl`), body);
    await writeAtomic(path.join(snapshotsDir, `${day}.manifest.json`), `${JSON.stringify({
      day,
      count: messages.length,
      sha256: digest,
      generated_at: new Date(now()).toISOString(),
    }, null, 2)}\n`);
    return messages.length;
  }

  async function run(messages = []) {
    if (!archiveDir) return { ...status };
    if (running) return running;
    running = (async () => {
      const attemptAt = new Date(now()).toISOString();
      status = { ...status, state: 'running', last_attempt_at: attemptAt, last_error: null };
      try {
        await persistStatus();
        for (const message of messages) {
          await journal(message);
        }
        let snapshotMessages = 0;
        for (const day of await listDays()) snapshotMessages += await snapshotDay(day);
        status = {
          ...status,
          state: 'ok',
          last_success_at: new Date(now()).toISOString(),
          last_error: null,
          last_error_source: null,
          archived_messages: snapshotMessages,
          snapshot_messages: snapshotMessages,
        };
        await persistStatus();
        logger.log(`[chat-archive] snapshot complete: ${snapshotMessages} messages`);
        return { ...status };
      } catch (error) {
        status = {
          ...status,
          state: 'error',
          last_error: String(error.message || error),
          last_error_source: 'snapshot',
        };
        await persistStatus().catch(() => {});
        logger.error(`[chat-archive] failed: ${status.last_error}`);
        throw error;
      } finally {
        running = null;
      }
    })();
    return running;
  }

  async function start(getMessages) {
    if (!archiveDir) return;
    if (timer) {
      await run(getMessages());
      return;
    }
    await loadStatus();
    await run(getMessages());
    timer = setInterval(() => {
      const last = status.last_success_at ? Date.parse(status.last_success_at) : 0;
      if (!last || now() - last >= DAY_MS) run(getMessages()).catch(() => {});
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function getStatus() {
    if (!archiveDir) return { ...status, overdue: false, next_due_at: null };
    const last = status.last_success_at ? Date.parse(status.last_success_at) : 0;
    const overdue = !last || now() - last > DAY_MS + intervalMs;
    return { ...status, overdue, next_due_at: last ? new Date(last + DAY_MS).toISOString() : null };
  }

  return { journal, run, start, stop, getStatus };
}

module.exports = { DAY_MS, dayOf, createChatArchive };
