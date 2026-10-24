import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CommunitySkillCatalog,
  listCommunityPacks,
} from "../src/community-packs.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("community pack registry", () => {
  it("lists pinned repositories with explicit license and integration states", () => {
    const packs = listCommunityPacks();
    expect(packs).toHaveLength(16);
    expect(
      packs.every((pack) => /^[a-f0-9]{40}$/.test(pack.pinnedRevision)),
    ).toBe(true);
    expect(listCommunityPacks({ query: "debugging" }).length).toBeGreaterThan(
      0,
    );
    expect(listCommunityPacks({ mode: "vendored-skill-pack" })).toHaveLength(4);
    expect(
      listCommunityPacks({ mode: "license-review-required" }),
    ).toHaveLength(1);
    expect(() => listCommunityPacks({ limit: 0 })).toThrow(
      "Community pack limit",
    );
    expect(() => listCommunityPacks({ mode: "unknown" as never })).toThrow(
      "Community pack mode",
    );
  });

  it("loads pinned skill markdown and selects relevant instructions within a strict budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuro-community-skills-"));
    temporaryRoots.push(root);
    const skillPath = join(
      root,
      "vendor",
      "community",
      "superpowers",
      "skills",
      "systematic-debugging",
      "SKILL.md",
    );
    await mkdir(join(skillPath, ".."), { recursive: true });
    await writeFile(
      skillPath,
      [
        "---",
        "name: Systematic Debugging",
        "description: Diagnose failures and find root causes before applying a fix.",
        "---",
        "# Systematic Debugging",
        "",
        "Reproduce the failure, collect evidence, isolate the cause, and verify the fix with a regression test.",
      ].join("\n"),
      "utf8",
    );

    const catalog = new CommunitySkillCatalog({ repositoryRoot: root });
    const selected = await catalog.selectForTask(
      "Debug the broken worker and fix the error",
      { maxSkills: 2, maxCharacters: 2_000 },
    );

    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({
      packId: "superpowers",
      name: "Systematic Debugging",
    });
    expect(selected[0]?.content).toContain("regression test");
    expect(
      (await catalog.status()).find((item) => item.packId === "superpowers"),
    ).toMatchObject({ available: true, skillCount: 1 });
    expect(await catalog.search("debugging")).toHaveLength(1);
  });

  it("ignores missing source submodules and rejects invalid selection budgets", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuro-community-empty-"));
    temporaryRoots.push(root);
    const catalog = new CommunitySkillCatalog({ repositoryRoot: root });
    expect(await catalog.selectForTask("debug an issue")).toEqual([]);
    expect((await catalog.status()).every((item) => !item.available)).toBe(
      true,
    );
    await expect(
      catalog.selectForTask("debug", { maxSkills: 10 }),
    ).rejects.toThrow("selection limit");
    await expect(catalog.search("")).rejects.toThrow("Community skill query");
  });
});
