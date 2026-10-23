import { spawn, type ChildProcess } from "node:child_process";
import { lstat, mkdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { WorkspaceRuntime } from "./workspace.js";

const SandboxRunArgsSchema = z
  .object({
    command: z.string().trim().min(1).max(20_000),
    timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
  })
  .strict();

export interface SandboxProcessResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly termination: "exited" | "timeout" | "output_limit";
  readonly outputTruncated: boolean;
}

export interface SandboxProcessOptions {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
}

export interface SandboxProcessRunner {
  run(
    executable: string,
    args: readonly string[],
    options: SandboxProcessOptions,
  ): Promise<SandboxProcessResult>;
}

export class SandboxError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(
    code: string,
    message: string,
    retryable = false,
    options: { cause?: unknown } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "SandboxError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface SandboxRuntimeOptions {
  readonly workspaceRoot: string;
  readonly image?: string;
  readonly dockerBinary?: string;
  readonly network?: "none" | "bridge";
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly runner?: SandboxProcessRunner;
}

export interface SandboxExecutor {
  execute(
    runId: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<SandboxToolResult>;
}

export interface SandboxToolResult {
  readonly name: "sandbox.run";
  readonly ok: boolean;
  readonly result?: SandboxProcessResult & {
    readonly command: string;
    readonly network: "none" | "bridge";
  };
  readonly error?: { readonly code: string; readonly message: string };
}

function dockerImageName(value: string): string {
  const image = value.trim();
  if (
    !image ||
    image.length > 255 ||
    /\s/.test(image) ||
    image.startsWith("-")
  ) {
    throw new Error(
      "Sandbox image must be a valid, non-empty Docker image reference.",
    );
  }
  return image;
}

function asToolError(error: unknown): { code: string; message: string } {
  const value = error as { code?: unknown; message?: unknown };
  const code = typeof value?.code === "string" ? value.code : "sandbox_failed";
  const message =
    typeof value?.message === "string"
      ? value.message
      : "Sandbox execution failed.";
  return { code, message: message.slice(0, 1000) };
}

/**
 * Runs generated commands inside a Docker container. The container sees only its
 * run workspace, has a read-only root filesystem, no Linux capabilities, bounded
 * CPU/memory/PIDs/output/time, and no network by default. The image must already
 * exist locally; commands cannot trigger an implicit image pull.
 */
export class DockerSandboxRuntime {
  readonly image: string;
  readonly network: "none" | "bridge";
  private readonly workspace: WorkspaceRuntime;
  private readonly dockerBinary: string;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly runner: SandboxProcessRunner;

  constructor(options: SandboxRuntimeOptions) {
    if (!isAbsolute(options.workspaceRoot)) {
      throw new Error("Sandbox workspace root must be an absolute path.");
    }
    this.workspace = new WorkspaceRuntime({ root: options.workspaceRoot });
    this.image = dockerImageName(options.image ?? "node:22-bookworm-slim");
    this.dockerBinary = options.dockerBinary?.trim() || "docker";
    if (this.dockerBinary.includes("\0"))
      throw new Error("Docker executable is invalid.");
    this.network = options.network ?? "none";
    if (this.network !== "none" && this.network !== "bridge") {
      throw new Error("Sandbox network must be none or bridge.");
    }
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxOutputBytes = options.maxOutputBytes ?? 40_000;
    if (
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 1_000 ||
      this.timeoutMs > 120_000
    ) {
      throw new Error("Sandbox timeout must be between 1000 and 120000 ms.");
    }
    if (
      !Number.isInteger(this.maxOutputBytes) ||
      this.maxOutputBytes < 1024 ||
      this.maxOutputBytes > 200_000
    ) {
      throw new Error(
        "Sandbox output limit must be between 1024 and 200000 bytes.",
      );
    }
    this.runner = options.runner ?? new NodeSandboxProcessRunner();
  }

  async execute(
    runId: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<SandboxToolResult> {
    const parsed = SandboxRunArgsSchema.safeParse(input);
    if (!parsed.success) {
      return {
        name: "sandbox.run",
        ok: false,
        error: {
          code: "invalid_arguments",
          message: "Sandbox command arguments are invalid.",
        },
      };
    }
    if (signal?.aborted) {
      return {
        name: "sandbox.run",
        ok: false,
        error: {
          code: "cancelled",
          message: "Sandbox execution was cancelled before it started.",
        },
      };
    }

    try {
      const hostWorkspace = await this.prepareWorkspace(runId);
      const uid =
        typeof process.getuid === "function" ? process.getuid() : 1000;
      const gid =
        typeof process.getgid === "function" ? process.getgid() : 1000;
      const args = [
        "run",
        "--rm",
        "--init",
        "--pull=never",
        "--network=" + this.network,
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--pids-limit=128",
        "--memory=768m",
        "--cpus=1",
        "--user=" + uid + ":" + gid,
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=64m",
        "--mount",
        "type=bind,source=" + hostWorkspace + ",target=/workspace",
        "--workdir=/workspace",
        "--env",
        "HOME=/tmp",
        "--env",
        "CI=true",
        this.image,
        "sh",
        "-lc",
        parsed.data.command,
      ];
      if (hostWorkspace.includes(",")) {
        throw new SandboxError(
          "invalid_workspace_path",
          "Workspace paths containing commas are not supported by the Docker mount contract.",
        );
      }
      const result = await this.runner.run(this.dockerBinary, args, {
        timeoutMs: parsed.data.timeoutMs ?? this.timeoutMs,
        maxOutputBytes: this.maxOutputBytes,
        ...(signal ? { signal } : {}),
      });
      return {
        name: "sandbox.run",
        ok: true,
        result: {
          ...result,
          command: parsed.data.command,
          network: this.network,
        },
      };
    } catch (error) {
      return { name: "sandbox.run", ok: false, error: asToolError(error) };
    }
  }

  private async prepareWorkspace(runId: string): Promise<string> {
    const root = this.workspace.root;
    await mkdir(root, { recursive: true, mode: 0o700 });
    const rootInfo = await lstat(root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      throw new SandboxError(
        "unsafe_workspace_root",
        "Sandbox workspace root must be a real directory.",
      );
    }
    const directory = this.workspace.runDirectory(runId);
    if (!directory.startsWith(root + "/") && directory !== root) {
      throw new SandboxError(
        "unsafe_workspace_path",
        "Run workspace escaped the configured root.",
      );
    }
    try {
      await mkdir(directory, { recursive: false, mode: 0o700 });
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "";
      if (code !== "EEXIST") throw error;
    }
    const directoryInfo = await lstat(directory);
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
      throw new SandboxError(
        "unsafe_workspace_path",
        "Run workspace must be a real directory.",
      );
    }
    return resolve(directory);
  }
}

class NodeSandboxProcessRunner implements SandboxProcessRunner {
  async run(
    executable: string,
    args: readonly string[],
    options: SandboxProcessOptions,
  ): Promise<SandboxProcessResult> {
    if (options.signal?.aborted) {
      throw new SandboxError("cancelled", "Sandbox execution was cancelled.");
    }
    return new Promise((resolveResult, rejectResult) => {
      const startedAt = Date.now();
      let stdout = "";
      let stderr = "";
      let capturedBytes = 0;
      let outputTruncated = false;
      let termination: SandboxProcessResult["termination"] = "exited";
      let settled = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let child: ChildProcess;

      const cleanup = () => {
        if (deadline) clearTimeout(deadline);
        if (killTimer) clearTimeout(killTimer);
        options.signal?.removeEventListener("abort", onAbort);
      };
      const fail = (error: SandboxError) => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectResult(error);
      };
      const terminate = (reason: "timeout" | "output_limit") => {
        if (settled || termination !== "exited") return;
        termination = reason;
        try {
          child.kill("SIGTERM");
        } catch {
          /* process may already be closed */
        }
        killTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* process may already be closed */
          }
        }, 1_000);
        killTimer.unref?.();
      };
      const onAbort = () => {
        if (settled) return;
        try {
          child.kill("SIGTERM");
        } catch {
          /* process may already be closed */
        }
        killTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* process may already be closed */
          }
        }, 1_000);
        killTimer.unref?.();
      };

      try {
        child = spawn(executable, [...args], {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (error) {
        fail(
          new SandboxError(
            "sandbox_unavailable",
            "Could not start the Docker sandbox process.",
            false,
            { cause: error },
          ),
        );
        return;
      }
      options.signal?.addEventListener("abort", onAbort, { once: true });
      deadline = setTimeout(() => terminate("timeout"), options.timeoutMs);
      deadline.unref?.();

      const capture = (chunk: Buffer, stream: "stdout" | "stderr") => {
        const remaining = Math.max(0, options.maxOutputBytes - capturedBytes);
        const kept = chunk.subarray(0, remaining);
        capturedBytes += kept.byteLength;
        if (stream === "stdout") stdout += kept.toString("utf8");
        else stderr += kept.toString("utf8");
        if (kept.byteLength < chunk.byteLength) {
          outputTruncated = true;
          terminate("output_limit");
        }
      };
      child.stdout?.on("data", (chunk: Buffer | string) =>
        capture(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), "stdout"),
      );
      child.stderr?.on("data", (chunk: Buffer | string) =>
        capture(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), "stderr"),
      );
      child.once("error", (error) => {
        const code =
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : "";
        fail(
          new SandboxError(
            code === "ENOENT"
              ? "sandbox_unavailable"
              : "sandbox_process_failed",
            code === "ENOENT"
              ? "Docker is not installed or is not available to the worker."
              : "Docker sandbox process could not start.",
            code !== "ENOENT",
            { cause: error },
          ),
        );
      });
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (options.signal?.aborted) {
          rejectResult(
            new SandboxError(
              "cancelled",
              "Sandbox execution was cancelled.",
              true,
            ),
          );
          return;
        }
        resolveResult({
          exitCode: code,
          stdout,
          stderr,
          durationMs: Date.now() - startedAt,
          termination,
          outputTruncated,
        });
      });
    });
  }
}
