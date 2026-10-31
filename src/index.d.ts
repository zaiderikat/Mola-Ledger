/** Early-access Node.js SDK. Not an exactly-once guarantee. */
export type EffectStatus = 'IN_PROGRESS' | 'SUCCEEDED' | 'UNKNOWN';
export interface EffectRecord<T = unknown> {
  namespace: string;
  operationId: string;
  action: string;
  status: EffectStatus;
  inputHash: string;
  metadata: Record<string, unknown> | null;
  result: T | null;
  reason: string | null;
  providerReference: string | null;
  attemptCount: number;
  executionAttemptCount: number;
  suppressedAttemptCount: number;
  conflictCount: number;
  createdAt: string;
  updatedAt: string;
  executionStartedAt: string | null;
  succeededAt: string | null;
  unknownAt: string | null;
  reconciledAt: string | null;
  events?: { event: string; detail: string | null; timestamp: string }[];
}
export class EffectLedgerError extends Error {
  code: string;
  status?: number;
  effect?: EffectRecord;
}
export class EffectInProgressError extends EffectLedgerError {}
export class EffectUnknownError extends EffectLedgerError {}
export class EffectConflictError extends EffectLedgerError {}
export class EffectUncertainError extends EffectLedgerError {}
export interface EffectLedgerOptions {
  url?: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}
interface ExecuteBase<I, O> {
  namespace?: string;
  action: string;
  input: I;
  metadata?: Record<string, unknown>;
  providerReference?: string | ((result: O) => string | null | undefined);
}
type OperationIdentity =
  | { operationId: string; id?: never }
  | { id: string; operationId?: never };
type ExecutionCallback<O> =
  | { perform: (context: { idempotencyKey: string }) => Promise<O> | O; run?: never }
  | { run: (context: { idempotencyKey: string }) => Promise<O> | O; perform?: never };
export type ExecuteOptions<I, O> = ExecuteBase<I, O> & OperationIdentity & ExecutionCallback<O>;
export type VerifyResult<T> =
  | { status: 'succeeded'; evidence: string; result: T }
  | { status: 'unknown' };
export interface LedgerMetrics {
  totalAttempts: number;
  uniqueOperations: number;
  succeeded: number;
  inProgress: number;
  unknown: number;
  repeatedAttemptsSuppressed: number;
  inputConflicts: number;
  reconciledOperations: number;
  instrumentationSince: string | null;
}
export interface OperationPage<T = unknown> {
  operations: EffectRecord<T>[];
  total: number;
  limit: number;
  offset: number;
}
export interface ActivityEvent {
  namespace: string;
  operationId: string;
  action: string;
  status: EffectStatus;
  event: string;
  detail: string | null;
  timestamp: string;
}
export interface ActivityPoint {
  bucket: string;
  attempts: number;
  suppressed: number;
  conflicts: number;
}
export interface ReportingFilter {
  namespace?: string;
  from?: string | number;
  to?: string | number;
}
export interface OperationFilter extends ReportingFilter {
  query?: string;
  action?: string;
  status?: EffectStatus;
  limit?: number;
  offset?: number;
}
export class EffectLedger {
  constructor(options: EffectLedgerOptions);
  execute<I, O>(options: ExecuteOptions<I, O>): Promise<O>;
  get<T = unknown>(options: { namespace?: string; history?: boolean } & OperationIdentity): Promise<EffectRecord<T> | null>;
  listUnknown<T = unknown>(options?: { namespace?: string; limit?: number }): Promise<EffectRecord<T>[]>;
  reconcile<T = unknown>(options: {
    namespace?: string;
    verify: (identity: { namespace: string; operationId: string; action: string }) => Promise<VerifyResult<T>> | VerifyResult<T>;
  } & OperationIdentity): Promise<EffectRecord<T>>;
  getMetrics(options?: ReportingFilter): Promise<LedgerMetrics>;
  listOperations<T = unknown>(options?: OperationFilter): Promise<OperationPage<T>>;
  recentActivity(options?: { namespace?: string; limit?: number }): Promise<ActivityEvent[]>;
  activitySeries(options?: { namespace?: string; hours?: number }): Promise<ActivityPoint[]>;
  close(): Promise<void>;
}
export interface EmbeddedLedgerOptions {
  storage?: string;
  inFlightTimeoutMs?: number;
}
export class EmbeddedLedger {
  constructor(options?: EmbeddedLedgerOptions);
  readonly storagePath: string;
  execute<I, O>(options: ExecuteOptions<I, O>): Promise<O>;
  get<T = unknown>(options: { namespace?: string; history?: boolean } & OperationIdentity): Promise<EffectRecord<T> | null>;
  listUnknown<T = unknown>(options?: { namespace?: string; limit?: number }): Promise<EffectRecord<T>[]>;
  reconcile<T = unknown>(options: {
    namespace?: string;
    verify: (identity: { namespace: string; operationId: string; action: string }) => Promise<VerifyResult<T>> | VerifyResult<T>;
  } & OperationIdentity): Promise<EffectRecord<T>>;
  getMetrics(options?: ReportingFilter): Promise<LedgerMetrics>;
  listOperations<T = unknown>(options?: OperationFilter): Promise<OperationPage<T>>;
  recentActivity(options?: { namespace?: string; limit?: number }): Promise<ActivityEvent[]>;
  activitySeries(options?: { namespace?: string; hours?: number }): Promise<ActivityPoint[]>;
  close(): Promise<void>;
}
export function createLedger(options?: EmbeddedLedgerOptions): EmbeddedLedger;
export function fingerprintInput(input: unknown): string;
export function effectIdempotencyKey(namespace: string, operationId: string): string;
