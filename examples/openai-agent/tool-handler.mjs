import {
  EffectConflictError,
  EffectInProgressError,
  EffectUncertainError,
  EffectUnknownError,
} from '../../src/index.mjs';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

function trustedContext(runContext) {
  const context = runContext?.context;
  if (!context || typeof context !== 'object') {
    throw new TypeError('The tool requires trusted application context');
  }
  if (typeof context.requestId !== 'string' || !REQUEST_ID_PATTERN.test(context.requestId)) {
    throw new TypeError('Trusted context requestId is missing or invalid');
  }
  const issue = context.issue;
  if (!issue || typeof issue !== 'object' || typeof issue.title !== 'string' || !issue.title.trim()) {
    throw new TypeError('Trusted context issue.title is required');
  }
  if (issue.body !== undefined && typeof issue.body !== 'string') {
    throw new TypeError('Trusted context issue.body must be a string');
  }
  if (issue.labels !== undefined && (!Array.isArray(issue.labels) || issue.labels.some(label => typeof label !== 'string'))) {
    throw new TypeError('Trusted context issue.labels must be an array of strings');
  }
  return {
    requestId: context.requestId,
    issue: {
      title: issue.title,
      body: issue.body ?? '',
      labels: issue.labels ?? [],
    },
  };
}

/**
 * Implements the agent tool while keeping identity and payload outside the
 * model's arguments. This function is exported so the complete integration can
 * be tested without making an OpenAI model call.
 */
export function createGitHubIssueToolHandler({ ledger, github }) {
  if (!ledger || typeof ledger.execute !== 'function') throw new TypeError('ledger is required');
  if (!github || typeof github.createIssue !== 'function') throw new TypeError('github adapter is required');

  return async function executeCreateGitHubIssue(_args, runContext) {
    const { requestId, issue } = trustedContext(runContext);
    const operationId = `github-issue:${requestId}`;

    try {
      const result = await ledger.execute({
        id: operationId,
        namespace: 'openai-agent-example',
        action: 'github.issue.create',
        input: {
          owner: github.owner,
          repo: github.repo,
          title: issue.title,
          body: issue.body,
          labels: issue.labels,
        },
        metadata: {
          framework: 'openai-agents-js',
          tool: 'create_approved_github_issue',
        },
        providerReference: result => result.url,
        run: ({ idempotencyKey }) => github.createIssue({
          ...issue,
          idempotencyKey,
        }),
      });
      return {
        status: 'succeeded',
        operationId,
        issue: result,
        message: `GitHub issue #${result.number} is recorded at ${result.url}`,
      };
    } catch (error) {
      if (error instanceof EffectUnknownError || error instanceof EffectUncertainError) {
        return {
          status: 'blocked_unknown',
          operationId,
          message: 'The issue may already exist. Do not retry; verify with GitHub and reconcile the ledger.',
        };
      }
      if (error instanceof EffectInProgressError) {
        return {
          status: 'in_progress',
          operationId,
          message: 'Another execution of this operation is already in progress.',
        };
      }
      if (error instanceof EffectConflictError) {
        return {
          status: 'input_conflict',
          operationId,
          message: 'This operation ID was already used with a different issue payload.',
        };
      }
      throw error;
    }
  };
}
