import { LedgerEngine } from './engine.mjs';
import { HttpLedgerDriver } from './http-driver.mjs';
import { SqliteLedgerDriver } from './sqlite-driver.mjs';

export {
  EffectLedgerError,
  EffectInProgressError,
  EffectUnknownError,
  EffectConflictError,
  EffectUncertainError,
} from './errors.mjs';
export { fingerprintInput, effectIdempotencyKey } from './identity.mjs';

/**
 * Backwards-compatible HTTP client.
 *
 * Embedded applications should use createLedger(), exported by this package
 * once the embedded driver is initialized.
 */
export class EffectLedger extends LedgerEngine {
  constructor(options = {}) {
    const driver = new HttpLedgerDriver(options);
    super({ driver });
    this.url = driver.url;
    this.apiKey = driver.apiKey;
    this.fetchImpl = driver.fetchImpl;
  }

  request(path, options) {
    return this.driver.request(path, options);
  }
}

export class EmbeddedLedger extends LedgerEngine {
  constructor(options = {}) {
    const driver = new SqliteLedgerDriver(options);
    super({ driver });
    this.storagePath = driver.storagePath;
  }
}

export function createLedger(options = {}) {
  return new EmbeddedLedger(options);
}
