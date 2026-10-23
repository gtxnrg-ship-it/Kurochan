import { describe, expect, it } from "vitest";
import { AgentCatalog, AGENCY_AGENTS_COMMIT } from "../src/index.js";

describe("Agency Agents catalog", () => {
  it("loads the pinned, broad specialist catalog", async () => {
    const catalog = new AgentCatalog();
    const metadata = await catalog.metadata();
    expect(metadata.pinnedCommit).toBe(AGENCY_AGENTS_COMMIT);
    expect(metadata.license).toBe("MIT");
    expect(metadata.count).toBe(298);
    expect(metadata.divisions.length).toBeGreaterThanOrEqual(15);
  });

  it("searches relevant agents and supports division filtering", async () => {
    const catalog = new AgentCatalog();
    const results = await catalog.search("Unreal Engine world building game environment", { limit: 10 });
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((agent) => agent.division === "game-development")).toBe(true);
    expect((await catalog.list({ division: "game-development" })).length).toBe(21);
  });

  it("does not resolve path traversal IDs", async () => {
    const catalog = new AgentCatalog();
    expect(await catalog.get("../README")).toBeUndefined();
    expect(await catalog.get("engineering/../../README")).toBeUndefined();
  });
});
