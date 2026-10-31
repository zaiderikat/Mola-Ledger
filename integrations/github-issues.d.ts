export interface GitHubIssueResult {
  id: number;
  nodeId: string;
  number: number;
  url: string;
  title: string;
  state: string;
}

export class GitHubIssuesError extends Error {
  code: string;
  status?: number;
}

export interface GitHubIssuesAdapterOptions {
  token: string;
  owner: string;
  repo: string;
  apiUrl?: string;
  apiVersion?: string;
  fetchImpl?: typeof fetch;
  maxLookupPages?: number;
}

export class GitHubIssuesAdapter {
  constructor(options: GitHubIssuesAdapterOptions);
  createIssue(options: {
    title: string | number;
    body?: string;
    labels?: string[];
    idempotencyKey: string;
  }): Promise<GitHubIssueResult>;
  findIssueByIdempotencyKey(idempotencyKey: string): Promise<GitHubIssueResult | null>;
  verifyIssueByIdempotencyKey(idempotencyKey: string): Promise<
    | { status: 'succeeded'; result: GitHubIssueResult; evidence: string }
    | { status: 'unknown' }
  >;
}

export function githubIssueMarker(idempotencyKey: string): string;
