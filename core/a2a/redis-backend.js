'use strict';

// The store's side of Redis. A command that changes state is never raced against a
// clock, because a limit cannot cancel a write; reads may be bounded.

const { withTimeout } = require('./store');
const { setOptionsFor } = require('../retention');

const LOCK_SUFFIX = ':lock';

// Holding the lock when the work began does not mean holding it when the write
// lands, so the check and the write are one command and a refusal is certain.
const WRITE_IF_LOCK_HELD =
  'if redis.call("get", KEYS[2]) ~= ARGV[2] then return 0 end '
  + 'if ARGV[3] == "" then redis.call("set", KEYS[1], ARGV[1]) '
  + 'else redis.call("set", KEYS[1], ARGV[1], "PX", ARGV[3]) end return 1';

function createRedisBackend({ client, persist, isReady, ttlSeconds = () => null, namespace = 'a2a:message:', opTimeoutMs = 2000 }) {
  return {
    async save(key, value, fencing) {
      if (!isReady()) {
        // Refused before anything was sent, so what happened is not in doubt.
        const err = new Error('redis is not connected');
        err.attempted = false;
        throw err;
      }

      if (!fencing) return persist(key, value);

      // The conditional write carries the retention policy itself, read from the same
      // source the ordinary write reads.
      const opcje = setOptionsFor(ttlSeconds());
      const wszedl = await client.eval(WRITE_IF_LOCK_HELD, {
        keys: [key, fencing.key],
        arguments: [JSON.stringify(value), fencing.token, opcje.PX ? String(opcje.PX) : ''],
      });
      if (!wszedl) {
        const err = new Error(`lock ${fencing.key} is no longer held by this caller`);
        err.fenced = true;
        throw err;
      }
    },

    // Settles what actually happened when a write reports an error.
    async read(key) {
      return withTimeout(client.get(key), opTimeoutMs, `a2a read ${key}`);
    },

    async loadAll() {
      const keys = await withTimeout(client.keys(`${namespace}*`), opTimeoutMs, 'a2a hydrate');
      const rows = [];
      for (const key of keys) {
        if (key.endsWith(LOCK_SUFFIX)) continue;
        const data = await withTimeout(client.get(key), opTimeoutMs, `a2a read ${key}`);
        if (data) rows.push(data);
      }
      return rows;
    },
  };
}

module.exports = { createRedisBackend };
