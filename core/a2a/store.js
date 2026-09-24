'use strict';

// Durable state for A2A messages: written before success is reported, changed only
// through allowed transitions, serialised per message. The backend is injected.

const crypto = require('crypto');

const NAMESPACE = 'a2a:message:';

// Locks live outside the message namespace: hydration scans that namespace and
// parses what it finds, and a lock token is not a message.
const LOCK_NAMESPACE = 'a2a:lock:';

// The whole lifecycle. A message may be acknowledged without being fetched first, and
// nothing follows an acknowledgement.
const ALLOWED_TRANSITIONS = Object.freeze({
  pending: Object.freeze(['delivered', 'acked']),
  delivered: Object.freeze(['acked']),
  acked: Object.freeze([]),
});

// Thrown when the message could not be written down; a message only in memory is not
// queued. outcome: 'not-written' when the old value is still there, else 'unknown'.
class StoreUnavailable extends Error {
  constructor(cause, outcome = 'not-written') {
    super(`a2a store unavailable: ${cause.message}`);
    this.name = 'StoreUnavailable';
    this.cause = cause;
    this.outcome = outcome;
  }
}

// A task nothing follows cannot take more messages either: a client with something
// more to say starts a new one.
class TaskClosed extends Error {
  constructor(status) {
    super(`task is ${status} and takes no further messages`);
    this.name = 'TaskClosed';
    this.status = status;
  }
}

class TransitionRefused extends Error {
  constructor(from, to) {
    super(`transition ${from} -> ${to} is not allowed`);
    this.name = 'TransitionRefused';
    this.from = from;
    this.to = to;
  }
}

// Two records are the same value when they hold the same fields, whatever order
// they were serialised in.
function canonical(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

function keyFor(id) {
  return `${NAMESPACE}${id}`;
}

function lockKeyFor(id) {
  return `${LOCK_NAMESPACE}${id}`;
}

// A store that never answers leaves the caller waiting, so a call that cannot complete
// is turned into a refusal.
function withTimeout(promise, ms, what, onTimeout) {
  // Deliberately not unref'd: an unref'd timer lets an idle process finish and the
  // timeout never fires. It is cleared as soon as the race settles.
  let timer;
  const expiry = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      if (onTimeout) onTimeout();
      reject(new Error(`${what} timed out after ${ms}ms`));
    }, ms);
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

function createStore({ backend, now = () => new Date().toISOString(), newId = () => crypto.randomUUID(), lockTimeoutMs = 5000 }) {
  const messages = new Map();
  const problems = [];

  // A write reporting an error may still have arrived, so the key settles it: the new
  // value is proof it did, the previous one proof it did not, anything else is neither.
  async function write(message, previous = null, lease = null) {
    const key = keyFor(message.id);
    try {
      await backend.save(key, message, lease ? { key: lease.key, token: lease.token } : undefined);
    } catch (err) {
      // A write we did not send needs no check: nothing can have arrived. Neither does
      // one the lock refused: that check and the write were one operation.
      if (err.attempted === false || err.fenced) throw new StoreUnavailable(err, 'not-written');

      let surowe;
      try {
        surowe = await backend.read(key);
      } catch (_err) {
        throw new StoreUnavailable(err, 'unknown');
      }

      let zapisane = null;
      if (surowe !== null && surowe !== undefined) {
        try {
          zapisane = typeof surowe === 'string' ? JSON.parse(surowe) : surowe;
        } catch (_err) {
          throw new StoreUnavailable(err, 'unknown');
        }
      }

      const znalezione = canonical(zapisane);
      if (znalezione === canonical(message)) {
        // It arrived; only the reply was lost.
      } else if (znalezione === canonical(previous)) {
        // Exactly the state this call set out to replace — for a new message, no key
        // at all — so nothing landed.
        throw new StoreUnavailable(err, 'not-written');
      } else {
        // Neither the intended value nor the one replaced: this proves nothing, and
        // the store outranks whatever this process believed.
        if (zapisane === null) messages.delete(message.id);
        else messages.set(message.id, zapisane);
        throw new StoreUnavailable(err, 'unknown');
      }
    }
    messages.set(message.id, message);
    return message;
  }

  // Every path that changes a message goes through here: the lock, the limit on
  // taking it, and the refusal, in one place.
  async function withGuardedLock(id, fn) {
    let dzierzawa;
    try {
      // Only the taking is raced against the clock: until it succeeds nothing has
      // happened, so a refusal here is true and stays true.
      dzierzawa = await withTimeout(backend.acquire(lockKeyFor(id)), lockTimeoutMs, `a2a lock ${id}`);
    } catch (err) {
      throw new StoreUnavailable(err);
    }

    try {
      // The work itself is not raced: an answer must describe the store.
      return await fn(dzierzawa);
    } catch (err) {
      if (err instanceof StoreUnavailable || err instanceof TransitionRefused
          || err instanceof TaskClosed) throw err;
      throw new StoreUnavailable(err);
    } finally {
      await dzierzawa.release().catch(() => {});
    }
  }

  async function add({ from, to, type, payload, priority, requires_ack: requiresAck }) {
    const at = now();
    return write({
      id: newId(),
      from,
      to,
      type,
      payload: payload || {},
      priority: priority || 'normal',
      requires_ack: requiresAck || false,
      status: 'pending',
      created_at: at,
      history: [{ from: null, to: 'pending', at, by: from }],
    });
  }

  // Runs under a per-message lock, so a concurrent caller reads the state this one wrote
  // rather than the one it started from.
  async function transition(id, to, { by } = {}) {
    if (!by) throw new Error('transition needs a by: the signed identity making it');

    return withGuardedLock(id, async (dzierzawa) => {
      const current = messages.get(id);
      if (!current) return null;

      // Asking for the state it already holds is not a change, so the first timestamp
      // stands.
      if (current.status === to) return current;

      const allowed = ALLOWED_TRANSITIONS[current.status] || [];
      if (!allowed.includes(to)) throw new TransitionRefused(current.status, to);

      const at = now();
      const next = {
        ...current,
        status: to,
        history: [...current.history, { from: current.status, to, at, by }],
        ...(to === 'delivered' ? { delivered_at: at } : {}),
        ...(to === 'acked' ? { acked_at: at } : {}),
      };
      return write(next, current, dzierzawa);
    });
  }

  // A message naming a task joins that record under the same guarded lock. It is not a
  // state transition, so the status history says nothing about it.
  async function append(id, message, { by } = {}) {
    if (!by) throw new Error('append needs a by: the signed identity adding the message');

    return withGuardedLock(id, async (dzierzawa) => {
      const current = messages.get(id);
      if (!current) return null;
      if ((ALLOWED_TRANSITIONS[current.status] || []).length === 0) throw new TaskClosed(current.status);

      return write({ ...current, followups: [...(current.followups || []), message] }, current, dzierzawa);
    });
  }

  async function hydrate() {
    const rows = await backend.loadAll();
    messages.clear();
    problems.length = 0;
    for (const row of rows) {
      let message = row;
      if (typeof row === 'string') {
        try {
          message = JSON.parse(row);
        } catch (err) {
          // Locks live elsewhere, so anything unreadable here is a damaged message.
          // The set is served without it, and the caller is told what it lost.
          problems.push(`niecz\u0079telny wpis pomini\u0119ty: ${err.message}`);
          continue;
        }
      }
      if (message && message.id) messages.set(message.id, message);
    }
    return messages.size;
  }

  function get(id) {
    return messages.get(id) || null;
  }

  function forRecipient(agent, { status } = {}) {
    const wanted = String(agent).toUpperCase();
    return [...messages.values()].filter(m =>
      String(m.to).toUpperCase() === wanted && (!status || m.status === status));
  }

  function all() {
    return [...messages.values()];
  }

  function countsByStatus() {
    const counts = { pending: 0, delivered: 0, acked: 0 };
    for (const message of messages.values()) {
      if (message.status in counts) counts[message.status] += 1;
    }
    return counts;
  }

  return { add, append, transition, hydrate, get, forRecipient, all, countsByStatus, hydrationProblems: () => [...problems] };
}

module.exports = {
  NAMESPACE,
  LOCK_NAMESPACE,
  lockKeyFor,
  withTimeout,
  ALLOWED_TRANSITIONS,
  StoreUnavailable,
  TransitionRefused,
  TaskClosed,
  createStore,
};
