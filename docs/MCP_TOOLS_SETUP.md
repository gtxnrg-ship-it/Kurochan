# Model Context Protocol (MCP) integrations

Kuro-chan can connect to administrator-configured MCP servers and expose their tools to relevant specialists. This is a shared tool bridge, not a hard-coded list of integrations. It allows a specialist to use a configured tool when its description and schema fit the current task.

The runtime uses the official TypeScript SDK's client transports for local stdio processes and Streamable HTTP servers. MCP SDK v1 documentation: https://ts.sdk.modelcontextprotocol.io/client

## Configuration

Set `KUROCHAN_MCP_SERVERS` in the environment of the **worker process**. The API also loads it for diagnostics and for deployments where `KUROCHAN_WORKER_ENABLED=true`.

The value is a JSON array. Use `[]` to disable MCP. For a local stdio server, provide an explicit command and arguments. For a remote server, use Streamable HTTP over HTTPS (plain HTTP is allowed only for loopback development).

Example stdio configuration:

```json
[
  {
    "id": "local-utilities",
    "name": "Local utility tools",
    "transport": "stdio",
    "command": "node",
    "args": ["/absolute/path/to/trusted-mcp-server.js"],
    "env": {
      "SERVICE_API_TOKEN": "SERVICE_API_TOKEN"
    }
  }
]
```

The `env` map maps the environment variable name expected by the MCP child process to the name of an environment variable already present in Kuro-chan. Put real secrets in the worker's secret environment or secret manager. Do not put their values into `KUROCHAN_MCP_SERVERS`, agent prompts, model-visible tool metadata, or source control.

Example remote configuration:

```json
[
  {
    "id": "internal-knowledge",
    "name": "Internal knowledge tools",
    "transport": "streamable-http",
    "url": "https://mcp.example.com/mcp",
    "headers": {
      "Authorization": "INTERNAL_MCP_AUTH_TOKEN"
    }
  }
]
```

The `headers` map works the same way as the stdio `env` map: each value names an existing environment variable. Do not embed credentials in the URL. Remote MCP URLs must use HTTPS; HTTP is accepted only for local loopback addresses. Avoid public unauthenticated MCP servers and arbitrary executable commands.

## How specialist tools are selected and called

1. Kuro-chan connects to the configured servers and discovers their advertised tool schemas.
2. For each specialist task, Kuro-chan ranks available tool descriptions against the goal, task objective and specialist profile. It provides a bounded set of the most relevant tools with their server IDs, names and input schemas.
3. A model can request `mcp.call` using only the discovered `serverId` and tool name. The server, transport and credentials are fixed by operator configuration and cannot be changed by a model call.
4. A tool is treated as read-only **only** when its MCP server explicitly advertises `annotations.readOnlyHint: true`. Calls without that explicit annotation require per-tool approval. Tool results are bounded and recorded as execution evidence.
5. Inspect `GET /v1/mcp/status?probe=true` to attempt connections and list discovered tools. `GET /v1/worker/status` shows configured MCP server status without initiating the probe.

## Trust and operational limits

MCP servers can access whatever resources are available to their operating-system account or network identity. Use only trusted servers and least-privileged service credentials. Do not give every integration broad administrator credentials. Stdio server commands are spawned directly with fixed configured arguments, not provided by model output.

MCP is optional. If no servers are configured, Kuro-chan continues to work with its built-in workspace, GitHub research, Brave search (when configured), isolated command sandbox (when enabled) and GitHub project connector (when configured). A tool named in a specialist profile is not automatically available unless the required server is configured and its tool is discovered.
