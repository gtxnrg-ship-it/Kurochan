# GitHub project checkout and pull requests

Kuro-chan separates **public GitHub research** from **authenticated project operations**. Public research is read-only. Project checkout and pull-request publication are an optional capability that uses the operator's own server-side GitHub token.

## Enable project checkout

1. Create a GitHub fine-grained personal access token scoped only to the repositories Kuro-chan should modify. Grant **Contents: Read** for checkout.
2. List the exact repositories in `KUROCHAN_GITHUB_ALLOWED_REPOSITORIES`, separated by commas, using `owner/name` names. The runtime refuses repositories outside this allowlist, even when the token could access them.
3. Store the token in the server/worker environment as `KUROCHAN_GITHUB_TOKEN`. Never place it in source code, browser variables, prompts, task artifacts, or logs.
4. Restart the API and worker.

Example configuration:

```dotenv
KUROCHAN_GITHUB_TOKEN=your-own-fine-grained-token
KUROCHAN_GITHUB_ALLOWED_REPOSITORIES=your-account/your-project,another-owner/another-project
KUROCHAN_GITHUB_WRITE_ENABLED=false
KUROCHAN_GITHUB_MAX_FILES=500
KUROCHAN_GITHUB_MAX_FILE_BYTES=250000
KUROCHAN_GITHUB_MAX_TOTAL_BYTES=10000000
```

The values shown are configuration examples, not a supplied credential.

## Workflow

A specialist can use `github.checkout_repository` to load text source into the run-specific workspace. Checkout is bounded by file-count and byte limits; binary, unsafe, secret-like, oversized, and unsupported paths are excluded. The checkout records the original base commit and file hashes outside the sandbox-mounted workspace.

The agent then uses the normal workspace tools and the isolated command sandbox to make and test changes. When appropriate, it can request `github.create_pull_request`. Before that tool executes, Kuro-chan asks for explicit task approval. The operation creates a run-specific branch and a pull request; it does not merge it or deploy the application.

## Enable publishing

Review the allowlist and token permissions first, then set `KUROCHAN_GITHUB_WRITE_ENABLED=true` and restart the worker. The token needs **Contents: Write** and **Pull requests: Write** for the allowed repository. Publishing remains approval-gated by Kuro-chan. Avoid broad classic tokens when a fine-grained token is practical.

The runtime refuses to publish if the base branch moved after checkout, the generated branch name collides with a branch not created by this run, no changes are present, or the repository is not allowlisted. Re-checkout and resolve the work rather than forcing an update.

## Limits and security

- The connector accepts repository names, not arbitrary URLs; API traffic is fixed to `https://api.github.com`.
- Only the exact repository allowlist is accepted. Token values and upstream error bodies are not returned to the agent.
- Workspace content remains scoped to a run. The metadata used to produce the proposed commit is stored outside the Docker-mounted run directory.
- Checkout limits are configurable but bounded. Repositories larger than those limits are rejected rather than silently represented as complete.
- The connector proposes a pull request only. Users retain final control over merge, release, deployment, and other production changes.
- Kuro-chan is not a multi-tenant credential broker. Keep the API bound to loopback unless API authentication and deployment security have been configured.
