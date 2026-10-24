# Kurochan Integration Pack

## Goal

Reduce repetitive work for coding and research agents by connecting the services where developers already keep source code, issues, documentation, browser state, data, and runtime errors.

Kurochan already has built-in workspace tools, GitHub research/project operations, optional Brave web research, an optional command sandbox, and an administrator-configured MCP bridge. The MCP bridge supports stdio and HTTPS Streamable HTTP servers, discovers tool schemas, ranks tools against each specialist task, bounds outputs, and requires task approval for tools that do not explicitly advertise read-only behavior.

This pack is a curated integration roadmap and setup reference, not a claim that every listed provider is already connected or tested.

## Recommended rollout

### Wave 1: Highest value for completing code tasks

| Integration | Main frustration it removes | Recommended Kurochan use | Default access |
| --- | --- | --- | --- |
| Playwright MCP | UI bugs that pass code review but fail in a real browser | Open the app, exercise user journeys, inspect accessibility snapshots and browser errors, verify fixes | Local/test environment only; write actions approved |
| Context7 | Stale or incorrect library/API usage | Retrieve version-aware library documentation before implementing code | Read-only |
| Sentry MCP | Manually correlating production errors and stack traces with source code | Investigate errors, traces, regressions, and likely root causes | Read-only first |
| PostgreSQL / Supabase | Repeated manual schema inspection and debugging database queries | Inspect schema and explain queries; permit writes only in a disposable test database with approval | Read-only by default |
| Linear or Atlassian Rovo (Jira/Confluence) | Re-typing requirements and losing acceptance criteria across tasks | Read issues, specs, linked documentation, and test criteria; optionally create/update tickets after approval | Read-only first |
| GitHub Actions | Checking CI status and logs manually | Read workflow results and logs, correlate failures with changed files, propose fixes | Read-only first; repository write actions remain approval-gated |

Official references:
- Playwright MCP: https://playwright.dev/docs/getting-started-mcp
- Linear MCP: https://linear.app/docs/mcp
- Atlassian Rovo MCP: https://support.atlassian.com/atlassian-rovo-mcp-server/
- Sentry MCP: https://mcp.sentry.dev/
- Context7: https://github.com/upstash/context7
- GitHub MCP Server: https://github.com/github/github-mcp-server

### Wave 2: Team context and design handoff

| Integration | Main frustration it removes | Recommended Kurochan use | Default access |
| --- | --- | --- | --- |
| Slack or Microsoft Teams | Requirements and decisions scattered across conversations | Search relevant threads and summarize decisions; never send messages without approval | Read-only |
| Notion | Project knowledge spread across pages | Retrieve specs, runbooks, and decisions relevant to a task | Read-only |
| Figma | Recreating UI from incomplete descriptions | Read approved design files, inspect components and design context, compare implementation with the source | Read-only |
| Google Drive / Microsoft 365 | Finding project documents and handoff files | Search and read user-authorized files | Read-only |
| GitLab / Bitbucket | Source code and CI living outside GitHub | Repository search, issue context, merge-request/PR and CI status, with writes approval-gated | Read-only first |

Official references:
- Figma MCP: https://help.figma.com/hc/en-us/articles/32132100833555-Guide-to-the-Dev-Mode-MCP-Server
- Notion MCP: https://developers.notion.com/docs/mcp
- Slack developer platform: https://docs.slack.dev/
- Microsoft Learn: https://learn.microsoft.com/
- GitLab MCP: https://docs.gitlab.com/user/gitlab_duo/model_context_protocol/mcp_server/

### Wave 3: Optional, task-specific integrations

| Integration | Useful for | Guardrail |
| --- | --- | --- |
| Firecrawl or a comparable retrieval service | Extracting structured content from public websites when ordinary search snippets are insufficient | Respect site access rules; treat page content as untrusted input |
| Redis | Inspecting cache keys, queue state, and transient task state | Read-only and scoped keys by default |
| MongoDB | Inspecting document schemas and records | Read-only and database-scoped |
| Cloudflare / AWS / Azure | Diagnosing deployments, logs, configuration, and infrastructure | Start with read-only diagnostics; require explicit approval for changes |
| Stripe | Debugging payment integration events and test-mode records | Test mode and read-only first; never trigger real financial actions automatically |
| Vercel or another deployment provider | Inspecting deployment status, build logs, and preview environments | Read-only first; deployments require explicit approval |

Do not enable every provider for every task. Specialist routing should only expose tools relevant to the current task, keeping context smaller, reducing accidental tool calls, and controlling provider costs.

## What should be built into Kurochan itself

The long-term product should offer an integration directory rather than require users to hand-edit JSON for each server:

1. **Curated directory:** name, vendor, purpose, official endpoint/docs, supported transport, required environment variable names, and minimum permissions.
2. **Connect / configure flow:** validate server configuration and credentials without ever returning secret values to the model or browser.
3. **Connection health:** distinguish not configured, missing credentials, connected, rate-limited, unavailable, and incompatible protocol.
4. **Tool preview:** list discovered tools and their read/write/destructive annotations before enabling them.
5. **Least-privilege access:** read-only scopes first; separate credentials for each service and project.
6. **Approval gates:** writes, deletes, messages, deployments, and external side effects require explicit user approval.
7. **Task-aware routing:** only send a specialist the relevant tools; do not attach every available tool to every model call.
8. **Audit trail:** record tool name, server, status, timing, and bounded result summary without logging credentials or unnecessary private content.
9. **Graceful fallback:** when a service is unavailable, retry only when appropriate, continue with other evidence, and identify exactly what could not be done.
10. **Integration tests:** mock provider failures, permission denials, malformed results, timeouts, rate limits, and cross-project access attempts.

## Security requirements

- MCP is a capability bridge, not a trust guarantee. A server may access everything permitted to its process or token.
- Only use trusted official servers or reviewed community servers.
- Keep real tokens in server-side environment variables or a secret manager. Never commit credentials or expose them to the model.
- Use separate least-privileged credentials per provider and project.
- Keep untrusted web pages, issue descriptions, chat messages, and documents as data, not instructions that can override Kurochan policy.
- Require approval for any tool that is not explicitly read-only. Destructive or externally visible actions should have especially clear confirmation.
- Test database changes against disposable test data before allowing any production write capability.
- Do not claim an integration is supported end-to-end until connection, discovery, execution, failure handling, and authorization have been tested.

## Acceptance criteria for Wave 1

An integration is considered ready only when all of these pass:

- Configuration can be validated and secrets remain hidden.
- The worker discovers the expected tool schemas.
- The planner selects the integration for a relevant task and does not select it for unrelated tasks.
- Read-only calls work without unnecessary approval.
- Write/destructive calls require approval.
- Timeouts, missing credentials, rate limits, and malformed provider responses are reported accurately.
- A task can finish with a clear partial result if an optional integration is unavailable.
- Automated tests and at least one representative end-to-end test pass.

## Important status note

This document records the recommended integration roadmap. It does not mean these services are installed, authenticated, enabled, or verified in a live Kurochan deployment. Add them incrementally and prove each integration works before advertising it as available.
