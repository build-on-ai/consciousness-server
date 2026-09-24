'use strict';

// Wiadomosc, ktora ginie po restarcie, nie zostala przyjeta. Zapis poprzedza
// odpowiedz, przejscia maja dozwolonego poprzednika i autora, rownolegle nie gina.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createStore, StoreUnavailable, ALLOWED_TRANSITIONS } = require('../a2a/store');

// Zaplecze udajace Redis: trzyma bajty, potrafi paść i serializuje sekcje krytyczne.
function fakeBackend({ failOnSave = false } = {}) {
  const rows = new Map();
  let locks = Promise.resolve();
  return {
    rows,
    calls: { save: 0, loadAll: 0 },
    async save(key, value) {
      this.calls.save += 1;
      if (failOnSave) throw new Error('redis unreachable');
      rows.set(key, JSON.stringify(value));
    },
    async loadAll() {
      this.calls.loadAll += 1;
      return [...rows.values()];   // surowe napisy, jak z Redisa
    },
    async acquire(key) {
      let uwolnij;
      const moja = new Promise(resolve => { uwolnij = resolve; });
      const poprzednia = locks;
      locks = locks.then(() => moja, () => moja);
      await poprzednia.catch(() => {});
      return { key, token: 'token-atrapy', release: async () => uwolnij() };
    },
  };
}

function nowFactory(start = 1000) {
  let t = start;
  return () => new Date(t++).toISOString();
}

test('wiadomosc jest zapisana zanim nadawca uslyszy sukces', async () => {
  const backend = fakeBackend();
  const store = createStore({ backend, now: nowFactory() });

  const msg = await store.add({ from: 'SENDER', to: 'ADDRESSEE', type: 'test', payload: {} });

  assert.ok(msg.id);
  assert.equal(msg.status, 'pending');
  assert.equal(backend.calls.save, 1);
  assert.ok(backend.rows.has(`a2a:message:${msg.id}`));
});

test('gdy magazyn nie odpowiada, wiadomosc nie jest przyjeta', async () => {
  const backend = fakeBackend({ failOnSave: true });
  const store = createStore({ backend, now: nowFactory() });

  await assert.rejects(
    () => store.add({ from: 'SENDER', to: 'ADDRESSEE', type: 'test', payload: {} }),
    (err) => err instanceof StoreUnavailable);

  assert.equal(store.all().length, 0, 'odrzucona wiadomosc nie moze zostac w pamieci');
});

test('po restarcie wiadomosci wracaja z tym samym id, trescia i stanem', async () => {
  const backend = fakeBackend();
  const pierwszy = createStore({ backend, now: nowFactory() });
  const msg = await pierwszy.add({ from: 'SENDER', to: 'ADDRESSEE', type: 'test', payload: { a: 1 } });
  await pierwszy.transition(msg.id, 'delivered', { by: 'ADDRESSEE' });

  const drugi = createStore({ backend, now: nowFactory() });
  await drugi.hydrate();

  const wrocila = drugi.get(msg.id);
  assert.equal(wrocila.id, msg.id);
  assert.equal(wrocila.status, 'delivered');
  assert.deepEqual(wrocila.payload, { a: 1 });
  assert.equal(wrocila.history.length, 2);
});

test('historia odtwarza kolejnosc przejsc, nie tylko stan koncowy', async () => {
  const backend = fakeBackend();
  const store = createStore({ backend, now: nowFactory() });
  const msg = await store.add({ from: 'SENDER', to: 'ADDRESSEE', type: 'test', payload: {} });
  await store.transition(msg.id, 'delivered', { by: 'ADDRESSEE' });
  await store.transition(msg.id, 'acked', { by: 'ADDRESSEE' });

  const odtworzony = createStore({ backend, now: nowFactory() });
  await odtworzony.hydrate();

  assert.deepEqual(odtworzony.get(msg.id).history.map(h => h.to),
    ['pending', 'delivered', 'acked']);
  assert.deepEqual(odtworzony.get(msg.id).history.map(h => h.by),
    ['SENDER', 'ADDRESSEE', 'ADDRESSEE']);
});

test('przejscie bez dozwolonego poprzednika jest odrzucone i nic nie zmienia', async () => {
  const backend = fakeBackend();
  const store = createStore({ backend, now: nowFactory() });
  const msg = await store.add({ from: 'SENDER', to: 'ADDRESSEE', type: 'test', payload: {} });
  await store.transition(msg.id, 'acked', { by: 'ADDRESSEE' });

  const przed = JSON.stringify(store.get(msg.id));
  await assert.rejects(() => store.transition(msg.id, 'delivered', { by: 'ADDRESSEE' }),
    /transition/);
  assert.equal(JSON.stringify(store.get(msg.id)), przed);
});

test('powtorzony ack zachowuje pierwszy czas i nie dokleja historii', async () => {
  const backend = fakeBackend();
  const store = createStore({ backend, now: nowFactory() });
  const msg = await store.add({ from: 'SENDER', to: 'ADDRESSEE', type: 'test', payload: {} });

  const pierwszy = await store.transition(msg.id, 'acked', { by: 'ADDRESSEE' });
  const drugi = await store.transition(msg.id, 'acked', { by: 'ADDRESSEE' });

  assert.equal(drugi.acked_at, pierwszy.acked_at);
  assert.equal(drugi.history.length, 2);
});

test('dwa rownolegle acki daja jeden stan i jeden czas', async () => {
  const backend = fakeBackend();
  const store = createStore({ backend, now: nowFactory() });
  const msg = await store.add({ from: 'SENDER', to: 'ADDRESSEE', type: 'test', payload: {} });

  const [a, b] = await Promise.all([
    store.transition(msg.id, 'acked', { by: 'ADDRESSEE' }),
    store.transition(msg.id, 'acked', { by: 'ADDRESSEE' }),
  ]);

  assert.equal(a.acked_at, b.acked_at);
  assert.equal(store.get(msg.id).history.filter(h => h.to === 'acked').length, 1);
});

test('autor przejscia jest zapisany, bo bez niego historia nie jest dowodem', async () => {
  const backend = fakeBackend();
  const store = createStore({ backend, now: nowFactory() });
  const msg = await store.add({ from: 'SENDER', to: 'ADDRESSEE', type: 'test', payload: {} });

  await assert.rejects(() => store.transition(msg.id, 'delivered', {}), /by/);
});

test('skrzynka adresata nie pokazuje cudzych wiadomosci', async () => {
  const backend = fakeBackend();
  const store = createStore({ backend, now: nowFactory() });
  await store.add({ from: 'SENDER', to: 'ADDRESSEE', type: 'test', payload: {} });
  await store.add({ from: 'SENDER', to: 'OTHER_AGENT', type: 'test', payload: {} });

  assert.equal(store.forRecipient('ADDRESSEE').length, 1);
  assert.equal(store.forRecipient('ADDRESSEE')[0].to, 'ADDRESSEE');
});

test('tabela przejsc jest jawna, a stan koncowy nie ma nastepnika', () => {
  assert.deepEqual(ALLOWED_TRANSITIONS.acked, []);
  assert.ok(ALLOWED_TRANSITIONS.pending.includes('delivered'));
});

test('magazyn ma wlasna przestrzen nazw, nie dokleja sie do task:', async () => {
  const backend = fakeBackend();
  const store = createStore({ backend, now: nowFactory() });
  const msg = await store.add({ from: 'SENDER', to: 'ADDRESSEE', type: 'test', payload: {} });

  for (const key of backend.rows.keys()) {
    assert.match(key, /^a2a:/);
    assert.doesNotMatch(key, /^task:/);
  }
  assert.ok(msg.id);
});

test('operacja, ktora nie odpowiada, konczy sie bledem, a nie czekaniem', async () => {
  const { withTimeout } = require('../a2a/store');

  await assert.rejects(
    () => withTimeout(new Promise(() => {}), 20, 'zapis'),
    /zapis timed out after 20ms/);

  assert.equal(await withTimeout(Promise.resolve('gotowe'), 50, 'zapis'), 'gotowe');
});

test('zaplecze, ktore wisi, nie przyjmuje wiadomosci', async () => {
  const { withTimeout } = require('../a2a/store');
  const wiszace = {
    async save() { await withTimeout(new Promise(() => {}), 20, 'zapis'); },
    async loadAll() { return []; },
    async withLock(_key, fn) { return fn(); },
  };
  const store = createStore({ backend: wiszace, now: nowFactory() });

  await assert.rejects(() => store.add({ from: 'A', to: 'B', type: 't', payload: {} }),
    (err) => err instanceof StoreUnavailable);
  assert.equal(store.all().length, 0);
});

// Restart ma przezyc kazdy stan wiadomosci, razem z pierwszym czasem potwierdzenia,
// ktory jest tym prawdziwym.

test('wiadomosc dostarczona wraca po restarcie jako dostarczona, z czasem dostawy', async () => {
  const backend = fakeBackend();
  const przed = createStore({ backend, now: nowFactory() });
  const msg = await przed.add({ from: 'SENDER', to: 'ADDRESSEE', type: 't', payload: {} });
  const dostarczona = await przed.transition(msg.id, 'delivered', { by: 'ADDRESSEE' });

  const po = createStore({ backend, now: nowFactory(9000) });
  await po.hydrate();

  assert.equal(po.get(msg.id).status, 'delivered');
  assert.equal(po.get(msg.id).delivered_at, dostarczona.delivered_at);
});

test('wiadomosc potwierdzona wraca po restarcie z PIERWSZYM acked_at', async () => {
  const backend = fakeBackend();
  const przed = createStore({ backend, now: nowFactory() });
  const msg = await przed.add({ from: 'SENDER', to: 'ADDRESSEE', type: 't', payload: {} });
  const potwierdzona = await przed.transition(msg.id, 'acked', { by: 'ADDRESSEE' });

  const po = createStore({ backend, now: nowFactory(9000) });
  await po.hydrate();

  assert.equal(po.get(msg.id).status, 'acked');
  assert.equal(po.get(msg.id).acked_at, potwierdzona.acked_at);

  // Ponowny ack juz po restarcie tez nie przestawia pierwszego czasu.
  const znowu = await po.transition(msg.id, 'acked', { by: 'ADDRESSEE' });
  assert.equal(znowu.acked_at, potwierdzona.acked_at);
});

test('historia przezywa restart w calosci, z autorami', async () => {
  const backend = fakeBackend();
  const przed = createStore({ backend, now: nowFactory() });
  const msg = await przed.add({ from: 'SENDER', to: 'ADDRESSEE', type: 't', payload: {} });
  await przed.transition(msg.id, 'delivered', { by: 'ADDRESSEE' });
  await przed.transition(msg.id, 'acked', { by: 'ADDRESSEE' });

  const po = createStore({ backend, now: nowFactory(9000) });
  await po.hydrate();

  assert.deepEqual(po.get(msg.id).history.map(h => [h.from, h.to, h.by]), [
    [null, 'pending', 'SENDER'],
    ['pending', 'delivered', 'ADDRESSEE'],
    ['delivered', 'acked', 'ADDRESSEE'],
  ]);
});

test('gdy zapis przejscia pada, stan w pamieci zostaje nietkniety', async () => {
  const backend = fakeBackend();
  const store = createStore({ backend, now: nowFactory() });
  const msg = await store.add({ from: 'SENDER', to: 'ADDRESSEE', type: 't', payload: {} });
  const przed = JSON.stringify(store.get(msg.id));

  backend.save = async () => { throw new Error('redis unreachable'); };

  await assert.rejects(() => store.transition(msg.id, 'acked', { by: 'ADDRESSEE' }),
    (err) => err instanceof StoreUnavailable);
  assert.equal(JSON.stringify(store.get(msg.id)), przed,
    'nieudany zapis nie moze zostawic w pamieci stanu, ktorego nie ma w magazynie');
});

test('stan po restarcie liczy sie z magazynu, nie z pamieci poprzedniego procesu', async () => {
  const backend = fakeBackend();
  const przed = createStore({ backend, now: nowFactory() });
  await przed.add({ from: 'SENDER', to: 'ADDRESSEE', type: 't', payload: {} });
  await przed.add({ from: 'SENDER', to: 'OTHER_AGENT', type: 't', payload: {} });

  const po = createStore({ backend, now: nowFactory(9000) });
  assert.equal(po.all().length, 0, 'przed hydratacja nowy proces nie wie nic');
  assert.equal(await po.hydrate(), 2);
  assert.deepEqual(po.countsByStatus(), { pending: 2, delivered: 0, acked: 0 });
});

// Blokada i hydratacja nie moga siebie nawzajem przewracac.

test('klucz blokady lezy poza zakresem hydratacji wiadomosci', () => {
  const { NAMESPACE, LOCK_NAMESPACE, lockKeyFor } = require('../a2a/store');

  assert.ok(!lockKeyFor('abc').startsWith(NAMESPACE),
    'inaczej skanowanie a2a:message:* zlapie klucz blokady, ktorego nikt nie sparsuje');
  assert.ok(lockKeyFor('abc').startsWith(LOCK_NAMESPACE));
});

test('wpis, ktorego nie da sie sparsowac, nie kasuje calej hydratacji', async () => {
  const backend = fakeBackend();
  const store = createStore({ backend, now: nowFactory() });
  const msg = await store.add({ from: 'SENDER', to: 'ADDRESSEE', type: 't', payload: {} });

  // Cos, co nie jest wiadomoscia — np. token blokady, ktory trafil w zakres skanu.
  backend.rows.set('a2a:message:smiec', 'nie-jest-jsonem');

  const po = createStore({ backend, now: nowFactory(9000) });
  assert.equal(await po.hydrate(), 1, 'jedna poprawna wiadomosc ma wrocic');
  assert.equal(po.get(msg.id).id, msg.id);
});

test('gdy blokada nie odpowiada, przejscie konczy sie bledem, a nie czekaniem', async () => {
  const backend = fakeBackend();
  backend.acquire = () => new Promise(() => {});   // nigdy nie oddaje sterowania
  const store = createStore({ backend, now: nowFactory(), lockTimeoutMs: 30 });

  const start = Date.now();
  await assert.rejects(() => store.transition('nieistotne', 'acked', { by: 'ADDRESSEE' }),
    (err) => err instanceof StoreUnavailable);
  assert.ok(Date.now() - start < 2000, 'odmowa ma przyjsc szybko, nie po minutach');
});

test('blokada, ktora przyszla po odmowie, niczego nie zmienia', async () => {
  const backend = fakeBackend();
  const store = createStore({ backend, now: nowFactory(), lockTimeoutMs: 20 });
  const msg = await store.add({ from: 'SENDER', to: 'ADDRESSEE', type: 't', payload: {} });

  // Zaplecze oddaje blokade dopiero po 80 ms — dlugo po tym, jak wolajacy uslyszal odmowe.
  backend.acquire = async (key) => {
    await new Promise(r => setTimeout(r, 80));
    return { key, token: 'spozniony', release: async () => {} };
  };

  await assert.rejects(() => store.transition(msg.id, 'acked', { by: 'ADDRESSEE' }),
    (err) => err instanceof StoreUnavailable);

  await new Promise(r => setTimeout(r, 150));
  assert.equal(store.get(msg.id).status, 'pending',
    'stan po odmowie musi zostac taki, jaki byl — inaczej odmowa byla nieprawda');
  assert.equal(JSON.parse(backend.rows.get(`a2a:message:${msg.id}`)).status, 'pending');
});

test('uszkodzony wpis jest zglaszany, nie pomijany w milczeniu', async () => {
  const backend = fakeBackend();
  const store = createStore({ backend, now: nowFactory() });
  await store.add({ from: 'SENDER', to: 'ADDRESSEE', type: 't', payload: {} });
  backend.rows.set('a2a:message:uszkodzony', '{ to nie jest json');

  const po = createStore({ backend, now: nowFactory(9000) });
  assert.equal(await po.hydrate(), 1);
  assert.equal(po.hydrationProblems().length, 1, 'strata ma byc widoczna');
  assert.match(po.hydrationProblems()[0], /pomini/);
});

// Dopisanie wiadomosci to zmiana stanu tak samo jak przejscie, wiec podlega tej
// samej dyscyplinie: ograniczony czas i brak skutkow po udzielonej odmowie.

test('dopisanie wiadomosci przy wiszacej blokadzie konczy sie odmowa, nie czekaniem', async () => {
  const backend = fakeBackend();
  const store = createStore({ backend, now: nowFactory(), lockTimeoutMs: 30 });
  const msg = await store.add({ from: 'SENDER', to: 'ADDRESSEE', type: 't', payload: {} });

  backend.acquire = () => new Promise(() => {});

  const start = Date.now();
  await assert.rejects(() => store.append(msg.id, { kind: 'message' }, { by: 'SENDER' }),
    (err) => err instanceof StoreUnavailable);
  assert.ok(Date.now() - start < 2000);
});

test('blokada spozniona po odmowie nie dopisuje wiadomosci', async () => {
  const backend = fakeBackend();
  const store = createStore({ backend, now: nowFactory(), lockTimeoutMs: 20 });
  const msg = await store.add({ from: 'SENDER', to: 'ADDRESSEE', type: 't', payload: {} });

  backend.acquire = async (key) => {
    await new Promise(r => setTimeout(r, 80));
    return { key, token: 'spozniony', release: async () => {} };
  };

  await assert.rejects(() => store.append(msg.id, { kind: 'message', messageId: 'spozniona' }, { by: 'SENDER' }),
    (err) => err instanceof StoreUnavailable);

  await new Promise(r => setTimeout(r, 150));
  assert.equal(store.get(msg.id).followups, undefined,
    'odmowa musi zostac odmowa takze po tym, jak blokada w koncu przyszla');
});

test('dopisana wiadomosc nie udaje przejscia stanu', async () => {
  const backend = fakeBackend();
  const store = createStore({ backend, now: nowFactory() });
  const msg = await store.add({ from: 'SENDER', to: 'ADDRESSEE', type: 't', payload: {} });

  const po = await store.append(msg.id, { kind: 'message', messageId: 'm-2' }, { by: 'SENDER' });

  assert.equal(po.followups.length, 1);
  assert.equal(po.history.length, 1, 'historia stanow ma opisywac stany, nie wiadomosci');
  assert.equal(po.status, 'pending');
});

test('wszystkie sciezki zmiany ida przez jedna strzezona blokade', () => {
  const fs = require('fs');
  const path = require('path');
  const zrodlo = fs.readFileSync(path.join(__dirname, '..', 'a2a', 'store.js'), 'utf8');

  const wywolania = zrodlo.match(/backend\.acquire\(/g) || [];
  assert.equal(wywolania.length, 1,
    'blokada ma byc brana w jednym miejscu — kazde kolejne to kopia zabezpieczen, ktora sie rozjedzie');
  assert.match(zrodlo, /function withGuardedLock\(/);
});

// Odpowiedz musi odpowiadac stanowi magazynu. Z zegarem scigamy tylko ZDOBYCIE
// blokady; po nim praca biegnie do konca i nigdy nie ma odmowy z zapisanym rekordem.

test('wolny zapis po zdobyciu blokady konczy sie sukcesem zgodnym ze stanem', async () => {
  const backend = fakeBackend();
  const store = createStore({ backend, now: nowFactory(), lockTimeoutMs: 20 });
  const msg = await store.add({ from: 'SENDER', to: 'ADDRESSEE', type: 't', payload: {} });

  const czystySave = backend.save.bind(backend);
  backend.save = async (key, value) => {
    await new Promise(r => setTimeout(r, 80));       // duzo dluzej niz limit blokady
    return czystySave(key, value);
  };

  const wynik = await store.transition(msg.id, 'acked', { by: 'ADDRESSEE' });

  assert.equal(wynik.status, 'acked');
  assert.equal(store.get(msg.id).status, 'acked');
  assert.equal(JSON.parse(backend.rows.get(`a2a:message:${msg.id}`)).status, 'acked',
    'skoro odpowiedzielismy sukcesem, zapis musi istniec');
});

test('wolny zapis przy dopisywaniu tez nie daje odmowy z zapisanym rekordem', async () => {
  const backend = fakeBackend();
  const store = createStore({ backend, now: nowFactory(), lockTimeoutMs: 20 });
  const msg = await store.add({ from: 'SENDER', to: 'ADDRESSEE', type: 't', payload: {} });

  const czystySave = backend.save.bind(backend);
  backend.save = async (key, value) => {
    await new Promise(r => setTimeout(r, 80));
    return czystySave(key, value);
  };

  const wynik = await store.append(msg.id, { kind: 'message', messageId: 'm-2' }, { by: 'SENDER' });

  assert.equal(wynik.followups.length, 1);
  assert.equal(JSON.parse(backend.rows.get(`a2a:message:${msg.id}`)).followups.length, 1);
});

test('gdy zapis padnie, odmowa jest prawdziwa: w magazynie nie ma zmiany', async () => {
  const backend = fakeBackend();
  const store = createStore({ backend, now: nowFactory(), lockTimeoutMs: 20 });
  const msg = await store.add({ from: 'SENDER', to: 'ADDRESSEE', type: 't', payload: {} });

  backend.save = async () => { throw new Error('redis unreachable'); };

  await assert.rejects(() => store.transition(msg.id, 'acked', { by: 'ADDRESSEE' }),
    (err) => err instanceof StoreUnavailable);

  assert.equal(store.get(msg.id).status, 'pending');
  assert.equal(JSON.parse(backend.rows.get(`a2a:message:${msg.id}`)).status, 'pending');
});

// Zapis, ktory zglosil blad, nie znaczy, ze nic sie nie stalo. Rozstrzyga odczyt
// klucza: nowa wartosc to sukces, stara to 503, brak odczytu to 503 z unknown.

function backendZWeryfikacja({ zapisPada = false, zapisDociera = false, odczytPada = false } = {}) {
  const b = fakeBackend();
  const czysty = b.save.bind(b);
  b.save = async (key, value) => {
    if (!zapisPada) return czysty(key, value);
    if (zapisDociera) await czysty(key, value);     // zapis wszedl, ale klient zglosil blad
    throw new Error('connection lost');
  };
  b.read = async (key) => {
    if (odczytPada) throw new Error('connection lost');
    return b.rows.get(key) || null;
  };
  return b;
}

for (const [nazwa, wywolaj] of [
  ['add', async (store) => store.add({ from: 'SENDER', to: 'ADDRESSEE', type: 't', payload: {} })],
  ['transition', async (store, id) => store.transition(id, 'acked', { by: 'ADDRESSEE' })],
  ['append', async (store, id) => store.append(id, { kind: 'message', messageId: 'm-2' }, { by: 'SENDER' })],
]) {
  test(`${nazwa}: blad zapisu, ale wartosc doszla — to sukces, nie odmowa`, async () => {
    const backend = backendZWeryfikacja();
    const store = createStore({ backend, now: nowFactory() });
    const msg = await store.add({ from: 'SENDER', to: 'ADDRESSEE', type: 't', payload: {} });

    Object.assign(backend, backendZWeryfikacja({ zapisPada: true, zapisDociera: true }));
    backend.rows = backend.rows;

    const wynik = await wywolaj(store, msg.id);
    assert.ok(wynik, 'skoro zapis doszedl, odmowa bylaby nieprawda');
  });

  test(`${nazwa}: blad zapisu i stara wartosc w magazynie — odmowa, stan bez zmiany`, async () => {
    const backend = backendZWeryfikacja();
    const store = createStore({ backend, now: nowFactory() });
    const msg = await store.add({ from: 'SENDER', to: 'ADDRESSEE', type: 't', payload: {} });
    const przed = JSON.stringify(store.get(msg.id));

    backend.save = async () => { throw new Error('connection lost'); };

    await assert.rejects(() => wywolaj(store, msg.id), (err) => {
      assert.ok(err instanceof StoreUnavailable);
      assert.equal(err.outcome, 'not-written');
      return true;
    });
    if (nazwa !== 'add') assert.equal(JSON.stringify(store.get(msg.id)), przed);
  });

  test(`${nazwa}: blad zapisu i nieudany odczyt kontrolny — outcome unknown`, async () => {
    const backend = backendZWeryfikacja();
    const store = createStore({ backend, now: nowFactory() });
    const msg = await store.add({ from: 'SENDER', to: 'ADDRESSEE', type: 't', payload: {} });
    const przed = JSON.stringify(store.get(msg.id));

    backend.save = async () => { throw new Error('connection lost'); };
    backend.read = async () => { throw new Error('connection lost'); };

    await assert.rejects(() => wywolaj(store, msg.id), (err) => {
      assert.equal(err.outcome, 'unknown');
      return true;
    });
    if (nazwa !== 'add') assert.equal(JSON.stringify(store.get(msg.id)), przed);
  });
}

test('gdy magazyn odmowil przed wyslaniem, outcome mowi not-written, nie unknown', async () => {
  const backend = fakeBackend();
  backend.save = async () => { const e = new Error('redis is not connected'); e.attempted = false; throw e; };
  backend.read = async () => { throw new Error('tez nie dziala'); };
  const store = createStore({ backend, now: nowFactory() });

  await assert.rejects(() => store.add({ from: 'SENDER', to: 'ADDRESSEE', type: 't', payload: {} }),
    (err) => {
      assert.equal(err.outcome, 'not-written',
        'nieudany odczyt kontrolny nie moze zamienic pewnosci w niepewnosc');
      return true;
    });
});

// Odczyt kontrolny rozstrzyga trzy rzeczy: nowa wartosc to dowod zapisu, STARA dowod
// jego braku, a cokolwiek innego nie dowodzi niczego i jest niewiadoma.

test('trzecia wartosc pod kluczem nie dowodzi braku zapisu', async () => {
  const backend = fakeBackend();
  const store = createStore({ backend, now: nowFactory() });
  const msg = await store.add({ from: 'SENDER', to: 'ADDRESSEE', type: 't', payload: {} });

  backend.save = async () => { throw new Error('connection lost'); };
  backend.read = async () => JSON.stringify({ ...msg, status: 'delivered', from: 'KTOS_INNY' });

  await assert.rejects(() => store.transition(msg.id, 'acked', { by: 'ADDRESSEE' }), (err) => {
    assert.equal(err.outcome, 'unknown',
      'cudza wartosc pod kluczem nie jest dowodem, ze naszego zapisu nie ma');
    return true;
  });
});

test('stara wartosc pod kluczem dowodzi, ze zapisu nie ma', async () => {
  const backend = fakeBackend();
  const store = createStore({ backend, now: nowFactory() });
  const msg = await store.add({ from: 'SENDER', to: 'ADDRESSEE', type: 't', payload: {} });
  const stara = backend.rows.get(`a2a:message:${msg.id}`);

  backend.save = async () => { throw new Error('connection lost'); };
  backend.read = async () => stara;

  await assert.rejects(() => store.transition(msg.id, 'acked', { by: 'ADDRESSEE' }), (err) => {
    assert.equal(err.outcome, 'not-written');
    return true;
  });
  assert.equal(store.get(msg.id).status, 'pending');
});

test('rekord, ktorego nie da sie odczytac, konczy sie niewiadoma, nie wyjatkiem', async () => {
  const backend = fakeBackend();
  const store = createStore({ backend, now: nowFactory() });
  const msg = await store.add({ from: 'SENDER', to: 'ADDRESSEE', type: 't', payload: {} });

  backend.save = async () => { throw new Error('connection lost'); };
  backend.read = async () => '{ to nie jest json';

  await assert.rejects(() => store.transition(msg.id, 'acked', { by: 'ADDRESSEE' }), (err) => {
    assert.ok(err instanceof StoreUnavailable, 'ma byc odmowa magazynu, a nie surowy SyntaxError');
    assert.equal(err.outcome, 'unknown');
    return true;
  });
});

for (const [nazwa, wywolaj] of [
  ['add', async (store) => store.add({ from: 'SENDER', to: 'ADDRESSEE', type: 't', payload: {} })],
  ['transition', async (store, id) => store.transition(id, 'acked', { by: 'ADDRESSEE' })],
  ['append', async (store, id) => store.append(id, { kind: 'message', messageId: 'm-2' }, { by: 'SENDER' })],
]) {
  test(`${nazwa}: cudza wartosc pod kluczem daje unknown i pamiec z magazynu`, async () => {
    const backend = fakeBackend();
    const store = createStore({ backend, now: nowFactory() });
    const msg = await store.add({ from: 'SENDER', to: 'ADDRESSEE', type: 't', payload: {} });
    const cudzy = { ...msg, status: 'delivered', delivered_at: 'kiedys', from: 'KTOS_INNY' };

    backend.save = async () => { throw new Error('connection lost'); };
    backend.read = async () => JSON.stringify(cudzy);

    await assert.rejects(() => wywolaj(store, msg.id), (err) => {
      assert.equal(err.outcome, 'unknown');
      return true;
    });

    // Rekord ladzie w pamieci pod id z KLUCZA, wiec dla nowej wiadomosci pod jej
    // wlasnym, a nie pod id zaszytym w cudzej wartosci.
    assert.ok(store.all().some(m => m.from === 'KTOS_INNY'),
      'magazyn jest zrodlem prawdy, wiec to on rozstrzyga, co ten proces pamieta');
  });
}

// Brak klucza znaczy co innego zaleznie od stanu sprzed zapisu: dla nowej wiadomosci
// to dowod, ze nic nie wpadlo, dla istniejacego rekordu — trzecia wartosc.

test('add: brak klucza po nieudanym zapisie to stan sprzed, czyli not-written', async () => {
  const backend = fakeBackend();
  const store = createStore({ backend, now: nowFactory() });

  backend.save = async () => { throw new Error('connection lost'); };
  backend.read = async () => null;

  await assert.rejects(
    () => store.add({ from: 'SENDER', to: 'ADDRESSEE', type: 't', payload: {} }),
    (err) => { assert.equal(err.outcome, 'not-written'); return true; });
  assert.equal(store.all().length, 0);
});

for (const [nazwa, wywolaj] of [
  ['transition', async (store, id) => store.transition(id, 'acked', { by: 'ADDRESSEE' })],
  ['append', async (store, id) => store.append(id, { kind: 'message', messageId: 'm-2' }, { by: 'SENDER' })],
]) {
  test(`${nazwa}: brak klucza tam, gdzie byl rekord, to niewiadoma i pamiec za magazynem`, async () => {
    const backend = fakeBackend();
    const store = createStore({ backend, now: nowFactory() });
    const msg = await store.add({ from: 'SENDER', to: 'ADDRESSEE', type: 't', payload: {} });

    backend.save = async () => { throw new Error('connection lost'); };
    backend.read = async () => null;

    await assert.rejects(() => wywolaj(store, msg.id),
      (err) => { assert.equal(err.outcome, 'unknown'); return true; });
    assert.equal(store.get(msg.id), null,
      'skoro magazyn nie ma tego rekordu, pamiec nie moze go trzymac');
  });
}

test('rownosc wartosci nie zalezy od kolejnosci pol', async () => {
  const backend = fakeBackend();
  const store = createStore({ backend, now: nowFactory() });
  const msg = await store.add({ from: 'SENDER', to: 'ADDRESSEE', type: 't', payload: {} });

  // Zaplecze zapamietuje, co mialo zapisac, i oddaje DOKLADNIE to — tyle ze z polami
  // w odwrotnej kolejnosci. To ta sama wartosc, wiec zapis doszedl.
  let zamierzone;
  backend.save = async (_key, value) => { zamierzone = value; throw new Error('connection lost'); };
  backend.read = async () => {
    const odwrocony = {};
    for (const k of Object.keys(zamierzone).reverse()) odwrocony[k] = zamierzone[k];
    return JSON.stringify(odwrocony);
  };

  const wynik = await store.transition(msg.id, 'acked', { by: 'ADDRESSEE' });

  assert.equal(wynik.status, 'acked');
  assert.equal(store.get(msg.id).status, 'acked');
});

test('rekord z klucza laduje w pamieci pod id z KLUCZA, nie pod swoim wlasnym', async () => {
  const backend = fakeBackend();
  const store = createStore({ backend, now: nowFactory() });
  const msg = await store.add({ from: 'SENDER', to: 'ADDRESSEE', type: 't', payload: {} });

  backend.save = async () => { throw new Error('connection lost'); };
  backend.read = async () => JSON.stringify({ ...msg, id: 'zupelnie-inne-id', status: 'delivered' });

  await assert.rejects(() => store.transition(msg.id, 'acked', { by: 'ADDRESSEE' }));

  assert.equal(store.get('zupelnie-inne-id'), null, 'nie tworzymy rekordu pod cudzym id');
  assert.equal(store.get(msg.id).status, 'delivered', 'pod kluczem stoi to, co magazyn ma pod kluczem');
});

// Blokada ma waznosc, a praca bywa dluzsza, wiec zapis idzie warunkowo: wchodzi tylko
// gdy klucz blokady wciaz ma NASZ token, a odmowa jest pewna — to jedna operacja.

function backendZDzierzawa() {
  const b = fakeBackend();
  b.trzymane = new Map();
  b.acquire = async (key) => {
    const token = `token-${Math.random()}`;
    b.trzymane.set(key, token);
    return { key, token, release: async () => { if (b.trzymane.get(key) === token) b.trzymane.delete(key); } };
  };
  const czysty = b.save.bind(b);
  b.save = async (key, value, fencing) => {
    if (fencing && b.trzymane.get(fencing.key) !== fencing.token) {
      const err = new Error('lock lost');
      err.fenced = true;
      throw err;
    }
    return czysty(key, value);
  };
  return b;
}

test('zapis nie wchodzi, gdy blokada wygasla i ma ja juz kto inny', async () => {
  const backend = backendZDzierzawa();
  const store = createStore({ backend, now: nowFactory() });
  const msg = await store.add({ from: 'SENDER', to: 'ADDRESSEE', type: 't', payload: {} });
  const przed = JSON.stringify(store.get(msg.id));

  // W trakcie pracy blokada wygasa i przejmuje ja drugi wolajacy.
  const czystySave = backend.save.bind(backend);
  backend.save = async (key, value, fencing) => {
    backend.trzymane.set(fencing.key, 'token-drugiego-wolajacego');
    return czystySave(key, value, fencing);
  };

  await assert.rejects(() => store.transition(msg.id, 'acked', { by: 'ADDRESSEE' }), (err) => {
    assert.ok(err instanceof StoreUnavailable);
    assert.equal(err.outcome, 'not-written',
      'sprawdzenie i zapis sa atomowe, wiec odmowa jest pewna — bez odczytu kontrolnego');
    return true;
  });

  assert.equal(JSON.stringify(store.get(msg.id)), przed, 'rekord drugiego wolajacego nietkniety');
});

test('odmowa fencingu nie siega po odczyt kontrolny', async () => {
  const backend = backendZDzierzawa();
  const store = createStore({ backend, now: nowFactory() });
  const msg = await store.add({ from: 'SENDER', to: 'ADDRESSEE', type: 't', payload: {} });

  let odczytow = 0;
  backend.read = async () => { odczytow += 1; return null; };
  const czystySave = backend.save.bind(backend);
  backend.save = async (key, value, fencing) => {
    backend.trzymane.set(fencing.key, 'ktos-inny');
    return czystySave(key, value, fencing);
  };

  await assert.rejects(() => store.append(msg.id, { kind: 'message' }, { by: 'SENDER' }));
  assert.equal(odczytow, 0, 'nie ma czego sprawdzac, skoro zapis na pewno nie wszedl');
});

test('zapis wchodzi, gdy blokada przez caly czas byla nasza', async () => {
  const backend = backendZDzierzawa();
  const store = createStore({ backend, now: nowFactory() });
  const msg = await store.add({ from: 'SENDER', to: 'ADDRESSEE', type: 't', payload: {} });

  const wynik = await store.transition(msg.id, 'acked', { by: 'ADDRESSEE' });
  assert.equal(wynik.status, 'acked');
});

// Pelny przeplot: blokada wygasa, drugi wlasciciel ja bierze I ZAPISUJE SWOJ REKORD,
// a spozniony zapis pierwszego ma zostac odrzucony. Asercja idzie na zaplecze.

function backendZWygasaniem() {
  const rows = new Map();
  const blokady = new Map();
  let licznik = 0;

  return {
    rows,
    blokady,
    wygasnij: (key) => blokady.delete(key),
    async acquire(key) {
      if (blokady.has(key)) throw new Error(`a2a lock busy: ${key}`);
      const token = `token-${++licznik}`;
      blokady.set(key, token);
      return { key, token, release: async () => { if (blokady.get(key) === token) blokady.delete(key); } };
    },
    async save(key, value, fencing) {
      if (fencing && blokady.get(fencing.key) !== fencing.token) {
        const err = new Error('lock is no longer held');
        err.fenced = true;
        throw err;
      }
      rows.set(key, JSON.stringify(value));
    },
    async read(key) { return rows.get(key) || null; },
    async loadAll() { return [...rows.values()]; },
  };
}

test('blokada wygasa, drugi wlasciciel zapisuje, spozniony zapis pierwszego odrzucony', async () => {
  const backend = backendZWygasaniem();
  const store = createStore({ backend, now: nowFactory() });
  const msg = await store.add({ from: 'SENDER', to: 'ADDRESSEE', type: 't', payload: {} });

  const klucz = `a2a:message:${msg.id}`;
  const kluczBlokady = `a2a:lock:${msg.id}`;
  const czystySave = backend.save.bind(backend);
  let odczytow = 0;
  backend.read = async (key) => { odczytow += 1; return backend.rows.get(key) || null; };

  backend.save = async (key, value, fencing) => {
    backend.save = czystySave;                       // przeplot zachodzi raz

    backend.wygasnij(kluczBlokady);                  // waznosc blokady mija w trakcie pracy
    const drugi = await backend.acquire(kluczBlokady);
    await czystySave(key, { ...value, status: 'delivered', by: 'DRUGI_WOLAJACY' },
      { key: drugi.key, token: drugi.token });       // drugi robi SWOJ zapis

    return czystySave(key, value, fencing);          // dopiero teraz spozniony zapis pierwszego
  };

  await assert.rejects(() => store.transition(msg.id, 'acked', { by: 'ADDRESSEE' }), (err) => {
    assert.ok(err instanceof StoreUnavailable);
    assert.equal(err.outcome, 'not-written');
    return true;
  });

  const wZapleczu = JSON.parse(backend.rows.get(klucz));
  assert.equal(wZapleczu.by, 'DRUGI_WOLAJACY', 'rekord drugiego wlasciciela ma zostac nietkniety');
  assert.equal(wZapleczu.status, 'delivered');
  assert.equal(odczytow, 0, 'odmowa fencingu jest pewna, wiec odczyt kontrolny jest zbedny');
});
