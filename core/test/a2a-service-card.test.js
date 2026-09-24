'use strict';

// /.well-known/agent.json to karta TEJ uslugi: sprawdzana tym samym schematem co
// karty rol i opisujaca to, co rdzen naprawde robi.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Ajv = require('ajv');

const { serviceCard, SERVICE_ROLE } = require('../a2a/service-card');
const { SUPPORTED_METHODS } = require('../a2a/tasks');
const { A2A_PROTOCOL_VERSION } = require('../a2a/cards');
const pakiet = require('../package.json');
const schemaDocument = require('../a2a/schema/a2a-0.2.6.json');

const ajv = new Ajv({ allErrors: true, strict: false });
ajv.addSchema(schemaDocument, 'a2a');
const waliduj = ajv.compile({ $ref: 'a2a#/definitions/AgentCard' });

const BASE = 'http://127.0.0.1:13032';

test('karta uslugi przechodzi oficjalny schemat AgentCard', () => {
  const karta = serviceCard(BASE);
  assert.ok(waliduj(karta), JSON.stringify(waliduj.errors));
});

test('wersja pochodzi z package.json, nie z kopii w kodzie', () => {
  assert.equal(serviceCard(BASE).version, pakiet.version);
  assert.notEqual(pakiet.version, '1.0.0', 'test straci sens, gdy wersje przypadkiem sie zrownaja');
});

test('nazwa i opis tez pochodza z pakietu', () => {
  const karta = serviceCard(BASE);
  assert.equal(karta.name, pakiet.name);
  assert.equal(karta.description, pakiet.description);
});

test('adres jest bezwzgledny i wskazuje trase, ktora rdzen obsluguje', () => {
  const karta = serviceCard(BASE);
  assert.equal(karta.url, `${BASE}/api/a2a/${SERVICE_ROLE}`);
  assert.match(karta.url, /^https?:\/\//);
  assert.doesNotMatch(karta.url, /\$\{/);
});

test('adres nie znika, gdy nikt nie ustawil zmiennej', () => {
  assert.throws(() => serviceCard(''), /base address/);
  assert.throws(() => serviceCard(undefined), /base address/);
});

test('wersja protokolu jest ta sama, ktora walidujemy karty rol', () => {
  assert.equal(serviceCard(BASE).protocolVersion, A2A_PROTOCOL_VERSION);
});

test('zdolnosci opisuja to, co rdzen robi, a nie czego chcielibysmy', () => {
  const { capabilities } = serviceCard(BASE);

  assert.equal(capabilities.streaming, SUPPORTED_METHODS.includes('message/stream'));
  assert.equal(capabilities.pushNotifications,
    SUPPORTED_METHODS.some(m => m.startsWith('tasks/pushNotificationConfig/')));
});

test('karta nie niesie pol spoza kontraktu', () => {
  const karta = serviceCard(BASE);
  const dozwolone = new Set(Object.keys(schemaDocument.definitions.AgentCard.properties));

  for (const pole of Object.keys(karta)) {
    assert.ok(dozwolone.has(pole), `${pole} nie jest polem AgentCard — tak zaczyna sie nastepny dryf`);
  }
});

test('umiejetnosc opisuje to, co endpoint faktycznie przyjmuje', () => {
  const [skill] = serviceCard(BASE).skills;

  assert.ok(skill, 'karta bez umiejetnosci nie mowi, po co ten adres istnieje');
  assert.match(skill.description, /message\/send|tasks\/get/);
});

test('karta uslugi deklaruje historie stanow tak samo jak karty rol', () => {
  const { loadCards } = require('../a2a/cards');
  const path = require('path');

  const { cards } = loadCards(path.join(__dirname, '..', '..', 'agents'), { baseUrl: BASE });
  const rola = Object.values(cards).find(e => e.kind === 'a2a' && e.card);

  assert.equal(serviceCard(BASE).capabilities.stateTransitionHistory,
    rola.card.capabilities.stateTransitionHistory,
    'usluga i role stoja za tym samym rdzeniem, wiec nie moga deklarowac roznych zdolnosci');
});
