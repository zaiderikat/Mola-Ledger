import { appendFileSync } from 'node:fs';
import { createLedger, EffectInProgressError } from '../../src/index.mjs';

const [storage, executions] = process.argv.slice(2);
const ledger = createLedger({ storage, inFlightTimeoutMs: 5_000 });

try {
  const result = await ledger.execute({
    id: 'cross-process-operation',
    action: 'external.create',
    input: { stable: true },
    run: async () => {
      appendFileSync(executions, `${process.pid}\n`);
      await new Promise(resolve => setTimeout(resolve, 200));
      return { created: true };
    },
  });
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  if (!(error instanceof EffectInProgressError)) throw error;
  process.stdout.write('IN_PROGRESS');
} finally {
  await ledger.close();
}
