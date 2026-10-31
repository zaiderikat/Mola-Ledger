# OpenAI Agents SDK + GitHub example

This example proves the intended integration boundary:

```text
user instruction -> OpenAI agent -> registered function tool
                 -> embedded ledger -> GitHub Issues adapter -> GitHub API
```

The implementation uses `@openai/agents` 0.21.0 and Zod 4.6.7. It follows the current OpenAI Agents SDK APIs: `Agent`, `tool`, `run`, and local `RunContext`. See the official [Agents SDK quickstart](https://developers.openai.com/api/docs/guides/agents/quickstart) and [context guide](https://openai.github.io/openai-agents-js/guides/context/).

## Why trusted context matters

The agent decides whether to invoke `create_approved_github_issue`, but it supplies no operation identity or provider payload. The host application passes these through local run context:

```javascript
await run(agent, userInstruction, {
  context: {
    requestId: trustedRequestId,
    issue: approvedIssueDraft,
  },
});
```

OpenAI's local context is available to tool code and is not sent to the model. The handler derives `github-issue:${requestId}` and wraps the approved draft with `ledger.execute()`. A model-generated UUID would change on retries and defeat duplicate detection, so it is not used as the business identity.

## Run the live example

Use a disposable repository. The command can create a real GitHub issue and makes an OpenAI API request.

From this repository, `npm install` installs the pinned example dependencies. In an application that already installed the ledger package, add the optional agent dependencies explicitly:

```bash
npm install @openai/agents@0.21.0 zod@4.6.7

export OPENAI_API_KEY='...'
export GITHUB_TOKEN='fine-grained-token-with-issues-write'
export GITHUB_OWNER='your-account'
export GITHUB_REPO='disposable-repository'
export AGENT_REQUEST_ID='support-request-1842-v1'
export GITHUB_ISSUE_TITLE='Investigate alert 1842'
export GITHUB_ISSUE_BODY='Created by the operations agent.'
export GITHUB_ISSUE_LABELS='agent,demo'
export MOLA_LEDGER_STORAGE='./data/openai-agent.sqlite'

node examples/openai-agent/agent.mjs 'Create the approved GitHub issue.'
```

Keep `AGENT_REQUEST_ID` and the issue draft unchanged when retrying the same intended action. Run the command again: the agent may invoke the tool again, but the ledger returns the recorded GitHub result rather than independently creating another issue. Changing the payload under the same ID is an input conflict.

Inspect the action while the agent application is stopped or running:

```bash
npx mola-ledger studio --storage ./data/openai-agent.sqlite
```

## Unknown outcomes

If GitHub may have created the issue but the callback cannot confirm its response, the tool returns a structured `blocked_unknown` result. Its instructions tell the agent not to recommend a blind retry. The application must use the adapter's positive lookup and the ledger's `reconcile()` API.

The GitHub adapter puts the ledger idempotency key in an invisible issue-body marker. Finding that marker is positive evidence. Not finding it is not proof of failure, so the record remains `UNKNOWN`.

## Credential-free verification

Normal `npm test` runs the real tool handler with the embedded ledger and controlled GitHub HTTP responses. It verifies:

- trusted application identity is required before any provider call;
- two identical tool invocations execute one GitHub creation;
- the second invocation is recorded as a suppressed cached replay;
- simulated response loss becomes `UNKNOWN` and blocks another creation;
- a positive marker lookup reconciles the issue to `SUCCEEDED`.

These tests do not call an OpenAI model because tool-handler correctness does not require spending model tokens. The agent definition is separately loaded against the installed SDK to verify the actual framework API.

## Opt-in live integration test

The live test is disabled during normal CI. With the GitHub variables above, explicitly acknowledge the external write:

```bash
RUN_GITHUB_LIVE_TEST=1 npm run test:live:github
```

It creates a disposable issue, simulates losing the successful response, verifies the marker through GitHub, reconciles the ledger, and confirms cached replay. Live execution requires repository-owner credentials and an explicit command; normal automated tests use credential-free controlled responses.

## Files

- `examples/openai-agent/agent.mjs` defines and runs the OpenAI agent and tool.
- `examples/openai-agent/tool-handler.mjs` implements the protected tool boundary.
- `test/openai-agent.test.mjs` provides controlled-response coverage.
- `integrations/github-issues.mjs` provides GitHub creation and positive lookup.
