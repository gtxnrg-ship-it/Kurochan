import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DockerSandboxRuntime, type SandboxProcessRunner } from "../src/sandbox.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "kuro-sandbox-"));
  roots.push(root);
  return resolve(root);
}

describe("DockerSandboxRuntime", () => {
  it("launches a no-network, resource-limited container with only the run workspace mounted", async () => {
    const root = await makeRoot();
    const runId = "e3eb00b5-1a04-4d0a-a523-3bf5f1151e5f";
    let executable = "";
    let args: readonly string[] = [];
    const runner: SandboxProcessRunner = {
      run: vi.fn(async (program: string, argv: readonly string[]) => {
        executable = program;
        args = argv;
        return {
          exitCode: 0,
          stdout: "all tests passed",
          stderr: "",
          durationMs: 20,
          termination: "exited" as const,
          outputTruncated: false,
        };
      }),
    };
    const runtime = new DockerSandboxRuntime({ workspaceRoot: root, runner });
    const result = await runtime.execute(runId, { command: "npm test" });
    expect(result.ok).toBe(true);
    expect(result.result?.exitCode).toBe(0);
    expect(executable).toBe("docker");
    expect(args).toContain("--network=none");
    expect(args).toContain("--read-only");
    expect(args).toContain("--cap-drop=ALL");
    expect(args).toContain("--pids-limit=128");
    expect(args).toContain("--pull=never");
    expect(args).toContain("sh");
    expect(args).toContain("npm test");
    expect(args.some((arg) => arg.includes("target=/workspace"))).toBe(true);
  });

  it("rejects malformed commands without launching a process", async () => {
    const runner: SandboxProcessRunner = { run: vi.fn() };
    const runtime = new DockerSandboxRuntime({ workspaceRoot: await makeRoot(), runner });
    const result = await runtime.execute("e3eb00b5-1a04-4d0a-a523-3bf5f1151e5f", { command: " " });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_arguments" } });
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("rejects symbolic-link workspaces before mounting them", async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    const runId = "e3eb00b5-1a04-4d0a-a523-3bf5f1151e5f";
    await mkdir(join(root, runId));
    await rm(join(root, runId), { recursive: true, force: true });
    await symlink(outside, join(root, runId));
    const runner: SandboxProcessRunner = { run: vi.fn() };
    const runtime = new DockerSandboxRuntime({ workspaceRoot: root, runner });
    const result = await runtime.execute(runId, { command: "id" });
    expect(result).toMatchObject({ ok: false, error: { code: "unsafe_workspace_path" } });
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("rejects invalid limits and unsafe image names", async () => {
    const root = await makeRoot();
    expect(() => new DockerSandboxRuntime({ workspaceRoot: root, timeoutMs: 999 })).toThrow(/timeout/);
    expect(() => new DockerSandboxRuntime({ workspaceRoot: root, image: "--privileged" })).toThrow(/Docker image/);
    expect(() => new DockerSandboxRuntime({ workspaceRoot: root, maxOutputBytes: 500 })).toThrow(/output limit/);
  });
});
