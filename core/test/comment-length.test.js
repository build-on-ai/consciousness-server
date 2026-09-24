'use strict';

// Komentarz opisuje zachowanie kodu, nie prace nad nim, i ma najwyzej dwa wiersze.
// Dotyczy komentarzy liniowych i blokowych.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CORE = path.join(__dirname, '..');
const ROOT = path.join(CORE, '..');
const LIMIT = 2;

// Czego komentarz nie ma niesc: numeru wymagania, nazwy roli w zespole, ustalenia
// ani warunku odbioru. Slowo 'wrocilo' celowo pominiete — opisuje tez zachowanie.
const ZNACZNIKI = [
  /\bW\d+\b/,
  /\bCCO\b/,
  /\b(REVIEWER|AUDITOR|TESTER|BUILDER)\b/i,
  /decyzj/i,
  /\bdecision\b/i,
  /kryterium odbioru/i,
  /\breview(ed|er|s)?\s+(finding|comment|round)\b/i,
  /\b(earlier|previously|used to|no longer)\b/i,
];

// SPDX to metadana licencji, nie proza — nie liczy sie do dlugosci bloku.
const METADANA = /^\/\/\s*SPDX-/;

// Komentarze dokumentacyjne Go opisuja eksportowane nazwy i rzadza sie wlasna
// konwencja, wiec pliki .go objete sa wylacznie regula znacznikow.
function pliki({ takze_go = false } = {}) {
  const zbior = [];
  const dodaj = (katalog, rozszerzenia) => {
    let wpisy;
    try {
      wpisy = fs.readdirSync(katalog, { withFileTypes: true });
    } catch (_err) {
      return;
    }
    for (const wpis of wpisy) {
      const pelna = path.join(katalog, wpis.name);
      if (wpis.isDirectory()) dodaj(pelna, rozszerzenia);
      else if (rozszerzenia.some(r => wpis.name.endsWith(r))) zbior.push(pelna);
    }
  };

  dodaj(path.join(CORE, 'a2a'), ['.js']);
  dodaj(path.join(CORE, 'test'), ['.js']);
  dodaj(path.join(ROOT, 'lib'), ['.js']);
  dodaj(path.join(ROOT, 'deploy', 'tests'), ['.js']);
  if (takze_go) dodaj(path.join(ROOT, 'tui'), ['.go']);
  zbior.push(path.join(CORE, 'route-index.js'));

  return zbior.filter(p => !p.includes(`a2a${path.sep}schema`) && !p.includes('node_modules'));
}

// Komentarz to takze blok /* ... */: znacznik procesu ukryty w nim jest tak samo
// widoczny dla czytelnika repozytorium.
function wiersze(plik) {
  const out = [];
  let wBloku = false;

  for (const [i, surowa] of fs.readFileSync(plik, 'utf8').split('\n').entries()) {
    const linia = surowa.trim();

    if (wBloku) {
      out.push({ nr: i + 1, tresc: linia, komentarz: true });
      if (linia.includes('*/')) wBloku = false;
      continue;
    }
    if (linia.startsWith('/*')) {
      out.push({ nr: i + 1, tresc: linia, komentarz: true });
      if (!linia.includes('*/')) wBloku = true;
      continue;
    }
    out.push({ nr: i + 1, tresc: linia, komentarz: linia.startsWith('//') });
  }
  return out;
}

function wykroczenia(plik) {
  const gdzie = path.relative(ROOT, plik);
  const znalezione = [];
  let dlugosc = 0;
  let poczatek = 0;

  for (const { nr, tresc, komentarz } of wiersze(plik)) {
    if (komentarz) {
      for (const znacznik of ZNACZNIKI) {
        if (znacznik.test(tresc)) znalezione.push(`${gdzie}:${nr} slad procesu: ${tresc.slice(0, 60)}`);
      }
      if (METADANA.test(tresc)) continue;
      if (dlugosc === 0) poczatek = nr;
      dlugosc += 1;
      continue;
    }

    if (dlugosc > LIMIT) znalezione.push(`${gdzie}:${poczatek} blok ${dlugosc} wierszy`);
    dlugosc = 0;
  }
  if (dlugosc > LIMIT) znalezione.push(`${gdzie}:${poczatek} blok ${dlugosc} wierszy`);

  return znalezione;
}

test('jest co sprawdzac', () => {
  const zbior = pliki({ takze_go: true });
  assert.ok(zbior.length >= 30, `spodziewam sie wiekszego zestawu, mam ${zbior.length}`);
  assert.ok(zbior.some(p => p.includes(`deploy${path.sep}tests`)));
  assert.ok(zbior.some(p => p.endsWith('.go')));
});

test('zaden komentarz nie jest dluzszy niz dwa wiersze', () => {
  const zbyt = pliki().flatMap(wykroczenia).filter(w => w.includes('blok'));
  assert.deepEqual(zbyt, [], 'dluzszy komentarz opisuje zwykle historie, nie zachowanie');
});

test('zaden komentarz nie niesie sladu procesu zamiast opisu produktu', () => {
  const slady = pliki({ takze_go: true }).flatMap(wykroczenia).filter(w => w.includes('slad procesu'));
  assert.deepEqual(slady, [], 'numer wymagania, rola w zespole czy decyzja nie opisuja kodu');
});
