#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Every local module server.js requires must reach the image. A missing one breaks
// neither the tests nor node --check — it breaks the container, which is too late.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..');

test('the Dockerfile copies every local module server.js requires', () => {
  const src = fs.readFileSync(path.join(DIR, 'server.js'), 'utf8');
  const dockerfile = fs.readFileSync(path.join(DIR, 'Dockerfile'), 'utf8');

  // A COPY line ends in its destination; everything before it is a source, and a
  // source is either a file or a whole directory.
  const copiedFiles = new Set();
  const copiedDirs = new Set();
  for (const line of dockerfile.split('\n')) {
    if (!line.startsWith('COPY ')) continue;
    const tokens = line.slice(5).split(/\s+/).filter(Boolean);
    for (const token of tokens.slice(0, -1)) {
      if (token.endsWith('.js')) copiedFiles.add(path.basename(token));
      else copiedDirs.add(path.basename(token.replace(/\/$/, '')));
    }
  }

  // Requires reach into subdirectories too — './a2a/cards' is as much a local module
  // as './retention', and a directory left out of the image fails the same way.
  const missing = [];
  for (const [, name] of src.matchAll(/require\('\.\/([a-z0-9-]+(?:\/[a-z0-9-]+)*)'\)/g)) {
    const file = `${name}.js`;
    if (!fs.existsSync(path.join(DIR, file))) continue;   // module from outside this directory
    const arrives = name.includes('/')
      ? copiedDirs.has(name.split('/')[0]) || copiedFiles.has(path.basename(file))
      : copiedFiles.has(file);
    if (!arrives) missing.push(file);
  }

  assert.deepEqual(missing, [],
    `server.js requires these files and the Dockerfile does not copy them: ${missing.join(', ')}`);
});
