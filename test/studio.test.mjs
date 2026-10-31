import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createLedger, EffectUncertainError } from '../src/index.mjs';
import { createStudioServer } from '../studio/server.mjs';

async function studioFixture(t, { seed = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ael-studio-'));
  const storage = join(directory, 'ledger.sqlite');
  if (seed) {
    const writer = createLedger({ storage });
    await writer.execute({
      id: 'studio-success', action: 'issue.create', input: { title: 'Visible operation' },
      metadata: { agent: 'triage' },
      providerReference: 'https://provider.test/issues/11',
      run: () => ({ id: 11, privateBody: 'not exposed by Studio' }),
    });
    await assert.rejects(writer.execute({
      id: 'studio-unknown', action: 'ticket.create', input: { title: 'Uncertain operation' },
      run: () => { throw new Error('lost response'); },
    }), EffectUncertainError);
    await writer.close();
  }
  const studio = createStudioServer({ storage, port: 0 });
  const address = await studio.listen();
  t.after(async () => {
    await studio.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { address, storage, studio, directory };
}

test('Studio serves bundled UI and real ledger reporting on loopback', async t => {
  const { address, studio } = await studioFixture(t);
  assert.equal(studio.server.address().address, '127.0.0.1');
  const page = await fetch(address);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(await page.text(), /Mola Ledger Studio/);
  assert.equal((await fetch(`${address}/styles.css`)).status, 200);
  assert.equal((await fetch(`${address}/app.js`)).status, 200);

  const overview = await (await fetch(`${address}/api/overview`)).json();
  assert.equal(overview.totalAttempts, 2);
  assert.equal(overview.uniqueOperations, 2);
  assert.equal(overview.succeeded, 1);
  assert.equal(overview.unknown, 1);
});

test('Studio exposes safe summaries, filtering, pagination, and no mutation API', async t => {
  const { address } = await studioFixture(t);
  const page = await (await fetch(`${address}/api/operations?status=SUCCEEDED&limit=1`)).json();
  assert.equal(page.total, 1);
  assert.equal(page.operations[0].operationId, 'studio-success');
  assert.equal('result' in page.operations[0], false);

  const details = await (await fetch(`${address}/api/operations/default/studio-success`)).json();
  assert.deepEqual(details.operation.resultSummary, {
    type: 'object', keys: ['id', 'privateBody'],
  });
  assert.equal('result' in details.operation, false);
  assert.equal(details.operation.metadata.agent, 'triage');
  assert(details.operation.events.some(event => event.event === 'EXECUTION_STARTED'));

  const mutation = await fetch(`${address}/api/operations/default/studio-success`, { method: 'POST' });
  assert.equal(mutation.status, 405);
  assert.equal(mutation.headers.get('access-control-allow-origin'), null);
});

test('Studio observes new writes without restarting', async t => {
  const { address, storage } = await studioFixture(t, { seed: false });
  assert.equal((await (await fetch(`${address}/api/overview`)).json()).uniqueOperations, 0);
  const writer = createLedger({ storage });
  await writer.execute({
    id: 'arrived-live', action: 'record.create', input: { value: 1 }, run: () => ({ ok: true }),
  });
  await writer.close();
  const updated = await (await fetch(`${address}/api/overview`)).json();
  assert.equal(updated.uniqueOperations, 1);
  assert.equal(updated.succeeded, 1);
});

test('Studio rejects non-loopback binding and invalid storage paths', t => {
  assert.throws(() => createStudioServer({ host: '0.0.0.0' }), /only binds to a loopback/);
  const directory = mkdtempSync(join(tmpdir(), 'ael-studio-invalid-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const blocker = join(directory, 'file');
  writeFileSync(blocker, 'not a directory');
  assert.throws(() => createStudioServer({ storage: join(blocker, 'ledger.sqlite') }), /Cannot initialize/);
});

test('Studio rejects unexpected Host headers', async t => {
  const { address } = await studioFixture(t, { seed: false });
  const status = await new Promise((resolve, reject) => {
    const req = request(`${address}/api/overview`, { headers: { host: 'attacker.example' } }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    req.once('error', reject);
    req.end();
  });
  assert.equal(status, 403);
});
