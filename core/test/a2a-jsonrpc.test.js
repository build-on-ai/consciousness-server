'use strict';

// Koperta JSON-RPC jest tym, co odroznia A2A od wlasnego POST-a z JSON-em. Kody
// bledow pochodza z tego samego schematu, ktory waliduje karty — nie z pamieci.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { ERRORS, parseRequest, success, failure } = require('../a2a/jsonrpc');

test('katalog bledow pochodzi ze schematu, a nie z przepisanej listy', () => {
  assert.equal(ERRORS.MethodNotFoundError.code, -32601);
  assert.equal(ERRORS.TaskNotFoundError.code, -32001);
  assert.equal(ERRORS.UnsupportedOperationError.code, -32004);
  assert.equal(ERRORS.InvalidParamsError.code, -32602);
  assert.equal(ERRORS.TaskNotFoundError.message, 'Task not found');
});

test('poprawne zadanie jest rozlozone na id, metode i parametry', () => {
  const wynik = parseRequest({ jsonrpc: '2.0', id: 7, method: 'message/send', params: { message: {} } });

  assert.equal(wynik.error, undefined);
  assert.equal(wynik.id, 7);
  assert.equal(wynik.method, 'message/send');
  assert.deepEqual(wynik.params, { message: {} });
});

test('brak wersji 2.0 to nie jest JSON-RPC', () => {
  for (const cialo of [{ id: 1, method: 'm' }, { jsonrpc: '1.0', id: 1, method: 'm' }]) {
    const wynik = parseRequest(cialo);
    assert.equal(wynik.error.code, ERRORS.InvalidRequestError.code);
  }
});

test('brak metody jest bledem zadania, nie brakiem metody', () => {
  const wynik = parseRequest({ jsonrpc: '2.0', id: 1 });
  assert.equal(wynik.error.code, ERRORS.InvalidRequestError.code);
});

test('cialo, ktore nie jest obiektem, jest odrzucone', () => {
  for (const cialo of [null, 'napis', 42, []]) {
    assert.equal(parseRequest(cialo).error.code, ERRORS.InvalidRequestError.code);
  }
});

test('odpowiedz sukcesu ma koperte, id i wynik', () => {
  assert.deepEqual(success(7, { kind: 'task' }),
    { jsonrpc: '2.0', id: 7, result: { kind: 'task' } });
});

test('odpowiedz bledu ma koperte, id i kod', () => {
  assert.deepEqual(failure(7, ERRORS.TaskNotFoundError),
    { jsonrpc: '2.0', id: 7, error: { code: -32001, message: 'Task not found' } });
});

test('blad moze niesc dane, gdy jest co wyjasnic', () => {
  const odp = failure(1, ERRORS.InvalidParamsError, 'message.parts is required');
  assert.equal(odp.error.data, 'message.parts is required');
});

test('zadanie bez id nadal dostaje odpowiedz z id rownym null', () => {
  const wynik = parseRequest({ jsonrpc: '2.0', method: 'message/send', params: {} });
  assert.equal(wynik.error.code, ERRORS.InvalidRequestError.code);
  assert.equal(failure(wynik.id ?? null, wynik.error).id, null);
});
