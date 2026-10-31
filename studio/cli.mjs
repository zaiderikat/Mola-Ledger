import { createStudioServer } from './server.mjs';

function valueAfter(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  if (!args[index + 1]) throw new Error(`${name} requires a value`);
  return args[index + 1];
}

export async function runStudioCli(args = process.argv.slice(2)) {
  const storage = valueAfter(args, '--storage') || process.env.MOLA_LEDGER_STORAGE;
  const portValue = valueAfter(args, '--port') || process.env.MOLA_LEDGER_STUDIO_PORT;
  const port = portValue === undefined ? 4317 : Number(portValue);
  const studio = createStudioServer({ storage, port });
  const address = await studio.listen();
  console.log('Mola Ledger Studio');
  console.log('');
  console.log(`Database: ${studio.ledger.storagePath}`);
  console.log(`Dashboard: ${address}`);
  console.log('Mode: read-only investigation');
  return studio;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  runStudioCli().catch(error => {
    console.error(`[studio] ${error.message}`);
    process.exitCode = 1;
  });
}
