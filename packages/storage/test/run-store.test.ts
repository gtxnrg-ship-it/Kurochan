import { describe, expect, it } from "vitest";
import { RunStore } from "../src/index.js";

function makeStore(): RunStore {
  return new RunStore(":memory:");
}

describe("RunStore", () => {
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
