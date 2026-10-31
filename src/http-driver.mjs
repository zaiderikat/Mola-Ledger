import {
  EffectConflictError,
  EffectLedgerError,
} from './errors.mjs';

export class HttpLedgerDriver {
  constructor({ url = 'http://127.0.0.1:8787', apiKey, fetchImpl = globalThis.fetch } = {}) {
    if (!apiKey || typeof apiKey !== 'string') throw new TypeError('apiKey is required');
    if (typeof fetchImpl !== 'function') throw new TypeError('fetch must be available');
    this.url = String(url).replace(/\/$/, '');
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  async request(path, { method = 'GET', body, query } = {}) {
    const url = new URL(`${this.url}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
      }
    }
    let response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (cause) {
      throw new EffectLedgerError('Cannot reach the ledger server', { code: 'LEDGER_UNAVAILABLE', cause });
    }

    let data;
    try { data = await response.json(); }
    catch (cause) {
      throw new EffectLedgerError('Invalid response from ledger server', { code: 'INVALID_RESPONSE', cause });
    }
    if (!response.ok) {
      const ErrorClass = response.status === 409 ? EffectConflictError : EffectLedgerError;
      throw new ErrorClass(data.error?.message || 'Ledger request failed', {
        code: data.error?.code || 'HTTP_ERROR',
        status: response.status,
      });
    }
    return data;
  }

  claim(body) {
    return this.request('/v1/effects/claim', { method: 'POST', body });
  }

  async succeed(body) {
    const { effect } = await this.request('/v1/effects/succeed', { method: 'POST', body });
    return effect;
  }

  async executionStarted(body) {
    const { effect } = await this.request('/v1/effects/execution-started', { method: 'POST', body });
    return effect;
  }

  async unknown(body) {
    const { effect } = await this.request('/v1/effects/unknown', { method: 'POST', body });
    return effect;
  }

  async get({ namespace, operationId, history = false }) {
    try {
      const { effect } = await this.request('/v1/effects', {
        query: { namespace, operationId, history: String(history) },
      });
      return effect;
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  }

  async listUnknown({ namespace, limit }) {
    const { effects } = await this.request('/v1/effects/unknown', {
      query: { namespace, limit: String(limit) },
    });
    return effects;
  }

  async reconcileSuccess(body) {
    const { effect } = await this.request('/v1/effects/reconcile-success', { method: 'POST', body });
    return effect;
  }

  async getMetrics(query) {
    return this.request('/v1/reporting/overview', { query });
  }

  async listOperations(query) {
    return this.request('/v1/reporting/operations', { query });
  }

  async recentActivity(query) {
    const { activity } = await this.request('/v1/reporting/activity', { query });
    return activity;
  }

  async activitySeries(query) {
    const { series } = await this.request('/v1/reporting/series', { query });
    return series;
  }
}
