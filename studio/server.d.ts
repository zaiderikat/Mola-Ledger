import type { Server } from 'node:http';
import type { EmbeddedLedger } from 'mola-ledger';

export interface StudioServerOptions {
  storage?: string;
  host?: '127.0.0.1' | 'localhost' | '::1';
  port?: number;
  inFlightTimeoutMs?: number;
}

export interface StudioServer {
  readonly server: Server;
  readonly ledger: EmbeddedLedger;
  readonly address: string;
  listen(): Promise<string>;
  close(): Promise<void>;
}

export function createStudioServer(options?: StudioServerOptions): StudioServer;
