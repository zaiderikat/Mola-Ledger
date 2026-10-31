import { pathToFileURL } from 'node:url';
import { Agent, run, tool } from '@openai/agents';
import { z } from 'zod';
import { createLedger } from '../../src/index.mjs';
import { GitHubIssuesAdapter } from '../../integrations/github-issues.mjs';
import { createGitHubIssueToolHandler } from './tool-handler.mjs';

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required; see docs/OPENAI_AGENTS.md`);
  return value;
};

export function createGitHubIssueAgent({ ledger, github }) {
  const createIssue = tool({
    name: 'create_approved_github_issue',
    description: 'Create the pre-approved GitHub issue supplied by the host application.',
    parameters: z.object({}),
    execute: createGitHubIssueToolHandler({ ledger, github }),
  });

  return new Agent({
    name: 'GitHub operations agent',
    instructions: [
      'You help execute a GitHub issue creation request prepared by the host application.',
      'When the user asks to create the approved issue, call create_approved_github_issue exactly once.',
      'Report blocked_unknown as requiring provider verification. Never suggest blindly retrying it.',
    ].join(' '),
    tools: [createIssue],
  });
}

export async function runExample({
  requestId,
  prompt = 'Create the approved GitHub issue.',
  title,
  body = '',
  labels = [],
  storage,
} = {}) {
  const ledger = createLedger({ storage });
  const github = new GitHubIssuesAdapter({
    token: required('GITHUB_TOKEN'),
    owner: required('GITHUB_OWNER'),
    repo: required('GITHUB_REPO'),
  });
  const agent = createGitHubIssueAgent({ ledger, github });

  try {
    return await run(agent, prompt, {
      context: {
        requestId,
        issue: { title, body, labels },
      },
    });
  } finally {
    await ledger.close();
  }
}

async function main() {
  const requestId = required('AGENT_REQUEST_ID');
  const title = required('GITHUB_ISSUE_TITLE');
  const result = await runExample({
    requestId,
    title,
    body: process.env.GITHUB_ISSUE_BODY || 'Created by the Mola Ledger OpenAI Agents SDK example.',
    labels: (process.env.GITHUB_ISSUE_LABELS || '').split(',').map(value => value.trim()).filter(Boolean),
    storage: process.env.MOLA_LEDGER_STORAGE,
    prompt: process.argv.slice(2).join(' ') || 'Create the approved GitHub issue.',
  });
  console.log(result.finalOutput);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
