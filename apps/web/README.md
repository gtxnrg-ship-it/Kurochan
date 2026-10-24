# Kuro-chan web workbench

The web workbench is the mobile-first browser client for the Kuro-chan API. It uses browser-native HTML, CSS, and JavaScript, so the client adds no frontend framework or runtime dependency. It can be installed as a PWA on supported browsers and secure origins; it is not a native Android/iOS package.

There is no public hosted demo or app-store/download artifact published by this repository yet. To use the product today, run the web client and API using the instructions below. For an installable phone experience, serve the web client from HTTPS and use the browser's **Install app** / **Add to Home screen** command.

## Run and build

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @kurochan/web dev
```

The development server binds to `127.0.0.1:5173` by default. Set `WEB_HOST` and `WEB_PORT` to override it. The API defaults to `http://127.0.0.1:8787`. Use **Connection settings** in the client to change the API address and enter a bearer token only when the API requires one.

## Account sign-in

GitHub and Google sign-in are available only when the API operator configures them. Set `KUROCHAN_PUBLIC_API_URL`, a unique `KUROCHAN_SESSION_SECRET` of at least 32 characters, the exact `WEB_ORIGIN`, and the chosen provider's OAuth client ID/secret in the server environment. Register the callback URL shown in [authentication setup](../../docs/AUTHENTICATION_SETUP.md). The web app discovers enabled providers from the API; it does not pretend unconfigured providers are connected.

OAuth sessions last eight hours. The browser keeps the session token in tab-scoped session storage, not the URL or long-term local storage. Sign out removes the browser-held token. Until token revocation is configured for a multi-instance deployment, a copied bearer token remains valid until it expires, so use HTTPS and never share it. Local installs can continue using a local API without OAuth.

Build the static shell and serve it with the built-in server:

```sh
pnpm --filter @kurochan/web build
pnpm --filter @kurochan/web start
```

The build copies `apps/web/public` into `apps/web/dist`.

## Screens and behaviors

- **Chat:** streamed assistant responses, retry-safe client message IDs, model profile selection, and recorded voice turns when the server supports both transcription and synthesis.
- **Task runs:** inspect plans, specialist handoffs, task status, evidence and run events; cancel work; resume event streams using persisted event IDs.
- **Specialists:** search the pinned Agency Agents catalog.
- **Integrations:** browse built-in capabilities and curated MCP service examples, filter by provider/category/type, inspect current server-reported status, examine discovered tool names and permission labels, and copy configuration examples or official setup links.
- **System health:** see API reachability/readiness, providers, worker status/heartbeats, router diagnostics and actual speech capability flags.
- **Mobile shell:** collapsible navigation, touch-sized controls, accessible labels, keyboard-friendly composer, safe-area spacing, reduced-motion support, and an installable app shell.
- **Offline behavior:** the service worker can load the shell while offline. It never caches conversation data, API responses, tokens, run events, or artifacts.

## Integrations: how status works

The Integration directory distinguishes these states rather than assuming everything is ready:

- **Built in / ready:** the relevant backend capability exists, subject to the displayed limits.
- **Configured:** the server reports configuration, but a successful real request may still need to be tested.
- **Connected:** the API reports the MCP server as connected.
- **Probe to verify:** an MCP server configuration exists, but a fresh probe has not confirmed reachability or tool discovery.
- **Needs setup / operator setup:** the service requires server-side configuration.
- **OAuth support needed:** the service requires an interactive OAuth flow not currently brokered by Kuro-chan's MCP transport.

The directory is a curated starting point plus an extensible MCP bridge, not an exhaustive catalog of every service and not a one-click installer. For a compatible service, configure its official/reviewed MCP server in `KUROCHAN_MCP_SERVERS` in the worker environment. The environment/header maps contain **names of environment variables**, never real credential values. Restart the worker and use **Test MCP connections** to verify discovery.

The GitHub project connector is separate from GitHub's MCP server. Its native private-repository workflow requires a server-side token and repository allowlist; publishing stays separately disabled by default and each external write requires approval. Firebase MCP runs as a local stdio process under the Firebase CLI identity on the worker host. Supabase supports a project-scoped read-only URL and a server-side authorization header for non-interactive clients. Figma, Linear and Notion are shown as OAuth-dependent because the current Kuro-chan runtime does not yet perform their interactive hosted OAuth handshakes.

Read [MCP_TOOLS_SETUP.md](../../docs/MCP_TOOLS_SETUP.md) before enabling servers. Never test broad write scopes against production databases or accounts.

## Voice setup

The **Voice turn** button uses the recorded-audio pipeline, not a realtime duplex session. Configure a compatible speech-to-text and text-to-speech provider in the server environment. Keep any speech API credentials server-side. Browser microphone access requires a secure context, normally HTTPS on a phone.

A voice response is available only when the API's `/v1/speech/status` endpoint reports the required capabilities. This does not imply that a high-quality realtime speech-to-speech model, natural voice, interruption handling, or target latency has been selected or tested. Those require provider choice and live evaluation.

## Security

- Conversation and task data remain on the configured API. The service worker never caches API routes.
- The API base URL is saved in browser local storage; a bearer token is held only in session storage for the tab session.
- All API fetches omit ambient browser credentials and use bounded, explicit API routes.
- User/model/provider text is inserted as text, not evaluated as HTML.
- Provider, GitHub, speech and MCP credential values must never be entered into chat or stored in the web bundle.
- Remote deployments should use HTTPS, strict CORS origins, strong API authentication, and a trusted worker host.

## Checks

From the repository root:

```sh
pnpm --filter @kurochan/web build
pnpm --filter @kurochan/web typecheck
pnpm test
pnpm lint
```

The web `typecheck` script syntax-checks browser/server JavaScript files and validates the app-shell asset references. The repository test command runs Vitest tests, including API-client and integration-directory tests.
