import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentCatalog } from "@kurochan/agent-catalog";
import type { ProviderId } from "@kurochan/contracts";
import type { ChatCompletionInput, ChatCompletionOutput, ChatProvider } from "@kurochan/model-gateway";
import { OmniRouter } from "@kurochan/omnirouter";
import { RunStore } from "@kurochan/storage";
import { TaskWorker } from "../src/worker.js";
import { WorkspaceRuntime } from "../src/workspace.js";

const created: string[] = [];
afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fakeCatalogRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "kuro-agents-"));
  created.push(root);
  await mkdir(join(root, "engineering"), { recursive: true });
  await writeFile(join(root, "engineering", "engineering-test-agent.md"), [
    "---",
    "name: Test Engineer",
    "description: Writes and verifies project files",
    "tools: [workspace]",
    "---",
    "You are a test engineer. Produce concrete files in the scoped workspace.",
  ].join("\n"), "utf8");
  return root;
}

function provider(complete: ChatProvider["complete"]): ChatProvider {
  return {
    id: "openrouter",
    displayName: "Test Provider",
    defaultModel: "test-model",
    isConfigured: true,
    complete,
  };
}

describe("WorkspaceRuntime", () => {
  it("writes, reads, searches and lists only files inside the run workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuro-workspaces-"));
    created.push(root);
    const runtime = new WorkspaceRuntime({ root: resolve(root) });
    const runId = "799f3f6a-a5f0-4f0f-876c-42347e0e183b";
    const written = await runtime.writeFile(runId, "src/index.ts", "export const answer = 42;\n");
    expect(written.path).toBe("src/index.ts");
    expect((await runtime.readFile(runId, "src/index.ts")).content).toContain("42");
    expect((await runtime.searchText(runId, "answer")).length).toBe(1);
    expect((await runtime.listFiles(runId)).map((file) => file.path)).toContain("src/index.ts");
  });

  it("rejects traversal, absolute paths and symbolic links", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuro-workspaces-"));
    created.push(root);
    const runtime = new WorkspaceRuntime({ root: resolve(root) });
    const runId = "e3eb00b5-1a04-4d0a-a523-3bf5f1151e5f";
    await expect(runtime.writeFile(runId, "../escape.txt", "no")).rejects.toMatchObject({ code: "invalid_path" });
    await expect(runtime.writeFile(runId, "/tmp/escape.txt", "no")).rejects.toMatchObject({ code: "invalid_path" });
    await runtime.writeFile(runId, "safe.txt", "safe");
    const runDirectory = runtime.runDirectory(runId);
    await (await import("node:fs/promises")).symlink("/tmp", join(runDirectory, "link"));
    await expect(runtime.readFile(runId, "link/something")).rejects.toMatchObject({ code: "unsafe_path" });
  });
});

describe("TaskWorker", () => {
  it("uses the specialist, writes a file with a bounded tool, and records honest verification scope", async () => {
    const catalogRoot = await fakeCatalogRoot();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "kuro-workspaces-"));
    created.push(workspaceRoot);
    const runId = "3ed3c5e8-ec4f-4e42-935f-84013c8a9490";
    const store = new RunStore(":memory:");
    try {
      store.createRun({
        id: runId,
        goal: "Create a small TypeScript module",
        profile: "balanced",
        tasks: [{ key: "build-module", agentId: "engineering/engineering-test-agent", objective: "Create src/index.ts with answer = 42." }],
      });
      let toolRequestSent = false;
      const fakeProvider = provider(async (input: ChatCompletionInput): Promise<ChatCompletionOutput> => {
        const system = input.systemPrompt ?? "";
        let content: string;
        if (system.includes("independent consistency reviewer")) {
          content = JSON.stringify({
            passed: true,
            summary: "Task output is consistent with the goal.",
            checks: [{ name: "Expected file exists in workspace output", passed: true, notes: "Worker created a file using the scoped write tool." }],
            blockers: [],
          });
        } else if (!toolRequestSent) {
          toolRequestSent = true;
          content = JSON.stringify({
            status: "tool_calls", summary: "Write the module.", toolCalls: [{
              name: "workspace.write_file",
              arguments: { path: "src/index.ts", content: "export const answer = 42;\n", overwrite: true },
            }], evidence: [],
          });
        } else {
          content = JSON.stringify({
            status: "completed",
            summary: "Created src/index.ts.",
            toolCalls: [],
            evidence: [{ kind: "artifact", summary: "TypeScript file created in the run workspace.", uri: "workspace://" + runId + "/src/index.ts" }],
          });
        }
        return { providerId: "openrouter", model: "test-model", content, latencyMs: 2 };
      });
      const router = new OmniRouter({ providers: new Map<ProviderId, ChatProvider>([["openrouter", fakeProvider]]) });
      const worker = new TaskWorker({ store, catalog: new AgentCatalog(catalogRoot), router, workspaceRoot: resolve(workspaceRoot), pollIntervalMs: 100 });
      const result = await worker.runOnce();
      expect(result.kind).toBe("completed");
      expect(await readFile(join(workspaceRoot, runId, "src/index.ts"), "utf8")).toContain("answer = 42");
      expect(store.getRun(runId)?.status).toBe("completed");
      expect(JSON.stringify(store.getRun(runId)?.output)).toContain("executionTestsRun");
    } finally {
      store.close();
    }
  });
});
