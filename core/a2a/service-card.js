'use strict';

// The card for this service, as opposed to the roles it hosts. Every field is taken from
// its owner — package.json, the deployment address, the pin, the method list.

const { A2A_PROTOCOL_VERSION } = require('./cards');
const { SUPPORTED_METHODS } = require('./tasks');
const pkg = require('../package.json');

// The path this service answers A2A on, alongside the roles and through the same
// dispatcher.
const SERVICE_ROLE = 'consciousness-server';

const MODES = Object.freeze(['text/plain', 'application/json']);

function serviceCard(baseUrl) {
  if (!baseUrl || typeof baseUrl !== 'string') {
    throw new Error('serviceCard needs the base address this core answers at');
  }
  const base = baseUrl.replace(/\/$/, '');

  return {
    name: pkg.name,
    description: pkg.description,
    version: pkg.version,
    protocolVersion: A2A_PROTOCOL_VERSION,
    url: `${base}/api/a2a/${SERVICE_ROLE}`,
    provider: {
      organization: 'BuildOnAI',
      url: 'https://github.com/build-on-ai',
    },
    capabilities: {
      streaming: SUPPORTED_METHODS.includes('message/stream'),
      pushNotifications: SUPPORTED_METHODS.some(m => m.startsWith('tasks/pushNotificationConfig/')),
      // The store keeps a transition log, but a Task in 0.2.6 has nowhere to put one:
      // its history is a list of messages, not of status changes.
      stateTransitionHistory: false,
    },
    securitySchemes: {
      'ed25519-signed-request': {
        type: 'apiKey',
        in: 'header',
        name: 'X-Signature',
        description: 'Ed25519 signature over the canonical request, sent together with '
          + 'X-Agent-Id, X-Timestamp and X-Nonce. See docs/SIGNING-PROTOCOL.md for the '
          + 'payload that is signed.',
      },
    },
    security: [{ 'ed25519-signed-request': [] }],
    defaultInputModes: [...MODES],
    defaultOutputModes: [...MODES],
    skills: [
      {
        id: 'mailbox',
        name: 'Accept a message and track it as a task',
        description: 'Takes a message/send, stores it durably against the signed sender, '
          + 'and reports its state through tasks/get until the addressee acknowledges it.',
        tags: ['messaging', 'tasks'],
        examples: ['Send a message to this core and poll the task it returns.'],
      },
    ],
  };
}

module.exports = { SERVICE_ROLE, serviceCard };
