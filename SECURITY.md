# Security and safety

**Do not use this package as the sole safety mechanism for financial transactions, critical infrastructure, or regulated production actions.**

## Reliability boundary

- Mola Ledger does not guarantee exactly-once external effects.
- Only provider calls routed through `ledger.execute()` are protected.
- If a callback may have succeeded, the ledger blocks replay at `UNKNOWN`; it does not infer failure or retry automatically.
- Reconcile only from affirmative provider evidence. A missing record or `404` may reflect eventual consistency, incomplete search, or lost access.
- Stable business-operation IDs must come from trusted application logic. A model-generated fresh ID on every invocation defeats suppression.
- An expired claim becomes `UNKNOWN`. The original token holder can still report late success if reconciliation has not already changed the outcome.

## Stored data

SQLite stores operation IDs, action names, SHA-256 input fingerprints, sanitized optional metadata, provider references, result JSON, reasons, attempts, and events. Result values are not automatically redacted. Keep credentials, authentication headers, cookies, sensitive personal data, and secrets out of every ledger field.

Metadata recursively redacts keys that look like authorization, cookie, credential, password, secret, token, or API-key fields and limits size/depth. This is defense in depth, not a data-loss-prevention guarantee.

Protect the database and backups with filesystem permissions and host security appropriate to the underlying application data. The product does not provide encryption-at-rest key management, retention policy, or backup automation.

## Embedded deployment

Embedded mode targets trusted Node.js runtimes on a persistent local filesystem. Do not bundle the ledger into an untrusted browser or mobile client. Do not use SQLite over NFS or claim cross-host/serverless coordination from separate local files.

Application and provider credentials remain in the host application. The ledger never needs a Mola Ledger API key in embedded mode.

## Studio

Studio binds to `127.0.0.1`, validates local Host headers, serves a restrictive Content Security Policy, supports only `GET`/`HEAD`, and exposes no retry or reconciliation mutation. Its operation details return a structural result summary rather than raw result JSON.

Do not expose Studio through a public reverse proxy. It has no accounts, remote authentication, roles, tenant isolation, or TLS. Local operation metadata and provider references may still be sensitive.

## Optional HTTP backend

The legacy-compatible service has one shared bearer token, no built-in TLS, no granular roles, no tenant isolation, and no rate limiting. It binds to localhost by default. Do not expose it directly to the public Internet. If remote access is unavoidable, use a hardened authenticated TLS proxy, source-network restrictions, secret rotation, and careful log filtering.

## Provider adapters

Keep provider tokens in environment variables or a secret manager. The GitHub adapter sends its token only to the configured API URL and stores only the projected issue result plus an idempotency marker. Restrict credentials to a disposable repository during evaluation and grant the minimum required permissions.

## Reporting vulnerabilities

Report security issues privately to the repository owner. Do not publish exploit details or credentials in an issue tracker.
