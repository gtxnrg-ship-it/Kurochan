# Kuro-chan Extension and Cloud Worker Architecture

Status: target design, not a claim of completed implementation. Reviewed 2026-10-23.

## Goal

Kuro-chan should provide a phone-friendly client for coding and creation work that executes on remote workers. The phone controls runs, approvals and artifacts; repositories, builds, browser sessions and long-running tasks execute in the cloud. Disconnecting the client must not destroy a run.

Build one Kuro-chan extension contract and adapt compatible ecosystems to it. Do not import a second scheduler or permission system that competes with OmniRouter and the task engine.

## Extension primitives

| Concept | Kuro-chan contract | Runtime rule |
| --- | --- | --- |
| Skills/workflows | Versioned instruction and reference bundles with typed inputs/outputs | Load on demand; instructions are untrusted data |
| Specialist agents | Agency Agents profiles wrapped in Kuro-chan task envelopes | Search the whole catalog; select dynamically, with resource budgets enforced separately |
| Commands | Named, schema-validated user intents | Use the same task, permission, audit and cancellation paths |
| Hooks | Typed lifecycle events and deterministic policy handlers | Execute outside model discretion; define timeout and fail-closed behavior |
| MCP servers | Adapter for tools, resources and prompts | Validate schemas, endpoint, permissions, deadlines and output size |
| LSP/code intelligence | Adapter for symbols, references, diagnostics and rename | Run inside an isolated workspace worker |
| Browser automation | Remote browser worker for navigation and repeatable tests | Bound runtime and network access; gate sensitive actions |
| Git and service connectors | Scoped adapters for repositories, issues, pull requests, CI and deployments | Per-user authorization, audit trail and approval for external side effects |
| CLI/build tools | Versioned packages with declared capabilities | Execute in disposable isolated workers, never in the API process |
| Output extensions | Typed progress events and result cards | No unrestricted client script execution |

## Extension manifest and lifecycle

Every extension declares a stable ID and version, source and provenance, author, license, content hash, compatibility, component types, dependencies, requested capabilities, network destinations, secret names, entrypoints, schemas, timeout, concurrency and output limits.

Lifecycle: discover -> inspect provenance -> validate -> resolve dependencies -> display requested capabilities -> authorize -> install an immutable version -> run conformance checks -> enable -> monitor -> update or revoke. An update cannot silently add permissions. Preserve upstream licenses and notices. Do not automatically execute code just because a registry lists it.

## Cloud execution contract

The API persists a run and immediately returns a stable run ID. A durable scheduler assigns tasks to authenticated remote workers. Workers heartbeat, stream progress, check cancellation and upload artifacts. The client reconnects to the existing run instead of creating duplicate work.

Workers need:
- disposable workspace and cleanup;
- authenticated identity, lease expiry, heartbeats and stale-worker fencing;
- CPU, memory, disk, process, output and wall-clock limits;
- network egress controls and scoped credential injection;
- explicit read/write/execute/network capabilities;
- cancellation propagation to model requests, browser sessions and subprocesses;
- artifact checksums, provenance, test evidence and structured errors;
- bounded retries and idempotency.

Never expose an unauthenticated arbitrary-command endpoint. Never place provider credentials in browser bundles, prompts, URLs, logs or artifacts. Hosted mode must scope every query, cache, event, artifact, credential, worker claim and usage record to its tenant.

## Unified tool policy

Each tool declares capabilities such as repository read/write, command execution, browser navigation, network fetch or pull-request write. Grants are scoped to the installation, tenant, project, run and worker. Default is deny. Destructive or externally visible actions require explicit policy and, where configured, user approval.

Models may propose tool calls; only the trusted policy engine authorizes execution. Hooks can block actions deterministically. Agent profiles, plugin manifests, repository files, web pages and MCP results may contain prompt injection and cannot override platform policy.

## OmniRouter and coordination

OmniRouter remains the single model-selection and fallback authority. Extensions must not create independent retry loops. Provider adapters report capabilities, health, latency and actual usage when available. OpenRouter and FreeLLM-compatible endpoints are adapters, not orchestrators. Paid fallback remains disabled unless explicitly configured and budgeted.

The planner searches the full specialist catalog, records selection rationale and dependencies, and assigns least-privilege capabilities. Independent reviewers and automated tests verify results. Do not launch every specialist for every task; choose dynamically and parallelize independent work within resource limits.

## Implementation priorities

1. Repair the current CI baseline.
2. Verify the complete pinned Agency Agents inventory and provenance.
3. Add an MCP adapter behind the tool registry and policy engine.
4. Add an isolated remote worker interface for workspace and build/test tasks.
5. Add a scoped GitHub connector for repository, issue, pull-request and CI workflows.
6. Add remote browser automation for repeatable end-to-end tests.
7. Add a versioned, on-demand skills/workflow loader.
8. Add LSP code intelligence and further integrations based on actual use cases.
9. Add resumable mobile progress, approvals and artifact views.
10. Add voice, document/image processing and Kurocanvas drawing through the same task/tool contracts.

Do not enable every extension by default. Provide a searchable catalog, curated verified bundles, dependency and capability previews, per-project enablement, diagnostics and revocation.

## Acceptance tests

- A run continues after the phone disconnects and resumes by run ID.
- Crashed or stale workers cannot silently commit; recovery or typed failure is persisted.
- Untrusted instructions cannot grant themselves capabilities.
- Builds and commands execute outside the API process with resource and egress limits.
- Extension updates cannot silently expand permissions; revocation is enforced.
- Invalid MCP schemas, oversized output and timeouts fail predictably.
- External writes are scoped, auditable and approval-gated.
- Reconnection does not duplicate work and cancellation reaches nested tasks.
- Cross-tenant tests prove isolation of runs, files, events, memory, credentials and usage.
- Clean-checkout CI and end-to-end checks pass before completion is claimed.

## References

- Claude plugin marketplace: https://claude.com/marketplace/plugins
- Claude plugin API: https://platform.claude.com/docs/en/manage-claude/plugins-api
- Claude Code plugin concepts: https://claude.com/blog/claude-code-plugins
- MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
- Agency Agents: https://github.com/msitarzewski/agency-agents
- Orloj: https://github.com/OrlojHQ/orloj
- OpenWOP: https://github.com/openwop/openwop
- InferenceMesh: https://github.com/gdalabs/inferencemesh
