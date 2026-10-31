import {
  EffectLedger,
  EffectUncertainError,
  EffectUnknownError,
  effectIdempotencyKey,
} from '../src/index.mjs';
import { GitHubIssuesAdapter } from '../integrations/github-issues.mjs';

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required; see docs/GITHUB_ISSUES.md`);
  return value;
};

const command = process.argv[2] || 'create';
if (!['create', 'reconcile', 'status'].includes(command)) {
  throw new Error('Usage: node examples/github-issue.mjs [create|reconcile|status]');
}

const namespace = process.env.MOLA_LEDGER_NAMESPACE || 'github-demo';
const operationId = required('GITHUB_OPERATION_ID');
const title = process.env.GITHUB_ISSUE_TITLE || `[Mola Ledger demo] ${operationId}`;
const body = process.env.GITHUB_ISSUE_BODY || 'Created by the Mola Ledger GitHub Issues example.';

const ledger = new EffectLedger({
  url: process.env.MOLA_LEDGER_URL || 'http://127.0.0.1:8787',
  apiKey: required('MOLA_LEDGER_API_KEY'),
});
const github = new GitHubIssuesAdapter({
  token: required('GITHUB_TOKEN'),
  owner: required('GITHUB_OWNER'),
  repo: required('GITHUB_REPO'),
});

const identity = { namespace, operationId };
const key = effectIdempotencyKey(namespace, operationId);

async function create() {
  try {
    const result = await ledger.execute({
      ...identity,
      action: 'github.issue.create',
      input: { owner: github.owner, repo: github.repo, title, body },
      perform: async ({ idempotencyKey }) => {
        const issue = await github.createIssue({ title, body, idempotencyKey });
        if (process.env.GITHUB_SIMULATE_LOST_RESPONSE === '1') {
          throw new Error(`Simulated response loss after GitHub created ${issue.url}`);
        }
        return issue;
      },
    });
    console.log(`CONFIRMED: GitHub issue #${result.number}: ${result.url}`);
  } catch (error) {
    if (error instanceof EffectUnknownError) {
      console.error('BLOCKED: the prior attempt is UNKNOWN. Run the reconcile command; do not blindly retry.');
      process.exitCode = 2;
      return;
    }
    if (error instanceof EffectUncertainError) {
      console.error('UNKNOWN: GitHub may have created the issue. The ledger blocked blind replay.');
      console.error('Run: npm run demo:github -- reconcile');
      process.exitCode = 2;
      return;
    }
    throw error;
  }
}

async function reconcile() {
  const result = await ledger.reconcile({
    ...identity,
    verify: () => github.verifyIssueByIdempotencyKey(key),
  });
  if (result.status === 'SUCCEEDED') {
    console.log(`RECONCILED: GitHub issue #${result.result.number}: ${result.result.url}`);
  } else {
    console.log('STILL UNKNOWN: no matching issue was found. This is not proof that creation failed.');
    process.exitCode = 2;
  }
}

async function status() {
  const effect = await ledger.get({ ...identity, history: true });
  console.log(JSON.stringify(effect, null, 2));
}

await ({ create, reconcile, status }[command]());
