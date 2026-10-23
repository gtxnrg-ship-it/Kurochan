import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import {
  ChatCompletionRequestSchema,
  type ChatCompletionResponse,
  type ProviderId,
} from "@kurochan/contracts";
import { createProviderRegistry, type Environment } from "@kurochan/model-gateway";
import { OmniRouter, routeOrdersFromEnvironment } from "@kurochan/omnirouter";

export interface ServerOptions {
  readonly env?: Environment;
  readonly logger?: boolean;
  readonly providers?: ReturnType<typeof createProviderRegistry>;
  readonly fetchImpl?: typeof fetch;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function allowedOrigins(env: Environment): string[] {
  const configured = env.CORS_ALLOWED_ORIGINS?.split(",").map((v) => v.trim()).filter(Boolean) ?? [];
  const webOrigin = env.WEB_ORIGIN?.trim();
  if (webOrigin) configured.push(webOrigin);
  return [...new Set(configured)];
}

function providerIdFromModel(model: string): ProviderId | undefined {
  if (model.startsWith("openrouter/")) return "openrouter";
  if (model.startsWith("freellmapi/")) return "freellmapi";
  return undefined;
}

function profileFromModel(model: string) {
  const normalized = model.toLowerCase();
  if (normalized === "omni/fast") return "fast" as const;
  if (normalized === "omni/quality") return "quality" as const;
  return "balanced" as const;
}

export function buildServer(options: ServerOptions = {}): FastifyInstance {
  const env = options.env ?? process.env;
  const registry = options.providers ?? createProviderRegistry(env);
  const router = new OmniRouter({
    providers: registry.providers,
    routeOrder: routeOrdersFromEnvironment(env),
    maxAttempts: Number.parseInt(env.OMNIROUTER_MAX_ATTEMPTS ?? "2", 10),
    failureThreshold: Number.parseInt(env.OMNIROUTER_FAILURE_THRESHOLD ?? "3", 10),
    circuitCooldownMs: Number.parseInt(env.OMNIROUTER_CIRCUIT_COOLDOWN_MS ?? "30000", 10),
  });

  const app = Fastify({
    logger: options.logger ?? {
      level: env.LOG_LEVEL?.trim() || "info",
      redact: {
        paths: [
          "req.headers.authorization", "req.headers.x-api-key",
          "res.headers.authorization", "req.headers.cookie",
          "req.headers['set-cookie']",
        ],
        censor: "[REDACTED]",
      },
    },
    bodyLimit: 1_000_000,
    requestIdHeader: "x-request-id",
    disableRequestLogging: false,
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
    const candidate = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!candidate || !safeEqual(candidate, token)) {
      return reply.code(401).send({
        error: { code: "unauthorized", message: "A valid Kuro-chan API bearer token is required.", retryable: false, requestId: request.id },
      });
    }
  });

  app.setErrorHandler((error, request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    if (status >= 500) request.log.error({ err: error, requestId: request.id }, "Unhandled API error");
    const tooLarge = status === 413;
    const badJson = status === 400;
    void reply.code(status).send({
      error: {
        code: tooLarge ? "request_too_large" : badJson ? "invalid_request" : "internal_error",
        message: tooLarge ? "Request body exceeds the 1 MB limit." : badJson ? "Request body is invalid." : "The server could not complete the request.",
        retryable: status >= 500,
        requestId: request.id,
      },
    });
  });

  app.get("/healthz", async () => ({ ok: true, service: "kurochan-api" }));

  app.get("/readyz", async (_request, reply) => {
    const configuredProviders = registry.statuses.filter((p) => p.configured).length;
    const ready = configuredProviders > 0;
    if (!ready) reply.code(503);
    return { ready, configuredProviders, requirement: "Configure at least one model provider to run inference." };
  });

  app.get("/v1/config", async () => ({
    appName: "Kuro-chan",
    version: env.npm_package_version ?? "0.1.0",
    router: { name: "OmniRouter", availableProfiles: ["fast", "balanced", "quality"] },
    providers: registry.statuses,
  }));

  app.get("/v1/omnirouter/status", async () => ({
    name: "OmniRouter",
    profiles: routeOrdersFromEnvironment(env),
    providers: router.getProviderHealth(registry.statuses),
  }));

  app.get("/v1/models", async () => ({
    object: "list",
    data: [
      { id: "omni/fast", object: "model", owned_by: "kurochan" },
      { id: "omni/balanced", object: "model", owned_by: "kurochan" },
      { id: "omni/quality", object: "model", owned_by: "kurochan" },
    ],
  }));

  app.post("/v1/chat/completions", async (request, reply) => {
    const parsed = ChatCompletionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: "invalid_request", message: "Request must contain a supported model alias and valid text chat messages.", retryable: false, requestId: request.id },
      });
    }
    const body = parsed.data;
    if (body.stream) {
      return reply.code(501).send({
        error: { code: "streaming_not_supported_yet", message: "Streaming responses are not enabled in this backend build. Set stream to false.", retryable: false, requestId: request.id },
      });
    }
    const forcedProvider = providerIdFromModel(body.model);
    const profile = profileFromModel(body.model);
    const messages = body.messages;
    const abort = new AbortController();
    request.raw.on("aborted", () => abort.abort());

    try {
      const result = await router.complete({
        profile,
        messages,
        maxTokens: body.max_tokens ?? 1024,
        temperature: body.temperature ?? 0.2,
        signal: abort.signal,
        ...(forcedProvider && registry.providers.has(forcedProvider)
          ? { profile, }
          : {}),
      });
      const responseBody: ChatCompletionResponse = {
        id: `chatcmpl_${crypto.randomUUID().replaceAll("-", "")}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: result.content }, finish_reason: "stop" }],
        ...(result.usage ? { usage: {
          ...(result.usage.promptTokens === undefined ? {} : { prompt_tokens: result.usage.promptTokens }),
          ...(result.usage.completionTokens === undefined ? {} : { completion_tokens: result.usage.completionTokens }),
          ...(result.usage.totalTokens === undefined ? {} : { total_tokens: result.usage.totalTokens }),
        } } : {}),
      };
      reply.header("x-omnirouter-provider", result.providerId);
      reply.header("x-omnirouter-attempts", String(result.attempts));
      return responseBody;
    } catch (error) {
      const err = error as { code?: string; message?: string; retryable?: boolean };
      const status = err.code === "no_provider_available" ? 503
        : err.code === "cancelled" ? 499
        : err.code === "invalid_request" ? 400 : 502;
      request.log.warn({ code: err.code ?? "routing_error", requestId: request.id }, "OmniRouter request failed");
      return reply.code(status).send({
        error: {
          code: err.code ?? "routing_error",
          message: err.message ?? "OmniRouter could not complete the inference request.",
          retryable: err.retryable ?? status >= 500,
          requestId: request.id,
        },
      });
    }
  });

  return app;
}

export function validateServerConfiguration(env: Environment = process.env): { host: string; port: number } {
  const host = env.HOST?.trim() || "127.0.0.1";
  const parsedPort = Number.parseInt(env.PORT ?? "8787", 10);
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) throw new Error("PORT must be an integer between 1 and 65535.");
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (!loopback && !env.KUROCHAN_API_TOKEN?.trim()) {
    throw new Error("Refusing to bind Kuro-chan API to a non-loopback host without KUROCHAN_API_TOKEN.");
  }
  const rateLimit = Number.parseInt(env.API_RATE_LIMIT_PER_MINUTE ?? "60", 10);
  if (!Number.isInteger(rateLimit) || rateLimit < 1 || rateLimit > 1000) throw new Error("API_RATE_LIMIT_PER_MINUTE must be between 1 and 1000.");
  return { host, port: parsedPort };
}
