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
import {
  approvalGranted,
  jsonCharacterLimit,
  selectMcpToolsForTask,
  TaskWorker,
} from "../src/worker.js";
import {
  McpToolRuntime,
  type McpClientAdapter,
  type McpServerConfig,
} from "../src/mcp-tools.js";
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

describe("Bounded worker context", () => {
  it("keeps truncated context valid JSON and clearly marks its preview incomplete", () => {
    const serialized = jsonCharacterLimit(
      { results: ["useful evidence ".repeat(100)] },
      220,
    );

    expect(serialized.length).toBeLessThanOrEqual(220);
    const parsed = JSON.parse(serialized) as {
      contextTruncated?: boolean;
      notice?: string;
      preview?: string;
      originalCharacters?: number;
    };
    expect(parsed.contextTruncated).toBe(true);
    expect(parsed.notice).toContain("incomplete prefix");
    expect(parsed.preview).toBeTruthy();
    expect(parsed.originalCharacters).toBeGreaterThan(serialized.length);
  });

  it("rejects invalid context limits instead of silently overflowing", () => {
    expect(() => jsonCharacterLimit({}, 10)).toThrow(
      "JSON context character limit must be between 128 and 200000.",
    );
  });
});

describe("MCP tool relevance routing", () => {
  it("prefers task-relevant MCP tools over unrelated tools", () => {
    const tools = [
      {
        serverId: "a-billing",
        serverName: "Billing",
        name: "create_charge",
        description: "Create a charge and bill a customer",
        inputSchema: { type: "object", properties: {} },
        readOnly: false,
      },
      {
        serverId: "z-docs",
        serverName: "Documentation",
        name: "search_documentation",
        description:
          "Search official API documentation and technical reference pages",
        inputSchema: { type: "object", properties: {} },
        readOnly: true,
      },
    ];
    const selected = selectMcpToolsForTask(
      "Search official API documentation for TypeScript configuration",
      {
        id: "research/documentation-researcher",
        name: "Documentation Researcher",
        description: "Find and verify official technical documentation",
        tools: ["search", "research"],
      },
      tools,
      2,
    );

    expect(selected.map((tool) => tool.name)).toEqual([
      "search_documentation",
      "create_charge",
    ]);
  });
});

describe("Approval scope", () => {
  it("does not let approval of a later MCP tool authorize an earlier tool", () => {
    const store = new RunStore(":memory:");
    const runId = "be42cfea-6262-4c10-ad4f-ad7bb78b2a61";
    const workerId = "approval-scope-test";
    try {
      store.createRun(
        {
          id: runId,
          goal: "Use two external service tools with separate approvals",
          profile: "balanced",
          tasks: [
            {
              key: "external-tools",
              agentId: "engineering/engineering-test-agent",
              objective:
                "Use the exact external service action requested by the user.",
            },
          ],
        },
        1,
      );
      let task = store.claimNextTask(workerId, { now: 2, leaseMs: 1_000 });
      expect(task).toBeDefined();
      task = store.requestTaskApproval(
        runId,
        task!.id,
        workerId,
        {
          description: "Tool one",
          approvalType: "external-write",
          mcpServerId: "service-one",
          mcpToolName: "write_one",
        },
        3,
      );
      store.resolveTaskApproval(runId, task.id, true, "Approved tool one", 4);
      task = store.claimNextTask(workerId, { now: 5, leaseMs: 1_000 });
      expect(task).toBeDefined();
      task = store.requestTaskApproval(
        runId,
        task!.id,
        workerId,
        {
          description: "Tool two",
          approvalType: "external-write",
          mcpServerId: "service-two",
          mcpToolName: "write_two",
        },
        6,
      );
      store.resolveTaskApproval(runId, task.id, true, "Approved tool two", 7);

      const currentTask = store.listTasks(runId)[0]!;
      expect(
        approvalGranted(store, currentTask, "external-write", {
          mcpServerId: "service-one",
          mcpToolName: "write_one",
        }),
      ).toBe(false);
      expect(
        approvalGranted(store, currentTask, "external-write", {
          mcpServerId: "service-two",
          mcpToolName: "write_two",
        }),
      ).toBe(true);
    } finally {
      store.close();
    }
  });
});

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
  it("approval-gates MCP tools that are not explicitly marked read-only", async () => {
    const catalogRoot = await fakeCatalogRoot();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "kuro-workspaces-"));
    created.push(workspaceRoot);
    const runId = "be7691d2-36da-4b38-aec9-734be275c09d";
    const store = new RunStore(":memory:");
    let worker: TaskWorker | undefined;
    let toolExecuted = false;
    const mcpClient: McpClientAdapter = {
      connect: vi.fn(async () => undefined),
      listTools: vi.fn(async () => ({
        tools: [
          {
            name: "create_record",
            description: "Create a record in the connected workspace",
            inputSchema: {
              type: "object",
              properties: { title: { type: "string" } },
              required: ["title"],
            },
            annotations: { readOnlyHint: false },
          },
        ],
      })),
      callTool: vi.fn(async (_name, args) => {
        toolExecuted = true;
        return {
          isError: false,
          content: [{ type: "text", text: "created:" + String(args.title) }],
        };
      }),
      close: vi.fn(async () => undefined),
    };
    const mcpTools = new McpToolRuntime({
      servers: [
        {
          id: "workspace-service",
          name: "Workspace service",
          transport: "stdio",
          command: "node",
          args: ["/opt/trusted-mcp.js"],
        },
      ],
      connectorFactory: () => mcpClient,
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
                "The approved MCP action completed and its output was recorded.",
              checks: [
                {
                  name: "MCP result recorded",
                  passed: true,
                  notes:
                    "The runtime returned a result after explicit approval.",
                },
              ],
              blockers: [],
            }),
            latencyMs: 1,
          };
        }
        if (!toolExecuted) {
          toolRequested = true;
          return {
            providerId: "openrouter",
            model: "test-model",
            content: JSON.stringify({
              status: "tool_calls",
              summary: "Create the requested record.",
              toolCalls: [
                {
                  name: "mcp.call",
                  arguments: {
                    serverId: "workspace-service",
                    toolName: "create_record",
                    arguments: { title: "Quarterly report" },
                  },
                },
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
            summary: "The record was created and the response was captured.",
            toolCalls: [],
            evidence: [],
          }),
          latencyMs: 1,
        };
      },
    );
    try {
      store.createRun({
        id: runId,
        goal: "Create a record in the configured external service",
        profile: "balanced",
        tasks: [
          {
            key: "create-record",
            agentId: "engineering/engineering-test-agent",
            objective:
              "Use the discovered MCP create_record tool to create a quarterly report record.",
          },
        ],
      });
      const router = new OmniRouter({
        providers: new Map<ProviderId, ChatProvider>([
          ["openrouter", fakeProvider],
        ]),
      });
      worker = new TaskWorker({
        store,
        catalog: new AgentCatalog(catalogRoot),
        router,
        workspaceRoot: resolve(workspaceRoot),
        mcpTools,
      });

      const waiting = await worker.runOnce();
      expect(waiting).toMatchObject({
        kind: "waiting_for_approval",
        runId,
      });
      expect(toolRequested).toBe(true);
      expect(mcpClient.callTool).not.toHaveBeenCalled();
      const task = store.listTasks(runId)[0]!;
      expect(task.status).toBe("waiting_for_approval");
      const approval = store
        .listEvents(runId)
        .find((event) => event.type === "approval.requested");
      expect(approval?.payload).toMatchObject({
        action: {
          approvalType: "external-write",
          mcpServerId: "workspace-service",
          mcpToolName: "create_record",
        },
      });

      store.resolveTaskApproval(runId, task.id, true, "Reviewed and approved");
      const result = await worker.runOnce();
      expect(result).toMatchObject({ kind: "completed", runId });
      expect(mcpClient.callTool).toHaveBeenCalledOnce();
      expect(toolExecuted).toBe(true);
      expect(
        store
          .listTasks(runId)[0]
          ?.evidence.some((item) => item.kind === "mcp_tool_result"),
      ).toBe(true);
      expect(store.getRun(runId)?.status).toBe("completed");
    } finally {
      await worker?.stop();
      store.close();
    }
  });

  it("runs independent specialist tasks concurrently up to the configured worker limit", async () => {
    const catalogRoot = await fakeCatalogRoot();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "kuro-workspaces-"));
    created.push(workspaceRoot);
    const runId = "6b8d4614-f06f-4b1f-a3bb-6c0f132ab847";
    const store = new RunStore(":memory:");
    let worker: TaskWorker | undefined;
    let workStarted = 0;
    let reviewerCalls = 0;
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
            reviewerCalls += 1;
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
      worker = new TaskWorker({
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
      expect(reviewerCalls).toBe(1);
    } finally {
      releaseGate?.();
      await worker?.stop();
      store.close();
    }
  });

  it("requires a separate external-write approval before publishing a pull request", async () => {
    const catalogRoot = await fakeCatalogRoot();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "kuro-workspaces-"));
    created.push(workspaceRoot);
    const runId = "86b8b58f-e6b6-4bc0-8b3a-e3a24ee2ad92";
    const store = new RunStore(":memory:");
    let modelCalls = 0;
    const execute = vi.fn(async () => ({
      name: "github.create_pull_request" as const,
      ok: true,
      result: {
        repository: "acme/demo",
        pullRequest: {
          number: 7,
          url: "https://github.com/acme/demo/pull/7",
          state: "open",
        },
      },
      evidence: [
        {
          kind: "github_project",
          summary: "Created pull request #7 for acme/demo",
          uri: "https://github.com/acme/demo/pull/7",
        },
      ],
    }));

    try {
      store.createRun({
        id: runId,
        goal: "Update the project and open a pull request",
        profile: "balanced",
        tasks: [
          {
            key: "publish",
            agentId: "engineering/engineering-test-agent",
            objective:
              "Open a pull request after preparing the requested source changes.",
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
                summary: "The pull-request action returned real evidence.",
                checks: [
                  {
                    name: "Pull request evidence is present",
                    passed: true,
                    notes: "The connector returned a PR URL.",
                  },
                ],
                blockers: [],
              }),
              latencyMs: 1,
            };
          }
          modelCalls += 1;
          if (modelCalls <= 2) {
            return {
              providerId: "openrouter",
              model: "test-model",
              content: JSON.stringify({
                status: "tool_calls",
                summary: "Publish the requested pull request.",
                toolCalls: [
                  {
                    name: "github.create_pull_request",
                    arguments: {
                      repository: "acme/demo",
                      title: "Implement the requested change",
                      body: "Created by Kuro-chan.",
                    },
                  },
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
              summary: "The authorized connector created the pull request.",
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
        githubProject: {
          isConfigured: true,
          canPublish: true,
          execute,
        },
      });

      const first = await worker.runOnce();
      expect(first.kind).toBe("waiting_for_approval");
      expect(execute).not.toHaveBeenCalled();
      const task = store.listTasks(runId)[0]!;
      expect(task.status).toBe("waiting_for_approval");
      const requests = store
        .listEvents(runId, 0, 1000)
        .filter(
          (event) =>
            event.taskId === task.id && event.type === "approval.requested",
        );
      expect(requests.at(-1)?.payload).toMatchObject({
        action: { approvalType: "external-write" },
      });

      store.resolveTaskApproval(runId, task.id, true, "Reviewed and approved.");
      const second = await worker.runOnce();
      expect(second.kind).toBe("completed");
      expect(execute).toHaveBeenCalledOnce();
      expect(store.getRun(runId)?.status).toBe("completed");
      expect(store.getRun(runId)?.output).toMatchObject({
        review: { passed: true },
      });
    } finally {
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
