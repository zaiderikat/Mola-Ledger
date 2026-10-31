import {
  EffectUnknownError,
  createLedger,
  type EffectRecord,
  type LedgerMetrics,
} from 'mola-ledger';
import {
  GitHubIssuesAdapter,
  type GitHubIssueResult,
} from 'mola-ledger/github-issues';
import { createStudioServer } from 'mola-ledger/studio';

const ledger = createLedger({ storage: ':memory:', inFlightTimeoutMs: 1_000 });

const issue = await ledger.execute<{ title: string }, GitHubIssueResult>({
  id: 'typed-example',
  action: 'github.issue.create',
  input: { title: 'Typed' },
  metadata: { agent: 'type-check' },
  providerReference: result => result.url,
  run: async ({ idempotencyKey }) => ({
    id: 1,
    nodeId: idempotencyKey,
    number: 1,
    url: 'https://example.test/issues/1',
    title: 'Typed',
    state: 'open',
  }),
});

const record: EffectRecord<GitHubIssueResult> | null = await ledger.get({ id: 'typed-example', history: true });
const metrics: LedgerMetrics = await ledger.getMetrics();
const page = await ledger.listOperations<GitHubIssueResult>({ status: 'SUCCEEDED', limit: 10 });

const github = new GitHubIssuesAdapter({ token: 'test', owner: 'owner', repo: 'repo' });
const verified = await github.verifyIssueByIdempotencyKey(issue.nodeId);
const studio = createStudioServer({ storage: ':memory:', port: 0 });

void record;
void metrics;
void page;
void verified;
void studio.address;
void EffectUnknownError;

await ledger.close();
