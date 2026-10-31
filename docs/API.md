# SDK and reporting API

## Embedded ledger

```javascript
import { createLedger, EmbeddedLedger } from 'mola-ledger';

const ledger = createLedger({
  storage: './.mola-ledger/ledger.sqlite',
  inFlightTimeoutMs: 60_000,
});
```

`storage` defaults to `./.mola-ledger/ledger.sqlite`, resolved from the application working directory. Parent directories and the database are created automatically. Use `:memory:` only for disposable tests. Call `await ledger.close()` during an orderly shutdown.

`new EmbeddedLedger(options)` and `createLedger(options)` are equivalent. Embedded mode has no URL, bearer token, or service dependency.

## `execute(options)`

```javascript
const result = await ledger.execute({
  id: 'ticket-for-alert-1842-v1',
  namespace: 'support',
  action: 'ticket.create',
  input: { alertId: 1842 },
  metadata: { agent: 'triage' },
  providerReference: result => result.url,
  run: ({ idempotencyKey }) => provider.create({
    alertId: 1842,
    idempotencyKey,
  }),
});
```

Required fields are `id`, `action`, `input`, and `run`. `namespace` defaults to `default`. The legacy names `operationId` and `perform` remain supported, but do not provide both aliases in one call.

The SDK hashes canonical JSON input, atomically claims `(namespace, id)`, durably records execution start, and invokes `run` only for a new claim. The external call never runs inside a database transaction.

Outcomes:

- New claim: the callback runs and its confirmed result is returned.
- `SUCCEEDED`: the stored result is returned without another callback invocation.
- `IN_PROGRESS`: throws `EffectInProgressError`.
- `UNKNOWN`: throws `EffectUnknownError`.
- Same identity with changed action or input: throws `EffectConflictError`.
- Callback throws or times out: records uncertainty when possible and throws `EffectUncertainError` with `EXECUTION_UNCERTAIN`.
- Provider returned but ledger confirmation failed: throws `EffectUncertainError` with `COMMIT_UNCERTAIN`.

An `EffectUncertainError` never means “safe to retry.” Inspect the ledger and provider first.

### Identity rules

Choose an ID from a stable business fact controlled by the application, such as `refund:order-739:v1`. Reuse it for every retry of the same intended action. Never use a fresh UUID generated inside a retry and never trust a model to invent the authoritative ID.

An ID is permanently bound to its first action and input fingerprint. Raw input is not stored. Optional metadata is sanitized recursively, known secret-like keys are redacted, and the sanitized value is capped at 8 KiB. Keep secrets and personal data out of IDs, action names, metadata, results, and evidence anyway.

## Read and reconcile

### `get({ id, namespace?, history? })`

Returns an effect record or `null`. `history: true` includes chronological events. Reading also changes an expired `IN_PROGRESS` claim to `UNKNOWN`; it never authorizes replay.

### `listUnknown({ namespace?, limit? })`

Returns up to 100 uncertain operations, oldest update first, and lazily exposes expired claims in the requested namespace.

### `reconcile({ id, namespace?, verify })`

`verify(identity)` runs only for an existing `UNKNOWN` record. Return one of:

```javascript
{ status: 'unknown' }
```

```javascript
{
  status: 'succeeded',
  result: providerObject,
  evidence: 'Provider object abc-123 at https://provider.example/abc-123',
}
```

Only affirmative success changes state. A missing object, `404`, timeout, incomplete page scan, or inaccessible provider remains `UNKNOWN`. The ledger has no “mark failed and retry” transition.

## Reporting

All reporting methods read persisted data and are available in embedded and HTTP modes.

- `getMetrics({ namespace?, from?, to? })` returns total attempts, unique operations, state counts, suppressed attempts, conflicts, reconciliations, and the instrumentation start time.
- `listOperations({ namespace?, query?, action?, status?, from?, to?, limit?, offset? })` returns a paginated page. `limit` is 1–100.
- `recentActivity({ namespace?, limit? })` returns newest durable events.
- `activitySeries({ namespace?, hours? })` returns hourly attempt, suppression, and conflict buckets.

`from` and `to` accept ISO dates or millisecond timestamps. Counts for databases migrated from v0.2 begin at `instrumentationSince`; the migration does not fabricate attempts that older versions never recorded.

## Effect records

Records include identity, action, status, input hash, sanitized metadata, safe diagnostic reason, result, optional provider reference, attempt/execution/suppression/conflict counts, created/updated/execution/success/unknown/reconciliation timestamps, and optionally events.

Stored results are application data and can be sensitive. Studio intentionally exposes only a structural summary, but code using `get()` receives the full stored result.

## Errors and helpers

All SDK errors extend `EffectLedgerError` and include a string `code`. State classes are `EffectInProgressError`, `EffectUnknownError`, `EffectConflictError`, and `EffectUncertainError`.

- `fingerprintInput(input)` returns the canonical SHA-256 input fingerprint.
- `effectIdempotencyKey(namespace, operationId)` returns the stable key passed to callbacks.

## Optional HTTP client

```javascript
import { EffectLedger } from 'mola-ledger';

const ledger = new EffectLedger({
  url: 'http://127.0.0.1:8787',
  apiKey: process.env.MOLA_LEDGER_API_KEY,
});
```

The public execution/read/reporting methods match embedded mode. `url` defaults to `http://127.0.0.1:8787`; `apiKey` is required. The backend is retained for compatibility, not presented as a production distributed service.

HTTP routes other than `GET /healthz` require `Authorization: Bearer <MOLA_LEDGER_API_KEY>`:

| Method and path | Purpose |
|---|---|
| `POST /v1/effects/claim` | Atomic claim or repeat decision |
| `POST /v1/effects/execution-started` | Durable execution-start record |
| `POST /v1/effects/succeed` | Commit callback result |
| `POST /v1/effects/unknown` | Mark claimed attempt uncertain |
| `POST /v1/effects/reconcile-success` | Record positively verified success |
| `GET /v1/effects` | Fetch one record and optional history |
| `GET /v1/effects/unknown` | List uncertain records |
| `GET /v1/reporting/overview` | Aggregate metrics |
| `GET /v1/reporting/operations` | Filtered, paginated operations |
| `GET /v1/reporting/activity` | Recent events |
| `GET /v1/reporting/series` | Hourly reporting buckets |

The HTTP routes are an SDK implementation interface, not a stability promise for third-party language clients.

## GitHub adapter

Import `GitHubIssuesAdapter`, `GitHubIssuesError`, and `githubIssueMarker` from `mola-ledger/github-issues`. See [the GitHub guide](GITHUB_ISSUES.md) for creation, marker-based positive verification, and its limitations.

## Validation limits

- Namespace: 1–80 characters from `A-Z a-z 0-9 _ . -`.
- Operation ID: 1–200 non-empty characters.
- Action: 1–120 non-empty characters.
- Result: JSON-compatible, at most 64 KiB encoded.
- Sanitized metadata: at most 8 KiB encoded.
- HTTP request body: at most 128 KiB.
- Reconciliation evidence and diagnostic reason: at most 500 characters.
