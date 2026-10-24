# Connect Kuro-chan to FreeLLMAPI

FreeLLMAPI is an optional, self-hosted OpenAI-compatible inference gateway. Kuro-chan does not create a FreeLLMAPI key, host the FreeLLMAPI service, or invent access to upstream providers. These are two separate components:

1. Run your own FreeLLMAPI instance and add the upstream provider keys you are authorized to use in its dashboard.
2. Copy the **unified API key** from that instance's Keys page.
3. Put that unified key in Kuro-chan's server-side `FREELLMAPI_API_KEY` environment variable.

Official project and installation instructions:

- Repository: https://github.com/tashfeenahmed/freellmapi
- Installation guide: https://github.com/tashfeenahmed/freellmapi/blob/main/docs/en/install/01-install.md

## Configuration

Kuro-chan defaults to the documented local OpenAI-compatible endpoint and FreeLLMAPI's automatic model selector:

```dotenv
FREELLMAPI_BASE_URL=http://127.0.0.1:3001/v1
FREELLMAPI_API_KEY=your-unified-key-from-your-own-instance
FREELLMAPI_MODEL=auto
FREELLMAPI_CAP_STREAMING=true
```

The API key placeholder above is illustrative. Keep the real value in the server/worker environment or a secret manager. Do not put it in frontend variables, source control, client-side storage, logs, prompts, or screenshots. Kuro-chan does not need the individual upstream keys that you added inside FreeLLMAPI.

The default streaming capability reflects FreeLLMAPI's documented OpenAI-compatible streaming surface. To disable it for a deployment, set `FREELLMAPI_CAP_STREAMING=false`. Capability overrides are deliberately explicit because arbitrary compatible endpoints and selected models can differ.

For OpenRouter, `OPENROUTER_API_KEY` is enough to enable the free-only `openrouter/free` router by default; `OPENROUTER_MODEL` can override it. Streaming is enabled by default for this route so it can participate in the normal chat path. Set `OPENROUTER_CAP_STREAMING=false` when you override the model with one that cannot stream. Avoid `openrouter/auto` for a free-first setup because its model choice can have paid token rates.

The default OmniRouter **Auto / Quality** order is FreeLLMAPI first, then OpenRouter's free-only router. **Balanced** uses OpenRouter first. A fallback can happen when the first upstream reports a retryable error before streaming output starts; once a streamed answer has begun, Kuro-chan cannot safely switch providers in the middle of that answer.

## Network address matters

- If Kuro-chan and FreeLLMAPI both run directly on the same machine, `127.0.0.1:3001` is the expected local default.
- If Kuro-chan runs inside a container while FreeLLMAPI runs on the host, `127.0.0.1` inside Kuro-chan's container refers to that container, not the host.
- If both run in Docker, put them on a deliberate shared network and configure the FreeLLMAPI service hostname and port. Prefer HTTPS even on that network. For a trusted, isolated private network that has no TLS, `FREELLMAPI_ALLOW_INSECURE_HTTP=true` explicitly opts in to unencrypted HTTP for FreeLLMAPI only. Treat this as a risk acceptance, not a secure default.
- Remote deployments must use HTTPS. OpenRouter never accepts a non-loopback HTTP endpoint through this opt-in. Do not expose an unauthenticated inference gateway to the public internet.

Do not guess a URL or copy a key from someone else's deployment.

## How to check the connection

1. Start FreeLLMAPI and confirm its dashboard is available.
2. Set Kuro-chan's server-side variables and restart the API/worker so they load the new configuration.
3. Inspect `GET /v1/config` for a secret-free configured status and `GET /v1/omnirouter/status` for routing/circuit health.
4. Make a small request through `POST /v1/chat/completions` using `omni/fast` or `freellmapi/auto`. A successful request proves the inference path was reachable at that moment, not that free-tier quotas will always remain available.

A configured flag only means the required local settings exist. It is not a live health check, and free upstream quotas/models can change. OmniRouter can fail over only to another configured provider that supports the requested capability; it cannot generate new API keys or extra quota.
