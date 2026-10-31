import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLedgerServer } from '../server/app.mjs';
import {
  EffectInProgressError,
  EffectLedger,
  EffectUncertainError,
  EffectUnknownError,
  effectIdempotencyKey,
} from '../src/index.mjs';

const API_KEY = 'failure-demo-local-key';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function startProvider() {
  const records = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/actions') {
      const body = await readJson(req);
      const record = {
        id: `provider-${records.length + 1}`,
        businessKey: body.businessKey,
        kind: body.kind,
      };
      records.push(record);
      if (body.delayMs) await sleep(body.delayMs);
      res.writeHead(201, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(record));
    }
    if (req.method === 'GET' && url.pathname === '/actions') {
      const matches = records.filter(record => record.businessKey === url.searchParams.get('businessKey'));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(matches));
    }
    res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    records,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

async function providerCreate(providerUrl, body) {
  const response = await fetch(`${providerUrl}/actions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return response.json();
}

async function providerLookup(providerUrl, businessKey) {
  const response = await fetch(`${providerUrl}/actions?businessKey=${encodeURIComponent(businessKey)}`);
  return response.json();
}

const count = (records, businessKey) => records.filter(record => record.businessKey === businessKey).length;

async function waitFor(check, timeoutMs = 1000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for demo state');
    await sleep(5);
  }
}

async function runWorker(mode, { providerUrl, ledgerUrl }) {
  const workerPath = fileURLToPath(new URL('./crash-worker.mjs', import.meta.url));
  const child = spawn(process.execPath, [workerPath], {
    env: {
      PATH: process.env.PATH,
      MOLA_LEDGER_CRASH_MODE: mode,
      MOLA_LEDGER_PROVIDER_URL: providerUrl,
      MOLA_LEDGER_URL: ledgerUrl || '',
      MOLA_LEDGER_API_KEY: API_KEY,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  if (code !== 86) throw new Error(`Crash worker exited ${code}: ${stderr}`);
}

async function concurrencyDemo({ ledger, provider }) {
  console.log('\n1) CONCURRENT DUPLICATE EXECUTION');
  await Promise.all([
    providerCreate(provider.url, { businessKey: 'concurrency-unprotected', kind: 'issue' }),
    providerCreate(provider.url, { businessKey: 'concurrency-unprotected', kind: 'issue' }),
  ]);
  assert.equal(count(provider.records, 'concurrency-unprotected'), 2);
  console.log('   Without ledger: 2 concurrent requests created 2 provider records.');

  const operation = {
    namespace: 'failure-demo', operationId: 'concurrency-protected',
    action: 'issue.create', input: { scenario: 'concurrency' },
  };
  const key = effectIdempotencyKey(operation.namespace, operation.operationId);
  const first = ledger.execute({
    ...operation,
    perform: ({ idempotencyKey }) => providerCreate(provider.url, {
      businessKey: idempotencyKey, kind: 'issue', delayMs: 100,
    }),
  });
  await waitFor(() => count(provider.records, key) === 1);
  const second = ledger.execute({
    ...operation,
    perform: ({ idempotencyKey }) => providerCreate(provider.url, { businessKey: idempotencyKey, kind: 'issue' }),
  });
  const outcomes = await Promise.allSettled([first, second]);
  assert.equal(count(provider.records, key), 1);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert(outcomes.some(result => result.status === 'rejected' && result.reason instanceof EffectInProgressError));
  console.log('   With ledger: 1 provider record; the overlapping request received IN_PROGRESS.');
}

async function lostResponseDemo({ ledger, provider }) {
  console.log('\n2) LOST RESPONSE AFTER PROVIDER SUCCESS');
  try {
    await providerCreate(provider.url, { businessKey: 'lost-unprotected', kind: 'issue' });
    throw new Error('simulated response loss');
  } catch {
    await providerCreate(provider.url, { businessKey: 'lost-unprotected', kind: 'issue' });
  }
  assert.equal(count(provider.records, 'lost-unprotected'), 2);
  console.log('   Without ledger: retry after a lost response created a duplicate (2 records).');

  const operation = {
    namespace: 'failure-demo', operationId: 'lost-protected',
    action: 'issue.create', input: { scenario: 'lost-response' },
  };
  const key = effectIdempotencyKey(operation.namespace, operation.operationId);
  await assert.rejects(ledger.execute({
    ...operation,
    perform: async ({ idempotencyKey }) => {
      await providerCreate(provider.url, { businessKey: idempotencyKey, kind: 'issue' });
      throw new Error('simulated network failure after provider success');
    },
  }), EffectUncertainError);
  await assert.rejects(ledger.execute({
    ...operation,
    perform: ({ idempotencyKey }) => providerCreate(provider.url, { businessKey: idempotencyKey, kind: 'issue' }),
  }), EffectUnknownError);
  assert.equal(count(provider.records, key), 1);
  const reconciled = await ledger.reconcile({
    namespace: operation.namespace,
    operationId: operation.operationId,
    verify: async () => {
      const matches = await providerLookup(provider.url, key);
      return matches.length
        ? { status: 'succeeded', result: matches[0], evidence: `Demo provider confirmed ${matches[0].id}` }
        : { status: 'unknown' };
    },
  });
  assert.equal(reconciled.status, 'SUCCEEDED');
  console.log('   With ledger: retry blocked at UNKNOWN; positive provider lookup reconciled SUCCEEDED.');
}

async function crashDemo({ ledger, ledgerUrl, provider }) {
  console.log('\n3) APPLICATION PROCESS CRASH AND RESTART');
  await runWorker('plain', { providerUrl: provider.url });
  await providerCreate(provider.url, { businessKey: 'crash-unprotected', kind: 'ticket' });
  assert.equal(count(provider.records, 'crash-unprotected'), 2);
  console.log('   Without ledger: restarted application retried and created a duplicate (2 records).');

  await runWorker('ledger', { providerUrl: provider.url, ledgerUrl });
  await sleep(180);
  const expired = await ledger.get({ namespace: 'failure-demo', operationId: 'crash-protected', history: true });
  assert.equal(expired.status, 'UNKNOWN');
  assert(expired.events.some(event => event.event === 'CLAIM_EXPIRED_TO_UNKNOWN'));
  await assert.rejects(ledger.execute({
    namespace: 'failure-demo', operationId: 'crash-protected',
    action: 'ticket.create', input: { scenario: 'crash' },
    perform: () => { throw new Error('must not execute'); },
  }), EffectUnknownError);
  const key = effectIdempotencyKey('failure-demo', 'crash-protected');
  assert.equal(count(provider.records, key), 1);
  const reconciled = await ledger.reconcile({
    namespace: 'failure-demo', operationId: 'crash-protected',
    verify: async () => {
      const matches = await providerLookup(provider.url, key);
      return matches.length
        ? { status: 'succeeded', result: matches[0], evidence: `Demo provider confirmed ${matches[0].id}` }
        : { status: 'unknown' };
    },
  });
  assert.equal(reconciled.status, 'SUCCEEDED');
  console.log('   With ledger: expired claim became UNKNOWN; restart was blocked; lookup reconciled success.');
}

const scenario = process.argv[2] || 'all';
if (!['all', 'concurrency', 'lost-response', 'crash'].includes(scenario)) {
  throw new Error('Usage: node examples/failure-demos.mjs [all|concurrency|lost-response|crash]');
}

const dir = mkdtempSync(join(tmpdir(), 'ael-failure-demos-'));
const provider = await startProvider();
const app = createLedgerServer({
  apiKey: API_KEY,
  dbPath: join(dir, 'effects.sqlite'),
  inFlightTimeoutMs: 120,
});
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const ledgerUrl = `http://127.0.0.1:${app.server.address().port}`;
const ledger = new EffectLedger({ url: ledgerUrl, apiKey: API_KEY });

try {
  const context = { ledger, ledgerUrl, provider };
  if (scenario === 'all' || scenario === 'concurrency') await concurrencyDemo(context);
  if (scenario === 'all' || scenario === 'lost-response') await lostResponseDemo(context);
  if (scenario === 'all' || scenario === 'crash') await crashDemo(context);
  console.log('\nPASS: every selected failure demonstration matched its assertions.');
  console.log('Provider calls above are local HTTP calls; failures are intentionally simulated.');
} finally {
  await app.close();
  await provider.close();
  rmSync(dir, { recursive: true, force: true });
}
