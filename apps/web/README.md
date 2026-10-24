# Kuro-chan web workbench

This is the first real client for the Kuro-chan API. It uses browser-native HTML, CSS, and JavaScript, so the UI adds no frontend framework or runtime dependency.

## Run and build

From the repository root:

```sh
pnpm --filter @kurochan/web dev
pnpm --filter @kurochan/web build
pnpm --filter @kurochan/web start
```

The development server binds to `127.0.0.1:5173` by default. Set `WEB_HOST` and `WEB_PORT` to override it. A production build copies the app shell to `apps/web/dist`; the built-in static server can then serve that directory.

## Features

- Streamed assistant chat with retry-safe client message IDs.
- Natural-language goal submission to the backend's planning and coordinated-run endpoint.
- Saved run list, task status, specialist handoffs, evidence, cancellation, and resumable server-sent events.
- Search across the pinned Agency Agents catalog.
- Connection, provider, worker, router, and speech capability diagnostics.
- Mobile navigation, accessible labels, keyboard-friendly composer, installable PWA shell, and shell-only offline cache.

## Data and security

- Conversation and task data stay on the configured API. The service worker explicitly does not cache API routes.
- The API URL is saved in local browser storage. An optional bearer token is held only in session storage for the tab session.
- All API fetches omit ambient browser credentials. User content is rendered as text, not interpolated as HTML.
- Provider and speech keys are server-side configuration; never enter them in this client.
- A configured provider is not proof of live connectivity. Use backend diagnostics to test real provider credentials and review actual speech capabilities before promising realtime voice.
