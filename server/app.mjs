import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { LedgerStore, ValidationError } from './storage.mjs';

const LIMIT = 128 * 1024;

const equalSecret = (a, b) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

async function readJson(req) {
  let length = 0;
  const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > LIMIT) throw new ValidationError('Request body exceeds 128 KiB');
    chunks.push(chunk);
  }
  if (!length) throw new ValidationError('JSON body required');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ValidationError('Invalid JSON body'); }
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
}

export function createLedgerServer({ apiKey, dbPath = './data/effects.sqlite', inFlightTimeoutMs = 60_000, store: externalStore } = {}) {
  if (typeof apiKey !== 'string' || apiKey.length < 8) {
    throw new Error('An explicit MOLA_LEDGER_API_KEY of at least 8 characters is required');
  }
  const store = externalStore ?? new LedgerStore({ filename: dbPath, inFlightTimeoutMs });
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/healthz' && req.method === 'GET') {
        return json(res, 200, { status: 'ok' });
      }
      if (!equalSecret(req.headers.authorization ?? '', `Bearer ${apiKey}`)) {
        return json(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Valid bearer token required' } });
      }
      if (url.pathname === '/v1/reporting/overview' && req.method === 'GET') {
        return json(res, 200, store.getMetrics({
          namespace: url.searchParams.get('namespace') || undefined,
          from: url.searchParams.get('from') || undefined,
          to: url.searchParams.get('to') || undefined,
        }));
      }
      if (url.pathname === '/v1/reporting/operations' && req.method === 'GET') {
        return json(res, 200, store.listOperations({
          namespace: url.searchParams.get('namespace') || undefined,
          query: url.searchParams.get('query') || undefined,
          action: url.searchParams.get('action') || undefined,
          status: url.searchParams.get('status') || undefined,
          from: url.searchParams.get('from') || undefined,
          to: url.searchParams.get('to') || undefined,
          limit: Number(url.searchParams.get('limit') || '50'),
          offset: Number(url.searchParams.get('offset') || '0'),
        }));
      }
      if (url.pathname === '/v1/reporting/activity' && req.method === 'GET') {
        return json(res, 200, { activity: store.recentActivity({
          namespace: url.searchParams.get('namespace') || undefined,
          limit: Number(url.searchParams.get('limit') || '25'),
        }) });
      }
      if (url.pathname === '/v1/reporting/series' && req.method === 'GET') {
        return json(res, 200, { series: store.activitySeries({
          namespace: url.searchParams.get('namespace') || undefined,
          hours: Number(url.searchParams.get('hours') || '24'),
        }) });
      }
      if (url.pathname === '/v1/effects/unknown' && req.method === 'GET') {
        return json(res, 200, { effects: store.listUnknown({
          namespace: url.searchParams.get('namespace'),
          limit: Number(url.searchParams.get('limit') || '50'),
        }) });
      }
      if (url.pathname === '/v1/effects' && req.method === 'GET') {
        const effect = store.get({
          namespace: url.searchParams.get('namespace'),
          operationId: url.searchParams.get('operationId'),
          includeHistory: url.searchParams.get('history') === 'true',
        });
        return effect ? json(res, 200, { effect }) : json(res, 404, { error: { code: 'NOT_FOUND', message: 'Effect not found' } });
      }
      if (req.method !== 'POST') return json(res, 404, { error: { code: 'NOT_FOUND', message: 'Route not found' } });
      const body = await readJson(req);
      if (url.pathname === '/v1/effects/claim') return json(res, 200, store.claim(body));
      if (url.pathname === '/v1/effects/execution-started') return json(res, 200, { effect: store.executionStarted(body) });
      if (url.pathname === '/v1/effects/succeed') return json(res, 200, { effect: store.success(body) });
      if (url.pathname === '/v1/effects/unknown') return json(res, 200, { effect: store.unknown(body) });
      if (url.pathname === '/v1/effects/reconcile-success') return json(res, 200, { effect: store.reconcileSuccess(body) });
      return json(res, 404, { error: { code: 'NOT_FOUND', message: 'Route not found' } });
    } catch (err) {
      if (err?.code && err?.statusCode) return json(res, err.statusCode, { error: { code: err.code, message: err.message } });
      // Never send stack traces or untrusted exception messages to clients.
      console.error('[ledger] request failed:', err);
      return json(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
    }
  });
  return { server, store, close: () => new Promise((resolve, reject) => server.close((err) => { store.close(); err ? reject(err) : resolve(); })) };
}
