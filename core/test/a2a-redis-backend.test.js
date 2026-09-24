'use strict';

// Zaplecze magazynu wobec Redisa: komendy MUTUJACEJ nie scigamy z zegarem, bo limit
// nie anuluje zapisu i odmowa mogłaby zostawic zmiane, ktorej wolajacemu odmowiono.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createRedisBackend } = require('../a2a/redis-backend');

test('wolny zapis jest czekany do konca, nie scigany z zegarem', async () => {
  const zapisane = [];
  const backend = createRedisBackend({
    isReady: () => true,
    persist: async (key, value) => {
      await new Promise(r => setTimeout(r, 60));
      zapisane.push([key, value]);
    },
  });

  const start = Date.now();
  await backend.save('a2a:message:1', { id: '1' });

  assert.ok(Date.now() - start >= 50, 'zapis ma zostac dokonczony, a nie porzucony');
  assert.equal(zapisane.length, 1, 'sukces wolno zglosic dopiero po zapisie');
});

test('zapis, ktory padl, jest bledem — bez cichego sukcesu', async () => {
  const backend = createRedisBackend({
    isReady: () => true,
    persist: async () => { throw new Error('redis unreachable'); },
  });

  await assert.rejects(() => backend.save('a2a:message:1', { id: '1' }), /unreachable/);
});

test('gdy Redis nie jest polaczony, zapis odmawia od razu i niczego nie prubuje', async () => {
  let prob = 0;
  const backend = createRedisBackend({
    isReady: () => false,
    persist: async () => { prob += 1; },
  });

  await assert.rejects(() => backend.save('a2a:message:1', { id: '1' }), /not connected/);
  assert.equal(prob, 0, 'skoro odmawiamy, nie mozemy w tle probowac zapisac');
});

test('odczyty maja limit czasu, bo nie zmieniaja niczego', async () => {
  const backend = createRedisBackend({
    isReady: () => true,
    persist: async () => {},
    client: { keys: () => new Promise(() => {}), get: async () => null },
    opTimeoutMs: 20,
  });

  await assert.rejects(() => backend.loadAll(), /timed out/);
});

test('hydratacja oddaje surowe wpisy i pomija klucze blokad', async () => {
  const backend = createRedisBackend({
    isReady: () => true,
    persist: async () => {},
    client: {
      keys: async () => ['a2a:message:1', 'a2a:message:1:lock'],
      get: async (key) => (key.endsWith(':lock') ? 'token' : '{"id":"1"}'),
    },
    opTimeoutMs: 100,
  });

  assert.deepEqual(await backend.loadAll(), ['{"id":"1"}']);
});

test('odmowa przed wyslaniem jest oznaczona jako taka', async () => {
  const backend = createRedisBackend({ isReady: () => false, persist: async () => {} });

  await assert.rejects(() => backend.save('k', {}), (err) => {
    assert.equal(err.attempted, false, 'skoro nic nie wyslalismy, nie ma o czym gdybac');
    return true;
  });
});

test('zapis pod blokada wchodzi jedna komenda, ktora sama sprawdza token', async () => {
  const wywolania = [];
  const backend = createRedisBackend({
    isReady: () => true,
    persist: async () => { throw new Error('zwykly zapis nie powinien tu wejsc'); },
    client: { eval: async (skrypt, opcje) => { wywolania.push([skrypt, opcje]); return 1; } },
  });

  await backend.save('a2a:message:1', { id: '1' }, { key: 'a2a:lock:1', token: 'moj' });

  assert.equal(wywolania.length, 1, 'sprawdzenie i zapis maja byc jedna operacja');
  assert.match(wywolania[0][0], /redis\.call\("get", KEYS\[2\]\)/);
  assert.deepEqual(wywolania[0][1].keys, ['a2a:message:1', 'a2a:lock:1']);
});

test('gdy blokada nalezy juz do kogos innego, zapis jest odrzucony jako fenced', async () => {
  const backend = createRedisBackend({
    isReady: () => true,
    persist: async () => {},
    client: { eval: async () => 0 },
  });

  await assert.rejects(
    () => backend.save('a2a:message:1', { id: '1' }, { key: 'a2a:lock:1', token: 'moj' }),
    (err) => { assert.equal(err.fenced, true); return true; });
});

test('bez dzierzawy zapis idzie zwykla sciezka', async () => {
  let zapisano = 0;
  const backend = createRedisBackend({ isReady: () => true, persist: async () => { zapisano += 1; } });

  await backend.save('a2a:message:1', { id: '1' });
  assert.equal(zapisano, 1);
});

// Zapis warunkowy omija persistWithRetention, wiec sam musi uszanowac polityke
// retencji. Zwykly SET kasuje istniejacy TTL — rekord terminowy stalby sie wieczny.

test('zapis pod blokada zdejmuje TTL, gdy polityka go nie ustala', async () => {
  let uzyte;
  const backend = createRedisBackend({
    isReady: () => true,
    persist: async () => {},
    ttlSeconds: () => null,
    client: { eval: async (skrypt, opcje) => { uzyte = { skrypt, opcje }; return 1; } },
  });

  await backend.save('a2a:message:1', { id: '1' }, { key: 'a2a:lock:1', token: 'moj' });

  assert.doesNotMatch(uzyte.skrypt, /KEEPTTL/,
    'przy polityce bez terminu zwykly zapis TEZ zdejmuje termin — obie sciezki maja byc zgodne');
  assert.equal(uzyte.opcje.arguments[2], '', 'brak polityki terminu przekazujemy jawnie');
});

test('zapis pod blokada ustawia TTL, gdy polityka go ma', async () => {
  let uzyte;
  const backend = createRedisBackend({
    isReady: () => true,
    persist: async () => {},
    ttlSeconds: () => 90,
    client: { eval: async (skrypt, opcje) => { uzyte = { skrypt, opcje }; return 1; } },
  });

  await backend.save('a2a:message:1', { id: '1' }, { key: 'a2a:lock:1', token: 'moj' });

  assert.equal(uzyte.opcje.arguments[2], '90000', 'polityka jest w sekundach, Redis chce milisekund');
  assert.match(uzyte.skrypt, /PX/);
});

// Fencing i zwykly zapis maja dawac ten sam termin waznosci dla tego samego klucza:
// polityka ma jedno zrodlo, wiec obie sciezki musza z niej czytac tak samo.

function redisZTerminem() {
  const wartosci = new Map();
  const terminy = new Map();
  return {
    wartosci,
    terminy,
    async set(key, value, opcje) {
      wartosci.set(key, value);
      if (opcje && opcje.PX) terminy.set(key, opcje.PX);
      else if (!opcje || !opcje.KEEPTTL) terminy.delete(key);
      return 'OK';
    },
    async setEx(key, sekundy, value) { wartosci.set(key, value); terminy.set(key, sekundy * 1000); return 'OK'; },
    async get(key) { return wartosci.get(key) || null; },
    async eval(skrypt, { keys, arguments: args }) {
      if (wartosci.get(keys[1]) !== args[1]) return 0;
      wartosci.set(keys[0], args[0]);
      // Jak prawdziwy Redis: zwykly SET zdejmuje termin, SET z PX go ustawia.
      if (args[2] === '') terminy.delete(keys[0]);
      else terminy.set(keys[0], Number(args[2]));
      return 1;
    },
  };
}

for (const polityka of [null, 90]) {
  test(`termin po zapisie warunkowym rowna sie terminowi po zwyklym (polityka: ${polityka})`, async () => {
    const klient = redisZTerminem();
    const persist = async (key, value) => (polityka === null
      ? klient.set(key, JSON.stringify(value))
      : klient.setEx(key, polityka, JSON.stringify(value)));

    const backend = createRedisBackend({
      client: klient, isReady: () => true, persist, ttlSeconds: () => polityka,
    });

    // Oba klucze startuja z TYM SAMYM terminem. Bez tego test nie widzi roznicy
    // miedzy zachowaniem terminu a jego skasowaniem — obie sciezki daja undefined.
    klient.wartosci.set('a2a:message:zwykly', 'stare');
    klient.terminy.set('a2a:message:zwykly', 120000);
    klient.wartosci.set('a2a:message:pod-blokada', 'stare');
    klient.terminy.set('a2a:message:pod-blokada', 120000);

    await backend.save('a2a:message:zwykly', { id: 'zwykly' });

    klient.wartosci.set('a2a:lock:pod-blokada', 'moj-token');
    await backend.save('a2a:message:pod-blokada', { id: 'pod-blokada' },
      { key: 'a2a:lock:pod-blokada', token: 'moj-token' });

    assert.equal(klient.terminy.get('a2a:message:pod-blokada'),
      klient.terminy.get('a2a:message:zwykly'),
      'obie sciezki maja zostawic ten sam termin, takze gdy polityka go nie ma');
  });
}
