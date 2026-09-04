'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadServices, parseServices, ARTEFACT } = require('../services-registry');

const PRZYKLAD = JSON.stringify({
  services: [
    { name: 'consciousness-server', target: 'host_gateway', port: 13032,
      port_key: 'consciousness-server', path: '/health', status: 'active' },
    { name: 'redis', target: 'host_gateway', port: 16380,
      port_key: 'redis', path: null, status: 'external' },
  ],
});

test('czyta kazda usluge z rejestru', () => {
  const uslugi = parseServices(PRZYKLAD);
  assert.equal(uslugi.length, 2);
  assert.deepEqual(uslugi.map(u => u.name), ['consciousness-server', 'redis']);
});

test('port jest liczba, nie napisem', () => {
  const [pierwsza] = parseServices(PRZYKLAD);
  assert.equal(typeof pierwsza.port, 'number');
  assert.equal(pierwsza.port, 13032);
});

test('status rozroznia active od external', () => {
  const uslugi = parseServices(PRZYKLAD);
  assert.equal(uslugi.find(u => u.name === 'consciousness-server').status, 'active');
  assert.equal(uslugi.find(u => u.name === 'redis').status, 'external');
});

test('brak rozwiazanego portu jest bledem, nie cicha luka', () => {
  const bezPortu = JSON.stringify({ services: [{ name: 'x', port_key: 'x' }] });
  assert.throws(() => parseServices(bezPortu), /has no resolved port/);
});

test('brak tablicy services jest bledem', () => {
  assert.throws(() => parseServices('{}'), /expected a "services" array/);
});

// Pusta lista czytalaby sie jak "nie ma czego sprawdzac", czyli jak zdrowy
// stos bez uslug. Brak artefaktu ma zatrzymac start, nie udawac porzadku.
test('brak artefaktu zatrzymuje start zamiast dawac pusta liste', () => {
  const pusty = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-'));
  const bylo = process.env.SERVICES_RESOLVED;
  process.env.SERVICES_RESOLVED = path.join(pusty, 'nie-ma.json');
  try {
    assert.throws(() => loadServices(), /ENOENT|not found/);
  } finally {
    if (bylo === undefined) delete process.env.SERVICES_RESOLVED;
    else process.env.SERVICES_RESOLVED = bylo;
    fs.rmSync(pusty, { recursive: true, force: true });
  }
});

test('rejestr z repozytorium wczytuje sie i ma consciousness-server', () => {
  const uslugi = loadServices();
  assert.ok(uslugi.length > 0, `${ARTEFACT} nie zawiera zadnej uslugi`);
  const core = uslugi.find(u => u.name === 'consciousness-server');
  assert.ok(core, 'brak wpisu consciousness-server');
  assert.equal(typeof core.port, 'number');
});

// Numer portu ma jedno zrodlo: ports.yaml. Artefakt tylko go przepisuje,
// wiec kazda wartosc w nim musi sie tam znalezc.
test('kazdy port w artefakcie pochodzi z ports.yaml', () => {
  const portsYaml = fs.readFileSync(path.join(__dirname, '..', '..', 'ports.yaml'), 'utf8');
  const zYaml = {};
  for (const [, nazwa, port] of portsYaml.matchAll(/^\s+([a-z][a-z0-9-]*):\s+(\d+)/gm)) {
    zYaml[nazwa] = Number(port);
  }
  for (const usluga of loadServices()) {
    assert.equal(usluga.port, zYaml[usluga.port_key],
      `${usluga.name}: port ${usluga.port} nie zgadza sie z ports.yaml (${zYaml[usluga.port_key]})`);
  }
});
