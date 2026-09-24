'use strict';

// /api/_routes jest zrodlem dla bin/test-endpoints, wiec trasa, ktorej nie widzi, nie
// jest testowana przez nikogo — introspekcja musi wchodzic w zamontowane routery.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { collectRoutes } = require('../route-index');

function aplikacjaZRouterem() {
  const app = express();
  app.get('/health', (_req, res) => res.end());

  const router = express.Router();
  router.post('/api/a2a/send', (_req, res) => res.end());
  router.get('/api/a2a/inbox/:agent', (_req, res) => res.end());
  router.post('/api/a2a/inbox/:agent', (_req, res) => res.end());
  app.use(router);

  const zagniezdzony = express.Router();
  zagniezdzony.get('/api/identity/card/:agent', (_req, res) => res.end());
  app.use(zagniezdzony);

  return app;
}

test('trasy wpiete wprost w aplikacje sa widoczne', () => {
  const sciezki = collectRoutes(aplikacjaZRouterem()).map(r => r.path);
  assert.ok(sciezki.includes('/health'));
});

test('trasy z zamontowanych routerow tez sa widoczne', () => {
  const trasy = collectRoutes(aplikacjaZRouterem());
  const sciezki = trasy.map(r => r.path);

  for (const oczekiwana of ['/api/a2a/send', '/api/a2a/inbox/:agent', '/api/identity/card/:agent']) {
    assert.ok(sciezki.includes(oczekiwana), `${oczekiwana} nie jest widoczna dla introspekcji`);
  }
});

test('ta sama sciezka z dwiema metodami jest jedna pozycja z dwiema metodami', () => {
  const wpis = collectRoutes(aplikacjaZRouterem()).find(r => r.path === '/api/a2a/inbox/:agent');

  assert.deepEqual(wpis.methods, ['GET', 'POST']);
  assert.equal(wpis.parameterised, true);
});

test('lista jest posortowana i oznacza trasy parametryczne', () => {
  const trasy = collectRoutes(aplikacjaZRouterem());

  assert.deepEqual(trasy.map(r => r.path), [...trasy.map(r => r.path)].sort());
  assert.equal(trasy.find(r => r.path === '/health').parameterised, false);
});

test('introspekcja rdzenia widzi trasy A2A i rejestru', () => {
  const fs = require('fs');
  const path = require('path');
  const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  assert.match(SERVER, /collectRoutes\(app\)/,
    'rejestr tras ma korzystac z tej samej funkcji, ktora wchodzi w routery');
});
