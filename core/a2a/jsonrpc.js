'use strict';

// The JSON-RPC 2.0 envelope for the A2A routes. Error codes and their messages are read
// from the same schema that validates the cards.

const schemaDocument = require('./schema/a2a-0.2.6.json');

const JSONRPC_VERSION = '2.0';

function errorCatalogue(doc) {
  const catalogue = {};
  for (const [name, definition] of Object.entries(doc.definitions)) {
    const code = definition.properties
      && definition.properties.code
      && definition.properties.code.const;
    if (code === undefined) continue;
    const message = (definition.properties.message && definition.properties.message.default) || name;
    catalogue[name] = Object.freeze({ code, message });
  }
  return Object.freeze(catalogue);
}

const ERRORS = errorCatalogue(schemaDocument);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// A2A requires an id on every request, so a call without one is refused rather than
// accepted as a notification.
function parseRequest(body) {
  if (!isPlainObject(body)) return { id: null, error: ERRORS.InvalidRequestError };
  if (body.jsonrpc !== JSONRPC_VERSION) return { id: body.id ?? null, error: ERRORS.InvalidRequestError };
  if (typeof body.method !== 'string' || body.method.length === 0) {
    return { id: body.id ?? null, error: ERRORS.InvalidRequestError };
  }
  if (body.id === undefined || body.id === null) return { id: null, error: ERRORS.InvalidRequestError };
  if (typeof body.id !== 'string' && typeof body.id !== 'number') {
    return { id: null, error: ERRORS.InvalidRequestError };
  }

  return { id: body.id, method: body.method, params: body.params };
}

function success(id, result) {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

function failure(id, error, data) {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    error: data === undefined
      ? { code: error.code, message: error.message }
      : { code: error.code, message: error.message, data },
  };
}

module.exports = { JSONRPC_VERSION, ERRORS, parseRequest, success, failure };
