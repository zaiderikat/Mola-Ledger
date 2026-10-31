import { resolve } from 'node:path';
import { LedgerStore } from '../server/storage.mjs';
import {
  EffectConflictError,
  EffectLedgerError,
} from './errors.mjs';

export function resolveStoragePath(storage) {
  if (storage === ':memory:') return storage;
  const selected = storage ?? './.mola-ledger/ledger.sqlite';
  if (typeof selected !== 'string' || !selected.trim()) {
    throw new TypeError('storage must be a non-empty filesystem path');
  }
  return resolve(selected);
}

function translateStorageError(error) {
  if (error instanceof EffectLedgerError) return error;
  if (error?.code === 'OPERATION_CONFLICT') {
    return new EffectConflictError(error.message, {
      code: error.code,
      status: error.statusCode,
      cause: error,
    });
  }
  if (error?.code && error?.statusCode) {
    return new EffectLedgerError(error.message, {
      code: error.code,
      status: error.statusCode,
      cause: error,
    });
  }
  return new EffectLedgerError('Embedded ledger storage operation failed', {
    code: 'STORAGE_ERROR',
    cause: error,
  });
}

export class SqliteLedgerDriver {
  constructor({ storage, inFlightTimeoutMs = 60_000, store } = {}) {
    this.storagePath = store ? (storage ?? ':custom:') : resolveStoragePath(storage);
    try {
      this.store = store ?? new LedgerStore({
        filename: this.storagePath,
        inFlightTimeoutMs,
      });
    } catch (cause) {
      throw new EffectLedgerError(`Cannot initialize embedded ledger storage at ${this.storagePath}`, {
        code: 'STORAGE_INITIALIZATION_FAILED',
        cause,
      });
    }
  }

  call(method, input) {
    try {
      return this.store[method](input);
    } catch (error) {
      throw translateStorageError(error);
    }
  }

  claim(input) { return this.call('claim', input); }
  executionStarted(input) { return this.call('executionStarted', input); }
  succeed(input) { return this.call('success', input); }
  unknown(input) { return this.call('unknown', input); }

  get({ namespace, operationId, history = false }) {
    return this.call('get', { namespace, operationId, includeHistory: history });
  }

  listUnknown(input) { return this.call('listUnknown', input); }
  reconcileSuccess(input) { return this.call('reconcileSuccess', input); }
  getMetrics(input) { return this.call('getMetrics', input); }
  listOperations(input) { return this.call('listOperations', input); }
  recentActivity(input) { return this.call('recentActivity', input); }
  activitySeries(input) { return this.call('activitySeries', input); }

  close() {
    try { this.store.close(); }
    catch (error) { throw translateStorageError(error); }
  }
}
