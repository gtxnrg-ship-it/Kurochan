import { describe, expect, it, vi } from "vitest";
import { PlanService } from "../src/planner.js";
import type { AgentCatalog, AgentProfile } from "@kurochan/agent-catalog";
import type { RouteProfile } from "@kurochan/contracts";

const candidates: AgentProfile[] = [
  { id: "engineering/backend-architect", name: "Backend Architect", description: "Scalable API architecture", division: "engineering", sourcePath: "engineering/backend-architect.md", sourceSha256: "a".repeat(64), tools: [] },
  { id: "testing/api-tester", name: "API Tester", description: "Test APIs and contracts", division: "testing", sourcePath: "testing/api-tester.md", sourceSha256: "b".repeat(64), tools: [] },
  { id: "research/research-analyst", name: "Research Analyst", description: "Collect and evaluate evidence", division: "research", sourcePath: "research/research-analyst.md", sourceSha256: "c".repeat(64), tools: [] },
];

function fakeCatalog(): AgentCatalog {
  return {
    search: vi.fn(async () => candidates),
    list: vi.fn(async () => candidates),
    get: vi.fn(async (id: string) => candidates.find((candidate) => candidate.id === id)),
  } as unknown as AgentCatalog;
}

function fakeRouter(content: string, options: { providerId?: string; model?: string } = {}) {
  return {
    complete: vi.fn(async () => ({
      content,
      providerId: options.providerId ?? "openrouter",
      model: options.model ?? "test-model",
      latencyMs: 12,
      attempts: 1,
      routeProfile: "balanced" as RouteProfile,
      providerErrors: [],
    })),
  };
}

describe("PlanService", () => {
  it("only accepts selected catalog agents and produces an acyclic dependency graph", async () => {
    const router = fakeRouter(JSON.stringify({
      summary: "Research, implement and verify the service.",
      tasks: [
        { key: "research", agentId: "research/research-analyst", objective: "Research the API requirements.", dependsOn: [] },
        { key: "build", agentId: "engineering/backend-architect", objective: "Implement the API.", dependsOn: ["research"] },
        { key: "qa", agentId: "testing/api-tester", objective: "Test the API.", dependsOn: ["build"] },
      ],
    }));
    const planner = new PlanService({ catalog: fakeCatalog(), router });
    const plan = await planner.createPlan({ goal: "Build a service", profile: "balanced" });
    expect(plan.tasks).toHaveLength(3);
    expect(plan.tasks[2]?.dependsOn).toEqual(["build"]);
    expect(plan.selectedAgents).toHaveLength(3);
    expect(router.complete).toHaveBeenCalledOnce();
  });

  it("refuses model-invented agent IDs", async () => {
    const router = fakeRouter(JSON.stringify({
      summary: "bad plan",
      tasks: [{ key: "build", agentId: "made-up-agent", objective: "Build it", dependsOn: [] }],
    }));
    const planner = new PlanService({ catalog: fakeCatalog(), router });
    await expect(planner.createPlan({ goal: "Build it", profile: "balanced" })).rejects.toMatchObject({ code: "invalid_model_plan" });
  });

  it("retries malformed plan JSON once, then rejects it", async () => {
    const router = {
      complete: vi.fn()
        .mockResolvedValueOnce({ content: "not json", providerId: "openrouter", model: "test", latencyMs: 2, attempts: 1, routeProfile: "balanced", providerErrors: [] })
        .mockResolvedValueOnce({ content: "still not json", providerId: "openrouter", model: "test", latencyMs: 2, attempts: 1, routeProfile: "balanced", providerErrors: [] }),
    };
    const planner = new PlanService({ catalog: fakeCatalog(), router });
    await expect(planner.createPlan({ goal: "Plan something", profile: "balanced" })).rejects.toMatchObject({ code: "invalid_model_plan" });
    expect(router.complete).toHaveBeenCalledTimes(2);
  });
});
