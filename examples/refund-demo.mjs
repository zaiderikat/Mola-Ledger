import { EffectLedger, EffectUncertainError, EffectUnknownError, effectIdempotencyKey } from '../src/index.mjs';

const ledger = new EffectLedger({
  url: process.env.MOLA_LEDGER_URL || 'http://127.0.0.1:8787',
  apiKey: process.env.MOLA_LEDGER_API_KEY || 'dev-local-only',
});

// Fake external provider. Persisted effect lives in LEDGER, provider here is a demo only.
const provider = {
  refunds: new Map(),
  async refund({ idempotencyKey, paymentId, amount }) {
    if (!this.refunds.has(idempotencyKey)) {
      this.refunds.set(idempotencyKey, { refundId: 'rf-demo-001', paymentId, amount });
    }
    // Simulates an external refund succeeding but its response being lost.
    throw new Error('Simulated network timeout AFTER provider refund succeeded');
  },
  lookupByKey(key) { return this.refunds.get(key); },
};

const operation = {
  namespace: 'shop-demo',
  operationId: 'refund-order-123-v1',
  action: 'payment.refund',
  input: { paymentId: 'pay_123', amount: 500 },
};

async function run() {
  console.log('1. Execute the refund. Provider succeeds; response is lost.');
  try {
    await ledger.execute({ ...operation, perform: ({ idempotencyKey }) => provider.refund({
      idempotencyKey, ...operation.input,
    }) });
  } catch (err) {
    if (!(err instanceof EffectUncertainError)) throw err;
    console.log('   Safe result:', err.code);
  }

  console.log('2. Try the SAME operation again. It must NOT call the provider.');
  try {
    await ledger.execute({ ...operation, perform: async () => { throw new Error('DUPLICATE: should never run'); } });
  } catch (err) {
    if (!(err instanceof EffectUnknownError)) throw err;
    console.log('   Blocked:', err.code);
  }

  console.log('3. Reconcile by querying the actual provider.');
  const outcome = await ledger.reconcile({
    namespace: operation.namespace,
    operationId: operation.operationId,
    verify: async ({ namespace, operationId }) => {
      const key = effectIdempotencyKey(namespace, operationId);
      const refund = provider.lookupByKey(key);
      return refund
        ? { status: 'succeeded', evidence: `Provider refund ID ${refund.refundId}`, result: refund }
        : { status: 'unknown' };
    },
  });
  console.log('   Status:', outcome.status);

  console.log('4. Invoke same action again — cached provider result, no second refund.');
  const result = await ledger.execute({ ...operation, perform: async () => { throw new Error('should never execute'); } });
  console.log('   Result:', JSON.stringify(result));
  console.log('   Provider refunds count:', provider.refunds.size);
  console.log('   Audit events:', (await ledger.get({ namespace: operation.namespace, operationId: operation.operationId, history: true })).events.map(e => e.event).join(' → '));
}

run().catch(err => { console.error(err); process.exitCode = 1; });
