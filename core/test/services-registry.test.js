'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { parseServices, loadServices } = require('../services-registry');

const PRZYKLAD = `
services:
  - name: consciousness
    host: consciousness-server
    port: 3032
    path: /health
    description: Core
    status: active

  - name: ollama
    host: host.docker.internal
    port: 11434
    path: /api/tags
    description: Local inference
    status: external
`;

test('czyta kazda usluge z rejestru', () => {
  const s = parseServices(PRZYKLAD);
  assert.strictEqual(s.length, 2);
  assert.strictEqual(s[0].name, 'consciousness');
  assert.strictEqual(s[1].name, 'ollama');
});

test('port jest liczba, nie napisem', () => {
  const s = parseServices(PRZYKLAD);
  assert.strictEqual(s[0].port, 3032);
  assert.strictEqual(typeof s[0].port, 'number');
});

test('status rozroznia active od external', () => {
  const s = parseServices(PRZYKLAD);
  assert.strictEqual(s.filter(x => x.status === 'active').length, 1);
});

test('nowa usluga w rejestrze pojawia sie bez zmiany kodu', () => {
  const rozszerzony = PRZYKLAD + `
  - name: nowa-usluga
    host: nowa
    port: 9999
    path: /health
    description: Dodana tylko w pliku
    status: active
`;
  const s = parseServices(rozszerzony);
  const nowa = s.find(x => x.name === 'nowa-usluga');
  assert.ok(nowa, 'usluga dopisana do rejestru musi byc widoczna');
  assert.strictEqual(nowa.port, 9999);
  assert.strictEqual(s.filter(x => x.status === 'active').length, 2);
});

test('komentarze i puste linie nie tworza wpisow', () => {
  const s = parseServices(`
services:
  # to jest komentarz
  - name: jedna
    port: 1

`);
  assert.strictEqual(s.length, 1);
  assert.strictEqual(s[0].name, 'jedna');
});

test('brak pliku daje pusta liste zamiast wyjatku', () => {
  const stary = process.env.SERVICES_YAML;
  process.env.SERVICES_YAML = '/nie/istnieje/services.yaml';
  try {
    assert.deepStrictEqual(loadServices(), []);
  } finally {
    if (stary === undefined) delete process.env.SERVICES_YAML;
    else process.env.SERVICES_YAML = stary;
  }
});

test('rejestr z repozytorium wczytuje sie i ma consciousness', () => {
  const s = loadServices();
  assert.ok(s.length > 0, 'services.yaml musi dac sie wczytac');
  assert.ok(s.some(x => x.name === 'consciousness'));
});
