'use strict';

// Nazwa roli, nazwa klucza i tozsamosc podpisu maja wynikac z jednej normalizacji:
// na systemie plikow rozrozniajacym wielkosc liter kazda inna to inna tozsamosc.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { agentIdFor, publicKeyFileFor, caseCollisions } = require('../a2a/identity');
const { loadCards } = require('../a2a/cards');

const ROOT = path.join(__dirname, '..', '..');
const KLUCZE_PUBLICZNE = path.join(ROOT, 'key-server', 'keys', 'agents');

test('nazwa roli i tozsamosc podpisu roznia sie tylko wielkoscia liter', () => {
  assert.equal(agentIdFor('auditor_example'), 'AUDITOR_EXAMPLE');
  assert.equal(agentIdFor('AUDITOR_EXAMPLE'), 'AUDITOR_EXAMPLE');
  assert.equal(agentIdFor('architect-redis_example'), 'ARCHITECT-REDIS_EXAMPLE');
});

test('nazwa, ktora nie jest nazwa, jest bledem, nie poprawiana po cichu', () => {
  for (const zle of ['../etc/passwd', 'a b', 'kropka.w.nazwie', '', null, 42]) {
    assert.throws(() => agentIdFor(zle), /agent name/, `${zle} powinno byc odrzucone`);
  }
});

test('plik klucza publicznego wynika z nazwy, nie z osobnego pola', () => {
  assert.equal(publicKeyFileFor('auditor_example'), 'AUDITOR_EXAMPLE.pub');
});

test('dwie nazwy rozniace sie tylko wielkoscia liter sa kolizja', () => {
  assert.deepEqual(caseCollisions(['auditor', 'AUDITOR', 'scout']), [['auditor', 'AUDITOR']]);
  assert.deepEqual(caseCollisions(['auditor', 'scout']), []);
});

// Klucze to stan uruchomieniowy (key-server/.gitignore: keys/**), wiec czysty
// checkout ich nie ma. Obecnosc sprawdzamy tam, gdzie zostaly wygenerowane.
function kluczeWygenerowane() {
  try {
    return fs.readdirSync(KLUCZE_PUBLICZNE).some(f => f.endsWith('.pub'));
  } catch (_err) {
    return false;
  }
}

test('kazda karta ma klucz publiczny pod nazwa, ktora wynika z normalizacji', {
  skip: kluczeWygenerowane() ? false : 'bin/bootstrap-keys nie byl tu uruchomiony — nie ma czego sprawdzac',
}, () => {
  const { cards } = loadCards(path.join(ROOT, 'agents'), { baseUrl: 'http://127.0.0.1:13032' });
  const a2a = Object.values(cards).filter(e => e.kind === 'a2a' && e.card);
  assert.ok(a2a.length > 0);

  for (const entry of a2a) {
    const plik = path.join(KLUCZE_PUBLICZNE, publicKeyFileFor(entry.card.name));
    assert.ok(fs.existsSync(plik),
      `${entry.card.name}: brak klucza ${publicKeyFileFor(entry.card.name)} — podpis ta tozsamoscia nie przejdzie`);
  }
});

test('zadne dwie karty nie roznia sie wylacznie wielkoscia liter', () => {
  const { cards } = loadCards(path.join(ROOT, 'agents'), { baseUrl: 'http://127.0.0.1:13032' });
  const nazwy = Object.values(cards).filter(e => e.kind === 'a2a' && e.card).map(e => e.card.name);
  assert.deepEqual(caseCollisions(nazwy), []);
});

test('karty opisuja podpis schematem protokolu, nie wlasnym polem', () => {
  const { cards } = loadCards(path.join(ROOT, 'agents'), { baseUrl: 'http://127.0.0.1:13032' });

  for (const entry of Object.values(cards).filter(e => e.kind === 'a2a' && e.card)) {
    assert.equal(entry.card.authentication, undefined,
      `${entry.card.name}: pole authentication nie istnieje w AgentCard 0.2.6`);
    assert.ok(entry.card.securitySchemes, `${entry.card.name}: brak securitySchemes`);
    assert.ok(Array.isArray(entry.card.security), `${entry.card.name}: brak security`);

    const [nazwaSchematu] = Object.keys(entry.card.securitySchemes);
    assert.equal(entry.card.securitySchemes[nazwaSchematu].type, 'apiKey');
    assert.equal(entry.card.securitySchemes[nazwaSchematu].in, 'header');
    assert.match(entry.card.securitySchemes[nazwaSchematu].description, /SIGNING-PROTOCOL/);
  }
});

test('normalizacja jest opisana tam, gdzie opisany jest podpis', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'SIGNING-PROTOCOL.md'), 'utf8');

  assert.match(doc, /## Agent names/);
  assert.match(doc, /AUDITOR_EXAMPLE/, 'regula ma byc pokazana na przykladzie, nie tylko opisana');
  assert.match(doc, /case-sensitive/);
});

// Dwie nazwy roznice sie tylko wielkoscia liter to jedna tozsamosc i dwa pliki.
// Ktory wygralby po cichu, zalezaloby od kolejnosci odczytu katalogu.

test('dwa pliki rol roznice sie tylko wielkoscia liter sa odrzucone, nie nadpisane', (t) => {
  const os = require('os');
  const { loadCards } = require('../a2a/cards');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-kolizja-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'foo.md'), '# Agent: foo\n\nPierwszy.\n');
  fs.writeFileSync(path.join(dir, 'FOO.md'), '# Agent: FOO\n\nDrugi.\n');
  fs.writeFileSync(path.join(dir, 'inny.md'), '# Agent: inny\n\nBez kolizji.\n');

  const { cards, problems } = loadCards(dir, { baseUrl: 'https://core.example' });

  assert.equal(cards.FOO, undefined, 'zaden z kolidujacych plikow nie moze cicho wygrac');
  assert.ok(cards.INNY, 'kolizja nie moze kosztowac rol, ktore jej nie maja');

  const kolizje = problems.filter(p => p.kind === 'name-collision');
  assert.equal(kolizje.length, 1);
  assert.match(kolizje[0].detail, /foo\.md/);
  assert.match(kolizje[0].detail, /FOO\.md/);
});
