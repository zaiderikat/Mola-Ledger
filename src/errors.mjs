export class EffectLedgerError extends Error {
  constructor(message, { code = 'LEDGER_ERROR', status, effect, cause } = {}) {
    super(message, { cause });
    this.name = this.constructor.name;
    this.code = code;
    this.status = status;
    this.effect = effect;
  }
}

export class EffectInProgressError extends EffectLedgerError {}
export class EffectUnknownError extends EffectLedgerError {}
export class EffectConflictError extends EffectLedgerError {}
export class EffectUncertainError extends EffectLedgerError {}
