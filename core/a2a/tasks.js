'use strict';

// Builds the Task a caller gets back. The three mailbox states map onto protocol states;
// no state the store cannot reach is ever reported.

const crypto = require('crypto');
const Ajv = require('ajv');
const { ERRORS } = require('./jsonrpc');

const schemaDocument = require('./schema/a2a-0.2.6.json');

const ajv = new Ajv({ allErrors: true, strict: false });
ajv.addSchema(schemaDocument, 'a2a');

const PARAMS_BY_METHOD = Object.freeze({
  'message/send': ajv.compile({ $ref: 'a2a#/definitions/MessageSendParams' }),
  'tasks/get': ajv.compile({ $ref: 'a2a#/definitions/TaskQueryParams' }),
});

const STATE_BY_STATUS = Object.freeze({
  pending: 'submitted',
  delivered: 'working',
  acked: 'completed',
});

// The methods this core answers. A card's capabilities are checked against this list, so
// a card cannot claim a method that is not here.
const SUPPORTED_METHODS = Object.freeze(Object.keys(PARAMS_BY_METHOD));

// Every method the protocol defines, read from the request types in the schema. A name
// outside this set is not an unsupported operation — it is not a method at all.
const PROTOCOL_METHODS = Object.freeze(Object.values(schemaDocument.definitions)
  .map(def => def.properties && def.properties.method && def.properties.method.const)
  .filter(Boolean)
  .sort());

const PUSH_NOTIFICATION_PREFIX = 'tasks/pushNotificationConfig/';

// What this core answers to a method it does not implement, as the error itself —
// a method name arrives from the network and must never index anything.
function refusalFor(method) {
  if (SUPPORTED_METHODS.includes(method)) return null;
  if (!PROTOCOL_METHODS.includes(method)) return ERRORS.MethodNotFoundError;
  return String(method).startsWith(PUSH_NOTIFICATION_PREFIX)
    ? ERRORS.PushNotificationNotSupportedError
    : ERRORS.UnsupportedOperationError;
}

function validateParams(method, params) {
  const znane = Object.prototype.hasOwnProperty.call(PARAMS_BY_METHOD, method);
  if (!znane) throw new Error(`unknown method: ${method}`);
  const validate = PARAMS_BY_METHOD[method];
  if (validate(params)) return [];
  return validate.errors.map(err => `${err.instancePath || 'params'} ${err.message}`);
}

// Groups messages of one conversation. A supplied contextId is kept; otherwise it is
// derived from the task id, so the field is never absent and stable between reads.
function contextIdFor(message) {
  const supplied = message.payload && message.payload.message && message.payload.message.contextId;
  if (supplied) return supplied;
  return crypto.createHash('sha256').update(`context:${message.id}`).digest('hex').slice(0, 32);
}

function historyFor(message, contextId) {
  const sent = message.payload && message.payload.message;
  if (!sent) return [];
  const dalsze = message.followups || [];
  return [sent, ...dalsze].map(m => ({ ...m, taskId: message.id, contextId }));
}

function taskFromMessage(message, { historyLength } = {}) {
  const contextId = contextIdFor(message);
  const lastChange = message.history && message.history.length
    ? message.history[message.history.length - 1].at
    : message.created_at;

  const history = historyFor(message, contextId);

  return {
    kind: 'task',
    id: message.id,
    contextId,
    status: {
      state: STATE_BY_STATUS[message.status] || 'unknown',
      timestamp: lastChange,
    },
    history: historyLength === undefined ? history : history.slice(0, Math.max(0, historyLength)),
  };
}

module.exports = {
  STATE_BY_STATUS, SUPPORTED_METHODS, PROTOCOL_METHODS, PUSH_NOTIFICATION_PREFIX,
  taskFromMessage, validateParams, refusalFor,
};
