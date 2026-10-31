#!/usr/bin/env node
import { createLedgerServer } from './app.mjs';

const apiKey = process.env.MOLA_LEDGER_API_KEY;
const host = process.env.MOLA_LEDGER_HOST || '127.0.0.1';
const port = Number(process.env.MOLA_LEDGER_PORT || '8787');
const dbPath = process.env.MOLA_LEDGER_DB_PATH || './data/effects.sqlite';
const inFlightTimeoutMs = Number(process.env.MOLA_LEDGER_IN_FLIGHT_TIMEOUT_MS || '60000');

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('MOLA_LEDGER_PORT must be 1–65535');
  process.exit(1);
}
try {
  const { server } = createLedgerServer({ apiKey, dbPath, inFlightTimeoutMs });
  server.listen(port, host, () => {
    console.log(`[mola-ledger] listening at http://${host}:${port}`);
    console.log(`[mola-ledger] SQLite: ${dbPath}`);
    console.log('[mola-ledger] Do not expose HTTP directly to the public Internet. Use TLS and protect your key.');
  });
} catch (error) {
  console.error('[mola-ledger] failed to start:', error.message);
  process.exit(1);
}
