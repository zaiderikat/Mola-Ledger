import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EffectConflictError,
  EffectLedgerError,
  EffectUnknownError,
  EffectUncertainError,
  createLedger,
} from '../src/index.mjs';

function temporaryLedger(t) {
  const directory = mkdtempSync(join(tmpdir(), 'ael-embedded-'));
  const storage = join(directory, 'ledger.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, storage };
}

test('embedded ledger executes without HTTP and persists through application restart', async t => {
  const { storage } = temporaryLedger(t);
  let calls = 0;
  const first = createLedger({ storage });
  assert.equal(first.storagePath, storage);
  const result = await first.execute({
    id: 'ticket-123',
    action: 'ticket.create',
    input: { title: 'Investigate alert' },
    run: async () => {
      calls++;
      return { ticketId: 'T-123' };
    },
  });
  assert.deepEqual(result, { ticketId: 'T-123' });
  await first.close();

  const restarted = createLedger({ storage });
  t.after(() => restarted.close());
  const cached = await restarted.execute({
    id: 'ticket-123',
    action: 'ticket.create',
    input: { title: 'Investigate alert' },
    run: () => {
      calls++;
      throw new Error('must not execute');
    },
  });
  assert.deepEqual(cached, result);
  assert.equal(calls, 1);
});

test('embedded ledger preserves conflict and unknown safety semantics', async t => {
  const { storage } = temporaryLedger(t);
  const ledger = createLedger({ storage });
  t.after(() => ledger.close());

  await assert.rejects(ledger.execute({
    id: 'external-1', action: 'external.create', input: { value: 1 },
    run: () => { throw new Error('provider response lost'); },
  }), EffectUncertainError);
  await assert.rejects(ledger.execute({
    id: 'external-1', action: 'external.create', input: { value: 1 },
    run: () => ({ duplicate: true }),
  }), EffectUnknownError);
  await assert.rejects(ledger.execute({
    id: 'external-1', action: 'external.create', input: { value: 2 },
    run: () => ({ duplicate: true }),
  }), EffectConflictError);
});

test('embedded SQLite atomically suppresses duplicate claims across Node processes', async t => {
  const { directory, storage } = temporaryLedger(t);
  const executions = join(directory, 'executions.log');
  const worker = join(import.meta.dirname, 'fixtures', 'embedded-worker.mjs');
  const runWorker = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, storage, executions], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
  });

  const results = await Promise.all([runWorker(), runWorker()]);
  assert(results.some(result => result === 'IN_PROGRESS' || result.includes('created')));
  assert.equal(readFileSync(executions, 'utf8').trim().split('\n').length, 1);
});

test('embedded reporting persists accurate attempts, outcomes, filters, and sanitized metadata', async t => {
  const { storage } = temporaryLedger(t);
  const ledger = createLedger({ storage });

  const succeeded = await ledger.execute({
    id: 'report-success', action: 'issue.create', input: { title: 'One' },
    metadata: { agent: 'triage', apiToken: 'must-not-be-recorded' },
    providerReference: result => result.url,
    run: () => ({ id: 1, url: 'https://provider.test/issues/1' }),
  });
  await ledger.execute({
    id: 'report-success', action: 'issue.create', input: { title: 'One' },
    run: () => { throw new Error('cached request must not execute'); },
  });
  await assert.rejects(ledger.execute({
    id: 'report-unknown', action: 'ticket.create', input: { title: 'Two' },
    run: () => { throw new Error('lost provider response'); },
  }), EffectUncertainError);
  await assert.rejects(ledger.execute({
    id: 'report-unknown', action: 'ticket.create', input: { title: 'Two' },
    run: () => ({ duplicate: true }),
  }), EffectUnknownError);
  await assert.rejects(ledger.execute({
    id: 'report-unknown', action: 'ticket.create', input: { title: 'Changed' },
    run: () => ({ duplicate: true }),
  }), EffectConflictError);

  assert.deepEqual(succeeded, { id: 1, url: 'https://provider.test/issues/1' });
  const effect = await ledger.get({ id: 'report-success', history: true });
  assert.equal(effect.metadata.agent, 'triage');
  assert.equal(effect.metadata.apiToken, '[redacted]');
  assert.equal(effect.providerReference, 'https://provider.test/issues/1');
  assert.equal(effect.attemptCount, 2);
  assert.equal(effect.executionAttemptCount, 1);
  assert.equal(effect.suppressedAttemptCount, 1);
  assert(effect.executionStartedAt);

  await ledger.close();
  const restarted = createLedger({ storage });
  t.after(() => restarted.close());
  assert.deepEqual(await restarted.getMetrics(), {
    totalAttempts: 5,
    uniqueOperations: 2,
    succeeded: 1,
    inProgress: 0,
    unknown: 1,
    repeatedAttemptsSuppressed: 2,
    inputConflicts: 1,
    reconciledOperations: 0,
    instrumentationSince: (await restarted.getMetrics()).instrumentationSince,
  });
  const filtered = await restarted.listOperations({ status: 'UNKNOWN', query: 'report', limit: 10 });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.operations[0].operationId, 'report-unknown');
  assert((await restarted.recentActivity()).some(event => event.event === 'ATTEMPT_INPUT_CONFLICT'));
  assert.equal((await restarted.activitySeries({ hours: 1 }))[0].attempts, 5);

  await restarted.reconcile({
    id: 'report-unknown',
    verify: () => ({
      status: 'succeeded', evidence: 'provider ticket T-2', result: { ticketId: 'T-2' },
    }),
  });
  const afterReconciliation = await restarted.getMetrics();
  assert.equal(afterReconciliation.succeeded, 2);
  assert.equal(afterReconciliation.unknown, 0);
  assert.equal(afterReconciliation.reconciledOperations, 1);
});

test('embedded initialization reports inaccessible storage paths explicitly', t => {
  const { directory } = temporaryLedger(t);
  const blocker = join(directory, 'not-a-directory');
  writeFileSync(blocker, 'file');
  assert.throws(
    () => createLedger({ storage: join(blocker, 'ledger.sqlite') }),
    error => error instanceof EffectLedgerError && error.code === 'STORAGE_INITIALIZATION_FAILED',
  );
});

test('v0.2 SQLite databases migrate in place without losing confirmed effects', async t => {
  const { storage } = temporaryLedger(t);
  const old = new DatabaseSync(storage);
  old.exec(`
    CREATE TABLE effects (
      namespace TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      action TEXT NOT NULL,
      input_sha256 TEXT NOT NULL,
      status TEXT NOT NULL,
      claim_token TEXT NOT NULL,
      result_json TEXT,
      reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(namespace, operation_id)
    ) STRICT;
    CREATE TABLE effect_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      namespace TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      event TEXT NOT NULL,
      detail TEXT,
      created_at INTEGER NOT NULL
    ) STRICT;
  `);
  const inputHash = 'a'.repeat(64);
  old.prepare(`INSERT INTO effects VALUES(?, ?, ?, ?, 'SUCCEEDED', ?, ?, NULL, ?, ?)`)
    .run('legacy', 'existing-1', 'legacy.action', inputHash, 'legacy-token', '{"preserved":true}', 1, 1);
  old.close();

  const ledger = createLedger({ storage });
  t.after(() => ledger.close());
  const effect = await ledger.get({ namespace: 'legacy', id: 'existing-1', history: true });
  assert.deepEqual(effect.result, { preserved: true });
  assert.equal(effect.status, 'SUCCEEDED');
  assert.equal(effect.attemptCount, 0);
  assert.equal(effect.metadata, null);
});
