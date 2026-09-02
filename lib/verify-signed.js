'use strict';

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { Readable } = require('stream');
const { URL } = require('url');


const KEY_SERVER_URL = (process.env.KEY_SERVER_URL || 'http://key-server:3040').replace(/\/$/, '');
const VERIFY_TIMEOUT_MS = parseInt(process.env.AUTH_VERIFY_TIMEOUT_MS || '2000', 10);

const ALWAYS_OPEN_PATHS = new Set(['/health', '/metrics']);

function headerValue(headers, name) {
  if (!headers) return null;
  const direct = headers[name] ?? headers[name.toLowerCase()];
  if (direct !== undefined) return direct;
  return headers[name.toLowerCase()] ?? null;
}

function shouldSkip(method, reqPath, headers) {
  if ((method || '').toUpperCase() === 'OPTIONS') return true;
  if (ALWAYS_OPEN_PATHS.has(reqPath)) return true;
  const upgrade = headerValue(headers, 'upgrade');
  if (upgrade && String(upgrade).toLowerCase() === 'websocket') return true;
  return false;
}

function bodySha256(bodyBytes) {
  return crypto.createHash('sha256').update(bodyBytes || Buffer.alloc(0)).digest('hex');
}

function verifySignedRequest({ headers, method, path: reqPath, bodyBytes }) {
  return new Promise((resolve) => {
    const agentId = headerValue(headers, 'X-Agent-Id');
    const timestamp = headerValue(headers, 'X-Timestamp');
    const nonce = headerValue(headers, 'X-Nonce');
    const signature = headerValue(headers, 'X-Signature');

    if (!agentId || !timestamp || !nonce || !signature) {
      resolve({ valid: false, reason: 'missing_headers' });
      return;
    }

    const payload = JSON.stringify({
      agent_id: agentId,
      timestamp,
      nonce,
      method: String(method || '').toUpperCase(),
      path: reqPath || '/',
      body_sha256: bodySha256(bodyBytes),
      signature,
    });

    let url;
    try {
      url = new URL(`${KEY_SERVER_URL}/api/verify`);
    } catch (_err) {
      resolve({ valid: false, reason: 'key_server_url_invalid' });
      return;
    }

    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + (url.search || ''),
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: VERIFY_TIMEOUT_MS,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch (_e) { }

          if (parsed && parsed.valid === true) {
            resolve({ valid: true, agent_id: parsed.agent_id || agentId });
            return;
          }
          if (parsed && parsed.reason) {
            resolve({ valid: false, reason: String(parsed.reason) });
            return;
          }
          resolve({ valid: false, reason: `key_server_http_${res.statusCode}` });
        });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      resolve({ valid: false, reason: 'key_server_unreachable' });
    });
    req.on('error', () => {
      resolve({ valid: false, reason: 'key_server_unreachable' });
    });
    req.write(payload);
    req.end();
  });
}

function reinjectBody(req, bodyBytes) {
  const ct = headerValue(req.headers, 'content-type') || '';
  const isJson = /^application\/json\b/i.test(ct);

  if (isJson) {
    try {
      req.body = bodyBytes.length ? JSON.parse(bodyBytes.toString('utf8')) : {};
    } catch (_e) {
      req.body = {};
    }
    req._body = true;
  } else {
    req.body = bodyBytes;
  }

  const replay = Readable.from(bodyBytes.length ? [bodyBytes] : []);
  req.read  = replay.read.bind(replay);
  req.pipe  = replay.pipe.bind(replay);
  req.unpipe = replay.unpipe.bind(replay);
  req[Symbol.asyncIterator] = replay[Symbol.asyncIterator].bind(replay);

  const origOn = req.on.bind(req);
  req.on = (event, listener) => {
    if (event === 'data' || event === 'end' || event === 'readable' || event === 'close') {
      return replay.on(event, listener);
    }
    return origOn(event, listener);
  };
  const origOnce = req.once.bind(req);
  req.once = (event, listener) => {
    if (event === 'data' || event === 'end' || event === 'readable' || event === 'close') {
      return replay.once(event, listener);
    }
    return origOnce(event, listener);
  };
}

function attachToServer(server, handler) {
  return function gatedHandler(req, res) {
    const method = req.method || 'GET';
    const reqPath = (req.url || '/').split('?', 1)[0];

    if (shouldSkip(method, reqPath, req.headers)) {
      handler(req, res);
      return;
    }
    const MAX_BODY = 16 * 1024 * 1024;
    const chunks = [];
    let total = 0;
    let aborted = false;

    req.on('data', (c) => {
      total += c.length;
      if (total > MAX_BODY) {
        aborted = true;
        req.destroy();
        return;
      }
      chunks.push(c);
    });

    req.on('end', async () => {
      if (aborted) return;
      const bodyBytes = Buffer.concat(chunks);

      const verdict = await verifySignedRequest({
        headers: req.headers,
        method,
        path: reqPath,
        bodyBytes,
      });

      if (verdict.valid) {
        reinjectBody(req, bodyBytes);
        req._verifiedAgent = verdict.agent_id;
        handler(req, res);
        return;
      }

      const reason = verdict.reason || 'invalid';

      const status = reason === 'key_server_unreachable' ? 503 : 401;
      const payload = JSON.stringify({ error: 'unauthorized', reason });
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(payload);
    });

    req.on('error', () => {
      try {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad_request' }));
      } catch (_err) { }
    });
  };
}

module.exports = {
  KEY_SERVER_URL,
  verifySignedRequest,
  attachToServer,
};
