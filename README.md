# Kuro-chan

**A mobile-first, tool-using AI workbench powered by a coordinated ecosystem of specialist agents.**

Kuro-chan is being built from a clean foundation. It aims to turn natural-language goals into researched plans, coordinated specialist work, real tool execution, and verifiable deliverables.

## Product principles

- **Reuse expertise:** integrate the upstream [Agency Agents](https://github.com/msitarzewski/agency-agents) catalog rather than recreating hundreds of specialist personas.
- **Orchestrate with OmniRouter:** Kuro-chan's internal routing layer chooses configured model providers based on route profile, availability, bounded failover, and policy. OmniRouter is not the same thing as OpenRouter.
- **Treat providers as adapters:** OpenRouter and a configured FreeLLMAPI/OpenAI-compatible endpoint can serve as upstream inference providers. They do not own Kuro-chan's orchestration.
- **Research before planning:** gather evidence from relevant web sources, repositories, documentation, and project files.
- **Execute, don't simulate:** specialist prompts need real tools, permission-scoped workspaces, and execution workers.
- **Verify outcomes:** tests, artifacts, tool results, and review evidence drive completion claims.
- **Mobile-first by design:** the phone is the control surface. Heavy builds and untrusted code run in isolated workers.
- **Safe by construction:** credentials remain server-side; permissions are scoped; destructive or external actions require approval.
- **No fake completeness:** a visible screen or an untested stub does not count as a completed feature.

## Backend architecture

```text
Client (later; backend-first build)
  -> Kuro-chan API
     -> durable run/task store and worker queue
     -> planner + specialist selector
        -> pinned Agency Agents catalog
     -> OmniRouter (Kuro-chan-owned policy and routing)
        -> OpenRouter provider adapter (optional)
        -> FreeLLMAPI / OpenAI-compatible endpoint adapter (optional)
     -> permission-scoped tools and isolated workers
     -> evidence, audit events, and verification
```

OmniRouter owns route profiles, provider selection, retry limits, circuit breakers, and normalized failures. An upstream provider never receives an agent's tool permissions and is never trusted to decide that a task is complete.

## Development status

Implementation is in progress. See [docs/FOUNDATION.md](docs/FOUNDATION.md) for engineering principles and acceptance expectations. Features are not considered complete until implementation and relevant tests exist.

## Upstream attribution

Agency Agents is maintained independently. Kuro-chan pins the exact revision it consumes, preserves applicable license and attribution notices, and treats imported agent instructions as untrusted content that cannot override application security policy.
