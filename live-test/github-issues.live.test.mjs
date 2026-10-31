import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  EffectUncertainError,
  EffectUnknownError,
  createLedger,
  effectIdempotencyKey,
} from '../src/index.mjs';
import { GitHubIssuesAdapter } from '../integrations/github-issues.mjs';

test('creates, blocks uncertain replay, positively reconciles, and caches a real GitHub issue', async t => {
  assert.equal(process.env.RUN_GITHUB_LIVE_TEST, '1', 'Set RUN_GITHUB_LIVE_TEST=1 to acknowledge a real issue will be created');
  for (const name of ['GITHUB_TOKEN', 'GITHUB_OWNER', 'GITHUB_REPO']) {
    assert(process.env[name], `${name} is required`);
  }

  const ledger = createLedger({ storage: ':memory:' });
  t.after(() => ledger.close());
  const github = new GitHubIssuesAdapter({
    token: process.env.GITHUB_TOKEN,
    owner: process.env.GITHUB_OWNER,
    repo: process.env.GITHUB_REPO,
  });
  const operationId = `live-test-${randomUUID()}`;
  const input = {
    owner: github.owner,
    repo: github.repo,
    title: `[Mola Ledger live test] ${operationId}`,
  };
  let providerCreates = 0;
  let created;
  const operation = {
    namespace: 'github-live-test',
    operationId,
    action: 'github.issue.create',
    input,
  };

  await assert.rejects(ledger.execute({
    ...operation,
    perform: async ({ idempotencyKey }) => {
      providerCreates += 1;
      created = await github.createIssue({
        title: input.title,
        body: 'This disposable issue is evidence from the opt-in live integration test.',
        idempotencyKey,
      });
      throw new Error('Simulated response loss after GitHub confirmed creation');
    },
  }), EffectUncertainError);

  await assert.rejects(ledger.execute({
    ...operation,
    perform: async () => { providerCreates += 1; },
  }), EffectUnknownError);
  assert.equal(providerCreates, 1);

  const key = effectIdempotencyKey(operation.namespace, operation.operationId);
  const reconciled = await ledger.reconcile({
    namespace: operation.namespace,
    operationId: operation.operationId,
    verify: () => github.verifyIssueByIdempotencyKey(key),
  });
  assert.equal(reconciled.status, 'SUCCEEDED');
  assert.equal(reconciled.result.number, created.number);

  const cached = await ledger.execute({
    ...operation,
    perform: async () => { providerCreates += 1; },
  });
  assert.equal(cached.number, created.number);
  assert.equal(providerCreates, 1);
  console.log(`LIVE_GITHUB_EVIDENCE=${created.url}`);
});
