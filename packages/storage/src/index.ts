import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type {
  ProviderId,
  RouteProfile,
  RunStatus,
  TaskStatus,
} from "@kurochan/contracts";

export type ProviderUsageOutcome = "success" | "failure";
export type ProviderUsageOperation =
  | "chat"
  | "planning"
  | "task"
  | "verification"
  | "provider_test"
  | "other";

export interface ProviderUsageInput {
  readonly providerId: ProviderId;
  readonly model: string;
  readonly profile: RouteProfile;
  readonly operation: ProviderUsageOperation;
  readonly runId?: string;
  readonly taskId?: string;
  readonly latencyMs: number;
  readonly outcome: ProviderUsageOutcome;
  readonly errorCode?: string;
  readonly usage?: {
    readonly promptTokens?: number;
    readonly completionTokens?: number;
    readonly totalTokens?: number;
  };
}

export interface ProviderUsageSummary {
  readonly providerId: ProviderId;
  readonly model: string;
  readonly operation: ProviderUsageOperation;
  readonly requests: number;
  readonly successfulRequests: number;
  readonly failedRequests: number;
  readonly requestsWithTokenUsage: number;
  readonly requestsWithoutTokenUsage: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly averageLatencyMs: number;
  readonly lastUsedAt: number;
}

export interface PlannedTask {
  readonly key: string;
  readonly agentId: string;
  readonly objective: string;
  readonly dependsOn?: readonly string[];
  readonly maxAttempts?: number;
  readonly input?: unknown;
  readonly approvalRequired?: boolean;
}

export interface CreateRunInput {
  readonly id?: string;
  readonly goal: string;
  readonly profile: RouteProfile;
  readonly tasks: readonly PlannedTask[];
  readonly createdBy?: string;
}

export interface RunRecord {
  readonly id: string;
  readonly goal: string;
  readonly profile: RouteProfile;
  readonly status: RunStatus;
  readonly createdBy?: string;
  readonly output?: unknown;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly version: number;
}

export interface Evidence {
  readonly kind: string;
  readonly summary: string;
  readonly uri?: string;
  readonly metadata?: unknown;
}

export interface TaskRecord {
  readonly id: string;
  readonly runId: string;
  readonly planKey: string;
  readonly agentId: string;
  readonly objective: string;
  readonly status: TaskStatus;
  readonly dependencies: readonly string[];
  readonly input: unknown;
  readonly output?: unknown;
  readonly evidence: readonly Evidence[];
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly approvalRequired: boolean;
  readonly leaseOwner?: string;
  readonly leaseExpiresAt?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface RunEvent {
  readonly id: number;
  readonly runId: string;
  readonly taskId?: string;
  readonly type: string;
  readonly payload: unknown;
  readonly createdAt: number;
}

export interface ClaimOptions {
  readonly now?: number;
  readonly leaseMs?: number;
}

export type WorkerState = "idle" | "busy" | "waiting_for_approval" | "stopping";

export interface WorkerHeartbeatRecord {
  readonly workerId: string;
  readonly state: WorkerState;
  readonly currentTaskId?: string;
  readonly metadata: unknown;
  readonly startedAt: number;
  readonly lastSeenAt: number;
  readonly stale: boolean;
}

export interface FinishFailureInput {
  readonly runId: string;
  readonly taskId: string;
  readonly workerId: string;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly now?: number;
}

interface RunRow {
  id: string;
  goal: string;
  profile: RouteProfile;
  status: RunStatus;
  created_by: string | null;
  output_json: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: number;
  updated_at: number;
  version: number;
}
interface TaskRow {
  id: string;
  run_id: string;
  plan_key: string;
  agent_id: string;
  objective: string;
  status: TaskStatus;
  input_json: string;
  output_json: string | null;
  evidence_json: string | null;
  error_code: string | null;
  error_message: string | null;
  attempts: number;
  max_attempts: number;
  approval_required: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  available_at: number;
  created_at: number;
  updated_at: number;
}
interface EventRow {
  id: number;
  run_id: string;
  task_id: string | null;
  type: string;
  payload_json: string;
  created_at: number;
}

const MAX_JSON_BYTES = 1_000_000;
const VALID_PROFILES = new Set<RouteProfile>(["fast", "balanced", "quality"]);

function encodeJson(value: unknown): string {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value ?? null);
  } catch {
    throw new Error("Value must be JSON-serializable.");
  }
  if (encoded === undefined)
    throw new Error("Value must be JSON-serializable.");
  if (Buffer.byteLength(encoded, "utf8") > MAX_JSON_BYTES)
    throw new Error("Stored JSON payload exceeds the 1 MB limit.");
  return encoded;
}
function decodeJson(value: string | null): unknown {
  if (value === null) return undefined;
  return JSON.parse(value) as unknown;
}
function assertText(value: string, field: string, max = 20_000): void {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > max
  ) {
    throw new Error(
      `${field} must be a non-empty string of at most ${max} characters.`,
    );
  }
}
function asRun(row: RunRow | undefined): RunRecord | undefined {
  if (!row) return undefined;
  return {
    id: row.id,
    goal: row.goal,
    profile: row.profile,
    status: row.status,
    ...(row.created_by ? { createdBy: row.created_by } : {}),
    ...(row.output_json === null
      ? {}
      : { output: decodeJson(row.output_json) }),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}
function asTask(
  row: TaskRow | undefined,
  dependencies: readonly string[] = [],
): TaskRecord | undefined {
  if (!row) return undefined;
  const evidence = row.evidence_json ? decodeJson(row.evidence_json) : [];
  return {
    id: row.id,
    runId: row.run_id,
    planKey: row.plan_key,
    agentId: row.agent_id,
    objective: row.objective,
    status: row.status,
    dependencies,
    input: decodeJson(row.input_json),
    ...(row.output_json === null
      ? {}
      : { output: decodeJson(row.output_json) }),
    evidence: Array.isArray(evidence) ? (evidence as Evidence[]) : [],
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    approvalRequired: row.approval_required === 1,
    ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}),
    ...(row.lease_expires_at === null
      ? {}
      : { leaseExpiresAt: row.lease_expires_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class RunStore {
  private readonly db: Database.Database;

  constructor(filename = "data/kurochan.sqlite") {
    if (filename !== ":memory:")
      mkdirSync(dirname(filename), { recursive: true });
    this.db = new Database(filename);
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, goal TEXT NOT NULL, profile TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','planning','running','waiting_for_approval','verifying','completed','failed','cancelled')),
        created_by TEXT, output_json TEXT, error_code TEXT, error_message TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        plan_key TEXT NOT NULL, agent_id TEXT NOT NULL, objective TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','ready','running','waiting_for_approval','succeeded','failed','cancelled')),
        input_json TEXT NOT NULL, output_json TEXT, evidence_json TEXT, error_code TEXT, error_message TEXT,
        attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3,
        approval_required INTEGER NOT NULL DEFAULT 0, lease_owner TEXT, lease_expires_at INTEGER,
        available_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(run_id, plan_key)
      );
      CREATE TABLE IF NOT EXISTS task_dependencies (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        PRIMARY KEY(task_id, depends_on_task_id),
        CHECK(task_id <> depends_on_task_id)
      );
      CREATE TABLE IF NOT EXISTS run_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS worker_heartbeats (
        worker_id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK(state IN ('idle','busy','waiting_for_approval','stopping')),
        current_task_id TEXT,
        metadata_json TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS provider_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_id TEXT NOT NULL CHECK(provider_id IN ('openrouter','freellmapi')),
        model TEXT NOT NULL,
        route_profile TEXT NOT NULL CHECK(route_profile IN ('fast','balanced','quality')),
        operation TEXT NOT NULL CHECK(operation IN ('chat','planning','task','verification','provider_test','other')),
        run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        prompt_tokens INTEGER CHECK(prompt_tokens IS NULL OR prompt_tokens >= 0),
        completion_tokens INTEGER CHECK(completion_tokens IS NULL OR completion_tokens >= 0),
        total_tokens INTEGER CHECK(total_tokens IS NULL OR total_tokens >= 0),
        latency_ms INTEGER NOT NULL CHECK(latency_ms >= 0),
        outcome TEXT NOT NULL CHECK(outcome IN ('success','failure')),
        error_code TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_provider_usage_created ON provider_usage(created_at);
      CREATE INDEX IF NOT EXISTS idx_provider_usage_provider_created ON provider_usage(provider_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_runs_status_updated ON runs(status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_claim ON tasks(status, available_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_run_status ON tasks(run_id, status);
      CREATE INDEX IF NOT EXISTS idx_events_run_id ON run_events(run_id, id);
      PRAGMA user_version = 2;
    `);
  }

  close(): void {
    this.db.close();
  }

  recordProviderUsage(
    input: ProviderUsageInput,
    now = Date.now(),
  ): void {
    if (input.providerId !== "openrouter" && input.providerId !== "freellmapi") {
      throw new Error("Unknown provider ID for usage record.");
    }
    assertText(input.model, "model", 400);
    if (!VALID_PROFILES.has(input.profile)) {
      throw new Error("Unknown route profile for usage record.");
    }
    if (
      !["chat", "planning", "task", "verification", "provider_test", "other"].includes(input.operation)
    ) {
      throw new Error("Unknown operation for usage record.");
    }
    if (input.outcome !== "success" && input.outcome !== "failure") {
      throw new Error("Unknown usage outcome.");
    }
    if (!Number.isInteger(input.latencyMs) || input.latencyMs < 0 || input.latencyMs > 86_400_000) {
      throw new Error("Usage latency must be a non-negative integer under 24 hours.");
    }
    if (input.runId !== undefined) assertText(input.runId, "runId", 200);
    if (input.taskId !== undefined) assertText(input.taskId, "taskId", 200);

    const validateTokens = (value: number | undefined, label: string) => {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
        throw new Error(label + " must be a non-negative safe integer.");
      }
      return value ?? null;
    };
    const promptTokens = validateTokens(input.usage?.promptTokens, "promptTokens");
    const completionTokens = validateTokens(input.usage?.completionTokens, "completionTokens");
    const reportedTotalTokens = input.usage?.totalTokens;
    const totalTokens = validateTokens(
      reportedTotalTokens ??
        (promptTokens !== null && completionTokens !== null
          ? promptTokens + completionTokens
          : undefined),
      "totalTokens",
    );
    const errorCode = input.errorCode?.trim();
    if (errorCode) assertText(errorCode, "errorCode", 100);

    this.db.prepare(
      `INSERT INTO provider_usage(
        provider_id,model,route_profile,operation,run_id,task_id,
        prompt_tokens,completion_tokens,total_tokens,latency_ms,outcome,error_code,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      input.providerId,
      input.model,
      input.profile,
      input.operation,
      input.runId ?? null,
      input.taskId ?? null,
      promptTokens,
      completionTokens,
      totalTokens,
      input.latencyMs,
      input.outcome,
      errorCode || null,
      now,
    );
  }

  summarizeProviderUsage(
    since = 0,
    until = Date.now(),
  ): readonly ProviderUsageSummary[] {
    if (
      !Number.isSafeInteger(since) ||
      !Number.isSafeInteger(until) ||
      since < 0 ||
      until < since
    ) {
      throw new Error("Usage time range must be a valid increasing timestamp range.");
    }
    const rows = this.db.prepare(
      `SELECT
        provider_id,
        model,
        operation,
        COUNT(*) AS requests,
        SUM(CASE WHEN outcome='success' THEN 1 ELSE 0 END) AS successful_requests,
        SUM(CASE WHEN outcome='failure' THEN 1 ELSE 0 END) AS failed_requests,
        SUM(CASE WHEN prompt_tokens IS NOT NULL OR completion_tokens IS NOT NULL OR total_tokens IS NOT NULL THEN 1 ELSE 0 END) AS requests_with_token_usage,
        SUM(COALESCE(prompt_tokens, 0)) AS prompt_tokens,
        SUM(COALESCE(completion_tokens, 0)) AS completion_tokens,
        SUM(COALESCE(total_tokens, 0)) AS total_tokens,
        AVG(latency_ms) AS average_latency_ms,
        MAX(created_at) AS last_used_at
      FROM provider_usage
      WHERE created_at >= ? AND created_at <= ?
      GROUP BY provider_id, model, operation
      ORDER BY provider_id, model, operation`,
    ).all(since, until) as Array<{
      provider_id: ProviderId;
      model: string;
      operation: ProviderUsageOperation;
      requests: number;
      successful_requests: number;
      failed_requests: number;
      requests_with_token_usage: number;
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
      average_latency_ms: number;
      last_used_at: number;
    }>;
    return rows.map((row) => ({
      providerId: row.provider_id,
      model: row.model,
      operation: row.operation,
      requests: row.requests,
      successfulRequests: row.successful_requests,
      failedRequests: row.failed_requests,
      requestsWithTokenUsage: row.requests_with_token_usage,
      requestsWithoutTokenUsage: row.requests - row.requests_with_token_usage,
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      totalTokens: row.total_tokens,
      averageLatencyMs: Math.round(row.average_latency_ms),
      lastUsedAt: row.last_used_at,
    }));
  }

  recordWorkerHeartbeat(
    workerId: string,
    state: WorkerState,
    currentTaskId?: string,
    metadata: unknown = {},
    now = Date.now(),
  ): void {
    assertText(workerId, "workerId", 200);
    if (!["idle", "busy", "waiting_for_approval", "stopping"].includes(state)) {
      throw new Error("Unknown worker state.");
    }
    if (currentTaskId !== undefined)
      assertText(currentTaskId, "currentTaskId", 200);
    const metadataJson = encodeJson(metadata);
    this.db
      .prepare(
        `
      INSERT INTO worker_heartbeats(worker_id,state,current_task_id,metadata_json,started_at,last_seen_at)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(worker_id) DO UPDATE SET
        state=excluded.state,
        current_task_id=excluded.current_task_id,
        metadata_json=excluded.metadata_json,
        last_seen_at=excluded.last_seen_at
    `,
      )
      .run(workerId, state, currentTaskId ?? null, metadataJson, now, now);
  }

  listWorkerHeartbeats(
    now = Date.now(),
    staleAfterMs = 30_000,
  ): readonly WorkerHeartbeatRecord[] {
    if (
      !Number.isInteger(staleAfterMs) ||
      staleAfterMs < 1000 ||
      staleAfterMs > 600_000
    ) {
      throw new Error("staleAfterMs must be between 1000 and 600000.");
    }
    const rows = this.db
      .prepare(
        "SELECT worker_id,state,current_task_id,metadata_json,started_at,last_seen_at FROM worker_heartbeats ORDER BY last_seen_at DESC",
      )
      .all() as Array<{
      worker_id: string;
      state: WorkerState;
      current_task_id: string | null;
      metadata_json: string;
      started_at: number;
      last_seen_at: number;
    }>;
    return rows.map((row) => ({
      workerId: row.worker_id,
      state: row.state,
      ...(row.current_task_id ? { currentTaskId: row.current_task_id } : {}),
      metadata: JSON.parse(row.metadata_json) as unknown,
      startedAt: row.started_at,
      lastSeenAt: row.last_seen_at,
      stale: now - row.last_seen_at > staleAfterMs,
    }));
  }

  createRun(input: CreateRunInput, now = Date.now()): RunRecord {
    assertText(input.goal, "goal", 20_000);
    if (!VALID_PROFILES.has(input.profile))
      throw new Error("Unknown OmniRouter profile.");
    assertText(input.createdBy ?? "anonymous", "createdBy", 200);
    if (
      !Array.isArray(input.tasks) ||
      input.tasks.length === 0 ||
      input.tasks.length > 200
    ) {
      throw new Error("A run must contain between 1 and 200 planned tasks.");
    }
    const keys = new Set<string>();
    for (const task of input.tasks) {
      assertText(task.key, "task key", 200);
      assertText(task.agentId, "agentId", 200);
      assertText(task.objective, "objective", 20_000);
      if (keys.has(task.key))
        throw new Error(`Duplicate planned task key: ${task.key}`);
      keys.add(task.key);
      const attempts = task.maxAttempts ?? 3;
      if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10)
        throw new Error("Task maxAttempts must be between 1 and 10.");
      encodeJson(task.input ?? null);
    }
    for (const task of input.tasks) {
      for (const dep of task.dependsOn ?? []) {
        if (!keys.has(dep))
          throw new Error(`Task ${task.key} depends on unknown task ${dep}.`);
        if (dep === task.key)
          throw new Error(`Task ${task.key} cannot depend on itself.`);
      }
    }
    this.assertAcyclic(input.tasks);
    const runId = input.id ?? randomUUID();
    const idByKey = new Map(
      input.tasks.map((task) => [task.key, randomUUID()]),
    );
    const insertRun = this.db.prepare(
      "INSERT INTO runs(id,goal,profile,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    );
    const insertTask = this.db.prepare(
      "INSERT INTO tasks(id,run_id,plan_key,agent_id,objective,status,input_json,attempts,max_attempts,approval_required,available_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    const insertDep = this.db.prepare(
      "INSERT INTO task_dependencies(task_id,depends_on_task_id) VALUES(?,?)",
    );
    const updateTaskStatus = this.db.prepare(
      "UPDATE tasks SET status=? WHERE id=?",
    );
    const tx = this.db.transaction(() => {
      insertRun.run(
        runId,
        input.goal,
        input.profile,
        "queued",
        input.createdBy ?? null,
        now,
        now,
      );
      for (const task of input.tasks) {
        const taskId = idByKey.get(task.key)!;
        const dependencies = task.dependsOn ?? [];
        insertTask.run(
          taskId,
          runId,
          task.key,
          task.agentId,
          task.objective,
          "pending",
          encodeJson(task.input ?? null),
          0,
          task.maxAttempts ?? 3,
          task.approvalRequired ? 1 : 0,
          now,
          now,
          now,
        );
        for (const dep of dependencies)
          insertDep.run(taskId, idByKey.get(dep)!);
      }
      for (const task of input.tasks) {
        if (!task.dependsOn?.length)
          updateTaskStatus.run("ready", idByKey.get(task.key)!);
      }
      this.addEvent(
        runId,
        undefined,
        "run.created",
        {
          goal: input.goal,
          profile: input.profile,
          taskCount: input.tasks.length,
        },
        now,
      );
      this.addEvent(
        runId,
        undefined,
        "run.plan_created",
        { taskKeys: input.tasks.map((task) => task.key) },
        now,
      );
    });
    try {
      tx.immediate();
    } catch (error) {
      throw new Error("Could not create run. The run ID may already exist.", {
        cause: error,
      });
    }
    return this.getRun(runId)!;
  }

  getRun(runId: string): RunRecord | undefined {
    return asRun(
      this.db.prepare("SELECT * FROM runs WHERE id=?").get(runId) as
        RunRow | undefined,
    );
  }

  listRuns(limit = 50, before?: number): readonly RunRecord[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200)
      throw new Error("limit must be between 1 and 200.");
    const rows =
      before === undefined
        ? this.db
            .prepare(
              "SELECT * FROM runs ORDER BY created_at DESC, id DESC LIMIT ?",
            )
            .all(limit)
        : this.db
            .prepare(
              "SELECT * FROM runs WHERE created_at < ? ORDER BY created_at DESC, id DESC LIMIT ?",
            )
            .all(before, limit);
    return (rows as RunRow[]).map((row) => asRun(row)!);
  }

  getTask(taskId: string): TaskRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE id=?")
      .get(taskId) as TaskRow | undefined;
    if (!row) return undefined;
    const deps = this.db
      .prepare(
        "SELECT depends_on_task_id FROM task_dependencies WHERE task_id=? ORDER BY depends_on_task_id",
      )
      .all(taskId) as Array<{ depends_on_task_id: string }>;
    return asTask(
      row,
      deps.map((dep) => dep.depends_on_task_id),
    );
  }

  listTasks(runId: string): readonly TaskRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE run_id=? ORDER BY rowid")
      .all(runId) as TaskRow[];
    return rows.map((row) => {
      const deps = this.db
        .prepare(
          "SELECT depends_on_task_id FROM task_dependencies WHERE task_id=? ORDER BY depends_on_task_id",
        )
        .all(row.id) as Array<{ depends_on_task_id: string }>;
      return asTask(
        row,
        deps.map((dep) => dep.depends_on_task_id),
      )!;
    });
  }

  listEvents(runId: string, afterId = 0, limit = 200): readonly RunEvent[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new Error("limit must be between 1 and 1000.");
    const rows = this.db
      .prepare(
        "SELECT * FROM run_events WHERE run_id=? AND id>? ORDER BY id ASC LIMIT ?",
      )
      .all(runId, afterId, limit) as EventRow[];
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      ...(row.task_id ? { taskId: row.task_id } : {}),
      type: row.type,
      payload: decodeJson(row.payload_json),
      createdAt: row.created_at,
    }));
  }

  claimNextTask(
    workerId: string,
    options: ClaimOptions = {},
  ): TaskRecord | undefined {
    assertText(workerId, "workerId", 200);
    const now = options.now ?? Date.now();
    const leaseMs = options.leaseMs ?? 60_000;
    if (!Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > 600_000)
      throw new Error("leaseMs must be between 1000 and 600000.");
    const tx = this.db.transaction(() => {
      const expired = this.db
        .prepare(
          "SELECT * FROM tasks WHERE status='running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?",
        )
        .all(now) as TaskRow[];
      for (const task of expired) {
        if (task.attempts >= task.max_attempts) {
          this.db
            .prepare(
              "UPDATE tasks SET status='failed',lease_owner=NULL,lease_expires_at=NULL,error_code='lease_expired',error_message='Worker lease expired after the maximum number of attempts.',updated_at=? WHERE id=?",
            )
            .run(now, task.id);
          this.failRunForTask(
            task.run_id,
            task.id,
            "lease_expired",
            "Worker lease expired after the maximum number of attempts.",
            now,
          );
        } else {
          this.db
            .prepare(
              "UPDATE tasks SET status='ready',lease_owner=NULL,lease_expires_at=NULL,available_at=?,error_code='lease_expired',error_message='Previous worker lease expired; task queued for recovery.',updated_at=? WHERE id=?",
            )
            .run(now, now, task.id);
          this.addEvent(
            task.run_id,
            task.id,
            "task.lease_expired",
            { attempts: task.attempts, recovered: true },
            now,
          );
        }
      }
      const row = this.db
        .prepare(
          `
        SELECT t.* FROM tasks t JOIN runs r ON r.id=t.run_id
        WHERE t.status='ready' AND t.available_at <= ? AND r.status IN ('queued','running')
          AND NOT EXISTS (
            SELECT 1 FROM task_dependencies d JOIN tasks dep ON dep.id=d.depends_on_task_id
            WHERE d.task_id=t.id AND dep.status <> 'succeeded'
          )
        ORDER BY t.created_at ASC, t.id ASC LIMIT 1
      `,
        )
        .get(now) as TaskRow | undefined;
      if (!row) return undefined;
      const expires = now + leaseMs;
      this.db
        .prepare(
          "UPDATE tasks SET status='running',attempts=attempts+1,lease_owner=?,lease_expires_at=?,updated_at=? WHERE id=? AND status='ready'",
        )
        .run(workerId, expires, now, row.id);
      this.db
        .prepare(
          "UPDATE runs SET status='running',updated_at=?,version=version+1 WHERE id=? AND status='queued'",
        )
        .run(now, row.run_id);
      this.addEvent(
        row.run_id,
        row.id,
        "task.claimed",
        { workerId, leaseExpiresAt: expires, attempt: row.attempts + 1 },
        now,
      );
      return this.getTask(row.id);
    });
    return tx.immediate();
  }

  renewTaskLease(
    runId: string,
    taskId: string,
    workerId: string,
    leaseMs = 60_000,
    now = Date.now(),
  ): number {
    assertText(workerId, "workerId", 200);
    if (!Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > 600_000) {
      throw new Error("leaseMs must be between 1000 and 600000.");
    }
    const leaseExpiresAt = now + leaseMs;
    const updated = this.db
      .prepare(
        "UPDATE tasks SET lease_expires_at=?,updated_at=? WHERE id=? AND run_id=? AND status='running' AND lease_owner=? AND lease_expires_at > ?",
      )
      .run(leaseExpiresAt, now, taskId, runId, workerId, now);
    if (updated.changes !== 1) {
      throw new Error("Task lease is no longer valid for this worker.");
    }
    return leaseExpiresAt;
  }

  completeTask(
    runId: string,
    taskId: string,
    workerId: string,
    output: unknown,
    evidence: readonly Evidence[] = [],
    now = Date.now(),
  ): TaskRecord {
    assertText(workerId, "workerId", 200);
    const outputJson = encodeJson(output);
    const evidenceJson = encodeJson(evidence);
    const tx = this.db.transaction(() => {
      const task = this.db
        .prepare("SELECT * FROM tasks WHERE id=? AND run_id=?")
        .get(taskId, runId) as TaskRow | undefined;
      if (!task) throw new Error("Task was not found in this run.");
      if (
        task.status !== "running" ||
        task.lease_owner !== workerId ||
        task.lease_expires_at === null ||
        task.lease_expires_at <= now
      ) {
        throw new Error(
          "Task lease is not owned by this worker or has expired.",
        );
      }
      this.db
        .prepare(
          "UPDATE tasks SET status='succeeded',output_json=?,evidence_json=?,error_code=NULL,error_message=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?",
        )
        .run(outputJson, evidenceJson, now, taskId);
      this.addEvent(
        runId,
        taskId,
        "task.succeeded",
        { evidenceCount: evidence.length },
        now,
      );
      // Newly unblocked tasks become claimable in the same transaction as their dependency's success.
      this.db
        .prepare(
          `
        UPDATE tasks SET status='ready', available_at=?, updated_at=?
        WHERE run_id=? AND status='pending'
          AND id IN (SELECT task_id FROM task_dependencies WHERE depends_on_task_id=?)
          AND NOT EXISTS (
            SELECT 1 FROM task_dependencies d
            JOIN tasks dep ON dep.id=d.depends_on_task_id
            WHERE d.task_id=tasks.id AND dep.status <> 'succeeded'
          )
      `,
        )
        .run(now, now, runId, taskId);
      const tasks = this.db
        .prepare("SELECT status FROM tasks WHERE run_id=?")
        .all(runId) as Array<{ status: TaskStatus }>;
      const nextStatus: RunStatus = tasks.every((t) => t.status === "succeeded")
        ? "verifying"
        : "running";
      this.db
        .prepare(
          "UPDATE runs SET status=?,updated_at=?,version=version+1 WHERE id=?",
        )
        .run(nextStatus, now, runId);
      if (nextStatus === "verifying")
        this.addEvent(
          runId,
          undefined,
          "run.verification_required",
          { taskCount: tasks.length },
          now,
        );
    });
    tx.immediate();
    return this.getTask(taskId)!;
  }

  failTask(input: FinishFailureInput): TaskRecord {
    assertText(input.workerId, "workerId", 200);
    assertText(input.code, "error code", 200);
    assertText(input.message, "error message", 2000);
    const now = input.now ?? Date.now();
    const tx = this.db.transaction(() => {
      const task = this.db
        .prepare("SELECT * FROM tasks WHERE id=? AND run_id=?")
        .get(input.taskId, input.runId) as TaskRow | undefined;
      if (!task) throw new Error("Task was not found in this run.");
      if (task.status !== "running" || task.lease_owner !== input.workerId)
        throw new Error("Task lease is not owned by this worker.");
      const retry = input.retryable && task.attempts < task.max_attempts;
      if (retry) {
        const delay = Math.min(
          60_000,
          1000 * 2 ** Math.max(0, task.attempts - 1),
        );
        this.db
          .prepare(
            "UPDATE tasks SET status='ready',available_at=?,lease_owner=NULL,lease_expires_at=NULL,error_code=?,error_message=?,updated_at=? WHERE id=?",
          )
          .run(now + delay, input.code, input.message, now, input.taskId);
        this.addEvent(
          input.runId,
          input.taskId,
          "task.retry_scheduled",
          { code: input.code, retryAt: now + delay, attempt: task.attempts },
          now,
        );
      } else {
        this.db
          .prepare(
            "UPDATE tasks SET status='failed',lease_owner=NULL,lease_expires_at=NULL,error_code=?,error_message=?,updated_at=? WHERE id=?",
          )
          .run(input.code, input.message, now, input.taskId);
        this.failRunForTask(
          input.runId,
          input.taskId,
          input.code,
          input.message,
          now,
        );
      }
    });
    tx.immediate();
    return this.getTask(input.taskId)!;
  }

  requestTaskApproval(
    runId: string,
    taskId: string,
    workerId: string,
    action: unknown,
    now = Date.now(),
  ): TaskRecord {
    assertText(workerId, "workerId", 200);
    const actionJson = encodeJson(action);
    const tx = this.db.transaction(() => {
      const task = this.db
        .prepare("SELECT * FROM tasks WHERE id=? AND run_id=?")
        .get(taskId, runId) as TaskRow | undefined;
      if (!task || task.status !== "running" || task.lease_owner !== workerId)
        throw new Error("Task lease is not owned by this worker.");
      this.db
        .prepare(
          "UPDATE tasks SET status='waiting_for_approval',lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?",
        )
        .run(now, taskId);
      this.db
        .prepare(
          "UPDATE runs SET status='waiting_for_approval',updated_at=?,version=version+1 WHERE id=?",
        )
        .run(now, runId);
      this.addEvent(
        runId,
        taskId,
        "approval.requested",
        { action: JSON.parse(actionJson) as unknown },
        now,
      );
    });
    tx.immediate();
    return this.getTask(taskId)!;
  }

  resolveTaskApproval(
    runId: string,
    taskId: string,
    approved: boolean,
    reason = "",
    now = Date.now(),
  ): TaskRecord {
    const tx = this.db.transaction(() => {
      const task = this.db
        .prepare("SELECT * FROM tasks WHERE id=? AND run_id=?")
        .get(taskId, runId) as TaskRow | undefined;
      if (!task || task.status !== "waiting_for_approval")
        throw new Error("Task is not waiting for approval.");
      if (approved) {
        this.db
          .prepare(
            "UPDATE tasks SET status='ready',available_at=?,updated_at=? WHERE id=?",
          )
          .run(now, now, taskId);
        this.db
          .prepare(
            "UPDATE runs SET status='running',updated_at=?,version=version+1 WHERE id=?",
          )
          .run(now, runId);
        this.addEvent(
          runId,
          taskId,
          "approval.granted",
          { reason: reason.slice(0, 2000) },
          now,
        );
      } else {
        this.db
          .prepare(
            "UPDATE tasks SET status='failed',error_code='approval_denied',error_message=?,updated_at=? WHERE id=?",
          )
          .run(
            reason.slice(0, 2000) || "Required action was not approved.",
            now,
            taskId,
          );
        this.failRunForTask(
          runId,
          taskId,
          "approval_denied",
          reason.slice(0, 2000) || "Required action was not approved.",
          now,
        );
        this.addEvent(
          runId,
          taskId,
          "approval.denied",
          { reason: reason.slice(0, 2000) },
          now,
        );
      }
    });
    tx.immediate();
    return this.getTask(taskId)!;
  }

  verifyRun(
    runId: string,
    passed: boolean,
    summary: string,
    evidence: readonly Evidence[] = [],
    output?: unknown,
    now = Date.now(),
  ): RunRecord {
    assertText(summary, "verification summary", 20_000);
    const outputJson = output === undefined ? null : encodeJson(output);
    const evidenceJson = encodeJson(evidence);
    const tx = this.db.transaction(() => {
      const run = this.db
        .prepare("SELECT * FROM runs WHERE id=?")
        .get(runId) as RunRow | undefined;
      if (!run) throw new Error("Run was not found.");
      if (run.status !== "verifying")
        throw new Error(
          "Run must be in verifying state before it can be finalized.",
        );
      const remaining = this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM tasks WHERE run_id=? AND status <> 'succeeded'",
        )
        .get(runId) as { count: number };
      if (remaining.count !== 0)
        throw new Error(
          "Run cannot be verified while tasks remain incomplete.",
        );
      if (passed) {
        this.db
          .prepare(
            "UPDATE runs SET status='completed',output_json=?,error_code=NULL,error_message=NULL,updated_at=?,version=version+1 WHERE id=?",
          )
          .run(outputJson, now, runId);
        this.addEvent(
          runId,
          undefined,
          "run.completed",
          { summary, evidence: JSON.parse(evidenceJson) as unknown },
          now,
        );
      } else {
        this.db
          .prepare(
            "UPDATE runs SET status='failed',error_code='verification_failed',error_message=?,updated_at=?,version=version+1 WHERE id=?",
          )
          .run(summary, now, runId);
        this.addEvent(
          runId,
          undefined,
          "run.verification_failed",
          { summary, evidence: JSON.parse(evidenceJson) as unknown },
          now,
        );
      }
    });
    tx.immediate();
    return this.getRun(runId)!;
  }

  cancelRun(
    runId: string,
    reason = "Cancelled by user.",
    now = Date.now(),
  ): RunRecord {
    const tx = this.db.transaction(() => {
      const run = this.db
        .prepare("SELECT * FROM runs WHERE id=?")
        .get(runId) as RunRow | undefined;
      if (!run) throw new Error("Run was not found.");
      if (["completed", "failed", "cancelled"].includes(run.status)) return;
      this.db
        .prepare(
          "UPDATE tasks SET status='cancelled',lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE run_id=? AND status IN ('pending','ready','running','waiting_for_approval')",
        )
        .run(now, runId);
      this.db
        .prepare(
          "UPDATE runs SET status='cancelled',error_code='cancelled',error_message=?,updated_at=?,version=version+1 WHERE id=?",
        )
        .run(reason.slice(0, 2000), now, runId);
      this.addEvent(
        runId,
        undefined,
        "run.cancelled",
        { reason: reason.slice(0, 2000) },
        now,
      );
    });
    tx.immediate();
    return this.getRun(runId)!;
  }

  private assertAcyclic(tasks: readonly PlannedTask[]): void {
    const map = new Map(tasks.map((t) => [t.key, t]));
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (key: string): void => {
      if (visiting.has(key))
        throw new Error("Task dependency graph contains a cycle.");
      if (visited.has(key)) return;
      visiting.add(key);
      for (const dependency of map.get(key)?.dependsOn ?? []) visit(dependency);
      visiting.delete(key);
      visited.add(key);
    };
    for (const task of tasks) visit(task.key);
  }

  private addEvent(
    runId: string,
    taskId: string | undefined,
    type: string,
    payload: unknown,
    now: number,
  ): void {
    this.db
      .prepare(
        "INSERT INTO run_events(run_id,task_id,type,payload_json,created_at) VALUES(?,?,?,?,?)",
      )
      .run(runId, taskId ?? null, type, encodeJson(payload), now);
  }

  private failRunForTask(
    runId: string,
    taskId: string,
    code: string,
    message: string,
    now: number,
  ): void {
    this.db
      .prepare(
        "UPDATE runs SET status='failed',error_code=?,error_message=?,updated_at=?,version=version+1 WHERE id=? AND status NOT IN ('completed','failed','cancelled')",
      )
      .run(code, message, now, runId);
    this.db
      .prepare(
        "UPDATE tasks SET status='cancelled',lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE run_id=? AND id<>? AND status IN ('pending','ready','running','waiting_for_approval')",
      )
      .run(now, runId, taskId);
    this.addEvent(runId, taskId, "run.failed", { code, message }, now);
  }
}
