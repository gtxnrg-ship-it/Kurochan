import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WorkspaceRuntime } from "../src/workspace.js";
import { RunStore } from "@kurochan/storage";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function createWorkspace() {
  const root = await mkdtemp(join(tmpdir(), "kuro-workspace-integration-"));
  roots.push(root);
  return {
    runtime: new WorkspaceRuntime({ root: resolve(root) }),
    runId: "799f3f6a-a5f0-4f0f-876c-42347e0e183b",
  };
}

describe("workspace editing tools", () => {
  it("indexes code incrementally, ranks relevant files, and skips generated dependency trees", async () => {
    const root = await mkdtemp(join(tmpdir(), "kuro-workspace-index-"));
    roots.push(root);
    const store = new RunStore(":memory:");
    try {
      const run = store.createRun({
        goal: "Test indexed workspace retrieval",
        profile: "balanced",
        tasks: [
          {
            key: "search",
            agentId: "builder",
            objective: "Search the codebase",
          },
        ],
      });
      const runtime = new WorkspaceRuntime({
        root: resolve(root),
        searchIndex: store,
      });
      await runtime.writeFile(
        run.id,
        "src/router.ts",
        'export function getProviderFallback() { return "provider fallback"; }\n',
      );
      await runtime.writeFile(
        run.id,
        "README.md",
        "Project overview and installation notes.\n",
      );
      await runtime.writeFile(
        run.id,
        "node_modules/fake-package/index.js",
        "export function getProviderFallback() {}\n",
      );
      await runtime.writeFile(
        run.id,
        "dist/generated.js",
        "export function getProviderFallback() {}\n",
      );

      const fileList = await runtime.listFiles(run.id);
      expect(fileList.map((file) => file.path)).not.toContain(
        "node_modules/fake-package/index.js",
      );
      expect(fileList.map((file) => file.path)).not.toContain(
        "dist/generated.js",
      );

      const matches = await runtime.searchText(
        run.id,
        "getProviderFallback",
        10,
      );
      expect(matches[0]).toMatchObject({
        path: "src/router.ts",
        line: 1,
      });
      expect(matches[0]?.text).toContain("provider fallback");
      const indexedBefore = store.getWorkspaceIndexState(run.id);
      expect(indexedBefore.map((file) => file.path)).toEqual([
        "README.md",
        "src/router.ts",
      ]);

      await runtime.writeFile(
        run.id,
        "src/router.ts",
        'export function selectModel() { return "chosen"; }\n',
      );
      expect(
        await runtime.searchText(run.id, "getProviderFallback", 10),
      ).toHaveLength(0);
      expect(
        (await runtime.searchText(run.id, "selectModel", 10))[0]?.path,
      ).toBe("src/router.ts");
    } finally {
      store.close();
    }
  });

  it("reads a bounded, line-numbered file range", async () => {
    const { runtime, runId } = await createWorkspace();
    await runtime.writeFile(
      runId,
      "src/app.ts",
      "first\nsecond\nthird\nfourth\n",
    );
    const result = await runtime.execute(runId, {
      name: "workspace.read_file",
      arguments: {
        path: "src/app.ts",
        startLine: 2,
        endLine: 3,
        maxCharacters: 1000,
      },
    });
    expect(result).toMatchObject({
      ok: true,
      result: {
        path: "src/app.ts",
        content: "second\nthird",
        startLine: 2,
        endLine: 3,
        totalLines: 5,
        truncated: false,
      },
    });
  });

  it("only replaces text when the expected exact-match count agrees", async () => {
    const { runtime, runId } = await createWorkspace();
    await runtime.writeFile(runId, "src/app.css", ".button { color: red; }\n");
    const mismatch = await runtime.execute(runId, {
      name: "workspace.replace_text",
      arguments: {
        path: "src/app.css",
        search: "color: red;",
        replace: "color: blue;",
        expectedMatches: 2,
      },
    });
    expect(mismatch).toMatchObject({
      ok: false,
      error: { code: "replacement_count_mismatch" },
    });
    expect((await runtime.readFile(runId, "src/app.css")).content).toContain(
      "color: red;",
    );

    const replaced = await runtime.execute(runId, {
      name: "workspace.replace_text",
      arguments: {
        path: "src/app.css",
        search: "color: red;",
        replace: "color: blue;",
        expectedMatches: 1,
      },
    });
    expect(replaced).toMatchObject({
      ok: true,
      result: { matchesReplaced: 1, overwritten: true },
    });
    expect((await runtime.readFile(runId, "src/app.css")).content).toContain(
      "color: blue;",
    );
  });
});
