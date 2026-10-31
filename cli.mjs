#!/usr/bin/env node
const [command, ...args] = process.argv.slice(2);

if (command === 'studio') {
  const { runStudioCli } = await import('./studio/cli.mjs');
  await runStudioCli(args);
} else if (command === 'server') {
  await import('./server/cli.mjs');
} else {
  console.log(`Mola Ledger

Usage:
  mola-ledger studio [--storage PATH] [--port PORT]
  mola-ledger server

Embedded applications do not need a server. Run Studio to inspect a local ledger.`);
  if (command && command !== '--help' && command !== '-h') process.exitCode = 1;
}
