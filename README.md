# Kuro-chan

**A mobile-first, tool-using AI workbench powered by a coordinated ecosystem of specialist agents.**

Kuro-chan is being built from a clean foundation. It aims to turn natural-language goals into researched plans, coordinated specialist work, real tool execution, and verifiable deliverables.

## Product principles

- **Reuse proven expertise.** Integrate the upstream [Agency Agents](https://github.com/msitarzewski/agency-agents) catalog and its specialist instructions instead of recreating hundreds of personas.
- **Coordinate only the specialists a task needs.** Route work by capability, make dependencies explicit, run independent work concurrently, and preserve context through structured handoffs.
- **Research before committing to a plan.** Use appropriate web, repository, documentation, and project tools; distinguish evidence from assumptions.
- **Execute, don't simulate.** Agents must use permission-scoped tools and real execution workers. A persona prompt is not a substitute for a compiler, terminal, browser, or API connection.
- **Verify outcomes.** Treat tests, artifacts, tool results, and review evidence as the basis for completion claims.
- **Mobile-first by design.** Make the phone a capable control surface, while delegating heavy builds and untrusted execution to isolated workers where appropriate.
- **Provider-independent intelligence.** Keep the model gateway separate from orchestration and support provider adapters such as OpenRouter and the intended free-LLM API integration without exposing secrets to the client.
- **Safe by construction.** Use explicit permissions, scoped credentials, task limits, cancellation, checkpoints, and confirmation for destructive or external actions.
- **No fake completeness.** Mark features as implemented only when they exist and the relevant checks pass.

## Architecture direction

The initial architecture is organized around clear boundaries:

1. **Client:** responsive mobile-first workspace for conversations, plans, task activity, approvals, outputs, and provider settings.
2. **API and orchestration:** durable task lifecycle, planning, specialist selection, delegation, dependencies, retries, cancellation, and result aggregation.
3. **Agent catalog:** pinned and validated upstream definitions with metadata, search, attribution, and reproducible sync.
4. **Model gateway:** provider-neutral requests, capability-aware routing, timeout and retry policy, fallback, and usage accounting.
5. **Tool and worker runtime:** controlled filesystem, repository, research, build, and test capabilities behind explicit permissions.
6. **Verification and observability:** structured events, evidence references, diagnostics, and honest completion states.

These are target boundaries, not a claim that all of them are implemented today. The project will grow through small, reviewable, tested changes.

## Development status

The repository has just been reset to its clean starting point. Implementation is in progress; the description above is the intended product direction, not a feature-completion claim.

See [docs/FOUNDATION.md](docs/FOUNDATION.md) for the initial engineering contract and sequencing.

## Upstream attribution

The Agency Agents catalog is maintained independently by its upstream authors. Kuro-chan will pin the exact upstream revision it consumes, preserve applicable license and attribution notices, and validate imported definitions before use. The catalog's instructions are treated as untrusted input and cannot override Kuro-chan's security policy.
