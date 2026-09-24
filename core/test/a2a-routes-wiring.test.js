'use strict';

// Czego testy HTTP nie widza: czy regula ma jedno zrodlo i czy trasy sa zamontowane
// w rdzeniu. Zachowanie tras sprawdza a2a-http.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CORE = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(CORE, 'server.js'), 'utf8');
const ROUTES = fs.readFileSync(path.join(CORE, 'a2a', 'routes.js'), 'utf8');

test('rdzen montuje te same trasy, ktore sprawdzaja testy HTTP', () => {
  assert.match(SERVER, /require\('\.\/a2a\/routes'\)/);
  assert.match(SERVER, /app\.use\(a2aRoutes\(\{ store: a2aStore, cardFor: a2aCardFor \}\)\)/);
});

test('reguly autoryzacji sa wolane, a nie przepisane w trasie', () => {
  assert.match(ROUTES, /senderMismatch\(req\._verifiedAgent, from_agent\)/);
  assert.match(ROUTES, /mayAck\(req\._verifiedAgent, message\)/);
  assert.match(ROUTES, /inboxDenial\(req\._verifiedAgent, req\.params\.agent\)/);

  assert.doesNotMatch(ROUTES, /function inboxDenial\(/,
    'regula ma jedno miejsce — inaczej nie da sie jej ani przetestowac, ani zmutowac');
  assert.doesNotMatch(ROUTES, /const \{ agent \} = req\.body/,
    'uprawnienie nie moze wracac do pola w tresci');
});

test('zestaw metod pochodzi z modulu, nie z kopii w trasie', () => {
  assert.match(ROUTES, /new Set\(SUPPORTED_METHODS\)/);
  assert.doesNotMatch(ROUTES, /new Set\(\['message\/send'/);
});

test('trasa roli jest zarejestrowana po trasach nazwanych', () => {
  assert.ok(ROUTES.indexOf('app.post("/api/a2a/send"') < ROUTES.indexOf('app.post("/api/a2a/:role"'),
    'inaczej /api/a2a/send trafiloby do dyspozytora protokolu');
});

test('discovery serwuje zbudowana karte, nie wlasny obiekt', () => {
  const wk = SERVER.slice(SERVER.indexOf('app.get("/.well-known/agent.json"'));
  const sekcja = wk.slice(0, 300);
  assert.match(sekcja, /serviceCard\(CORE_URL\)/);
  assert.doesNotMatch(sekcja, /version:/, 'wersja ma pochodzic z karty, nie byc wpisana tutaj');
  assert.doesNotMatch(SERVER, /"Ecosystem Agent Network"/);
});

test('adres z karty uslugi jest trasa, ktora rdzen obsluguje', () => {
  assert.match(SERVER, /String\(role\)\.toLowerCase\(\) === SERVICE_ROLE/,
    'inaczej /.well-known wskazywaloby adres bez obslugi');
});
