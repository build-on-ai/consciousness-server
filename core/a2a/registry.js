'use strict';

// The role registry in the shape its consumers read: a list of names, and one file's
// text. Both are served from the parsed model.

function registryList(model) {
  const agents = Object.keys(model.cards);
  return { agents, total: agents.length };
}

function registryEntry(model, agent) {
  const entry = model.cards[String(agent).toUpperCase()];
  if (!entry) return null;
  return {
    agent: entry.id,
    claude_md: entry.raw,
    updated_at: new Date().toISOString(),
  };
}

// Only a file that is a card has a card; a role prompt has text and nothing more.
function cardFor(model, agent) {
  const entry = model.cards[String(agent).toUpperCase()];
  if (!entry || entry.kind !== 'a2a' || !entry.card) return null;
  return entry.card;
}

module.exports = { registryList, registryEntry, cardFor };
