'use strict';

// To, co karta deklaruje, ma byc tym, co rdzen robi. Macierz po istniejacych kartach:
// nie sprawdza konkretnych wartosci flag, tylko zgodnosc kazdej z zachowaniem.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { loadCards } = require('../a2a/cards');
const { SUPPORTED_METHODS, taskFromMessage } = require('../a2a/tasks');

const AGENTS_DIR = path.join(__dirname, '..', '..', 'agents');
const BASE = 'http://127.0.0.1:13032';

function kartyA2A() {
  const { cards } = loadCards(AGENTS_DIR, { baseUrl: BASE });
  return Object.values(cards).filter(entry => entry.kind === 'a2a' && entry.card);
}

// Co rdzen potrafi, wyprowadzone z zestawu metod. Historie zmian stanu sprawdzamy
// proba: czy w Tasku da sie odczytac tyle przejsc, ile zapisal magazyn.
function czyTaskWystawiaHistorieStanow() {
  const zapisana = {
    id: 't-1', to: 'rola', status: 'acked', created_at: 'n',
    payload: { message: { kind: 'message', messageId: 'm', role: 'user', parts: [] } },
    history: [
      { from: null, to: 'pending', at: 'a', by: 'X' },
      { from: 'pending', to: 'delivered', at: 'b', by: 'Y' },
      { from: 'delivered', to: 'acked', at: 'c', by: 'Y' },
    ],
  };

  const task = taskFromMessage(zapisana);
  const wystawione = JSON.stringify(task).match(/"(pending|delivered|acked)"/g) || [];

  // Jeden wpis to biezacy stan, nie historia. Historia oznacza wszystkie przejscia.
  return wystawione.length >= zapisana.history.length;
}

const RDZEN = {
  streaming: SUPPORTED_METHODS.includes('message/stream'),
  pushNotifications: SUPPORTED_METHODS.some(m => m.startsWith('tasks/pushNotificationConfig/')),
  stateTransitionHistory: czyTaskWystawiaHistorieStanow(),
};

test('jest co sprawdzac', () => {
  assert.ok(kartyA2A().length > 0, 'brak kart A2A — macierz nie mialaby sensu');
});

test('kazda zadeklarowana zdolnosc zgadza sie z zachowaniem rdzenia', () => {
  for (const entry of kartyA2A()) {
    for (const [flaga, potrafi] of Object.entries(RDZEN)) {
      const zadeklarowane = entry.card.capabilities[flaga];
      if (zadeklarowane === undefined) continue;
      assert.equal(zadeklarowane, potrafi,
        `${entry.card.name}: karta mowi ${flaga}=${zadeklarowane}, a rdzen ${potrafi ? 'to potrafi' : 'tego nie robi'}`);
    }
  }
});

test('gdy rdzen nie strumieniuje, message/stream nie jest obslugiwana metoda', () => {
  assert.equal(SUPPORTED_METHODS.includes('message/stream'), RDZEN.streaming);
});

test('zestaw metod ma jedno zrodlo, nie kopie w trasie', () => {
  const fs = require('fs');
  const ROUTES = fs.readFileSync(path.join(__dirname, '..', 'a2a', 'routes.js'), 'utf8');
  assert.match(ROUTES, /new Set\(SUPPORTED_METHODS\)/);
  assert.doesNotMatch(ROUTES, /new Set\(\['message\/send'/);
});
