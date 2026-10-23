import { describe, expect, it, vi } from "vitest";
import { GitHubResearchRuntime } from "../src/research.js";

function jsonResponse(
  payload: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function repository(overrides: Record<string, unknown> = {}) {
  return {
    full_name: "acme/portfolio",
    name: "portfolio",
    owner: { login: "acme" },
    description: "A web portfolio starter.",
    html_url: "https://github.com/acme/portfolio",
    default_branch: "main",
    stargazers_count: 120,
    language: "TypeScript",
    license: { spdx_id: "MIT", name: "MIT License" },
    topics: ["web", "typescript"],
    updated_at: "2026-10-20T10:00:00Z",
    ...overrides,
  };
}

describe("GitHubResearchRuntime", () => {
  it("searches repositories through the fixed GitHub API host and emits source evidence", async () => {
    let requestedUrl = "";
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      requestedUrl = String(input);
      return jsonResponse({ total_count: 1, items: [repository()] });
    }) as unknown as typeof fetch;
    const runtime = new GitHubResearchRuntime({ fetchImpl });

    const result = await runtime.execute({
      name: "github.search_repositories",
      arguments: { query: "portfolio starter", limit: 3 },
    });

    expect(result.ok).toBe(true);
    expect(new URL(requestedUrl).hostname).toBe("api.github.com");
    expect(new URL(requestedUrl).pathname).toBe("/search/repositories");
    expect((result.result as { items: unknown[] }).items).toHaveLength(1);
    expect(result.evidence?.[0]?.uri).toBe("https://github.com/acme/portfolio");
  });

  it("rejects traversal paths before making a network request", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch;
    const runtime = new GitHubResearchRuntime({ fetchImpl });

    const result = await runtime.execute({
      name: "github.read_file",
      arguments: { repository: "acme/portfolio", path: "../secrets.txt" },
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("invalid_path");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports public GitHub API rate limiting as retryable", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ message: "rate limit exceeded" }, 403, {
        "x-ratelimit-remaining": "0",
      }),
    ) as unknown as typeof fetch;
    const runtime = new GitHubResearchRuntime({ fetchImpl });

    const result = await runtime.execute({
      name: "github.get_repository",
      arguments: { repository: "acme/portfolio" },
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("github_rate_limited");
  });

  it("does not return repository files above the bounded research read size", async () => {
    const body = {
      type: "file",
      path: "large.txt",
      size: 50_001,
      encoding: "base64",
      content: Buffer.from("x".repeat(50_001)).toString("base64"),
      html_url: "https://github.com/acme/portfolio/blob/main/large.txt",
    };
    const fetchImpl = vi.fn(async () => jsonResponse(body)) as unknown as typeof fetch;
    const runtime = new GitHubResearchRuntime({ fetchImpl });

    const result = await runtime.execute({
      name: "github.read_file",
      arguments: { repository: "acme/portfolio", path: "large.txt" },
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("file_too_large");
  });
});
