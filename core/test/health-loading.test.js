#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

const checks = [
  [/let dataLoading = true;/,               'flaga startuje jako "trwa wczytywanie"'],
  [/dataLoading = false;/,                  'flaga jest zdejmowana po zaladowaniu'],
  [/counts_complete:\s*countsComplete/,     '/health zwraca counts_complete'],
  [/const status = dataLoading\s*\n\s*\?\s*'loading'/, 'status ma pierwszenstwo "loading"'],
];

let failed = 0;
for (const [re, why] of checks) {
  if (!re.test(src)) { failed++; console.error(`FAIL: ${why}`); }
}

const iLast = src.indexOf('await loadSummariesFromRedis();');
const iOff  = src.indexOf('dataLoading = false;');
if (iLast === -1 || iOff === -1 || iOff < iLast) {
  failed++;
  console.error('FAIL: dataLoading zdejmowane przed koncem wczytywania');
}

if (failed) { console.error(`\n${failed} sprawdzen zawodzi`); process.exit(1); }
console.log('ok - /health odroznia stan wczytywania od kompletnego');
