'use strict';

// Karta roli jest kontraktem maszynowym, prompt nie. Te testy trzymaja granice:
// co jest karta, co promptem, i ktory blad ma byc widoczny zamiast domyslnej wartosci.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseCard, loadCards, registryUnavailable, A2A_PROTOCOL_VERSION } = require('../a2a/cards');

const KARTA_POPRAWNA = `---
name: builder_example
description: Implements changes end to end.
version: "1.0.0"
protocolVersion: "${A2A_PROTOCOL_VERSION}"
url: https://core.example/api/a2a/builder_example
capabilities:
  streaming: false
  pushNotifications: false
  stateTransitionHistory: true
defaultInputModes: [text/plain]
defaultOutputModes: [text/plain]
skills:
  - id: implement-task
    name: Implement a task
    description: Writes the code and the test that holds it.
    tags: [build]
---

# Agent: builder_example
`;

const PROMPT_BEZ_FRONT_MATTER = `# Agent: tester_example

Runs the tests and reports what actually happened.
`;

const PROMPT_Z_WLASNYM_FRONT_MATTER = `---
role: designer
capabilities: [layout, typography]
---

# Agent: designer_example
`;

function wKatalogu(pliki) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-cards-'));
  for (const [nazwa, tresc] of Object.entries(pliki)) {
    fs.writeFileSync(path.join(dir, nazwa), tresc);
  }
  return dir;
}

function rodzajeProblemow(wynik) {
  return wynik.problems.map(p => p.kind).sort();
}

test('przypieta wersja protokolu jest jedna i jawna', () => {
  assert.equal(A2A_PROTOCOL_VERSION, '0.2.6');
});

test('poprawna karta jest rozpoznana jako karta i ma sparsowane pola', () => {
  const wynik = parseCard('builder_example.md', KARTA_POPRAWNA);

  assert.equal(wynik.kind, 'a2a');
  assert.deepEqual(wynik.problems, []);
  assert.equal(wynik.card.name, 'builder_example');
  assert.equal(wynik.card.url, 'https://core.example/api/a2a/builder_example');
  assert.equal(wynik.card.capabilities.streaming, false);
  assert.equal(wynik.card.skills.length, 1);
  assert.equal(wynik.card.skills[0].id, 'implement-task');
});

test('surowa tresc pliku zostaje nietknieta obok modelu', () => {
  const wynik = parseCard('builder_example.md', KARTA_POPRAWNA);
  assert.equal(wynik.raw, KARTA_POPRAWNA);
});

test('plik bez front matter jest promptem, nie karta z domyslnymi polami', () => {
  const wynik = parseCard('tester_example.md', PROMPT_BEZ_FRONT_MATTER);

  assert.equal(wynik.kind, 'legacy');
  assert.equal(wynik.card, null);
  assert.deepEqual(wynik.problems, []);
});

test('wlasny front matter bez pol A2A to nadal prompt, nie kaleka karta', () => {
  const wynik = parseCard('designer_example.md', PROMPT_Z_WLASNYM_FRONT_MATTER);

  assert.equal(wynik.kind, 'legacy');
  assert.equal(wynik.card, null);
});

test('karta bez wymaganego pola jest bledem, nie karta z luka', () => {
  const bezUrl = KARTA_POPRAWNA.replace(/^url: .*$/m, '');
  const wynik = parseCard('builder_example.md', bezUrl);

  assert.equal(wynik.kind, 'a2a');
  assert.equal(wynik.card, null);
  assert.ok(rodzajeProblemow(wynik).includes('missing-field'));
  assert.match(wynik.problems.map(p => p.detail).join(' '), /required property 'url'/);
});

// Klucz podpisu jest mintowany z nazwy PLIKU, a trasa i tozsamosc ida od nazwy w
// karcie. Jesli te dwie moga sie roznic, karta wskazuje na klucz, ktorego nie ma.
test('niezgodnosc name z nazwa pliku nie daje uzywalnej karty', () => {
  const wynik = parseCard('operator_example.md', KARTA_POPRAWNA);

  assert.ok(rodzajeProblemow(wynik).includes('name-mismatch'));
  assert.equal(wynik.card, null);
});

test('nierozwiniety placeholder w url jest bledem, nie adresem', () => {
  const zPlaceholderem = KARTA_POPRAWNA.replace(
    'https://core.example/api/a2a/builder_example',
    '${CORE_URL}/api/a2a/builder_example');
  const wynik = parseCard('builder_example.md', zPlaceholderem);

  assert.ok(rodzajeProblemow(wynik).includes('unresolved-url'));
  assert.equal(wynik.card, null);
});

test('inna wersja protokolu niz przypieta jest zglaszana', () => {
  const stara = KARTA_POPRAWNA.replace(`protocolVersion: "${A2A_PROTOCOL_VERSION}"`,
    'protocolVersion: "0.2"');
  const wynik = parseCard('builder_example.md', stara);

  assert.ok(rodzajeProblemow(wynik).includes('protocol-version'));
});

test('zepsuty YAML jest bledem, nie pustym promptem', () => {
  const zepsuty = '---\nname: [builder\n---\n\ntresc\n';
  const wynik = parseCard('builder_example.md', zepsuty);

  assert.ok(rodzajeProblemow(wynik).includes('malformed-front-matter'));
  assert.equal(wynik.card, null);
});

test('katalog: karty i prompty sa policzone osobno', () => {
  const dir = wKatalogu({
    'builder_example.md': KARTA_POPRAWNA,
    'tester_example.md': PROMPT_BEZ_FRONT_MATTER,
    'designer_example.md': PROMPT_Z_WLASNYM_FRONT_MATTER,
  });

  const { counts, cards, problems } = loadCards(dir);

  assert.equal(counts.a2a, 1);
  assert.equal(counts.legacy, 2);
  assert.deepEqual(problems, []);
  assert.deepEqual(Object.keys(cards).sort(),
    ['BUILDER_EXAMPLE', 'DESIGNER_EXAMPLE', 'TESTER_EXAMPLE']);
});

test('duplikat name w dwoch plikach jest zglaszany, nie wygrywa ostatni', () => {
  const dir = wKatalogu({
    'builder_example.md': KARTA_POPRAWNA,
    'builder_copy.md': KARTA_POPRAWNA,
  });

  const { problems } = loadCards(dir);
  const duplikaty = problems.filter(p => p.kind === 'duplicate-name');

  assert.equal(duplikaty.length, 1);
  assert.match(duplikaty[0].detail, /builder_example/);
});

test('pusty plik nie tworzy ani karty, ani promptu', () => {
  const dir = wKatalogu({ 'pusty.md': '   \n' });
  const { counts, cards } = loadCards(dir);

  assert.equal(counts.a2a, 0);
  assert.equal(counts.legacy, 0);
  assert.deepEqual(Object.keys(cards), []);
});

test('katalog, ktorego nie ma, jest bledem widocznym, nie pustym zestawem', () => {
  assert.throws(() => loadCards(path.join(os.tmpdir(), 'a2a-cards-nie-ma-takiego')),
    /ENOENT|nie istnieje/);
});

// Jako root chmod 000 nadal da sie odczytac, wiec ten test nie mialby czego pokazac.
test('nieczytelny plik nie kasuje calego zestawu rol, ale zostaje zgloszony', {
  skip: typeof process.getuid === 'function' && process.getuid() === 0
    ? 'jako root prawa dostepu nie blokuja odczytu' : false,
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-cards-'));
  fs.writeFileSync(path.join(dir, 'builder_example.md'), KARTA_POPRAWNA);
  const zly = path.join(dir, 'bez_dostepu.md');
  fs.writeFileSync(zly, 'tresc');
  fs.chmodSync(zly, 0o000);

  const { counts, problems } = loadCards(dir);
  fs.chmodSync(zly, 0o600);

  assert.equal(counts.a2a, 1);
  assert.equal(problems.filter(p => p.kind === 'unreadable-file').length, 1);
});

// Kazdy z tych plikow wyglada jak karta i jest zepsuty w jednym miejscu. Zgloszenie
// problemu nie wystarczy: karta nie moze zostac uzyta, bo z niej pojdzie trasa.

function zPodmiana(fragment, zamiast) {
  return KARTA_POPRAWNA.replace(fragment, zamiast);
}

test('wersja protokolu inna niz przypieta nie daje uzywalnej karty', () => {
  const wynik = parseCard('builder_example.md',
    zPodmiana(`protocolVersion: "${A2A_PROTOCOL_VERSION}"`, 'protocolVersion: "0.2"'));

  assert.ok(rodzajeProblemow(wynik).includes('protocol-version'));
  assert.equal(wynik.card, null);
});

test('url wzgledny nie jest adresem, pod ktory da sie zadzwonic', () => {
  const wynik = parseCard('builder_example.md',
    zPodmiana('https://core.example/api/a2a/builder_example', '/api/a2a/builder_example'));

  assert.ok(rodzajeProblemow(wynik).includes('invalid-field'));
  assert.equal(wynik.card, null);
});

test('url innego typu niz napis jest bledem', () => {
  const wynik = parseCard('builder_example.md',
    zPodmiana('url: https://core.example/api/a2a/builder_example', 'url: 42'));

  assert.ok(rodzajeProblemow(wynik).includes('invalid-field'));
  assert.equal(wynik.card, null);
});

test('name innego typu niz napis jest bledem', () => {
  const wynik = parseCard('builder_example.md', zPodmiana('name: builder_example', 'name: 42'));
  assert.equal(wynik.card, null);
  assert.match(wynik.problems.map(p => p.detail).join(' '), /\/name must be string/);
});

test('tryby podane napisem zamiast lista sa bledem', () => {
  const wynik = parseCard('builder_example.md',
    zPodmiana('defaultInputModes: [text/plain]', 'defaultInputModes: text/plain'));

  assert.equal(wynik.card, null);
  assert.match(wynik.problems.map(p => p.detail).join(' '), /\/defaultInputModes must be array/);
});

test('flaga capability podana napisem nie jest wartoscia logiczna', () => {
  const wynik = parseCard('builder_example.md',
    zPodmiana('streaming: false', 'streaming: "false"'));

  assert.equal(wynik.card, null);
  assert.match(wynik.problems.map(p => p.detail).join(' '), /\/capabilities\/streaming must be boolean/);
});

test('skill bez nazwy i opisu nie jest skillem', () => {
  const wynik = parseCard('builder_example.md', zPodmiana(
    `  - id: implement-task
    name: Implement a task
    description: Writes the code and the test that holds it.
    tags: [build]`,
    '  - id: implement-task'));

  assert.equal(wynik.card, null);
  const detale = wynik.problems.map(p => p.detail).join(' ');
  assert.match(detale, /\/skills\/0 must have required property 'name'/);
  assert.match(detale, /\/skills\/0 must have required property 'description'/);
});

test('niezamkniety front matter to blad, nie prompt', () => {
  const wynik = parseCard('builder_example.md', '---\nname: builder_example\nurl: https://x.example\n\n# tresc\n');

  assert.equal(wynik.kind, 'a2a');
  assert.equal(wynik.card, null);
  assert.ok(rodzajeProblemow(wynik).includes('malformed-front-matter'));
});

test('front matter z polami karty, ale bez wersji i url, nie spada cicho do promptu', () => {
  const wynik = parseCard('builder_example.md', `---
name: builder_example
description: Implements changes end to end.
version: "1.0.0"
defaultInputModes: [text/plain]
defaultOutputModes: [text/plain]
skills:
  - id: implement-task
    name: Implement a task
    description: Writes the code.
---

# Agent: builder_example
`);

  assert.equal(wynik.kind, 'a2a');
  assert.equal(wynik.card, null);
  assert.ok(rodzajeProblemow(wynik).includes('missing-field'));
});

test('provider bez wymaganego url jest bledem', () => {
  const wynik = parseCard('builder_example.md', zPodmiana('name: builder_example',
    'provider:\n  organization: BuildOnAI\nname: builder_example'));

  assert.equal(wynik.card, null);
  assert.match(wynik.problems.map(p => p.detail).join(' '), /\/provider must have required property 'url'/);
});

test('nieczytelny katalog rol to odmowa obslugi, nie pusty rejestr', () => {
  assert.deepEqual(registryUnavailable({ error: 'ENOENT: no such file or directory' }),
    { status: 503, body: { error: 'agents_dir_unreadable', detail: 'ENOENT: no such file or directory' } });
});

test('zdrowy model nie blokuje rejestru', () => {
  assert.equal(registryUnavailable({ cards: {}, problems: [], counts: { a2a: 0, legacy: 0 } }), null);
});

// Pola latwe do przeoczenia przy recznym sprawdzaniu. Kazde ma byc odrzucone przez
// oficjalny schemat, a nie przez pamiec specyfikacji.

test('skill bez tags nie spelnia AgentSkill ze schematu', () => {
  const wynik = parseCard('builder_example.md', zPodmiana('    tags: [build]\n', ''));

  assert.equal(wynik.card, null);
  assert.match(wynik.problems.map(p => p.detail).join(' '), /\/skills\/0 must have required property 'tags'/);
});

test('skill.inputModes podane napisem zamiast lista jest bledem', () => {
  const wynik = parseCard('builder_example.md',
    zPodmiana('    tags: [build]', '    tags: [build]\n    inputModes: text/plain'));

  assert.equal(wynik.card, null);
  assert.match(wynik.problems.map(p => p.detail).join(' '), /\/skills\/0\/inputModes must be array/);
});

test('capabilities.extensions jako obiekt zamiast listy jest bledem', () => {
  const wynik = parseCard('builder_example.md',
    zPodmiana('  stateTransitionHistory: true', '  stateTransitionHistory: true\n  extensions: {}'));

  assert.equal(wynik.card, null);
  assert.match(wynik.problems.map(p => p.detail).join(' '), /\/capabilities\/extensions must be array/);
});

test('documentationUrl innego typu niz napis jest bledem', () => {
  const wynik = parseCard('builder_example.md',
    zPodmiana('name: builder_example', 'documentationUrl: 42\nname: builder_example'));

  assert.equal(wynik.card, null);
  assert.match(wynik.problems.map(p => p.detail).join(' '), /\/documentationUrl must be string/);
});

test('supportsAuthenticatedExtendedCard jako napis nie jest wartoscia logiczna', () => {
  const wynik = parseCard('builder_example.md', zPodmiana('name: builder_example',
    'supportsAuthenticatedExtendedCard: "false"\nname: builder_example'));

  assert.equal(wynik.card, null);
  assert.match(wynik.problems.map(p => p.detail).join(' '), /\/supportsAuthenticatedExtendedCard must be boolean/);
});

test('security jako napis zamiast listy jest bledem', () => {
  const wynik = parseCard('builder_example.md',
    zPodmiana('name: builder_example', 'security: ed25519\nname: builder_example'));

  assert.equal(wynik.card, null);
  assert.match(wynik.problems.map(p => p.detail).join(' '), /\/security must be array/);
});

test('securitySchemes jako lista zamiast mapy jest bledem', () => {
  const wynik = parseCard('builder_example.md',
    zPodmiana('name: builder_example', 'securitySchemes: []\nname: builder_example'));

  assert.equal(wynik.card, null);
  assert.match(wynik.problems.map(p => p.detail).join(' '), /\/securitySchemes must be object/);
});

test('wzorzec poprawnej karty przechodzi oficjalny schemat', () => {
  const wynik = parseCard('builder_example.md', KARTA_POPRAWNA);
  assert.deepEqual(wynik.problems, []);
  assert.ok(wynik.card);
});

// Adres bazowy: karta trzyma sciezke, wdrozenie trzyma adres.

test('adres bazowy rozwija placeholder w url karty', () => {
  const wynik = parseCard('builder_example.md',
    zPodmiana('https://core.example/api/a2a/builder_example', '${CORE_URL}/api/a2a/builder_example'),
    { baseUrl: 'https://core.example' });

  assert.deepEqual(wynik.problems, []);
  assert.equal(wynik.card.url, 'https://core.example/api/a2a/builder_example');
});

test('bez adresu bazowego placeholder nadal jest bledem, nie cicha zgadywanka', () => {
  const wynik = parseCard('builder_example.md',
    zPodmiana('https://core.example/api/a2a/builder_example', '${CORE_URL}/api/a2a/builder_example'));

  assert.ok(rodzajeProblemow(wynik).includes('unresolved-url'));
  assert.equal(wynik.card, null);
});

test('adres bazowy z koncowym ukosnikiem nie daje podwojnego ukosnika', () => {
  const wynik = parseCard('builder_example.md',
    zPodmiana('https://core.example/api/a2a/builder_example', '${CORE_URL}/api/a2a/builder_example'),
    { baseUrl: 'https://core.example/' });

  assert.equal(wynik.card.url, 'https://core.example/api/a2a/builder_example');
});

test('nieznany placeholder zostaje bledem mimo podanego adresu bazowego', () => {
  const wynik = parseCard('builder_example.md',
    zPodmiana('https://core.example/api/a2a/builder_example', '${NIE_TEN}/api/a2a/builder_example'),
    { baseUrl: 'https://core.example' });

  assert.ok(rodzajeProblemow(wynik).includes('unresolved-url'));
});

// Klasyfikacja jest bramka przed schematem: co nie zostanie uznane za karte, tego
// schemat nigdy nie zobaczy — dlatego lista pol rozpoznawczych pochodzi ze schematu.

test('front matter z polami karty, ale bez tych oczywistych, nie omija schematu', () => {
  const wynik = parseCard('builder_example.md', `---
name: builder_example
description: Implements changes end to end.
version: "1.0.0"
provider:
  organization: BuildOnAI
  url: https://github.com/build-on-ai
securitySchemes: {}
security: []
---

# Agent: builder_example
`);

  assert.equal(wynik.kind, 'a2a');
  assert.equal(wynik.card, null);
  assert.ok(rodzajeProblemow(wynik).includes('missing-field'));
});

test('samo pole unikalne dla karty wystarczy, zeby plik nie uchodzil za prompt', () => {
  for (const pole of ['iconUrl: https://x.example/i.png', 'documentationUrl: https://x.example',
                      'preferredTransport: JSONRPC', 'supportsAuthenticatedExtendedCard: true']) {
    const wynik = parseCard('builder_example.md', `---\nrole: builder\n${pole}\n---\n\ntresc\n`);
    assert.equal(wynik.kind, 'a2a', `${pole} powinno oznaczac karte`);
    assert.equal(wynik.card, null);
  }
});

test('name, description i version razem oznaczaja karte, osobno nie', () => {
  const komplet = parseCard('builder_example.md',
    '---\nname: builder_example\ndescription: x\nversion: "1.0.0"\n---\n\ntresc\n');
  assert.equal(komplet.kind, 'a2a');
  assert.equal(komplet.card, null);

  const samoName = parseCard('builder_example.md', '---\nname: builder_example\n---\n\ntresc\n');
  assert.equal(samoName.kind, 'legacy');
  assert.deepEqual(samoName.problems, []);
});

test('prompt z rola i lista umiejetnosci pozostaje promptem', () => {
  const wynik = parseCard('designer_example.md',
    '---\nrole: designer\ncapabilities: [ui, wireframes]\n---\n\n# Agent: designer_example\n');

  assert.equal(wynik.kind, 'legacy');
  assert.equal(wynik.card, null);
  assert.deepEqual(wynik.problems, []);
});

test('prawdziwy katalog rol nadal dzieli sie tak samo', () => {
  const { counts, problems } = loadCards(path.join(__dirname, '..', '..', 'agents'),
    { baseUrl: 'http://127.0.0.1:13032' });

  assert.deepEqual(counts, { a2a: 7, legacy: 8 });
  assert.deepEqual(problems, []);
});
