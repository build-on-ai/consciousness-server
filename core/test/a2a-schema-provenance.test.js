'use strict';

// The schema is a vendored copy: it can stop matching what SOURCE.md says it is, or
// never reach the image, and the container dies on its first require.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const A2A_DIR = path.join(__dirname, '..', 'a2a');
const SCHEMA = path.join(A2A_DIR, 'schema', 'a2a-0.2.6.json');
const SOURCE = path.join(A2A_DIR, 'schema', 'SOURCE.md');

test('wersja w SOURCE.md zgadza sie z przypieta w kodzie', () => {
  const { A2A_PROTOCOL_VERSION } = require('../a2a/cards');
  assert.match(fs.readFileSync(SOURCE, 'utf8'), new RegExp(`v${A2A_PROTOCOL_VERSION.replace(/\./g, '\\.')}`));
});

test('schemat jest tym plikiem, ktory SOURCE.md opisuje', () => {
  const zapisany = fs.readFileSync(SOURCE, 'utf8').match(/\b([0-9a-f]{64})\b/);
  assert.ok(zapisany, 'SOURCE.md nie podaje sumy kontrolnej');

  const faktyczny = crypto.createHash('sha256').update(fs.readFileSync(SCHEMA)).digest('hex');
  assert.equal(faktyczny, zapisany[1]);
});

test('schemat opisuje AgentCard, a nie cokolwiek innego', () => {
  const doc = JSON.parse(fs.readFileSync(SCHEMA, 'utf8'));
  assert.ok(doc.definitions && doc.definitions.AgentCard, 'brak definicji AgentCard');
  assert.deepEqual(doc.definitions.AgentSkill.required.sort(),
    ['description', 'id', 'name', 'tags']);
});

test('licencja jedzie razem z plikiem, ktory obejmuje', () => {
  const licencja = fs.readFileSync(path.join(A2A_DIR, 'schema', 'LICENSE'), 'utf8');
  assert.match(licencja, /Apache License/);
  assert.match(licencja, /Version 2\.0, January 2004/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', '..', 'COPYRIGHT'), 'utf8'),
    /core\/a2a\/schema\/a2a-0\.2\.6\.json/);
});

test('katalog ze schematem trafia do obrazu', () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /^COPY core\/a2a /m,
    'Dockerfile nie kopiuje core/a2a — schemat nie dotrze do kontenera');
});
