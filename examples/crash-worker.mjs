import { EffectLedger } from '../src/index.mjs';

const mode = process.env.MOLA_LEDGER_CRASH_MODE;
const providerUrl = process.env.MOLA_LEDGER_PROVIDER_URL;

async function providerCreate(body) {
  const response = await fetch(`${providerUrl}/actions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Demo provider returned ${response.status}`);
  return response.json();
}

if (mode === 'plain') {
  await providerCreate({ businessKey: 'crash-unprotected', kind: 'ticket' });
  process.exit(86);
}

if (mode === 'ledger') {
  const ledger = new EffectLedger({
    url: process.env.MOLA_LEDGER_URL,
    apiKey: process.env.MOLA_LEDGER_API_KEY,
  });
  await ledger.execute({
    namespace: 'failure-demo',
    operationId: 'crash-protected',
    action: 'ticket.create',
    input: { scenario: 'crash' },
    perform: async ({ idempotencyKey }) => {
      await providerCreate({ businessKey: idempotencyKey, kind: 'ticket' });
      // Deliberately terminate after the provider has replied but before execute()
      // can durably report SUCCEEDED to the ledger.
      process.exit(86);
    },
  });
}

throw new Error(`Unknown crash-worker mode: ${mode}`);
