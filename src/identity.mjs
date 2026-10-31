import { createHash } from 'node:crypto';

// Deterministic JSON for stable hashes independent of object key insertion order.
function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Effect input must contain only finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  throw new TypeError('Effect input must be plain JSON data (no dates, undefined, circular references, or BigInt)');
}

export function fingerprintInput(input) {
  return createHash('sha256').update(canonical(input)).digest('hex');
}

export function effectIdempotencyKey(namespace, operationId) {
  if (typeof namespace !== 'string' || typeof operationId !== 'string') {
    throw new TypeError('namespace and operationId must be strings');
  }
  return 'mola_' + createHash('sha256').update(JSON.stringify([namespace, operationId])).digest('hex');
}
