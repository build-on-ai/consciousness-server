'use strict';

// A role's signing identity is its name in upper case: agents/<name>.md holds the card
// <name> and signs as <NAME>. Every conversion between the two goes through here.

const AGENT_NAME = /^[A-Za-z0-9_-]+$/;

function agentIdFor(name) {
  if (typeof name !== 'string' || !AGENT_NAME.test(name)) {
    throw new Error(`not a usable agent name: ${JSON.stringify(name)}`);
  }
  return name.toUpperCase();
}

function publicKeyFileFor(name) {
  return `${agentIdFor(name)}.pub`;
}

// Names differing only in case are one identity here and two files on a case-sensitive
// filesystem, so they are refused as a collision.
function caseCollisions(names) {
  const byNormalised = new Map();
  for (const name of names) {
    const key = String(name).toUpperCase();
    if (!byNormalised.has(key)) byNormalised.set(key, []);
    byNormalised.get(key).push(name);
  }
  return [...byNormalised.values()].filter(group => group.length > 1);
}

module.exports = { agentIdFor, publicKeyFileFor, caseCollisions };
