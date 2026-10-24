# Kuro-chan

**A mobile-first AI workbench for natural-language coding and research, powered by coordinated specialist agents.**

[![CI](https://github.com/gtxnrg-ship-it/Kurochan/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/gtxnrg-ship-it/Kurochan/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-backend%20%2B%20web-blue)](https://github.com/gtxnrg-ship-it/Kurochan)

> **Project status:** Active development. The repository contains a working web-client codebase and backend services. A public hosted demo is **not deployed yet**, so there is no live app URL to click today. We will add one here after the frontend and API are deployed and verified together.

## Explore Kuro-chan

- **[Web workbench source](apps/web/README.md)**: client features, mobile/PWA behavior, voice setup, and security notes.
- **[Run the workbench locally](#run-the-full-workbench-locally)**: start the web app, API, and worker together.
- **[Backend architecture](docs/TARGET_BACKEND_ARCHITECTURE.md)**: how planning, specialist agents, routing, tools, and verification fit together.
- **[Engineering foundation](docs/FOUNDATION.md)**: project principles and acceptance expectations.
- **[CI checks](https://github.com/gtxnrg-ship-it/Kurochan/actions)** · **[Source code](https://github.com/gtxnrg-ship-it/Kurochan)** · **[Issues and ideas](https://github.com/gtxnrg-ship-it/Kurochan/issues)**

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
Client (mobile-first installable web app)
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

## Run the full workbench locally

Requirements: Node.js 22+ and pnpm 10.9+.

```sh
pnpm install --frozen-lockfile
cp .env.example .env
# Configure at least one model provider in .env on the server side.
pnpm dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). The web workbench connects to the API at `http://127.0.0.1:8787` by default. Use **Connection settings** in the workbench to change the API address or provide `KUROCHAN_API_TOKEN` when the API requires it. Provider keys belong in the server environment, never in the browser.

The web app includes streamed chat, coordinated run creation and monitoring, resumable run events, specialist search, and API/provider/worker/speech diagnostics. It is an installable PWA on supported browsers and secure origins. It caches only the app shell, never conversation or API data.

For phone-on-LAN testing, bind the web server with `WEB_HOST=0.0.0.0`, set `HOST=0.0.0.0` and a strong `KUROCHAN_API_TOKEN` for the API, and allow the exact web origin in `CORS_ALLOWED_ORIGINS`. Do this only on a trusted network. A production deployment should use HTTPS and a reverse proxy or hosted static origin.

The current speech backend reports its actual configured capabilities in `/v1/speech/status`. A recorded-audio turn is not the same thing as realtime duplex voice; the final speech-to-speech provider and naturalness/latency target still need a deliberate selection and live evaluation.
 
## Upstream attribution

Agency Agents is maintained independently. Kuro-chan pins the exact revision it consumes, preserves applicable license and attribution notices, and treats imported agent instructions as untrusted content that cannot override application security policy.
