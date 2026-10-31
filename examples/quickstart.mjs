import {
  EffectUncertainError,
  EffectUnknownError,
  createLedger,
} from '../src/index.mjs';

const ledger = createLedger({ storage: process.env.MOLA_LEDGER_STORAGE });
const runId = process.env.MOLA_LEDGER_DEMO_ID || new Date().toISOString().replace(/[:.]/g, '-');
let providerWrites = 0;

try {
  const operation = {
    id: `quickstart-success-${runId}`,
    namespace: 'quickstart',
    action: 'ticket.create',
    input: { customerId: 'customer-42', subject: 'Demo request' },
    metadata: { agent: 'offline-demo' },
    run: async ({ idempotencyKey }) => {
      providerWrites += 1;
      return { ticketId: 'ticket-42', idempotencyKey };
    },
  };

  const first = await ledger.execute(operation);
  const repeated = await ledger.execute(operation);
  console.log(`Confirmed ${first.ticketId}; repeated call returned ${repeated.ticketId}.`);
  console.log(`Provider callback executions: ${providerWrites} (expected 1).`);

  const uncertain = {
    id: `quickstart-unknown-${runId}`,
    namespace: 'quickstart',
    action: 'refund.create',
    input: { orderId: 'order-99', amount: 2500 },
    run: async () => {
      throw new Error('Simulated response loss after the provider may have accepted the action');
    },
  };

  try {
    await ledger.execute(uncertain);
  } catch (error) {
    if (!(error instanceof EffectUncertainError)) throw error;
    console.log('Ambiguous provider response recorded as UNKNOWN.');
  }
  try {
    await ledger.execute(uncertain);
  } catch (error) {
    if (!(error instanceof EffectUnknownError)) throw error;
    console.log('Repeated UNKNOWN action blocked; callback was not replayed.');
  }

  console.log(`Ledger: ${ledger.storagePath}`);
  console.log('Open Studio with: npx mola-ledger studio');
} finally {
  await ledger.close();
}
