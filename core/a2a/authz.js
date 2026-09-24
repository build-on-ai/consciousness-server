'use strict';

// Identity comes from the signature, never from the request body. Each rule takes only
// the verified identity and the message, so no field a caller sends can widen it.

function same(a, b) {
  return String(a).toUpperCase() === String(b).toUpperCase();
}

// A sender named in the body may only agree with the signature. A mismatch is refused
// rather than corrected, so nothing is ever written under another agent's name.
function senderMismatch(verified, claimed) {
  if (!verified) {
    return {
      error: 'unsigned_request',
      reason: 'żądanie bez zweryfikowanej tożsamości nie może niczego wysłać',
    };
  }
  if (claimed === undefined || claimed === null || claimed === '') return null;
  if (same(verified, claimed)) return null;

  return {
    error: 'authorship_mismatch',
    reason: `podpisano jako ${verified}, a pole nadawcy mówi ${claimed}`,
    signed_as: verified,
    claimed_as: claimed,
  };
}

function mayRead(verified, message) {
  if (!verified || !message) return false;
  return same(verified, message.to) || same(verified, message.from);
}

// Acknowledging is the addressee confirming receipt, so the sender cannot do it.
function mayAck(verified, message) {
  if (!verified || !message) return false;
  return same(verified, message.to);
}

// Stricter than a task: a task is a conversation both parties may read, while a mailbox
// belongs to one agent, so the sender of a message may not look inside it.
function inboxDenial(verified, mailbox) {
  if (!verified) {
    return {
      status: 401,
      body: { error: 'unsigned_request', reason: 'skrzynka wymaga podpisanego żądania' },
    };
  }
  if (!same(verified, mailbox)) {
    return {
      status: 403,
      body: {
        error: 'not_the_addressee',
        reason: `podpisano jako ${verified}, a skrzynka należy do ${mailbox}`,
      },
    };
  }
  return null;
}

module.exports = { senderMismatch, mayRead, mayAck, inboxDenial };
