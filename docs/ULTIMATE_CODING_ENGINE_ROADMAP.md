# Kuro-chan: Ultimate Open Coding Engine

**Status:** Active build plan  
**Owner:** Kuro-chan maintainers  
**Last updated:** 2026-10-24  
**Canonical repository:** https://github.com/gtxnrg-ship-it/Kurochan  
**Source of truth:** this document + GitHub PRs/issues + code and CI. Update the status here when work lands; never mark a capability complete from design alone.

## Product goal

Build the strongest practical **free, open-source, self-hostable coding agent/workbench** we can: a trustworthy alternative in workflow and usefulness to Cursor and Claude Code, without requiring a paid hosted AI subscription. The product should understand a repository, plan changes, edit multiple files, run checks, diagnose failures, iterate, and show evidence for what it claims.

“Free and open source” means the software can be self-hosted and users can choose local or free-tier model providers. It does **not** mean frontier-quality inference or unlimited GPU/API capacity is free. The system must make provider requirements, limits, latency, privacy, and model trade-offs explicit. Do not promise parity until evaluations demonstrate it.

## Non-negotiable engineering rules

1. **Build on Kuro-chan.** Preserve its TypeScript monorepo, API/worker split, OmniRouter, storage, contracts, and mobile-first workbench unless measured evidence justifies a change.
2. **Backend first, UI second.** Do not spend a sprint polishing screens while core execution, persistence, permissions, and verification are unreliable.
3. **One source of truth.** Durable decisions and progress live in this document and linked PRs/issues—not only in chat. Update the “Current checkpoint” on every meaningful handoff.
4. **No fake completion.** A feature is complete only when implementation, tests, docs, security review where relevant, and CI evidence exist. A configured integration is not proof of successful end-to-end operation.
5. **Small, reviewable increments.** Work on a branch, inspect current code first, add regression tests, run the canonical checks, and open a PR. Never overwrite another branch’s work or silently merge.
6. **Safe by construction.** Model output, repository files, agent profiles, MCP responses, and tool descriptions are untrusted input. Enforce policy in code, not prompts.
7. **Portable by default.** Local development and self-hosting must work without a Kuro-chan-operated cloud. Remote execution is an optional adapter, not a hidden requirement.
8. **Measure coding ability.** Maintain a reproducible task benchmark with pass/fail outcomes, regression rate, tool success, latency, and inference cost. No unsupported “Cursor-level” claims.

## Target system architecture

```text
Workbench (mobile-first PWA; desktop/editor integrations later)
  └─ API: identity, projects, conversations, approvals, streaming, audit
      ├─ Durable run engine: plans, steps, leases, retries, cancel/resume, events
      ├─ Coding agent loop: inspect → plan → retrieve → propose → edit → execute → verify
      ├─ Repository intelligence
      │   ├─ ignore-aware file inventory and bounded file reads
      │   ├─ lexical/FTS search + symbol/reference search
      │   ├─ language-server / Tree-sitter adapters where useful
      │   └─ incremental index, dependency graph, context-budget ranking
      ├─ Change engine: unified diffs, validation, preview, apply, rollback
      ├─ Execution boundary: local sandbox adapter; isolated remote worker adapter
      ├─ Verification: format, lint, typecheck, tests, build, task-specific checks
      ├─ OmniRouter: capability-aware provider selection, bounded retries, health,
      │              transparent limits/usage, local-model support
      ├─ Tool gateway: typed schemas, scoped permissions, approvals, timeouts,
      │                 output caps, secret redaction, audit events
      └─ Storage: users/workspaces, runs, events, artifacts, approvals, usage,
                  migrations, backup/restore
```

Keep the core as a modular monolith with separately runnable API and worker processes until scale or isolation requirements prove a service boundary is needed. Use explicit interfaces for model providers, repository access, command execution, indexing, and persistence.

## Core user journeys that define success

- **Ask:** answer a codebase question with file/line evidence and clear uncertainty.
- **Fix:** reproduce or locate a bug, propose a minimal diff, run relevant tests, iterate on failures, and show the final diff plus test evidence.
- **Build:** implement a multi-file feature against repository conventions, update tests/docs, and explain trade-offs.
- **Review:** identify likely defects/security issues with file/line references and severity, not generic style noise.
- **Understand:** map architecture, call paths, dependencies, symbols, and relevant tests without stuffing the entire repo into model context.
- **Operate safely:** preview and approve destructive/external actions; cancel/resume work; inspect logs/artifacts; recover from provider or worker failure.
- **Choose cost/privacy:** use local models or configured free-tier providers, explain unavailable capabilities, and never silently switch to a paid route.

## Delivery sequence and acceptance gates

### P0 — Establish a trustworthy baseline (current)
- [ ] Inspect the current default branch, open PRs, dependency chains, and CI state before modifying implementation.
- [ ] Review PR #12 (transactional SQLite migrations), PR #13 (incremental FTS5 codebase search), PR #11 (Ajv tool schema validation), PR #10 (optional account isolation), PR #6 (backend reliability), PR #5 (backend completion), and PR #4 (workbench finish). Resolve dependencies and conflicts; do not merge blindly.
- [ ] Run the repository's canonical `pnpm check` in an environment with Node 22+, pnpm 10.9+, and submodules. Record actual output; remote inspection is not a test run.
- [ ] Create a capability matrix from code + tests + CI: working, partial, unimplemented, insecure, or unverified.
- **Gate:** clean CI on the chosen base, explicit PR order, reproducible local setup, and a written list of release blockers.

### P1 — Durable, isolated execution
- [ ] Finish transactional schema migrations and migration rollback/forward compatibility.
- [ ] Make run/task transitions explicit and validated; persist event history; ensure cancellation, retry, resume, and worker lease/heartbeat behavior are deterministic.
- [ ] Enforce workspace/user ownership at every read/write boundary; test cross-user access denial.
- [ ] Add idempotency and crash-recovery tests for repeated requests and worker restarts.
- [ ] Define artifact retention, bounded logs, redaction, backup/restore, and health/readiness semantics.
- **Gate:** deterministic integration tests prove run recovery, ownership isolation, idempotency, and migration safety.

### P2 — Coding agent core
- [ ] Add a first-class coding task type and state machine: inspect → plan → retrieve → propose → apply → execute → verify → summarize.
- [ ] Introduce a repository adapter with ignore rules, safe path resolution, file-size limits, binary detection, and workspace boundary enforcement.
- [ ] Implement patch-first editing: model produces structured edits/unified diff; validate paths and hunks; show preview; apply atomically where possible; preserve rollback.
- [ ] Use bounded tool loops with explicit budgets for turns, tokens, wall time, tool calls, and retries.
- [ ] Persist the plan, decisions, diffs, commands, outputs, verification results, and final evidence as run artifacts.
- **Gate:** an end-to-end benchmark task can fix a seeded bug across multiple files and pass its tests without editing outside the workspace.

### P3 — Repository intelligence
- [ ] Finish incremental FTS5 indexing; verify ignore files, generated files, large repositories, deletions/renames, and index rebuilds.
- [ ] Add symbol/reference search through Tree-sitter or language-server adapters where language support justifies it; do not claim semantic navigation where only text search exists.
- [ ] Rank context using lexical relevance, symbol relations, recency, test proximity, and token budget.
- [ ] Cache summaries/indexes by content hash and invalidate incrementally.
- [ ] Return citations to exact paths and line ranges; measure retrieval precision/recall on a fixture suite.
- **Gate:** repository Q&A and change tasks outperform baseline grep-only retrieval on a fixed, repeatable evaluation set.

### P4 — Safe command execution and verification
- [ ] Specify a sandbox interface before selecting local/remote implementations.
- [ ] Restrict working directory, environment variables, network access, CPU/memory/time, process count, and output size; do not execute untrusted project commands inside the API process.
- [ ] Make command allow/deny policy explicit and approval-aware; secrets are not inherited by default.
- [ ] Detect project tooling and run the narrowest useful checks, then expand to typecheck/build/tests when appropriate.
- [ ] Parse failures into bounded, structured diagnostics and allow a limited repair loop.
- **Gate:** adversarial path, symlink, command, environment, timeout, and resource-limit tests pass; failed checks remain visible and cannot be reported as passed.

### P5 — Model quality, availability, and cost
- [ ] Define provider capability metadata (tool calling, structured output, context size, streaming, vision, embeddings, local/remote).
- [ ] Add health-aware routing and bounded fallback without duplicate retry loops or silent paid-model use.
- [ ] Track per-provider usage, limits, latency, failures, and user-configured budgets; label estimates versus provider-reported usage.
- [ ] Support local OpenAI-compatible endpoints and document practical local model sizing/quality trade-offs.
- [ ] Build a coding evaluation matrix across configured models and task types; select defaults from measured results.
- **Gate:** provider failures recover predictably, routing is explainable, and no request uses a paid route without clear user configuration/consent.

### P6 — Product experience and ecosystem
- [ ] Connect UI state to real run lifecycle, live events, diff review, approvals, artifacts, and cancellation—not simulated success.
- [ ] Make setup and diagnostics actionable on low-resource Android/mobile browsers as well as desktop.
- [ ] Add workspace import/export, Git diff/status support, and safe branch/commit/PR workflows with explicit confirmation.
- [ ] Add MCP/extension integration permissions, trust labels, schema validation, timeouts, quotas, and clear connection diagnostics.
- [ ] Add optional desktop/editor adapters only after the core API contracts are stable.
- **Gate:** documented fresh install works end-to-end, and every displayed capability has a tested real path or is explicitly marked unavailable/preview.

### P7 — Release and maintainability
- [ ] Threat model, dependency/license audit, secret scanning, SBOM, and security disclosure policy.
- [ ] E2E tests, failure injection, performance tests, and a versioned coding benchmark.
- [ ] Document upgrade/rollback, backup/restore, deployment, observability, privacy, and provider setup.
- [ ] Publish versioned releases and a support matrix.
- **Gate:** repeatable release checklist passes from a clean checkout; no unresolved critical/high security blockers.

## Definition of done for any task

Every task must have: (1) a narrowly scoped acceptance criterion, (2) implementation in the repository, (3) automated regression tests, (4) security/permission analysis if it touches tools, files, identity, providers, or execution, (5) formatter/typecheck/build/test results from an actual run, (6) docs/config updates, and (7) a PR or commit link. If environment access prevents verification, mark it **unverified**, state the exact blocker, and do not call it done.

## Current checkpoint — 2026-10-24

- Default branch: `main`, HEAD `9a86bbcaa4859aa677a3966407ac604ab59e41ca`.
- Repository is a public Apache-2.0 TypeScript/pnpm monorepo with API, worker, mobile-first PWA, contracts, storage, model gateway, OmniRouter, orchestrator, tests, and existing architecture/setup docs.
- Existing design docs already cover backend architecture, user isolation/quotas, MCP, integrations, cloud worker/extension, and provider setup. This plan extends those decisions; it does not replace them.
- Open PRs at checkpoint: #4, #5, #6, #10, #11, #12, #13. PR #13 currently targets PR #12's branch, so review and dependency order matter. Inspect live PR status before acting.
- A previous attempt to clone from this environment failed at DNS resolution. The current inspection uses GitHub's repository APIs; **no local clone, install, tests, or build has been run in this session**.
- Immediate next action: inspect the open PR diffs and CI checks; then establish a green base and start P1/P2 implementation in small, testable PRs. Do not begin a competing implementation of functionality already being built in #10–#13.

## Session handoff template

Append one entry per substantial work session:
- Date:
- Base branch + commit:
- Branch / PR:
- Exact files changed:
- Behavior implemented:
- Tests/checks actually run + result:
- Remaining blockers:
- Next concrete action:

## Continuity protocol

At the start of every work session, read this document, inspect current `main` and open PRs, and verify whether the recorded checkpoint is stale. Before ending, update the checkpoint and handoff entry with exact repository state and evidence. Never rely on conversational memory alone.
