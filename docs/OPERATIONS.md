# Operations and deployment

## Embedded mode

Embedded mode is the default. `createLedger()` creates `./.mola-ledger/ledger.sqlite` under the application's current working directory. Set an explicit absolute or application-controlled path in services whose working directory can change.

```javascript
const ledger = createLedger({
  storage: '/var/lib/my-agent/effects.sqlite',
  inFlightTimeoutMs: 120_000,
});
```

Choose an in-flight timeout longer than the provider's expected maximum latency. An expired claim becomes `UNKNOWN`; expiry never launches a retry.

SQLite uses WAL and a five-second busy timeout. Multiple local Node.js processes can coordinate through one file. Do not use NFS, independently copied files, ephemeral serverless filesystems, or separate hosts and claim shared coordination.

Call `await ledger.close()` during an orderly process shutdown. An application crash does not erase committed records; an orphaned claim eventually becomes `UNKNOWN`.

## Studio

```bash
npx mola-ledger studio --storage /var/lib/my-agent/effects.sqlite
```

Studio is an optional loopback-only reader. It may start, stop, or restart independently from the application. See [the Studio guide](STUDIO.md).

## Unknown-outcome runbook

1. Inspect `UNKNOWN` records in Studio or with `ledger.listUnknown()`.
2. Identify the exact provider account, action, and stable business operation.
3. Query the provider using its strongest durable identifier or the ledger idempotency key.
4. If and only if the provider positively confirms success, call `reconcile()` with the provider object and evidence.
5. If the lookup is missing, delayed, inconsistent, incomplete, or inaccessible, leave the record `UNKNOWN` and escalate it for review.

The ledger has no “mark failed and retry” transition. That is intentional: many negative provider lookups cannot prove the external action did not happen.

## Durability and backups

Before consequential evaluation:

- place the database on durable local storage;
- monitor disk space and filesystem health;
- use a SQLite-aware online backup or stop all writers before copying the database and WAL files;
- test restore into an isolated process;
- restrict access to the database and backups because results and diagnostics may be sensitive;
- record the application version used for each backup.

Schema migration is automatic and idempotent. The current store migrates v0.2 databases to schema version 2 without discarding existing effects or events. Back up before upgrading. Reporting attempts that predate instrumentation are not reconstructed; use `instrumentationSince` to interpret metrics.

## Optional HTTP backend

The original service remains available for compatibility and small single-host evaluation:

| Variable | Purpose | Default |
|---|---|---|
| `MOLA_LEDGER_API_KEY` | Required shared bearer secret, minimum 8 characters | none |
| `MOLA_LEDGER_HOST` | Listen address | `127.0.0.1` |
| `MOLA_LEDGER_PORT` | Listen port | `8787` |
| `MOLA_LEDGER_DB_PATH` | SQLite database | `./data/effects.sqlite` |
| `MOLA_LEDGER_IN_FLIGHT_TIMEOUT_MS` | Claim age before uncertainty | `60000` |

```bash
export MOLA_LEDGER_API_KEY="$(openssl rand -hex 32)"
npx mola-ledger server
```

Use `new EffectLedger({ url, apiKey })` in the application. The service and embedded driver share state semantics and reporting, but a process must use one mode for a given ledger. Do not point embedded application writers at the same file while the HTTP service owns it as a deployment pattern.

The HTTP service has one shared bearer token, no TLS, no roles, no tenant isolation, and no rate limiting. Keep it on localhost or a trusted network. If remote access is unavoidable, put a hardened TLS proxy and network policy in front of it, rotate the bearer token, and avoid logging authorization headers.

Docker Compose is preserved for the optional backend:

```bash
export MOLA_LEDGER_API_KEY="$(openssl rand -hex 32)"
docker compose up --build -d
curl http://127.0.0.1:8787/healthz
```

`healthz` proves only that the process answers; it is not a storage write/readiness check. The HTTP backend is not a multi-region, highly available, or enterprise-authenticated product.

## Serverless and multi-host warning

An embedded database on one Lambda/container filesystem does not coordinate another instance. Do not use copied SQLite ledgers as if they were one global claim authority. Use infrastructure designed for shared coordination when multiple independent hosts must share one claim authority.

See [SECURITY.md](../SECURITY.md) for the full safety boundary.
