'use strict';

// Bramka parsuje cialo sama, zanim zobaczy je handler. Cicha zamiana zepsutego JSON-a
// na pusty obiekt sprawia, ze trasa myli sie co do tego, co poszlo nie tak.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('stream');

const { reinjectBody } = require('../middleware/verify-signed');

function fakeReq(contentType) {
  const req = Readable.from([]);
  req.headers = { 'content-type': contentType };
  return req;
}

test('poprawne cialo jest sparsowane i nie zglasza bledu', () => {
  const req = fakeReq('application/json');
  reinjectBody(req, Buffer.from('{"a":1}'));

  assert.deepEqual(req.body, { a: 1 });
  assert.equal(req._bodyParseError, undefined);
});

test('zepsute cialo jest zapamietane jako blad, nie jako puste zadanie', () => {
  const req = fakeReq('application/json');
  reinjectBody(req, Buffer.from('{"a":'));

  assert.deepEqual(req.body, {});
  assert.match(req._bodyParseError, /JSON/i);
});

test('puste cialo to nie jest blad parsowania', () => {
  const req = fakeReq('application/json');
  reinjectBody(req, Buffer.alloc(0));

  assert.deepEqual(req.body, {});
  assert.equal(req._bodyParseError, undefined);
});
