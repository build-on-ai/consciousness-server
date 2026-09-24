'use strict';

// Blokada jest granica, za ktora dzieje sie mutacja. Jej limit czasu lezy PRZED
// wywolaniem callbacku: spozniona obietnica nie moze zrobic tego, czego odmowiono.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createRedisLock } = require('../a2a/redis-lock');

function klientUdajacy({ setOpoznienie = 0, setWisi = false, zajete = false } = {}) {
  const stan = { set: 0, get: 0, del: 0, trzyma: new Map() };
  return {
    stan,
    async set(key, value) {
      stan.set += 1;
      if (setWisi) return new Promise(() => {});
      if (setOpoznienie) await new Promise(r => setTimeout(r, setOpoznienie));
      if (zajete && stan.set === 1) return null;
      stan.trzyma.set(key, value);
      return 'OK';
    },
    async get(key) { stan.get += 1; return stan.trzyma.get(key) || null; },
    async del(key) { stan.del += 1; stan.trzyma.delete(key); return 1; },
    // Jedno wywolanie, bez okna miedzy sprawdzeniem a skasowaniem.
    // Warunkowe skasowanie: jedna operacja, bez okna miedzy sprawdzeniem a usunieciem.
    async eval(_skrypt, { keys, arguments: args }) {
      stan.eval = (stan.eval || 0) + 1;
      if (stan.trzyma.get(keys[0]) !== args[0]) return 0;
      stan.trzyma.delete(keys[0]);
      return 1;
    },
  };
}

test('blokada, ktorej nie da sie wziac, konczy sie bledem w zadanym czasie', async () => {
  const lock = createRedisLock({ client: klientUdajacy({ setWisi: true }), opTimeoutMs: 20, waitMs: 50 });

  const start = Date.now();
  await assert.rejects(() => lock.withLock('k', async () => 'nie tutaj'), /timed out|busy/);
  assert.ok(Date.now() - start < 1000);
});

test('gdy wziecie blokady sie spoznilo, callback NIE jest wolany', async () => {
  const klient = klientUdajacy({ setOpoznienie: 80 });
  const lock = createRedisLock({ client: klient, opTimeoutMs: 20, waitMs: 20 });
  let wolany = false;

  await assert.rejects(() => lock.withLock('k', async () => { wolany = true; }));

  await new Promise(r => setTimeout(r, 150));
  assert.equal(wolany, false, 'spozniona blokada nie moze uruchomic tego, co juz odmowiono');
});

// Zwalnianie tez ma limit, ale jego przekroczenie NIE psuje udanej pracy: klucz
// i tak wygasa sam. Wolajacy ma dostac swoj wynik, nie blad po cudzym sprzataniu.
test('wiszace zwalnianie nie trzyma wolajacego i nie psuje wyniku', async () => {
  const klient = klientUdajacy();
  klient.eval = () => new Promise(() => {});   // zwolnienie idzie przez eval, wiec to ono ma wisiec
  const lock = createRedisLock({ client: klient, opTimeoutMs: 20, waitMs: 200 });

  const start = Date.now();
  assert.equal(await lock.withLock('k', async () => 'praca'), 'praca');
  assert.ok(Date.now() - start < 1000, 'wiszace zwalnianie nie moze trzymac wolajacego');
});

test('zwyczajne wziecie i zwolnienie blokady dziala', async () => {
  const klient = klientUdajacy();
  const lock = createRedisLock({ client: klient, opTimeoutMs: 50, waitMs: 200 });

  assert.equal(await lock.withLock('k', async () => 'wynik'), 'wynik');
  assert.equal(klient.stan.eval, 1, 'zwolnienie idzie warunkowa operacja');
  assert.equal(klient.stan.trzyma.size, 0, 'blokada ma zostac zwolniona');
});

test('blokada zajeta przez kogos innego jest ponawiana, nie odrzucana od razu', async () => {
  const klient = klientUdajacy({ zajete: true });
  const lock = createRedisLock({ client: klient, opTimeoutMs: 50, waitMs: 500, stepMs: 5 });

  assert.equal(await lock.withLock('k', async () => 'po czekaniu'), 'po czekaniu');
  assert.ok(klient.stan.set >= 2, 'pierwsze podejscie odbilo sie, drugie weszlo');
});

// Zwolnienie musi byc jedna operacja warunkowa. Osobne GET i DEL zostawiaja okno,
// w ktorym cudza blokada zostaje skasowana przez poprzedniego wlasciciela.

// Wlasnosc, nie dyskryminator: o tym, ze nie ma juz okna miedzy sprawdzeniem a
// skasowaniem, mowi test ponizej. Ten pilnuje samego skutku.
test('zwolnienie nie kasuje blokady o cudzym tokenie', async () => {
  const klient = klientUdajacy();
  const lock = createRedisLock({ client: klient, opTimeoutMs: 50, waitMs: 200 });

  await lock.withLock('k', async () => {
    klient.stan.trzyma.set('k', 'token-kogos-innego');   // blokada wygasla i wzial ja ktos inny
  });

  assert.equal(klient.stan.trzyma.get('k'), 'token-kogos-innego');
});

test('zwolnienie idzie jedna operacja, nie para GET+DEL', async () => {
  const klient = klientUdajacy();
  const lock = createRedisLock({ client: klient, opTimeoutMs: 50, waitMs: 200 });

  await lock.withLock('k', async () => 'praca');

  assert.equal(klient.stan.eval, 1, 'zwolnienie ma byc warunkowe i atomowe');
  assert.equal(klient.stan.del, 0, 'goly DEL zostawia okno na skasowanie cudzej blokady');
});

test('spozniony SET, ktory jednak wszedl, zostaje posprzatany', async () => {
  const klient = klientUdajacy({ setOpoznienie: 80 });
  const lock = createRedisLock({ client: klient, opTimeoutMs: 20, waitMs: 500 });

  await assert.rejects(() => lock.withLock('k', async () => 'nie tutaj'), /timed out/);

  await new Promise(r => setTimeout(r, 200));
  assert.equal(klient.stan.trzyma.get('k'), undefined,
    'blokada, ktorej nikt nie uzywa, nie moze zostac zajeta do wygasniecia TTL');
});

test('blokada wzieta po czasie jest zwalniana, nie zostawiona do wygasniecia', async () => {
  const klient = klientUdajacy({ setOpoznienie: 60 });
  const lock = createRedisLock({ client: klient, opTimeoutMs: 200, waitMs: 20, stepMs: 5 });

  await assert.rejects(() => lock.acquire('k'), /timed out before it was held|busy/);

  await new Promise(r => setTimeout(r, 120));
  assert.equal(klient.stan.trzyma.get('k'), undefined,
    'blokada, ktorej nikt nie dostal, nie moze zostac zajeta');
});
