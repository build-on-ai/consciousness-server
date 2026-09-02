
'use strict';

const fs = require('fs');
const path = require('path');

function _findServicesFile() {
  if (process.env.SERVICES_YAML) return process.env.SERVICES_YAML;
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'services.yaml');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function parseServices(text) {
  const out = [];
  let inServices = false;
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '');
    if (!line.trim()) continue;
    if (/^[A-Za-z][\w-]*\s*:\s*$/.test(line.trim()) && !/^\s/.test(line)) {
      if (current) { out.push(current); current = null; }
      inServices = line.trim().replace(/\s*:\s*$/, '') === 'services';
      continue;
    }
    if (!inServices) continue;
    const item = line.match(/^\s*-\s+([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (item) {
      if (current) out.push(current);
      current = {};
      current[item[1]] = _value(item[2]);
      continue;
    }
    const field = line.match(/^\s+([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (field && current) current[field[1]] = _value(field[2]);
  }
  if (current) out.push(current);
  return out;
}

function _value(raw) {
  const v = raw.trim().replace(/^["'](.*)["']$/, '$1');
  if (/^\d+$/.test(v)) return parseInt(v, 10);
  return v;
}

function loadServices() {
  const file = _findServicesFile();
  if (!file) return [];
  try {
    return parseServices(fs.readFileSync(file, 'utf8'));
  } catch (_e) {
    return [];
  }
}

module.exports = { loadServices, parseServices };
