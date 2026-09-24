'use strict';

// Magazyn potrafi przezyc restart tylko wtedy, gdy ktos go po starcie wczyta.
// Testy jednostkowe magazynu tego nie widza — to jest o jednym wywolaniu w rdzeniu.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('rdzen wczytuje wiadomosci a2a przy starcie', () => {
  assert.match(SERVER, /a2aStore\.hydrate\(\)/,
    'bez hydratacji wiadomosci przetrwaja w Redisie, ale rdzen ich nie zobaczy');
});

test('trasy a2a nie trzymaja juz stanu w tablicy w pamieci', () => {
  assert.doesNotMatch(SERVER, /let a2aMessages/,
    'tablica w pamieci byla tym, co restart kasowal');
});

// Zachowanie przy niedostepnym magazynie sprawdza a2a-http.test.js na zywej
// aplikacji; tutaj zostaje tylko to, czego HTTP nie zobaczy.

test('magazyn a2a ma wpis w tabeli retencji', () => {
  const { RETENTION_SECONDS } = require('../retention');
  assert.ok(Object.prototype.hasOwnProperty.call(RETENTION_SECONDS, 'a2a'),
    'bez wpisu retentionSeconds rzuca i zapis pada');
});

test('rdzen zglasza uszkodzone wpisy, a nie tylko je liczy', () => {
  assert.match(SERVER, /a2aStore\.hydrationProblems\(\)/,
    'bez tego uszkodzona wiadomosc znika operatorowi bez sladu');
});
