import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

const ServerIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/);
const EnvironmentNameSchema = z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/);
const StdioServerSchema = z
  .object({
    id: ServerIdSchema,
    name: z.string().trim().min(1).max(120),
    transport: z.literal("stdio"),
    command: z.string().trim().min(1).max(500),
    args: z.array(z.string().max(2_000)).max(100).default([]),
    cwd: z.string().min(1).max(2_000).optional(),
    // Map MCP-process variable names to names in Kuro-chan's process environment.
    env: z.record(EnvironmentNameSchema, EnvironmentNameSchema).default({}),
  })
  .strict();

const HttpServerSchema = z
  .object({
    id: ServerIdSchema,
    name: z.string().trim().min(1).max(120),
    transport: z.literal("streamable-http"),
    url: z.string().url().max(2_000),
    // Map HTTP header names to names in Kuro-chan's process environment.
    headers: z
      .record(
        z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,79}$/),
        EnvironmentNameSchema,
      )
      .default({}),
  })
  .strict();

export const McpServerConfigSchema = z.discriminatedUnion("transport", [
  StdioServerSchema,
  HttpServerSchema,
]);
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

const McpCallArgsSchema = z
  .object({
    serverId: ServerIdSchema,
    toolName: z.string().trim().min(1).max(200),
    arguments: z.record(z.unknown()).default({}),
  })
  .strict();

export type McpToolDescriptor = {
  readonly serverId: string;
  readonly serverName: string;
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly readOnly: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
};

type RawMcpTool = {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly annotations?: {
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
    readonly openWorldHint?: boolean;
  };
};

export interface McpClientAdapter {
  connect(): Promise<void>;
  listTools(): Promise<{ readonly tools: readonly RawMcpTool[] }>;
  callTool(name: string, arguments_: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export type McpEnvironment = Readonly<Record<string, string | undefined>>;

export interface McpToolRuntimeOptions {
  readonly servers: readonly unknown[];
  readonly environment?: McpEnvironment;
  readonly connectorFactory?: (
    server: McpServerConfig,
    environment: McpEnvironment,
  ) => McpClientAdapter;
  readonly maxServers?: number;
  readonly maxToolsPerServer?: number;
  readonly maxResultCharacters?: number;
  readonly timeoutMs?: number;
}

export interface McpToolExecutionResult {
  readonly name: "mcp.call";
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
  readonly tool?: McpToolDescriptor;
}

type ServerState = {
  readonly config: McpServerConfig;
  readonly client: McpClientAdapter;
  readonly connectedAt: number;
  connected: boolean;
  connectPromise: Promise<void> | undefined;
  tools: readonly McpToolDescriptor[] | undefined;
  listPromise: Promise<readonly McpToolDescriptor[]> | undefined;
  lastError: string | undefined;
  lastUsedAt: number | undefined;
};

export class McpToolError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(
    code: string,
    message: string,
    retryable = false,
    options: { cause?: unknown } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "McpToolError";
    this.code = code;
    this.retryable = retryable;
  }
}

function parseConfiguration(
  values: readonly unknown[],
  maxServers: number,
): McpServerConfig[] {
  if (values.length > maxServers) {
    throw new Error(
      `MCP configuration may contain at most ${maxServers} servers.`,
    );
  }
  const seen = new Set<string>();
  return values.map((value) => {
    const config = McpServerConfigSchema.parse(value);
    if (seen.has(config.id)) throw new Error("MCP server IDs must be unique.");
    seen.add(config.id);
    if (config.transport === "stdio") {
      if (config.command.includes("\0") || config.command.startsWith("-")) {
        throw new Error(`MCP server "${config.id}" has an invalid executable.`);
      }
      if (config.cwd && !isAbsolute(config.cwd)) {
        throw new Error(
          `MCP server "${config.id}" cwd must be an absolute path.`,
        );
      }
      for (const arg of config.args) {
        if (arg.includes("\0"))
          throw new Error(`MCP server "${config.id}" has an invalid argument.`);
      }
    } else {
      const url = new URL(config.url);
      const loopback =
        url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname === "[::1]";
      if (
        url.protocol !== "https:" &&
        !(url.protocol === "http:" && loopback)
      ) {
        throw new Error(
          `MCP HTTP server "${config.id}" must use HTTPS, except for local loopback development.`,
        );
      }
      if (url.username || url.password || url.hash) {
        throw new Error(
          `MCP HTTP server "${config.id}" URL must not embed credentials or fragments.`,
        );
      }
      for (const name of Object.keys(config.headers)) {
        if (
          /^(host|content-length|connection|transfer-encoding)$/i.test(name)
        ) {
          throw new Error(
            `MCP HTTP server "${config.id}" uses a forbidden override header.`,
          );
        }
      }
    }
    return config;
  });
}

function withMcpDeadlineAndAbort<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolveResult, rejectResult) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      rejectResult(
        new McpToolError("cancelled", "MCP tool call was cancelled.", true),
      );
    };
    const timer = setTimeout(() => {
      cleanup();
      rejectResult(
        new McpToolError(
          "mcp_timeout",
          "MCP tool call exceeded its deadline.",
          true,
        ),
      );
    }, timeoutMs);
    timer.unref?.();
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolveResult(value);
      },
      (error: unknown) => {
        cleanup();
        rejectResult(error);
      },
    );
  });
}

function withMcpDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolveResult, rejectResult) => {
    const timer = setTimeout(() => {
      rejectResult(new McpToolError("mcp_timeout", message, true));
    }, timeoutMs);
    timer.unref?.();
    promise
      .then(resolveResult, rejectResult)
      .finally(() => clearTimeout(timer));
  });
}

const SENSITIVE_MCP_FIELD =
  /authorization|cookie|password|passwd|secret|api.?key|access.?token|refresh.?token|id.?token|client.?secret|private.?key|credential/i;
const SENSITIVE_MCP_VALUE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=?/gi,
  /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{12,}\b/g,
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
];

export function redactMcpSensitiveValues(
  value: unknown,
  depth = 0,
): unknown {
  if (depth > 32) return "[REDACTED: maximum nesting depth]";
  if (typeof value === "string") {
    return SENSITIVE_MCP_VALUE_PATTERNS.reduce(
      (current, pattern) => current.replace(pattern, "[REDACTED_SECRET]"),
      value,
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactMcpSensitiveValues(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = SENSITIVE_MCP_FIELD.test(key)
        ? "[REDACTED_SECRET]"
        : redactMcpSensitiveValues(item, depth + 1);
    }
    return result;
  }
  return value;
}

function safeJson(value: unknown, maxCharacters: number): unknown {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new McpToolError(
      "invalid_result",
      "MCP tool returned a non-serializable result.",
    );
  }
  if (typeof serialized !== "string") {
    throw new McpToolError(
      "invalid_result",
      "MCP tool returned a value that cannot be represented as JSON.",
    );
  }
  if (serialized.length > maxCharacters) {
    throw new McpToolError(
      "result_too_large",
      "MCP tool result exceeded Kuro-chan's configured output limit.",
    );
  }
  return JSON.parse(serialized) as unknown;
}

function validateSchemaSize(value: unknown): unknown {
  return safeJson(value ?? { type: "object", properties: {} }, 12_000);
}

function createSdkAdapter(
  config: McpServerConfig,
  environment: McpEnvironment,
): McpClientAdapter {
  let transport: StdioClientTransport | StreamableHTTPClientTransport;
  if (config.transport === "stdio") {
    const mappedEnvironment: Record<string, string> = {};
    for (const [targetName, sourceName] of Object.entries(config.env)) {
      const value = environment[sourceName];
      if (value === undefined || value.length === 0) {
        throw new McpToolError(
          "mcp_secret_missing",
          `Environment variable "${sourceName}" required by MCP server "${config.id}" is not configured.`,
        );
      }
      mappedEnvironment[targetName] = value;
    }
    const inherited: Record<string, string> = {};
    for (const key of [
      "PATH",
      "HOME",
      "TMPDIR",
      "TEMP",
      "TMP",
      "SystemRoot",
      "WINDIR",
    ]) {
      const value = environment[key];
      if (value) inherited[key] = value;
    }
    transport = new StdioClientTransport({
      command: config.command,
      args: [...config.args],
      env: { ...inherited, ...mappedEnvironment },
      ...(config.cwd ? { cwd: resolve(config.cwd) } : {}),
      stderr: "inherit",
    });
  } else {
    const headers: Record<string, string> = {};
    for (const [headerName, sourceName] of Object.entries(config.headers)) {
      const value = environment[sourceName];
      if (value === undefined || value.length === 0) {
        throw new McpToolError(
          "mcp_secret_missing",
          `Environment variable "${sourceName}" required by MCP server "${config.id}" is not configured.`,
        );
      }
      headers[headerName] = value;
    }
    transport = new StreamableHTTPClientTransport(new URL(config.url), {
      ...(Object.keys(headers).length ? { requestInit: { headers } } : {}),
    });
  }

  const client = new Client(
    { name: "kurochan-agent-runtime", version: "0.1.0" },
    { capabilities: {} },
  );
  return {
    // The SDK v1 HTTP transport types `sessionId` as string | undefined, while Transport omits undefined under exactOptionalPropertyTypes.
    connect: () => client.connect(transport as unknown as Transport),
    listTools: async () => {
      const response = await client.listTools();
      return { tools: response.tools as RawMcpTool[] };
    },
    callTool: (name, arguments_) =>
      client.callTool({ name, arguments: arguments_ }),
    close: () => client.close(),
  };
}

/**
 * Connects to explicitly configured Model Context Protocol servers. MCP process
 * commands, URLs and credential mappings come only from operator configuration,
 * never from model tool arguments. All tools run with the worker's OS permissions,
 * so servers should be independently trusted and least-privileged.
 */
export class McpToolRuntime {
  private readonly servers = new Map<string, ServerState>();
  private readonly configurations: readonly McpServerConfig[];
  private readonly environment: McpEnvironment;
  private readonly connectorFactory: NonNullable<
    McpToolRuntimeOptions["connectorFactory"]
  >;
  private readonly connectionErrors = new Map<string, string>();
  private readonly maxToolsPerServer: number;
  private readonly maxResultCharacters: number;
  private readonly timeoutMs: number;

  constructor(options: McpToolRuntimeOptions) {
    const maxServers = options.maxServers ?? 32;
    if (!Number.isInteger(maxServers) || maxServers < 1 || maxServers > 64) {
      throw new Error("MCP maxServers must be between 1 and 64.");
    }
    this.configurations = parseConfiguration(options.servers, maxServers);
    this.environment = options.environment ?? process.env;
    this.connectorFactory = options.connectorFactory ?? createSdkAdapter;
    this.maxToolsPerServer = options.maxToolsPerServer ?? 100;
    this.maxResultCharacters = options.maxResultCharacters ?? 50_000;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (
      !Number.isInteger(this.maxToolsPerServer) ||
      this.maxToolsPerServer < 1 ||
      this.maxToolsPerServer > 500
    ) {
      throw new Error("MCP maxToolsPerServer must be between 1 and 500.");
    }
    if (
      !Number.isInteger(this.maxResultCharacters) ||
      this.maxResultCharacters < 1_000 ||
      this.maxResultCharacters > 200_000
    ) {
      throw new Error(
        "MCP result limit must be between 1000 and 200000 characters.",
      );
    }
    if (
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 1_000 ||
      this.timeoutMs > 120_000
    ) {
      throw new Error("MCP timeout must be between 1000 and 120000 ms.");
    }
  }

  static fromEnvironment(
    environment: McpEnvironment = process.env,
    overrides: Partial<
      Pick<
        McpToolRuntimeOptions,
        | "connectorFactory"
        | "timeoutMs"
        | "maxToolsPerServer"
        | "maxResultCharacters"
      >
    > = {},
  ): McpToolRuntime {
    const raw = environment.KUROCHAN_MCP_SERVERS?.trim();
    if (!raw)
      return new McpToolRuntime({ servers: [], environment, ...overrides });
    if (Buffer.byteLength(raw, "utf8") > 128_000) {
      throw new Error(
        "KUROCHAN_MCP_SERVERS exceeds the 128 KB configuration limit.",
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new Error("KUROCHAN_MCP_SERVERS must contain valid JSON.", {
        cause: error,
      });
    }
    if (!Array.isArray(value)) {
      throw new Error("KUROCHAN_MCP_SERVERS must be a JSON array.");
    }
    return new McpToolRuntime({ servers: value, environment, ...overrides });
  }

  get isConfigured(): boolean {
    return this.configurations.length > 0;
  }

  configuredServers(): readonly {
    id: string;
    name: string;
    transport: McpServerConfig["transport"];
  }[] {
    return this.configurations.map(({ id, name, transport }) => ({
      id,
      name,
      transport,
    }));
  }

  async listTools(): Promise<readonly McpToolDescriptor[]> {
    const results = await Promise.all(
      this.configurations.map(async (config) => {
        try {
          const state = await this.getState(config);
          if (state.tools) return state.tools;
          if (state.listPromise) return await state.listPromise;
          state.listPromise = this.fetchTools(state);
          try {
            state.tools = await state.listPromise;
            state.lastError = undefined;
            return state.tools;
          } finally {
            state.listPromise = undefined;
          }
        } catch (error) {
          const state = this.servers.get(config.id);
          if (state)
            state.lastError =
              error instanceof Error
                ? error.message.slice(0, 500)
                : "MCP server connection failed.";
          return [];
        }
      }),
    );
    return results
      .flat()
      .sort(
        (a, b) =>
          a.serverId.localeCompare(b.serverId) || a.name.localeCompare(b.name),
      );
  }

  status(): readonly {
    id: string;
    name: string;
    transport: McpServerConfig["transport"];
    connected: boolean;
    toolCount: number;
    lastError?: string;
    lastUsedAt?: number;
  }[] {
    return this.configurations.map((config) => {
      const state = this.servers.get(config.id);
      const lastError =
        state?.lastError ?? this.connectionErrors.get(config.id);
      return {
        id: config.id,
        name: config.name,
        transport: config.transport,
        connected: Boolean(state?.connected && !state.lastError),
        toolCount: state?.tools?.length ?? 0,
        ...(lastError ? { lastError } : {}),
        ...(state?.lastUsedAt ? { lastUsedAt: state.lastUsedAt } : {}),
      };
    });
  }

  getTool(
    serverId: string,
    toolName: string,
  ): Promise<McpToolDescriptor | undefined> {
    return this.listTools().then((tools) =>
      tools.find(
        (tool) => tool.serverId === serverId && tool.name === toolName,
      ),
    );
  }

  async execute(
    input: unknown,
    signal?: AbortSignal,
  ): Promise<McpToolExecutionResult> {
    const parsed = McpCallArgsSchema.safeParse(input);
    if (!parsed.success) {
      return {
        name: "mcp.call",
        ok: false,
        error: {
          code: "invalid_arguments",
          message: "MCP call arguments are invalid.",
        },
      };
    }
    if (signal?.aborted) {
      return {
        name: "mcp.call",
        ok: false,
        error: { code: "cancelled", message: "MCP tool call was cancelled." },
      };
    }

    const descriptor = await this.getTool(
      parsed.data.serverId,
      parsed.data.toolName,
    );
    if (!descriptor) {
      return {
        name: "mcp.call",
        ok: false,
        error: {
          code: "unknown_tool",
          message: "The requested MCP tool is not currently available.",
        },
      };
    }
    const config = this.configurations.find(
      (server) => server.id === descriptor.serverId,
    );
    if (!config) {
      return {
        name: "mcp.call",
        ok: false,
        error: {
          code: "unknown_server",
          message: "MCP server is not configured.",
        },
      };
    }
    try {
      const state = await this.getState(config);
      const pending = state.client.callTool(
        parsed.data.toolName,
        parsed.data.arguments,
      );
      const result = await withMcpDeadlineAndAbort(
        pending,
        this.timeoutMs,
        signal,
      );
      const safeResult = redactMcpSensitiveValues(
        safeJson(result, this.maxResultCharacters),
      );
      state.lastUsedAt = Date.now();
      state.lastError = undefined;
      this.connectionErrors.delete(config.id);
      const isError = Boolean(
        safeResult &&
        typeof safeResult === "object" &&
        "isError" in safeResult &&
        (safeResult as { isError?: unknown }).isError === true,
      );
      return {
        name: "mcp.call",
        ok: !isError,
        result: safeResult,
        tool: descriptor,
        ...(isError
          ? {
              error: {
                code: "mcp_tool_error",
                message: "MCP server reported a tool execution error.",
              },
            }
          : {}),
      };
    } catch (error) {
      const typed = error as { code?: unknown; message?: unknown };
      const code = typeof typed.code === "string" ? typed.code : "mcp_failed";
      const message =
        typeof typed.message === "string"
          ? typed.message
          : "MCP tool call failed.";
      return {
        name: "mcp.call",
        ok: false,
        tool: descriptor,
        error: { code, message: message.slice(0, 1000) },
      };
    }
  }

  async close(): Promise<void> {
    const states = [...this.servers.values()];
    this.servers.clear();
    await Promise.allSettled(states.map((state) => state.client.close()));
  }

  private async getState(config: McpServerConfig): Promise<ServerState> {
    const existing = this.servers.get(config.id);
    if (existing) {
      if (existing.connectPromise) await existing.connectPromise;
      if (!existing.connected) {
        throw new McpToolError(
          "mcp_connect_failed",
          `MCP server "${config.id}" is not connected.`,
          true,
        );
      }
      return existing;
    }
    const client = this.connectorFactory(config, this.environment);
    const state: ServerState = {
      config,
      client,
      connectedAt: Date.now(),
      connected: false,
      connectPromise: undefined,
      tools: undefined,
      listPromise: undefined,
      lastError: undefined,
      lastUsedAt: undefined,
    };
    this.servers.set(config.id, state);
    const connecting = withMcpDeadline(
      client.connect(),
      this.timeoutMs,
      "MCP server connection exceeded its deadline.",
    );
    state.connectPromise = connecting;
    try {
      await connecting;
      state.connected = true;
      state.lastError = undefined;
      this.connectionErrors.delete(config.id);
      return state;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message.slice(0, 500)
          : "MCP server connection failed.";
      state.lastError = message;
      this.connectionErrors.set(config.id, message);
      this.servers.delete(config.id);
      await client.close().catch(() => undefined);
      throw new McpToolError(
        "mcp_connect_failed",
        `MCP server "${config.id}" could not be connected.`,
        true,
        { cause: error },
      );
    } finally {
      state.connectPromise = undefined;
    }
  }

  private async fetchTools(
    state: ServerState,
  ): Promise<readonly McpToolDescriptor[]> {
    const result = await withMcpDeadline(
      state.client.listTools(),
      this.timeoutMs,
      "MCP listTools exceeded its deadline.",
    );
    if (result.tools.length > this.maxToolsPerServer) {
      throw new McpToolError(
        "too_many_tools",
        `MCP server "${state.config.id}" exposed more than ${this.maxToolsPerServer} tools.`,
      );
    }
    const seen = new Set<string>();
    return result.tools.map((tool) => {
      if (
        !tool.name ||
        tool.name.length > 200 ||
        /[\0\r\n]/.test(tool.name) ||
        seen.has(tool.name)
      ) {
        throw new McpToolError(
          "invalid_tool_catalog",
          `MCP server "${state.config.id}" exposed duplicate or invalid tool names.`,
        );
      }
      seen.add(tool.name);
      const inputSchema = validateSchemaSize(tool.inputSchema);
      return {
        serverId: state.config.id,
        serverName: state.config.name,
        name: tool.name,
        description: (tool.description ?? "").slice(0, 1000),
        inputSchema,
        readOnly: tool.annotations?.readOnlyHint === true,
        ...(tool.annotations?.destructiveHint === undefined
          ? {}
          : { destructiveHint: tool.annotations.destructiveHint }),
        ...(tool.annotations?.idempotentHint === undefined
          ? {}
          : { idempotentHint: tool.annotations.idempotentHint }),
        ...(tool.annotations?.openWorldHint === undefined
          ? {}
          : { openWorldHint: tool.annotations.openWorldHint }),
      };
    });
  }
}
