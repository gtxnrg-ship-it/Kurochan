# Authentication and account sign-in

Kuro-chan supports two authentication modes:

- **Local-first mode:** if KUROCHAN_API_TOKEN and OAuth are both unset, the API binds to loopback by default and uses the local workspace identity. This keeps a fresh local install simple.
- **Protected mode:** configure a strong KUROCHAN_API_TOKEN for a self-hosted single-user API, or configure OAuth for separate GitHub/Google accounts. Remote binding is refused unless an API token or a valid HTTPS OAuth setup is present.

The UI asks the API which OAuth providers are actually configured. It never displays an always-on login button for an unconfigured provider, and provider client secrets never go to the browser.

## Configure GitHub sign-in

1. Create a GitHub OAuth App in your GitHub account's Developer settings.
2. Set its **Authorization callback URL** to exactly: https://YOUR_API_HOST/auth/github/callback
3. Set the client ID and client secret only in the API environment:

    KUROCHAN_PUBLIC_API_URL=https://YOUR_API_HOST
    WEB_ORIGIN=https://YOUR_WEB_HOST
    CORS_ALLOWED_ORIGINS=https://YOUR_WEB_HOST
    KUROCHAN_SESSION_SECRET=REPLACE_WITH_A_RANDOM_SECRET_AT_LEAST_32_CHARACTERS
    GITHUB_OAUTH_CLIENT_ID=...
    GITHUB_OAUTH_CLIENT_SECRET=...

4. Restart the API and open **Connection settings** in the web workbench. GitHub appears only after /auth/providers reports it as configured.

The app requests only the scopes needed to identify the GitHub user and read a verified primary email when available. A verified GitHub account ID remains the account identity if the user has no public/available email.

## Configure Google sign-in

1. Create an OAuth client in Google Cloud Console. Configure the consent screen and permitted account types for your intended deployment.
2. Add https://YOUR_API_HOST/auth/google/callback as an authorized redirect URI.
3. Set the following in the API environment:

    KUROCHAN_PUBLIC_API_URL=https://YOUR_API_HOST
    WEB_ORIGIN=https://YOUR_WEB_HOST
    CORS_ALLOWED_ORIGINS=https://YOUR_WEB_HOST
    KUROCHAN_SESSION_SECRET=REPLACE_WITH_A_RANDOM_SECRET_AT_LEAST_32_CHARACTERS
    GOOGLE_OAUTH_CLIENT_ID=...
    GOOGLE_OAUTH_CLIENT_SECRET=...

4. Restart the API and confirm that Google appears as configured in Connection settings.

Google sign-in requires the identity service to return a verified email. Do not configure a web origin, callback URL, or public API URL you do not control.

## Session and ownership behavior

OAuth uses a random, short-lived state value bound to an HttpOnly, SameSite=Lax cookie, provider-side code exchange, verified identity lookup, and a one-time code that the browser exchanges for a signed Kuro-chan bearer session. The one-time code is sent in the URL fragment, which is not part of the HTTP request to the web server. The browser removes it from the address bar immediately after handling the redirect.

Session tokens are signed with KUROCHAN_SESSION_SECRET and expire after eight hours. Do not rotate or expose the secret casually: changing it invalidates existing sessions. Conversation and run list/read/write operations are scoped to the signed-in account ID. A caller cannot choose the owner by supplying createdBy in a request. Run artifacts, events, cancellation, and task approvals also check run ownership. Global usage totals are not shown to OAuth users until per-account usage metering exists.

**Current deployment limits:** pending OAuth state and one-time codes are held in the API process memory. Use a single API instance for sign-in until the deployment has a shared state store. Session tokens are stateless, so clearing a token from the browser does not revoke any copy of that token; a copied token can remain valid until its eight-hour expiry. Keep sessions on HTTPS and do not share bearer tokens. A production multi-user service should add persistent revocation, shared OAuth state storage, account/session administration, backups, and independent penetration/load testing before public launch.

## Local development

Leave the OAuth environment variables blank for local-only work. Run pnpm dev and visit http://127.0.0.1:5173. OAuth requires registered provider applications and callback URLs, so it is not expected to work with invented credentials or an undeployed placeholder domain.

## Before public deployment

- Use HTTPS for the web app and API.
- Register only the exact provider callback URLs and web origins.
- Generate a unique KUROCHAN_SESSION_SECRET (at least 32 characters) and store it in a secret manager.
- Keep API/provider client secrets out of browser bundles, logs, screenshots, and chat.
- Confirm that account A cannot access account B's conversations, runs, artifacts, events, approvals, or voice audio.
- Test OAuth denial, expired state, reused one-time code, expired session, provider outage, API restart, and sign-out behavior.
- Do not advertise a hosted site or native app download until that deployment/release exists and has passed real-device acceptance tests.
