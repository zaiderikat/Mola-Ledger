import {
  EffectLedgerError,
  EffectInProgressError,
  EffectUnknownError,
  EffectUncertainError,
} from './errors.mjs';
import { fingerprintInput } from './identity.mjs';

/**
 * Transport-independent protection engine.
 *
 * Drivers perform short durable operations. The external callback always runs
 * outside a storage transaction.
 */
export class LedgerEngine {
  constructor({ driver } = {}) {
    if (!driver || typeof driver.claim !== 'function') {
      throw new TypeError('A ledger storage driver is required');
    }
    this.driver = driver;
  }

  async execute(options) {
    const {
      namespace = 'default',
      action,
      input,
      metadata,
    } = options ?? {};
    const operationId = options?.operationId ?? options?.id;
    const perform = options?.perform ?? options?.run;
    if (typeof perform !== 'function') throw new TypeError('perform or run callback is required');

    const inputHash = fingerprintInput(input);
    const claim = await this.driver.claim({ namespace, operationId, action, inputHash, metadata });
    if (claim.decision === 'SUCCEEDED') return claim.effect.result;
    if (claim.decision === 'UNKNOWN') {
      throw new EffectUnknownError('Prior attempt has an unknown outcome. Reconcile before retrying.', {
        code: 'UNKNOWN_OUTCOME', effect: claim.effect,
      });
    }
    if (claim.decision === 'IN_PROGRESS') {
      throw new EffectInProgressError('Another execution is already in progress.', {
        code: 'IN_PROGRESS', effect: claim.effect,
      });
    }
    if (claim.decision !== 'EXECUTE') throw new EffectLedgerError(`Unexpected decision: ${claim.decision}`);

    const identity = { namespace, operationId, token: claim.token };
    try {
      await this.driver.executionStarted(identity);
    } catch (cause) {
      try {
        await this.driver.unknown({
          ...identity,
          reason: 'Execution could not start because durable instrumentation failed',
        });
      } catch {
        // The claim remains durable and will expire to UNKNOWN.
      }
      throw new EffectUncertainError('Action was not started because its execution could not be durably recorded.', {
        code: 'START_UNCERTAIN', cause,
      });
    }
    let result;
    try {
      result = await perform({ idempotencyKey: claim.idempotencyKey });
    } catch (cause) {
      try {
        await this.driver.unknown({
          ...identity,
          reason: 'Executor failed; external effect may have occurred',
        });
      } catch {
        // The durable claim will expire to UNKNOWN rather than authorize replay.
      }
      throw new EffectUncertainError('Action failed or timed out; outcome could not be established. No automatic retry.', {
        code: 'EXECUTION_UNCERTAIN', cause,
      });
    }

    try {
      const providerReference = typeof options.providerReference === 'function'
        ? options.providerReference(result)
        : options.providerReference;
      await this.driver.succeed({ ...identity, result, providerReference });
    } catch (cause) {
      throw new EffectUncertainError('Action returned success, but ledger confirmation failed. Reconcile before retrying.', {
        code: 'COMMIT_UNCERTAIN', cause,
      });
    }
    return result;
  }

  async get({ namespace = 'default', operationId, id, history = false }) {
    return this.driver.get({ namespace, operationId: operationId ?? id, history });
  }

  async listUnknown({ namespace = 'default', limit = 50 } = {}) {
    return this.driver.listUnknown({ namespace, limit });
  }

  async reconcile({ namespace = 'default', operationId, id, verify }) {
    if (typeof verify !== 'function') throw new TypeError('verify callback is required');
    const resolvedId = operationId ?? id;
    const existing = await this.get({ namespace, operationId: resolvedId });
    if (!existing) throw new EffectLedgerError('Effect not found', { code: 'NOT_FOUND' });
    if (existing.status !== 'UNKNOWN') return existing;

    const verified = await verify({ namespace, operationId: resolvedId, action: existing.action });
    if (verified?.status !== 'succeeded') return existing;
    if (typeof verified.evidence !== 'string' || !verified.evidence.trim()) {
      throw new TypeError('Confirmed success must include a verifiable evidence reference');
    }
    return this.driver.reconcileSuccess({
      namespace,
      operationId: resolvedId,
      result: verified.result,
      evidence: verified.evidence,
    });
  }

  async getMetrics(options = {}) {
    if (typeof this.driver.getMetrics !== 'function') {
      throw new EffectLedgerError('This ledger backend does not expose reporting metrics', {
        code: 'REPORTING_UNAVAILABLE',
      });
    }
    return this.driver.getMetrics(options);
  }

  async listOperations(options = {}) {
    if (typeof this.driver.listOperations !== 'function') {
      throw new EffectLedgerError('This ledger backend does not expose operation reporting', {
        code: 'REPORTING_UNAVAILABLE',
      });
    }
    return this.driver.listOperations(options);
  }

  async recentActivity(options = {}) {
    if (typeof this.driver.recentActivity !== 'function') {
      throw new EffectLedgerError('This ledger backend does not expose activity reporting', {
        code: 'REPORTING_UNAVAILABLE',
      });
    }
    return this.driver.recentActivity(options);
  }

  async activitySeries(options = {}) {
    if (typeof this.driver.activitySeries !== 'function') {
      throw new EffectLedgerError('This ledger backend does not expose activity reporting', {
        code: 'REPORTING_UNAVAILABLE',
      });
    }
    return this.driver.activitySeries(options);
  }

  async close() {
    await this.driver.close?.();
  }
}
