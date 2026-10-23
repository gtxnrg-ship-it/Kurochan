import "dotenv/config";
import { resolve } from "node:path";
import { AgentCatalog } from "@kurochan/agent-catalog";
import { createProviderRegistry } from "@kurochan/model-gateway";
import { OmniRouter, routeOrdersFromEnvironment } from "@kurochan/omnirouter";
import {
  DockerSandboxRuntime,
  GitHubProjectRuntime,
  McpToolRuntime,
  TaskWorker,
  WebResearchRuntime,
} from "@kurochan/orchestrator";
import { RunStore } from "@kurochan/storage";

function integerEnv(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

const registry = createProviderRegistry(process.env);
const store = new RunStore(
  process.env.KUROCHAN_DB_PATH?.trim() || "data/kurochan.sqlite",
);
const router = new OmniRouter({
  providers: registry.providers,
  routeOrder: routeOrdersFromEnvironment(process.env),
  maxAttempts: integerEnv("OMNIROUTER_MAX_ATTEMPTS", 2, 1, 5),
  maxConcurrentRequests: integerEnv("OMNIROUTER_MAX_CONCURRENT", 24, 1, 256),
  failureThreshold: integerEnv("OMNIROUTER_FAILURE_THRESHOLD", 3, 1, 20),
  circuitCooldownMs: integerEnv(
    "OMNIROUTER_CIRCUIT_COOLDOWN_MS",
    30_000,
    1_000,
    300_000,
  ),
  onUsage: (event) => store.recordProviderUsage(event),
});

const webResearch = new WebResearchRuntime({
  ...(process.env.BRAVE_SEARCH_API_KEY?.trim()
    ? { apiKey: process.env.BRAVE_SEARCH_API_KEY.trim() }
    : {}),
  ...(process.env.BRAVE_SEARCH_COUNTRY?.trim()
    ? { country: process.env.BRAVE_SEARCH_COUNTRY.trim() }
    : {}),
  ...(process.env.BRAVE_SEARCH_LANG?.trim()
    ? { searchLang: process.env.BRAVE_SEARCH_LANG.trim() }
    : {}),
});

const sandboxEnabled =
  process.env.KUROCHAN_SANDBOX_ENABLED?.trim().toLowerCase() === "true";
const sandboxNetwork =
  process.env.KUROCHAN_SANDBOX_NETWORK?.trim().toLowerCase() || "none";
if (sandboxNetwork !== "none" && sandboxNetwork !== "bridge") {
  throw new Error("KUROCHAN_SANDBOX_NETWORK must be none or bridge.");
}

const workspaceRoot = resolve(
  process.env.KUROCHAN_WORKSPACE_ROOT?.trim() || "data/workspaces",
);
const githubAllowedRepositories = (
  process.env.KUROCHAN_GITHUB_ALLOWED_REPOSITORIES ?? ""
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const githubProjectMaxFileBytes = integerEnv(
  "KUROCHAN_GITHUB_MAX_FILE_BYTES",
  250_000,
  1_024,
  1_000_000,
);
const githubProject = new GitHubProjectRuntime({
  workspaceRoot,
  ...(process.env.KUROCHAN_GITHUB_TOKEN?.trim()
    ? { token: process.env.KUROCHAN_GITHUB_TOKEN.trim() }
    : {}),
  allowedRepositories: githubAllowedRepositories,
  writeEnabled:
    process.env.KUROCHAN_GITHUB_WRITE_ENABLED?.trim().toLowerCase() === "true",
  maxFiles: integerEnv("KUROCHAN_GITHUB_MAX_FILES", 500, 1, 2000),
  maxFileBytes: githubProjectMaxFileBytes,
  maxTotalBytes: integerEnv(
    "KUROCHAN_GITHUB_MAX_TOTAL_BYTES",
    10_000_000,
    githubProjectMaxFileBytes,
    50_000_000,
  ),
});

const mcpTools = McpToolRuntime.fromEnvironment(process.env);
const catalog = new AgentCatalog();
const worker = new TaskWorker({
  store,
  catalog,
  router,
  workspaceRoot,
  webResearch,
  githubProject,
  mcpTools,
  ...(sandboxEnabled
    ? {
        sandbox: new DockerSandboxRuntime({
          workspaceRoot,
          ...(process.env.KUROCHAN_SANDBOX_IMAGE?.trim()
            ? { image: process.env.KUROCHAN_SANDBOX_IMAGE.trim() }
            : {}),
          ...(process.env.DOCKER_BINARY?.trim()
            ? { dockerBinary: process.env.DOCKER_BINARY.trim() }
            : {}),
          network: sandboxNetwork,
          timeoutMs: integerEnv(
            "KUROCHAN_SANDBOX_TIMEOUT_MS",
            30_000,
            1_000,
            120_000,
          ),
          maxOutputBytes: integerEnv(
            "KUROCHAN_SANDBOX_MAX_OUTPUT_BYTES",
            40_000,
            1_024,
            200_000,
          ),
        }),
      }
    : {}),
  ...(process.env.KUROCHAN_WORKER_ID?.trim()
    ? { workerId: process.env.KUROCHAN_WORKER_ID.trim() }
    : {}),
  leaseMs: integerEnv("KUROCHAN_WORKER_LEASE_MS", 120_000, 1_000, 600_000),
  pollIntervalMs: integerEnv("KUROCHAN_WORKER_POLL_MS", 1_000, 100, 30_000),
  maxToolRounds: integerEnv("KUROCHAN_WORKER_MAX_TOOL_ROUNDS", 6, 1, 12),
  concurrency: integerEnv("KUROCHAN_WORKER_CONCURRENCY", 4, 1, 32),
  onError: (error) => {
    const message =
      error instanceof Error ? error.message : "Unknown worker error";
    process.stderr.write(
      JSON.stringify({ level: "error", service: "kurochan-worker", message }) +
        "\n",
    );
  },
});

let shuttingDown = false;
worker.start();
process.stdout.write(
  JSON.stringify({
    level: "info",
    service: "kurochan-worker",
    workerId: worker.workerId,
    concurrency: integerEnv("KUROCHAN_WORKER_CONCURRENCY", 4, 1, 32),
    configuredProviders: registry.statuses
      .filter((provider) => provider.configured)
      .map((provider) => provider.id),
    workspaceRoot,
    sandboxEnabled,
    sandboxNetwork: sandboxEnabled ? sandboxNetwork : "disabled",
    webResearchConfigured: webResearch.isConfigured,
    githubProjectConfigured: githubProject.isConfigured,
    githubProjectPublishingEnabled: githubProject.canPublish,
    githubAllowedRepositoryCount: githubAllowedRepositories.length,
    mcpConfiguredServerCount: mcpTools.configuredServers().length,
  }) + "\n",
);

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(
    JSON.stringify({
      level: "info",
      service: "kurochan-worker",
      signal,
      message: "Stopping worker cleanly.",
    }) + "\n",
  );
  try {
    await worker.stop();
  } finally {
    store.close();
  }
}

process.once("SIGINT", () => {
  void shutdown("SIGINT").catch((error: unknown) => {
    process.stderr.write(
      JSON.stringify({
        level: "error",
        service: "kurochan-worker",
        message: error instanceof Error ? error.message : "Shutdown failed",
      }) + "\n",
    );
    process.exitCode = 1;
  });
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM").catch((error: unknown) => {
    process.stderr.write(
      JSON.stringify({
        level: "error",
        service: "kurochan-worker",
        message: error instanceof Error ? error.message : "Shutdown failed",
      }) + "\n",
    );
    process.exitCode = 1;
  });
});
