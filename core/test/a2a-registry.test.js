'use strict';

// Rejestr kart ma dwoch konsumentow: TUI (Go) i klienta MCP (TypeScript). Nazwy pol
// czytamy wprost z ich zrodel, zamiast zakladac, czego oczekuja.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { registryList, registryEntry, cardFor } = require('../a2a/registry');
const { loadCards } = require('../a2a/cards');

const ROOT = path.join(__dirname, '..', '..');
const TUI = fs.readFileSync(path.join(ROOT, 'tui', 'internal', 'api', 'client.go'), 'utf8');
const MCP = fs.readFileSync(path.join(ROOT, 'clients', 'mcp-buildonai', 'mcp-server.ts'), 'utf8');

function model() {
  return loadCards(path.join(ROOT, 'agents'), { baseUrl: 'http://127.0.0.1:13032' });
}

test('TUI nadal czyta pola, ktore rejestr podaje', () => {
  // client.go: `json:"agents"` oraz `json:"claude_md"`
  assert.match(TUI, /json:"agents"/);
  assert.match(TUI, /json:"claude_md"/);

  const lista = registryList(model());
  assert.ok(Array.isArray(lista.agents));

  const wpis = registryEntry(model(), 'AUDITOR_EXAMPLE');
  assert.equal(typeof wpis.claude_md, 'string');
});

test('klient MCP nadal czyta pola, ktore rejestr podaje', () => {
  assert.match(MCP, /list\.agents/);
  assert.match(MCP, /data\.claude_md/);

  const lista = registryList(model());
  assert.equal(typeof lista.total, 'number');
  assert.equal(lista.total, lista.agents.length);
});

test('rejestr wymienia i karty, i prompty — jak dotad', () => {
  const lista = registryList(model());

  assert.ok(lista.agents.includes('AUDITOR_EXAMPLE'), 'karta A2A');
  assert.ok(lista.agents.includes('TESTER_EXAMPLE'), 'prompt roli');
  assert.equal(lista.agents.length, 15);
});

test('tresc wpisu to plik tak, jak napisany', () => {
  const m = model();
  const wpis = registryEntry(m, 'AUDITOR_EXAMPLE');

  assert.equal(wpis.claude_md, m.cards.AUDITOR_EXAMPLE.raw);
  assert.equal(wpis.agent, 'AUDITOR_EXAMPLE');
  assert.match(wpis.updated_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('rola, ktorej nie ma, nie jest pustym wpisem', () => {
  assert.equal(registryEntry(model(), 'NIE_MA_TAKIEJ'), null);
});

test('karta roli to sparsowana karta, nie obiekt zlozony z domyslnych wartosci', () => {
  const karta = cardFor(model(), 'AUDITOR_EXAMPLE');

  assert.equal(karta.name, 'auditor_example');
  assert.equal(karta.protocolVersion, '0.2.6');
  assert.match(karta.url, /^http/);
  assert.equal(karta.version, '1.0.0', 'wersja roli pochodzi z karty roli');
  assert.ok(Array.isArray(karta.skills) && karta.skills.length > 0);
});

test('prompt roli nie udaje karty A2A', () => {
  assert.equal(cardFor(model(), 'TESTER_EXAMPLE'), null);
  assert.equal(cardFor(model(), 'NIE_MA_TAKIEJ'), null);
});

test('rdzen nie pozwala edytowac karty roli przez API', () => {
  const SERVER = fs.readFileSync(path.join(ROOT, 'core', 'server.js'), 'utf8');
  const TRASY = fs.readFileSync(path.join(ROOT, 'core', 'a2a', 'identity-routes.js'), 'utf8');

  assert.doesNotMatch(SERVER, /app\.put\("\/api\/identity\/card/);
  assert.doesNotMatch(TRASY, /router\.put|app\.put/,
    'plik jest jedynym sposobem zmiany roli');
  assert.match(SERVER, /app\.use\(identityRoutes\(/);
});

test('karta roli nie jest juz skladana z domyslnych wartosci', () => {
  const SERVER = fs.readFileSync(path.join(ROOT, 'core', 'server.js'), 'utf8');
  // Sam handler, nie to, co po nim nastepuje.
  const od = SERVER.indexOf('app.get("/api/identity/card/:agent"');
  const handler = SERVER.slice(od, SERVER.indexOf('app.', od + 10));

  assert.doesNotMatch(handler, /claude_md_preview/);
  assert.doesNotMatch(handler, /version: "1\.0\.0"/);
  assert.doesNotMatch(handler, /agentIdentities/);
});

test('dokumentacja opisuje to, co rdzen faktycznie obsluguje', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const { SUPPORTED_METHODS } = require('../a2a/tasks');
  const { A2A_PROTOCOL_VERSION } = require('../a2a/cards');

  assert.match(readme, new RegExp(A2A_PROTOCOL_VERSION.replace(/\./g, '\\.')),
    'README ma podawac przypieta wersje protokolu');

  for (const metoda of SUPPORTED_METHODS) {
    assert.ok(readme.includes(metoda), `README nie wymienia obslugiwanej metody ${metoda}`);
  }
  assert.ok(readme.includes('message/stream'), 'README ma mowic, czego nie ma');
});

// README opisuje zachowanie, ktore zmienia sie w kodzie. Te asercje czytaja zrodlo
// i pytaja, czy dokument nadal mowi to samo.

test('README wymienia DOKLADNIE te przejscia stanu, ktore dopuszcza magazyn', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const { ALLOWED_TRANSITIONS } = require('../a2a/store');

  const stany = Object.keys(ALLOWED_TRANSITIONS).join('|');
  const wymienione = new Set(
    [...readme.matchAll(new RegExp(`\`(${stany}) → (${stany})\``, 'g'))]
      .map(m => `${m[1]} → ${m[2]}`));

  const dozwolone = new Set();
  for (const [from, doKad] of Object.entries(ALLOWED_TRANSITIONS)) {
    for (const to of doKad) dozwolone.add(`${from} → ${to}`);
  }

  // Rownosc zbiorow, nie zawieranie: dopisane w dokumencie przejscie, ktorego kod nie
  // dopuszcza, jest tak samo falszywe jak przemilczane.
  assert.deepEqual([...wymienione].sort(), [...dozwolone].sort());
});

test('README mowi, ze skrzynka jest surowsza niz task', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

  assert.match(readme, /a mailbox is not a task/);
  assert.match(readme, /sender of a message cannot look inside the box/);
});

test('README nazywa ograniczenia skrzynki', () => {
  // Proza sie zawija, wiec fraza potrafi lezec w dwoch wierszach. Dopasowujemy
  // tresc, nie lamanie linii.
  const plaski = (nazwa) =>
    fs.readFileSync(path.join(ROOT, nazwa), 'utf8').replace(/\s+/g, ' ');

  for (const dokument of [plaski('README.md')]) {
    assert.match(dokument, /requires_ack/, 'niewymuszane requires_ack ma byc nazwane');
    assert.match(dokument, /recorded, not enforced|recorded and returned, and nothing acts/);
    assert.match(dokument, /unknown addressee|no agent answers to/i,
      'przyjmowanie nieznanego adresata ma byc nazwane');
  }
});

test('README ostrzega, ze nazwy kontenerow sa globalne dla hosta', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').replace(/\s+/g, ' ');
  const compose = fs.readFileSync(path.join(ROOT, 'deploy', 'docker-compose.yml'), 'utf8');

  // Ostrzezenie ma sens tylko dopoki nazwy sa naprawde stale — gdy przestana,
  // ten test przypomni, ze trzeba je z README zdjac.
  assert.match(compose, /^name: /m);
  assert.match(compose, /container_name:/);

  assert.match(readme, /Different ports do not make a second stack/);
  assert.match(readme, /one installation per machine/);
});

test('README opisuje, co znaczy odmowa przy utracie polaczenia z Redis', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').replace(/\s+/g, ' ');

  assert.match(readme, /not-written/);
  assert.match(readme, /unknown/);
  assert.match(readme, /never abandoned on a timer|not abandoned/i,
    'README ma mowic, ze mutujacego zapisu nie porzucamy na zegarze');
});

test('dokument podpisu mowi, ze trasy A2A pytaja o wiecej niz tozsamosc', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'SIGNED-REQUESTS.md'), 'utf8')
    .replace(/\s+/g, ' ');

  assert.doesNotMatch(doc, /an authenticated agent is allowed to call every endpoint/,
    'to przestalo byc prawda, gdy skrzynka i task dostaly wlasne reguly');
  assert.match(doc, /each route decides what that identity may do/);
});

test('przyklady w README uzywaja tozsamosci, ktore tworzy bootstrap', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const role = fs.readdirSync(path.join(ROOT, 'agents'))
    .filter(f => f.endsWith('.md'))
    .map(f => f.replace(/\.md$/, '').toUpperCase());
  const klienci = ['TUI', 'status-collector', 'cs-core'];

  for (const [, tozsamosc] of readme.matchAll(/bin\/cs-curl -a ([A-Za-z0-9_-]+)/g)) {
    assert.ok(role.includes(tozsamosc) || klienci.includes(tozsamosc),
      `README podpisuje sie jako ${tozsamosc}, a bin/bootstrap-keys takiej tozsamosci nie tworzy`);
  }
});

test('dokument operatora wymienia dokladnie te sciezki, ktore bramka przepuszcza', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'SIGNED-REQUESTS.md'), 'utf8');
  const { ALWAYS_OPEN_PATHS, PUBLIC_READ_PATHS } = require('../middleware/verify-signed');

  for (const sciezka of [...ALWAYS_OPEN_PATHS, ...PUBLIC_READ_PATHS]) {
    assert.ok(doc.includes(sciezka), `${sciezka} jest otwarta w bramce, a dokument o niej milczy`);
  }
  assert.doesNotMatch(doc.split('\n')[2], /^Every request to every block must carry a valid ed25519 signature\. There is$/,
    'zdanie bez wyjatku przeczy liscie ponizej');
});

// Nie chodzi o to, czy liczby WYSTEPUJA, tylko przy czym stoja. Oczekiwany kod bierze
// sie z tego samego rozstrzygniecia, ktorego uzywa dyspozytor.
test('kazda dokumentacja przypisuje kody do klas metod tak, jak odpowiada dyspozytor', () => {
  const { PROTOCOL_METHODS, SUPPORTED_METHODS, refusalFor } = require('../a2a/tasks');

  const dokumenty = ['README.md',
    ...fs.readdirSync(path.join(ROOT, 'docs')).map(f => path.join('docs', f))];

  // Kazda metoda protokolu, ktorej rdzen nie obsluguje, plus nazwa spoza protokolu.
  const klasy = PROTOCOL_METHODS
    .filter(m => !SUPPORTED_METHODS.includes(m))
    .map(m => [new RegExp(`\`${m.replace(/\//g, '\\/')}\``, 'g'), refusalFor(m).code]);

  klasy.push([/\b(outside the protocol|protocol does not define|spoza protokolu)\b/gi,
    refusalFor('nazwa-spoza-protokolu').code]);
  klasy.push([/push[- ]notification[a-z ]*methods/gi,
    refusalFor('tasks/pushNotificationConfig/get').code]);

  assert.ok(klasy.length >= 7, `spodziewam sie wszystkich klas, mam ${klasy.length}`);

  const najblizszyKod = (tekst, od) => {
    const dopasowanie = /-32\d{3}/.exec(tekst.slice(od, od + 400));
    return dopasowanie ? dopasowanie[0] : null;
  };

  let sprawdzonych = 0;
  for (const nazwa of dokumenty) {
    const tekst = fs.readFileSync(path.join(ROOT, nazwa), 'utf8').replace(/\s+/g, ' ');

    for (const [wzorzec, kod] of klasy) {
      for (const trafienie of tekst.matchAll(wzorzec)) {
        const znaleziony = najblizszyKod(tekst, trafienie.index + trafienie[0].length);
        if (znaleziony === null) continue;      // wzmianka bez kodu obok niczego nie obiecuje
        sprawdzonych += 1;
        assert.equal(znaleziony, String(kod),
          `${nazwa}: "${trafienie[0]}" ma obok kod ${znaleziony}, a rdzen odpowiada ${kod}`);
      }
    }
  }

  assert.ok(sprawdzonych >= 5, `za malo sprawdzonych przypisan: ${sprawdzonych}`);
});

test('README opisuje obie drogi do niewiadomej i to, co dzieje sie z pamiecia', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').replace(/\s+/g, ' ');

  assert.match(readme, /some other value, or no key where a record stood/,
    'konflikt i brak klucza to osobna droga do unknown niz nieudany odczyt');
  assert.match(readme, /the store wins and that record replaces what this process held/);
  assert.match(readme, /memory stays as it was/);
});
