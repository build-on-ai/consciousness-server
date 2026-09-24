'use strict';

// Task to jest to, co klient A2A dostaje w odpowiedzi. Sprawdzamy go tym samym
// schematem co karty, zamiast pamiecia specyfikacji.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Ajv = require('ajv');

const { STATE_BY_STATUS, taskFromMessage, validateParams } = require('../a2a/tasks');
const schemaDocument = require('../a2a/schema/a2a-0.2.6.json');

const ajv = new Ajv({ allErrors: true, strict: false });
ajv.addSchema(schemaDocument, 'a2a');
const walidujTask = ajv.compile({ $ref: 'a2a#/definitions/Task' });

const WIADOMOSC_A2A = {
  kind: 'message',
  messageId: 'm-1',
  role: 'user',
  parts: [{ kind: 'text', text: 'zrob to' }],
};

function zapisana(status = 'pending') {
  return {
    id: 'task-1',
    from: 'SENDER',
    to: 'AUDITOR_EXAMPLE',
    type: 'message/send',
    payload: { message: WIADOMOSC_A2A },
    status,
    created_at: '2026-09-24T00:00:00.000Z',
    history: [{ from: null, to: 'pending', at: '2026-09-24T00:00:00.000Z', by: 'SENDER' }],
  };
}

test('stan zadania jest tlumaczony z tego, co magazyn naprawde wie', () => {
  assert.equal(STATE_BY_STATUS.pending, 'submitted');
  assert.equal(STATE_BY_STATUS.delivered, 'working');
  assert.equal(STATE_BY_STATUS.acked, 'completed');
});

test('task zbudowany z wiadomosci przechodzi oficjalny schemat', () => {
  const task = taskFromMessage(zapisana());

  assert.ok(walidujTask(task), JSON.stringify(walidujTask.errors));
  assert.equal(task.kind, 'task');
  assert.equal(task.id, 'task-1');
  assert.equal(task.status.state, 'submitted');
  assert.ok(task.contextId);
});

test('kazdy stan magazynu daje task zgodny ze schematem', () => {
  for (const status of ['pending', 'delivered', 'acked']) {
    const task = taskFromMessage(zapisana(status));
    assert.ok(walidujTask(task), `${status}: ${JSON.stringify(walidujTask.errors)}`);
  }
});

test('historia zadania niesie wyslana wiadomosc, nie tylko stan', () => {
  const task = taskFromMessage(zapisana('delivered'));

  assert.equal(task.history.length, 1);
  assert.equal(task.history[0].messageId, 'm-1');
  assert.equal(task.history[0].taskId, 'task-1');
});

test('historia da sie przyciac, bo klient o to prosi', () => {
  const task = taskFromMessage(zapisana(), { historyLength: 0 });
  assert.deepEqual(task.history, []);
});

test('parametry message/send sa sprawdzane schematem', () => {
  assert.deepEqual(validateParams('message/send', { message: WIADOMOSC_A2A }), []);

  const bezParts = validateParams('message/send', { message: { kind: 'message', messageId: 'm', role: 'user' } });
  assert.ok(bezParts.length > 0);
  assert.match(bezParts.join(' '), /parts/);

  assert.ok(validateParams('message/send', {}).length > 0, 'brak message musi byc bledem');
});

test('parametry tasks/get sa sprawdzane schematem', () => {
  assert.deepEqual(validateParams('tasks/get', { id: 'task-1' }), []);
  assert.ok(validateParams('tasks/get', {}).length > 0);
  assert.ok(validateParams('tasks/get', { id: 42 }).length > 0);
});

test('nieznana metoda nie ma parametrow do sprawdzenia', () => {
  assert.throws(() => validateParams('message/stream', {}), /unknown method/);
});

test('lista metod protokolu pochodzi ze schematu, nie z pamieci', () => {
  const { PROTOCOL_METHODS, SUPPORTED_METHODS } = require('../a2a/tasks');

  // Dziewiec typow zadan w 0.2.6 niesie staly method; to one sa metodami protokolu.
  assert.equal(PROTOCOL_METHODS.length, 9);
  assert.ok(PROTOCOL_METHODS.includes('message/stream'));
  assert.ok(PROTOCOL_METHODS.includes('tasks/cancel'));
  assert.ok(!PROTOCOL_METHODS.includes('foo/bar'));

  for (const metoda of SUPPORTED_METHODS) {
    assert.ok(PROTOCOL_METHODS.includes(metoda),
      `${metoda} jest obslugiwana, wiec musi byc metoda protokolu`);
  }
});

test('metoda, ktora rdzen obsluguje, nie jest niczym odmawiana', () => {
  const { SUPPORTED_METHODS, refusalFor } = require('../a2a/tasks');
  const { ERRORS } = require('../a2a/jsonrpc');

  for (const metoda of SUPPORTED_METHODS) {
    assert.equal(refusalFor(metoda), null, `${metoda} jest obslugiwana, wiec nie ma odmowy`);
  }
  assert.equal(refusalFor('message/stream'), ERRORS.UnsupportedOperationError);
});

test('odziedziczona nazwa nie jest metoda protokolu ani obslugiwana', () => {
  const { refusalFor, validateParams } = require('../a2a/tasks');
  const { ERRORS } = require('../a2a/jsonrpc');

  for (const nazwa of ['__proto__', 'constructor', 'toString', 'valueOf']) {
    assert.equal(refusalFor(nazwa), ERRORS.MethodNotFoundError, nazwa);
    assert.throws(() => validateParams(nazwa, {}), /unknown method/, nazwa);
  }
});
