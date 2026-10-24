import { describe, expect, it, vi } from "vitest";
import { OpenAICompatibleChatProvider } from "../src/openai-compatible.js";
import { ProviderError } from "../src/provider.js";

describe("OpenAICompatibleChatProvider", () => {
  it("sends the selected model and returns normalized content and usage", async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            model: "resolved-model",
            choices: [{ message: { content: "hello" } }],
            usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const provider = new OpenAICompatibleChatProvider({
      id: "openrouter",
      displayName: "OpenRouter",
      baseUrl: "https://example.test/v1",
      apiKey: "secret-test-key",
      defaultModel: "test-model",
      fetchImpl,
    });
    const result = await provider.complete({
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.content).toBe("hello");
    expect(result.model).toBe("resolved-model");
    expect(result.usage).toEqual({
      promptTokens: 2,
      completionTokens: 3,
      totalTokens: 5,
    });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "https://example.test/v1/chat/completions",
    );
    expect(
      String(
        (fetchImpl.mock.calls[0]?.[1]?.headers as Record<string, string>)
          .authorization,
      ),
    ).toBe("Bearer secret-test-key");
  });

  it("classifies exhausted credits as retryable so OmniRouter can fail over", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("account has insufficient credits", { status: 402 }),
    );
    const provider = new OpenAICompatibleChatProvider({
      id: "openrouter",
      displayName: "OpenRouter",
      baseUrl: "https://example.test/v1",
      apiKey: "secret",
      defaultModel: "test-model",
      fetchImpl,
    });

    await expect(
      provider.complete({ messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toMatchObject({
      code: "quota_exhausted",
      retryable: true,
      statusCode: 402,
    });
  });

  it("does not reveal upstream response bodies for failed requests", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("provider leaked detailed internal data", { status: 429 }),
    );
    const provider = new OpenAICompatibleChatProvider({
      id: "freellmapi",
      displayName: "FreeLLMAPI",
      baseUrl: "https://example.test/v1",
      apiKey: "secret",
      defaultModel: "test-model",
      fetchImpl,
    });
    await expect(
      provider.complete({ messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toMatchObject({ code: "rate_limited", retryable: true });
  });

  it("rejects URL credentials and non-http schemes", () => {
    expect(
      () =>
        new OpenAICompatibleChatProvider({
          id: "openrouter",
          displayName: "OpenRouter",
          baseUrl: "file:///etc/passwd",
          apiKey: "secret",
          defaultModel: "x",
        }),
    ).toThrow(ProviderError);
  });

  it("requires HTTPS for remote model endpoints while allowing loopback HTTP", () => {
    expect(
      () =>
        new OpenAICompatibleChatProvider({
          id: "openrouter",
          displayName: "OpenRouter",
          baseUrl: "http://model-provider.example/v1",
          apiKey: "secret",
          defaultModel: "test-model",
        }),
    ).toThrow(/HTTPS/);

    expect(
      () =>
        new OpenAICompatibleChatProvider({
          id: "freellmapi",
          displayName: "FreeLLMAPI",
          baseUrl: "http://127.0.0.1:3001/v1",
          apiKey: "secret",
          defaultModel: "auto",
        }),
    ).not.toThrow();
  });

  it("requires an explicit opt-in for remote HTTP FreeLLMAPI and never allows it for OpenRouter", () => {
    const options = {
      displayName: "FreeLLMAPI",
      baseUrl: "http://freellmapi:3001/v1",
      apiKey: "secret",
      defaultModel: "auto",
    };
    expect(
      () =>
        new OpenAICompatibleChatProvider({
          id: "freellmapi",
          ...options,
        }),
    ).toThrow(/HTTPS/);
    expect(
      () =>
        new OpenAICompatibleChatProvider({
          id: "freellmapi",
          ...options,
          allowInsecureHttp: true,
        }),
    ).not.toThrow();
    expect(
      () =>
        new OpenAICompatibleChatProvider({
          id: "openrouter",
          ...options,
          allowInsecureHttp: true,
        }),
    ).toThrow(/HTTPS/);
  });

  it("fails explicitly when no key is configured", async () => {
    const provider = new OpenAICompatibleChatProvider({
      id: "openrouter",
      displayName: "OpenRouter",
      baseUrl: "https://example.test/v1",
      defaultModel: "test-model",
    });
    await expect(
      provider.complete({ messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toMatchObject({ code: "not_configured" });
  });
  it("classifies exhausted credits as retryable for streaming requests", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("account has insufficient credits", { status: 402 }),
    );
    const provider = new OpenAICompatibleChatProvider({
      id: "openrouter",
      displayName: "OpenRouter",
      baseUrl: "https://example.test/v1",
      apiKey: "secret",
      defaultModel: "test-model",
      capabilities: { streaming: true },
      fetchImpl,
    });
    await expect(
      provider.stream({
        messages: [{ role: "user", content: "hi" }],
        requiredCapabilities: ["text", "streaming"],
      }),
    ).rejects.toMatchObject({
      code: "quota_exhausted",
      retryable: true,
      statusCode: 402,
    });
  });

  it("parses OpenAI-compatible SSE deltas and requests true provider streaming", async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        new Response(
          [
            'data: {"choices":[{"delta":{"role":"assistant"}}]}',
            "",
            'data: {"choices":[{"delta":{"content":"hello"}}]}',
            "",
            'data: {"choices":[{"delta":{"content":" world"}}]}',
            "",
            'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}',
            "",
            "data: [DONE]",
            "",
          ].join("\n"),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        ),
    );
    const provider = new OpenAICompatibleChatProvider({
      id: "openrouter",
      displayName: "OpenRouter",
      baseUrl: "https://example.test/v1",
      apiKey: "secret-test-key",
      defaultModel: "test-model",
      capabilities: { streaming: true },
      includeStreamUsage: true,
      fetchImpl,
    });
    const stream = await provider.stream({
      messages: [{ role: "user", content: "hi" }],
      requiredCapabilities: ["text", "streaming"],
    });
    const chunks: Array<{
      content: string;
      usage?: {
        promptTokens?: number;
        completionTokens?: number;
        totalTokens?: number;
      };
    }> = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(chunks).toEqual([
      { content: "hello" },
      { content: " world" },
      {
        content: "",
        usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
      },
    ]);
    expect(
      JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)),
    ).toMatchObject({
      model: "test-model",
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(
      String(
        (fetchImpl.mock.calls[0]?.[1]?.headers as Record<string, string>)
          .accept,
      ),
    ).toBe("text/event-stream");
  });

  it("rejects streaming when the provider capability is not enabled", async () => {
    const provider = new OpenAICompatibleChatProvider({
      id: "openrouter",
      displayName: "OpenRouter",
      baseUrl: "https://example.test/v1",
      apiKey: "secret",
      defaultModel: "test-model",
    });
    await expect(
      provider.stream({
        messages: [{ role: "user", content: "hi" }],
        requiredCapabilities: ["text", "streaming"],
      }),
    ).rejects.toMatchObject({ code: "upstream_rejected" });
  });
});
