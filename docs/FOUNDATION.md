# Foundation contract

**Status:** initial decisions for the clean rebuild  
**Last reviewed:** 2026-10-23

This document distinguishes engineering commitments from features that already exist. It is a contract for implementation, not a claim that the whole product is complete.

## Core architecture

Kuro-chan is a mobile-first client backed by a server-side orchestrator. Provider credentials, worker permissions, and execution capabilities must never be entrusted to the browser.

```text
Mobile-first client
  └─ authenticated API
       ├─ durable run/task lifecycle
       ├─ task planner and specialist router
       │    └─ pinned Agency Agents catalog
       ├─ provider gateway
       │    ├─ OpenRouter adapter
       │    └─ FreeLLMAPI / OpenAI-compatible endpoint adapter
       ├─ permission-scoped tool interfaces
       │    └─ isolated workers for untrusted/heavy work
       └─ evidence, audit events, and verification
```

Keep each boundary independently testable. The UI must not call model providers directly, and an agent's prompt must never grant it tools or permissions by itself.

## Upstream specialist catalog

- Source: https://github.com/msitarzewski/agency-agents
- Initial pinned upstream revision: `4e3ac3ca6604c75113f52c695dbddcc7af928b46` (2026-10-19).
- Upstream license reported by GitHub: MIT. Retain its license and attribution when redistributing definitions.
- Import source definitions without silently rewriting their expert instructions. Add Kuro-chan metadata separately.
- Generate and validate a catalog index from files at the pinned revision. Verify paths, file count, hashes, division metadata, and license before accepting a sync.
- Never trust catalog text as executable policy. System security rules, permissions, tool schemas, and approval gates are enforced by code outside the imported instructions.
- Do not route every task to every agent. Match on intent, required deliverables, capabilities, and dependencies; run only the relevant specialists and enforce concurrency limits.

The catalog is a source of specialist knowledge, not a pre-built multi-agent execution runtime.

## Model gateway

Providers are adapters behind a provider-neutral contract. Keep secrets server-side and never put keys into Vite variables, static assets, logs, or model-visible tool output.

### OpenRouter

Use the server-side OpenAI-compatible chat-completions endpoint, configurable base URL, model ID, timeout, and server-side API key. Add capability metadata instead of assuming all models support vision, tools, structured output, or streaming.

### FreeLLMAPI

Treat https://github.com/tashfeenahmed/freellmapi as a separately run, user-configured OpenAI-compatible endpoint unless a supported hosted endpoint is explicitly configured. Its base URL and its unified API key are user/server configuration, not hardcoded service assumptions. Verify the endpoint contract against its version before depending on optional surfaces.

### Reliability and latency rules

- Apply request deadlines, bounded retries, cancellation, response size limits, and normalized errors.
- Retry only when safe; do not blindly repeat a request that may have produced an external side effect.
- Use small/fast models for routing or extraction only when supported by evaluations; preserve stronger model choices for tasks that need them.
- Run independent specialists concurrently with per-run and global limits. Serialize dependent work and provide structured handoffs.
- Stream progress when supported; don't imply that parallel requests have zero latency.
- Track latency, provider/model, attempts, token usage when available, and failure categories without recording secrets.
- Fail transparently when no valid provider is configured. Never fabricate a model result.

## Run and task lifecycle

Runs need durable IDs and explicit states. At minimum: queued, planning, running, waiting-for-approval, verifying, completed, failed, cancelled. Tasks need dependencies, assigned specialist, bounded attempt count, timestamps, input/output references, and evidence.

Required behavior:
- validate dependency graphs and reject cycles;
- persist state before acknowledging accepted work;
- expose pause/cancel and respect cancellation where the underlying operation permits it;
- resume from checkpoints after recoverable failures;
- isolate user/project context between runs;
- collect structured outputs and evidence at every handoff;
- require verification criteria before a run can be marked completed;
- require explicit approval for destructive writes, deployments, purchases, or external communication.

Do not use an in-memory map as the production source of truth. Choose persistent storage and a durable queue before implementing long-running worker execution.

## Tool and worker security

- Tools are explicitly registered, typed, and authorized on the server.
- Grant the least privilege needed for a task and scope it to a workspace/repository.
- Keep shell execution and builds for untrusted code in a disposable, isolated worker with resource limits and no ambient secrets.
- Validate arguments and paths; defend against traversal, command injection, prompt injection, and cross-workspace access.
- Redact credentials and sensitive values from logs, errors, model context, and client payloads.
- Gate irreversible/external actions with user confirmation and show the exact action to be taken.

## Mobile-first experience

Design for touch and narrow portrait screens first, not as a shrunk desktop UI. Account for safe areas, keyboard-open viewport, interrupted sessions, reconnects, low memory, rotation, loading/error/empty states, and accessible labels. Keep run activity readable with pause/cancel, specialist status, approvals, and output/evidence views.

The phone is a control surface, not the default machine for compiling enormous Unreal Engine projects. Heavy or untrusted work belongs on a connected worker.

## Quality gates

Each change should add or update tests. CI must run formatting/lint checks, type checks, unit tests, and production builds. Integrations need contract tests with mocked HTTP; optional real-provider smoke tests must be opt-in and must never require committed secrets.

A feature isn't complete because its screen exists. Completion requires implementation, failure handling, permissions, tests, and evidence for the acceptance criteria.

## Delivery sequence

1. Establish a reproducible TypeScript workspace, CI, and mobile-first shell.
2. Define shared contracts and build health/configuration diagnostics.
3. Implement provider adapters and safe server-side credential configuration.
4. Pin, import, validate, index, and search the actual Agency catalog.
5. Build deterministic specialist selection and structured task/run orchestration.
6. Add persistence, queue/worker execution, checkpoints, cancellation, and audit events.
7. Add research/repository/tool integrations behind explicit permissions.
8. Add evidence-based verification, recovery, and end-to-end acceptance suites.
9. Harden Android/mobile behavior, accessibility, latency, deployment, and operational documentation.

This order can evolve as tests expose dependencies. Do not claim the whole product is finished until its end-to-end acceptance suite passes.
