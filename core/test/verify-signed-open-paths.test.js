'use strict';

// The gate wraps the whole server, so what it does not open needs four headers.
// Discovery is readable before a client has an identity; everything else stays shut.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { shouldSkip, ALWAYS_OPEN_PATHS, PUBLIC_READ_PATHS } = require('../middleware/verify-signed');

test('discovery jest czytelne bez podpisu', () => {
  assert.equal(shouldSkip('GET', '/.well-known/agent.json', {}), true);
  assert.equal(shouldSkip('HEAD', '/.well-known/agent.json', {}), true);
});

// Odczyt karty nie wymaga tozsamosci. Zmiana czegokolwiek pod tym adresem wymaga.
test('discovery otwarte jest tylko na odczyt', () => {
  for (const metoda of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal(shouldSkip(metoda, '/.well-known/agent.json', {}), false,
      `${metoda} na discovery nie moze omijac podpisu`);
  }
});

test('health i metrics zostaja otwarte', () => {
  assert.equal(shouldSkip('GET', '/health', {}), true);
  assert.equal(shouldSkip('GET', '/metrics', {}), true);
});

test('reszta rdzenia nadal wymaga podpisu', () => {
  for (const sciezka of ['/api/chat', '/api/a2a/send', '/api/identity/claude-md',
                         '/api/tasks', '/api/identity/card/SOME_ROLE']) {
    assert.equal(shouldSkip('POST', sciezka, {}), false, `${sciezka} nie moze byc otwarte`);
  }
});

test('sciezka podobna do discovery nie jest otwarta', () => {
  assert.equal(shouldSkip('GET', '/.well-known/agent.json.bak', {}), false);
  assert.equal(shouldSkip('GET', '/.well-known/', {}), false);
  assert.equal(shouldSkip('GET', '/api/.well-known/agent.json', {}), false);
});

test('listy otwartych sciezek sa jawne i krotkie', () => {
  assert.deepEqual([...ALWAYS_OPEN_PATHS].sort(), ['/health', '/metrics']);
  assert.deepEqual([...PUBLIC_READ_PATHS].sort(), ['/.well-known/agent.json']);
});
