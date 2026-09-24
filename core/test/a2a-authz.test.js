'use strict';

// Kto jest nadawca, kto moze czytac i kto moze potwierdzic. Reguly biora tozsamosc
// wylacznie z podpisu, nigdy z tresci zadania.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { senderMismatch, mayRead, mayAck, inboxDenial } = require('../a2a/authz');

const WIADOMOSC = { id: 'm1', from: 'SENDER', to: 'ADDRESSEE' };

test('brak pola nadawcy w tresci nie jest bledem — autor jest z podpisu', () => {
  assert.equal(senderMismatch('SENDER', undefined), null);
  assert.equal(senderMismatch('SENDER', null), null);
  assert.equal(senderMismatch('SENDER', ''), null);
});

test('zgodne pole w tresci nie jest bledem', () => {
  assert.equal(senderMismatch('SENDER', 'SENDER'), null);
});

test('cudzy nadawca w tresci jest odmowa, nie korekta', () => {
  const blad = senderMismatch('SENDER', 'STRANGER');

  assert.ok(blad);
  assert.equal(blad.error, 'authorship_mismatch');
  assert.equal(blad.signed_as, 'SENDER');
  assert.equal(blad.claimed_as, 'STRANGER');
});

test('brak zweryfikowanej tozsamosci nie pozwala niczego wyslac', () => {
  const blad = senderMismatch(undefined, 'SENDER');
  assert.ok(blad);
  assert.equal(blad.error, 'unsigned_request');
});

test('roznica wielkosci liter nie tworzy dwoch tozsamosci', () => {
  assert.equal(senderMismatch('SENDER', 'sender'), null);
});

test('czytac moze adresat i nadawca, nikt inny', () => {
  assert.equal(mayRead('ADDRESSEE', WIADOMOSC), true);
  assert.equal(mayRead('SENDER', WIADOMOSC), true);
  assert.equal(mayRead('STRANGER', WIADOMOSC), false);
  assert.equal(mayRead(undefined, WIADOMOSC), false);
});

test('potwierdzic moze tylko adresat — ani nadawca, ani obcy', () => {
  assert.equal(mayAck('ADDRESSEE', WIADOMOSC), true);
  assert.equal(mayAck('SENDER', WIADOMOSC), false);
  assert.equal(mayAck('STRANGER', WIADOMOSC), false);
  assert.equal(mayAck(undefined, WIADOMOSC), false);
});

test('pole agent w tresci nie nadaje uprawnien', () => {
  // Dzis handler patrzy na req.body.agent; tu nie ma takiego wejscia w ogole.
  assert.equal(mayAck.length, 2, 'uprawnienie liczy sie z podpisu i wiadomosci, z niczego wiecej');
});

// Skrzynka nalezy do jednego agenta. Task jest rozmowa dwojga — i to jest jedyne
// miejsce, gdzie te dwie polityki sie roznia, wiec musi miec wlasny test.

test('skrzynke czyta tylko ten, do kogo nalezy', () => {
  assert.equal(inboxDenial('ADDRESSEE', 'ADDRESSEE'), null);
  assert.equal(inboxDenial('ADDRESSEE', 'addressee'), null);
});

test('nadawca nie zaglada do skrzynki, do ktorej wrzucil', () => {
  const odmowa = inboxDenial('SENDER', 'ADDRESSEE');

  assert.equal(odmowa.status, 403);
  assert.equal(odmowa.body.error, 'not_the_addressee');
  assert.match(odmowa.body.reason, /SENDER/);
  assert.match(odmowa.body.reason, /ADDRESSEE/);
});

test('bez podpisu skrzynka nie odpowiada wcale', () => {
  const odmowa = inboxDenial(undefined, 'ADDRESSEE');

  assert.equal(odmowa.status, 401);
  assert.equal(odmowa.body.error, 'unsigned_request');
});

test('polityka skrzynki jest surowsza niz polityka taska', () => {
  const wiadomosc = { id: 'm1', from: 'SENDER', to: 'ADDRESSEE' };

  assert.equal(mayRead('SENDER', wiadomosc), true, 'task: nadawca czyta');
  assert.ok(inboxDenial('SENDER', 'ADDRESSEE'), 'skrzynka: nadawca nie czyta');
});
