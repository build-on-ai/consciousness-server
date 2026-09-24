'use strict';

// The registry of role files: the list, one file's text, one role's card. Each reads
// the directory first, so an edit shows up on the next request.

const express = require('express');

const { registryList, registryEntry, cardFor } = require('./registry');
const { registryUnavailable } = require('./cards');

function identityRoutes({ reload }) {
  const app = express.Router();

  // Refusing to answer is not the same as answering that there are no roles.
  function model(res) {
    let current;
    try {
      current = reload();
    } catch (err) {
      current = { cards: {}, problems: [], counts: { a2a: 0, legacy: 0 }, error: err.message };
    }
    const unavailable = registryUnavailable(current);
    if (unavailable) {
      res.status(unavailable.status).json(unavailable.body);
      return null;
    }
    return current;
  }

  app.get("/api/identity/claude-md", (req, res) => {
    const current = model(res);
    if (current) res.json(registryList(current));
  });

  app.get("/api/identity/claude-md/:agent", (req, res) => {
    const current = model(res);
    if (!current) return;

    const entry = registryEntry(current, req.params.agent);
    if (!entry) {
      return res.status(404).json({ error: "Agent not found", available: Object.keys(current.cards) });
    }
    res.json(entry);
  });

  app.get("/api/identity/card/:agent", (req, res) => {
    const current = model(res);
    if (!current) return;

    const card = cardFor(current, req.params.agent);
    if (!card) {
      return res.status(404).json({
        error: "no_agent_card",
        agent: req.params.agent,
        reason: "ta rola nie ma karty A2A; treść roli jest pod /api/identity/claude-md/:agent",
      });
    }
    res.json(card);
  });

  return app;
}

module.exports = { identityRoutes };
