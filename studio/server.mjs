import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLedger } from '../src/index.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const assets = new Map([
  ['/', { type: 'text/html; charset=utf-8', body: readFileSync(join(directory, 'public/index.html')) }],
  ['/styles.css', { type: 'text/css; charset=utf-8', body: readFileSync(join(directory, 'public/styles.css')) }],
  ['/app.js', { type: 'text/javascript; charset=utf-8', body: readFileSync(join(directory, 'public/app.js')) }],
]);

const json = (res, status, value) => {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(value));
};

const securityHeaders = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

function safeResultSummary(result) {
  if (result === null) return null;
  if (Array.isArray(result)) return { type: 'array', length: result.length };
  if (typeof result === 'object') return { type: 'object', keys: Object.keys(result).slice(0, 20) };
  if (typeof result === 'string') return { type: 'string', length: result.length };
  return { type: typeof result };
}

function studioEffect(effect, { details = false } = {}) {
  const { result, ...safe } = effect;
  if (details) safe.resultSummary = safeResultSummary(result);
  else delete safe.events;
  return safe;
}

function allowedHost(hostHeader, port) {
  const host = String(hostHeader || '').toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
}

export function createStudioServer({
  storage,
  host = '127.0.0.1',
  port = 4317,
  inFlightTimeoutMs = 60_000,
} = {}) {
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error('Ledger Studio only binds to a loopback address');
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new TypeError('Studio port must be an integer from 0 to 65535');
  }
  const ledger = createLedger({ storage, inFlightTimeoutMs });
  let activePort = port;

  const server = createServer(async (req, res) => {
    try {
      if (!allowedHost(req.headers.host, activePort)) {
        return json(res, 403, { error: { code: 'INVALID_HOST', message: 'Ledger Studio only accepts local hostnames' } });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return json(res, 405, { error: { code: 'READ_ONLY', message: 'Ledger Studio is read-only' } });
      }
      const url = new URL(req.url, `http://127.0.0.1:${activePort}`);

      if (url.pathname === '/api/config') {
        return json(res, 200, {
          storagePath: ledger.storagePath,
          readOnly: true,
          refreshIntervalMs: 4000,
        });
      }
      if (url.pathname === '/api/overview') {
        return json(res, 200, await ledger.getMetrics({
          namespace: url.searchParams.get('namespace') || undefined,
          from: url.searchParams.get('from') || undefined,
          to: url.searchParams.get('to') || undefined,
        }));
      }
      if (url.pathname === '/api/operations') {
        const page = await ledger.listOperations({
          namespace: url.searchParams.get('namespace') || undefined,
          query: url.searchParams.get('query') || undefined,
          action: url.searchParams.get('action') || undefined,
          status: url.searchParams.get('status') || undefined,
          from: url.searchParams.get('from') || undefined,
          to: url.searchParams.get('to') || undefined,
          limit: Number(url.searchParams.get('limit') || '25'),
          offset: Number(url.searchParams.get('offset') || '0'),
        });
        return json(res, 200, { ...page, operations: page.operations.map(effect => studioEffect(effect)) });
      }
      if (url.pathname.startsWith('/api/operations/')) {
        const parts = url.pathname.slice('/api/operations/'.length).split('/').map(decodeURIComponent);
        if (parts.length !== 2 || !parts[0] || !parts[1]) {
          return json(res, 400, { error: { code: 'INVALID_IDENTITY', message: 'Namespace and operation ID are required' } });
        }
        const effect = await ledger.get({ namespace: parts[0], operationId: parts[1], history: true });
        return effect
          ? json(res, 200, { operation: studioEffect(effect, { details: true }) })
          : json(res, 404, { error: { code: 'NOT_FOUND', message: 'Operation not found' } });
      }
      if (url.pathname === '/api/activity') {
        return json(res, 200, { activity: await ledger.recentActivity({
          namespace: url.searchParams.get('namespace') || undefined,
          limit: Number(url.searchParams.get('limit') || '25'),
        }) });
      }
      if (url.pathname === '/api/series') {
        return json(res, 200, { series: await ledger.activitySeries({
          namespace: url.searchParams.get('namespace') || undefined,
          hours: Number(url.searchParams.get('hours') || '24'),
        }) });
      }

      const asset = assets.get(url.pathname);
      if (!asset) return json(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
      res.writeHead(200, {
        ...securityHeaders,
        'content-type': asset.type,
        'cache-control': url.pathname === '/' ? 'no-store' : 'public, max-age=300',
      });
      if (req.method === 'HEAD') return res.end();
      res.end(asset.body);
    } catch (error) {
      console.error('[studio] request failed:', error);
      return json(res, error?.status === 400 ? 400 : 500, {
        error: { code: error?.code || 'INTERNAL_ERROR', message: error?.status === 400 ? error.message : 'Studio request failed' },
      });
    }
  });

  return {
    server,
    ledger,
    get address() { return `http://${host}:${activePort}`; },
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        activePort = server.address().port;
        resolve(`http://${host}:${activePort}`);
      });
    }),
    close: () => new Promise((resolve, reject) => server.close(async error => {
      try { await ledger.close(); }
      catch (closeError) { return reject(closeError); }
      if (error) reject(error);
      else resolve();
    })),
  };
}
