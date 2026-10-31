import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { effectIdempotencyKey } from '../src/index.mjs';

const STATUSES = Object.freeze({
  IN_PROGRESS: 'IN_PROGRESS',
  SUCCEEDED: 'SUCCEEDED',
  UNKNOWN: 'UNKNOWN',
});

const maxLength = (s, n) => typeof s === 'string' && s.length > 0 && s.length <= n;

const SENSITIVE_METADATA_KEY = /authorization|cookie|credential|password|secret|token|api[-_]?key/i;

function sanitizeMetadata(value, depth = 0) {
  if (depth > 4) return '[maximum depth]';
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : '[non-finite number]';
  if (Array.isArray(value)) return value.slice(0, 50).map(item => sanitizeMetadata(item, depth + 1));
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, item]) => [
      key,
      SENSITIVE_METADATA_KEY.test(key) ? '[redacted]' : sanitizeMetadata(item, depth + 1),
    ]));
  }
  return '[unsupported value]';
}

export class ValidationError extends Error {
  constructor(message, code = 'INVALID_INPUT') {
    super(message);
    this.code = code;
    this.statusCode = 400;
  }
}

export class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.code = 'OPERATION_CONFLICT';
    this.statusCode = 409;
  }
}

/**
 * Single-host SQLite implementation. It intentionally NEVER automatically retries external calls.
 * Claims are atomic and durable. A crashed/expired claim becomes UNKNOWN, not retryable.
 */
export class LedgerStore {
  constructor({ filename = './data/effects.sqlite', inFlightTimeoutMs = 60_000, now = () => Date.now() } = {}) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    if (!Number.isInteger(inFlightTimeoutMs) || inFlightTimeoutMs < 100) {
      throw new Error('inFlightTimeoutMs must be an integer >= 100');
    }
    this.now = now;
    this.inFlightTimeoutMs = inFlightTimeoutMs;
    this.db = new DatabaseSync(filename, { timeout: 5000 });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS effects (
        namespace TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        action TEXT NOT NULL,
        input_sha256 TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('IN_PROGRESS','SUCCEEDED','UNKNOWN')),
        claim_token TEXT NOT NULL,
        result_json TEXT,
        reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(namespace, operation_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS effect_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        namespace TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        event TEXT NOT NULL,
        detail TEXT,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_effects_status ON effects(status, updated_at);
      CREATE TABLE IF NOT EXISTS effect_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        namespace TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        action TEXT NOT NULL,
        input_sha256 TEXT NOT NULL,
        decision TEXT NOT NULL,
        metadata_json TEXT,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_attempts_operation
        ON effect_attempts(namespace, operation_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_attempts_created
        ON effect_attempts(created_at);
      CREATE TABLE IF NOT EXISTS ledger_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
    `);
    this.ensureColumn('effects', 'metadata_json', 'TEXT');
    this.ensureColumn('effects', 'execution_started_at', 'INTEGER');
    this.ensureColumn('effects', 'succeeded_at', 'INTEGER');
    this.ensureColumn('effects', 'unknown_at', 'INTEGER');
    this.ensureColumn('effects', 'reconciled_at', 'INTEGER');
    this.ensureColumn('effects', 'provider_reference', 'TEXT');
    this.db.prepare(`INSERT INTO ledger_meta(key, value) VALUES('instrumentation_started_at', ?)
      ON CONFLICT(key) DO NOTHING`).run(new Date(this.now()).toISOString());
    this.db.exec('PRAGMA user_version = 2;');
    this.sql = {
      insert: this.db.prepare(`INSERT INTO effects
        (namespace, operation_id, action, input_sha256, status, claim_token, metadata_json, created_at, updated_at)
        VALUES(?, ?, ?, ?, 'IN_PROGRESS', ?, ?, ?, ?)
        ON CONFLICT(namespace, operation_id) DO NOTHING`),
      get: this.db.prepare('SELECT * FROM effects WHERE namespace = ? AND operation_id = ?'),
      event: this.db.prepare(`INSERT INTO effect_events(namespace, operation_id, event, detail, created_at)
        VALUES(?, ?, ?, ?, ?)`),
      attempt: this.db.prepare(`INSERT INTO effect_attempts
        (namespace, operation_id, action, input_sha256, decision, metadata_json, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?)`),
      expire: this.db.prepare(`UPDATE effects SET status = 'UNKNOWN', reason = 'Execution exceeded timeout; outcome not established',
        unknown_at = COALESCE(unknown_at, ?), updated_at = ?
        WHERE namespace = ? AND operation_id = ? AND status = 'IN_PROGRESS' AND updated_at <= ?`),
      executionStarted: this.db.prepare(`UPDATE effects SET execution_started_at = COALESCE(execution_started_at, ?), updated_at = ?
        WHERE namespace = ? AND operation_id = ? AND claim_token = ? AND status = 'IN_PROGRESS'`),
      success: this.db.prepare(`UPDATE effects SET status = 'SUCCEEDED', result_json = ?, reason = NULL,
        succeeded_at = ?, provider_reference = COALESCE(?, provider_reference), updated_at = ?
        WHERE namespace = ? AND operation_id = ? AND claim_token = ? AND status IN ('IN_PROGRESS','UNKNOWN')`),
      unknown: this.db.prepare(`UPDATE effects SET status = 'UNKNOWN', reason = ?, unknown_at = ?, updated_at = ?
        WHERE namespace = ? AND operation_id = ? AND claim_token = ? AND status = 'IN_PROGRESS'`),
      reconcile: this.db.prepare(`UPDATE effects SET status = 'SUCCEEDED', result_json = ?, reason = NULL,
        reconciled_at = ?, provider_reference = ?, updated_at = ?
        WHERE namespace = ? AND operation_id = ? AND status = 'UNKNOWN'`),
      history: this.db.prepare('SELECT event, detail, created_at FROM effect_events WHERE namespace = ? AND operation_id = ? ORDER BY id ASC'),
      listStale: this.db.prepare(`SELECT operation_id FROM effects WHERE namespace = ? AND status = 'IN_PROGRESS' AND updated_at <= ? LIMIT ?`),
      listUnknown: this.db.prepare(`SELECT * FROM effects WHERE namespace = ? AND status = 'UNKNOWN' ORDER BY updated_at ASC LIMIT ?`),
      attemptCounts: this.db.prepare(`SELECT
        COUNT(*) AS attempt_count,
        SUM(CASE WHEN decision = 'EXECUTE' THEN 1 ELSE 0 END) AS execution_attempt_count,
        SUM(CASE WHEN decision IN ('CACHED_SUCCESS','IN_PROGRESS','UNKNOWN') THEN 1 ELSE 0 END) AS suppressed_attempt_count,
        SUM(CASE WHEN decision = 'INPUT_CONFLICT' THEN 1 ELSE 0 END) AS conflict_count
        FROM effect_attempts WHERE namespace = ? AND operation_id = ?`),
      instrumentationSince: this.db.prepare(`SELECT value FROM ledger_meta WHERE key = 'instrumentation_started_at'`),
    };
  }

  ensureColumn(table, column, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some(existing => existing.name === column)) {
      try {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      } catch (error) {
        // Another process may have completed the same idempotent migration
        // between PRAGMA table_info and ALTER TABLE.
        if (!String(error?.message).includes(`duplicate column name: ${column}`)) throw error;
      }
    }
  }

  withTransaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = work();
      this.db.exec('COMMIT');
      return value;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  validateIdentity({ namespace, operationId }) {
    if (!maxLength(namespace, 80) || !/^[A-Za-z0-9_.-]+$/.test(namespace)) {
      throw new ValidationError('namespace must be 1–80 characters: A–Z a–z 0–9 _ . -');
    }
    if (!maxLength(operationId, 200)) {
      throw new ValidationError('operationId must be a non-empty string <= 200 characters');
    }
  }

  appendEvent(namespace, operationId, event, detail = null) {
    this.sql.event.run(namespace, operationId, event, detail, this.now());
  }

  appendAttempt({ namespace, operationId, action, inputHash, decision, metadataJson }) {
    this.sql.attempt.run(namespace, operationId, action, inputHash, decision, metadataJson, this.now());
  }

  project(row) {
    if (!row) return null;
    const counts = this.sql.attemptCounts.get(row.namespace, row.operation_id);
    return {
      namespace: row.namespace,
      operationId: row.operation_id,
      action: row.action,
      status: row.status,
      inputHash: row.input_sha256,
      metadata: row.metadata_json === null ? null : JSON.parse(row.metadata_json),
      result: row.result_json === null ? null : JSON.parse(row.result_json),
      reason: row.reason,
      providerReference: row.provider_reference,
      attemptCount: Number(counts.attempt_count),
      executionAttemptCount: Number(counts.execution_attempt_count || 0),
      suppressedAttemptCount: Number(counts.suppressed_attempt_count || 0),
      conflictCount: Number(counts.conflict_count || 0),
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
      executionStartedAt: row.execution_started_at === null ? null : new Date(row.execution_started_at).toISOString(),
      succeededAt: row.succeeded_at === null ? null : new Date(row.succeeded_at).toISOString(),
      unknownAt: row.unknown_at === null ? null : new Date(row.unknown_at).toISOString(),
      reconciledAt: row.reconciled_at === null ? null : new Date(row.reconciled_at).toISOString(),
    };
  }

  refreshStale(namespace, operationId) {
    const cutoff = this.now() - this.inFlightTimeoutMs;
    const at = this.now();
    const changed = this.sql.expire.run(at, at, namespace, operationId, cutoff).changes;
    if (changed) this.appendEvent(namespace, operationId, 'CLAIM_EXPIRED_TO_UNKNOWN');
  }

  claim({ namespace, operationId, action, inputHash, metadata }) {
    this.validateIdentity({ namespace, operationId });
    if (!maxLength(action, 120)) throw new ValidationError('action must be a non-empty string <= 120 characters');
    if (typeof inputHash !== 'string' || !/^[a-f0-9]{64}$/.test(inputHash)) {
      throw new ValidationError('inputHash must be a SHA-256 hex digest');
    }
    const cleanMetadata = metadata === undefined ? null : sanitizeMetadata(metadata);
    const metadataJson = cleanMetadata === null ? null : JSON.stringify(cleanMetadata);
    if (metadataJson !== null && Buffer.byteLength(metadataJson) > 8192) {
      throw new ValidationError('metadata must be <= 8 KiB after sanitization');
    }
    const outcome = this.withTransaction(() => {
    const token = randomUUID();
    const at = this.now();
    const inserted = this.sql.insert.run(namespace, operationId, action, inputHash, token, metadataJson, at, at).changes === 1;
    if (inserted) {
      this.appendAttempt({ namespace, operationId, action, inputHash, decision: 'EXECUTE', metadataJson });
      this.appendEvent(namespace, operationId, 'CLAIMED');
      return { decision: 'EXECUTE', token, idempotencyKey: this.idempotencyKey(namespace, operationId) };
    }
    const existing = this.sql.get.get(namespace, operationId);
    if (existing.input_sha256 !== inputHash || existing.action !== action) {
      this.appendAttempt({ namespace, operationId, action, inputHash, decision: 'INPUT_CONFLICT', metadataJson });
      this.appendEvent(namespace, operationId, 'ATTEMPT_INPUT_CONFLICT');
      return { conflict: true };
    }
    this.refreshStale(namespace, operationId);
    const current = this.project(this.sql.get.get(namespace, operationId));
    const attemptDecision = current.status === 'SUCCEEDED' ? 'CACHED_SUCCESS' : current.status;
    this.appendAttempt({ namespace, operationId, action, inputHash, decision: attemptDecision, metadataJson });
    const event = current.status === 'SUCCEEDED'
      ? 'ATTEMPT_RETURNED_CACHED_SUCCESS'
      : current.status === 'IN_PROGRESS'
        ? 'ATTEMPT_SUPPRESSED_IN_PROGRESS'
        : 'ATTEMPT_BLOCKED_UNKNOWN';
    this.appendEvent(namespace, operationId, event);
    return { decision: current.status, effect: this.project(this.sql.get.get(namespace, operationId)) };
    });
    if (outcome.conflict) {
      throw new ConflictError('This operation ID is already bound to a different action or input');
    }
    return outcome;
  }

  idempotencyKey(namespace, operationId) {
    return effectIdempotencyKey(namespace, operationId);
  }

  get({ namespace, operationId, includeHistory = false }) {
    this.validateIdentity({ namespace, operationId });
    return this.withTransaction(() => {
    this.refreshStale(namespace, operationId);
    const effect = this.project(this.sql.get.get(namespace, operationId));
    if (!effect) return null;
    if (includeHistory) {
      effect.events = this.sql.history.all(namespace, operationId).map((r) => ({
        event: r.event,
        detail: r.detail,
        timestamp: new Date(r.created_at).toISOString(),
      }));
    }
    return effect;
    });
  }

  listUnknown({ namespace, limit = 50 }) {
    if (!maxLength(namespace, 80) || !/^[A-Za-z0-9_.-]+$/.test(namespace)) throw new ValidationError('namespace is invalid');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ValidationError('limit must be 1–100');
    return this.withTransaction(() => {
      // Lazily expire stale claims so operators can discover them even without knowing IDs.
      for (const row of this.sql.listStale.all(namespace, this.now() - this.inFlightTimeoutMs, 100)) {
        this.refreshStale(namespace, row.operation_id);
      }
      return this.sql.listUnknown.all(namespace, limit).map(row => this.project(row));
    });
  }

  refreshStaleForReporting(namespace) {
    const whereNamespace = namespace ? 'AND namespace = ?' : '';
    const statement = this.db.prepare(`SELECT namespace, operation_id FROM effects
      WHERE status = 'IN_PROGRESS' AND updated_at <= ? ${whereNamespace} LIMIT 1000`);
    const params = [this.now() - this.inFlightTimeoutMs, ...(namespace ? [namespace] : [])];
    for (const row of statement.all(...params)) this.refreshStale(row.namespace, row.operation_id);
  }

  reportingFilters({ namespace, from, to } = {}, alias = '') {
    const prefix = alias ? `${alias}.` : '';
    const clauses = [];
    const params = [];
    if (namespace !== undefined) {
      if (!maxLength(namespace, 80) || !/^[A-Za-z0-9_.-]+$/.test(namespace)) {
        throw new ValidationError('namespace is invalid');
      }
      clauses.push(`${prefix}namespace = ?`);
      params.push(namespace);
    }
    for (const [name, value, operator] of [['from', from, '>='], ['to', to, '<=']]) {
      if (value !== undefined) {
        const timestamp = typeof value === 'number' ? value : Date.parse(value);
        if (!Number.isFinite(timestamp)) throw new ValidationError(`${name} must be a timestamp or ISO date`);
        clauses.push(`${prefix}created_at ${operator} ?`);
        params.push(timestamp);
      }
    }
    return { sql: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', params };
  }

  getMetrics({ namespace, from, to } = {}) {
    return this.withTransaction(() => {
      this.refreshStaleForReporting(namespace);
      const effectFilter = this.reportingFilters({ namespace, from, to });
      const attemptFilter = this.reportingFilters({ namespace, from, to });
      const effects = this.db.prepare(`SELECT
        COUNT(*) AS unique_operations,
        SUM(CASE WHEN status = 'SUCCEEDED' THEN 1 ELSE 0 END) AS succeeded,
        SUM(CASE WHEN status = 'IN_PROGRESS' THEN 1 ELSE 0 END) AS in_progress,
        SUM(CASE WHEN status = 'UNKNOWN' THEN 1 ELSE 0 END) AS unknown_count,
        SUM(CASE WHEN reconciled_at IS NOT NULL THEN 1 ELSE 0 END) AS reconciled
        FROM effects${effectFilter.sql}`).get(...effectFilter.params);
      const attempts = this.db.prepare(`SELECT
        COUNT(*) AS total_attempts,
        SUM(CASE WHEN decision IN ('CACHED_SUCCESS','IN_PROGRESS','UNKNOWN') THEN 1 ELSE 0 END) AS suppressed,
        SUM(CASE WHEN decision = 'INPUT_CONFLICT' THEN 1 ELSE 0 END) AS input_conflicts
        FROM effect_attempts${attemptFilter.sql}`).get(...attemptFilter.params);
      return {
        totalAttempts: Number(attempts.total_attempts),
        uniqueOperations: Number(effects.unique_operations),
        succeeded: Number(effects.succeeded || 0),
        inProgress: Number(effects.in_progress || 0),
        unknown: Number(effects.unknown_count || 0),
        repeatedAttemptsSuppressed: Number(attempts.suppressed || 0),
        inputConflicts: Number(attempts.input_conflicts || 0),
        reconciledOperations: Number(effects.reconciled || 0),
        instrumentationSince: this.sql.instrumentationSince.get()?.value ?? null,
      };
    });
  }

  listOperations({ namespace, query, action, status, from, to, limit = 50, offset = 0 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ValidationError('limit must be 1–100');
    if (!Number.isInteger(offset) || offset < 0) throw new ValidationError('offset must be a non-negative integer');
    if (status !== undefined && !Object.values(STATUSES).includes(status)) throw new ValidationError('status is invalid');
    if (action !== undefined && !maxLength(action, 120)) throw new ValidationError('action is invalid');
    if (query !== undefined && (typeof query !== 'string' || query.length > 200)) throw new ValidationError('query is invalid');
    return this.withTransaction(() => {
      this.refreshStaleForReporting(namespace);
      const filters = this.reportingFilters({ namespace, from, to }, 'e');
      const clauses = filters.sql ? [filters.sql.slice(7)] : [];
      const params = [...filters.params];
      if (query) {
        clauses.push('(e.operation_id LIKE ? ESCAPE \'\\\' OR e.action LIKE ? ESCAPE \'\\\')');
        const escaped = query.replace(/[\\%_]/g, match => `\\${match}`);
        params.push(`%${escaped}%`, `%${escaped}%`);
      }
      if (action) { clauses.push('e.action = ?'); params.push(action); }
      if (status) { clauses.push('e.status = ?'); params.push(status); }
      const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
      const total = this.db.prepare(`SELECT COUNT(*) AS count FROM effects e${where}`).get(...params).count;
      const rows = this.db.prepare(`SELECT e.* FROM effects e${where}
        ORDER BY e.updated_at DESC, e.operation_id ASC LIMIT ? OFFSET ?`).all(...params, limit, offset);
      return {
        operations: rows.map(row => this.project(row)),
        total: Number(total),
        limit,
        offset,
      };
    });
  }

  recentActivity({ namespace, limit = 25 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ValidationError('limit must be 1–100');
    const filter = namespace === undefined ? '' : 'WHERE ev.namespace = ?';
    if (namespace !== undefined && (!maxLength(namespace, 80) || !/^[A-Za-z0-9_.-]+$/.test(namespace))) {
      throw new ValidationError('namespace is invalid');
    }
    return this.db.prepare(`SELECT ev.namespace, ev.operation_id, ev.event, ev.detail, ev.created_at,
      e.action, e.status FROM effect_events ev
      JOIN effects e ON e.namespace = ev.namespace AND e.operation_id = ev.operation_id
      ${filter} ORDER BY ev.id DESC LIMIT ?`).all(...(namespace ? [namespace] : []), limit).map(row => ({
      namespace: row.namespace,
      operationId: row.operation_id,
      action: row.action,
      status: row.status,
      event: row.event,
      detail: row.detail,
      timestamp: new Date(row.created_at).toISOString(),
    }));
  }

  activitySeries({ namespace, hours = 24 } = {}) {
    if (!Number.isInteger(hours) || hours < 1 || hours > 24 * 90) throw new ValidationError('hours must be 1–2160');
    if (namespace !== undefined && (!maxLength(namespace, 80) || !/^[A-Za-z0-9_.-]+$/.test(namespace))) {
      throw new ValidationError('namespace is invalid');
    }
    const filter = namespace === undefined ? '' : 'AND namespace = ?';
    return this.db.prepare(`SELECT
      strftime('%Y-%m-%dT%H:00:00Z', created_at / 1000, 'unixepoch') AS bucket,
      COUNT(*) AS attempts,
      SUM(CASE WHEN decision IN ('CACHED_SUCCESS','IN_PROGRESS','UNKNOWN') THEN 1 ELSE 0 END) AS suppressed,
      SUM(CASE WHEN decision = 'INPUT_CONFLICT' THEN 1 ELSE 0 END) AS conflicts
      FROM effect_attempts WHERE created_at >= ? ${filter}
      GROUP BY bucket ORDER BY bucket ASC`).all(
        this.now() - hours * 60 * 60 * 1000,
        ...(namespace ? [namespace] : []),
      ).map(row => ({
        bucket: row.bucket,
        attempts: Number(row.attempts),
        suppressed: Number(row.suppressed || 0),
        conflicts: Number(row.conflicts || 0),
      }));
  }

  executionStarted({ namespace, operationId, token }) {
    this.validateIdentity({ namespace, operationId });
    if (!maxLength(token, 100)) throw new ValidationError('token is required');
    this.withTransaction(() => {
      const at = this.now();
      const changed = this.sql.executionStarted.run(at, at, namespace, operationId, token).changes;
      if (!changed) throw new ConflictError('Cannot start effect: invalid claim token or status');
      this.appendEvent(namespace, operationId, 'EXECUTION_STARTED');
    });
    return this.get({ namespace, operationId });
  }

  success({ namespace, operationId, token, result, providerReference = null }) {
    this.validateIdentity({ namespace, operationId });
    if (!maxLength(token, 100)) throw new ValidationError('token is required');
    const resultJson = JSON.stringify(result);
    if (resultJson === undefined || Buffer.byteLength(resultJson) > 65536) {
      throw new ValidationError('result must be JSON-serializable and <= 64 KiB');
    }
    if (providerReference !== null && !maxLength(providerReference, 500)) {
      throw new ValidationError('providerReference must be a non-empty string <= 500 characters');
    }
    this.withTransaction(() => {
      const at = this.now();
      const changed = this.sql.success.run(resultJson, at, providerReference, at, namespace, operationId, token).changes;
      if (!changed) throw new ConflictError('Cannot complete effect: invalid claim token or terminal status');
      this.appendEvent(namespace, operationId, 'SUCCEEDED');
    });
    return this.get({ namespace, operationId });
  }

  unknown({ namespace, operationId, token, reason }) {
    this.validateIdentity({ namespace, operationId });
    if (!maxLength(token, 100)) throw new ValidationError('token is required');
    const note = typeof reason === 'string' ? reason.substring(0, 500) : 'Executor raised an exception; outcome uncertain';
    this.withTransaction(() => {
      const at = this.now();
      const changed = this.sql.unknown.run(note, at, at, namespace, operationId, token).changes;
      if (!changed) throw new ConflictError('Cannot mark UNKNOWN: invalid claim token or status');
      this.appendEvent(namespace, operationId, 'UNKNOWN', note);
    });
    return this.get({ namespace, operationId });
  }

  /** Only use after provider confirms the original operation succeeded. */
  reconcileSuccess({ namespace, operationId, result, evidence }) {
    this.validateIdentity({ namespace, operationId });
    if (!maxLength(evidence, 500)) throw new ValidationError('evidence (reference/lookup details) is required');
    const resultJson = JSON.stringify(result);
    if (resultJson === undefined || Buffer.byteLength(resultJson) > 65536) {
      throw new ValidationError('result must be JSON-serializable and <= 64 KiB');
    }
    this.withTransaction(() => {
      this.refreshStale(namespace, operationId);
      const at = this.now();
      const changed = this.sql.reconcile.run(resultJson, at, evidence, at, namespace, operationId).changes;
      if (!changed) throw new ConflictError('Only UNKNOWN effects can be reconciled');
      this.appendEvent(namespace, operationId, 'RECONCILED_SUCCEEDED', evidence);
    });
    return this.get({ namespace, operationId });
  }

  close() { this.db.close(); }
}

export { STATUSES };
