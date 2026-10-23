import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { Evidence } from "@kurochan/storage";
import { WorkspaceRuntime } from "./workspace.js";

const API_ROOT = "https://api.github.com";
const RepositoryNameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/);
const CheckoutArgsSchema = z
  .object({
    repository: RepositoryNameSchema,
    ref: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
const PullRequestArgsSchema = z
  .object({
    repository: RepositoryNameSchema,
    title: z.string().trim().min(1).max(250),
    body: z.string().max(10_000).default(""),
  })
  .strict();

export const GitHubProjectToolNameSchema = z.enum([
  "github.checkout_repository",
  "github.create_pull_request",
]);
export type GitHubProjectToolName = z.infer<typeof GitHubProjectToolNameSchema>;

export interface GitHubProjectToolCall {
  readonly name: GitHubProjectToolName;
  readonly arguments: unknown;
}

export interface GitHubProjectToolResult {
  readonly name: GitHubProjectToolName;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
  readonly evidence?: readonly Evidence[];
}

export interface GitHubProjectRuntimeOptions {
  readonly workspaceRoot: string;
  readonly token?: string;
  readonly allowedRepositories?: readonly string[];
  readonly writeEnabled?: boolean;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxFiles?: number;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
}

interface RepositoryManifest {
  readonly repository: string;
  readonly baseBranch: string;
  readonly baseCommit: string;
  readonly baseTree: string;
  readonly checkedOutAt: number;
  readonly managed: Readonly<
    Record<string, { sha: string; size: number; mode: "100644" | "100755" }>
  >;
}

const ManifestSchema = z
  .object({
    repository: RepositoryNameSchema,
    baseBranch: z.string().min(1).max(200),
    baseCommit: z.string().regex(/^[0-9a-f]{40}$/i),
    baseTree: z.string().regex(/^[0-9a-f]{40}$/i),
    checkedOutAt: z.number().int().nonnegative(),
    managed: z.record(
      z
        .object({
          sha: z.string().regex(/^[0-9a-f]{40}$/i),
          size: z.number().int().nonnegative(),
          mode: z.enum(["100644", "100755"]),
        })
        .strict(),
    ),
  })
  .strict();

const RepositorySchema = z
  .object({
    full_name: RepositoryNameSchema,
    private: z.boolean(),
    default_branch: z.string().min(1).max(200),
  })
  .passthrough();

const RefSchema = z
  .object({
    object: z
      .object({ sha: z.string().regex(/^[0-9a-f]{40}$/i) })
      .passthrough(),
  })
  .passthrough();

const CommitSchema = z
  .object({
    sha: z.string().regex(/^[0-9a-f]{40}$/i),
    tree: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/i) }).passthrough(),
    commit: z.object({ message: z.string() }).passthrough().optional(),
  })
  .passthrough();

const TreeSchema = z
  .object({
    sha: z.string().regex(/^[0-9a-f]{40}$/i),
    truncated: z.boolean().optional(),
    tree: z
      .array(
        z
          .object({
            path: z.string().min(1).max(1000),
            mode: z.string(),
            type: z.string(),
            sha: z.string().regex(/^[0-9a-f]{40}$/i),
            size: z.number().int().nonnegative().optional(),
          })
          .passthrough(),
      )
      .max(100_000),
  })
  .passthrough();

const BlobSchema = z
  .object({
    sha: z.string().regex(/^[0-9a-f]{40}$/i),
    encoding: z.string(),
    content: z.string(),
    size: z.number().int().nonnegative(),
  })
  .passthrough();

const PullRequestSchema = z
  .object({
    number: z.number().int().positive(),
    html_url: z.string().url(),
    state: z.string(),
  })
  .passthrough();

class ProjectIntegrationError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "ProjectIntegrationError";
    this.code = code;
    this.retryable = retryable;
  }
}

function parseRepository(value: string): {
  owner: string;
  name: string;
  canonical: string;
} {
  const parsed = RepositoryNameSchema.safeParse(value);
  if (!parsed.success) {
    throw new ProjectIntegrationError(
      "invalid_repository",
      "Repository must use owner/name form.",
    );
  }
  const [owner, name] = parsed.data.split("/");
  return {
    owner: owner!,
    name: name!,
    canonical: owner!.toLowerCase() + "/" + name!.toLowerCase(),
  };
}

function repositoryPath(repository: string, suffix = ""): string {
  const parsed = parseRepository(repository);
  return (
    "/repos/" +
    encodeURIComponent(parsed.owner) +
    "/" +
    encodeURIComponent(parsed.name) +
    suffix
  );
}

function safeBranchName(value: string): string {
  if (
    !value ||
    value.length > 200 ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("..") ||
    value.includes("//") ||
    /[~^:?*\[\]\\\s\x00-\x1f]/.test(value) ||
    value.endsWith(".") ||
    value.includes("@{")
  ) {
    throw new ProjectIntegrationError(
      "invalid_branch",
      "Git branch name is invalid.",
    );
  }
  return value;
}

function branchPath(value: string): string {
  return value
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function isSafeProjectPath(path: string): boolean {
  if (
    !path ||
    path.length > 1000 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").length > 8
  )
    return false;
  const parts = path.split("/");
  if (
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part === ".git" ||
        part === ".kurochan" ||
        part === "node_modules",
    )
  )
    return false;
  const base = parts.at(-1)!.toLowerCase();
  if (
    base === ".env" ||
    (base.startsWith(".env.") && base !== ".env.example") ||
    base === ".npmrc" ||
    base === ".pypirc" ||
    base === ".netrc" ||
    base.endsWith(".pem") ||
    base.endsWith(".p12") ||
    base.endsWith(".pfx") ||
    base.endsWith(".key") ||
    base.includes("id_rsa") ||
    base.includes("credentials")
  )
    return false;
  if (parts.some((part) => part.startsWith(".") && part !== ".github")) {
    const allowed = new Set([
      ".gitignore",
      ".dockerignore",
      ".env.example",
      ".editorconfig",
      ".prettierrc",
      ".prettierrc.json",
      ".prettierignore",
      ".eslintignore",
      ".nvmrc",
      ".python-version",
      ".markdownlint.json",
    ]);
    if (parts.length !== 1 || !allowed.has(base)) return false;
  }
  return true;
}

function gitBlobSha(content: string): string {
  const bytes = Buffer.from(content, "utf8");
  return createHash("sha1")
    .update(Buffer.from("blob " + bytes.byteLength + "\0", "utf8"))
    .update(bytes)
    .digest("hex");
}

function sourceEvidence(uri: string, summary: string): Evidence {
  return { kind: "github_project", uri, summary: summary.slice(0, 2000) };
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let nextIndex = 0;
  const run = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= values.length) return;
      output[index] = await mapper(values[index]!, index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => run()),
  );
  return output;
}

/**
 * Optional, token-authenticated GitHub project integration. Reads/writes are
 * restricted to an explicit repository allowlist. Publishing is disabled by
 * default and is additionally approval-gated by TaskWorker.
 */
export class GitHubProjectRuntime {
  private readonly workspace: WorkspaceRuntime;
  private readonly token: string | undefined;
  private readonly allowedRepositories: ReadonlySet<string>;
  private readonly writeEnabled: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxFiles: number;
  private readonly maxFileBytes: number;
  private readonly maxTotalBytes: number;

  constructor(options: GitHubProjectRuntimeOptions) {
    this.workspace = new WorkspaceRuntime({ root: options.workspaceRoot });
    this.token = options.token?.trim() || undefined;
    this.allowedRepositories = new Set(
      (options.allowedRepositories ?? []).map(
        (item) => parseRepository(item).canonical,
      ),
    );
    this.writeEnabled = options.writeEnabled === true;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxFiles = options.maxFiles ?? 500;
    this.maxFileBytes = options.maxFileBytes ?? 250_000;
    this.maxTotalBytes = options.maxTotalBytes ?? 10_000_000;

    if (
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 1_000 ||
      this.timeoutMs > 60_000
    ) {
      throw new Error(
        "GitHub project timeout must be between 1000 and 60000 ms.",
      );
    }
    if (
      !Number.isInteger(this.maxFiles) ||
      this.maxFiles < 1 ||
      this.maxFiles > 2000
    ) {
      throw new Error("GitHub project maxFiles must be between 1 and 2000.");
    }
    if (
      !Number.isInteger(this.maxFileBytes) ||
      this.maxFileBytes < 1024 ||
      this.maxFileBytes > 1_000_000
    ) {
      throw new Error(
        "GitHub project maxFileBytes must be between 1024 and 1000000.",
      );
    }
    if (
      !Number.isInteger(this.maxTotalBytes) ||
      this.maxTotalBytes < this.maxFileBytes ||
      this.maxTotalBytes > 50_000_000
    ) {
      throw new Error(
        "GitHub project maxTotalBytes must be between maxFileBytes and 50000000.",
      );
    }
  }

  get isConfigured(): boolean {
    return Boolean(this.token && this.allowedRepositories.size > 0);
  }

  get canPublish(): boolean {
    return this.isConfigured && this.writeEnabled;
  }

  async execute(
    runId: string,
    call: GitHubProjectToolCall,
    signal?: AbortSignal,
  ): Promise<GitHubProjectToolResult> {
    try {
      if (!this.isConfigured) {
        throw new ProjectIntegrationError(
          "github_project_not_configured",
          "Configure KUROCHAN_GITHUB_TOKEN and KUROCHAN_GITHUB_ALLOWED_REPOSITORIES to enable GitHub project work.",
        );
      }
      if (signal?.aborted)
        throw new ProjectIntegrationError(
          "cancelled",
          "GitHub project operation was cancelled.",
          true,
        );
      switch (call.name) {
        case "github.checkout_repository": {
          const result = await this.checkoutRepository(
            runId,
            CheckoutArgsSchema.parse(call.arguments),
            signal,
          );
          return {
            name: call.name,
            ok: true,
            result,
            evidence: [
              sourceEvidence(
                String((result as { sourceUrl: string }).sourceUrl),
                "Checked out " +
                  String((result as { repository: string }).repository) +
                  " at commit " +
                  String((result as { baseCommit: string }).baseCommit),
              ),
            ],
          };
        }
        case "github.create_pull_request": {
          if (!this.canPublish) {
            throw new ProjectIntegrationError(
              "github_writes_disabled",
              "Publishing is disabled. Set KUROCHAN_GITHUB_WRITE_ENABLED=true after authorizing the repository and token.",
            );
          }
          const result = await this.createPullRequest(
            runId,
            PullRequestArgsSchema.parse(call.arguments),
            signal,
          );
          const payload = result as {
            pullRequest: { url: string; number: number };
            repository: string;
          };
          return {
            name: call.name,
            ok: true,
            result,
            evidence: [
              sourceEvidence(
                payload.pullRequest.url,
                "Created pull request #" +
                  payload.pullRequest.number +
                  " for " +
                  payload.repository,
              ),
            ],
          };
        }
      }
    } catch (error) {
      const typed = error as {
        code?: unknown;
        message?: unknown;
        retryable?: unknown;
      };
      const code =
        error instanceof z.ZodError
          ? "invalid_arguments"
          : typeof typed.code === "string"
            ? typed.code
            : "github_project_failed";
      const message =
        error instanceof z.ZodError
          ? "GitHub project tool arguments did not match its schema."
          : typeof typed.message === "string"
            ? typed.message
            : "GitHub project operation failed.";
      return {
        name: call.name,
        ok: false,
        error: { code, message: message.slice(0, 1000) },
      };
    }
  }

  private assertAllowed(repository: string): string {
    const parsed = parseRepository(repository);
    if (!this.allowedRepositories.has(parsed.canonical)) {
      throw new ProjectIntegrationError(
        "repository_not_allowed",
        "This repository is not on KUROCHAN_GITHUB_ALLOWED_REPOSITORIES.",
      );
    }
    return parsed.canonical;
  }

  private async checkoutRepository(
    runId: string,
    args: z.infer<typeof CheckoutArgsSchema>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const canonical = this.assertAllowed(args.repository);
    const requested = parseRepository(args.repository);
    const runDirectory = this.workspace.runDirectory(runId);
    await mkdir(this.workspace.root, { recursive: true, mode: 0o700 });
    const rootInfo = await lstat(this.workspace.root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      throw new ProjectIntegrationError(
        "unsafe_workspace_root",
        "Workspace root must be a real directory.",
      );
    }
    await mkdir(runDirectory, { recursive: true, mode: 0o700 });
    const directoryInfo = await lstat(runDirectory);
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
      throw new ProjectIntegrationError(
        "unsafe_workspace_path",
        "Run workspace must be a real directory.",
      );
    }
    if ((await readdir(runDirectory)).length > 0) {
      throw new ProjectIntegrationError(
        "workspace_not_empty",
        "Repository checkout requires an empty run workspace. Plan checkout as a prerequisite to file edits.",
      );
    }

    let manifestPath = "";
    const writtenPaths: string[] = [];
    try {
      const repository = RepositorySchema.parse(
        await this.requestJson(
          repositoryPath(args.repository),
          "GET",
          undefined,
          signal,
        ),
      );
      if (repository.full_name.toLowerCase() !== canonical) {
        throw new ProjectIntegrationError(
          "repository_mismatch",
          "GitHub returned a different canonical repository.",
        );
      }
      const baseBranch = safeBranchName(
        args.ref?.trim() || repository.default_branch,
      );
      const ref = RefSchema.parse(
        await this.requestJson(
          repositoryPath(
            args.repository,
            "/git/ref/heads/" + branchPath(baseBranch),
          ),
          "GET",
          undefined,
          signal,
        ),
      );
      const baseCommit = CommitSchema.parse(
        await this.requestJson(
          repositoryPath(args.repository, "/git/commits/" + ref.object.sha),
          "GET",
          undefined,
          signal,
        ),
      );
      const tree = TreeSchema.parse(
        await this.requestJson(
          repositoryPath(
            args.repository,
            "/git/trees/" + baseCommit.sha + "?recursive=1",
          ),
          "GET",
          undefined,
          signal,
        ),
      );
      if (tree.truncated) {
        throw new ProjectIntegrationError(
          "repository_tree_truncated",
          "GitHub truncated this repository tree. Reduce the repository scope before checkout.",
        );
      }

      const candidates = tree.tree
        .filter(
          (entry) =>
            entry.type === "blob" &&
            (entry.mode === "100644" || entry.mode === "100755") &&
            isSafeProjectPath(entry.path),
        )
        .sort((a, b) => a.path.localeCompare(b.path));
      if (candidates.length > this.maxFiles) {
        throw new ProjectIntegrationError(
          "repository_too_large",
          "Repository has " +
            candidates.length +
            " eligible files, exceeding the configured limit of " +
            this.maxFiles +
            ".",
        );
      }
      const expectedTotal = candidates.reduce(
        (sum, entry) => sum + (entry.size ?? 0),
        0,
      );
      if (expectedTotal > this.maxTotalBytes) {
        throw new ProjectIntegrationError(
          "repository_too_large",
          "Repository text files exceed the configured checkout byte budget.",
        );
      }

      const downloaded = await mapConcurrent(candidates, 6, async (entry) => {
        if (signal?.aborted)
          throw new ProjectIntegrationError(
            "cancelled",
            "GitHub repository checkout was cancelled.",
            true,
          );
        if ((entry.size ?? 0) > this.maxFileBytes)
          return { entry, content: undefined as string | undefined };
        const blob = BlobSchema.parse(
          await this.requestJson(
            repositoryPath(args.repository, "/git/blobs/" + entry.sha),
            "GET",
            undefined,
            signal,
          ),
        );
        if (blob.encoding !== "base64")
          return { entry, content: undefined as string | undefined };
        const bytes = Buffer.from(blob.content.replace(/\s/g, ""), "base64");
        if (bytes.byteLength > this.maxFileBytes || bytes.includes(0))
          return { entry, content: undefined as string | undefined };
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          return { entry, content: undefined as string | undefined };
        }
        return { entry, content: text };
      });

      const managed: Record<
        string,
        { sha: string; size: number; mode: "100644" | "100755" }
      > = {};
      let skippedFiles = 0;
      for (const item of downloaded) {
        if (signal?.aborted)
          throw new ProjectIntegrationError(
            "cancelled",
            "GitHub repository checkout was cancelled.",
            true,
          );
        if (item.content === undefined) {
          skippedFiles += 1;
          continue;
        }
        await this.workspace.writeFile(
          runId,
          item.entry.path,
          item.content,
          false,
        );
        writtenPaths.push(item.entry.path);
        managed[item.entry.path] = {
          sha: item.entry.sha,
          size: Buffer.byteLength(item.content, "utf8"),
          mode: item.entry.mode === "100755" ? "100755" : "100644",
        };
      }

      const manifest: RepositoryManifest = {
        repository: canonical,
        baseBranch,
        baseCommit: baseCommit.sha,
        baseTree: baseCommit.tree.sha,
        checkedOutAt: Date.now(),
        managed,
      };
      manifestPath = await this.writeManifest(runId, manifest);
      return {
        repository: canonical,
        baseBranch,
        baseCommit: baseCommit.sha,
        filesCheckedOut: Object.keys(managed).length,
        skippedFiles,
        workspace: "workspace://" + runId + "/",
        sourceUrl:
          "https://github.com/" + requested.owner + "/" + requested.name,
      };
    } catch (error) {
      for (const path of writtenPaths.reverse()) {
        try {
          await rm(resolve(runDirectory, ...path.split("/")), { force: true });
        } catch {
          // Leave cleanup to the operator if a filesystem error prevents safe removal.
        }
      }
      if (manifestPath) {
        try {
          await rm(manifestPath, { force: true });
        } catch {
          /* best-effort cleanup */
        }
      }
      throw error;
    }
  }

  private async createPullRequest(
    runId: string,
    args: z.infer<typeof PullRequestArgsSchema>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const repository = this.assertAllowed(args.repository);
    const manifest = await this.readManifest(runId);
    if (manifest.repository !== repository) {
      throw new ProjectIntegrationError(
        "repository_mismatch",
        "Pull request repository must match the checked-out repository.",
      );
    }
    const currentFiles = await this.workspace.listFiles(runId);
    const currentPaths = new Set(
      currentFiles.map((file) => file.path).filter(isSafeProjectPath),
    );
    const entries: Array<Record<string, unknown>> = [];
    let changedFiles = 0;
    let createdFiles = 0;
    let deletedFiles = 0;

    for (const file of currentFiles) {
      if (signal?.aborted)
        throw new ProjectIntegrationError(
          "cancelled",
          "Pull request creation was cancelled.",
          true,
        );
      if (!isSafeProjectPath(file.path)) continue;
      const current = await this.workspace.readFile(runId, file.path);
      const sha = gitBlobSha(current.content);
      const base = manifest.managed[file.path];
      if (base?.sha === sha) continue;
      if (file.bytes > this.maxFileBytes) {
        throw new ProjectIntegrationError(
          "file_too_large",
          "Changed file " +
            file.path +
            " exceeds the configured repository write limit.",
        );
      }
      const blob = z
        .object({ sha: z.string().regex(/^[0-9a-f]{40}$/i) })
        .parse(
          await this.requestJson(
            repositoryPath(args.repository, "/git/blobs"),
            "POST",
            { content: current.content, encoding: "utf-8" },
            signal,
          ),
        );
      entries.push({
        path: file.path,
        mode: base?.mode ?? "100644",
        type: "blob",
        sha: blob.sha,
      });
      changedFiles += 1;
      if (!base) createdFiles += 1;
    }

    for (const [path, base] of Object.entries(manifest.managed)) {
      if (!currentPaths.has(path)) {
        entries.push({ path, mode: base.mode, type: "blob", sha: null });
        changedFiles += 1;
        deletedFiles += 1;
      }
    }
    if (entries.length === 0) {
      throw new ProjectIntegrationError(
        "no_changes",
        "No repository changes were found in the run workspace.",
      );
    }
    if (entries.length > this.maxFiles) {
      throw new ProjectIntegrationError(
        "too_many_changes",
        "Changed file count exceeds the configured repository limit.",
      );
    }

    const baseRef = RefSchema.parse(
      await this.requestJson(
        repositoryPath(
          args.repository,
          "/git/ref/heads/" + branchPath(manifest.baseBranch),
        ),
        "GET",
        undefined,
        signal,
      ),
    );
    if (baseRef.object.sha !== manifest.baseCommit) {
      throw new ProjectIntegrationError(
        "base_branch_moved",
        "The base branch changed after checkout. Re-checkout and resolve the differences before publishing.",
      );
    }

    const branch = "kurochan/run-" + runId.slice(0, 8);
    let parentCommit = manifest.baseCommit;
    let parentTree = manifest.baseTree;
    let branchExists = false;
    try {
      const existingRef = RefSchema.parse(
        await this.requestJson(
          repositoryPath(
            args.repository,
            "/git/ref/heads/" + branchPath(branch),
          ),
          "GET",
          undefined,
          signal,
        ),
      );
      const existingCommit = CommitSchema.parse(
        await this.requestJson(
          repositoryPath(
            args.repository,
            "/git/commits/" + existingRef.object.sha,
          ),
          "GET",
          undefined,
          signal,
        ),
      );
      const message = existingCommit.commit?.message ?? "";
      if (!message.includes("[Kuro-chan run " + runId + "]")) {
        throw new ProjectIntegrationError(
          "branch_collision",
          "The generated branch name already exists and is not owned by this run.",
        );
      }
      branchExists = true;
      parentCommit = existingCommit.sha;
      parentTree = existingCommit.tree.sha;
    } catch (error) {
      if (
        error instanceof ProjectIntegrationError &&
        error.code === "not_found"
      ) {
        branchExists = false;
      } else {
        throw error;
      }
    }

    const newTree = z
      .object({ sha: z.string().regex(/^[0-9a-f]{40}$/i) })
      .parse(
        await this.requestJson(
          repositoryPath(args.repository, "/git/trees"),
          "POST",
          { base_tree: parentTree, tree: entries },
          signal,
        ),
      );
    let commitSha = parentCommit;
    let treeSha = parentTree;
    if (newTree.sha !== parentTree) {
      const commit = z
        .object({ sha: z.string().regex(/^[0-9a-f]{40}$/i) })
        .parse(
          await this.requestJson(
            repositoryPath(args.repository, "/git/commits"),
            "POST",
            {
              message: "[Kuro-chan run " + runId + "] " + args.title,
              tree: newTree.sha,
              parents: [parentCommit],
            },
            signal,
          ),
        );
      commitSha = commit.sha;
      treeSha = newTree.sha;
    }

    if (!branchExists) {
      await this.requestJson(
        repositoryPath(args.repository, "/git/refs"),
        "POST",
        {
          ref: "refs/heads/" + branch,
          sha: commitSha,
        },
        signal,
      );
    } else if (commitSha !== parentCommit) {
      await this.requestJson(
        repositoryPath(
          args.repository,
          "/git/refs/heads/" + branchPath(branch),
        ),
        "PATCH",
        {
          sha: commitSha,
          force: false,
        },
        signal,
      );
    }

    const pullsQuery = new URLSearchParams({
      state: "open",
      head: parseRepository(args.repository).owner + ":" + branch,
      base: manifest.baseBranch,
      per_page: "20",
    });
    const existingPulls = await this.requestJson(
      repositoryPath(args.repository, "/pulls?" + pullsQuery.toString()),
      "GET",
      undefined,
      signal,
    );
    const existing = z
      .array(PullRequestSchema)
      .parse(existingPulls)
      .find((pull) => pull.state === "open");
    if (existing) {
      return {
        repository,
        branch,
        base: manifest.baseBranch,
        pullRequest: {
          number: existing.number,
          url: existing.html_url,
          state: existing.state,
        },
        changedFiles,
        createdFiles,
        deletedFiles,
        alreadyOpen: true,
        commit: commitSha,
        tree: treeSha,
      };
    }

    const pull = PullRequestSchema.parse(
      await this.requestJson(
        repositoryPath(args.repository, "/pulls"),
        "POST",
        {
          title: args.title,
          body: args.body,
          head: branch,
          base: manifest.baseBranch,
          draft: false,
        },
        signal,
      ),
    );
    return {
      repository,
      branch,
      base: manifest.baseBranch,
      pullRequest: {
        number: pull.number,
        url: pull.html_url,
        state: pull.state,
      },
      changedFiles,
      createdFiles,
      deletedFiles,
      alreadyOpen: false,
      commit: commitSha,
      tree: treeSha,
    };
  }

  private async writeManifest(
    runId: string,
    value: RepositoryManifest,
  ): Promise<string> {
    const directory = await this.metadataDirectory();
    const target = join(directory, runId + ".json");
    const temp = join(directory, runId + "." + randomUUID() + ".tmp");
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(value), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, target);
    return target;
  }

  private async readManifest(runId: string): Promise<RepositoryManifest> {
    const directory = await this.metadataDirectory();
    const path = join(directory, runId + ".json");
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile())
        throw new ProjectIntegrationError(
          "unsafe_manifest",
          "Repository manifest is not a regular file.",
        );
      return ManifestSchema.parse(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if (error instanceof ProjectIntegrationError) throw error;
      if (error instanceof z.ZodError)
        throw new ProjectIntegrationError(
          "invalid_manifest",
          "Repository checkout metadata failed validation.",
        );
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: unknown }).code === "ENOENT"
      ) {
        throw new ProjectIntegrationError(
          "repository_not_checked_out",
          "Checkout the repository in this run before creating a pull request.",
        );
      }
      throw new ProjectIntegrationError(
        "manifest_read_failed",
        "Repository checkout metadata could not be read.",
      );
    }
  }

  private async metadataDirectory(): Promise<string> {
    await mkdir(this.workspace.root, { recursive: true, mode: 0o700 });
    const rootInfo = await lstat(this.workspace.root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory())
      throw new ProjectIntegrationError(
        "unsafe_workspace_root",
        "Workspace root must be a real directory.",
      );
    const directory = resolve(this.workspace.root, ".kurochan-metadata");
    const rel = relative(this.workspace.root, directory);
    if (rel.startsWith(".." + sep) || rel === "..")
      throw new ProjectIntegrationError(
        "unsafe_manifest_path",
        "Repository metadata escaped the workspace root.",
      );
    try {
      await mkdir(directory, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (!(
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: unknown }).code === "EEXIST"
      ))
        throw error;
    }
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new ProjectIntegrationError(
        "unsafe_manifest_path",
        "Repository metadata directory must be a real directory.",
      );
    return directory;
  }

  private async requestJson(
    path: string,
    method: "GET" | "POST" | "PATCH",
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!this.token)
      throw new ProjectIntegrationError(
        "github_token_missing",
        "KUROCHAN_GITHUB_TOKEN is not configured.",
      );
    if (!path.startsWith("/") || path.startsWith("//"))
      throw new ProjectIntegrationError(
        "invalid_endpoint",
        "GitHub API path must be relative to the trusted API host.",
      );
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;
    let response: Response;
    try {
      response = await this.fetchImpl(API_ROOT + path, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: "Bearer " + this.token,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "Kuro-chan-GitHub-Project",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: combinedSignal,
      });
    } catch {
      if (signal?.aborted)
        throw new ProjectIntegrationError(
          "cancelled",
          "GitHub project request was cancelled.",
          true,
        );
      if (timeoutSignal.aborted)
        throw new ProjectIntegrationError(
          "github_timeout",
          "GitHub project request exceeded its deadline.",
          true,
        );
      throw new ProjectIntegrationError(
        "github_unavailable",
        "GitHub could not be reached.",
        true,
      );
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      const code =
        response.status === 401
          ? "github_unauthorized"
          : response.status === 403 &&
              response.headers.get("x-ratelimit-remaining") === "0"
            ? "github_rate_limited"
            : response.status === 404
              ? "not_found"
              : response.status === 409
                ? "github_conflict"
                : response.status === 422
                  ? "github_validation_failed"
                  : response.status === 429 || response.status >= 500
                    ? "github_unavailable"
                    : "github_request_failed";
      const message =
        code === "github_unauthorized"
          ? "GitHub did not accept the configured token."
          : code === "github_rate_limited"
            ? "GitHub API quota is exhausted."
            : code === "not_found"
              ? "The GitHub resource was not found or is not accessible to this token."
              : code === "github_conflict"
                ? "GitHub rejected the operation because the repository state changed."
                : code === "github_validation_failed"
                  ? "GitHub rejected the payload or branch/ref operation."
                  : code === "github_unavailable"
                    ? "GitHub is temporarily unavailable."
                    : "GitHub returned HTTP " + response.status + ".";
      void bodyText;
      throw new ProjectIntegrationError(
        code,
        message,
        response.status === 429 || response.status >= 500,
      );
    }
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new ProjectIntegrationError(
        "invalid_github_response",
        "GitHub returned invalid JSON.",
        true,
      );
    }
  }
}
