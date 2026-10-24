import { describe, expect, it, vi } from "vitest";
import {
  ApiClient,
  ApiError,
  consumeSse,
  normalizeApiBaseUrl,
  parseSseEvent,
} from "../public/api.mjs";

describe("Kuro-chan web API helpers", () => {
  it("normalizes API addresses without silently accepting credentials or query strings", () => {
    expect(normalizeApiBaseUrl(" http://127.0.0.1:8787/ ")).toBe(
      "http://127.0.0.1:8787",
    );
    expect(normalizeApiBaseUrl("https://example.test/kurochan/")).toBe(
      "https://example.test/kurochan",
    );
    expect(() => normalizeApiBaseUrl("")).toThrow(/API/);
    expect(() => normalizeApiBaseUrl("ftp://example.test")).toThrow(
      /HTTP or HTTPS/,
    );
    expect(() =>
      normalizeApiBaseUrl("https://user:secret@example.test"),
    ).toThrow(/credentials/);
    expect(() =>
      normalizeApiBaseUrl("https://example.test/?token=secret"),
    ).toThrow(/query/);
  });

  it("parses named and multi-line SSE events while ignoring comments", () => {
    expect(
      parseSseEvent(
        ": keep-alive\nevent: task.updated\nid: 42\ndata: first\ndata: second",
      ),
    ).toEqual({
      event: "task.updated",
      id: "42",
      data: "first\nsecond",
    });
    expect(parseSseEvent(": keep-alive")).toBeNull();
  });

  it("consumes SSE events split across arbitrary network chunks", async () => {
    const chunks = [
      'id: 1\nevent: run.started\ndata: {"status":',
      '"running"}\r\n\r\n',
      "data: [DONE]\n\n",
    ];
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks)
          controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });
    const events: unknown[] = [];
    await consumeSse({ body: stream }, (event) => events.push(event));
    expect(events).toEqual([
      { event: "run.started", id: "1", data: '{"status":"running"}' },
      { event: "message", id: undefined, data: "[DONE]" },
    ]);
  });

  it("sends bearer authentication without putting a token in the URL", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = new ApiClient({
      getBaseUrl: () => "http://127.0.0.1:8787/",
      getToken: () => "session-secret",
      fetchImpl,
    });
    await expect(client.health()).resolves.toEqual({ ok: true });
    const [url, options] = fetchImpl.mock.calls[0] || [];
    expect(url).toBe("http://127.0.0.1:8787/healthz");
    expect(new Headers(options?.headers).get("authorization")).toBe(
      "Bearer session-secret",
    );
    expect(url).not.toContain("session-secret");
    expect(options?.credentials).toBe("omit");
  });

  it("sends recorded voice as multipart without overriding the browser boundary", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ transcript: { text: "Hello Kuro-chan" } }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    const client = new ApiClient({
      getBaseUrl: () => "https://api.example.test",
      getToken: () => "voice-session-token",
      fetchImpl,
    });
    const form = new FormData();
    form.append(
      "file",
      new Blob(["fake audio"], { type: "audio/webm" }),
      "recording.webm",
    );
    form.append("clientMessageId", "voice-123");

    await expect(
      client.voiceTurn("conversation-1", form),
    ).resolves.toMatchObject({
      transcript: { text: "Hello Kuro-chan" },
    });
    const [url, options] = fetchImpl.mock.calls[0] || [];
    expect(url).toBe(
      "https://api.example.test/v1/conversations/conversation-1/voice-turn",
    );
    expect(options?.method).toBe("POST");
    expect(options?.body).toBe(form);
    expect(new Headers(options?.headers).get("authorization")).toBe(
      "Bearer voice-session-token",
    );
    expect(new Headers(options?.headers).has("content-type")).toBe(false);
    expect(options?.credentials).toBe("omit");
    expect(url).not.toContain("voice-session-token");
  });

  it("fetches a protected audio artifact with bearer auth and returns a Blob", async () => {
    const audio = new Blob(["audio bytes"], { type: "audio/wav" });
    const fetchImpl = vi.fn(
      async () =>
        new Response(audio, {
          status: 200,
          headers: { "content-type": "audio/wav" },
        }),
    );
    const client = new ApiClient({
      getBaseUrl: () => "https://api.example.test",
      getToken: () => "audio-session-token",
      fetchImpl,
    });

    const result = await client.conversationAudio(
      "conversation-1",
      "message-2",
    );
    const [url, options] = fetchImpl.mock.calls[0] || [];
    expect(result).toBeInstanceOf(Blob);
    expect(await result.text()).toBe("audio bytes");
    expect(url).toBe(
      "https://api.example.test/v1/conversations/conversation-1/audio/message-2",
    );
    expect(new Headers(options?.headers).get("authorization")).toBe(
      "Bearer audio-session-token",
    );
    expect(options?.credentials).toBe("omit");
    expect(url).not.toContain("audio-session-token");
  });

  it("requests live integration diagnostics without putting tokens in URLs", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = new ApiClient({
      getBaseUrl: () => "https://api.example.test",
      getToken: () => "integration-session-token",
      fetchImpl,
    });

    await client.mcpStatus({ probe: true });
    await client.communityMcpPresets("firebase supabase");
    await client.researchStatus();

    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "https://api.example.test/v1/mcp/status?probe=true",
      "https://api.example.test/v1/community-mcp-presets?limit=100&q=firebase+supabase",
      "https://api.example.test/v1/research/status",
    ]);
    for (const [url, options] of fetchImpl.mock.calls) {
      expect(new Headers(options?.headers).get("authorization")).toBe(
        "Bearer integration-session-token",
      );
      expect(options?.credentials).toBe("omit");
      expect(url).not.toContain("integration-session-token");
    }
  });

  it("sends the selected model with an agent run request", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ run: { id: "run-1" } }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = new ApiClient({
      getBaseUrl: () => "https://api.example.test",
      getToken: () => "session-token",
      fetchImpl,
    });

    await client.startRun("conversation-1", "Implement a feature", "quality", {
      model: "openrouter/openrouter/free",
    });

    const [url, options] = fetchImpl.mock.calls[0] || [];
    expect(url).toBe(
      "https://api.example.test/v1/conversations/conversation-1/runs",
    );
    expect(options?.method).toBe("POST");
    expect(JSON.parse(String(options?.body))).toEqual({
      goal: "Implement a feature",
      profile: "quality",
      model: "openrouter/openrouter/free",
    });
    expect(new Headers(options?.headers).get("authorization")).toBe(
      "Bearer session-token",
    );
  });

  it("normalizes structured API errors for the UI", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "no_provider_available",
              message: "Configure a model.",
              retryable: false,
              requestId: "req-1",
            },
          }),
          { status: 503, headers: { "content-type": "application/json" } },
        ),
    );
    const client = new ApiClient({
      getBaseUrl: () => "http://localhost:8787",
      fetchImpl,
    });
    await expect(client.config()).rejects.toMatchObject({
      name: "ApiError",
      status: 503,
      code: "no_provider_available",
      requestId: "req-1",
      retryable: false,
    } satisfies Partial<ApiError>);
  });

  it("exchanges OAuth codes, restores the current session, and signs out through the API", async () => {
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/auth/providers")) {
          return new Response(
            JSON.stringify({
              enabled: true,
              providers: [{ id: "github", configured: true }],
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        if (url.endsWith("/auth/session/exchange")) {
          return new Response(
            JSON.stringify({
              token: "oauth-session-token",
              user: {
                userId: "github:101",
                provider: "github",
                displayName: "Alice",
              },
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        if (url.endsWith("/v1/session")) {
          return new Response(
            JSON.stringify({
              user: {
                userId: "github:101",
                provider: "github",
                displayName: "Alice",
              },
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        if (url.endsWith("/v1/session/logout")) {
          return new Response(
            JSON.stringify({ signedOut: true, revoked: true }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response(
          JSON.stringify({
            error: { code: "not_found", message: "Unexpected request" },
          }),
          {
            status: 404,
            headers: { "content-type": "application/json" },
          },
        );
      },
    );
    const client = new ApiClient({
      getBaseUrl: () => "https://api.example.test",
      getToken: () => "oauth-session-token",
      fetchImpl,
    });

    await expect(client.authProviders()).resolves.toMatchObject({
      enabled: true,
    });
    await expect(
      client.exchangeOAuthCode("one-time-code-123456789012"),
    ).resolves.toMatchObject({
      token: "oauth-session-token",
      user: { userId: "github:101" },
    });
    await expect(client.session()).resolves.toMatchObject({
      user: { userId: "github:101" },
    });
    await expect(client.logoutSession()).resolves.toEqual({
      signedOut: true,
      revoked: true,
    });

    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.example.test/auth/providers",
      "https://api.example.test/auth/session/exchange",
      "https://api.example.test/v1/session",
      "https://api.example.test/v1/session/logout",
    ]);
    const exchange = fetchImpl.mock.calls[1]?.[1];
    expect(JSON.parse(String(exchange?.body))).toEqual({
      code: "one-time-code-123456789012",
    });
    const logout = fetchImpl.mock.calls[3]?.[1];
    expect(new Headers(logout?.headers).get("authorization")).toBe(
      "Bearer oauth-session-token",
    );
  });
});
