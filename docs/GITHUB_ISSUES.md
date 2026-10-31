# GitHub Issues adapter

The bundled adapter performs a real state-changing operation in a repository you control. Use a disposable repository for evaluation.

## Provider behavior

`GitHubIssuesAdapter.createIssue()` calls GitHub's issue-creation endpoint and appends a hidden marker derived from the ledger idempotency key:

```text
<!-- mola-ledger-idempotency:mola_… -->
```

`verifyIssueByIdempotencyKey()` scans open and closed issues, ignores pull requests, and looks for the exact marker. A match returns the issue number, node ID, URL, title, and state as affirmative evidence.

GitHub does not accept an idempotency-key parameter for issue creation. The marker supports later verification but cannot make the GitHub write and ledger commit atomic.

## Use the adapter

Create a fine-grained GitHub token restricted to a disposable repository with **Issues: Read and write** permission. Keep it in an environment variable or secret manager.

```javascript
import {
  createLedger,
  effectIdempotencyKey,
} from 'mola-ledger';
import { GitHubIssuesAdapter } from 'mola-ledger/github-issues';

const ledger = createLedger({ storage: './data/github-actions.sqlite' });
const github = new GitHubIssuesAdapter({
  token: process.env.GITHUB_TOKEN,
  owner: process.env.GITHUB_OWNER,
  repo: process.env.GITHUB_REPO,
});

const identity = {
  namespace: 'support',
  id: 'alert-1842-issue-v1',
};

const issue = await ledger.execute({
  ...identity,
  action: 'github.issue.create',
  input: { title: 'Investigate alert 1842' },
  providerReference: result => result.url,
  run: ({ idempotencyKey }) => github.createIssue({
    title: 'Investigate alert 1842',
    body: 'Created by the support agent.',
    labels: ['incident'],
    idempotencyKey,
  }),
});

console.log(issue.url);
```

Run the same `execute()` again with unchanged identity and input to receive the stored issue without another GitHub creation.

## Reconcile a lost response

If issue creation may have succeeded but `execute()` throws `EffectUncertainError`, do not choose a new operation ID and do not blindly call GitHub again. Verify and reconcile the same identity:

```javascript
const key = effectIdempotencyKey(identity.namespace, identity.id);

const outcome = await ledger.reconcile({
  ...identity,
  verify: () => github.verifyIssueByIdempotencyKey(key),
});
```

A match records `SUCCEEDED` with the projected issue and evidence. A missing match returns `{ status: 'unknown' }` and leaves the record blocked.

## What a missing match means

The default lookup checks at most 10 pages of 100 issues. Absence is not proof that creation failed because the issue may be outside the scan limit, temporarily invisible, inaccessible under changed permissions, or edited so the marker is gone. API failure also cannot establish non-execution.

The adapter never converts a negative GitHub lookup into permission to retry.

## Studio

```bash
npx mola-ledger studio --storage ./data/github-actions.sqlite
```

Studio displays the provider URL, sanitized metadata, attempt decisions, current state, and event timeline. It intentionally does not expose a retry or reconciliation button.

## OpenAI Agents SDK example

The complete agent tool integration uses this adapter and trusted run context. Follow [the OpenAI Agents SDK guide](OPENAI_AGENTS.md).

## Opt-in live verification

Normal unit tests use controlled HTTP responses. To deliberately create one real issue and exercise lost response, unknown blocking, marker lookup, reconciliation, and cached replay:

```bash
export GITHUB_TOKEN='github_pat_…'
export GITHUB_OWNER='your-account-or-org'
export GITHUB_REPO='disposable-issues-repo'
RUN_GITHUB_LIVE_TEST=1 npm run test:live:github
```

The test prints `LIVE_GITHUB_EVIDENCE=https://github.com/.../issues/...`. It never runs automatically and never reads credentials unless explicitly enabled.

## Security notes

The token stays in the application-side adapter and is never stored by the ledger. The adapter's HTTP errors omit the token. Do not put credentials, personal data, or sensitive content in operation IDs, issue text, results, metadata, or evidence.
