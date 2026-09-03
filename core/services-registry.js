'use strict';

// Reads deploy/services.resolved.json, the artefact bin/sync-ports builds from
// services.json and ports.yaml. Ports are already resolved there, so nothing
// here parses YAML or restates a number that ports.yaml owns.

const fs = require('fs');
const path = require('path');

const ARTEFACT = 'services.resolved.json';

function _findArtefact() {
  if (process.env.SERVICES_RESOLVED) return process.env.SERVICES_RESOLVED;
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'deploy', ARTEFACT);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function parseServices(text) {
  const doc = JSON.parse(text);
  if (!doc || !Array.isArray(doc.services)) {
    throw new Error(`${ARTEFACT}: expected a "services" array`);
  }
  for (const svc of doc.services) {
    if (typeof svc.port !== 'number') {
      throw new Error(`${ARTEFACT}: service "${svc.name}" has no resolved port`);
    }
  }
  return doc.services;
}

// Throws rather than returning [] when the artefact is missing: an empty
// registry reads as "no services to check", which looks like a healthy stack
// with nothing in it.
function loadServices() {
  const file = _findArtefact();
  if (!file) {
    throw new Error(
      `${ARTEFACT} not found — run bin/sync-ports before starting the stack`);
  }
  return parseServices(fs.readFileSync(file, 'utf8'));
}

module.exports = { loadServices, parseServices, ARTEFACT };
