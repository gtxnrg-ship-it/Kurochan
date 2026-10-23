import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentCatalog } from "@kurochan/agent-catalog";
import type { ProviderId } from "@kurochan/contracts";
import type {
  ChatCompletionInput,
  ChatCompletionOutput,
  ChatProvider,
} from "@kurochan/model-gateway";
import { OmniRouter } from "@kurochan/omnirouter";
import { RunStore } from "@kurochan/storage";
import { TaskWorker } from "../src/worker.js";
import { WorkspaceRuntime } from "../src/workspace.js";

const created: string[] = [];
afterEach(async () => {
  await Promise.all(
    created.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fakeCatalogRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "kuro-agents-"));
  created.push(root);
  await mkdir(join(root, "engineering"), { recursive: true });
  await writeFile(
    join(root, "engineering", "engineering-test-agent.md"),
    [
      "---",
      "name: Test Engineer",
      "description: Writes and verifies project files",
      "tools: [workspace]",
      "---",
      "You are a test engineer. Produce concrete files in the scoped workspace.",
    ].join("\n"),
    "utf8",
  );
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
    const written = await runtime.writeFile(
      runId,
      "src/index.ts",
      "export const answer = 42;\n",
    );
    expect(written.path).toBe("src/index.ts");
    expect((await runtime.readFile(runId, "src/index.ts")).content).toContain(
      "42",
    );
    expect((await runtime.searchText(runId, "answer")).length).toBe(1);
    expect((await runtime.listFiles(runId)).map((file) => file.path)).toContain(
      "src/index.ts",
    );
  });

  it("rejects traversal, absolute paths and symbolic links", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuro-workspaces-"));
    created.push(root);
    const runtime = new WorkspaceRuntime({ root: resolve(root) });
    const runId = "e3eb00b5-1a04-4d0a-a523-3bf5f1151e5f";
    await expect(
      runtime.writeFile(runId, "../escape.txt", "no"),
    ).rejects.toMatchObject({ code: "invalid_path" });
    await expect(
      runtime.writeFile(runId, "/tmp/escape.txt", "no"),
    ).rejects.toMatchObject({ code: "invalid_path" });
    await runtime.writeFile(runId, "safe.txt", "safe");
    const runDirectory = runtime.runDirectory(runId);
    await (
      await import("node:fs/promises")
    ).symlink("/tmp", join(runDirectory, "link"));
    await expect(
      runtime.readFile(runId, "link/something"),
    ).rejects.toMatchObject({ code: "unsafe_path" });
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
        tasks: [
          {
            key: "build-module",
            agentId: "engineering/engineering-test-agent",
            objective: "Create src/index.ts with answer = 42.",
          },
        ],
      });
      let toolRequestSent = false;
      const fakeProvider = provider(
        async (input: ChatCompletionInput): Promise<ChatCompletionOutput> => {
          const system = input.systemPrompt ?? "";
          let content: string;
          if (system.includes("independent consistency reviewer")) {
            content = JSON.stringify({
              passed: true,
              summary: "Task output is consistent with the goal.",
              checks: [
                {
                  name: "Expected file exists in workspace output",
                  passed: true,
                  notes: "Worker created a file using the scoped write tool.",
                },
              ],
              blockers: [],
            });
          } else if (!toolRequestSent) {
            toolRequestSent = true;
            content = JSON.stringify({
              status: "tool_calls",
              summary: "Write the module.",
              toolCalls: [
                {
                  name: "workspace.write_file",
                  arguments: {
                    path: "src/index.ts",
                    content: "export const answer = 42;\n",
                    overwrite: true,
                  },
                },
              ],
              evidence: [],
            });
          } else {
            content = JSON.stringify({
              status: "completed",
              summary: "Created src/index.ts.",
              toolCalls: [],
              evidence: [
                {
                  kind: "artifact",
                  summary: "TypeScript file created in the run workspace.",
                  uri: "workspace://" + runId + "/src/index.ts",
                },
              ],
            });
          }
          return {
            providerId: "openrouter",
            model: "test-model",
            content,
            latencyMs: 2,
          };
        },
      );
      const router = new OmniRouter({
        providers: new Map<ProviderId, ChatProvider>([
          ["openrouter", fakeProvider],
        ]),
      });
      const worker = new TaskWorker({
        store,
        catalog: new AgentCatalog(catalogRoot),
        router,
        workspaceRoot: resolve(workspaceRoot),
        pollIntervalMs: 100,
      });
      const result = await worker.runOnce();
      expect(result.kind).toBe("completed");
      expect(
        await readFile(join(workspaceRoot, runId, "src/index.ts"), "utf8"),
      ).toContain("answer = 42");
      expect(store.getRun(runId)?.status).toBe("completed");
      expect(JSON.stringify(store.getRun(runId)?.output)).toContain(
        "executionTestsRun",
      );
    } finally {
      store.close();
    }
  });
  it("runs independent specialist tasks concurrently up to the configured worker limit", async () => {
    const catalogRoot = await fakeCatalogRoot();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "kuro-workspaces-"));
    created.push(workspaceRoot);
    const runId = "6b8d4614-f06f-4b1f-a3bb-6c0f132ab847";
    const store = new RunStore(":memory:");
    let workStarted = 0;
    let activeWork = 0;
    let maxConcurrentWork = 0;
    let markBothStarted: (() => void) | undefined;
    const bothStarted = new Promise<void>((resolveBoth) => {
      markBothStarted = resolveBoth;
    });
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolveGate) => {
      releaseGate = resolveGate;
    });

    try {
      store.createRun({
        id: runId,
        goal: "Run two independent specialist tasks in parallel",
        profile: "balanced",
        tasks: [
          {
            key: "research",
            agentId: "engineering/engineering-test-agent",
            objective:
              "Independently summarize the requested project structure.",
          },
          {
            key: "implementation",
            agentId: "engineering/engineering-test-agent",
            objective: "Independently outline the implementation approach.",
          },
        ],
      });

      const fakeProvider = provider(
        async (input: ChatCompletionInput): Promise<ChatCompletionOutput> => {
          if (
            (input.systemPrompt ?? "").includes(
              "independent consistency reviewer",
            )
          ) {
            return {
              providerId: "openrouter",
              model: "test-model",
              content: JSON.stringify({
                passed: true,
                summary: "Both independent specialist outputs are present.",
                checks: [
                  {
                    name: "Both tasks completed",
                    passed: true,
                    notes: "Both task records reached succeeded before review.",
                  },
                ],
                blockers: [],
              }),
              latencyMs: 1,
            };
          }

          workStarted += 1;
          activeWork += 1;
          maxConcurrentWork = Math.max(maxConcurrentWork, activeWork);
          if (workStarted === 2) markBothStarted?.();
          try {
            await gate;
          } finally {
            activeWork -= 1;
          }
          return {
            providerId: "openrouter",
            model: "test-model",
            content: JSON.stringify({
              status: "completed",
              summary: "Produced an independent workstream result.",
              toolCalls: [],
              evidence: [],
            }),
            latencyMs: 1,
          };
        },
      );
      const router = new OmniRouter({
        providers: new Map<ProviderId, ChatProvider>([
          ["openrouter", fakeProvider],
        ]),
      });
      const worker = new TaskWorker({
        store,
        catalog: new AgentCatalog(catalogRoot),
        router,
        workspaceRoot: resolve(workspaceRoot),
        concurrency: 2,
        pollIntervalMs: 100,
      });

      worker.start();
      await Promise.race([
        bothStarted,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("Second independent task did not start.")),
            3_000,
          ),
        ),
      ]);
      expect(workStarted).toBe(2);
      expect(maxConcurrentWork).toBe(2);
      releaseGate?.();
      await vi.waitFor(
        () => {
          expect(store.getRun(runId)?.status).toBe("completed");
        },
        { timeout: 5_000 },
      );
      expect(
        store.listTasks(runId).every((task) => task.status === "succeeded"),
      ).toBe(true);
    } finally {
      releaseGate?.();
      store.close();
    }
  });

  it("cancels an in-flight model request when the run is cancelled", async () => {
    const catalogRoot = await fakeCatalogRoot();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "kuro-workspaces-"));
    created.push(workspaceRoot);
    const runId = "7c14ac61-0fb4-47b6-a54d-7c1cc3c92ec9";
    const store = new RunStore(":memory:");
    try {
      store.createRun({
        id: runId,
        goal: "Cancel a long-running task",
        profile: "balanced",
        tasks: [
          {
            key: "long-task",
            agentId: "engineering/engineering-test-agent",
            objective: "Wait for the current inference call to finish.",
          },
        ],
      });
      let markStarted: (() => void) | undefined;
      const inferenceStarted = new Promise<void>((resolveStarted) => {
        markStarted = resolveStarted;
      });
      const fakeProvider = provider(
        async (input: ChatCompletionInput): Promise<ChatCompletionOutput> => {
          markStarted?.();
          return await new Promise<ChatCompletionOutput>((_resolve, reject) => {
            const cancel = () =>
              reject(
                Object.assign(new Error("Inference cancelled."), {
                  code: "cancelled",
                }),
              );
            if (input.signal?.aborted) {
              cancel();
              return;
            }
            input.signal?.addEventListener("abort", cancel, { once: true });
          });
        },
      );
      const router = new OmniRouter({
        providers: new Map<ProviderId, ChatProvider>([
          ["openrouter", fakeProvider],
        ]),
      });
      const worker = new TaskWorker({
        store,
        catalog: new AgentCatalog(catalogRoot),
        router,
        workspaceRoot: resolve(workspaceRoot),
        leaseMs: 1_000,
      });
      const running = worker.runOnce();
      await inferenceStarted;
      store.cancelRun(runId, "user requested stop");
      worker.cancelRun(runId);
      await expect(running).resolves.toMatchObject({
        kind: "failed",
        runId,
        summary: "Run was cancelled.",
      });
      expect(store.getRun(runId)?.status).toBe("cancelled");
      expect(store.listTasks(runId)[0]?.status).toBe("cancelled");
    } finally {
      store.close();
    }
  });

  it("executes sandbox tools through the injected runtime and records real command evidence", async () => {
    const catalogRoot = await fakeCatalogRoot();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "kuro-workspaces-"));
    created.push(workspaceRoot);
    const runId = "7cd74b5c-05b3-45ae-b07e-19b8b9060bc9";
    const store = new RunStore(":memory:");
    try {
      store.createRun({
        id: runId,
        goal: "Run the project's tests",
        profile: "balanced",
        tasks: [
          {
            key: "test",
            agentId: "engineering/engineering-test-agent",
            objective: "Run npm test and report its exit status.",
          },
        ],
      });
      let toolRequested = false;
      const fakeProvider = provider(
        async (input: ChatCompletionInput): Promise<ChatCompletionOutput> => {
          if (
            (input.systemPrompt ?? "").includes(
              "independent consistency reviewer",
            )
          ) {
            return {
              providerId: "openrouter",
              model: "test-model",
              content: JSON.stringify({
                passed: true,
                summary:
                  "The task output matches the observed sandbox evidence.",
                checks: [
                  {
                    name: "Command evidence is present",
                    passed: true,
                    notes: "A real sandbox adapter returned exit code 0.",
                  },
                ],
                blockers: [],
              }),
              latencyMs: 1,
            };
          }
          if (!toolRequested) {
            toolRequested = true;
            return {
              providerId: "openrouter",
              model: "test-model",
              content: JSON.stringify({
                status: "tool_calls",
                summary: "Run the test suite.",
                toolCalls: [
                  { name: "sandbox.run", arguments: { command: "npm test" } },
                ],
                evidence: [],
              }),
              latencyMs: 1,
            };
          }
          return {
            providerId: "openrouter",
            model: "test-model",
            content: JSON.stringify({
              status: "completed",
              summary: "npm test exited successfully in the sandbox.",
              toolCalls: [],
              evidence: [],
            }),
            latencyMs: 1,
          };
        },
      );
      const execute = vi.fn(async (_runId: string, input: unknown) => {
        expect(input).toMatchObject({ command: "npm test" });
        return {
          name: "sandbox.run" as const,
          ok: true,
          result: {
            exitCode: 0,
            stdout: "tests passed",
            stderr: "",
            durationMs: 30,
            termination: "exited" as const,
            outputTruncated: false,
            command: "npm test",
            network: "none" as const,
          },
        };
      });
      const router = new OmniRouter({
        providers: new Map<ProviderId, ChatProvider>([
          ["openrouter", fakeProvider],
        ]),
      });
      const worker = new TaskWorker({
        store,
        catalog: new AgentCatalog(catalogRoot),
        router,
        workspaceRoot: resolve(workspaceRoot),
        sandbox: { execute },
      });
      const result = await worker.runOnce();
      expect(result.kind).toBe("completed");
      expect(execute).toHaveBeenCalledOnce();
      const task = store.listTasks(runId)[0]!;
      expect(
        task.evidence.some((item) => item.kind === "sandbox_execution"),
      ).toBe(true);
      expect(store.getRun(runId)?.output).toMatchObject({
        executionTestsRun: true,
      });
    } finally {
      store.close();
    }
  });
});
