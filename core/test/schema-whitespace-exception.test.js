'use strict';

// git diff --check keeps a diff publishable, and the vendored schema trips it on a
// blank line that is upstream's. The exception is narrow; this fails if it widens.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SCHEMA = 'core/a2a/schema/a2a-0.2.6.json';

function checkAttr(sciezka) {
  return execFileSync('git', ['check-attr', 'whitespace', '--', sciezka],
    { cwd: ROOT, encoding: 'utf8' }).trim();
}

test('schemat jest zwolniony z kontroli bialych znakow', () => {
  assert.match(checkAttr(SCHEMA), /whitespace: unset$/);
});

test('zwolnienie dotyczy tylko tego pliku', () => {
  for (const inny of ['core/server.js', 'core/a2a/cards.js', 'core/a2a/schema/SOURCE.md']) {
    assert.doesNotMatch(checkAttr(inny), /unset$/, `${inny} nie moze byc zwolniony`);
  }
});

test('powod zwolnienia jest zapisany tam, gdzie regula', () => {
  const tresc = fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8');
  assert.match(tresc, /byte-for-byte/);
  assert.match(tresc, /SOURCE\.md/);
});

test('git diff --check nie ma zastrzezen do drzewa roboczego', () => {
  const wynik = execFileSync('git', ['diff', '--check'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(wynik.trim(), '');
});
