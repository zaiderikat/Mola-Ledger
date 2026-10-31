# Reproducible failure demonstrations

Run every scenario with:

```bash
npm run demo:failures
```

Or run one:

```bash
npm run demo:failures -- concurrency
npm run demo:failures -- lost-response
npm run demo:failures -- crash
```

The script uses two real local HTTP servers: the ledger and a deliberately small provider. Provider calls are real HTTP writes to that local process. Network loss is deliberately simulated, and the crash scenario terminates a real child Node.js process with exit code 86. No external service or credential is used.

## Concurrent duplicate execution

**Failure:** two callers issue the same business action at nearly the same time.

**Without protection:** two concurrent `POST /actions` calls create two provider records.

**With the ledger:** the first caller atomically creates the `(namespace, operationId)` claim. Its provider response is delayed so the second caller overlaps. The second receives `EffectInProgressError`; only one provider record exists.

**Boundary:** this relies on every caller using the same stable operation ID and the same ledger service. A caller bypassing the SDK or choosing a new ID can still create a duplicate.

## Lost response after successful action

**Failure:** the provider durably creates a record, then the application behaves as if the response was lost.

**Without protection:** the application retries and the provider has two records.

**With the ledger:** the callback throws after the provider response. The ledger records `UNKNOWN`; another `execute()` is blocked. A positive provider lookup finds the original record and `reconcile()` changes the durable status to `SUCCEEDED`.

**Boundary:** the provider success is a local HTTP write; the response loss is simulated in application code. A negative lookup would leave the effect `UNKNOWN`.

## Process crash or restart

**Failure:** a child application process receives provider success and immediately exits before `execute()` can report success to the ledger.

**Without protection:** the restarted application repeats the call and creates a second record.

**With the ledger:** the durable claim survives the child. After the configured in-flight timeout, the next read lazily changes the claim to `UNKNOWN`. The restarted application is blocked from executing. A positive provider lookup reconciles the one existing record.

**Boundary:** the demo crashes the application process, not the provider. It uses a short 120 ms claim timeout only to make the demo fast. Production timeouts must exceed normal action duration and account for slow responses.

## Automated coverage

`test/github-issues.test.mjs` runs the entire failure lab as a child process and requires its internal assertions to pass. Lower-level tests in `test/ledger.test.mjs` separately cover atomic concurrency, explicit unknown outcomes, expired orphan claims, cached results, commit acknowledgement loss, and SQLite persistence across a ledger server restart.
