import { randomUUID, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import {
  ChatCompletionRequestSchema,
  type ChatCompletionResponse,
  type ProviderId,
  type RouteProfile,
} from "@kurochan/contracts";
import {
  createProviderRegistry,
  type Environment,
} from "@kurochan/model-gateway";
import { OmniRouter, routeOrdersFromEnvironment } from "@kurochan/omnirouter";
import { AgentCatalog } from "@kurochan/agent-catalog";
import { RunStore, type CreateRunInput } from "@kurochan/storage";
import { PlanError, PlanService } from "@kurochan/orchestrator";

export interface ServerOptions {
  readonly env?: Environment;
  readonly logger?: boolean;
  readonly providers?: ReturnType<typeof createProviderRegistry>;
  readonly store?: RunStore;
  readonly catalog?: AgentCatalog;
  readonly planner?: PlanService;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function allowedOrigins(env: Environment): string[] {
  const configured =
    env.CORS_ALLOWED_ORIGINS?.split(",")
      .map((v) => v.trim())
      .filter(Boolean) ?? [];
  const webOrigin = env.WEB_ORIGIN?.trim();
  if (webOrigin) configured.push(webOrigin);
  return [...new Set(configured)];
}

interface ModelSelection {
  readonly profile: RouteProfile;
  readonly preferredProvider?: ProviderId;
  readonly providerModel?: string;
}

function modelSelection(
  model: string,
  registry: ReturnType<typeof createProviderRegistry>,
): ModelSelection | undefined {
  const normalized = model.toLowerCase();
  if (normalized === "omni/fast") return { profile: "fast" };
  if (normalized === "omni/balanced") return { profile: "balanced" };
  if (normalized === "omni/quality") return { profile: "quality" };

  for (const id of ["openrouter", "freellmapi"] as const) {
    const prefix = id + "/";
    if (model.startsWith(prefix)) {
      const providerModel = model.slice(prefix.length).trim();
      return providerModel
        ? { profile: "balanced", preferredProvider: id, providerModel }
        : undefined;
    }
  }

  const matches = [...registry.providers.values()].filter(
    (provider) => provider.defaultModel === model,
  );
  if (matches.length === 1) {
    return {
      profile: "balanced",
      preferredProvider: matches[0]!.id,
      providerModel: model,
    };
  }
  return undefined;
}

export function buildServer(options: ServerOptions = {}): FastifyInstance {
  const env = options.env ?? process.env;
  const registry = options.providers ?? createProviderRegistry(env);
  const store =
    options.store ??
    new RunStore(env.KUROCHAN_DB_PATH?.trim() || "data/kurochan.sqlite");
  const catalog = options.catalog ?? new AgentCatalog();
  const router = new OmniRouter({
    providers: registry.providers,
    routeOrder: routeOrdersFromEnvironment(env),
    maxAttempts: Number.parseInt(env.OMNIROUTER_MAX_ATTEMPTS ?? "2", 10),
    maxConcurrentRequests: Number.parseInt(
      env.OMNIROUTER_MAX_CONCURRENT ?? "24",
      10,
    ),
    failureThreshold: Number.parseInt(
      env.OMNIROUTER_FAILURE_THRESHOLD ?? "3",
      10,
    ),
    circuitCooldownMs: Number.parseInt(
      env.OMNIROUTER_CIRCUIT_COOLDOWN_MS ?? "30000",
      10,
    ),
  });
  const planner = options.planner ?? new PlanService({ catalog, router });

  const app = Fastify({
    logger: options.logger ?? {
      level: env.LOG_LEVEL?.trim() || "info",
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.x-api-key",
          "res.headers.authorization",
          "req.headers.cookie",
          "req.headers['set-cookie']",
        ],
        censor: "[REDACTED]",
      },
    },
    bodyLimit: 1_000_000,
    requestIdHeader: "x-request-id",
    disableRequestLogging: false,
  });

  app.addHook("onClose", async () => {
    store.close();
  });

  const origins = allowedOrigins(env);
  void app.register(helmet, { contentSecurityPolicy: false });
  void app.register(cors, {
    origin: origins.length ? origins : false,
    credentials: false,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["authorization", "content-type", "x-request-id"],
    maxAge: 600,
  });
  void app.register(rateLimit, {
    max: Number.parseInt(env.API_RATE_LIMIT_PER_MINUTE ?? "60", 10),
    timeWindow: "1 minute",
    keyGenerator: (request) => request.ip,
    errorResponseBuilder: (_request, context) => ({
      error: {
        code: "rate_limited",
        message: "Too many requests. Please wait before trying again.",
        retryable: true,
        retryAfterSeconds: Math.max(1, Math.ceil(context.ttl / 1000)),
      },
    }),
  });

  const token = env.KUROCHAN_API_TOKEN?.trim();
  app.addHook("preHandler", async (request, reply) => {
    if (!token || !request.url.startsWith("/v1/")) return;
    const header = request.headers.authorization;
    const candidate =
      typeof header === "string" && header.startsWith("Bearer ")
        ? header.slice(7)
        : "";
    if (!candidate || !safeEqual(candidate, token)) {
      return reply.code(401).send({
        error: {
          code: "unauthorized",
          message: "A valid Kuro-chan API bearer token is required.",
          retryable: false,
          requestId: request.id,
        },
      });
    }
  });

  app.setErrorHandler((error, request, reply) => {
    const rawStatusCode =
      error && typeof error === "object" && "statusCode" in error
        ? (error as { statusCode?: unknown }).statusCode
        : undefined;
    const status =
      typeof rawStatusCode === "number" && rawStatusCode >= 400 && rawStatusCode < 500
        ? rawStatusCode
        : 500;
    if (status >= 500)
      request.log.error(
        { err: error, requestId: request.id },
        "Unhandled API error",
      );
    const tooLarge = status === 413;
    const badJson = status === 400;
    void reply.code(status).send({
      error: {
        code: tooLarge
          ? "request_too_large"
          : badJson
            ? "invalid_request"
            : "internal_error",
        message: tooLarge
          ? "Request body exceeds the 1 MB limit."
          : badJson
            ? "Request body is invalid."
            : "The server could not complete the request.",
        retryable: status >= 500,
        requestId: request.id,
      },
    });
  });

  app.get("/healthz", async () => ({ ok: true, service: "kurochan-api" }));

  app.get("/readyz", async (_request, reply) => {
    const configuredProviders = registry.statuses.filter(
      (p) => p.configured,
    ).length;
    const ready = configuredProviders > 0;
    if (!ready) reply.code(503);
    return {
      ready,
      configuredProviders,
      requirement: "Configure at least one model provider to run inference.",
    };
  });

  app.get("/v1/config", async () => ({
    appName: "Kuro-chan",
    version: env.npm_package_version ?? "0.1.0",
    router: {
      name: "OmniRouter",
      availableProfiles: ["fast", "balanced", "quality"],
    },
    providers: registry.statuses,
  }));

  app.get("/v1/omnirouter/status", async () => ({
    name: "OmniRouter",
    profiles: routeOrdersFromEnvironment(env),
    providers: router.getProviderHealth(registry.statuses),
  }));

  app.get("/v1/nexus/runbooks", async (_request, reply) => {
    try {
      const runbooks = await catalog.listRunbooks();
      return {
        source: "Agency Agents NEXUS strategy/runbooks.json",
        pinnedCommit: (await catalog.metadata()).pinnedCommit,
        data: runbooks.map(({ slug, title, mode, duration, summary, doc, roster }) => ({
          slug, title, mode, duration, summary, doc, roster,
        })),
      };
    } catch (error) {
      requestWarning(app, error, "nexus_runbooks_unavailable");
      return reply.code(503).send({
        error: {
          code: "nexus_runbooks_unavailable",
          message: "Pinned NEXUS runbooks could not be loaded or validated.",
          retryable: true,
        },
      });
    }
  });

  app.get("/v1/nexus/strategy", async (_request, reply) => {
    try {
      return {
        source: "Agency Agents NEXUS strategy/nexus-strategy.md",
        pinnedCommit: (await catalog.metadata()).pinnedCommit,
        content: await catalog.readNexusStrategy(24_000),
      };
    } catch (error) {
      requestWarning(app, error, "nexus_strategy_unavailable");
      return reply.code(503).send({
        error: {
          code: "nexus_strategy_unavailable",
          message: "Pinned NEXUS strategy could not be loaded.",
          retryable: true,
        },
      });
    }
  });

  app.get("/v1/agents/catalog", async (_request, reply) => {
    try {
      return await catalog.metadata();
    } catch (error) {
      requestWarning(app, error, "catalog_unavailable");
      return reply
        .code(503)
        .send({
          error: {
            code: "catalog_unavailable",
            message:
              "Agency Agents catalog is unavailable. Check that the pinned submodule is initialized.",
            retryable: true,
          },
        });
    }
  });

  app.get("/v1/agents", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const q = typeof query.q === "string" ? query.q : "";
    const division =
      typeof query.division === "string" ? query.division : undefined;
    let limit: number;
    try {
      limit = parseBoundedInteger(query.limit, 50, 1, 100);
    } catch {
      return reply
        .code(400)
        .send({
          error: {
            code: "invalid_query",
            message: "limit must be an integer from 1 to 100.",
            retryable: false,
          },
        });
    }
    try {
      if (q.trim())
        return {
          data: await catalog.search(q, {
            ...(division ? { division } : {}),
            limit,
          }),
        };
      return {
        data: await catalog.list({ ...(division ? { division } : {}), limit }),
      };
    } catch (error) {
      requestWarning(app, error, "catalog_unavailable");
      return reply
        .code(503)
        .send({
          error: {
            code: "catalog_unavailable",
            message: "Agency Agents catalog could not be loaded.",
            retryable: true,
          },
        });
    }
  });

  app.get("/v1/agents/:division/:slug", async (request, reply) => {
    const params = request.params as { division: string; slug: string };
    try {
      const agent = await catalog.get(`${params.division}/${params.slug}`);
      if (!agent)
        return reply
          .code(404)
          .send({
            error: {
              code: "agent_not_found",
              message: "No agent was found at that catalog path.",
              retryable: false,
            },
          });
      const { instructions: _instructions, ...profile } = agent;
      return profile;
    } catch (error) {
      requestWarning(app, error, "catalog_unavailable");
      return reply
        .code(503)
        .send({
          error: {
            code: "catalog_unavailable",
            message: "Agency Agents catalog could not be loaded.",
            retryable: true,
          },
        });
    }
  });

  const PlannedTaskSchema = z.object({
    key: z.string().trim().min(1).max(200),
    agentId: z.string().trim().min(1).max(200),
    objective: z.string().trim().min(1).max(20_000),
    dependsOn: z.array(z.string().trim().min(1).max(200)).max(200).optional(),
    maxAttempts: z.number().int().min(1).max(10).optional(),
    input: z.unknown().optional(),
    approvalRequired: z.boolean().optional(),
  });
  const CreateRunSchema = z
    .object({
      goal: z.string().trim().min(1).max(20_000),
      profile: z.enum(["fast", "balanced", "quality"]).default("balanced"),
      tasks: z.array(PlannedTaskSchema).min(1).max(200),
      createdBy: z.string().trim().min(1).max(200).optional(),
    })
    .strict();

  app.post("/v1/runs", async (request, reply) => {
    const parsed = CreateRunSchema.safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({
          error: {
            code: "invalid_run_plan",
            message: "A run requires a goal and a valid, bounded task plan.",
            retryable: false,
            requestId: request.id,
          },
        });
    try {
      const run = store.createRun(parsed.data as CreateRunInput);
      return reply
        .code(201)
        .send({
          run,
          tasks: store.listTasks(run.id),
          events: store.listEvents(run.id),
        });
    } catch (error) {
      requestWarning(app, error, "invalid_run_plan");
      return reply
        .code(400)
        .send({
          error: {
            code: "invalid_run_plan",
            message:
              error instanceof Error ? error.message : "Run plan was rejected.",
            retryable: false,
            requestId: request.id,
          },
        });
    }
  });

  const PlanRequestSchema = z.object({
    goal: z.string().trim().min(1).max(20_000),
    profile: z.enum(["fast", "balanced", "quality"]).default("balanced"),
    createdBy: z.string().trim().min(1).max(200).optional(),
  }).strict();

  app.post("/v1/runs/plan", async (request, reply) => {
    const parsed = PlanRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: "invalid_plan_request",
          message: "Request must include a goal and an optional valid OmniRouter profile.",
          retryable: false,
          requestId: request.id,
        },
      });
    }
    const abort = new AbortController();
    request.raw.on("aborted", () => abort.abort());
    try {
      const plan = await planner.createPlan({
        goal: parsed.data.goal,
        profile: parsed.data.profile,
        signal: abort.signal,
      });
      const input: CreateRunInput = {
        goal: parsed.data.goal,
        profile: parsed.data.profile,
        tasks: plan.tasks,
        ...(parsed.data.createdBy ? { createdBy: parsed.data.createdBy } : {}),
      };
      const run = store.createRun(input);
      return reply.code(201).send({
        run,
        plan: {
          summary: plan.summary,
          selectedAgents: plan.selectedAgents,
          provider: { id: plan.providerId, model: plan.model, latencyMs: plan.latencyMs },
          planningAttempts: plan.attempts,
        },
        tasks: store.listTasks(run.id),
        events: store.listEvents(run.id),
      });
    } catch (error) {
      if (error instanceof PlanError) {
        const status = error.code === "catalog_unavailable" ? 503
          : error.code === "no_provider_available" || error.code === "no_specialists_found" ? 503
          : error.code === "cancelled" ? 499
          : error.retryable ? 502 : 422;
        request.log.warn({ code: error.code, requestId: request.id }, "Run planning failed");
        return reply.code(status).send({
          error: {
            code: error.code,
            message: error.message,
            retryable: error.retryable,
            requestId: request.id,
          },
        });
      }
      requestWarning(app, error, "run_planning_failed");
      return reply.code(500).send({
        error: {
          code: "run_planning_failed",
          message: "The backend could not create the planned run.",
          retryable: true,
          requestId: request.id,
        },
      });
    }
  });

  app.get("/v1/runs", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    let limit: number;
    try {
      limit = parseBoundedInteger(query.limit, 50, 1, 200);
    } catch {
      return reply
        .code(400)
        .send({
          error: {
            code: "invalid_query",
            message: "limit must be an integer from 1 to 200.",
            retryable: false,
          },
        });
    }
    const beforeRaw = query.before;
    const before =
      typeof beforeRaw === "string" && /^\\d+$/.test(beforeRaw)
        ? Number(beforeRaw)
        : undefined;
    if (beforeRaw !== undefined && before === undefined)
      return reply
        .code(400)
        .send({
          error: {
            code: "invalid_cursor",
            message: "The before cursor must be a positive integer timestamp.",
            retryable: false,
          },
        });
    try {
      return { data: store.listRuns(limit, before) };
    } catch {
      return reply
        .code(400)
        .send({
          error: {
            code: "invalid_query",
            message: "Run list query was invalid.",
            retryable: false,
          },
        });
    }
  });

  app.get("/v1/runs/:runId", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const run = store.getRun(runId);
    if (!run)
      return reply
        .code(404)
        .send({
          error: {
            code: "run_not_found",
            message: "Run not found.",
            retryable: false,
            requestId: request.id,
          },
        });
    return {
      run,
      tasks: store.listTasks(runId),
      events: store.listEvents(runId, 0, 100),
    };
  });

  app.get("/v1/runs/:runId/events", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    if (!store.getRun(runId))
      return reply
        .code(404)
        .send({
          error: {
            code: "run_not_found",
            message: "Run not found.",
            retryable: false,
          },
        });
    const query = request.query as Record<string, unknown>;
    let afterId: number;
    let limit: number;
    try {
      afterId = parseBoundedInteger(
        query.afterId,
        0,
        0,
        Number.MAX_SAFE_INTEGER,
      );
      limit = parseBoundedInteger(query.limit, 200, 1, 1000);
    } catch {
      return reply
        .code(400)
        .send({
          error: {
            code: "invalid_query",
            message: "Event cursor or limit is outside the allowed range.",
            retryable: false,
          },
        });
    }
    return { data: store.listEvents(runId, afterId, limit) };
  });

  app.post("/v1/runs/:runId/cancel", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const body = z
      .object({ reason: z.string().max(2000).optional() })
      .safeParse(request.body ?? {});
    if (!body.success)
      return reply
        .code(400)
        .send({
          error: {
            code: "invalid_request",
            message: "Cancellation reason is too long.",
            retryable: false,
          },
        });
    try {
      return { run: store.cancelRun(runId, body.data.reason) };
    } catch {
      return reply
        .code(404)
        .send({
          error: {
            code: "run_not_found",
            message: "Run not found.",
            retryable: false,
          },
        });
    }
  });

  app.post("/v1/runs/:runId/approvals/:taskId", async (request, reply) => {
    const { runId, taskId } = request.params as {
      runId: string;
      taskId: string;
    };
    const body = z
      .object({
        approved: z.boolean(),
        reason: z.string().max(2000).optional(),
      })
      .safeParse(request.body);
    if (!body.success)
      return reply
        .code(400)
        .send({
          error: {
            code: "invalid_request",
            message:
              "Approval needs a boolean decision and an optional bounded reason.",
            retryable: false,
          },
        });
    try {
      return {
        task: store.resolveTaskApproval(
          runId,
          taskId,
          body.data.approved,
          body.data.reason,
        ),
      };
    } catch (error) {
      return reply
        .code(409)
        .send({
          error: {
            code: "approval_conflict",
            message:
              error instanceof Error
                ? error.message
                : "Task is not awaiting approval.",
            retryable: false,
          },
        });
    }
  });

  app.get("/v1/models", async () => ({
    object: "list",
    data: [
      { id: "omni/fast", object: "model", owned_by: "kurochan" },
      { id: "omni/balanced", object: "model", owned_by: "kurochan" },
      { id: "omni/quality", object: "model", owned_by: "kurochan" },
      ...[...registry.providers.values()]
        .filter((provider) => Boolean(provider.defaultModel))
        .map((provider) => ({
          id: provider.id + "/" + provider.defaultModel,
          object: "model",
          owned_by: provider.id,
        })),
    ],
  }));

  app.post("/v1/chat/completions", async (request, reply) => {
    const parsed = ChatCompletionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: "invalid_request",
          message:
            "Request must contain a supported model alias and valid text chat messages.",
          retryable: false,
          requestId: request.id,
        },
      });
    }
    const body = parsed.data;
    if (body.stream) {
      return reply.code(501).send({
        error: {
          code: "streaming_not_supported_yet",
          message:
            "Streaming responses are not enabled in this backend build. Set stream to false.",
          retryable: false,
          requestId: request.id,
        },
      });
    }
    const selection = modelSelection(body.model, registry);
    if (!selection) {
      return reply.code(400).send({
        error: {
          code: "unknown_model",
          message:
            "Use omni/fast, omni/balanced, omni/quality, or a provider-qualified model such as openrouter/vendor/model.",
          retryable: false,
          requestId: request.id,
        },
      });
    }

    const abort = new AbortController();
    request.raw.on("aborted", () => abort.abort());

    try {
      const result = await router.complete({
        profile: selection.profile,
        ...(selection.preferredProvider
          ? {
              preferredProvider: selection.preferredProvider,
              lockProvider: true,
            }
          : {}),
        ...(selection.providerModel ? { model: selection.providerModel } : {}),
        messages: body.messages,
        maxTokens: body.max_tokens ?? 1024,
        temperature: body.temperature ?? 0.2,
        timeoutMs: body.timeout_ms ?? 60_000,
        signal: abort.signal,
        requiredCapabilities: ["text"],
      });
      const responseBody: ChatCompletionResponse = {
        id: "chatcmpl_" + randomUUID().replaceAll("-", ""),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: result.content },
            finish_reason: "stop",
          },
        ],
        ...(result.usage
          ? {
              usage: {
                ...(result.usage.promptTokens === undefined
                  ? {}
                  : { prompt_tokens: Math.round(result.usage.promptTokens) }),
                ...(result.usage.completionTokens === undefined
                  ? {}
                  : {
                      completion_tokens: Math.round(
                        result.usage.completionTokens,
                      ),
                    }),
                ...(result.usage.totalTokens === undefined
                  ? {}
                  : { total_tokens: Math.round(result.usage.totalTokens) }),
              },
            }
          : {}),
      };
      reply.header("x-omnirouter-provider", result.providerId);
      reply.header("x-omnirouter-profile", result.routeProfile);
      reply.header("x-omnirouter-attempts", String(result.attempts));
      return responseBody;
    } catch (error) {
      const err = error as {
        code?: string;
        message?: string;
        retryable?: boolean;
      };
      const status =
        err.code === "no_provider_available"
          ? 503
          : err.code === "router_overloaded"
            ? 429
            : err.code === "cancelled"
              ? 499
              : err.code === "invalid_request"
                ? 400
                : 502;
      request.log.warn(
        { code: err.code ?? "routing_error", requestId: request.id },
        "OmniRouter request failed",
      );
      return reply.code(status).send({
        error: {
          code: err.code ?? "routing_error",
          message:
            err.message ??
            "OmniRouter could not complete the inference request.",
          retryable: err.retryable ?? status >= 500,
          requestId: request.id,
        },
      });
    }
  });

  return app;
}

function parseBoundedInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed =
    value === undefined
      ? fallback
      : typeof value === "number"
        ? value
        : typeof value === "string" && /^\\d+$/.test(value)
          ? Number(value)
          : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max)
    throw new Error(`Value must be an integer between ${min} and ${max}.`);
  return parsed;
}

function requestWarning(
  app: FastifyInstance,
  error: unknown,
  code: string,
): void {
  app.log.warn(
    { error: error instanceof Error ? error.message : String(error), code },
    "Backend request could not be completed",
  );
}

export function validateServerConfiguration(env: Environment = process.env): {
  host: string;
  port: number;
} {
  const host = env.HOST?.trim() || "127.0.0.1";
  const parsedPort = Number.parseInt(env.PORT ?? "8787", 10);
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535)
    throw new Error("PORT must be an integer between 1 and 65535.");
  const loopback =
    host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (!loopback && !env.KUROCHAN_API_TOKEN?.trim()) {
    throw new Error(
      "Refusing to bind Kuro-chan API to a non-loopback host without KUROCHAN_API_TOKEN.",
    );
  }
  const rateLimit = Number.parseInt(env.API_RATE_LIMIT_PER_MINUTE ?? "60", 10);
  if (!Number.isInteger(rateLimit) || rateLimit < 1 || rateLimit > 1000)
    throw new Error("API_RATE_LIMIT_PER_MINUTE must be between 1 and 1000.");
  const concurrency = Number.parseInt(
    env.OMNIROUTER_MAX_CONCURRENT ?? "24",
    10,
  );
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 256)
    throw new Error("OMNIROUTER_MAX_CONCURRENT must be between 1 and 256.");
  return { host, port: parsedPort };
}
