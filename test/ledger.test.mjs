import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createLedgerServer } from '../server/app.mjs';
import { LedgerStore } from '../server/storage.mjs';
import {
  EffectLedger, EffectInProgressError, EffectUnknownError, EffectConflictError,
  EffectUncertainError, EffectLedgerError,
  fingerprintInput,
} from '../src/index.mjs';

const KEY = 'test-key-1234567890';
async function fixture(t, { dbPath, store } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ael-'));
  const db = dbPath ?? join(dir, 'effects.sqlite');
  const app = createLedgerServer({ apiKey: KEY, dbPath: db, store });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  return { ledger: new EffectLedger({ url, apiKey: KEY }), url, db, app };
}

function operation(operationId = 'payment-123') {
  return { namespace: 'shop', operationId, action: 'charge', input: { amount: 500, currency: 'USD' } };
}

test('successful request is cached across retries and a fresh SDK instance', async t => {
  const { ledger, url } = await fixture(t);
  let calls = 0;
  const first = await ledger.execute({ ...operation(), perform: async () => { calls++; return { id: 'ch_1' }; } });
  const second = await new EffectLedger({ url, apiKey: KEY }).execute({
    ...operation(), perform: () => { calls++; throw new Error('duplicate'); },
  });
  assert.deepEqual(first, { id: 'ch_1' });
  assert.deepEqual(second, first);
  assert.equal(calls, 1);
  const effect = await ledger.get({ namespace: 'shop', operationId: 'payment-123', history: true });
  assert.equal(effect.status, 'SUCCEEDED');
  assert.deepEqual(effect.events.map(e => e.event), [
    'CLAIMED', 'EXECUTION_STARTED', 'SUCCEEDED', 'ATTEMPT_RETURNED_CACHED_SUCCESS',
  ]);
});

test('timeout after external success remains UNKNOWN, duplicate blocked, verified success reconciled', async t => {
  const { ledger } = await fixture(t);
  const provider = new Map();
  let calls = 0;
  await assert.rejects(ledger.execute({
    ...operation('refund-3'),
    perform: ({ idempotencyKey }) => {
      calls++;
      provider.set(idempotencyKey, { refundId: 'rf_3' });
      throw new Error('response vanished');
    },
  }), EffectUncertainError);
  await assert.rejects(ledger.execute({
    ...operation('refund-3'), perform: () => { calls++; return 'DUPLICATE'; },
  }), EffectUnknownError);
  assert.equal(calls, 1);
  let verified = 0;
  const reconciled = await ledger.reconcile({
    namespace: 'shop', operationId: 'refund-3',
    verify: () => {
      verified++;
      const key = 'mola_' + createHash('sha256').update(JSON.stringify(['shop', 'refund-3'])).digest('hex');
      assert.equal(provider.has(key), true);
      return { status: 'succeeded', evidence: 'provider refund rf_3', result: provider.get(key) };
    },
  });
  assert.equal(verified, 1);
  assert.equal(reconciled.status, 'SUCCEEDED');
  const cached = await ledger.execute({ ...operation('refund-3'), perform: () => { throw Error('unexpected'); } });
  assert.deepEqual(cached, { refundId: 'rf_3' });
  const history = (await ledger.get({ namespace: 'shop', operationId: 'refund-3', history: true })).events;
  assert(history.some(event => event.event === 'RECONCILED_SUCCEEDED'));
  assert.equal(history.at(-1).event, 'ATTEMPT_RETURNED_CACHED_SUCCESS');
});

test('unknown cannot be reconciled without affirmative evidence and missing result stays unknown', async t => {
  const { ledger } = await fixture(t);
  await assert.rejects(ledger.execute({ ...operation('unknown-1'), perform: () => { throw Error('failed'); } }), EffectUncertainError);
  assert.equal((await ledger.reconcile({ namespace: 'shop', operationId: 'unknown-1', verify: () => ({ status: 'unknown' }) })).status, 'UNKNOWN');
  await assert.rejects(ledger.reconcile({ namespace: 'shop', operationId: 'unknown-1', verify: () => ({ status: 'succeeded', result: 5 }) }), TypeError);
});

test('reusing same ID with changed request causes conflict (not silent return)', async t => {
  const { ledger } = await fixture(t);
  await ledger.execute({ ...operation(), perform: async () => ({ ok: true }) });
  await assert.rejects(ledger.execute({
    ...operation(), input: { currency: 'USD', amount: 501 }, perform: () => { throw Error('unexpected'); },
  }), EffectConflictError);
  await assert.rejects(ledger.execute({
    ...operation(), action: 'cancel', perform: () => { throw Error('unexpected'); },
  }), EffectConflictError);
});

test('concurrent calls for same operation do not both invoke external API', async t => {
  const { ledger } = await fixture(t);
  let release, entered;
  const block = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  let calls = 0;
  const first = ledger.execute({
    ...operation(), perform: async () => { calls++; entered(); await block; return { ok: true }; },
  });
  await started;
  await assert.rejects(ledger.execute({
    ...operation(), perform: async () => { calls++; return { ok: false }; },
  }), EffectInProgressError);
  release();
  await first;
  assert.equal(calls, 1);
});

test('orphaned in-flight claim expires to UNKNOWN and will not be retried', async t => {
  let current = 100_000;
  const store = new LedgerStore({ filename: ':memory:', inFlightTimeoutMs: 100, now: () => current });
  const { ledger } = await fixture(t, { store });
  store.claim({ namespace: 'shop', operationId: 'orphan', action: 'charge', inputHash: fingerprintInput({ amount: 500 }) });
  current += 200;
  const found = await ledger.get({ namespace: 'shop', operationId: 'orphan', history: true });
  assert.equal(found.status, 'UNKNOWN');
  assert.equal(found.events.at(-1).event, 'CLAIM_EXPIRED_TO_UNKNOWN');
  await assert.rejects(ledger.execute({
    namespace: 'shop', operationId: 'orphan', action: 'charge', input: { amount: 500 },
    perform: () => { throw Error('must not execute'); },
  }), EffectUnknownError);
});

test('original claim may report success after expiry if there was no competing reconciliation', async t => {
  let current = 100_000;
  const store = new LedgerStore({ filename: ':memory:', inFlightTimeoutMs: 100, now: () => current });
  const { ledger } = await fixture(t, { store });
  const c = store.claim({ namespace: 'shop', operationId: 'slow', action: 'create', inputHash: fingerprintInput({ value: 1 }) });
  current += 200;
  assert.equal((await ledger.get({ namespace: 'shop', operationId: 'slow' })).status, 'UNKNOWN');
  store.success({ namespace: 'shop', operationId: 'slow', token: c.token, result: { created: true } });
  assert.equal((await ledger.get({ namespace: 'shop', operationId: 'slow' })).status, 'SUCCEEDED');
});

test('service requires bearer authentication', async t => {
  const { url } = await fixture(t);
  const r = await fetch(`${url}/v1/effects?namespace=shop&operationId=123`);
  assert.equal(r.status, 401);
});

test('ledger unavailable fails closed before executing external callback', async () => {
  const ledger = new EffectLedger({ url: 'http://127.0.0.1:1', apiKey: KEY });
  let calls = 0;
  await assert.rejects(ledger.execute({
    ...operation(), perform: () => { calls++; return true; },
  }), err => err instanceof EffectLedgerError && err.code === 'LEDGER_UNAVAILABLE');
  assert.equal(calls, 0);
});

test('stable fingerprint ignores input property insertion order', () => {
  assert.equal(fingerprintInput({ b: 1, a: { z: 3, y: [1, 2] } }),
    fingerprintInput({ a: { y: [1, 2], z: 3 }, b: 1 }));
  assert.throws(() => fingerprintInput({ invalid: undefined }), TypeError);
});

test('unknown list includes expired orphaned claims and explicit unknowns', async t => {
  let current = 100_000;
  const store = new LedgerStore({ filename: ':memory:', inFlightTimeoutMs: 100, now: () => current });
  const { ledger } = await fixture(t, { store });
  store.claim({ namespace: 'shop', operationId: 'orphan-4', action: 'create', inputHash: fingerprintInput({}) });
  current += 200;
  const unknown = await ledger.listUnknown({ namespace: 'shop' });
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].operationId, 'orphan-4');
  assert.equal(unknown[0].status, 'UNKNOWN');
});

test('lost response while writing SUCCEEDED leaves durable cached result; never executes again', async t => {
  const { url } = await fixture(t);
  let calls = 0;
  const flakyTransport = async (requestUrl, init) => {
    const response = await fetch(requestUrl, init);
    if (new URL(requestUrl).pathname.endsWith('/succeed')) {
      throw new Error('simulated lost acknowledgement after successful ledger commit');
    }
    return response;
  };
  const client = new EffectLedger({ url, apiKey: KEY, fetchImpl: flakyTransport });
  await assert.rejects(client.execute({
    ...operation('commit-loss'), perform: async () => { calls++; return { charged: true }; },
  }), err => err instanceof EffectUncertainError && err.code === 'COMMIT_UNCERTAIN');
  const restoredClient = new EffectLedger({ url, apiKey: KEY });
  const cached = await restoredClient.execute({
    ...operation('commit-loss'), perform: () => { calls++; throw Error('duplicate'); },
  });
  assert.deepEqual(cached, { charged: true });
  assert.equal(calls, 1);
});

test('outcomes persist through a ledger server restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ael-restart-'));
  const db = join(dir, 'effects.sqlite');
  try {
    const first = createLedgerServer({ apiKey: KEY, dbPath: db });
    await new Promise(resolve => first.server.listen(0, '127.0.0.1', resolve));
    const client1 = new EffectLedger({ url: `http://127.0.0.1:${first.server.address().port}`, apiKey: KEY });
    await client1.execute({ ...operation('restart-1'), perform: () => ({ persisted: true }) });
    await first.close();

    const second = createLedgerServer({ apiKey: KEY, dbPath: db });
    try {
      await new Promise(resolve => second.server.listen(0, '127.0.0.1', resolve));
      const client2 = new EffectLedger({ url: `http://127.0.0.1:${second.server.address().port}`, apiKey: KEY });
      const result = await client2.execute({
        ...operation('restart-1'), perform: () => { throw Error('must not execute'); },
      });
      assert.deepEqual(result, { persisted: true });
    } finally {
      await second.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('optional HTTP backend exposes the same persisted reporting model', async t => {
  const { ledger } = await fixture(t);
  await ledger.execute({
    ...operation('report-http'),
    metadata: { workflow: 'support' },
    perform: () => ({ created: true }),
  });
  await ledger.execute({
    ...operation('report-http'),
    perform: () => { throw new Error('cached request must not execute'); },
  });
  const metrics = await ledger.getMetrics();
  assert.equal(metrics.totalAttempts, 2);
  assert.equal(metrics.uniqueOperations, 1);
  assert.equal(metrics.repeatedAttemptsSuppressed, 1);
  const page = await ledger.listOperations({ query: 'report-http' });
  assert.equal(page.total, 1);
  assert.equal(page.operations[0].metadata.workflow, 'support');
  assert((await ledger.recentActivity()).length >= 1);
  assert.equal((await ledger.activitySeries({ hours: 1 }))[0].attempts, 2);
});
