'use strict';

// Zmiana pliku karty ma byc widoczna w odpowiedzi endpointu, nie dopiero po
// restarcie. Testy wolaja te same handlery, ktore montuje rdzen.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { identityRoutes } = require('../a2a/identity-routes');
const { loadCards, A2A_PROTOCOL_VERSION } = require('../a2a/cards');

const BASE = 'https://core.example';

function karta(version = '1.0.0') {
  return `---
name: rola_probna
description: Rola probna.
version: "${version}"
protocolVersion: "${A2A_PROTOCOL_VERSION}"
url: \${CORE_URL}/api/a2a/rola_probna
capabilities:
  streaming: false
  pushNotifications: false
  stateTransitionHistory: false
defaultInputModes: [text/plain]
defaultOutputModes: [text/plain]
skills:
  - id: p
    name: P
    description: P.
    tags: [t]
---

# Agent: rola_probna
`;
}

async function stanowisko({ katalog } = {}) {
  const dir = katalog || fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-rejestr-'));
  const app = express();
  app.use(identityRoutes({ reload: () => loadCards(dir, { baseUrl: BASE }) }));

  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;

  return {
    dir,
    async zamknij() { await new Promise(r => server.close(r)); },
    async pobierz(sciezka) {
      const odp = await fetch(`http://127.0.0.1:${port}${sciezka}`);
      return { status: odp.status, tresc: await odp.json() };
    },
  };
}

test('zmiana pliku karty jest widoczna w odpowiedzi endpointu karty', async (t) => {
  const s = await stanowisko(); t.after(() => s.zamknij());
  fs.writeFileSync(path.join(s.dir, 'rola_probna.md'), karta('1.0.0'));

  const przed = await s.pobierz('/api/identity/card/ROLA_PROBNA');
  assert.equal(przed.tresc.version, '1.0.0');

  fs.writeFileSync(path.join(s.dir, 'rola_probna.md'), karta('2.5.0'));

  const po = await s.pobierz('/api/identity/card/ROLA_PROBNA');
  assert.equal(po.tresc.version, '2.5.0',
    'endpoint karty ma czytac plik, a nie model zapamietany przy poprzednim zadaniu');
});

test('zmiana pliku jest widoczna takze w tresci z rejestru', async (t) => {
  const s = await stanowisko(); t.after(() => s.zamknij());
  fs.writeFileSync(path.join(s.dir, 'rola_probna.md'), karta('1.0.0'));

  assert.match((await s.pobierz('/api/identity/claude-md/ROLA_PROBNA')).tresc.claude_md, /1\.0\.0/);

  fs.writeFileSync(path.join(s.dir, 'rola_probna.md'), karta('3.1.4'));

  assert.match((await s.pobierz('/api/identity/claude-md/ROLA_PROBNA')).tresc.claude_md, /3\.1\.4/);
});

test('dodany plik roli pojawia sie na liscie bez restartu', async (t) => {
  const s = await stanowisko(); t.after(() => s.zamknij());
  fs.writeFileSync(path.join(s.dir, 'rola_probna.md'), karta());

  assert.deepEqual((await s.pobierz('/api/identity/claude-md')).tresc.agents, ['ROLA_PROBNA']);

  fs.writeFileSync(path.join(s.dir, 'prompt.md'), '# Agent: prompt\n\nTresc.\n');

  const po = await s.pobierz('/api/identity/claude-md');
  assert.deepEqual(po.tresc.agents.sort(), ['PROMPT', 'ROLA_PROBNA']);
  assert.equal(po.tresc.total, 2);
});

test('rejestr zachowuje ksztalt, ktory czytaja TUI i klient MCP', async (t) => {
  const s = await stanowisko(); t.after(() => s.zamknij());
  fs.writeFileSync(path.join(s.dir, 'rola_probna.md'), karta());

  const lista = await s.pobierz('/api/identity/claude-md');
  assert.deepEqual(Object.keys(lista.tresc).sort(), ['agents', 'total']);

  const wpis = await s.pobierz('/api/identity/claude-md/ROLA_PROBNA');
  assert.deepEqual(Object.keys(wpis.tresc).sort(), ['agent', 'claude_md', 'updated_at']);
});

test('rola bez karty A2A dostaje 404 wskazujace, gdzie lezy jej tresc', async (t) => {
  const s = await stanowisko(); t.after(() => s.zamknij());
  fs.writeFileSync(path.join(s.dir, 'prompt.md'), '# Agent: prompt\n\nTresc.\n');

  const { status, tresc } = await s.pobierz('/api/identity/card/PROMPT');
  assert.equal(status, 404);
  assert.equal(tresc.error, 'no_agent_card');
  assert.match(tresc.reason, /claude-md/);
});

test('nieczytelny katalog rol to odmowa obslugi, nie pusta lista', async (t) => {
  const s = await stanowisko({ katalog: path.join(os.tmpdir(), 'a2a-nie-ma-takiego-katalogu') });
  t.after(() => s.zamknij());

  const { status, tresc } = await s.pobierz('/api/identity/claude-md');
  assert.equal(status, 503);
  assert.equal(tresc.error, 'agents_dir_unreadable');
});
