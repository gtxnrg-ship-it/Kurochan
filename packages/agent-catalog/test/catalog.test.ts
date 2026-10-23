import { describe, expect, it } from "vitest";
import { AgentCatalog, AGENCY_AGENTS_COMMIT } from "../src/index.js";

describe("Agency Agents catalog", () => {
  it("loads the pinned, broad specialist catalog", async () => {
    const catalog = new AgentCatalog();
    const metadata = await catalog.metadata();
    expect(metadata.pinnedCommit).toBe(AGENCY_AGENTS_COMMIT);
    expect(metadata.license).toBe("MIT");
    expect(metadata.count).toBe(282);
    expect(metadata.divisions).toHaveLength(18);
  });

  it("searches relevant agents and supports division filtering", async () => {
    const catalog = new AgentCatalog();
    const results = await catalog.search(
      "Unreal Engine world building game environment",
      { limit: 10 },
    );
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((agent) => agent.division === "game-development")).toBe(
      true,
    );
    expect((await catalog.list({ division: "game-development" })).length).toBe(
      21,
    );
    expect(
      await catalog.get(
        "game-development/unreal-engine/unreal-world-builder",
      ),
    ).toMatchObject({
      name: "Unreal World Builder",
      division: "game-development",
    });
  });

  it("validates upstream NEXUS runbooks against real, pinned specialists", async () => {
    const catalog = new AgentCatalog();
    const runbooks = await catalog.listRunbooks();
    expect(runbooks.length).toBeGreaterThanOrEqual(4);
    expect(runbooks.some((runbook) => runbook.slug === "startup-mvp")).toBe(true);
    expect(
      runbooks.every((runbook) =>
        runbook.roster.every((group) =>
          group.agents.every((id) => id.includes("/")),
        ),
      ),
    ).toBe(true);
    expect((await catalog.readNexusStrategy()).toLowerCase()).toContain("nexus");
  });

  it("does not resolve path traversal IDs", async () => {
    const catalog = new AgentCatalog();
    expect(await catalog.get("../README")).toBeUndefined();
    expect(await catalog.get("engineering/../../README")).toBeUndefined();
  });
});
