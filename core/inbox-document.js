'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_MAX_ATTACHMENT_BYTES = 7 * 1024 * 1024;
const SOURCE_KINDS = new Set(['document', 'email']);

class InboxValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function deterministicUuid(value) {
  const hex = crypto.createHash('sha256').update(value).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprintEnvelope(envelope) {
  const selected = {
    source_kind: envelope.source_kind,
    original_name: envelope.original_name,
    mime_type: envelope.mime_type,
    sha256: envelope.sha256,
    title: envelope.title,
    content: envelope.content,
    metadata: envelope.metadata || {},
  };
  return crypto.createHash('sha256').update(stableJson(selected)).digest('hex');
}

function parseInboxEnvelope(data, maxBytes = DEFAULT_MAX_ATTACHMENT_BYTES) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new InboxValidationError('JSON object required');
  const required = ['idempotency_key', 'source_kind', 'original_name', 'mime_type', 'sha256', 'attachment_base64', 'title', 'content'];
  for (const field of required) {
    if (typeof data[field] !== 'string' || !data[field].trim()) throw new InboxValidationError(`${field} is required`);
  }
  if (data.idempotency_key.length > 200) throw new InboxValidationError('idempotency_key is too long');
  if (!SOURCE_KINDS.has(data.source_kind)) throw new InboxValidationError('source_kind must be document or email');
  if (!/^[a-f0-9]{64}$/i.test(data.sha256)) throw new InboxValidationError('sha256 must contain 64 hex characters');
  const attachment = Buffer.from(data.attachment_base64, 'base64');
  if (!attachment.length) throw new InboxValidationError('attachment is empty');
  if (attachment.length > maxBytes) throw new InboxValidationError(`attachment exceeds ${maxBytes} bytes`, 413);
  if (data.size !== undefined && Number(data.size) !== attachment.length) throw new InboxValidationError('declared size does not match attachment');
  const digest = crypto.createHash('sha256').update(attachment).digest('hex');
  if (digest !== data.sha256.toLowerCase()) throw new InboxValidationError('sha256 does not match attachment', 422);
  return { ...data, sha256: digest, attachment, size: attachment.length };
}

async function storeAttachment(attachmentDir, envelope) {
  if (!attachmentDir) throw new InboxValidationError('INBOX_ATTACHMENT_DIR is not configured', 503);
  await fs.promises.mkdir(attachmentDir, { recursive: true });
  const target = path.join(attachmentDir, envelope.sha256);
  try {
    const existing = await fs.promises.readFile(target);
    if (crypto.createHash('sha256').update(existing).digest('hex') !== envelope.sha256) {
      throw new Error('stored attachment hash mismatch');
    }
    return target;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.promises.open(temporary, 'wx', 0o600);
    await handle.writeFile(envelope.attachment);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(temporary, target);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.promises.unlink(temporary).catch(() => {});
  }
  return target;
}

function buildInboxNote(envelope, agent, timestamp) {
  const source = envelope.metadata && typeof envelope.metadata === 'object' && !Array.isArray(envelope.metadata)
    ? envelope.metadata
    : {};
  return {
    id: deterministicUuid(`inbox:${envelope.idempotency_key}`),
    agent,
    type: 'observation',
    title: envelope.title,
    content: envelope.content,
    tags: ['inbox', envelope.source_kind],
    visibility: 'user',
    metadata: {
      session_id: typeof source.session_id === 'string' ? source.session_id : '',
      project: typeof source.project === 'string' ? source.project : '',
      kind: 'knowledge',
      source_kind: envelope.source_kind,
      idempotency_key: envelope.idempotency_key,
      attachment_id: envelope.sha256,
      attachment_sha256: envelope.sha256,
      attachment_name: path.basename(envelope.original_name),
      attachment_mime: envelope.mime_type,
      attachment_size: envelope.size,
    },
    expires_at: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

module.exports = {
  DEFAULT_MAX_ATTACHMENT_BYTES,
  InboxValidationError,
  deterministicUuid,
  fingerprintEnvelope,
  parseInboxEnvelope,
  storeAttachment,
  buildInboxNote,
};
