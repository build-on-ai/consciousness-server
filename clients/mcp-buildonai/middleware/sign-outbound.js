'use strict';

const crypto = require('crypto');
const fs = require('fs');

let cachedKey;
let cachedKeyPath;

function ed25519Pkcs8(parsedKey) {
  const seed = parsedKey.part.k.data.slice(0, 32);
  if (seed.length !== 32) {
    throw new Error(`expected a 32-byte ed25519 seed, got ${seed.length}`);
  }
  const header = Buffer.from('302e020100300506032b657004220420', 'hex');
  return {
    key: Buffer.concat([header, seed]),
    format: 'der',
    type: 'pkcs8',
  };
}

function loadSigningKey() {
  const keyPath = (process.env.CS_SIGNING_KEY || '').trim();
  if (!keyPath) return null;

  if (cachedKey !== undefined && cachedKeyPath === keyPath) return cachedKey;
  cachedKeyPath = keyPath;

  try {
    const sshpk = require('sshpk');
    const parsed = sshpk.parsePrivateKey(fs.readFileSync(keyPath), 'auto');
    if (parsed.type !== 'ed25519') {
      throw new Error(`key is ${parsed.type}; only ed25519 is accepted`);
    }
    cachedKey = crypto.createPrivateKey(ed25519Pkcs8(parsed));
  } catch (err) {
    cachedKey = undefined;
    throw new Error(
      `[sign-outbound] CS_SIGNING_KEY=${keyPath} unusable: ${err.message}`
    );
  }
  return cachedKey;
}

function assertUsable() {
  loadSigningKey();
}

function signHeaders(agentId, method, path, body) {
  const key = loadSigningKey();
  if (!key) return {};

  const id = agentId || (process.env.CS_AGENT_ID || '').trim() || 'cs-core';
  const timestamp = new Date().toISOString().split('.')[0] + 'Z';
  const nonce = crypto.randomBytes(16).toString('hex');
  const cleanPath = String(path || '/').split('?')[0];
  const bodyBytes = Buffer.isBuffer(body)
    ? body
    : Buffer.from(body || '', 'utf8');
  const bodySha256 = crypto.createHash('sha256').update(bodyBytes).digest('hex');

  const canonical = [
    String(method || '').toUpperCase(),
    cleanPath,
    timestamp,
    nonce,
    bodySha256,
  ].join('\n');

  const signature = crypto
    .sign(null, Buffer.from(canonical, 'utf8'), key)
    .toString('base64');

  return {
    'X-Agent-Id': id,
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
    'X-Signature': signature,
  };
}

module.exports = { signHeaders, assertUsable };
