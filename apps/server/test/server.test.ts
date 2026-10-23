import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer, validateServerConfiguration } from "../src/server.js";
import { RunStore } from "@kurochan/storage";
import type { ProviderId } from "@kurochan/contracts";
import type {
  ChatCompletionInput,
  ChatCompletionOutput,
  ChatProvider,
} from "@kurochan/model-gateway";

describe("Kuro-chan API", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("returns a liveness response without provider credentials", async () => {
    app = buildServer({
      env: { HOST: "127.0.0.1", PORT: "8787" },
      logger: false,
      store: new RunStore(":memory:"),
    });
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      service: "kurochan-api",
    });
  });

  it("does not report ready when no provider is configured", async () => {
    app = buildServer({
      env: {},
      logger: false,
      store: new RunStore(":memory:"),
    });
    const response = await app.inject({ method: "GET", url: "/readyz" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      ready: false,
      configuredProviders: 0,
    });
  });

  it("provides public, secret-free provider configuration", async () => {
    app = buildServer({
      env: {
        OPENROUTER_API_KEY: "top-secret",
        OPENROUTER_MODEL: "configured-model",
      },
      logger: false,
      store: new RunStore(":memory:"),
    });
    const response = await app.inject({ method: "GET", url: "/v1/config" });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("top-secret");
    expect(response.json().providers).toContainEqual(
      expect.objectContaining({ id: "openrouter", configured: true }),
    );
  });

  it("exposes durable provider and reported-token usage without leaking credentials", async () => {
    const store = new RunStore(":memory:");
    const now = Date.now();
    store.recordProviderUsage(
      {
        providerId: "freellmapi",
        model: "auto",
        profile: "fast",
        operation: "chat",
        latencyMs: 120,
        outcome: "success",
        usage: { promptTokens: 40, completionTokens: 16 },
      },
      now,
    );
    store.recordProviderUsage(
      {
        providerId: "openrouter",
        model: "test-model",
        profile: "balanced",
        operation: "task",
        latencyMs: 240,
        outcome: "failure",
        errorCode: "rate_limited",
      },
      now + 1,
    );
    app = buildServer({
      env: { FREELLMAPI_API_KEY: "must-not-be-returned" },
      logger: false,
      store,
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/usage?period=24h",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().totals).toMatchObject({
      requests: 2,
      successfulRequests: 1,
      failedRequests: 1,
      requestsWithTokenUsage: 1,
      requestsWithoutTokenUsage: 1,
      promptTokens: 40,
      completionTokens: 16,
      totalTokens: 56,
    });
    expect(response.json().data).toContainEqual(
      expect.objectContaining({
        providerId: "freellmapi",
        model: "auto",
        requests: 1,
        totalTokens: 56,
      }),
    );
    expect(response.body).not.toContain("must-not-be-returned");
    expect(response.json().accountingNote).toContain("not estimated");
  });

  it("rejects unsupported usage windows", async () => {
    app = buildServer({
      env: {},
      logger: false,
      store: new RunStore(":memory:"),
    });
    const response = await app.inject({
      method: "GET",
      url: "/v1/usage?period=forever",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "invalid_usage_period" },
    });
  });

  it("reports missing FreeLLMAPI configuration without trying to invent a key", async () => {
    app = buildServer({
      env: {},
      logger: false,
      store: new RunStore(":memory:"),
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/providers/freellmapi/test",
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: "provider_not_configured" },
    });
    expect(response.body).not.toContain("freellmapi-test-key");
  });

  it("tests a configured provider using a short request locked to that provider", async () => {
    const calls: Array<ChatCompletionInput> = [];
    const freellmapi: ChatProvider = {
      id: "freellmapi",
      displayName: "FreeLLMAPI",
      defaultModel: "auto",
      isConfigured: true,
      capabilities: { text: true, streaming: true },
      complete: async (
        input: ChatCompletionInput,
      ): Promise<ChatCompletionOutput> => {
        calls.push(input);
        return {
          providerId: "freellmapi",
          model: input.model ?? "auto",
          content: "connected",
          latencyMs: 3,
        };
      },
    };
    app = buildServer({
      env: {},
      providers: {
        providers: new Map<ProviderId, ChatProvider>([
          ["freellmapi", freellmapi],
        ]),
        statuses: [
          {
            id: "freellmapi",
            name: "FreeLLMAPI",
            configured: true,
            defaultModel: "auto",
            capabilityNotes: [],
            capabilities: {
              text: true,
              vision: false,
              tools: false,
              json: false,
              streaming: true,
              reasoning: false,
            },
          },
        ],
      },
      logger: false,
      store: new RunStore(":memory:"),
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/providers/freellmapi/test",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      provider: "freellmapi",
      model: "auto",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.messages).toEqual([
      {
        role: "user",
        content: "Reply with the single word connected.",
      },
    ]);
    expect(response.body).not.toContain("api_key");
  });

  it("requires an API token when one is configured", async () => {
    app = buildServer({
      env: { KUROCHAN_API_TOKEN: "test-token" },
      logger: false,
      store: new RunStore(":memory:"),
    });
    const response = await app.inject({ method: "GET", url: "/v1/models" });
    expect(response.statusCode).toBe(401);
    const ok = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: "Bearer test-token" },
    });
    expect(ok.statusCode).toBe(200);
  });

  it("validates external bind safety and port configuration", () => {
    expect(() => validateServerConfiguration({ HOST: "0.0.0.0" })).toThrow(
      /KUROCHAN_API_TOKEN/,
    );
    expect(
      validateServerConfiguration({
        HOST: "0.0.0.0",
        KUROCHAN_API_TOKEN: "token",
        PORT: "8080",
      }),
    ).toEqual({ host: "0.0.0.0", port: 8080 });
    expect(() => validateServerConfiguration({ PORT: "90000" })).toThrow(
      /PORT/,
    );
  });

  it("reports live and stale worker heartbeats without leaking worker metadata", async () => {
    const store = new RunStore(":memory:");
    const now = Date.now();
    store.recordWorkerHeartbeat(
      "worker-live",
      "busy",
      "task-123",
      { service: "kurochan-worker" },
      now,
    );
    store.recordWorkerHeartbeat(
      "worker-stale",
      "idle",
      undefined,
      { service: "kurochan-worker" },
      now - 60_000,
    );
    app = buildServer({
      env: {},
      logger: false,
      store,
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/workers?staleAfterMs=1000",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().summary).toEqual({ total: 2, active: 1, stale: 1 });
    expect(response.json().data).toContainEqual(
      expect.objectContaining({
        workerId: "worker-live",
        state: "busy",
        currentTaskId: "task-123",
        stale: false,
      }),
    );
    expect(response.json().data).toContainEqual(
      expect.objectContaining({ workerId: "worker-stale", stale: true }),
    );
  });

  it("locks provider-qualified model IDs to the named provider", async () => {
    const calls: Array<{ provider: ProviderId; model?: string }> = [];
    const fakeProvider = (
      id: ProviderId,
      defaultModel: string,
    ): ChatProvider => ({
      id,
      displayName: id,
      defaultModel,
      isConfigured: true,
      complete: async (
        input: ChatCompletionInput,
      ): Promise<ChatCompletionOutput> => {
        calls.push({ provider: id, model: input.model });
        return {
          providerId: id,
          model: input.model ?? defaultModel,
          content: "ok",
          latencyMs: 2,
        };
      },
    });
    const providers = {
      providers: new Map<ProviderId, ChatProvider>([
        ["openrouter", fakeProvider("openrouter", "vendor/default-model")],
        ["freellmapi", fakeProvider("freellmapi", "free-default")],
      ]),
      statuses: [
        {
          id: "openrouter" as const,
          name: "OpenRouter",
          configured: true,
          defaultModel: "vendor/default-model",
          capabilityNotes: [],
        },
        {
          id: "freellmapi" as const,
          name: "FreeLLMAPI",
          configured: true,
          defaultModel: "free-default",
          capabilityNotes: [],
        },
      ],
    };
    app = buildServer({
      env: {},
      providers,
      logger: false,
      store: new RunStore(":memory:"),
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "freellmapi/acme/model-v2",
        messages: [{ role: "user", content: "hello" }],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([{ provider: "freellmapi", model: "acme/model-v2" }]);
    expect(response.headers["x-omnirouter-provider"]).toBe("freellmapi");
  });

  it("rejects unknown model IDs instead of quietly changing route profiles", async () => {
    app = buildServer({
      env: {},
      logger: false,
      store: new RunStore(":memory:"),
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "invented-model",
        messages: [{ role: "user", content: "hello" }],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "unknown_model" } });
  });

  it("validates malformed inference requests before contacting a provider", async () => {
    app = buildServer({
      env: {},
      logger: false,
      store: new RunStore(":memory:"),
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "omni/balanced", messages: [] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "invalid_request" },
    });
  });
  it("rejects manual run plans that reference unknown specialists", async () => {
    const store = new RunStore(":memory:");
    app = buildServer({
      env: {},
      logger: false,
      store,
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/runs",
      payload: {
        goal: "Run an unknown specialist",
        profile: "balanced",
        tasks: [
          {
            key: "unknown",
            agentId: "invented/agent-id",
            objective: "Perform the task.",
          },
        ],
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: { code: "unknown_specialist", retryable: false },
      invalidAgentIds: ["invented/agent-id"],
    });
    expect(store.listRuns()).toHaveLength(0);
  });

  it("creates a run graph, exposes its events, and supports cancellation", async () => {
    app = buildServer({
      env: {},
      logger: false,
      store: new RunStore(":memory:"),
    });
    const created = await app.inject({
      method: "POST",
      url: "/v1/runs",
      payload: {
        goal: "Build a verified project",
        profile: "balanced",
        tasks: [
          {
            key: "research",
            agentId: "game-development/unreal-engine/unreal-world-builder",
            objective: "Gather evidence",
          },
          {
            key: "build",
            agentId: "game-development/unreal-engine/unreal-world-builder",
            objective: "Build from evidence",
            dependsOn: ["research"],
          },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    const runId = created.json().run.id as string;
    expect(created.json().tasks).toHaveLength(2);
    expect(
      created
        .json()
        .tasks.some(
          (task: { dependencies: readonly string[] }) =>
            task.dependencies.length === 1,
        ),
    ).toBe(true);
    const events = await app.inject({
      method: "GET",
      url: `/v1/runs/${runId}/events`,
    });
    expect(events.statusCode).toBe(200);
    expect(
      events.json().data.map((event: { type: string }) => event.type),
    ).toContain("run.plan_created");
    const cancelled = await app.inject({
      method: "POST",
      url: `/v1/runs/${runId}/cancel`,
      payload: { reason: "user requested stop" },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().run.status).toBe("cancelled");
  });

  it("exposes catalog metadata and searches agents without exposing full prompts", async () => {
    app = buildServer({
      env: {},
      logger: false,
      store: new RunStore(":memory:"),
    });
    const metadata = await app.inject({
      method: "GET",
      url: "/v1/agents/catalog",
    });
    expect(metadata.statusCode).toBe(200);
    expect(metadata.json().count).toBe(282);
    const searched = await app.inject({
      method: "GET",
      url: "/v1/agents?q=Unreal%20Engine%20world%20builder&limit=10",
    });
    expect(searched.statusCode).toBe(200);
    const completeCatalog = await app.inject({
      method: "GET",
      url: "/v1/agents?limit=500",
    });
    expect(completeCatalog.statusCode).toBe(200);
    expect(completeCatalog.json().data).toHaveLength(282);
    expect(
      new Set(
        completeCatalog.json().data.map((agent: { id: string }) => agent.id),
      ).size,
    ).toBe(282);
    expect(searched.json().data.length).toBeGreaterThan(0);
    expect(JSON.stringify(searched.json())).not.toContain("Core Mission");

    const deeplyNestedAgent = await app.inject({
      method: "GET",
      url: "/v1/agents/game-development/unreal-engine/unreal-world-builder",
    });
    expect(deeplyNestedAgent.statusCode).toBe(200);
    expect(deeplyNestedAgent.json().id).toBe(
      "game-development/unreal-engine/unreal-world-builder",
    );
    expect(deeplyNestedAgent.body).not.toContain("Core Mission");
  });

  it("rejects invalid pagination values with 400 rather than an internal error", async () => {
    app = buildServer({
      env: {},
      logger: false,
      store: new RunStore(":memory:"),
    });
    const response = await app.inject({
      method: "GET",
      url: "/v1/runs?limit=9999",
    });
    expect(response.statusCode).toBe(400);
  });
  it("streams chat completions through the API using provider SSE chunks", async () => {
    const streamingProvider: ChatProvider = {
      id: "openrouter",
      displayName: "Streaming test provider",
      defaultModel: "test-model",
      isConfigured: true,
      capabilities: { text: true, streaming: true },
      complete: async (): Promise<ChatCompletionOutput> => ({
        providerId: "openrouter",
        model: "test-model",
        content: "unused",
        latencyMs: 1,
      }),
      stream: async () =>
        (async function* () {
          yield { content: "hello" };
          yield { content: " mobile" };
        })(),
    };
    app = buildServer({
      env: {},
      providers: {
        providers: new Map<ProviderId, ChatProvider>([
          ["openrouter", streamingProvider],
        ]),
        statuses: [
          {
            id: "openrouter",
            name: "OpenRouter",
            configured: true,
            defaultModel: "test-model",
            capabilityNotes: [],
            capabilities: {
              text: true,
              vision: false,
              tools: false,
              json: false,
              streaming: true,
              reasoning: false,
            },
          },
        ],
      },
      logger: false,
      store: new RunStore(":memory:"),
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "openrouter/test-model",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.headers["x-omnirouter-provider"]).toBe("openrouter");
    expect(response.body).toContain("hello");
    expect(response.body).toContain(" mobile");
    expect(response.body).toContain("[DONE]");
  });

  it("rejects streaming when no configured provider advertises streaming", async () => {
    const ordinaryProvider: ChatProvider = {
      id: "openrouter",
      displayName: "Non-streaming test provider",
      defaultModel: "test-model",
      isConfigured: true,
      capabilities: { text: true, streaming: false },
      complete: async (): Promise<ChatCompletionOutput> => ({
        providerId: "openrouter",
        model: "test-model",
        content: "unused",
        latencyMs: 1,
      }),
    };
    app = buildServer({
      env: {},
      providers: {
        providers: new Map<ProviderId, ChatProvider>([
          ["openrouter", ordinaryProvider],
        ]),
        statuses: [
          {
            id: "openrouter",
            name: "OpenRouter",
            configured: true,
            defaultModel: "test-model",
            capabilityNotes: [],
            capabilities: {
              text: true,
              vision: false,
              tools: false,
              json: false,
              streaming: false,
              reasoning: false,
            },
          },
        ],
      },
      logger: false,
      store: new RunStore(":memory:"),
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "openrouter/test-model",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: "no_provider_available" },
    });
  });
});
