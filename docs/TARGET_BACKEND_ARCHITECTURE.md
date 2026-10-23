# Kuro-chan Backend Architecture Decision Record

Status: proposed target architecture; implementation must satisfy the gates below before being called complete.
Last reviewed: 2026-10-23.

## Executive decision

Keep Kuro-chan's own TypeScript backend and OmniRouter as the product's control plane. Reuse the Agency Agents profiles as versioned specialist knowledge. Study external projects for narrow, tested ideas and protocols; do not transplant a second orchestration control plane into Kuro-chan.

The target is a modular monolith for local/mobile-first use, with separately runnable API and worker processes and an explicit path to remote isolated workers and multi-user hosting. A fresh install owns fresh state. A self-hosted user's credentials and quotas are not silently shared with other installations.

## Research findings and integration choices

| Project | Useful ideas | Decision |
| --- | --- | --- |
| Agency Agents (MIT) | The specialist catalog: domain instructions, workflows, roles, and deliverables. | Primary source of agent profiles. Pin an upstream commit, preserve attribution and stable source paths, recursively ingest profiles, validate metadata, detect removals/changes, and never let profile text override platform security policy. |
| OpenWOP (Apache-2.0 protocol/spec) | Durable run semantics, explicit events, pause/resume, replay, idempotency, tenant-bound identity, and conformance testing. | Use as a protocol and acceptance-test reference. Do not replace the current task store with a second engine before proving a concrete gap. Evaluate an adapter only if interoperability/replay requirements justify it. |
| Orloj (Apache-2.0) | Operational patterns: declarative task graphs, leases/heartbeats, fail-closed permissions, approval gates, dead letters, MCP discovery, and traces. | Architecture reference, not an automatic runtime dependency. The repository is under active development; review its code, API stability, operational footprint, and license/NOTICE obligations before any adoption. |
| InferenceMesh (MIT) | Capability-aware model choice, free-tier quota ledgers, privacy filtering, missing-key transparency, provider health and failover. | Port the ideas into OmniRouter where they fit. Do not run a second router in the request path unless a measured integration need requires it. Provider quotas must be based on actual upstream limits, not assumed token grants. |
| Hermes Router (MIT) | Multi-provider failover, local model endpoints, key rotation, usage visibility and provider health. | Use as a provider compatibility/operations reference. Avoid running two competing routing loops that duplicate retries or hide the real provider selected. |
| ai-model-router (MIT) | Usage ledger, per-key limits, request policies, cost/latency data and hosted multi-tenant patterns. | Borrow the data model concepts and test cases, not its separate Python gateway. Never expose an unmetered public model proxy. |
| Model Context Protocol (MCP) TypeScript SDK | A standard way to discover and call external tools and resources. | Add an MCP adapter behind Kuro-chan's own tool policy. Every discovered tool is untrusted until schemas, endpoint, permissions, timeout, output limits, and approval rules are validated. Pin a compatible SDK release and verify the license/transitive dependency tree. |
| A2A interoperability | Cross-host agent discovery and task delegation when there is a real remote-agent use case. | Defer remote A2A execution until local task contracts, identity, audit, cancellation, and tool permissions are stable. |
| Container/remote worker isolation | Separate untrusted build/test commands from the API and user device. | Required before arbitrary repository code or project builds can be advertised as safely executable. Start with a worker adapter boundary and an isolated implementation; never treat an agent prompt as a security boundary. |

Research sources:
- https://github.com/msitarzewski/agency-agents
- https://github.com/openwop/openwop
- https://github.com/OrlojHQ/orloj
- https://github.com/gdalabs/inferencemesh
- https://github.com/Shaf2665/Hermes-router
- https://github.com/dsk-dev-ai/ai-model-router
- https://github.com/modelcontextprotocol/typescript-sdk

This is an engineering evaluation, not an endorsement or a claim that any upstream project's production guarantees have been independently verified. Review each project's current source, tests, releases, license and transitive dependencies before adopting code.

## Target component boundaries

1. **API and identity boundary**: request validation, authentication where hosted, tenant identity, request limits, idempotency keys, SSE/WebSocket event streaming, approval endpoints, and health/readiness endpoints. The API must not execute long builds inline.
2. **Run/task domain**: versioned schemas for runs, tasks, dependency edges, checkpoints, artifacts, evidence, approvals, cancellation, retries, and terminal outcomes. State transitions are explicit and transactional.
3. **Planner and specialist selector**: inspect the goal and workspace, search the entire available catalog, select any relevant specialists, build a dependency graph, and record why each specialist was selected. There is no arbitrary fixed catalog cap; concurrency, budgets and deadlines are runtime policy controls.
4. **Agency catalog**: pinned upstream source revision; recursive discovery of Markdown profiles; stable source-derived IDs; normalized metadata; index/search; provenance, hashes, license notice, change report and validation. Do not silently drop nested directories or invent a roster count.
5. **OmniRouter**: the only first-party inference routing policy layer. Filter providers by configured status, task capability, privacy, user policy, budget and health; then rank, make bounded attempts, classify failures, maintain circuit breakers, record provider/model/latency/token usage when reported, and expose the chosen route in diagnostics. Avoid retry multiplication across planner, worker, provider SDK and proxy.
6. **Provider adapters**: normalized chat/tool-call/structured-output/streaming/cancellation interface. OpenRouter and FreeLLMAPI-compatible endpoints are adapters, not orchestrators. Handle incompatible tool calling, vision, streaming and JSON schema honestly. Provider keys stay server-side.
7. **Tool registry and policy engine**: typed schemas; per-tool capability declarations; per-run and per-tenant grants; least privilege; timeouts, cancellation, output caps, audit records, network egress rules, approval requirements, and schema validation. MCP servers are optional adapters, not trusted authorities.
8. **Research subsystem**: web search/fetch, repository inspection, document parsing, source provenance, citations, freshness, evidence extraction, and explicit distinction between observed evidence, inference and unknowns. Research tools need SSRF defenses, URL allowlists/blocklists, redirect revalidation and bounded content.
9. **Execution/workspace subsystem**: workspace-scoped file operations and patch application, Git integration, command/build/test adapters, artifact manifests, and disposable isolated workers for untrusted code. Separate read/write/execute/network capabilities; do not give every specialist unrestricted shell access.
10. **Verification and quality gates**: independent review based on task type; compile/lint/test/security checks where applicable; evidence requirements; bounded repair loops; explicit blocked/failed states; no success claim based only on model prose.
11. **Storage and event log**: local SQLite for the first single-user deployment if its concurrency and durability tests pass; define a storage interface before adding PostgreSQL for hosted mode. Use transactions, idempotency, lease owner/expiry, heartbeats, append-only run events, checkpoints, retention, backups and migrations. Introduce a distributed queue only when multiple workers/hosted scale require it.
12. **Observability**: structured logs with secret redaction, per-run traces, provider selection/failover reasons, task timing, tool invocation outcomes, resource usage, failure classification and health checks. Avoid logging full user content by default.
13. **Installation/profile boundary**: new install creates a fresh database, workspace, local memory and credential namespace. The shared catalog is immutable app data. Multi-user mode must enforce tenant isolation in every query, artifact path, cache key, memory operation, audit event and worker claim.
14. **Remote worker interface**: versioned task envelope, workspace/artifact transfer, explicit capabilities, signed or authenticated worker identity, heartbeat, cancellation, timeout, resource quotas, network policy, cleanup and result attestation. Phone remains the control surface, not the build machine.
15. **Voice and media adapters (later backend stages)**: streaming STT/TTS, cancellation/interruption, transcripts, image/document input and drawing/media tools through the same task/tool policy. Do not couple these to the core scheduler.
16. **Client boundary (later)**: API contract only; no provider secrets or direct database access. UI is deliberately out of scope until backend acceptance gates pass.

## Task lifecycle contract

`accepted -> planning -> queued -> running -> verifying -> succeeded`

Other explicit states: `needs_input`, `waiting_for_approval`, `retry_wait`, `blocked`, `failed`, `cancel_requested`, `cancelled`.

Every transition must be persisted with a timestamp and cause. A task claim is a lease, not permanent ownership. Workers heartbeat while running; stale workers must be unable to commit results after lease loss. Retries are bounded, classified and idempotent. Cancellation propagates to model calls and tools. A reviewer outage must not rewrite a completed task as failed; instead preserve the task result and mark run verification as pending/blocked.

A task envelope should include schema version, run/task/parent IDs, tenant/install scope, objective, specialist ID and source hash, dependency IDs, context/artifact references, allowed capabilities, deadline, attempt, idempotency key, and trace/event correlation IDs. Results include structured output, artifacts, evidence references, usage metadata, and a typed failure if unsuccessful.

## Model and quota policy

- Never promise a fixed token allocation unless the provider contract explicitly supplies it.
- Separate provider-owned quotas from Kuro-chan's own per-install/per-user usage budgets.
- A self-hosted install can use its own keys. A hosted deployment with one upstream key has a shared upstream quota unless the provider offers separate subaccounts.
- Add per-user concurrency/rate controls and global backpressure for hosted mode; do not solve quota contention by merely creating a fresh local counter.
- Track actual upstream usage when returned, estimated usage separately, and unknown usage explicitly.
- No paid fallback unless the user/operator explicitly enables and budgets it.
- No model or provider is considered available merely because a key variable exists; perform safe capability/readiness checks.

## Security model

Treat all model output, imported profiles, fetched web pages, repository content, and MCP tool descriptions as untrusted data. Tool calls are validated against trusted schemas and policy outside the model. Use least privilege, isolated workers, secret redaction, egress controls, path traversal protection, bounded input/output, resource limits, dependency/license scanning, and confirmation for destructive or externally visible actions. Authentication and tenant isolation are required before exposing a hosted multi-user service.

## Phased build order and acceptance gates

### Phase 0: Repair and baseline
- Run CI against the exact current commit and capture failures.
- Fix parser, planner, catalog, lockfile and test issues before layering more features.
- Confirm clean install, build, typecheck, tests and lint pass from a fresh checkout.

### Phase 1: Catalog correctness
- Import all eligible upstream profile files recursively from a pinned commit.
- Validate source-derived IDs, nested profiles, frontmatter, duplicate IDs, empty instructions and provenance.
- Add catalog sync/diff tests and reconcile count against the source tree.
- Acceptance: no silent skips; deterministic inventory; license/NOTICE preserved.

### Phase 2: Task engine reliability
- Formalize schemas and state machine, transactional task claims, heartbeats, stale lease fencing, retry policy, cancellation, idempotency and restart recovery.
- Add concurrency/race/crash-injection tests.
- Acceptance: stale workers cannot commit; no task silently disappears; restart resumes or explicitly fails recoverably.

### Phase 3: OmniRouter reliability
- Add capability/policy filters, provider readiness, safe bounded failover, circuit breakers, per-provider deadlines, cancellation propagation, normalized errors, usage telemetry and privacy/budget constraints.
- Add deterministic fake-provider tests and adapter conformance tests.
- Acceptance: no retry storms, no unsupported capability claims, no hidden paid fallback.

### Phase 4: Real research and tool runtime
- Add source-backed search/fetch/repository/document tools and a typed tool registry.
- Add prompt-injection-resistant evidence handling, SSRF protection, citations and tool permission enforcement.
- Add MCP as an opt-in adapter with a security review.
- Acceptance: each factual research output links to evidence; unauthorized tools fail closed; tool errors are visible.

### Phase 5: Workspace and build workers
- Add safe file read/write/patch tools, Git operations, command execution and isolated build/test workers.
- Add artifact provenance and verification evidence.
- Acceptance: a real sample project can be modified, built, tested, reviewed, and its artifacts inspected without executing untrusted code in the API process.

### Phase 6: Quality, memory and integrations
- Add durable task-scoped context, explicit user-approved long-term memory, GitHub integrations, artifacts, evaluation datasets and regression tests.
- Add voice/media backend adapters after core cancellation and task events are stable.
- Acceptance: memory is scoped and deletable; integrations are permissioned; evaluation results are reproducible.

### Phase 7: Deployment and hosted isolation
- Add PostgreSQL adapter/migrations, authenticated tenants, per-tenant credential handling, remote worker protocol, backups, retention, metrics and deployment hardening.
- Acceptance: cross-tenant isolation tests, backup/restore test, load test, and secrets scan pass.

### Phase 8: Client integration
- Only after backend gates pass, implement the mobile-first client against versioned APIs and streaming task events.

## Definition of done

Kuro-chan is not complete because it has many agent files or a polished chat screen. It is complete only when:
- the source catalog is reconciled and searchable;
- OmniRouter selects models according to explicit capabilities/policy and recovers predictably;
- tasks are durable, cancellable, restart-safe and lease-fenced;
- tools perform real actions under enforceable permissions;
- research results carry evidence;
- project work runs in an isolated execution environment and is independently verified;
- fresh installs are isolated, hosted tenants are enforced, and provider quotas are represented honestly;
- CI passes from a fresh checkout and documented end-to-end acceptance scenarios pass.

"Flawless" is an aspiration, not a test result. Every claim of completion must name the checks that actually passed and the limitations that remain.
