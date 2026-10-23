import { describe, expect, it } from "vitest";
import { AgentCatalog } from "@kurochan/agent-catalog";
import type { RouteProfile } from "@kurochan/contracts";
import type { PlanRouter } from "../src/planner.js";
import { PlanningError, RunPlanner } from "../src/planner.js";

function fakeRouter(content: string): PlanRouter {
  return {
    complete: async (request: {
      profile: RouteProfile;
      messages: readonly { role: "user" | "assistant"; content: string }[];
      systemPrompt: string;
      maxTokens: number;
      temperature: number;
      timeoutMs: number;
      requiredCapabilities: readonly ["text"];
    }) => {
      expect(request.systemPrompt).toContain("candidate id");
      return { content, providerId: "test", model: "test-model" };
    },
  };
}

describe("RunPlanner", () => {
  it("builds a minimal, validated task DAG from the pinned specialist catalog", async () => {
    const catalog = new AgentCatalog();
    const matching = (await catalog.search("Unreal Engine gameplay world building", { limit: 10 }))[0];
    expect(matching).toBeDefined();
    const json = JSON.stringify({
      summary: "Research and implement a bounded prototype.",
      selectedRunbook: null,
      assumptions: ["The target engine version will be confirmed."],
      verificationCriteria: ["Review the generated project and run applicable tests."],
      tasks: [
        { key: "research", agentId: matching!.id, objective: "Research requirements and produce a cited implementation brief.", dependsOn: [], maxAttempts: 2, input: {}, requiresApproval: false },
        { key: "implement", agentId: matching!.id, objective: "Implement the prototype after the brief is available.", dependsOn: ["research"], maxAttempts: 2, input: {}, requiresApproval: false },
      ],
    });
    const planner = new RunPlanner({ catalog, router: fakeRouter(json) });
    const plan = await planner.plan("Build an Unreal Engine gameplay prototype");
    expect(plan.tasks).toHaveLength(2);
    expect(plan.tasks[1]?.dependsOn).toEqual(["research"]);
    expect(plan.catalogCommit).toMatch(/^[a-f0-9]{40}$/);
  });

  it("forces approval for high-impact tasks regardless of model preference", async () => {
    const catalog = new AgentCatalog();
    const selected = (await catalog.search("DevOps release deployment", { limit: 1 }))[0]!;
    const json = JSON.stringify({
      summary: "Release plan.",
      selectedRunbook: null,
      assumptions: [],
      verificationCriteria: ["Deployment rehearsal passes."],
      tasks: [{ key: "deploy", agentId: selected.id, objective: "Deploy this service to production and publish the release.", dependsOn: [], maxAttempts: 1, input: {}, requiresApproval: false }],
    });
    const plan = await new RunPlanner({ catalog, router: fakeRouter(json) }).plan("Deploy service to production");
    expect(plan.tasks[0]?.approvalRequired).toBe(true);
  });

  it("rejects hallucinated specialist IDs", async () => {
    const catalog = new AgentCatalog();
    const json = JSON.stringify({
      summary: "Plan.",
      selectedRunbook: null,
      assumptions: [],
      verificationCriteria: ["A check succeeds."],
      tasks: [{ key: "one", agentId: "not/a-real-agent", objective: "Do work.", dependsOn: [], maxAttempts: 1, requiresApproval: false }],
    });
    await expect(new RunPlanner({ catalog, router: fakeRouter(json) }).plan("Plan a small API"))
      .rejects.toMatchObject({ code: "invalid_plan" });
  });

  it("rejects dependency cycles", async () => {
    const catalog = new AgentCatalog();
    const selected = (await catalog.search("backend engineer API service", { limit: 1 }))[0]!;
    const json = JSON.stringify({
      summary: "Plan.",
      selectedRunbook: null,
      assumptions: [],
      verificationCriteria: ["A check succeeds."],
      tasks: [
        { key: "a", agentId: selected.id, objective: "First.", dependsOn: ["b"], maxAttempts: 1, requiresApproval: false },
        { key: "b", agentId: selected.id, objective: "Second.", dependsOn: ["a"], maxAttempts: 1, requiresApproval: false },
      ],
    });
    await expect(new RunPlanner({ catalog, router: fakeRouter(json) }).plan("Plan a small API"))
      .rejects.toMatchObject({ code: "invalid_plan" });
  });

  it("rejects malformed planner JSON", async () => {
    const catalog = new AgentCatalog();
    await expect(new RunPlanner({ catalog, router: fakeRouter("not json") }).plan("Plan a small API"))
      .rejects.toBeInstanceOf(PlanningError);
  });
});
