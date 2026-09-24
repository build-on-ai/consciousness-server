'use strict';

// HTTP na tych samych handlerach, ktore montuje rdzen. Atrapa dotyczy wylacznie
// podpisu: req._verifiedAgent ustawia jedna linia zamiast key-servera.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { a2aRoutes } = require('../a2a/routes');
const { createStore } = require('../a2a/store');
const { A2A_PROTOCOL_VERSION } = require('../a2a/cards');
const { serviceCard, SERVICE_ROLE } = require('../a2a/service-card');

const BASE = 'http://127.0.0.1:13032';

const KARTA_ROLI = {
  name: 'rola_probna',
  description: 'Roda probna.',
  version: '1.0.0',
  protocolVersion: A2A_PROTOCOL_VERSION,
  url: `${BASE}/api/a2a/rola_probna`,
  capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: true },
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  skills: [{ id: 'p', name: 'P', description: 'P.', tags: ['t'] }],
};

function pamieciowyBackend() {
  const rows = new Map();
  let kolejka = Promise.resolve();
  return {
    rows,
    padnij: false,
    async save(key, value) {
      if (this.padnij) throw new Error('redis unreachable');
      rows.set(key, JSON.stringify(value));
    },
    async loadAll() { return [...rows.values()].map(v => JSON.parse(v)); },
    async acquire(key) {
      let uwolnij;
      const moja = new Promise(resolve => { uwolnij = resolve; });
      const poprzednia = kolejka;
      kolejka = kolejka.then(() => moja, () => moja);
      await poprzednia.catch(() => {});
      return { key, token: 'token-atrapy', release: async () => uwolnij() };
    },
  };
}

function cardFor(role) {
  if (role === 'rola_wybuchowa') throw new TypeError('cos nieprzewidzianego w wyszukiwaniu karty');
  if (String(role).toLowerCase() === SERVICE_ROLE) return { kind: 'a2a', card: serviceCard(BASE) };
  if (String(role).toLowerCase() === 'rola_probna') return { kind: 'a2a', card: KARTA_ROLI };
  return null;
}

// Podnosi aplikacje na losowym porcie i oddaje funkcje wolajaca, w ktorej mozna
// wskazac, kim jest podpisany rozmowca — albo ze nie ma zadnego.
async function stanowisko({ backend = pamieciowyBackend() } = {}) {
  const store = createStore({ backend });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.headers['x-jako']) req._verifiedAgent = req.headers['x-jako'];
    if (req.headers['x-cialo-zepsute']) req._bodyParseError = 'Unexpected end of JSON input';
    next();
  });
  app.use(a2aRoutes({ store, cardFor }));

  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;

  return {
    store,
    backend,
    async zamknij() { await new Promise(r => server.close(r)); },
    async wolaj(metoda, sciezka, { jako, cialo, zepsuteCialo } = {}) {
      const naglowki = { 'Content-Type': 'application/json' };
      if (jako) naglowki['x-jako'] = jako;
      if (zepsuteCialo) naglowki['x-cialo-zepsute'] = '1';
      const odp = await fetch(`http://127.0.0.1:${port}${sciezka}`, {
        method: metoda,
        headers: naglowki,
        body: cialo === undefined ? undefined : JSON.stringify(cialo),
      });
      return { status: odp.status, tresc: await odp.json() };
    },
  };
}

function rpc(method, params, id = 1) {
  return { jsonrpc: '2.0', id, method, params };
}

const WIADOMOSC = {
  kind: 'message', messageId: 'm-1', role: 'user',
  parts: [{ kind: 'text', text: 'tresc' }],
};

// ─── adres z karty mowi protokolem, ktory karta deklaruje ───

test('message/send pod adresem z karty zwraca Task', async (t) => {
  const s = await stanowisko(); t.after(() => s.zamknij());

  const { status, tresc } = await s.wolaj('POST', '/api/a2a/rola_probna',
    { jako: 'SENDER', cialo: rpc('message/send', { message: WIADOMOSC }) });

  assert.equal(status, 200);
  assert.equal(tresc.jsonrpc, '2.0');
  assert.equal(tresc.id, 1);
  assert.equal(tresc.result.kind, 'task');
  assert.equal(tresc.result.status.state, 'submitted');
});

test('tasks/get zwraca ten sam task, a cudzy jest nieznany', async (t) => {
  const s = await stanowisko(); t.after(() => s.zamknij());

  const wyslany = await s.wolaj('POST', '/api/a2a/rola_probna',
    { jako: 'SENDER', cialo: rpc('message/send', { message: WIADOMOSC }) });
  const id = wyslany.tresc.result.id;

  const swoj = await s.wolaj('POST', '/api/a2a/rola_probna',
    { jako: 'SENDER', cialo: rpc('tasks/get', { id }, 2) });
  assert.equal(swoj.tresc.result.id, id);

  const obcy = await s.wolaj('POST', '/api/a2a/rola_probna',
    { jako: 'STRANGER', cialo: rpc('tasks/get', { id }, 3) });
  assert.equal(obcy.tresc.error.code, -32001);
});

test('metoda protokolu nieobslugiwana to -32004, spoza protokolu to -32601', async (t) => {
  const s = await stanowisko(); t.after(() => s.zamknij());

  for (const metoda of ['message/stream', 'tasks/resubscribe', 'tasks/cancel']) {
    const odp = await s.wolaj('POST', '/api/a2a/rola_probna',
      { jako: 'SENDER', cialo: rpc(metoda, { message: WIADOMOSC }) });
    assert.equal(odp.tresc.error.code, -32004, `${metoda} jest metoda protokolu`);
  }

  // Ukosnik w nazwie nie czyni metody metoda protokolu: o tym decyduje lista ze schematu.
  for (const metoda of ['zrobcos', 'foo/bar', 'tasks/wymyslone', 'message/cokolwiek']) {
    const odp = await s.wolaj('POST', '/api/a2a/rola_probna',
      { jako: 'SENDER', cialo: rpc(metoda, {}) });
    assert.equal(odp.tresc.error.code, -32601, `${metoda} nie jest metoda protokolu`);
  }
});

test('metody powiadomien push maja wlasny kod, bo karta mowi o nich wprost', async (t) => {
  const s = await stanowisko(); t.after(() => s.zamknij());

  for (const metoda of ['tasks/pushNotificationConfig/get', 'tasks/pushNotificationConfig/set']) {
    const odp = await s.wolaj('POST', '/api/a2a/rola_probna',
      { jako: 'SENDER', cialo: rpc(metoda, {}) });
    assert.equal(odp.tresc.error.code, -32003, metoda);
  }
});

test('zle parametry i zepsute cialo maja wlasne kody', async (t) => {
  const s = await stanowisko(); t.after(() => s.zamknij());

  const zleParametry = await s.wolaj('POST', '/api/a2a/rola_probna',
    { jako: 'SENDER', cialo: rpc('message/send', { message: { kind: 'message', messageId: 'm', role: 'user' } }) });
  assert.equal(zleParametry.tresc.error.code, -32602);
  assert.match(zleParametry.tresc.error.data, /parts/);

  const zepsute = await s.wolaj('POST', '/api/a2a/rola_probna',
    { jako: 'SENDER', cialo: {}, zepsuteCialo: true });
  assert.equal(zepsute.tresc.error.code, -32700);
});

test('rola bez karty nie ma adresu', async (t) => {
  const s = await stanowisko(); t.after(() => s.zamknij());

  const { status, tresc } = await s.wolaj('POST', '/api/a2a/nie_ma_takiej',
    { jako: 'SENDER', cialo: rpc('tasks/get', { id: 'x' }) });

  assert.equal(status, 404);
  assert.equal(tresc.error, 'agent_not_found');
});

// ─── adres z karty tej uslugi odpowiada protokolem ───

test('url z karty uslugi jest trasa, ktora odpowiada Taskiem', async (t) => {
  const s = await stanowisko(); t.after(() => s.zamknij());

  const karta = serviceCard(BASE);
  const sciezka = new URL(karta.url).pathname;

  const { tresc } = await s.wolaj('POST', sciezka,
    { jako: 'SENDER', cialo: rpc('message/send', { message: WIADOMOSC }) });

  assert.equal(tresc.result.kind, 'task');
});

test('karta uslugi nie zalezy od tego, kto pyta', () => {
  assert.deepEqual(serviceCard(BASE), serviceCard(BASE));
});

// ─── nadawca pochodzi z podpisu ───

test('cudzy nadawca w tresci to odmowa, bez zapisu', async (t) => {
  const s = await stanowisko(); t.after(() => s.zamknij());

  const { status, tresc } = await s.wolaj('POST', '/api/a2a/send', {
    jako: 'SENDER',
    cialo: { from_agent: 'STRANGER', to_agent: 'ADDRESSEE', message_type: 'test', payload: {} },
  });

  assert.equal(status, 403);
  assert.equal(tresc.error, 'authorship_mismatch');
  assert.equal(s.store.all().length, 0, 'odmowa nie moze niczego zostawic w magazynie');
});

test('brak nadawcy w tresci to nadal autor z podpisu', async (t) => {
  const s = await stanowisko(); t.after(() => s.zamknij());

  const { status } = await s.wolaj('POST', '/api/a2a/send',
    { jako: 'SENDER', cialo: { to_agent: 'ADDRESSEE', message_type: 'test', payload: {} } });

  assert.equal(status, 200);
  assert.equal(s.store.all()[0].from, 'SENDER');
});

test('zgodny nadawca przechodzi i jest zapisany z podpisu', async (t) => {
  const s = await stanowisko(); t.after(() => s.zamknij());

  await s.wolaj('POST', '/api/a2a/send', {
    jako: 'SENDER',
    cialo: { from_agent: 'sender', to_agent: 'ADDRESSEE', message_type: 'test', payload: {} },
  });

  assert.equal(s.store.all()[0].from, 'SENDER');
});

test('zadanie bez podpisu nie wysyla niczego', async (t) => {
  const s = await stanowisko(); t.after(() => s.zamknij());

  const { status, tresc } = await s.wolaj('POST', '/api/a2a/send',
    { cialo: { to_agent: 'ADDRESSEE', message_type: 'test', payload: {} } });

  assert.equal(status, 401);
  assert.equal(tresc.error, 'unsigned_request');
  assert.equal(s.store.all().length, 0);
});

test('send przez HTTP odmawia 503, gdy magazyn nie przyjmuje zapisu', async (t) => {
  const backend = pamieciowyBackend();
  backend.padnij = true;
  const s = await stanowisko({ backend }); t.after(() => s.zamknij());

  const { status, tresc } = await s.wolaj('POST', '/api/a2a/send',
    { jako: 'SENDER', cialo: { to_agent: 'ADDRESSEE', message_type: 'test', payload: {} } });

  assert.equal(status, 503);
  assert.equal(tresc.error, 'a2a_store_unavailable');
  assert.equal(tresc.retryable, true);
});

// ─── kto moze potwierdzic i kto moze czytac ───

async function zWiadomoscia(t) {
  const s = await stanowisko(); t.after(() => s.zamknij());
  await s.wolaj('POST', '/api/a2a/send',
    { jako: 'SENDER', cialo: { to_agent: 'ADDRESSEE', message_type: 'test', payload: {} } });
  return { s, id: s.store.all()[0].id };
}

test('nadawca nie potwierdza wlasnej wiadomosci', async (t) => {
  const { s, id } = await zWiadomoscia(t);

  const { status, tresc } = await s.wolaj('POST', `/api/a2a/ack/${id}`, { jako: 'SENDER', cialo: {} });

  assert.equal(status, 403);
  assert.equal(tresc.error, 'not_the_addressee');
  assert.equal(s.store.get(id).status, 'pending', 'odmowa nie zmienia stanu');
});

test('obcy z nazwa adresata w tresci tez nie potwierdza', async (t) => {
  const { s, id } = await zWiadomoscia(t);

  const { status } = await s.wolaj('POST', `/api/a2a/ack/${id}`,
    { jako: 'STRANGER', cialo: { agent: 'ADDRESSEE' } });

  assert.equal(status, 403);
  assert.equal(s.store.get(id).status, 'pending');
});

test('adresat potwierdza, a powtorzenie zachowuje pierwszy czas', async (t) => {
  const { s, id } = await zWiadomoscia(t);

  const pierwszy = await s.wolaj('POST', `/api/a2a/ack/${id}`, { jako: 'ADDRESSEE', cialo: {} });
  assert.equal(pierwszy.status, 200);
  const czas = s.store.get(id).acked_at;

  const drugi = await s.wolaj('POST', `/api/a2a/ack/${id}`, { jako: 'ADDRESSEE', cialo: {} });
  assert.equal(drugi.status, 200);
  assert.equal(s.store.get(id).acked_at, czas);
});

test('potwierdzenie nieistniejacej wiadomosci to 404', async (t) => {
  const { s } = await zWiadomoscia(t);

  const { status } = await s.wolaj('POST', '/api/a2a/ack/nie-ma-takiego', { jako: 'ADDRESSEE', cialo: {} });
  assert.equal(status, 404);
});

test('obcy nie czyta cudzej skrzynki, a odczyt niczego nie zmienia', async (t) => {
  const { s, id } = await zWiadomoscia(t);

  const obcy = await s.wolaj('GET', '/api/a2a/inbox/ADDRESSEE', { jako: 'STRANGER' });
  assert.equal(obcy.status, 403);

  const adresat = await s.wolaj('GET', '/api/a2a/inbox/ADDRESSEE', { jako: 'ADDRESSEE' });
  assert.equal(adresat.status, 200);
  assert.equal(adresat.tresc.count, 1);
  assert.equal(s.store.get(id).status, 'pending', 'GET nie przestawia stanu');
});

test('dostawa jest osobnym zadaniem i odpowiada tak samo dwa razy', async (t) => {
  const { s, id } = await zWiadomoscia(t);

  const pierwsza = await s.wolaj('POST', '/api/a2a/inbox/ADDRESSEE', { jako: 'ADDRESSEE', cialo: {} });
  assert.equal(pierwsza.tresc.delivered_now, 1);
  assert.equal(s.store.get(id).status, 'delivered');

  const druga = await s.wolaj('POST', '/api/a2a/inbox/ADDRESSEE', { jako: 'ADDRESSEE', cialo: {} });
  assert.equal(druga.tresc.count, pierwsza.tresc.count);
  assert.equal(druga.tresc.delivered_now, 0);
});
// Message.taskId znaczy "to jest ciag dalszy tamtego zadania", a nie "zrob nowe".

test('message/send z taskId dopisuje sie do istniejacego zadania', async (t) => {
  const s = await stanowisko(); t.after(() => s.zamknij());

  const pierwsza = await s.wolaj('POST', '/api/a2a/rola_probna',
    { jako: 'SENDER', cialo: rpc('message/send', { message: WIADOMOSC }) });
  const id = pierwsza.tresc.result.id;

  const druga = await s.wolaj('POST', '/api/a2a/rola_probna', {
    jako: 'SENDER',
    cialo: rpc('message/send', {
      message: { ...WIADOMOSC, messageId: 'm-2', taskId: id, parts: [{ kind: 'text', text: 'ciag dalszy' }] },
    }, 2),
  });

  assert.equal(druga.tresc.result.id, id, 'to ma byc TO SAMO zadanie');
  assert.equal(druga.tresc.result.history.length, 2);
  assert.equal(druga.tresc.result.history[1].messageId, 'm-2');
  assert.equal(s.store.all().length, 1, 'kontynuacja nie tworzy drugiego rekordu');
});

test('taskId, ktorego nie ma, to nie jest nowe zadanie', async (t) => {
  const s = await stanowisko(); t.after(() => s.zamknij());

  const { tresc } = await s.wolaj('POST', '/api/a2a/rola_probna', {
    jako: 'SENDER',
    cialo: rpc('message/send', { message: { ...WIADOMOSC, taskId: 'nie-ma-takiego' } }),
  });

  assert.equal(tresc.error.code, -32001);
  assert.equal(s.store.all().length, 0);
});

test('cudzego zadania nie da sie kontynuowac', async (t) => {
  const s = await stanowisko(); t.after(() => s.zamknij());

  const moje = await s.wolaj('POST', '/api/a2a/rola_probna',
    { jako: 'SENDER', cialo: rpc('message/send', { message: WIADOMOSC }) });

  const obcy = await s.wolaj('POST', '/api/a2a/rola_probna', {
    jako: 'STRANGER',
    cialo: rpc('message/send', { message: { ...WIADOMOSC, messageId: 'm-3', taskId: moje.tresc.result.id } }, 4),
  });

  assert.equal(obcy.tresc.error.code, -32001);
  assert.equal(s.store.get(moje.tresc.result.id).followups, undefined);
});

test('do zadania potwierdzonego nie dopisuje sie wiadomosci', async (t) => {
  const s = await stanowisko(); t.after(() => s.zamknij());

  const zadanie = await s.wolaj('POST', '/api/a2a/rola_probna',
    { jako: 'SENDER', cialo: rpc('message/send', { message: WIADOMOSC }) });
  const id = zadanie.tresc.result.id;
  await s.store.transition(id, 'acked', { by: 'rola_probna' });

  const { tresc } = await s.wolaj('POST', '/api/a2a/rola_probna', {
    jako: 'SENDER',
    cialo: rpc('message/send', { message: { ...WIADOMOSC, messageId: 'm-late', taskId: id } }, 9),
  });

  assert.equal(tresc.error.code, -32602);
  assert.match(tresc.error.data, /acked/);
  assert.equal(s.store.get(id).followups, undefined);
});

test('odmowa z magazynu niesie to, co wiadomo o zapisie', async (t) => {
  const backend = pamieciowyBackend();
  backend.padnij = true;
  backend.read = async () => null;              // odczyt kontrolny widzi stara wartosc
  const s = await stanowisko({ backend }); t.after(() => s.zamknij());

  const { status, tresc } = await s.wolaj('POST', '/api/a2a/send',
    { jako: 'SENDER', cialo: { to_agent: 'ADDRESSEE', message_type: 'test', payload: {} } });

  assert.equal(status, 503);
  assert.equal(tresc.outcome, 'not-written', 'wolajacy ma wiedziec, czy zapis na pewno nie doszedl');
});

test('gdy nawet odczyt kontrolny zawiodl, odmowa mowi o tym wprost', async (t) => {
  const backend = pamieciowyBackend();
  backend.padnij = true;
  backend.read = async () => { throw new Error('connection lost'); };
  const s = await stanowisko({ backend }); t.after(() => s.zamknij());

  const { status, tresc } = await s.wolaj('POST', '/api/a2a/send',
    { jako: 'SENDER', cialo: { to_agent: 'ADDRESSEE', message_type: 'test', payload: {} } });

  assert.equal(status, 503);
  assert.equal(tresc.outcome, 'unknown');
});

// Nazwa metody przychodzi z sieci: __proto__ i constructor sa dziedziczone po
// Object, wiec przy wyszukiwaniu po wlasnosci wygladalyby na obslugiwane.
test('nazwy dziedziczone po Object nie udaja obslugiwanych metod', async (t) => {
  const s = await stanowisko(); t.after(() => s.zamknij());

  for (const metoda of ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
    const { status, tresc } = await s.wolaj('POST', '/api/a2a/rola_probna',
      { jako: 'SENDER', cialo: rpc(metoda, {}) });

    assert.equal(status, 200, `${metoda}: rdzen ma odpowiedziec, a nie paść`);
    assert.equal(tresc.error.code, -32601, `${metoda} nie jest metoda protokolu`);
  }
});

test('rdzen odpowiada dalej po zadaniu z odziedziczona nazwa', async (t) => {
  const s = await stanowisko(); t.after(() => s.zamknij());

  await s.wolaj('POST', '/api/a2a/rola_probna', { jako: 'SENDER', cialo: rpc('__proto__', {}) });

  const potem = await s.wolaj('POST', '/api/a2a/rola_probna',
    { jako: 'SENDER', cialo: rpc('message/send', { message: WIADOMOSC }) });
  assert.equal(potem.tresc.result.kind, 'task', 'jedno zle zadanie nie moze zabic procesu');
});

// Trasa odpowiada sieci, wiec wyjatek w niej nie moze zabrac ze soba procesu.
test('blad, ktory wymknie sie z handlera, konczy sie odpowiedzia, a nie smiercia procesu', async (t) => {
  const s = await stanowisko(); t.after(() => s.zamknij());

  const { status, tresc } = await s.wolaj('POST', '/api/a2a/rola_wybuchowa',
    { jako: 'SENDER', cialo: rpc('message/send', { message: WIADOMOSC }) });

  assert.equal(status, 500);
  assert.equal(tresc.error.code, -32603);

  const potem = await s.wolaj('POST', '/api/a2a/rola_probna',
    { jako: 'SENDER', cialo: rpc('tasks/get', { id: 'x' }, 2) });
  assert.ok(potem.tresc, 'proces ma dalej odpowiadac');
});
