import { describe, expect, it, vi } from "vitest";
import { PlanService } from "../src/planner.js";
import type { AgentCatalog, AgentProfile } from "@kurochan/agent-catalog";
import type { RouteProfile } from "@kurochan/contracts";

const candidates: AgentProfile[] = [
  {
    id: "engineering/backend-architect",
    name: "Backend Architect",
    description: "Scalable API architecture",
    division: "engineering",
    sourcePath: "engineering/backend-architect.md",
    sourceSha256: "a".repeat(64),
    tools: [],
  },
  {
    id: "testing/api-tester",
    name: "API Tester",
    description: "Test APIs and contracts",
    division: "testing",
    sourcePath: "testing/api-tester.md",
    sourceSha256: "b".repeat(64),
    tools: [],
  },
  {
    id: "research/research-analyst",
    name: "Research Analyst",
    description: "Collect and evaluate evidence",
    division: "research",
    sourcePath: "research/research-analyst.md",
    sourceSha256: "c".repeat(64),
    tools: [],
  },
];

function fakeCatalog(): AgentCatalog {
  return {
    search: vi.fn(async () => candidates),
    list: vi.fn(async () => candidates),
    get: vi.fn(async (id: string) =>
      candidates.find((candidate) => candidate.id === id),
    ),
    listRunbooks: vi.fn(async () => [
      {
        slug: "startup-mvp",
        title: "Startup MVP",
        mode: "micro",
        duration: "short",
        summary:
          "Research, design, implement and verify a minimum viable product.",
        doc: "strategy/nexus-strategy.md",
        roster: [
          {
            group: "engineering",
            activation: "required",
            agents: ["engineering/backend-architect"],
          },
        ],
      },
    ]),
    readNexusStrategy: vi.fn(
      async () => "NEXUS: discover, strategize, build, verify and evolve.",
    ),
  } as unknown as AgentCatalog;
}

function fakeRouter(
  content: string,
  options: { providerId?: string; model?: string } = {},
) {
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
    const router = fakeRouter(
      JSON.stringify({
        summary: "Research, implement and verify the service.",
        tasks: [
          {
            key: "research",
            agentId: "research/research-analyst",
            objective: "Research the API requirements.",
            dependsOn: [],
          },
          {
            key: "build",
            agentId: "engineering/backend-architect",
            objective: "Implement the API.",
            dependsOn: ["research"],
          },
          {
            key: "qa",
            agentId: "testing/api-tester",
            objective: "Test the API.",
            dependsOn: ["build"],
          },
        ],
      }),
    );
    const planner = new PlanService({ catalog: fakeCatalog(), router });
    const plan = await planner.createPlan({
      goal: "Build a startup MVP service",
      profile: "balanced",
    });
    expect(plan.tasks).toHaveLength(3);
    expect(plan.tasks[2]?.dependsOn).toEqual(["build"]);
    expect(plan.selectedAgents).toHaveLength(3);
    expect(plan.selectedRunbook).toEqual({
      slug: "startup-mvp",
      title: "Startup MVP",
    });
    expect(router.complete).toHaveBeenCalledOnce();
    const prompted = JSON.parse(
      router.complete.mock.calls[0]![0].messages[0]!.content,
    );
    expect(prompted.relevantNexusRunbooks).toHaveLength(1);
    expect(router.complete.mock.calls[0]![0].systemPrompt).toContain(
      "NEXUS strategy excerpt",
    );
  });

  it("turns vague goals into an explicit intent, bounded assumptions, or one blocker question", async () => {
    const router = fakeRouter(
      JSON.stringify({
        intent: "Build a lightweight study-planning app for a student.",
        summary:
          "Confirm the target platform before committing to platform-specific implementation.",
        assumptions: [
          "Keep the first version small and easy to use.",
          "Avoid paid infrastructure unless it becomes necessary.",
        ],
        clarificationRequired: true,
        clarificationQuestion:
          "Should the first version be a web app or a native mobile app?",
        tasks: [
          {
            key: "define-mvp",
            agentId: "engineering/backend-architect",
            objective:
              "Define a platform-neutral MVP and identify the decisions that depend on the target platform.",
            dependsOn: [],
          },
        ],
      }),
    );
    const catalog = fakeCatalog();
    const planner = new PlanService({ catalog, router });
    const plan = await planner.createPlan({
      goal: "Make it real",
      profile: "balanced",
      conversationContext: [
        {
          role: "user",
          content:
            "I want a lightweight study planner that helps me stay organized.",
        },
        {
          role: "assistant",
          content: "We can start with a small MVP and grow it later.",
        },
      ],
    });

    expect(plan.intent).toContain("study-planning app");
    expect(plan.assumptions).toHaveLength(2);
    expect(plan.clarificationRequired).toBe(true);
    expect(plan.clarificationQuestion).toContain(
      "web app or a native mobile app",
    );
    expect(plan.tasks[0]?.input).toMatchObject({
      userIntent: plan.intent,
      assumptions: plan.assumptions,
    });
    const prompted = JSON.parse(
      router.complete.mock.calls[0]![0].messages[0]!.content,
    );
    expect(prompted.goal).toBe("Make it real");
    expect(prompted.recentConversation).toHaveLength(2);
    expect(prompted.recentConversation[0].content).toContain("study planner");
    expect(router.complete.mock.calls[0]![0].systemPrompt).toContain(
      "A vague idea is not automatically a reason to interrogate the user",
    );
    const catalogGoalSearch = vi.mocked(catalog.search).mock.calls[0]?.[0];
    expect(catalogGoalSearch).toContain("Make it real");
    expect(catalogGoalSearch).toContain("study planner");
  });

  it("retrieves runbook specialists from the complete catalog even when they were absent from search results", async () => {
    const unseen: AgentProfile = {
      id: "security/security-architect",
      name: "Security Architect",
      description: "Security architecture and threat modeling. ".repeat(30),
      division: "security",
      sourcePath: "security/security-architect.md",
      sourceSha256: "d".repeat(64),
      tools: Array.from({ length: 20 }, (_, index) => `security-tool-${index}`),
    };
    const catalog = fakeCatalog();
    vi.mocked(catalog.list).mockResolvedValue([...candidates, unseen]);
    vi.mocked(catalog.get).mockImplementation(async (id: string) =>
      [...candidates, unseen].find((candidate) => candidate.id === id),
    );
    vi.mocked(catalog.listRunbooks).mockResolvedValue([
      {
        slug: "startup-mvp",
        title: "Startup MVP",
        mode: "micro",
        duration: "short",
        summary:
          "Build a startup MVP with secure architecture and verification.",
        doc: "strategy/nexus-strategy.md",
        roster: [
          {
            group: "security",
            activation: "required",
            agents: ["security/security-architect"],
          },
        ],
      },
    ]);

    const router = fakeRouter(
      JSON.stringify({
        summary: "Research, implement and verify the service.",
        tasks: [
          {
            key: "research",
            agentId: "research/research-analyst",
            objective: "Research the API requirements.",
            dependsOn: [],
          },
          {
            key: "build",
            agentId: "engineering/backend-architect",
            objective: "Implement the API.",
            dependsOn: ["research"],
          },
          {
            key: "security-review",
            agentId: "security/security-architect",
            objective:
              "Review the proposed API for threats and insecure assumptions.",
            dependsOn: ["research"],
          },
          {
            key: "qa",
            agentId: "testing/api-tester",
            objective: "Test the API.",
            dependsOn: ["build", "security-review"],
          },
        ],
      }),
    );
    const planner = new PlanService({ catalog, router });
    const plan = await planner.createPlan({
      goal: "Build a startup MVP service",
      profile: "balanced",
    });
    expect(plan.selectedAgents.some((agent) => agent.id === unseen.id)).toBe(
      true,
    );

    const prompt = JSON.parse(
      router.complete.mock.calls[0]![0].messages[0]!.content,
    );
    const compactSpecialist = prompt.allowedSpecialists.find(
      (agent: { id: string }) => agent.id === unseen.id,
    );
    expect(compactSpecialist).toBeDefined();
    expect(compactSpecialist.description.length).toBeLessThanOrEqual(320);
    expect(compactSpecialist.tools).toHaveLength(8);
    // Full pinned instructions remain available to the worker after selection.
    expect(plan.selectedAgents.some((agent) => agent.id === unseen.id)).toBe(true);
  });

  it("plans project checkout before repo edits and exposes only configured capabilities", async () => {
    const router = fakeRouter(
      JSON.stringify({
        summary:
          "Check out, implement, test, and propose a reviewed repository change.",
        tasks: [
          {
            key: "checkout",
            agentId: "engineering/backend-architect",
            objective:
              "Check out acme/demo using github.checkout_repository before any source edits.",
            dependsOn: [],
          },
          {
            key: "implement",
            agentId: "engineering/backend-architect",
            objective:
              "Implement the source changes in the checked-out workspace.",
            dependsOn: ["checkout"],
          },
          {
            key: "verify",
            agentId: "testing/api-tester",
            objective:
              "Run the configured sandbox test suite and report command evidence.",
            dependsOn: ["implement"],
          },
          {
            key: "review",
            agentId: "research/research-analyst",
            objective: "Review the code changes and verification evidence.",
            dependsOn: ["implement", "verify"],
          },
          {
            key: "pull-request",
            agentId: "engineering/backend-architect",
            objective:
              "Request github.create_pull_request for acme/demo after review and wait for explicit approval.",
            dependsOn: ["review", "verify"],
            approvalRequired: true,
          },
        ],
      }),
    );
    const planner = new PlanService({
      catalog: fakeCatalog(),
      router,
      githubProjectRepositories: ["acme/demo"],
      githubProjectPublishingEnabled: true,
      webResearchEnabled: true,
      mcpToolsEnabled: true,
      sandboxEnabled: true,
    });
    const plan = await planner.createPlan({
      goal: "Update acme/demo, run tests, review the changes, and open a pull request.",
      profile: "balanced",
    });

    expect(
      plan.tasks.find((task) => task.key === "checkout")?.dependsOn,
    ).toEqual([]);
    expect(
      plan.tasks.find((task) => task.key === "implement")?.dependsOn,
    ).toContain("checkout");
    expect(
      plan.tasks.find((task) => task.key === "pull-request")?.dependsOn,
    ).toContain("review");
    expect(
      plan.tasks.find((task) => task.key === "pull-request")?.approvalRequired,
    ).toBe(true);
    expect(router.complete.mock.calls[0]![0].systemPrompt).toContain(
      "Authenticated GitHub project checkout",
    );
    expect(router.complete.mock.calls[0]![0].systemPrompt).toContain(
      "Publishing is an external action",
    );
    const prompt = JSON.parse(
      router.complete.mock.calls[0]![0].messages[0]!.content,
    );
    expect(prompt.installationCapabilities).toEqual({
      githubProjectRepositories: ["acme/demo"],
      githubProjectCheckoutEnabled: true,
      githubProjectPublishingEnabled: true,
      webResearchEnabled: true,
      mcpToolsEnabled: true,
      sandboxEnabled: true,
    });
  });

  it("supports larger plans when a goal genuinely needs coordinated specialists", async () => {
    const tasks = Array.from({ length: 16 }, (_, index) => ({
      key: `task-${index + 1}`,
      agentId: "engineering/backend-architect",
      objective: `Deliver and verify workstream ${index + 1}.`,
      dependsOn: [],
    }));
    const router = fakeRouter(
      JSON.stringify({
        summary: "Coordinate a complex, multi-workstream delivery.",
        tasks,
      }),
    );
    const catalog = fakeCatalog();
    const planner = new PlanService({ catalog, router });
    const plan = await planner.createPlan({
      goal: "Coordinate a complex platform build with parallel workstreams",
      profile: "balanced",
    });

    expect(plan.tasks).toHaveLength(16);
    expect(catalog.search).toHaveBeenCalledWith(
      "Coordinate a complex platform build with parallel workstreams",
      { limit: 100 },
    );
    expect(router.complete.mock.calls[0]![0].maxTokens).toBe(6000);
  });

  it("refuses model-invented agent IDs", async () => {
    const router = fakeRouter(
      JSON.stringify({
        summary: "bad plan",
        tasks: [
          {
            key: "build",
            agentId: "made-up-agent",
            objective: "Build it",
            dependsOn: [],
          },
        ],
      }),
    );
    const planner = new PlanService({ catalog: fakeCatalog(), router });
    await expect(
      planner.createPlan({ goal: "Build it", profile: "balanced" }),
    ).rejects.toMatchObject({ code: "invalid_model_plan" });
  });

  it("retries malformed plan JSON once, then rejects it", async () => {
    const router = {
      complete: vi
        .fn()
        .mockResolvedValueOnce({
          content: "not json",
          providerId: "openrouter",
          model: "test",
          latencyMs: 2,
          attempts: 1,
          routeProfile: "balanced",
          providerErrors: [],
        })
        .mockResolvedValueOnce({
          content: "still not json",
          providerId: "openrouter",
          model: "test",
          latencyMs: 2,
          attempts: 1,
          routeProfile: "balanced",
          providerErrors: [],
        }),
    };
    const planner = new PlanService({ catalog: fakeCatalog(), router });
    await expect(
      planner.createPlan({ goal: "Plan something", profile: "balanced" }),
    ).rejects.toMatchObject({ code: "invalid_model_plan" });
    expect(router.complete).toHaveBeenCalledTimes(2);
  });
});
