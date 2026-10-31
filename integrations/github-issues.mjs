const DEFAULT_API_URL = 'https://api.github.com';
const DEFAULT_API_VERSION = '2022-11-28';

const repositoryPart = (value, name) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new TypeError(`${name} must contain only GitHub repository-name characters`);
  }
  return value;
};

const idempotencyKey = (value) => {
  if (typeof value !== 'string' || !/^mola_[a-f0-9]{64}$/.test(value)) {
    throw new TypeError('idempotencyKey must be the key supplied by EffectLedger.execute()');
  }
  return value;
};

export function githubIssueMarker(key) {
  return `<!-- mola-ledger-idempotency:${idempotencyKey(key)} -->`;
}

export class GitHubIssuesError extends Error {
  constructor(message, { code = 'GITHUB_API_ERROR', status, cause } = {}) {
    super(message, { cause });
    this.name = 'GitHubIssuesError';
    this.code = code;
    this.status = status;
  }
}

function projectIssue(issue) {
  return {
    id: issue.id,
    nodeId: issue.node_id,
    number: issue.number,
    url: issue.html_url,
    title: issue.title,
    state: issue.state,
  };
}

/**
 * Minimal GitHub Issues integration for Mola Ledger.
 *
 * GitHub does not accept an idempotency key for issue creation. This adapter
 * stores the ledger key in an HTML comment so a positive provider lookup can
 * reconcile a lost response. A missing lookup is deliberately inconclusive.
 */
export class GitHubIssuesAdapter {
  constructor({
    token,
    owner,
    repo,
    apiUrl = DEFAULT_API_URL,
    apiVersion = DEFAULT_API_VERSION,
    fetchImpl = globalThis.fetch,
    maxLookupPages = 10,
  } = {}) {
    if (typeof token !== 'string' || !token.trim()) throw new TypeError('GitHub token is required');
    if (typeof fetchImpl !== 'function') throw new TypeError('fetch must be available');
    if (!Number.isInteger(maxLookupPages) || maxLookupPages < 1 || maxLookupPages > 100) {
      throw new TypeError('maxLookupPages must be an integer from 1 to 100');
    }
    this.token = token;
    this.owner = repositoryPart(owner, 'owner');
    this.repo = repositoryPart(repo, 'repo');
    this.apiUrl = String(apiUrl).replace(/\/$/, '');
    this.apiVersion = apiVersion;
    this.fetchImpl = fetchImpl;
    this.maxLookupPages = maxLookupPages;
  }

  async request(path, { method = 'GET', body } = {}) {
    let response;
    try {
      response = await this.fetchImpl(`${this.apiUrl}${path}`, {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${this.token}`,
          'x-github-api-version': this.apiVersion,
          'user-agent': 'mola-ledger',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (cause) {
      throw new GitHubIssuesError('Cannot reach the GitHub API', { code: 'GITHUB_UNAVAILABLE', cause });
    }

    let data;
    try { data = await response.json(); }
    catch (cause) {
      throw new GitHubIssuesError('GitHub returned a non-JSON response', {
        code: 'GITHUB_INVALID_RESPONSE', status: response.status, cause,
      });
    }
    if (!response.ok) {
      throw new GitHubIssuesError(`GitHub request failed: ${data?.message || response.statusText}`, {
        status: response.status,
      });
    }
    return data;
  }

  async createIssue({ title, body = '', labels = [], idempotencyKey: key }) {
    if ((typeof title !== 'string' && typeof title !== 'number') || String(title).length === 0) {
      throw new TypeError('title is required');
    }
    if (typeof body !== 'string') throw new TypeError('body must be a string');
    if (!Array.isArray(labels) || labels.some(label => typeof label !== 'string')) {
      throw new TypeError('labels must be an array of strings');
    }
    const marker = githubIssueMarker(key);
    const issue = await this.request(
      `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/issues`,
      { method: 'POST', body: { title, body: `${body}${body ? '\n\n' : ''}${marker}`, labels } },
    );
    return projectIssue(issue);
  }

  async findIssueByIdempotencyKey(key) {
    const marker = githubIssueMarker(key);
    for (let page = 1; page <= this.maxLookupPages; page++) {
      const issues = await this.request(
        `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/issues?state=all&per_page=100&page=${page}`,
      );
      if (!Array.isArray(issues)) {
        throw new GitHubIssuesError('GitHub issue list was not an array', { code: 'GITHUB_INVALID_RESPONSE' });
      }
      const match = issues.find(issue => !issue.pull_request && typeof issue.body === 'string' && issue.body.includes(marker));
      if (match) return projectIssue(match);
      if (issues.length < 100) return null;
    }
    return null;
  }

  async verifyIssueByIdempotencyKey(key) {
    const issue = await this.findIssueByIdempotencyKey(key);
    if (!issue) return { status: 'unknown' };
    return {
      status: 'succeeded',
      result: issue,
      evidence: `GitHub confirmed issue #${issue.number} (${issue.nodeId}) at ${issue.url}`,
    };
  }
}
