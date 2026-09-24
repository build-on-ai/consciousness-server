'use strict';

// A lock around one message, held in Redis. The time limit sits before the callback
// runs, never around it: a limit around the work cannot cancel work already started.

const { withTimeout } = require('./store');

const RELEASE_IF_MINE =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

const DEFAULTS = { holdMs: 5000, waitMs: 2000, opTimeoutMs: 2000, stepMs: 20 };

function createRedisLock({ client, newToken = () => require('crypto').randomUUID(), ...opcje }) {
  const { holdMs, waitMs, opTimeoutMs, stepMs } = { ...DEFAULTS, ...opcje };

  // Reading the token and deleting it are one operation: as two, the key can expire
  // between them and the delete would remove someone else's lock.
  async function release(key, token) {
    await withTimeout(
      client.eval(RELEASE_IF_MINE, { keys: [key], arguments: [token] }),
      opTimeoutMs, `lock release ${key}`);
  }

  // Taking the lock and doing the work are separate, because only the taking may be
  // raced against a clock: nothing has happened yet, so giving up is still true.
  async function acquire(key) {
    const token = newToken();
    const deadline = Date.now() + waitMs;
    let porzucone = false;

    for (;;) {
      const proba = client.set(key, token, { NX: true, PX: holdMs });

      // A call that times out is not cancelled, so if it lands after we gave up, its
      // own promise releases the key.
      proba.then(
        (spozniony) => { if (spozniony && porzucone) release(key, token).catch(() => {}); },
        () => {});

      const taken = await withTimeout(proba, opTimeoutMs, `lock take ${key}`,
        () => { porzucone = true; });
      if (taken) break;
      if (Date.now() >= deadline) throw new Error(`a2a lock busy: ${key}`);
      await new Promise(resolve => setTimeout(resolve, stepMs));
    }

    if (Date.now() >= deadline) {
      await release(key, token).catch(() => {});
      throw new Error(`a2a lock take ${key} timed out before it was held`);
    }

    // The lease, so a write can prove it still holds the lock at the moment it lands.
    return { key, token, release: () => release(key, token) };
  }

  async function withLock(key, fn) {
    const dzierzawa = await acquire(key);
    try {
      return await fn(dzierzawa);
    } finally {
      await dzierzawa.release().catch(() => {});
    }
  }

  return { acquire, withLock };
}

module.exports = { createRedisLock, DEFAULTS };
