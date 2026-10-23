import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { GitHubProjectRuntime } from "../src/github-project.js";
import { WorkspaceRuntime } from "../src/workspace.js";

const roots: string[] = [];
const runId = "6b8d4614-f06f-4b1f-a3bb-6c0f132ab847";
const repository = "acme/demo";
const baseCommit = "1111111111111111111111111111111111111111";
const baseTree = "2222222222222222222222222222222222222222";
const newTree = "3333333333333333333333333333333333333333";
const newCommit = "4444444444444444444444444444444444444444";
const baseContent = "export const answer = 41;\n";
const changedContent = "export const answer = 42;\n";

function blobSha(content: string): string {
  const bytes = Buffer.from(content, "utf8");
  return createHash("sha1")
    .update(Buffer.from("blob " + bytes.byteLength + "\0", "utf8"))
    .update(bytes)
    .digest("hex");
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "kuro-github-project-"));
  roots.push(root);
  return resolve(root);
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("GitHubProjectRuntime", () => {
  it("keeps project integration disabled until a token and explicit allowlist are configured", async () => {
    const fetchImpl = vi.fn();
    const runtime = new GitHubProjectRuntime({
      workspaceRoot: await makeRoot(),
      fetchImpl: fetchImpl as typeof fetch,
    });
    const result = await runtime.execute(runId, {
      name: "github.checkout_repository",
      arguments: { repository },
    });
    expect(runtime.isConfigured).toBe(false);
    expect(runtime.canPublish).toBe(false);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "github_project_not_configured" },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects repositories outside the configured allowlist before making network requests", async () => {
    const fetchImpl = vi.fn();
    const runtime = new GitHubProjectRuntime({
      workspaceRoot: await makeRoot(),
      token: "test-token",
      allowedRepositories: ["acme/approved"],
      fetchImpl: fetchImpl as typeof fetch,
    });
    const result = await runtime.execute(runId, {
      name: "github.checkout_repository",
      arguments: { repository },
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "repository_not_allowed" },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("checks out text project files and creates an approval-gated pull request from workspace changes", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const body =
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as unknown)
            : undefined;
        requests.push({ url, method, ...(body === undefined ? {} : { body }) });

        if (url.endsWith("/repos/acme/demo") && method === "GET") {
          return jsonResponse({
            full_name: repository,
            private: true,
            default_branch: "main",
          });
        }
        if (url.endsWith("/git/ref/heads/main") && method === "GET") {
          return jsonResponse({ object: { sha: baseCommit } });
        }
        if (url.endsWith("/git/commits/" + baseCommit) && method === "GET") {
          return jsonResponse({
            sha: baseCommit,
            tree: { sha: baseTree },
            commit: { message: "initial" },
          });
        }
        if (
          url.endsWith("/git/trees/" + baseCommit + "?recursive=1") &&
          method === "GET"
        ) {
          return jsonResponse({
            sha: baseTree,
            truncated: false,
            tree: [
              {
                path: "src/index.ts",
                mode: "100644",
                type: "blob",
                sha: blobSha(baseContent),
                size: Buffer.byteLength(baseContent),
              },
              {
                path: ".env",
                mode: "100644",
                type: "blob",
                sha: "5555555555555555555555555555555555555555",
                size: 20,
              },
            ],
          });
        }
        if (
          url.endsWith("/git/blobs/" + blobSha(baseContent)) &&
          method === "GET"
        ) {
          return jsonResponse({
            sha: blobSha(baseContent),
            encoding: "base64",
            content: Buffer.from(baseContent).toString("base64"),
            size: Buffer.byteLength(baseContent),
          });
        }
        if (url.endsWith("/git/blobs") && method === "POST") {
          const payload = body as { content: string; encoding: string };
          expect(payload.encoding).toBe("utf-8");
          expect(payload.content).toBe(changedContent);
          return jsonResponse({ sha: blobSha(changedContent) });
        }
        if (url.endsWith("/git/ref/heads/kurochan/run-6b8d4614") && method === "GET") {
          return jsonResponse({ message: "Not Found" }, 404);
        }
        if (url.endsWith("/git/trees") && method === "POST") {
          const payload = body as {
            base_tree: string;
            tree: Array<{ path: string; sha: string | null }>;
          };
          expect(payload.base_tree).toBe(baseTree);
          expect(payload.tree).toContainEqual({
            path: "src/index.ts",
            mode: "100644",
            type: "blob",
            sha: blobSha(changedContent),
          });
          return jsonResponse({ sha: newTree });
        }
        if (url.endsWith("/git/commits") && method === "POST") {
          const payload = body as {
            tree: string;
            parents: string[];
            message: string;
          };
          expect(payload.tree).toBe(newTree);
          expect(payload.parents).toEqual([baseCommit]);
          expect(payload.message).toContain("[Kuro-chan run " + runId + "]");
          return jsonResponse({ sha: newCommit });
        }
        if (url.endsWith("/git/refs") && method === "POST") {
          const payload = body as { ref: string; sha: string };
          expect(payload.ref).toBe("refs/heads/kurochan/run-6b8d4614");
          expect(payload.sha).toBe(newCommit);
          return jsonResponse({ ref: payload.ref, object: { sha: payload.sha } }, 201);
        }
        if (url.includes("/pulls?") && method === "GET") return jsonResponse([]);
        if (url.endsWith("/pulls") && method === "POST") {
          const payload = body as { head: string; base: string; title: string };
          expect(payload.head).toBe("kurochan/run-6b8d4614");
          expect(payload.base).toBe("main");
          expect(payload.title).toBe("Fix the answer");
          return jsonResponse({
            number: 7,
            html_url: "https://github.com/acme/demo/pull/7",
            state: "open",
          }, 201);
        }
        throw new Error("Unexpected mocked GitHub request: " + method + " " + url);
      },
    );

    const workspaceRoot = await makeRoot();
    const runtime = new GitHubProjectRuntime({
      workspaceRoot,
      token: "test-token",
      allowedRepositories: [repository],
      writeEnabled: true,
      fetchImpl,
    });

    expect(runtime.isConfigured).toBe(true);
    expect(runtime.canPublish).toBe(true);
    const checkout = await runtime.execute(runId, {
      name: "github.checkout_repository",
      arguments: { repository },
    });
    expect(checkout.ok).toBe(true);
    expect(checkout.result).toMatchObject({
      repository,
      baseBranch: "main",
      baseCommit,
      filesCheckedOut: 1,
      skippedFiles: 0,
    });
    expect(checkout.evidence?.[0]?.uri).toBe("https://github.com/acme/demo");
    expect(
      await readFile(join(workspaceRoot, runId, "src/index.ts"), "utf8"),
    ).toBe(baseContent);
    expect(
      await readFile(join(workspaceRoot, runId, ".env"), "utf8").catch(() => ""),
    ).toBe("");

    const workspace = new WorkspaceRuntime({ root: workspaceRoot });
    await workspace.writeFile(runId, "src/index.ts", changedContent, true);
    const pullRequest = await runtime.execute(runId, {
      name: "github.create_pull_request",
      arguments: {
        repository,
        title: "Fix the answer",
        body: "Update the sample module.",
      },
    });
    expect(pullRequest.ok).toBe(true);
    expect(pullRequest.result).toMatchObject({
      repository,
      branch: "kurochan/run-6b8d4614",
      base: "main",
      changedFiles: 1,
      createdFiles: 0,
      deletedFiles: 0,
      alreadyOpen: false,
      commit: newCommit,
      tree: newTree,
      pullRequest: {
        number: 7,
        url: "https://github.com/acme/demo/pull/7",
        state: "open",
      },
    });
    expect(pullRequest.evidence?.[0]?.uri).toBe(
      "https://github.com/acme/demo/pull/7",
    );
    expect(
      requests.some((request) => request.url.endsWith("/git/refs") && request.method === "POST"),
    ).toBe(true);
    expect(
      requests.some((request) => request.url.endsWith("/pulls") && request.method === "POST"),
    ).toBe(true);
    expect(
      requests.every((request) => request.url.startsWith("https://api.github.com/")),
    ).toBe(true);
  });

  it("does not enable repository publication by default", async () => {
    const runtime = new GitHubProjectRuntime({
      workspaceRoot: await makeRoot(),
      token: "test-token",
      allowedRepositories: [repository],
      fetchImpl: vi.fn() as typeof fetch,
    });
    expect(runtime.isConfigured).toBe(true);
    expect(runtime.canPublish).toBe(false);
    const result = await runtime.execute(runId, {
      name: "github.create_pull_request",
      arguments: { repository, title: "No write by default" },
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "github_writes_disabled" },
    });
  });
});
