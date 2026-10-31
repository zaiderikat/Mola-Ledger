# Ledger Studio

Ledger Studio is the bundled local monitoring and investigation interface. It reads the same SQLite file as the SDK and is never in the provider execution path.

## Start it

From an application that uses the default storage path:

```bash
npx mola-ledger studio
```

For an explicit path or port:

```bash
npx mola-ledger studio --storage ./data/agent-actions.sqlite --port 4317
```

The equivalent environment variables are `MOLA_LEDGER_STORAGE` and `MOLA_LEDGER_STUDIO_PORT`. The CLI prints the absolute database path and dashboard address. It binds to `127.0.0.1` and rejects non-loopback binding.

The source repository also provides `npm run studio`.

## Screens

**Overview** shows total attempts, unique operations, successful, suppressed, unknown, and in-progress counts; a 24-hour attempt trend; recent durable events; and the current investigation queue.

**Action Explorer** provides paginated operations with search, action, status, and time filters. It never loads the complete history into the browser.

**Operation Details** shows identity, state, sanitized metadata, attempt and suppression counts, diagnostic reason, provider reference, a structural result summary, timestamps, and the ordered event timeline. Studio does not return the raw result value to the browser.

**Investigation** lists `UNKNOWN` operations and their diagnostic events. Studio is read-only: it does not expose a retry or unauthenticated reconciliation mutation. Use the SDK's `reconcile()` method after your application positively verifies the provider outcome.

## Freshness

The interface polls local reporting endpoints every four seconds and also supports manual refresh. New application writes appear without restarting Studio. Closing or restarting Studio does not affect the ledger or erase data.

## Security boundary

Studio is for local development and single-host investigation. It:

- serves only loopback addresses;
- validates the browser `Host` header;
- allows only `GET` and `HEAD`;
- sends a restrictive Content Security Policy and frame protections;
- enables no permissive CORS;
- exposes safe result shape summaries rather than raw results;
- provides no state-changing route.

Do not reverse-proxy Studio to the Internet. It has no remote authentication, roles, or tenant isolation.

Operation IDs, action names, sanitized metadata, reasons, and provider references can still be sensitive. Protect the machine and SQLite file, and do not put credentials or personal data in ledger fields.

## Empty and invalid ledgers

Starting Studio against a new path creates an empty ledger and shows zero metrics. A parent directory is created automatically when permitted. Invalid, inaccessible, or unsupported storage paths fail at startup with an explicit storage initialization error.
