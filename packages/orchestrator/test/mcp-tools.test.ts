import { describe, expect, it, vi } from "vitest";
import {
  McpToolRuntime,
  redactMcpSensitiveValues,
  type McpClientAdapter,
  type McpServerConfig,
} from "../src/mcp-tools.js";

const readonlyTool = {
  name: "search_records",
  description: "Search read-only records by query",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
  annotations: { readOnlyHint: true },
};

function adapter(
  tools: readonly {
    name: string;
    description?: string;
    inputSchema?: unknown;
    annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  }[],
  callTool: (
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<unknown> = async (name, args) => ({
    isError: false,
    content: [{ type: "text", text: name + ":" + JSON.stringify(args) }],
  }),
): McpClientAdapter {
  return {
    connect: vi.fn(async () => undefined),
    listTools: vi.fn(async () => ({ tools })),
    callTool: vi.fn(callTool),
    close: vi.fn(async () => undefined),
  };
}

const serverConfig: McpServerConfig = {
  id: "records",
  name: "Records MCP",
  transport: "stdio",
  command: "node",
  args: ["/opt/trusted-mcp-server.js"],
  env: { SERVICE_TOKEN: "SERVICE_TOKEN" },
};

describe("McpToolRuntime", () => {
  it("stays disabled when no MCP servers are configured", async () => {
    const runtime = new McpToolRuntime({ servers: [] });
    expect(runtime.isConfigured).toBe(false);
    expect(runtime.configuredServers()).toEqual([]);
    expect(await runtime.listTools()).toEqual([]);
    expect(runtime.status()).toEqual([]);
    await runtime.close();
  });

  it("rejects unsafe remote endpoints, embedded credentials, duplicate IDs, and invalid stdio paths", () => {
    expect(
      () =>
        new McpToolRuntime({
          servers: [
            {
              id: "remote",
              name: "Remote",
              transport: "streamable-http",
              url: "http://mcp.example.com/mcp",
            },
          ],
        }),
    ).toThrow(/HTTPS/);

    expect(
      () =>
        new McpToolRuntime({
          servers: [
            {
              id: "remote",
              name: "Remote",
              transport: "streamable-http",
              url: "https://user:secret@mcp.example.com/mcp",
            },
          ],
        }),
    ).toThrow(/credentials/);

    expect(
      () =>
        new McpToolRuntime({
          servers: [serverConfig, serverConfig],
        }),
    ).toThrow(/unique/);

    expect(
      () =>
        new McpToolRuntime({
          servers: [
            {
              ...serverConfig,
              cwd: "relative/path",
            },
          ],
        }),
    ).toThrow(/absolute path/);
  });

  it("discovers schemas, reports explicit read-only annotations, and dispatches a selected tool", async () => {
    const client = adapter([
      readonlyTool,
      {
        name: "create_record",
        description: "Create a record",
        inputSchema: {
          type: "object",
          properties: { title: { type: "string" } },
        },
      },
    ]);
    const factory = vi.fn(
      (_config: McpServerConfig, _environment: NodeJS.ProcessEnv) => client,
    );
    const runtime = new McpToolRuntime({
      servers: [serverConfig],
      environment: { SERVICE_TOKEN: "a-secret-value" },
      connectorFactory: factory,
    });

    const tools = await runtime.listTools();
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({
      serverId: "records",
      serverName: "Records MCP",
      name: "create_record",
      readOnly: false,
    });
    expect(tools.find((tool) => tool.name === "search_records")).toMatchObject({
      readOnly: true,
      inputSchema: {
        type: "object",
        required: ["query"],
      },
    });
    expect(JSON.stringify(tools)).not.toContain("a-secret-value");
    expect(runtime.status()).toContainEqual(
      expect.objectContaining({
        id: "records",
        connected: true,
        toolCount: 2,
      }),
    );

    const result = await runtime.execute({
      serverId: "records",
      toolName: "search_records",
      arguments: { query: "billing" },
    });
    expect(result).toMatchObject({
      name: "mcp.call",
      ok: true,
      tool: { serverId: "records", name: "search_records", readOnly: true },
      result: {
        isError: false,
        content: [{ text: 'search_records:{"query":"billing"}' }],
      },
    });
    expect(client.callTool.mock.calls[0]?.slice(0, 2)).toEqual([
      "search_records",
      { query: "billing" },
    ]);
    expect(client.callTool.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);
    await runtime.close();
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("propagates caller cancellation to an in-flight MCP tool call", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let observedSignal: AbortSignal | undefined;
    const client = adapter([readonlyTool], async (_name, _args, signal) => {
      observedSignal = signal;
      markStarted();
      return await new Promise<unknown>((_resolve, reject) => {
        const rejectIfAborted = () => reject(new Error("MCP call aborted."));
        if (signal?.aborted) {
          rejectIfAborted();
          return;
        }
        signal?.addEventListener("abort", rejectIfAborted, { once: true });
      });
    });
    const runtime = new McpToolRuntime({
      servers: [serverConfig],
      connectorFactory: () => client,
      timeoutMs: 10_000,
    });
    const abort = new AbortController();

    const pending = runtime.execute(
      {
        serverId: "records",
        toolName: "search_records",
        arguments: { query: "unfinished request" },
      },
      abort.signal,
    );
    await started;
    abort.abort();

    await expect(pending).resolves.toMatchObject({
      name: "mcp.call",
      ok: false,
      error: { code: "cancelled" },
    });
    expect(observedSignal?.aborted).toBe(true);
    await runtime.close();
  });

  it("redacts credential fields and token-shaped strings from tool results", async () => {
    const githubToken = "ghp_" + "A".repeat(36);
    const bearerToken = "B".repeat(40);
    const client = adapter([readonlyTool], async () => ({
      isError: false,
      credentials: {
        access_token: "access-secret",
        refreshToken: "refresh-secret",
        token: "generic-token-secret",
        nested: { password: "password-secret" },
      },
      content: [
        { type: "text", text: "Authorization: Bearer " + bearerToken },
        { type: "text", text: "GitHub token: " + githubToken },
        { type: "text", text: "A safe status message." },
      ],
    }));
    const runtime = new McpToolRuntime({
      servers: [serverConfig],
      connectorFactory: () => client,
    });

    const result = await runtime.execute({
      serverId: "records",
      toolName: "search_records",
      arguments: { query: "status" },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("access-secret");
    expect(serialized).not.toContain("refresh-secret");
    expect(serialized).not.toContain("generic-token-secret");
    expect(serialized).not.toContain("password-secret");
    expect(serialized).not.toContain(bearerToken);
    expect(serialized).not.toContain(githubToken);
    expect(serialized).toContain("A safe status message.");
    expect(serialized).toContain("[REDACTED_SECRET]");
    await runtime.close();
  });

  it("redacts secrets from MCP connection health errors", async () => {
    const client = adapter([readonlyTool]);
    client.connect = vi.fn(async () => {
      throw Object.assign(
        new Error("Connection failed with token=health-secret-value"),
        { code: "connect_failed" },
      );
    });
    const runtime = new McpToolRuntime({
      servers: [serverConfig],
      connectorFactory: () => client,
    });

    expect(await runtime.listTools()).toEqual([]);
    const status = JSON.stringify(runtime.status());
    expect(status).not.toContain("health-secret-value");
    expect(status).toContain("[REDACTED_SECRET]");
    await runtime.close();
  });

  it("redacts secrets in exceptions thrown by an MCP server", async () => {
    const client = adapter([readonlyTool], async () => {
      throw Object.assign(
        new Error("Request failed with token=exception-secret-value"),
        { code: "upstream_failed" },
      );
    });
    const runtime = new McpToolRuntime({
      servers: [serverConfig],
      connectorFactory: () => client,
    });
    const result = await runtime.execute({
      serverId: "records",
      toolName: "search_records",
      arguments: { query: "status" },
    });
    expect(JSON.stringify(result)).not.toContain("exception-secret-value");
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "upstream_failed",
        message: expect.stringContaining("[REDACTED_SECRET]"),
      },
    });
    await runtime.close();
  });

  it("returns a typed error for undefined or non-JSON MCP results", async () => {
    const client = adapter([readonlyTool], async () => undefined);
    const runtime = new McpToolRuntime({
      servers: [serverConfig],
      connectorFactory: () => client,
    });

    const result = await runtime.execute({
      serverId: "records",
      toolName: "search_records",
      arguments: { query: "status" },
    });
    expect(result).toMatchObject({
      name: "mcp.call",
      ok: false,
      error: {
        code: "invalid_result",
        message:
          "MCP tool returned a value that cannot be represented as JSON.",
      },
    });
    await runtime.close();
  });

  it("redacts sensitive values when preparing approval previews", () => {
    const safe = redactMcpSensitiveValues({
      query: "find records",
      authorization: "Bearer B".repeat(20),
      connection: {
        apiKey: "visible-key",
        status: "healthy",
      },
    });
    expect(safe).toEqual({
      query: "find records",
      authorization: "[REDACTED_SECRET]",
      connection: {
        apiKey: "[REDACTED_SECRET]",
        status: "healthy",
      },
    });
  });

  it("validates tool arguments against the discovered input schema before dispatch", async () => {
    const writeTool = {
      name: "create_record",
      description: "Create a record with a bounded title",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1, maxLength: 80 },
          visibility: { type: "string", enum: ["private", "team"] },
        },
        required: ["title"],
        additionalProperties: false,
      },
    };
    const client = adapter([writeTool]);
    const runtime = new McpToolRuntime({
      servers: [serverConfig],
      connectorFactory: () => client,
    });

    const invalidType = await runtime.execute({
      serverId: "records",
      toolName: "create_record",
      arguments: { title: 123 },
    });
    expect(invalidType).toMatchObject({
      ok: false,
      error: { code: "invalid_tool_arguments" },
    });

    const invalidField = await runtime.execute({
      serverId: "records",
      toolName: "create_record",
      arguments: { title: "Quarterly report", visibility: "public" },
    });
    expect(invalidField).toMatchObject({
      ok: false,
      error: { code: "invalid_tool_arguments" },
    });

    const unexpectedField = await runtime.execute({
      serverId: "records",
      toolName: "create_record",
      arguments: { title: "Quarterly report", admin: true },
    });
    expect(unexpectedField).toMatchObject({
      ok: false,
      error: { code: "invalid_tool_arguments" },
    });
    expect(client.callTool).not.toHaveBeenCalled();

    const valid = await runtime.execute({
      serverId: "records",
      toolName: "create_record",
      arguments: { title: "Quarterly report", visibility: "team" },
    });
    expect(valid).toMatchObject({ ok: true });
    expect(client.callTool).toHaveBeenCalledOnce();
    await runtime.close();
  });

  it("validates standard JSON Schema constraints and dialect-specific keywords", async () => {
    const client = adapter([
      {
        name: "submit_profile",
        inputSchema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {
            email: { type: "string", format: "email" },
            slug: {
              type: "string",
              pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
            },
            kind: { type: "string", enum: ["general", "repository"] },
            repository: { type: "string", minLength: 1 },
            labels: {
              type: "array",
              prefixItems: [{ type: "string" }],
              items: { type: "string" },
            },
          },
          required: ["email", "slug", "kind"],
          if: {
            properties: { kind: { const: "repository" } },
            required: ["kind"],
          },
          then: { required: ["repository"] },
          additionalProperties: false,
        },
      },
    ]);
    const runtime = new McpToolRuntime({
      servers: [serverConfig],
      connectorFactory: () => client,
    });

    const invalidFormat = await runtime.execute({
      serverId: "records",
      toolName: "submit_profile",
      arguments: {
        email: "not-an-email",
        slug: "valid-slug",
        kind: "general",
      },
    });
    expect(invalidFormat).toMatchObject({
      ok: false,
      error: { code: "invalid_tool_arguments" },
    });

    const invalidConditional = await runtime.execute({
      serverId: "records",
      toolName: "submit_profile",
      arguments: {
        email: "user@example.com",
        slug: "valid-slug",
        kind: "repository",
      },
    });
    expect(invalidConditional).toMatchObject({
      ok: false,
      error: { code: "invalid_tool_arguments" },
    });

    const valid = await runtime.execute({
      serverId: "records",
      toolName: "submit_profile",
      arguments: {
        email: "user@example.com",
        slug: "valid-slug",
        kind: "repository",
        repository: "owner/project",
        labels: ["backend", "security"],
      },
    });
    expect(valid).toMatchObject({ ok: true });
    expect(client.callTool).toHaveBeenCalledOnce();
    await runtime.close();
  });

  it("fails closed on unknown schema dialects and unresolved external references", async () => {
    const client = adapter([
      {
        name: "unknown_dialect",
        inputSchema: {
          $schema: "https://example.invalid/draft/9999/schema",
          type: "object",
        },
      },
      {
        name: "external_reference",
        inputSchema: {
          $schema: "http://json-schema.org/draft-07/schema#",
          type: "object",
          properties: {
            value: { $ref: "https://example.invalid/schema.json" },
          },
        },
      },
    ]);
    const runtime = new McpToolRuntime({
      servers: [serverConfig],
      connectorFactory: () => client,
    });

    for (const toolName of ["unknown_dialect", "external_reference"]) {
      const result = await runtime.execute({
        serverId: "records",
        toolName,
        arguments: { value: "anything" },
      });
      expect(result).toMatchObject({
        ok: false,
        error: { code: "invalid_tool_schema" },
      });
    }
    expect(client.callTool).not.toHaveBeenCalled();
    await runtime.close();
  });

  it("fails closed when a discovered tool advertises an unsupported input schema", async () => {
    const client = adapter([
      {
        name: "unexpected_schema",
        inputSchema: { type: "string" },
      },
    ]);
    const runtime = new McpToolRuntime({
      servers: [serverConfig],
      connectorFactory: () => client,
    });
    const result = await runtime.execute({
      serverId: "records",
      toolName: "unexpected_schema",
      arguments: {},
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_tool_schema" },
    });
    expect(client.callTool).not.toHaveBeenCalled();
    await runtime.close();
  });

  it("coalesces simultaneous server connections and caches discovery", async () => {
    const client = adapter([readonlyTool]);
    const runtime = new McpToolRuntime({
      servers: [serverConfig],
      connectorFactory: () => client,
    });

    const [first, second, third] = await Promise.all([
      runtime.listTools(),
      runtime.listTools(),
      runtime.listTools(),
    ]);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(third).toHaveLength(1);
    expect(client.connect).toHaveBeenCalledOnce();
    expect(client.listTools).toHaveBeenCalledOnce();
    await runtime.close();
  });

  it("rejects unknown tools and bounds MCP results", async () => {
    const client = adapter([readonlyTool], async () => ({
      isError: false,
      content: [{ type: "text", text: "x".repeat(5_000) }],
    }));
    const runtime = new McpToolRuntime({
      servers: [serverConfig],
      connectorFactory: () => client,
      maxResultCharacters: 1_000,
    });

    const unknown = await runtime.execute({
      serverId: "records",
      toolName: "arbitrary_unknown_tool",
      arguments: {},
    });
    expect(unknown).toMatchObject({
      ok: false,
      error: { code: "unknown_tool" },
    });
    expect(client.callTool).not.toHaveBeenCalled();

    const oversized = await runtime.execute({
      serverId: "records",
      toolName: "search_records",
      arguments: { query: "large" },
    });
    expect(oversized).toMatchObject({
      ok: false,
      error: { code: "result_too_large" },
    });
    await runtime.close();
  });

  it("loads an operator-owned server list from environment JSON and enforces the config byte limit", () => {
    const raw = JSON.stringify([serverConfig]);
    const runtime = McpToolRuntime.fromEnvironment({
      KUROCHAN_MCP_SERVERS: raw,
    });
    expect(runtime.isConfigured).toBe(true);
    expect(runtime.configuredServers()).toEqual([
      {
        id: "records",
        name: "Records MCP",
        transport: "stdio",
      },
    ]);

    expect(() =>
      McpToolRuntime.fromEnvironment({
        KUROCHAN_MCP_SERVERS: "x".repeat(128_001),
      }),
    ).toThrow(/128 KB/);
  });
});
