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
            agentId: "research/research-analyst",
            objective: "Gather evidence",
          },
          {
            key: "build",
            agentId: "engineering/engineering-backend-architect",
            objective: "Build from evidence",
            dependsOn: ["research"],
          },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    const runId = created.json().run.id as string;
    expect(created.json().tasks).toHaveLength(2);
    expect(created.json().tasks[1].dependencies).toHaveLength(1);
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
    expect(metadata.json().count).toBe(298);
    const searched = await app.inject({
      method: "GET",
      url: "/v1/agents?q=Unreal%20Engine%20world%20builder&limit=10",
    });
    expect(searched.statusCode).toBe(200);
    expect(searched.json().data.length).toBeGreaterThan(0);
    expect(JSON.stringify(searched.json())).not.toContain("Core Mission");
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
});
