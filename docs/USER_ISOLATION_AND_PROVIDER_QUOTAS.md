# User Isolation and Provider Quotas

## Design contract

Kuro-chan shares its application code and versioned Agency specialist catalog. It does not share private user state by default.

Each installation must start with a new local database, workspace directory, run history, and memory namespace. Imported agent definitions are read-only application assets; personal conversations, credentials, project files, and task outputs are not part of the shared catalog.

For a self-hosted installation, provider credentials are supplied through that installation's server-side environment. Never bake API keys into the mobile/web bundle, commit real credentials, or return them from API endpoints. A public repository may contain variable names and empty example values only. If a credential was ever committed, revoke or rotate it; deleting it from the latest commit does not erase it from Git history.

## What "fresh start" means

- A fresh install has an empty database and workspace unless the user explicitly imports a backup.
- A reinstall does not automatically inherit another install's credentials, run history, files, or memory.
- A hosted multi-user deployment must use authenticated identities and tenant-scoped storage for every run, task, artifact, workspace, audit event, and usage record.
- Workers must verify that a task belongs to the requesting tenant before reading its context or writing its output.
- Logs and diagnostics must redact credentials and avoid storing full prompts or file contents unless explicitly needed and disclosed.

## Provider quota reality

OmniRouter coordinates provider selection, capability checks, bounded retries, failover, circuit breakers, and request accounting. It cannot mint upstream tokens or convert one provider key into separate quotas.

- If every self-hosted installation configures its own provider key, each installation's usage is billed/limited by that provider account.
- If multiple users send requests through one hosted server-side key, they share that key's quota and provider policy unless the upstream service explicitly provides isolated subaccounts/quotas.
- A public API key embedded in a Git repository or client app is not a safe way to provide everyone free access. It can be copied and exhausted by anyone who obtains it.
- "Free" plans, token amounts, rate limits, and model availability are controlled by the provider and can change. Do not promise a fixed billion-token allocation unless the provider contract actually guarantees it.

## Multi-user hosted mode requirements

Before exposing one Kuro-chan service to multiple users, implement and test:

1. Authentication and a stable tenant/user ID.
2. Tenant-scoped database queries and workspace roots, enforced server-side.
3. Encrypted credential storage or a supported bring-your-own-key flow; never plaintext keys in browser storage.
4. Per-user concurrency and rate limits, plus global backpressure to protect the host.
5. Usage accounting from provider-reported token usage where available, clearly distinguishing reported values from estimates.
6. Retention, export, deletion, and backup/restore behavior for each user's data.
7. Tests proving one user cannot access another user's run IDs, files, provider keys, logs, or outputs.

Until these controls exist, run Kuro-chan as a trusted single-user/self-hosted service. Do not claim tenant isolation merely because every task has a run ID.

## Related settings

See `.env.example` for server-side provider configuration. FreeLLMAPI is treated as a configured OpenAI-compatible endpoint; its actual availability and quota depend on the endpoint and upstream service selected by the operator.
