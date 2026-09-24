'use strict';

// The A2A routes, as a router so the same handlers run in the core and under test.
// The store and the card lookup are passed in; this module owns the protocol.

const express = require('express');

const { ERRORS: A2A_ERRORS, parseRequest, success, failure } = require('./jsonrpc');
const { taskFromMessage, validateParams, SUPPORTED_METHODS, refusalFor } = require('./tasks');
const { senderMismatch, mayRead, mayAck, inboxDenial } = require('./authz');
const { StoreUnavailable, TransitionRefused, TaskClosed } = require('./store');

function a2aRoutes({ store: a2aStore, cardFor: a2aCardFor }) {
  const app = express.Router();

  // The wire shape of the four mailbox routes: the stored message without its history.
  function a2aWire(message) {
    return {
      id: message.id,
      from_agent: message.from,
      to_agent: message.to,
      message_type: message.type,
      payload: message.payload,
      priority: message.priority,
      requires_ack: message.requires_ack,
      status: message.status,
      created_at: message.created_at,
      ...(message.delivered_at ? { delivered_at: message.delivered_at } : {}),
      ...(message.acked_at ? { acked_at: message.acked_at } : {}),
    };
  }

  app.post("/api/a2a/send", async (req, res) => {
    const { from_agent, to_agent, message_type, payload, priority, requires_ack } = req.body;

    // A sender named in the body may agree with the signature and nothing else; the
    // message is filed under the signature either way.
    const mismatch = senderMismatch(req._verifiedAgent, from_agent);
    if (mismatch) return res.status(mismatch.error === "unsigned_request" ? 401 : 403).json(mismatch);

    if (!to_agent || !message_type) return res.status(400).json({ error: "Missing required fields" });

    try {
      const message = await a2aStore.add({
        from: req._verifiedAgent, to: to_agent, type: message_type, payload, priority, requires_ack,
      });
      res.json({ success: true, message_id: message.id, status: "queued" });
    } catch (err) {
      if (err instanceof StoreUnavailable) {
        // A message that was not written down must not be reported as queued.
        return res.status(503).json({ error: "a2a_store_unavailable", retryable: true, outcome: err.outcome, reason: err.message });
      }
      throw err;
    }
  });

  // Reading a mailbox changes nothing; accepting delivery is the POST below. Only the
  // addressee may do either.
  app.get("/api/a2a/inbox/:agent", (req, res) => {
    const denial = inboxDenial(req._verifiedAgent, req.params.agent);
    if (denial) return res.status(denial.status).json(denial.body);

    const waiting = a2aStore.forRecipient(req.params.agent, { status: "pending" });
    res.json({ agent: req.params.agent.toUpperCase(), messages: waiting.map(a2aWire), count: waiting.length });
  });

  app.post("/api/a2a/inbox/:agent", async (req, res) => {
    const denial = inboxDenial(req._verifiedAgent, req.params.agent);
    if (denial) return res.status(denial.status).json(denial.body);

    const waiting = a2aStore.forRecipient(req.params.agent, { status: "pending" });
    const taken = [];

    try {
      for (const message of waiting) {
        taken.push(await a2aStore.transition(message.id, "delivered", { by: req._verifiedAgent }));
      }
    } catch (err) {
      if (err instanceof StoreUnavailable) {
        return res.status(503).json({ error: "a2a_store_unavailable", retryable: true, outcome: err.outcome, reason: err.message });
      }
      throw err;
    }

    // Delivered mail comes back too, so a second call answers the same thing.
    const held = a2aStore.forRecipient(req.params.agent, { status: "delivered" });
    res.json({ agent: req.params.agent.toUpperCase(), messages: held.map(a2aWire), count: held.length, delivered_now: taken.length });
  });

  app.post("/api/a2a/ack/:message_id", async (req, res) => {
    const message = a2aStore.get(req.params.message_id);
    if (!message) return res.status(404).json({ error: "Message not found" });

    // Permission comes from the signature alone: a name a caller puts in the body proves
    // nothing.
    if (!mayAck(req._verifiedAgent, message)) {
      return res.status(req._verifiedAgent ? 403 : 401).json({
        error: req._verifiedAgent ? "not_the_addressee" : "unsigned_request",
        reason: `potwierdzić może tylko adresat (${message.to})`,
      });
    }

    try {
      const acked = await a2aStore.transition(message.id, "acked", { by: req._verifiedAgent });
      res.json({ success: true, message_id: acked.id, status: acked.status });
    } catch (err) {
      if (err instanceof TransitionRefused) {
        return res.status(409).json({ error: "transition_refused", from: err.from, to: err.to });
      }
      if (err instanceof StoreUnavailable) {
        return res.status(503).json({ error: "a2a_store_unavailable", retryable: true, outcome: err.outcome, reason: err.message });
      }
      throw err;
    }
  });

  app.get("/api/a2a/stats", (req, res) => {
    res.json({ total_messages: a2aStore.all().length, by_status: a2aStore.countsByStatus() });
  });

  // The address printed on every role card, registered after the four named routes so those
  // keep their paths. Unimplemented methods are refused with the protocol's code, not a 404.
  const A2A_METHODS = new Set(SUPPORTED_METHODS);

  // An unhandled rejection in an async handler takes the process down with it, and
  // this one answers the network. Whatever escapes becomes an internal error.
  const bezpiecznie = (handler) => (req, res) => handler(req, res).catch((err) => {
    console.error('[A2A] nieobsłużony błąd trasy:', err && err.stack ? err.stack : err);
    if (res.headersSent) return;
    res.status(500).json(failure(null, A2A_ERRORS.InternalError));
  });

  app.post("/api/a2a/:role", bezpiecznie(async (req, res) => {
    const entry = a2aCardFor(req.params.role);
    if (!entry) return res.status(404).json({ error: "agent_not_found", agent: req.params.role });

    // The gate parses the body first, so a broken one arrives empty with the failure
    // noted; reporting it as invalid would hide which half the caller got wrong.
    if (req._bodyParseError) return res.json(failure(null, A2A_ERRORS.JSONParseError, req._bodyParseError));

    const { id, method, params, error } = parseRequest(req.body);
    if (error) return res.json(failure(id, error));

    if (!A2A_METHODS.has(method)) {
      // One place settles what a method is refused with — a push call is
      // unavailable, not unknown.
      return res.json(failure(id, refusalFor(method)));
    }

    const problems = validateParams(method, params);
    if (problems.length) return res.json(failure(id, A2A_ERRORS.InvalidParamsError, problems.join('; ')));

    try {
      if (method === "message/send") {
        // A message naming a task continues it. An unknown task, or one this caller
        // is not party to, is not an invitation to start a new one.
        const continuing = params.message.taskId;
        if (continuing) {
          const task = a2aStore.get(continuing);
          const tutaj = task && String(task.to).toUpperCase() === String(entry.card.name).toUpperCase();
          if (!tutaj || !mayRead(req._verifiedAgent, task)) {
            return res.json(failure(id, A2A_ERRORS.TaskNotFoundError));
          }
          const dopisany = await a2aStore.append(continuing, params.message, { by: req._verifiedAgent });
          return res.json(success(id, taskFromMessage(dopisany)));
        }

        const stored = await a2aStore.add({
          from: req._verifiedAgent,
          to: entry.card.name,
          type: method,
          payload: params,
          requires_ack: true,
        });
        return res.json(success(id, taskFromMessage(stored)));
      }

      const stored = a2aStore.get(params.id);
      const belongsHere = stored && String(stored.to).toUpperCase() === String(entry.card.name).toUpperCase();
      // A task the caller is not party to is reported as absent: refusing would confirm
      // that it exists.
      if (!belongsHere || !mayRead(req._verifiedAgent, stored)) {
        return res.json(failure(id, A2A_ERRORS.TaskNotFoundError));
      }
      return res.json(success(id, taskFromMessage(stored, { historyLength: params.historyLength })));
    } catch (err) {
      if (err instanceof TaskClosed) {
        return res.json(failure(id, A2A_ERRORS.InvalidParamsError, err.message));
      }
      if (err instanceof StoreUnavailable) {
        return res.status(503).json(failure(id, A2A_ERRORS.InternalError, { outcome: err.outcome, reason: err.message }));
      }
      throw err;
    }
  }));



  return app;
}

module.exports = { a2aRoutes };
