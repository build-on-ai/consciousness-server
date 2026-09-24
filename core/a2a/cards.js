'use strict';

// Classifies each role file as an A2A card, a plain prompt, or a named problem, and
// validates cards against the protocol schema.

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { caseCollisions } = require('./identity');
const Ajv = require('ajv');

// The exact protocol patch the cards are pinned to. The 0.2.x line changed both schema
// and methods, so the patch level is the contract, not `0.2`.
const A2A_PROTOCOL_VERSION = '0.2.6';

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

// The protocol schema, vendored from the A2A project (schema/SOURCE.md). The rules
// below add what it cannot express: the pin, placeholder expansion, a dialable address.
const schemaDocument = require('./schema/a2a-0.2.6.json');

const ajv = new Ajv({ allErrors: true, strict: false });
ajv.addSchema(schemaDocument, 'a2a');
const validateAgainstSchema = ajv.compile({ $ref: 'a2a#/definitions/AgentCard' });

// Problems that make a card unusable. An unimplemented protocol version is one of them:
// a route served from such a card would answer for a contract nothing checked.
const FATAL = new Set([
  'malformed-front-matter', 'missing-field', 'invalid-field',
  'unresolved-url', 'protocol-version', 'name-mismatch',
]);

// Fields that mark a file as a card, taken from AgentCard's own property list. Four
// names are held back below, because a plain prompt may carry them innocently.
const AMBIGUOUS_FIELDS = new Set(['name', 'description', 'version', 'capabilities']);

const CARD_MARKERS = Object.keys(schemaDocument.definitions.AgentCard.properties)
  .filter(field => !AMBIGUOUS_FIELDS.has(field));

function idFromFileName(fileName) {
  return path.basename(fileName, '.md').toUpperCase();
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function looksLikeCard(data) {
  if (!isPlainObject(data)) return false;
  // A capabilities object is the protocol's shape; a capabilities list is a prompt's.
  if (isPlainObject(data.capabilities)) return true;
  if (CARD_MARKERS.some(marker => marker in data)) return true;
  // The held-back names identify a card when all three arrive together, since a card
  // cannot omit any of them.
  return ['name', 'description', 'version'].every(field => field in data);
}

function isAbsoluteHttpUrl(value) {
  if (typeof value !== 'string') return false;
  let parsed;
  try {
    parsed = new URL(value);
  } catch (_err) {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

// The card owns the path and the deployment owns the address, so the one placeholder
// is expanded here.
function resolveUrl(url, baseUrl) {
  if (typeof url !== 'string' || !baseUrl) return url;
  return url.replace('${CORE_URL}', String(baseUrl).replace(/\/$/, ''));
}

function schemaProblems(data, fileName) {
  if (validateAgainstSchema(data)) return [];
  return (validateAgainstSchema.errors || []).map(err => ({
    kind: err.keyword === 'required' ? 'missing-field' : 'invalid-field',
    detail: `${fileName}: ${err.instancePath || 'card'} ${err.message}`,
  }));
}

function validate(data, fileName) {
  const problems = schemaProblems(data, fileName);
  const add = (kind, detail) => problems.push({ kind, detail });

  if (typeof data.url === 'string') {
    if (/\$\{[^}]*\}/.test(data.url)) {
      add('unresolved-url', `${fileName}: url still contains a placeholder: ${data.url}`);
    } else if (!isAbsoluteHttpUrl(data.url)) {
      add('invalid-field', `${fileName}: url must be an absolute http(s) address, not ${JSON.stringify(data.url)}`);
    }
  }

  if (typeof data.protocolVersion === 'string' && data.protocolVersion !== A2A_PROTOCOL_VERSION) {
    add('protocol-version', `${fileName}: declares protocolVersion ${JSON.stringify(data.protocolVersion)}, pinned is ${A2A_PROTOCOL_VERSION}`);
  }

  const expected = path.basename(fileName, '.md');
  if (typeof data.name === 'string' && data.name !== expected) {
    add('name-mismatch', `${fileName}: card name is ${data.name}`);
  }

  return problems;
}

// Returns a card (kind 'a2a', card filled), a prompt (kind 'legacy', card null), or a
// card-shaped file that cannot be used (kind 'a2a', card null, problems filled).
function parseCard(fileName, text, options = {}) {
  const id = idFromFileName(fileName);
  const base = { id, kind: 'legacy', name: null, card: null, raw: text, problems: [] };

  const match = FRONT_MATTER.exec(text);
  if (!match) {
    // An unclosed front matter block is a broken card, not a prompt: reading it as text
    // would hide the typo.
    if (/^---\r?\n/.test(text)) {
      return {
        ...base,
        kind: 'a2a',
        problems: [{ kind: 'malformed-front-matter', detail: `${fileName}: front matter is opened and never closed` }],
      };
    }
    return base;
  }

  let data;
  try {
    data = yaml.load(match[1]);
  } catch (err) {
    return {
      ...base,
      kind: 'a2a',
      problems: [{ kind: 'malformed-front-matter', detail: `${fileName}: ${err.message.split('\n')[0]}` }],
    };
  }

  if (!looksLikeCard(data)) return base;

  if (typeof data.url === 'string') {
    data.url = resolveUrl(data.url, options.baseUrl);
  }

  const problems = validate(data, fileName);
  const usable = !problems.some(p => FATAL.has(p.kind));

  return {
    id,
    kind: 'a2a',
    name: typeof data.name === 'string' ? data.name : null,
    card: usable ? data : null,
    raw: text,
    problems,
  };
}

// Reads a directory of role files. A missing directory throws, so it cannot be mistaken
// for a system with no roles.
function loadCards(dir, options = {}) {
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.md') && f.toUpperCase() !== 'README.MD')
    .sort();

  const cards = {};
  const problems = [];
  const counts = { a2a: 0, legacy: 0 };
  const seenNames = new Map();

  // Two names differing only in case are one role here and two files on disk; which
  // would win depends on read order, so neither does.
  const kolidujace = new Set();
  for (const grupa of caseCollisions(files.map(f => path.basename(f, '.md')))) {
    problems.push({
      kind: 'name-collision',
      detail: `role files differ only in case: ${grupa.map(n => `${n}.md`).join(', ')}`,
    });
    for (const nazwa of grupa) kolidujace.add(`${nazwa}.md`);
  }

  for (const file of files) {
    if (kolidujace.has(file)) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(dir, file), 'utf8');
    } catch (err) {
      // One unreadable file costs only that role, and is reported rather than skipped.
      problems.push({ kind: 'unreadable-file', detail: `${file}: ${err.message}` });
      continue;
    }
    if (text.trim().length === 0) continue;

    const entry = parseCard(file, text, options);
    cards[entry.id] = entry;
    counts[entry.kind] += 1;
    problems.push(...entry.problems);

    if (entry.name) {
      const seen = seenNames.get(entry.name) || [];
      seen.push(file);
      seenNames.set(entry.name, seen);
    }
  }

  for (const [name, files_] of seenNames) {
    if (files_.length > 1) {
      problems.push({ kind: 'duplicate-name', detail: `name ${name} is claimed by ${files_.join(', ')}` });
    }
  }

  return { cards, problems, counts };
}

// A directory that cannot be read is not a system with no roles, so the caller gets a
// refusal to serve rather than an empty set.
function registryUnavailable(model) {
  if (!model || !model.error) return null;
  return {
    status: 503,
    body: { error: 'agents_dir_unreadable', detail: model.error },
  };
}

module.exports = { A2A_PROTOCOL_VERSION, parseCard, loadCards, registryUnavailable };
