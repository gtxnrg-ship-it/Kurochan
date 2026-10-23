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
  it("parses OpenAI-compatible SSE deltas and requests true provider streaming", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
      new Response([
        'data: {"choices":[{"delta":{"role":"assistant"}}]}',
        "",
        'data: {"choices":[{"delta":{"content":"hello"}}]}',
        "",
        'data: {"choices":[{"delta":{"content":" world"}}]}',
        "",
        "data: [DONE]",
        "",
      ].join("\n"), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    const provider = new OpenAICompatibleChatProvider({
      id: "openrouter",
      displayName: "OpenRouter",
      baseUrl: "https://example.test/v1",
      apiKey: "secret-test-key",
      defaultModel: "test-model",
      capabilities: { streaming: true },
      fetchImpl,
    });
    const stream = await provider.stream({
      messages: [{ role: "user", content: "hi" }],
      requiredCapabilities: ["text", "streaming"],
    });
    const chunks: string[] = [];
    for await (const chunk of stream) chunks.push(chunk.content);
    expect(chunks).toEqual(["hello", " world"]);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: "test-model",
      stream: true,
    });
    expect(String((fetchImpl.mock.calls[0]?.[1]?.headers as Record<string, string>).accept)).toBe("text/event-stream");
  });

  it("rejects streaming when the provider capability is not enabled", async () => {
    const provider = new OpenAICompatibleChatProvider({
      id: "openrouter",
      displayName: "OpenRouter",
      baseUrl: "https://example.test/v1",
      apiKey: "secret",
      defaultModel: "test-model",
    });
    await expect(provider.stream({
      messages: [{ role: "user", content: "hi" }],
      requiredCapabilities: ["text", "streaming"],
    })).rejects.toMatchObject({ code: "upstream_rejected" });
  });

});
