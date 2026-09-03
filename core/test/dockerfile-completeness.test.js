#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Every local module server.js requires must reach the image.
//
// Adding a file next to server.js and requiring it breaks neither the tests nor
// node --check. It breaks the container, which is the latest possible moment to
// find out.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..');

test('the Dockerfile copies every local module server.js requires', () => {
  const src = fs.readFileSync(path.join(DIR, 'server.js'), 'utf8');
  const dockerfile = fs.readFileSync(path.join(DIR, 'Dockerfile'), 'utf8');

  const copied = new Set();
  for (const line of dockerfile.split('\n')) {
    if (!line.startsWith('COPY ')) continue;
    for (const token of line.slice(5).split(/\s+/)) {
      if (token.endsWith('.js')) copied.add(path.basename(token));
    }
  }

  const missing = [];
  for (const [, name] of src.matchAll(/require\('\.\/([a-z0-9-]+)'\)/g)) {
    const file = `${name}.js`;
    if (!fs.existsSync(path.join(DIR, file))) continue;   // module from outside this directory
    if (!copied.has(file)) missing.push(file);
  }

  assert.deepEqual(missing, [],
    `server.js requires these files and the Dockerfile does not copy them: ${missing.join(', ')}`);
});
