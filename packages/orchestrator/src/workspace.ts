import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

const RelativePathSchema = z.string().min(1).max(1000);
const ListFilesSchema = z.object({}).strict();
const ReadFileSchema = z.object({ path: RelativePathSchema }).strict();
const WriteFileSchema = z
  .object({
    path: RelativePathSchema,
    content: z.string().max(250_000),
    overwrite: z.boolean().default(true),
  })
  .strict();
const SearchTextSchema = z
  .object({
    query: z.string().trim().min(1).max(500),
    limit: z.number().int().min(1).max(100).default(30),
  })
  .strict();

export class WorkspaceToolError extends Error {
  readonly code: string;
  constructor(
    code: string,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "WorkspaceToolError";
    this.code = code;
  }
}

export interface WorkspaceToolCall {
  readonly name:
    | "workspace.list_files"
    | "workspace.read_file"
    | "workspace.write_file"
    | "workspace.search_text";
  readonly arguments: unknown;
}

export interface WorkspaceToolResult {
  readonly name: WorkspaceToolCall["name"];
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: { code: string; message: string };
}

export interface WorkspaceRuntimeOptions {
  readonly root: string;
  readonly maxFileBytes?: number;
  readonly maxFiles?: number;
  readonly maxSearchResults?: number;
}

function isMissing(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT",
  );
}

function validateRunId(runId: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      runId,
    )
  ) {
    throw new WorkspaceToolError(
      "invalid_run_id",
      "Workspace run ID must be a generated UUID.",
    );
  }
  return runId;
}

function cleanRelativePath(path: string): string[] {
  if (
    path.includes("\\") ||
    path.includes("\0") ||
    path.startsWith("/") ||
    isAbsolute(path) ||
    /^[a-z]:/i.test(path)
  ) {
    throw new WorkspaceToolError(
      "invalid_path",
      "Path must be a relative POSIX-style workspace path.",
    );
  }
  const parts = path.split("/");
  if (
    parts.some(
      (part) =>
        !part || part === "." || part === ".." || part.startsWith(".kurochan"),
    )
  ) {
    throw new WorkspaceToolError(
      "invalid_path",
      "Path contains an empty, traversal, or reserved component.",
    );
  }
  return parts;
}

function inside(base: string, target: string): boolean {
  const rel = relative(base, target);
  return (
    rel === "" ||
    (!rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel))
  );
}

async function assertDirectory(path: string): Promise<void> {
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new WorkspaceToolError(
      "unsafe_path",
      "Workspace path contains a symbolic link or a non-directory parent.",
    );
  }
}

export class WorkspaceRuntime {
  readonly root: string;
  private readonly maxFileBytes: number;
  private readonly maxFiles: number;
  private readonly maxSearchResults: number;

  constructor(options: WorkspaceRuntimeOptions) {
    if (!isAbsolute(options.root))
      throw new Error("Workspace root must be an absolute path.");
    this.root = resolve(options.root);
    this.maxFileBytes = options.maxFileBytes ?? 250_000;
    this.maxFiles = options.maxFiles ?? 500;
    this.maxSearchResults = options.maxSearchResults ?? 100;
    if (
      !Number.isInteger(this.maxFileBytes) ||
      this.maxFileBytes < 1024 ||
      this.maxFileBytes > 2_000_000
    )
      throw new Error("maxFileBytes must be 1024..2000000.");
    if (
      !Number.isInteger(this.maxFiles) ||
      this.maxFiles < 1 ||
      this.maxFiles > 5000
    )
      throw new Error("maxFiles must be 1..5000.");
    if (
      !Number.isInteger(this.maxSearchResults) ||
      this.maxSearchResults < 1 ||
      this.maxSearchResults > 1000
    )
      throw new Error("maxSearchResults must be 1..1000.");
  }

  runDirectory(runId: string): string {
    const path = resolve(this.root, validateRunId(runId));
    if (!inside(this.root, path))
      throw new WorkspaceToolError(
        "unsafe_path",
        "Run workspace escaped the workspace root.",
      );
    return path;
  }

  async execute(
    runId: string,
    call: WorkspaceToolCall,
  ): Promise<WorkspaceToolResult> {
    try {
      let result: unknown;
      switch (call.name) {
        case "workspace.list_files":
          ListFilesSchema.parse(call.arguments);
          result = await this.listFiles(runId);
          break;
        case "workspace.read_file": {
          const args = ReadFileSchema.parse(call.arguments);
          result = await this.readFile(runId, args.path);
          break;
        }
        case "workspace.write_file": {
          const args = WriteFileSchema.parse(call.arguments);
          result = await this.writeFile(
            runId,
            args.path,
            args.content,
            args.overwrite,
          );
          break;
        }
        case "workspace.search_text": {
          const args = SearchTextSchema.parse(call.arguments);
          result = await this.searchText(runId, args.query, args.limit);
          break;
        }
      }
      return { name: call.name, ok: true, result };
    } catch (error) {
      const typed = error as { code?: string; message?: string };
      return {
        name: call.name,
        ok: false,
        error: {
          code: typed.code ?? "tool_error",
          message: (typed.message ?? "Workspace tool failed.").slice(0, 1000),
        },
      };
    }
  }

  async listFiles(
    runId: string,
  ): Promise<readonly { path: string; bytes: number }[]> {
    const base = await this.ensureRunDirectory(runId);
    const files: Array<{ path: string; bytes: number }> = [];
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > 8 || files.length >= this.maxFiles) return;
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (files.length >= this.maxFiles) break;
        if (entry.name === ".kurochan" || entry.name.startsWith(".")) continue;
        const fullPath = join(directory, entry.name);
        const info = await lstat(fullPath);
        if (info.isSymbolicLink()) continue;
        if (info.isDirectory()) await visit(fullPath, depth + 1);
        else if (info.isFile()) {
          const rel = relative(base, fullPath).split(sep).join("/");
          files.push({ path: rel, bytes: info.size });
        }
      }
    };
    await visit(base, 0);
    return files;
  }

  async readFile(
    runId: string,
    relativePath: string,
  ): Promise<{ path: string; content: string; bytes: number }> {
    const { base, target, parts } = await this.resolveWorkspacePath(
      runId,
      relativePath,
      false,
    );
    await this.checkParents(base, parts, false);
    let handle;
    try {
      handle = await open(
        target,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const info = await handle.stat();
      if (!info.isFile())
        throw new WorkspaceToolError(
          "not_a_file",
          "The requested workspace path is not a regular file.",
        );
      if (info.size > this.maxFileBytes)
        throw new WorkspaceToolError(
          "file_too_large",
          "Workspace file exceeds the configured read limit.",
        );
      const content = await handle.readFile("utf8");
      if (content.includes("\0"))
        throw new WorkspaceToolError(
          "binary_file",
          "Binary files are not supported by this text tool.",
        );
      return {
        path: relative(base, target).split(sep).join("/"),
        content,
        bytes: Buffer.byteLength(content, "utf8"),
      };
    } catch (error) {
      if (error instanceof WorkspaceToolError) throw error;
      if (isMissing(error))
        throw new WorkspaceToolError(
          "file_not_found",
          "The requested workspace file does not exist.",
        );
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ELOOP"
      )
        throw new WorkspaceToolError(
          "unsafe_path",
          "Symbolic links are not allowed in the workspace.",
        );
      throw new WorkspaceToolError(
        "read_failed",
        "Workspace file could not be read.",
        { cause: error },
      );
    } finally {
      await handle?.close();
    }
  }

  async writeFile(
    runId: string,
    relativePath: string,
    content: string,
    overwrite = true,
  ): Promise<{ path: string; bytes: number; overwritten: boolean }> {
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > this.maxFileBytes)
      throw new WorkspaceToolError(
        "file_too_large",
        "Workspace file exceeds the configured write limit.",
      );
    const { base, target, parts } = await this.resolveWorkspacePath(
      runId,
      relativePath,
      true,
    );
    await this.checkParents(base, parts, true);
    let existed = false;
    try {
      const previous = await lstat(target);
      if (previous.isSymbolicLink() || !previous.isFile())
        throw new WorkspaceToolError(
          "unsafe_path",
          "Writing through a symbolic link or replacing a directory is forbidden.",
        );
      if (!overwrite)
        throw new WorkspaceToolError(
          "already_exists",
          "The workspace file already exists and overwrite is disabled.",
        );
      existed = true;
    } catch (error) {
      if (error instanceof WorkspaceToolError) throw error;
      if (!isMissing(error)) throw error;
    }

    let handle;
    try {
      const flags =
        constants.O_WRONLY |
        constants.O_CREAT |
        (overwrite ? constants.O_TRUNC : constants.O_EXCL) |
        (constants.O_NOFOLLOW ?? 0);
      handle = await open(target, flags, 0o600);
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "EEXIST"
      ) {
        throw new WorkspaceToolError(
          "already_exists",
          "The workspace file already exists and overwrite is disabled.",
        );
      }
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ELOOP"
      ) {
        throw new WorkspaceToolError(
          "unsafe_path",
          "Symbolic links are not allowed in the workspace.",
        );
      }
      throw new WorkspaceToolError(
        "write_failed",
        "Workspace file could not be written.",
        { cause: error },
      );
    } finally {
      await handle?.close();
    }
    return {
      path: relative(base, target).split(sep).join("/"),
      bytes,
      overwritten: existed,
    };
  }

  async searchText(
    runId: string,
    query: string,
    limit = 30,
  ): Promise<readonly { path: string; line: number; text: string }[]> {
    const files = await this.listFiles(runId);
    const needle = query.toLowerCase();
    const matches: Array<{ path: string; line: number; text: string }> = [];
    for (const file of files) {
      if (matches.length >= Math.min(limit, this.maxSearchResults)) break;
      if (file.bytes > this.maxFileBytes) continue;
      let content: string;
      try {
        content = (await this.readFile(runId, file.path)).content;
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index]!;
        if (line.toLowerCase().includes(needle)) {
          matches.push({
            path: file.path,
            line: index + 1,
            text: line.slice(0, 500),
          });
          if (matches.length >= Math.min(limit, this.maxSearchResults)) break;
        }
      }
    }
    return matches;
  }

  private async ensureRunDirectory(runId: string): Promise<string> {
    const base = this.runDirectory(runId);
    await mkdir(this.root, { recursive: true });
    const rootInfo = await lstat(this.root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory())
      throw new WorkspaceToolError(
        "unsafe_root",
        "Configured workspace root must be a real directory.",
      );
    await mkdir(base, { recursive: true });
    await assertDirectory(base);
    return base;
  }

  private async resolveWorkspacePath(
    runId: string,
    relativePath: string,
    createParents: boolean,
  ): Promise<{ base: string; target: string; parts: string[] }> {
    const base = await this.ensureRunDirectory(runId);
    const parts = cleanRelativePath(relativePath);
    const target = resolve(base, ...parts);
    if (!inside(base, target))
      throw new WorkspaceToolError(
        "unsafe_path",
        "Path escaped the run workspace.",
      );
    return { base, target, parts };
  }

  private async checkParents(
    base: string,
    parts: readonly string[],
    create: boolean,
  ): Promise<void> {
    let cursor = base;
    for (const segment of parts.slice(0, -1)) {
      cursor = join(cursor, segment);
      try {
        const info = await lstat(cursor);
        if (info.isSymbolicLink() || !info.isDirectory())
          throw new WorkspaceToolError(
            "unsafe_path",
            "Workspace parent paths must be real directories, not symbolic links.",
          );
      } catch (error) {
        if (!isMissing(error)) throw error;
        if (!create)
          throw new WorkspaceToolError(
            "file_not_found",
            "A parent directory does not exist.",
          );
        try {
          await mkdir(cursor, { mode: 0o700 });
        } catch (mkdirError) {
          if (!(
            mkdirError &&
            typeof mkdirError === "object" &&
            "code" in mkdirError &&
            mkdirError.code === "EEXIST"
          ))
            throw mkdirError;
        }
        await assertDirectory(cursor);
      }
    }
  }
}
