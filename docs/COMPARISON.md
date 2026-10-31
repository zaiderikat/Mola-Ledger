# Choosing the right tool

Mola Ledger is a narrow external-effect boundary, not a workflow engine.

| Option | Usually strongest when | What it provides that this package does not | Tradeoff relative to this package |
|---|---|---|---|
| Provider-native idempotency | One provider accepts durable keys and exposes reliable status | Atomic deduplication inside the system performing the write | Prefer it when its retention and semantics cover your retry horizon; the ledger can still preserve cross-restart status |
| Custom database table | Your team owns the application DB and the pattern is simple | Exact fit, local transactions, existing operations stack | You must design claims, fingerprints, expiry, audit history, and reconciliation correctly |
| Restate | Services/agents need durable execution and virtual-object/workflow semantics | Durable handlers, retries, state, timers, broader runtime model | More capable and more architectural commitment |
| Temporal | Complex, long-running, multi-step workflows need durable orchestration | Workflow history/replay, activities, timers, signals, compensation patterns, mature operations | Much broader than guarding a few calls; requires workflow/runtime adoption |
| DBOS | Application code benefits from database-backed durable workflows | Durable execution primitives and workflow recovery integrated with application code | Broader programming model and database/runtime assumptions |
| Mola Ledger | A Node.js app needs a small, framework-neutral guard and local investigation UI around a few consequential external calls | Nothing beyond its documented single-host claim/result/reconciliation record | Embedded integration, but no workflow recovery, safe negative outcome, HA, or managed operations |

## Provider-native idempotency first

If a provider can atomically deduplicate a stable key for longer than your maximum retry window and lets you fetch the original result, use that feature. Pass the ledger-generated key to it if you also need a local durable audit/status record. Do not claim the ledger makes a weak provider guarantee stronger than it is.

## When a custom table is enough

A unique constraint on `(namespace, operation_id)` plus status and result columns can solve much of this problem. This project earns its place only if its packaged state transitions, canonical input binding, SDK errors, audit events, and reconciliation convention remove meaningful repeated engineering and operational mistakes.

## When to choose a workflow platform

Choose Temporal, Restate, DBOS, or another durable-workflow platform when the application needs multi-step recovery, timers, signals, compensation, cross-host coordination, or a broader durable-execution model. Mola Ledger is intentionally limited to guarding and investigating individual external actions.
