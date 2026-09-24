'use strict';

// The address this core answers at appears in its cards and in discovery. Spelled in
// two places it ends up spelled two ways, so ports.yaml owns it and the core reads one name.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const COMPOSE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'deploy', 'docker-compose.yml'), 'utf8');

test('rdzen czyta jedna nazwe adresu, nie dwie', () => {
  assert.match(SERVER, /process\.env\.CORE_URL/);
  assert.doesNotMatch(SERVER, /PUBLIC_URL/,
    'PUBLIC_URL bylo drugim zrodlem tego samego adresu');
});

test('compose buduje adres z portu z ports.yaml, nie z wpisanej liczby', () => {
  const linia = COMPOSE.split('\n').find(l => l.trim().startsWith('CORE_URL:'));
  assert.ok(linia, 'compose nie przekazuje CORE_URL do rdzenia');
  assert.match(linia, /\$\{PORT_CONSCIOUSNESS_SERVER/,
    'port w adresie musi pochodzic z wygenerowanego .env, nie z liczby w pliku');
});

test('domyslny adres rdzenia nie zawiera wpisanego numeru portu', () => {
  const linia = SERVER.split('\n').find(l => l.includes('process.env.CORE_URL'));
  assert.doesNotMatch(linia, /:\d{4,5}`/,
    'domyslny port ma pochodzic z ports.yaml przez getPort, nie z liczby w kodzie');
  assert.match(linia, /getPort\('consciousness-server'/);
});
