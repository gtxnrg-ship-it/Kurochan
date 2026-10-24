import { describe, expect, it, vi } from "vitest";
import { WebResearchRuntime } from "../src/web-research.js";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function contextResponse() {
  const url = "https://docs.example.dev/guide";
  return {
    grounding: {
      generic: [
        {
          url,
          title: "Official Guide",
          snippets: [
            "Use the supported API and verify its returned status.",
            "Configure credentials on the server.",
          ],
        },
      ],
    },
    sources: {
      [url]: {
        title: "Official Guide",
        hostname: "docs.example.dev",
        age: ["2026-10-20", "2026-10-20", "3 days ago", "x".repeat(500)],
      },
    },
  };
}

describe("WebResearchRuntime", () => {
  it("calls the fixed Brave LLM Context endpoint and emits source evidence", async () => {
    let requestedUrl = "";
    let requestedHeaders: HeadersInit | undefined;
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        requestedUrl = String(input);
        requestedHeaders = init?.headers;
        return jsonResponse(contextResponse());
      },
    ) as unknown as typeof fetch;
    const runtime = new WebResearchRuntime({
      apiKey: "brave-test-key",
      country: "BD",
      searchLang: "en",
      fetchImpl,
    });

    const result = await runtime.execute({
      name: "web.search",
      arguments: { query: "official TypeScript API documentation", limit: 2 },
    });

    expect(result.ok).toBe(true);
    expect(new URL(requestedUrl).origin).toBe("https://api.search.brave.com");
    expect(new URL(requestedUrl).pathname).toBe("/res/v1/llm/context");
    expect(new URL(requestedUrl).searchParams.get("q")).toBe(
      "official TypeScript API documentation",
    );
    expect(new URL(requestedUrl).searchParams.get("country")).toBe("BD");
    expect(new Headers(requestedHeaders).get("x-subscription-token")).toBe(
      "brave-test-key",
    );
    expect(result.result).toMatchObject({
      provider: "Brave Search LLM Context",
      items: [
        { url: "https://docs.example.dev/guide", hostname: "docs.example.dev" },
      ],
    });
    expect(result.evidence?.[0]).toMatchObject({
      kind: "web_source",
      uri: "https://docs.example.dev/guide",
    });

    const resultBody = result.result as { items: { age?: string[] }[] };
    expect(
      resultBody.items[0]?.age?.every((age) => age.length <= 100),
    ).toBe(true);
  });

  it("returns deeper bounded source context for research-heavy queries", async () => {
    let requestedUrl = "";
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      requestedUrl = String(input);
      return jsonResponse({
        grounding: {
          generic: Array.from({ length: 12 }, (_, sourceIndex) => ({
            url: "https://docs.example.dev/guide-" + sourceIndex,
            title: "Guide " + sourceIndex,
            snippets: Array.from(
              { length: 8 },
              (_, snippetIndex) =>
                "Source " +
                sourceIndex +
                " chunk " +
                snippetIndex +
                ": " +
                "evidence ".repeat(220),
            ),
          })),
        },
        sources: {},
      });
    }) as unknown as typeof fetch;
    const runtime = new WebResearchRuntime({
      apiKey: "brave-test-key",
      fetchImpl,
    });

    const result = await runtime.execute({
      name: "web.search",
      arguments: {
        query: "comprehensive technical documentation review",
        limit: 12,
      },
    });

    expect(result.ok).toBe(true);
    const requested = new URL(requestedUrl);
    expect(requested.searchParams.get("count")).toBe("12");
    expect(requested.searchParams.get("maximum_number_of_urls")).toBe("12");
    expect(requested.searchParams.get("maximum_number_of_tokens")).toBe(
      "12288",
    );
    expect(requested.searchParams.get("maximum_number_of_tokens_per_url")).toBe(
      "2048",
    );
    expect(requested.searchParams.get("maximum_number_of_snippets")).toBe("72");
    expect(
      requested.searchParams.get("maximum_number_of_snippets_per_url"),
    ).toBe("6");

    const body = result.result as {
      items: { snippets: string[] }[];
    };
    expect(body.items).toHaveLength(12);
    expect(body.items.every((item) => item.snippets.length <= 4)).toBe(true);
    const totalSnippetCharacters = body.items
      .flatMap((item) => item.snippets)
      .reduce((total, snippet) => total + snippet.length, 0);
    expect(totalSnippetCharacters).toBeLessThanOrEqual(28_000);
    expect(totalSnippetCharacters).toBeGreaterThan(25_000);
  });

  it("marks malformed provider responses as retryable provider failures", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ unexpected: true }),
    ) as unknown as typeof fetch;
    const runtime = new WebResearchRuntime({
      apiKey: "brave-test-key",
      fetchImpl,
    });

    const result = await runtime.execute({
      name: "web.search",
      arguments: { query: "official documentation response" },
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "invalid_web_search_response",
        retryable: true,
      },
    });
  });

  it("does not invent API credentials or make a request when unconfigured", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(contextResponse()),
    ) as unknown as typeof fetch;
    const runtime = new WebResearchRuntime({ apiKey: "", fetchImpl });

    const result = await runtime.execute({
      name: "web.search",
      arguments: { query: "Open-source code editor" },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "web_research_not_configured" },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects arbitrary URL retrieval and malformed search options before network access", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(contextResponse()),
    ) as unknown as typeof fetch;
    const runtime = new WebResearchRuntime({
      apiKey: "brave-test-key",
      fetchImpl,
    });

    const result = await runtime.execute({
      name: "web.search",
      arguments: { query: "search", url: "http://127.0.0.1/internal" },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_arguments" },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports Brave Search quota limits as retryable", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "limited" }, 429),
    ) as unknown as typeof fetch;
    const runtime = new WebResearchRuntime({
      apiKey: "brave-test-key",
      fetchImpl,
    });

    const result = await runtime.execute({
      name: "web.search",
      arguments: { query: "latest official API docs" },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "web_search_rate_limited" },
    });
  });

  it("discards insecure source URLs returned by the search provider", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        grounding: {
          generic: [
            {
              url: "javascript:alert(1)",
              title: "Injected",
              snippets: ["Do not trust this result."],
            },
            {
              url: "https://long.example/" + "x".repeat(1_100),
              title: "Oversized",
              snippets: ["Do not retain an oversized URL."],
            },
            {
              url: "https://valid.example/docs",
              title: "Valid",
              snippets: ["A valid source."],
            },
          ],
        },
        sources: {},
      }),
    ) as unknown as typeof fetch;
    const runtime = new WebResearchRuntime({
      apiKey: "brave-test-key",
      fetchImpl,
    });

    const result = await runtime.execute({
      name: "web.search",
      arguments: { query: "safe source links" },
    });

    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({
      items: [{ url: "https://valid.example/docs" }],
    });
  });
});
