import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLedger, effectIdempotencyKey } from '../src/index.mjs';
import { GitHubIssuesAdapter, githubIssueMarker } from '../integrations/github-issues.mjs';
import { createGitHubIssueToolHandler } from '../examples/openai-agent/tool-handler.mjs';

const issueResponse = (body, overrides = {}) => ({
  id: 401,
  node_id: 'I_agent_example',
  number: 41,
  html_url: 'https://github.com/example/repo/issues/41',
  title: 'Ship the ledger',
  state: 'open',
  body,
  ...overrides,
});

function context(requestId = 'request-41') {
  return {
    context: {
      requestId,
      issue: {
        title: 'Ship the ledger',
        body: 'Document the production incident.',
        labels: ['agent'],
      },
    },
  };
}

test('OpenAI agent tool uses trusted context and cached replay creates one GitHub issue', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ael-agent-tool-'));
  const ledger = createLedger({ storage: join(dir, 'ledger.sqlite') });
  let creates = 0;
  const github = new GitHubIssuesAdapter({
    token: 'test-token', owner: 'example', repo: 'repo',
    fetchImpl: async (_url, init) => {
      creates += 1;
      const sent = JSON.parse(init.body);
      return new Response(JSON.stringify(issueResponse(sent.body)), {
        status: 201, headers: { 'content-type': 'application/json' },
      });
    },
  });
  const execute = createGitHubIssueToolHandler({ ledger, github });

  try {
    const first = await execute({}, context());
    const second = await execute({}, context());
    assert.equal(first.status, 'succeeded');
    assert.equal(second.status, 'succeeded');
    assert.equal(creates, 1);
    const metrics = await ledger.getMetrics();
    assert.equal(metrics.totalAttempts, 2);
    assert.equal(metrics.repeatedAttemptsSuppressed, 1);
  } finally {
    await ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('OpenAI agent tool returns a controlled unknown response and positive GitHub evidence reconciles it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ael-agent-unknown-'));
  const ledger = createLedger({ storage: join(dir, 'ledger.sqlite') });
  let creates = 0;
  let createdIssue;
  const github = new GitHubIssuesAdapter({
    token: 'test-token', owner: 'example', repo: 'repo',
    fetchImpl: async (_url, init = {}) => {
      if (init.method === 'POST') {
        creates += 1;
        const sent = JSON.parse(init.body);
        createdIssue = issueResponse(sent.body);
        throw new Error('simulated response loss after provider success');
      }
      return new Response(JSON.stringify([createdIssue]), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    },
  });
  const execute = createGitHubIssueToolHandler({ ledger, github });

  try {
    const first = await execute({}, context('request-unknown'));
    const second = await execute({}, context('request-unknown'));
    assert.equal(first.status, 'blocked_unknown');
    assert.equal(second.status, 'blocked_unknown');
    assert.equal(creates, 1);

    const operationId = 'github-issue:request-unknown';
    const key = effectIdempotencyKey('openai-agent-example', operationId);
    assert(createdIssue.body.includes(githubIssueMarker(key)));
    const reconciled = await ledger.reconcile({
      id: operationId,
      namespace: 'openai-agent-example',
      verify: () => github.verifyIssueByIdempotencyKey(key),
    });
    assert.equal(reconciled.status, 'SUCCEEDED');
    assert.equal(reconciled.result.number, 41);
  } finally {
    await ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('OpenAI agent tool rejects missing trusted request identity before calling GitHub', async () => {
  let called = false;
  const execute = createGitHubIssueToolHandler({
    ledger: { execute: async () => { called = true; } },
    github: { createIssue: async () => { called = true; } },
  });
  await assert.rejects(execute({}, { context: { issue: { title: 'No ID' } } }), /requestId/);
  assert.equal(called, false);
});
