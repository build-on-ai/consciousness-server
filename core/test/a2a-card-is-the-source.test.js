'use strict';

// Plik karty jest jedynym zrodlem pol roli: zmiana JEDNEGO pola ma zmienic wszystkie
// reprezentacje, bez zmiany kodu. Testy zmieniaja plik i czytaja go ponownie.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadCards, A2A_PROTOCOL_VERSION } = require('../a2a/cards');
const { registryEntry, registryList, cardFor } = require('../a2a/registry');

const BASE = 'https://core.example';

function karta({ version = '1.0.0', description = 'Pierwszy opis.' } = {}) {
  return `---
name: rola_probna
description: ${description}
version: "${version}"
protocolVersion: "${A2A_PROTOCOL_VERSION}"
url: \${CORE_URL}/api/a2a/rola_probna
capabilities:
  streaming: false
  pushNotifications: false
  stateTransitionHistory: true
defaultInputModes: [text/plain]
defaultOutputModes: [text/plain]
skills:
  - id: probna
    name: Umiejetnosc probna
    description: Istnieje po to, zeby dalo sie ja zmienic.
    tags: [test]
---

# Agent: rola_probna
`;
}

function katalogZKarta(tresc) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-zrodlo-'));
  fs.writeFileSync(path.join(dir, 'rola_probna.md'), tresc);
  return dir;
}

test('zmiana jednego pola karty widoczna jest w KAZDEJ reprezentacji', () => {
  const dir = katalogZKarta(karta());

  const przed = loadCards(dir, { baseUrl: BASE });
  assert.equal(cardFor(przed, 'ROLA_PROBNA').version, '1.0.0');
  assert.match(registryEntry(przed, 'ROLA_PROBNA').claude_md, /version: "1\.0\.0"/);

  // Jedno pole, na dysku, bez dotykania kodu.
  fs.writeFileSync(path.join(dir, 'rola_probna.md'), karta({ version: '2.5.0' }));

  const po = loadCards(dir, { baseUrl: BASE });
  assert.equal(cardFor(po, 'ROLA_PROBNA').version, '2.5.0');
  assert.match(registryEntry(po, 'ROLA_PROBNA').claude_md, /version: "2\.5\.0"/);
  assert.equal(po.cards.ROLA_PROBNA.card.version, '2.5.0');
});

test('zmiana opisu tez przechodzi, wiec nie chodzi o jedno szczegolne pole', () => {
  const dir = katalogZKarta(karta());
  assert.equal(cardFor(loadCards(dir, { baseUrl: BASE }), 'ROLA_PROBNA').description,
    'Pierwszy opis.');

  fs.writeFileSync(path.join(dir, 'rola_probna.md'), karta({ description: 'Drugi opis.' }));

  assert.equal(cardFor(loadCards(dir, { baseUrl: BASE }), 'ROLA_PROBNA').description,
    'Drugi opis.');
});

test('adres roli bierze sie z karty i z adresu bazowego, nie z kodu', () => {
  const dir = katalogZKarta(karta());

  assert.equal(cardFor(loadCards(dir, { baseUrl: 'https://a.example' }), 'ROLA_PROBNA').url,
    'https://a.example/api/a2a/rola_probna');
  assert.equal(cardFor(loadCards(dir, { baseUrl: 'https://b.example' }), 'ROLA_PROBNA').url,
    'https://b.example/api/a2a/rola_probna');
});

test('dodanie pliku roli zmienia rejestr bez restartu i bez zmiany kodu', () => {
  const dir = katalogZKarta(karta());
  assert.equal(registryList(loadCards(dir, { baseUrl: BASE })).total, 1);

  fs.writeFileSync(path.join(dir, 'prompt_probny.md'), '# Agent: prompt_probny\n\nTresc.\n');

  const po = registryList(loadCards(dir, { baseUrl: BASE }));
  assert.equal(po.total, 2);
  assert.deepEqual(po.agents.sort(), ['PROMPT_PROBNY', 'ROLA_PROBNA']);
});
