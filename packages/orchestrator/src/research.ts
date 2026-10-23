import { z } from "zod";
import type { Evidence } from "@kurochan/storage";

const RepositoryNameSchema = z.string().trim().regex(
  /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/,
  "repository must use owner/name form",
);

const SearchRepositoriesArgs = z.object({
  query: z.string().trim().min(2).max(200),
  limit: z.number().int().min(1).max(10).default(5),
}).strict();

const RepositoryArgs = z.object({
  repository: RepositoryNameSchema,
}).strict();

const ListFilesArgs = z.object({
  repository: RepositoryNameSchema,
  path: z.string().max(1000).optional(),
  ref: z.string().trim().min(1).max(200).optional(),
}).strict();

const ReadFileArgs = z.object({
  repository: RepositoryNameSchema,
  path: z.string().trim().min(1).max(1000),
  ref: z.string().trim().min(1).max(200).optional(),
}).strict();

export const GitHubResearchToolNameSchema = z.enum([
  "github.search_repositories",
  "github.get_repository",
  "github.list_files",
  "github.read_file",
]);
export type GitHubResearchToolName = z.infer<typeof GitHubResearchToolNameSchema>;

export interface GitHubResearchToolCall {
  readonly name: GitHubResearchToolName;
  readonly arguments: unknown;
}

export interface GitHubResearchToolResult {
  readonly name: GitHubResearchToolName;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
  readonly evidence?: readonly Evidence[];
}

interface RepositoryData {
  readonly full_name: string;
  readonly name: string;
  readonly owner: { readonly login: string };
  readonly description: string | null;
  readonly html_url: string;
  readonly default_branch: string;
  readonly stargazers_count: number;
  readonly language: string | null;
  readonly license: { readonly spdx_id: string | null; readonly name: string } | null;
  readonly topics?: readonly string[] | undefined;
  readonly updated_at: string;
  readonly private?: boolean;
}

const RepositoryDataSchema = z.object({
  full_name: z.string(),
  name: z.string(),
  owner: z.object({ login: z.string() }),
  description: z.string().nullable(),
  html_url: z.string().url(),
  default_branch: z.string(),
  stargazers_count: z.number().int().nonnegative(),
  language: z.string().nullable(),
  license: z.object({
    spdx_id: z.string().nullable(),
    name: z.string(),
  }).nullable(),
  topics: z.array(z.string()).optional(),
  updated_at: z.string(),
  private: z.boolean().optional(),
}).passthrough();

const SearchResponseSchema = z.object({
  items: z.array(RepositoryDataSchema),
}).passthrough();

const ContentsEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.string(),
  size: z.number().int().nonnegative().optional(),
  html_url: z.string().url().optional(),
}).passthrough();

const ContentsFileSchema = z.object({
  type: z.literal("file"),
  path: z.string(),
  size: z.number().int().nonnegative(),
  encoding: z.string(),
  content: z.string(),
  html_url: z.string().url(),
}).passthrough();

const API_ROOT = "https://api.github.com";
const MAX_READ_BYTES = 50_000;
const REQUEST_TIMEOUT_MS = 12_000;

class ResearchError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "ResearchError";
    this.code = code;
    this.retryable = retryable;
  }
}

function parseRepository(value: string): { owner: string; repo: string } {
  const parsed = RepositoryNameSchema.safeParse(value);
  if (!parsed.success) {
    throw new ResearchError("invalid_repository", "Repository must use owner/name form.");
  }
  const [owner, repo] = parsed.data.split("/");
  return { owner: owner!, repo: repo! };
}

function cleanRepoPath(value: string, allowEmpty = false): string {
  if ((!allowEmpty && !value) || value.startsWith("/") || value.includes("\\") || value.includes("\0")) {
    throw new ResearchError("invalid_path", "Repository path must be a relative POSIX path.");
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "." || part === ".." || part === "")) {
    if (!(allowEmpty && value === "")) {
      throw new ResearchError("invalid_path", "Repository path contains an unsafe component.");
    }
  }
  return parts.map((part) => encodeURIComponent(part)).join("/");
}

function canonicalRepositoryUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "github.com") {
    throw new ResearchError("invalid_source_url", "GitHub returned a non-canonical repository URL.");
  }
  return url.toString();
}

function sourceEvidence(uri: string, summary: string): Evidence {
  return { kind: "github_source", summary: summary.slice(0, 2000), uri };
}

function repositorySummary(repository: RepositoryData) {
  return {
    fullName: repository.full_name,
    name: repository.name,
    description: repository.description,
    url: canonicalRepositoryUrl(repository.html_url),
    defaultBranch: repository.default_branch,
    stars: repository.stargazers_count,
    language: repository.language,
    license: repository.license
      ? { id: repository.license.spdx_id, name: repository.license.name }
      : null,
    topics: repository.topics ?? [],
    updatedAt: repository.updated_at,
  };
}

/**
 * Read-only GitHub research, deliberately limited to GitHub's fixed API host.
 * It does not accept arbitrary URLs or execute code from repositories.
 */
export class GitHubResearchRuntime {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1000 || this.timeoutMs > 30_000) {
      throw new Error("GitHub research timeout must be between 1000 and 30000 ms.");
    }
  }

  async execute(call: GitHubResearchToolCall, signal?: AbortSignal): Promise<GitHubResearchToolResult> {
    try {
      switch (call.name) {
        case "github.search_repositories": {
          const args = SearchRepositoriesArgs.parse(call.arguments);
          const query = new URLSearchParams({
            q: args.query + " in:name,description,readme",
            per_page: String(args.limit),
            sort: "stars",
            order: "desc",
          });
          const data = SearchResponseSchema.parse(await this.requestJson("/search/repositories?" + query.toString(), signal));
          const items = data.items
            .filter((repository) => repository.private !== true)
            .map(repositorySummary);
          return {
            name: call.name,
            ok: true,
            result: { query: args.query, items },
            evidence: items.map((item) => sourceEvidence(item.url, item.fullName + ": " + (item.description ?? "No description provided."))),
          };
        }
        case "github.get_repository": {
          const args = RepositoryArgs.parse(call.arguments);
          const { owner, repo } = parseRepository(args.repository);
          const repository = RepositoryDataSchema.parse(await this.requestJson(
            "/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repo),
            signal,
          ));
          if (repository.private) throw new ResearchError("private_repository", "Private repositories require a user-authorized GitHub connection.");
          const summary = repositorySummary(repository);
          return {
            name: call.name,
            ok: true,
            result: summary,
            evidence: [sourceEvidence(summary.url, "Repository metadata for " + summary.fullName)],
          };
        }
        case "github.list_files": {
          const args = ListFilesArgs.parse(call.arguments);
          const { owner, repo } = parseRepository(args.repository);
          const path = args.path === undefined ? "" : cleanRepoPath(args.path, true);
          const query = new URLSearchParams();
          if (args.ref) query.set("ref", args.ref);
          const suffix = query.size ? "?" + query.toString() : "";
          const endpoint = "/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repo) +
            "/contents" + (path ? "/" + path : "") + suffix;
          const raw = await this.requestJson(endpoint, signal);
          const contents = z.array(ContentsEntrySchema).max(100).parse(raw);
          const visible = contents.map((entry) => ({
            name: entry.name,
            path: entry.path,
            type: entry.type,
            size: entry.size ?? null,
            url: entry.html_url ? canonicalRepositoryUrl(entry.html_url) : null,
          }));
          return {
            name: call.name,
            ok: true,
            result: { repository: args.repository, path: args.path ?? "", entries: visible },
            evidence: visible
              .filter((entry): entry is typeof entry & { url: string } => entry.url !== null)
              .slice(0, 20)
              .map((entry) => sourceEvidence(entry.url, "Repository entry " + entry.path + " (" + entry.type + ")")),
          };
        }
        case "github.read_file": {
          const args = ReadFileArgs.parse(call.arguments);
          const { owner, repo } = parseRepository(args.repository);
          const path = cleanRepoPath(args.path);
          const query = new URLSearchParams();
          if (args.ref) query.set("ref", args.ref);
          const suffix = query.size ? "?" + query.toString() : "";
          const endpoint = "/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repo) +
            "/contents/" + path + suffix;
          const file = ContentsFileSchema.parse(await this.requestJson(endpoint, signal));
          if (file.size > MAX_READ_BYTES) {
            throw new ResearchError("file_too_large", "Repository file exceeds the 50 KB research read limit.");
          }
          if (file.encoding !== "base64") {
            throw new ResearchError("unsupported_encoding", "GitHub returned a file with an unsupported content encoding.");
          }
          const content = Buffer.from(file.content.replace(/\s/g, ""), "base64").toString("utf8");
          if (content.includes("\0")) throw new ResearchError("binary_file", "Binary repository files are not supported by this research tool.");
          const url = canonicalRepositoryUrl(file.html_url);
          return {
            name: call.name,
            ok: true,
            result: {
              repository: args.repository,
              path: file.path,
              content,
              bytes: Buffer.byteLength(content, "utf8"),
              url,
              ref: args.ref ?? "default branch",
            },
            evidence: [sourceEvidence(url, "Read source file " + args.repository + "/" + file.path)],
          };
        }
      }
    } catch (error) {
      const typed = error as { code?: string; message?: string; retryable?: boolean };
      const code = error instanceof z.ZodError
        ? "invalid_arguments"
        : typed.code ?? (signal?.aborted ? "cancelled" : "github_research_failed");
      const message = error instanceof z.ZodError
        ? "GitHub research tool arguments did not match its schema."
        : typed.message ?? "GitHub research request failed.";
      return {
        name: call.name,
        ok: false,
        error: {
          code,
          message: message.slice(0, 1000),
        },
      };
    }
  }

  private async requestJson(path: string, signal?: AbortSignal): Promise<unknown> {
    if (!path.startsWith("/") || path.startsWith("//")) {
      throw new ResearchError("invalid_endpoint", "GitHub API path must be relative to the trusted API host.");
    }
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    let response: Response;
    try {
      response = await this.fetchImpl(API_ROOT + path, {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "Kuro-chan-GitHub-Research",
        },
        signal: combinedSignal,
      });
    } catch (error) {
      if (signal?.aborted) throw new ResearchError("cancelled", "GitHub research was cancelled.", true);
      throw new ResearchError("github_unavailable", "GitHub could not be reached before the request deadline.", true);
    }
    if (!response.ok) {
      if (response.status === 404) throw new ResearchError("not_found", "The public GitHub resource was not found.");
      if (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") {
        throw new ResearchError("github_rate_limited", "GitHub's unauthenticated API quota is exhausted.", true);
      }
      if (response.status === 429 || response.status >= 500) {
        throw new ResearchError("github_unavailable", "GitHub returned a temporary error.", true);
      }
      if (response.status === 401 || response.status === 403) {
        throw new ResearchError("github_forbidden", "GitHub did not permit this public research request.");
      }
      throw new ResearchError("github_request_failed", "GitHub returned HTTP " + response.status + ".");
    }
    try {
      return await response.json() as unknown;
    } catch {
      throw new ResearchError("invalid_github_response", "GitHub returned invalid JSON.", true);
    }
  }
}
