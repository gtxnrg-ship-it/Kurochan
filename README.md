# Kuro-chan

**A mobile-first AI workbench for turning rough ideas into coordinated, verifiable work.**

[![CI](https://github.com/gtxnrg-ship-it/Kurochan/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/gtxnrg-ship-it/Kurochan/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-backend%20%2B%20web-blue)](https://github.com/gtxnrg-ship-it/Kurochan)

> **Status: active development.** The repository contains backend services and an installable web workbench. A public hosted demo is not deployed yet, and there is no native Android/iOS package in this repository. A real provider, speech, and device workflow still needs deployment-specific credentials and end-to-end verification.

## What Kuro-chan is

Kuro-chan is designed to help someone start with a vague goal, clarify what matters, select relevant specialist agents, perform research and tool-based work, and return a clear result with evidence. The aim is to hide unnecessary complexity without hiding failures, costs, approvals, or verification gaps.

### The workbench today

- **Chat:** streamed model responses and retry-safe message IDs.
- **Coordinated runs:** plan a goal, track task states and specialist handoffs, inspect events/evidence, and cancel a run.
- **Specialist library:** search the pinned [Agency Agents](https://github.com/msitarzewski/agency-agents) profiles without treating their instructions as security policy.
- **System health:** inspect API readiness, configured providers, router, worker heartbeats, and speech capabilities.
- **Integration directory:** browse native capabilities and optional MCP connectors, see reported connection state, inspect discovered tools, and copy safe server-side setup examples.
- **Voice turns:** record a clip, send it for transcription, get a routed text response, and play synthesized audio when compatible speech services are configured.

A status badge has a specific meaning: *catalogued* means an option is documented; *configured* means server settings exist; *connected* means the API has reported a successful connection. None of those labels on its own proves that every possible task succeeds.

## Architecture

```text
Installable web client
  -> authenticated Kuro-chan API
     -> durable conversation and run/task store
     -> planner + specialist selector
        -> pinned Agency Agents catalog and NEXUS runbooks
     -> OmniRouter
        -> OpenRouter adapter (optional)
        -> FreeLLMAPI / OpenAI-compatible adapter (optional)
     -> permission-scoped tool registry
        -> workspace, GitHub research, optional Brave search
        -> optional GitHub project connector and isolated sandbox
        -> optional administrator-configured MCP servers
     -> evidence, run events, approval gates and verification
```

OmniRouter is Kuro-chan's routing policy layer, not the OpenRouter service. Providers supply inference; the backend controls specialist selection, tool permissions, task state, bounded retries, approval gates, and verification claims.

## Run the workbench locally

### Requirements

- Node.js 22 or newer
- pnpm 10.9 or newer
- A model provider configured on the server for inference
- Git with the configured submodules available

### Install and start

From the repository root:

```sh
pnpm install --frozen-lockfile
cp .env.example .env
# Edit .env on the server: configure a supported model provider.
pnpm dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). The web client connects to the API at [http://127.0.0.1:8787](http://127.0.0.1:8787) by default. Use **Connection settings** in the app if the API is listening elsewhere or requires `KUROCHAN_API_TOKEN`.

The development command starts the web app, API, and worker. You can also run them individually:

```sh
pnpm dev:web
pnpm dev:api
pnpm dev:worker
```

Keep model-provider credentials, GitHub tokens, Brave keys, speech credentials, and MCP credentials in the server/worker environment or a secret manager. Never put them in browser code, UI settings, chat prompts, or a committed `.env` file.

## Sign in, deploy, and install

The workbench now supports optional first-party **GitHub and Google account sign-in** when the API operator configures OAuth credentials. On an unconfigured local install, the app stays local-first and continues to use the optional API bearer token. Provider buttons only appear when the API reports a provider as configured.

Set `KUROCHAN_PUBLIC_API_URL`, `KUROCHAN_SESSION_SECRET` (at least 32 characters), `WEB_ORIGIN`, and the desired provider's client ID/secret in the server environment. Register the exact callback URL `https://your-api-host/auth/github/callback` or `https://your-api-host/auth/google/callback` with the provider, and set `CORS_ALLOWED_ORIGINS` to the exact web origin. See [authentication setup](docs/AUTHENTICATION_SETUP.md) before exposing the API. Do not deploy the example credentials or bind an unprotected development server to the public internet.

**There is no official hosted Kuro-chan website, public download URL, or native Android/iOS package published by this repository yet.** For now, run the web client locally using the instructions above. Once served from a secure origin, supported browsers can install it as a PWA from their browser's install menu. A public website needs an actual deployment, DNS/TLS configuration, real OAuth client credentials, and live acceptance testing; a README link alone cannot provide that deployment.

## Build, test and quality checks

```sh
pnpm build
pnpm typecheck
pnpm test
pnpm lint
pnpm check
```

`pnpm check` is the full repository gate: pinned catalog/community checks, type checking, build and automated tests, and Prettier validation. CI runs this gate. A green CI run validates the code and automated tests for that commit; it does **not** replace a live provider smoke test or mobile browser/device acceptance test.

## Integration directory

The integration view is the front door for capabilities that are already built in and for optional services the operator can connect.

| Area | Built-in or optional path | Important boundary |
| --- | --- | --- |
| Model providers | OpenRouter and FreeLLMAPI/OpenAI-compatible endpoints | Keys stay server-side; configuration is not the same as live inference. |
| GitHub | Read-only public research; optional authenticated project checkout | Private-repository access requires server credentials and an explicit allowlist. Publishing is separately controlled and approval-gated. |
| Web research | Optional Brave Search | Requires a server-side key; fetched content is untrusted evidence, not instructions. |
| Workspace and commands | Scoped workspace tools; optional Docker sandbox | Sandbox is disabled by default; command execution needs deliberate isolation and limits. |
| Speech | Optional STT + TTS adapter pair | The web UI supports recorded turns. A chosen high-quality realtime speech-to-speech model, duplex audio, interruption handling, naturalness, and latency still need deliberate selection and live evaluation. |
| MCP services | GitHub, Firebase, Supabase, Context7, Playwright and other curated examples; operator-configured MCP servers are extensible | The directory is not an installer. Each server must be configured in the worker environment, probed, permission-checked, and tested. |

For configuration details, see [MCP setup](docs/MCP_TOOLS_SETUP.md), [GitHub projects](docs/GITHUB_PROJECTS_SETUP.md), [web research](docs/WEB_RESEARCH_SETUP.md), [speech](docs/SPEECH_SETUP.md), and the [integration roadmap](docs/INTEGRATION_PACK.md).

### Connect an MCP server

1. Open **Integrations** in the workbench and select a service.
2. Copy its configuration example and merge it into `KUROCHAN_MCP_SERVERS` in the worker/server environment. Keep existing entries.
3. Put actual credential values in the environment variables referenced by the config; the `env` and `headers` maps refer to variable names, not secret values.
4. Restart the worker, then click **Test MCP connections** and inspect discovered tool names and read-only/approval behavior.
5. Start with read-only permissions. Use a scoped identity and test against non-production data before permitting writes.

Kuro-chan's first-party web account sign-in can use GitHub or Google when configured, but that is separate from interactive OAuth inside third-party MCP integrations. The MCP runtime supports local stdio and Streamable HTTP; it does not yet broker interactive OAuth for every hosted MCP provider, so those services remain marked as needing OAuth support rather than showing as connected. Supabase can use its documented project-scoped, read-only URL and a server-side authorization header for non-interactive setup. Firebase's local MCP server uses the Firebase CLI identity on the worker host. See the official provider documentation linked from each card and [MCP_TOOLS_SETUP.md](docs/MCP_TOOLS_SETUP.md).

## Install and use on a phone

The current client is an **installable progressive web app (PWA)** on supported browsers and secure origins. It is not a native APK/IPA. The service worker caches only the app shell, not conversations, run data, credentials, or API responses.

For LAN testing, use a trusted network and configure both servers deliberately. A typical setup needs the web host bound to the LAN interface, the API bound with a strong `KUROCHAN_API_TOKEN`, and the exact client origin in `CORS_ALLOWED_ORIGINS`. Use the phone's reachable API address in Connection settings. For any public deployment, use HTTPS, strict origin allowlists, appropriate network isolation, and server-side secret storage. Do not expose a development API directly to the public internet.

## Voice and media status

The API exposes its actual speech capabilities through `/v1/speech/status`. The current browser workflow records a clip, calls the backend, and retrieves synthesized audio when configured. This is **recorded-turn voice**, not proof of realtime duplex speech or natural, low-latency interruption handling. The exact STT, TTS and speech-to-speech model should be selected from deliberate quality/latency/cost evaluations before those capabilities are advertised as finished.

## Security principles

- Model output, imported agent profiles, repository content, fetched pages, and MCP tool descriptions are untrusted data.
- Tool permissions are enforced by backend code, not by specialist prompts.
- Keep tokens server-side, use least-privilege credentials, and allowlist repositories/projects.
- Actions that write externally or have side effects require explicit approval.
- Never claim a provider, integration, build, test, or deployment was verified unless there is corresponding evidence.

## Project documentation

- [Authentication and OAuth setup](docs/AUTHENTICATION_SETUP.md)
- [Backend architecture and definition of done](docs/TARGET_BACKEND_ARCHITECTURE.md)
- [Engineering foundation](docs/FOUNDATION.md)
- [MCP setup and security](docs/MCP_TOOLS_SETUP.md)
- [Integration roadmap](docs/INTEGRATION_PACK.md)
- [GitHub project connector](docs/GITHUB_PROJECTS_SETUP.md)
- [Speech configuration](docs/SPEECH_SETUP.md)
- [FreeLLMAPI configuration](docs/FREELLMAPI_SETUP.md)
- [Web research setup](docs/WEB_RESEARCH_SETUP.md)

## Upstream attribution

Agency Agents is maintained independently. Kuro-chan pins the exact revision it consumes, preserves applicable license and attribution notices, and treats imported specialist instructions as untrusted content that cannot override application security policy.
