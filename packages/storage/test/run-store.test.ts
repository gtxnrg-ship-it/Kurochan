import { describe, expect, it } from "vitest";
import { RunStore } from "../src/index.js";

function makeStore(): RunStore {
  return new RunStore(":memory:");
}

describe("RunStore", () => {
  it("lists runs only for the requested owner while preserving legacy local runs", () => {
    const store = makeStore();
    try {
      const task = {
        key: "work",
        agentId: "engineering/test-agent",
        objective: "Perform the work.",
      };
      store.createRun({
        id: "run-owner-github",
        goal: "GitHub owner's work",
        profile: "balanced",
        createdBy: "github:123",
        tasks: [task],
      });
      store.createRun({
        id: "run-owner-google",
        goal: "Google owner's work",
        profile: "balanced",
        createdBy: "google:abc",
        tasks: [task],
      });
      store.createRun({
        id: "run-legacy-local",
        goal: "Legacy local work",
        profile: "balanced",
        tasks: [task],
      });

      expect(store.listRuns(50, undefined, "github:123").map((run) => run.id)).toEqual([
        "run-owner-github",
      ]);
      expect(store.listRuns(50, undefined, "google:abc").map((run) => run.id)).toEqual([
        "run-owner-google",
      ]);
      const localIds = store.listRuns(50, undefined, "local").map((run) => run.id);
      expect(localIds).toContain("run-legacy-local");
      expect(localIds).not.toContain("run-owner-github");
      expect(localIds).not.toContain("run-owner-google");
    } finally {
      store.close();
    }
  });

  it("persists task dependencies and requires a verification gate before completion", () => {
    const store = makeStore();
    try {
      const run = store.createRun(
        {
          id: "run-1",
          goal: "Create a verified deliverable",
          profile: "balanced",
          tasks: [
            {
              key: "research",
              agentId: "researcher",
              objective: "Gather evidence",
            },
            {
              key: "build",
              agentId: "builder",
              objective: "Build from evidence",
              dependsOn: ["research"],
            },
          ],
        },
        1000,
      );
      expect(run.status).toBe("queued");
      const first = store.claimNextTask("worker-a", {
        now: 1001,
        leaseMs: 5000,
      });
      expect(first?.planKey).toBe("research");
      expect(
        store.claimNextTask("worker-b", { now: 1002, leaseMs: 5000 }),
      ).toBeUndefined();

      store.completeTask(
        run.id,
        first!.id,
        "worker-a",
        { findings: ["source A"] },
        [{ kind: "source", summary: "Evidence captured" }],
        1003,
      );
      const second = store.claimNextTask("worker-b", {
        now: 1004,
        leaseMs: 5000,
      });
      expect(second?.planKey).toBe("build");
      store.completeTask(
        run.id,
        second!.id,
        "worker-b",
        { artifact: "artifact-ref" },
        [{ kind: "artifact", summary: "Build created" }],
        1005,
      );
      expect(store.getRun(run.id)?.status).toBe("verifying");
      expect(
        store.verifyRun(
          run.id,
          true,
          "Artifact inspected successfully",
          [{ kind: "test", summary: "Acceptance tests passed" }],
          { artifact: "artifact-ref" },
          1006,
        ).status,
      ).toBe("completed");
      expect(store.listEvents(run.id).map((event) => event.type)).toContain(
        "run.completed",
      );
    } finally {
      store.close();
    }
  });

  it("persists plan metadata and lease-fenced progress with safe source URLs", () => {
    const store = makeStore();
    try {
      const run = store.createRun(
        {
          goal: "Research and build a verified deliverable",
          profile: "balanced",
          plan: {
            intent: "Build the deliverable using source-backed research.",
            summary: "Research first, implement second, then verify.",
            assumptions: ["Use the existing project conventions."],
            selectedAgents: [
              {
                id: "research/research-analyst",
                name: "Research Analyst",
                division: "Research",
              },
            ],
            provider: {
              id: "openrouter",
              model: "test-model",
              latencyMs: 42,
            },
          },
          tasks: [
            {
              key: "research",
              agentId: "research/research-analyst",
              objective: "Gather source-backed findings.",
            },
          ],
        },
        1_000,
      );
      const planEvent = store
        .listEvents(run.id)
        .find((event) => event.type === "run.plan_created");
      expect(planEvent?.payload).toMatchObject({
        plan: {
          intent: "Build the deliverable using source-backed research.",
          selectedAgents: [{ id: "research/research-analyst" }],
        },
        taskGraph: [
          {
            key: "research",
            agentId: "research/research-analyst",
            dependencies: [],
          },
        ],
      });

      const task = store.claimNextTask("worker-a", {
        now: 1_001,
        leaseMs: 5_000,
      })!;
      store.recordTaskProgress(
        {
          runId: run.id,
          taskId: task.id,
          workerId: "worker-a",
          stage: "tool_completed",
          message: "Search returned a source reference.",
          round: 1,
          toolName: "web.search",
          sources: [
            {
              kind: "web_source",
              summary: "Official documentation",
              uri: "https://example.com/docs?access_token=super-secret",
            },
            {
              kind: "web_source",
              summary: "Unsafe scheme must be discarded",
              uri: "javascript:alert(1)",
            },
          ],
        },
        1_002,
      );
      const progressEvent = store
        .listEvents(run.id)
        .find((event) => event.type === "task.progress");
      expect(progressEvent?.payload).toMatchObject({
        stage: "tool_completed",
        toolName: "web.search",
        sources: [
          {
            kind: "web_source",
            summary: "Official documentation",
            uri: "https://example.com/docs",
          },
          {
            kind: "web_source",
            summary: "Unsafe scheme must be discarded",
          },
        ],
      });
      expect(JSON.stringify(progressEvent?.payload)).not.toContain(
        "super-secret",
      );
      expect(() =>
        store.recordTaskProgress(
          {
            runId: run.id,
            taskId: task.id,
            workerId: "worker-b",
            stage: "thinking",
            message: "Trying to report as another worker.",
          },
          1_003,
        ),
      ).toThrow(/lease/);
      expect(() =>
        store.recordTaskProgress(
          {
            runId: run.id,
            taskId: task.id,
            workerId: "worker-a",
            stage: "thinking",
            message: "Lease has expired.",
          },
          6_001,
        ),
      ).toThrow(/lease/);
    } finally {
      store.close();
    }
  });

  it("rejects cyclic and unknown task dependencies", () => {
    const store = makeStore();
    try {
      expect(() =>
        store.createRun({
          goal: "bad graph",
          profile: "balanced",
          tasks: [
            { key: "a", agentId: "planner", objective: "A", dependsOn: ["b"] },
            { key: "b", agentId: "builder", objective: "B", dependsOn: ["a"] },
          ],
        }),
      ).toThrow(/cycle/);
      expect(() =>
        store.createRun({
          goal: "bad graph",
          profile: "balanced",
          tasks: [
            {
              key: "a",
              agentId: "builder",
              objective: "A",
              dependsOn: ["missing"],
            },
          ],
        }),
      ).toThrow(/unknown task/);
    } finally {
      store.close();
    }
  });

  it("enforces worker leases and retries retryable failures with backoff", () => {
    const store = makeStore();
    try {
      const run = store.createRun(
        {
          goal: "Retry this",
          profile: "fast",
          tasks: [
            {
              key: "build",
              agentId: "builder",
              objective: "Build it",
              maxAttempts: 2,
            },
          ],
        },
        10_000,
      );
      const task = store.claimNextTask("worker-a", {
        now: 10_000,
        leaseMs: 5000,
      })!;
      expect(() =>
        store.completeTask(run.id, task.id, "worker-b", {}, [], 10_001),
      ).toThrow(/lease/);
      expect(
        store.failTask({
          runId: run.id,
          taskId: task.id,
          workerId: "worker-a",
          code: "timeout",
          message: "Timed out",
          retryable: true,
          now: 10_002,
        }).status,
      ).toBe("ready");
      expect(
        store.claimNextTask("worker-a", { now: 10_500, leaseMs: 5000 }),
      ).toBeUndefined();
      const retried = store.claimNextTask("worker-a", {
        now: 12_000,
        leaseMs: 5000,
      })!;
      expect(retried.attempts).toBe(2);
      expect(
        store.failTask({
          runId: run.id,
          taskId: retried.id,
          workerId: "worker-a",
          code: "timeout",
          message: "Timed out again",
          retryable: true,
          now: 12_001,
        }).status,
      ).toBe("failed");
      expect(store.getRun(run.id)?.status).toBe("failed");
    } finally {
      store.close();
    }
  });

  it("renews only a valid worker lease and blocks writes after expiry", () => {
    const store = makeStore();
    try {
      const run = store.createRun(
        {
          goal: "Keep a long task alive",
          profile: "balanced",
          tasks: [
            {
              key: "long-task",
              agentId: "builder",
              objective: "Run for a while",
            },
          ],
        },
        100,
      );
      const task = store.claimNextTask("worker-a", {
        now: 100,
        leaseMs: 1000,
      })!;
      expect(store.renewTaskLease(run.id, task.id, "worker-a", 1000, 900)).toBe(
        1900,
      );
      expect(() =>
        store.renewTaskLease(run.id, task.id, "worker-b", 1000, 901),
      ).toThrow(/lease/);
      expect(() =>
        store.completeTask(run.id, task.id, "worker-a", {}, [], 1900),
      ).toThrow(/lease/);
      expect(
        store.renewTaskLease(run.id, task.id, "worker-a", 1000, 1500),
      ).toBe(2500);
      expect(
        store.completeTask(run.id, task.id, "worker-a", { ok: true }, [], 1600)
          .status,
      ).toBe("succeeded");
    } finally {
      store.close();
    }
  });

  it("recovers abandoned worker leases", () => {
    const store = makeStore();
    try {
      const run = store.createRun(
        {
          goal: "Recover",
          profile: "fast",
          tasks: [{ key: "task", agentId: "builder", objective: "work" }],
        },
        100,
      );
      const first = store.claimNextTask("worker-a", {
        now: 100,
        leaseMs: 1000,
      })!;
      expect(first.status).toBe("running");
      const next = store.claimNextTask("worker-b", {
        now: 1200,
        leaseMs: 1000,
      })!;
      expect(next.id).toBe(first.id);
      expect(next.attempts).toBe(2);
      expect(next.leaseOwner).toBe("worker-b");
      expect(
        store
          .listEvents(run.id)
          .some((event) => event.type === "task.lease_expired"),
      ).toBe(true);
    } finally {
      store.close();
    }
  });

  it("persists provider request outcomes and aggregates only reported token usage", () => {
    const store = makeStore();
    try {
      const run = store.createRun(
        {
          goal: "Track provider usage",
          profile: "balanced",
          tasks: [
            {
              key: "task",
              agentId: "engineering/backend-architect",
              objective: "Complete a provider-backed task",
            },
          ],
        },
        100,
      );
      const task = store.listTasks(run.id)[0]!;

      store.recordProviderUsage(
        {
          providerId: "openrouter",
          model: "test-model",
          profile: "balanced",
          operation: "task",
          runId: run.id,
          taskId: task.id,
          latencyMs: 50,
          outcome: "success",
          usage: { promptTokens: 12, completionTokens: 8 },
        },
        110,
      );
      store.recordProviderUsage(
        {
          providerId: "openrouter",
          model: "test-model",
          profile: "balanced",
          operation: "task",
          runId: run.id,
          taskId: task.id,
          latencyMs: 100,
          outcome: "failure",
          errorCode: "rate_limited",
        },
        120,
      );
      store.recordProviderUsage(
        {
          providerId: "freellmapi",
          model: "auto",
          profile: "fast",
          operation: "chat",
          latencyMs: 20,
          outcome: "success",
        },
        130,
      );

      expect(store.summarizeProviderUsage(100, 120)).toEqual([
        {
          providerId: "openrouter",
          model: "test-model",
          operation: "task",
          requests: 2,
          successfulRequests: 1,
          failedRequests: 1,
          requestsWithTokenUsage: 1,
          requestsWithoutTokenUsage: 1,
          promptTokens: 12,
          completionTokens: 8,
          totalTokens: 20,
          averageLatencyMs: 75,
          lastUsedAt: 120,
        },
      ]);
      expect(store.summarizeProviderUsage(121, 200)).toEqual([
        {
          providerId: "freellmapi",
          model: "auto",
          operation: "chat",
          requests: 1,
          successfulRequests: 1,
          failedRequests: 0,
          requestsWithTokenUsage: 0,
          requestsWithoutTokenUsage: 1,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          averageLatencyMs: 20,
          lastUsedAt: 130,
        },
      ]);
    } finally {
      store.close();
    }
  });

  it("persists ordered conversation history with idempotent client message IDs", () => {
    const store = makeStore();
    try {
      const conversation = store.createConversation(
        { title: "New chat", createdBy: "local" },
        100,
      );
      const user = store.appendConversationMessage(
        conversation.id,
        {
          role: "user",
          content: "Build a small API",
          clientMessageId: "client-turn-1",
        },
        101,
      );
      const assistant = store.appendConversationMessage(
        conversation.id,
        {
          role: "assistant",
          content: "I'll plan the API and tests.",
          providerId: "freellmapi",
          model: "auto",
          usage: { promptTokens: 30, completionTokens: 12 },
          metadata: { routeProfile: "balanced" },
        },
        102,
      );
      const duplicate = store.appendConversationMessage(
        conversation.id,
        {
          role: "user",
          content: "Build a small API",
          clientMessageId: "client-turn-1",
        },
        103,
      );

      expect(user.inserted).toBe(true);
      expect(assistant.inserted).toBe(true);
      expect(duplicate.inserted).toBe(false);
      expect(duplicate.message.id).toBe(user.message.id);
      expect(assistant.message.sequence).toBe(2);
      expect(assistant.message.usage).toEqual({
        promptTokens: 30,
        completionTokens: 12,
        totalTokens: 42,
      });
      expect(store.getConversation(conversation.id)).toMatchObject({
        title: "Build a small API",
        messageCount: 2,
        version: 3,
        updatedAt: 102,
      });
      expect(
        store
          .listConversationMessages(conversation.id)
          .map((message) => message.role),
      ).toEqual(["user", "assistant"]);
      expect(
        store
          .listConversationMessages(conversation.id, { beforeSequence: 2 })
          .map((message) => message.content),
      ).toEqual(["Build a small API"]);
      expect(() =>
        store.appendConversationMessage(conversation.id, {
          role: "user",
          content: "Different content",
          clientMessageId: "client-turn-1",
        }),
      ).toThrow(/different message content/);
      expect(store.listConversations({ createdBy: "local" })).toHaveLength(1);
      expect(
        store.listConversations({ createdBy: "someone-else" }),
      ).toHaveLength(0);
      expect(store.deleteConversation(conversation.id)).toBe(true);
      expect(store.listConversationMessages(conversation.id)).toEqual([]);
      expect(store.deleteConversation(conversation.id)).toBe(false);
    } finally {
      store.close();
    }
  });

  it("persists synthesized audio against an assistant message and deletes it with the conversation", () => {
    const store = makeStore();
    try {
      const conversation = store.createConversation({ createdBy: "local" }, 10);
      const user = store.appendConversationMessage(
        conversation.id,
        { role: "user", content: "Please say hello." },
        11,
      );
      const assistant = store.appendConversationMessage(
        conversation.id,
        { role: "assistant", content: "Hello there." },
        12,
      );
      expect(user.inserted).toBe(true);
      const audio = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);
      const saved = store.saveConversationAudio(
        {
          conversationId: conversation.id,
          messageId: assistant.message.id,
          contentType: "audio/wav",
          format: "wav",
          audio,
        },
        13,
      );
      expect(saved).toMatchObject({
        conversationId: conversation.id,
        messageId: assistant.message.id,
        contentType: "audio/wav",
        format: "wav",
        bytes: 8,
        createdAt: 13,
      });
      expect([
        ...store.getConversationAudio(conversation.id, assistant.message.id)!
          .audio,
      ]).toEqual([...audio]);

      const duplicate = store.saveConversationAudio(
        {
          conversationId: conversation.id,
          messageId: assistant.message.id,
          contentType: "audio/wav",
          format: "wav",
          audio: new Uint8Array([0, 0, 0]),
        },
        14,
      );
      expect(duplicate).toEqual(saved);
      expect([
        ...store.getConversationAudio(conversation.id, assistant.message.id)!
          .audio,
      ]).toEqual([...audio]);

      expect(() =>
        store.saveConversationAudio({
          conversationId: conversation.id,
          messageId: user.message.id,
          contentType: "audio/wav",
          format: "wav",
          audio,
        }),
      ).toThrow(/assistant message/);
      expect(store.deleteConversation(conversation.id)).toBe(true);
      expect(
        store.getConversationAudio(conversation.id, assistant.message.id),
      ).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("keeps a run waiting for approval when a parallel task finishes", () => {
    const store = makeStore();
    try {
      const run = store.createRun(
        {
          goal: "Review a risky action while other work continues",
          profile: "balanced",
          tasks: [
            {
              key: "external-action",
              agentId: "release",
              objective: "Prepare an external write",
            },
            {
              key: "independent-review",
              agentId: "reviewer",
              objective: "Review the proposed action",
            },
          ],
        },
        100,
      );
      const externalAction = store.claimNextTask("worker-a", {
        now: 100,
        leaseMs: 5_000,
      })!;
      const review = store.claimNextTask("worker-b", {
        now: 100,
        leaseMs: 5_000,
      })!;

      store.requestTaskApproval(
        run.id,
        externalAction.id,
        "worker-a",
        { action: "publish" },
        101,
      );
      expect(store.getRun(run.id)?.status).toBe("waiting_for_approval");

      store.completeTask(
        run.id,
        review.id,
        "worker-b",
        { reviewed: true },
        [],
        102,
      );

      expect(store.getTask(externalAction.id)?.status).toBe(
        "waiting_for_approval",
      );
      expect(store.getRun(run.id)?.status).toBe("waiting_for_approval");
      expect(store.claimNextTask("worker-c", { now: 103 })).toBeUndefined();

      store.resolveTaskApproval(
        run.id,
        externalAction.id,
        true,
        "Approved",
        104,
      );
      expect(store.getRun(run.id)?.status).toBe("running");
      expect(store.claimNextTask("worker-c", { now: 105 })?.id).toBe(
        externalAction.id,
      );
    } finally {
      store.close();
    }
  });

  it("does not resume a run until every pending approval is resolved", () => {
    const store = makeStore();
    try {
      const run = store.createRun(
        {
          goal: "Approve two separate external actions",
          profile: "balanced",
          tasks: [
            {
              key: "publish",
              agentId: "release",
              objective: "Prepare a publish action",
            },
            {
              key: "notify",
              agentId: "communications",
              objective: "Prepare a notification action",
            },
          ],
        },
        200,
      );
      const publish = store.claimNextTask("worker-a", {
        now: 200,
        leaseMs: 5_000,
      })!;
      const notify = store.claimNextTask("worker-b", {
        now: 200,
        leaseMs: 5_000,
      })!;

      store.requestTaskApproval(
        run.id,
        publish.id,
        "worker-a",
        { action: "publish" },
        201,
      );
      store.requestTaskApproval(
        run.id,
        notify.id,
        "worker-b",
        { action: "notify" },
        202,
      );
      expect(store.getRun(run.id)?.status).toBe("waiting_for_approval");

      store.resolveTaskApproval(
        run.id,
        publish.id,
        true,
        "Approved publish",
        203,
      );
      expect(store.getRun(run.id)?.status).toBe("waiting_for_approval");
      expect(store.claimNextTask("worker-c", { now: 204 })).toBeUndefined();

      store.resolveTaskApproval(
        run.id,
        notify.id,
        true,
        "Approved notification",
        205,
      );
      expect(store.getRun(run.id)?.status).toBe("running");
      expect(store.claimNextTask("worker-c", { now: 206 })).toBeDefined();
    } finally {
      store.close();
    }
  });

  it("consumes external write approvals once and only for the reviewed action", () => {
    const store = makeStore();
    try {
      const run = store.createRun(
        {
          goal: "Approve a single external action",
          profile: "balanced",
          tasks: [
            {
              key: "external-action",
              agentId: "release",
              objective: "Create a record in an external service",
            },
          ],
        },
        100,
      );
      let task = store.claimNextTask("worker-a", {
        now: 100,
        leaseMs: 5_000,
      })!;
      task = store.requestTaskApproval(
        run.id,
        task.id,
        "worker-a",
        {
          approvalType: "external-write",
          mcpServerId: "records",
          mcpToolName: "create_record",
          argumentsHash: "approved-hash",
        },
        101,
      );
      store.resolveTaskApproval(run.id, task.id, true, "Approved", 102);
      task = store.claimNextTask("worker-a", {
        now: 103,
        leaseMs: 5_000,
      })!;

      expect(
        store.consumeExternalActionApproval(
          run.id,
          task.id,
          "worker-a",
          {
            mcpServerId: "records",
            mcpToolName: "create_record",
            argumentsHash: "different-hash",
          },
          104,
        ),
      ).toBe(false);
      expect(
        store.consumeExternalActionApproval(
          run.id,
          task.id,
          "worker-a",
          {
            mcpServerId: "records",
            mcpToolName: "create_record",
            argumentsHash: "approved-hash",
          },
          105,
        ),
      ).toBe(true);
      expect(
        store.consumeExternalActionApproval(
          run.id,
          task.id,
          "worker-a",
          {
            mcpServerId: "records",
            mcpToolName: "create_record",
            argumentsHash: "approved-hash",
          },
          106,
        ),
      ).toBe(false);
      expect(
        store
          .listEvents(run.id)
          .filter((event) => event.type === "approval.consumed"),
      ).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("supports approvals and cancellation", () => {
    const store = makeStore();
    try {
      const run = store.createRun(
        {
          goal: "Confirm the operation",
          profile: "balanced",
          tasks: [
            {
              key: "deploy",
              agentId: "release",
              objective: "Prepare deployment",
            },
          ],
        },
        100,
      );
      const task = store.claimNextTask("worker-a", { now: 100 })!;
      expect(
        store.requestTaskApproval(
          run.id,
          task.id,
          "worker-a",
          { action: "deploy", target: "production" },
          101,
        ).status,
      ).toBe("waiting_for_approval");
      expect(
        store.resolveTaskApproval(run.id, task.id, true, "Approved", 102)
          .status,
      ).toBe("ready");
      expect(store.cancelRun(run.id, "Stop requested", 103).status).toBe(
        "cancelled",
      );
      expect(store.listEvents(run.id).map((event) => event.type)).toContain(
        "run.cancelled",
      );
    } finally {
      store.close();
    }
  });
});
