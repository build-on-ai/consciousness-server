#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const PG_HOST = process.env.MEMORY_PG_HOST || process.env.PGHOST || '127.0.0.1';
const PG_PORT = parseInt(process.env.MEMORY_PG_PORT || process.env.PGPORT || '5432', 10);
const PG_DB   = process.env.MEMORY_PG_DB   || process.env.PGDATABASE || 'memory';
const PG_USER = process.env.MEMORY_PG_USER || process.env.PGUSER || 'memory';
const PG_PASS = process.env.MEMORY_PG_PASSWORD || process.env.PGPASSWORD || 'memory';

(async () => {
  const schemaSql = fs.readFileSync(
    path.join(__dirname, 'schema.sql'), 'utf8'
  );

  const client = new Client({
    host: PG_HOST, port: PG_PORT,
    database: PG_DB, user: PG_USER, password: PG_PASS,
  });

  try {
    await client.connect();
    console.log(`[migrate] connected to ${PG_USER}@${PG_HOST}:${PG_PORT}/${PG_DB}`);

    await client.query('BEGIN');
    await client.query(schemaSql);
    await client.query('COMMIT');

    const tables = await client.query(`
      SELECT tablename FROM pg_tables
       WHERE schemaname = 'public'
         AND tablename IN ('knowledge_sources','primary_indices',
                           'entity_mentions','ingest_audit')
       ORDER BY tablename
    `);
    console.log('[migrate] tables present:');
    for (const r of tables.rows) console.log(`  - ${r.tablename}`);

    const ext = await client.query(
      `SELECT extname FROM pg_extension WHERE extname IN ('vector','pgcrypto')`
    );
    console.log('[migrate] extensions:');
    for (const r of ext.rows) console.log(`  - ${r.extname}`);

    process.exit(0);
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { }
    console.error('[migrate] failed:', e.message);
    process.exit(1);
  } finally {
    try { await client.end(); } catch { }
  }
})();
