# Backend hardening and open-source adoption decisions

Status: engineering decision record for finishing Kuro-chan's backend before the larger UI build.

## Architecture we have today

Kuro-chan is a TypeScript monorepo with a Fastify API, a separate worker, SQLite-backed durable run/task storage, an agent catalog, a planning/execution engine, an OpenAI-compatible model gateway, OmniRouter, workspace/GitHub/research/sandbox tools, an MCP client, and a browser/PWA client.

The right strategy is not to rewrite every subsystem. Several core boundaries already exist and are worth retaining. Replace components when an upstream project provides a clearly better, testable implementation behind an explicit adapter.

## Findings and decisions

### 1. MCP input-schema validation — replace the hand-written validator

**Finding:** the repository already uses the official MCP TypeScript SDK for stdio and Streamable HTTP transports. Do not replace that with an unrelated MCP client. The weaker part was Kuro-chan's large, hand-written partial JSON Schema evaluator, which could reject legitimate schemas or fail to enforce newer keywords.

**Change in this branch:** use Ajv plus ajv-formats, use the MCP-compatible 2020-12 dialect by default, support explicitly declared draft-07 and 2019-09 schemas, reject unknown dialects and unresolved references, disable coercion/default injection/removing properties, bound input-schema and argument sizes, cache compiled schemas with a fixed maximum, and add regression tests. Tool permission and approval decisions remain in Kuro-chan's policy layer.

References:
- https://github.com/ajv-validator/ajv
- https://github.com/ajv-validator/ajv-formats
- https://github.com/modelcontextprotocol/typescript-sdk

### 2. Keep OmniRouter; do not add a competing router

**Finding:** the current router already has bounded attempts, capability filtering, request concurrency limits, per-provider health/circuit state, cancellation, streaming, and usage hooks. Adding LiteLLM or another router in the request path as a second policy engine would create competing retries and fallback rules.

**Decision:** keep OmniRouter as the single policy authority. Later, if additional provider coverage is needed, connect a compatible gateway such as LiteLLM or Ollama through the existing OpenAI-compatible adapter. Improve capability provenance, live readiness probes, provider/model-specific health, usage accounting, per-user budgets, and regression tests before widening routes.

References:
- https://github.com/BerriAI/litellm
- https://github.com/ollama/ollama

### 3. Keep the local SQLite queue; add a separate production durable-workflow adapter only for hosted execution

**Finding:** SQLite state is more than a prototype: runs, tasks, dependency edges, events, heartbeats, lease owners/expiry, and recovery behavior are stored transactionally. It is appropriate for the initial local-first/single-user deployment. It is not, by itself, the right shared coordination plane for a horizontally scaled multi-tenant fleet.

**Decision:** do not replace the local queue indiscriminately. First add adversarial tests for concurrent claims, stale-worker fencing, crash/restart, duplicate submissions, idempotent tool writes, cancellation and approval waits. For hosted long-running agents, compare Temporal workflows (durable timers/signals/replay) against BullMQ (Redis-backed jobs/retries/worker scaling) in a spike, then select exactly one scheduler adapter. Temporal is the stronger fit when approval pauses and multi-step durable workflows are requirements; BullMQ is simpler when the requirement is queue-based dispatch. The scheduler must not become a second source of truth for Kuro-chan's product-facing run record.

References:
- https://github.com/temporalio/sdk-typescript
- https://github.com/taskforcesh/bullmq

### 4. Add an isolated remote execution adapter instead of extending Docker-only execution into hosted mode

**Finding:** the current Docker runner is a useful opt-in local sandbox with resource/output limits and network disabled by default. It is not a complete remote per-user compute platform or a production multi-tenant security boundary.

**Decision:** keep Docker as the local development executor. Define a versioned execution-provider contract covering create/resume/stop, workspace sync, command execution, cancellation, resource caps, network policy, logs, artifacts/checksums, cleanup and typed failures. Prototype Daytona or the OpenHands Agent Server behind that contract. Do not import their scheduler or permission model wholesale; Kuro-chan remains responsible for tool policy, approvals, evidence and product run state. Never expose raw Docker access or unrestricted host commands.

References:
- https://github.com/daytonaio/daytona
- https://github.com/OpenHands/software-agent-sdk
- https://github.com/OpenHands/OpenHands

### 5. Hosted persistence and identity are a release gate, not a UI-only task

**Finding:** local SQLite and a static server-side bearer token are enough for a trusted local instance, but the original hosted vision requires tenant identity, per-user credential ownership, resource limits, and full data scoping.

**Decision:** finish/review the account-authentication work on its PR; then define a storage port before adding a PostgreSQL implementation. Scope every run, event, task, workspace/artifact path, memory entry, approval and usage record to an authenticated owner/tenant. Add migration, retention/export/delete, backup/restore, and cross-tenant adversarial tests before enabling shared hosting.

### 6. Code intelligence is still a real backend gap

**Finding:** workspace text/file tools do not equal the indexing and retrieval system described in the original vision.

**Decision:** begin with deterministic ignored-path-aware file discovery, content hashes, lexical/symbol search and language-server diagnostics. Add incremental codebase indexing and embeddings behind a replaceable retrieval interface; do not add a vector database until evaluation data proves it improves retrieval. Continue's indexing approach is a useful reference; Tree-sitter is appropriate for language-aware syntax and symbol extraction.

References:
- https://github.com/continuedev/continue
- https://github.com/tree-sitter/tree-sitter

## Backend definition of done

Do not move to the full UI phase until the backend provides evidence for all of these:

1. Clean frozen install, build, typecheck, tests and lint from a fresh checkout including pinned submodules.
2. Durable, idempotent, cancellable task lifecycle with worker fencing and crash/restart tests.
3. A single model-routing policy with provider/model capability checks, bounded retries, honest usage and explicit paid-fallback policy.
4. Schema-validated tools, default-deny permission grants, per-action approval, audit events and safe failure behavior.
5. Isolated execution that builds/tests a real sample repository and returns logs, artifact hashes and verification evidence.
6. Project-aware context retrieval with measurable search/retrieval tests.
7. Safe GitHub operations with allowlisting, separate read/write scopes, branch/diff evidence, approval-gated publication, and no implicit merge/deploy.
8. Authenticated tenant isolation for hosted mode, secret redaction, rate/concurrency limits, backup/restore and deletion tests.
9. Real-provider smoke tests and end-to-end acceptance tests in a controlled environment; ordinary CI alone is insufficient.
10. Operational runbooks and health/readiness/metrics/tracing for API, workers, providers and executions.

## Explicit non-goals for this backend pass

- Drawing/art canvas features: not implied by the word “canvas” and not a backend requirement unless specified separately.
- Replacing OmniRouter with a second gateway.
- Rewriting the existing task engine merely to adopt a framework.
- Claiming remote workers, OAuth-dependent MCP connections, realtime voice, native apps or hosted multi-tenancy are complete before their acceptance tests pass.
