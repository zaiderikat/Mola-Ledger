import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GitHubIssuesAdapter,
  GitHubIssuesError,
  githubIssueMarker,
} from '../integrations/github-issues.mjs';
import { effectIdempotencyKey } from '../src/index.mjs';

const execFileAsync = promisify(execFile);
const KEY = effectIdempotencyKey('demo', 'create-issue-1');

const issue = (overrides = {}) => ({
  id: 101,
  node_id: 'I_kw_example',
  number: 7,
  html_url: 'https://github.com/example/repo/issues/7',
  title: 'Demo issue',
  state: 'open',
  body: githubIssueMarker(KEY),
  ...overrides,
});

test('GitHub adapter creates an issue with a stable hidden marker and projects evidence fields', async () => {
  let request;
  const adapter = new GitHubIssuesAdapter({
    token: 'secret-token', owner: 'example', repo: 'repo',
    fetchImpl: async (url, init) => {
      request = { url, init };
      return new Response(JSON.stringify(issue()), {
        status: 201, headers: { 'content-type': 'application/json' },
      });
    },
  });
  const result = await adapter.createIssue({
    title: 'Demo issue', body: 'Visible body', labels: ['demo'], idempotencyKey: KEY,
  });
  assert.equal(request.url, 'https://api.github.com/repos/example/repo/issues');
  assert.equal(request.init.headers.authorization, 'Bearer secret-token');
  const sent = JSON.parse(request.init.body);
  assert.equal(sent.body, `Visible body\n\n${githubIssueMarker(KEY)}`);
  assert.deepEqual(sent.labels, ['demo']);
  assert.deepEqual(result, {
    id: 101, nodeId: 'I_kw_example', number: 7,
    url: 'https://github.com/example/repo/issues/7', title: 'Demo issue', state: 'open',
  });
});

test('GitHub positive lookup returns reconciliation evidence and ignores pull requests', async () => {
  const adapter = new GitHubIssuesAdapter({
    token: 'secret-token', owner: 'example', repo: 'repo',
    fetchImpl: async () => new Response(JSON.stringify([
      issue({ number: 6, pull_request: { url: 'https://api.github.test/pulls/6' } }),
      issue(),
    ]), { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  const verified = await adapter.verifyIssueByIdempotencyKey(KEY);
  assert.equal(verified.status, 'succeeded');
  assert.equal(verified.result.number, 7);
  assert.match(verified.evidence, /I_kw_example/);
});

test('GitHub missing lookup remains unknown and API errors retain safe diagnostics', async () => {
  const missing = new GitHubIssuesAdapter({
    token: 'secret-token', owner: 'example', repo: 'repo',
    fetchImpl: async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  assert.deepEqual(await missing.verifyIssueByIdempotencyKey(KEY), { status: 'unknown' });

  const failing = new GitHubIssuesAdapter({
    token: 'secret-token', owner: 'example', repo: 'repo',
    fetchImpl: async () => new Response(JSON.stringify({ message: 'Bad credentials' }), {
      status: 401, headers: { 'content-type': 'application/json' },
    }),
  });
  await assert.rejects(failing.findIssueByIdempotencyKey(KEY), error => (
    error instanceof GitHubIssuesError && error.status === 401 && !error.message.includes('secret-token')
  ));
});

test('all three executable failure demonstrations pass', async () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const { stdout } = await execFileAsync(process.execPath, [join(root, 'examples/failure-demos.mjs')], {
    cwd: root,
    timeout: 10_000,
  });
  assert.match(stdout, /CONCURRENT DUPLICATE EXECUTION/);
  assert.match(stdout, /LOST RESPONSE AFTER PROVIDER SUCCESS/);
  assert.match(stdout, /APPLICATION PROCESS CRASH AND RESTART/);
  assert.match(stdout, /PASS: every selected failure demonstration matched its assertions/);
});
