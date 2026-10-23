import type {
  Capability,
  ProviderId,
  ProviderStatus,
  RouteProfile,
} from "@kurochan/contracts";
import type {
  ChatCompletionInput,
  ChatCompletionOutput,
  ChatCompletionStreamChunk,
  ChatCompletionUsage,
  ChatProvider,
} from "@kurochan/model-gateway";
import { ProviderError } from "@kurochan/model-gateway";

export type { ProviderId, RouteProfile };

export interface OmniRouteRequest extends ChatCompletionInput {
  readonly profile: RouteProfile;
  readonly preferredProvider?: ProviderId;
  readonly lockProvider?: boolean;
  readonly requiredCapabilities?: readonly Capability[];
  readonly context?: OmniRouteContext;
}

export type OmniRouteOperation =
  "chat" | "planning" | "task" | "verification" | "provider_test" | "other";

export interface OmniRouteContext {
  readonly operation?: OmniRouteOperation;
  readonly runId?: string;
  readonly taskId?: string;
}

export interface OmniRouterUsageEvent {
  readonly providerId: ProviderId;
  readonly model: string;
  readonly profile: RouteProfile;
  readonly operation: OmniRouteOperation;
  readonly runId?: string;
  readonly taskId?: string;
  readonly latencyMs: number;
  readonly outcome: "success" | "failure";
  readonly errorCode?: string;
  readonly usage?: ChatCompletionUsage;
}

export interface OmniRouteResult extends ChatCompletionOutput {
  readonly routeProfile: RouteProfile;
  readonly attempts: number;
  readonly providerErrors: readonly { providerId: ProviderId; code: string }[];
}

export interface OmniRouteStreamResult {
  readonly providerId: ProviderId;
  readonly model: string;
  readonly routeProfile: RouteProfile;
  readonly attempts: number;
  readonly providerErrors: readonly { providerId: ProviderId; code: string }[];
  readonly stream: AsyncIterable<ChatCompletionStreamChunk>;
  close(): void;
}

export interface OmniRouterOptions {
  readonly providers: ReadonlyMap<ProviderId, ChatProvider>;
  readonly routeOrder?: Partial<Record<RouteProfile, readonly ProviderId[]>>;
  readonly maxAttempts?: number;
  readonly maxConcurrentRequests?: number;
  readonly failureThreshold?: number;
  readonly circuitCooldownMs?: number;
  readonly now?: () => number;
  readonly onUsage?: (event: OmniRouterUsageEvent) => void;
}

export interface ProviderHealth {
  readonly id: ProviderId;
  readonly configured: boolean;
  readonly circuitOpen: boolean;
  readonly consecutiveFailures: number;
  readonly lastLatencyMs?: number;
  readonly lastErrorCode?: string;
}

interface MutableProviderHealth {
  consecutiveFailures: number;
  openUntil: number;
  lastLatencyMs?: number;
  lastErrorCode: string | undefined;
  successes: number;
  failures: number;
}

const DEFAULT_ROUTES: Record<RouteProfile, readonly ProviderId[]> = {
  fast: ["freellmapi", "openrouter"],
  balanced: ["openrouter", "freellmapi"],
  quality: ["openrouter", "freellmapi"],
};

export class OmniRouterError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly attempts: number;
  readonly providerErrors: readonly { providerId: ProviderId; code: string }[];

  constructor(
    code: string,
    message: string,
    attempts: number,
    providerErrors: readonly { providerId: ProviderId; code: string }[] = [],
    retryable = false,
  ) {
    super(message);
    this.name = "OmniRouterError";
    this.code = code;
    this.attempts = attempts;
    this.providerErrors = providerErrors;
    this.retryable = retryable;
  }
}

function parseOrder(
  value: string | undefined,
  fallback: readonly ProviderId[],
): readonly ProviderId[] {
  if (!value?.trim()) return fallback;
  const parsed: ProviderId[] = [];
  for (const candidate of value
    .split(",")
    .map((part) => part.trim().toLowerCase())) {
    if (
      (candidate === "openrouter" || candidate === "freellmapi") &&
      !parsed.includes(candidate)
    )
      parsed.push(candidate);
  }
  return parsed.length > 0 ? parsed : fallback;
}

export function routeOrdersFromEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Record<RouteProfile, readonly ProviderId[]> {
  return {
    fast: parseOrder(env.OMNIROUTER_ROUTE_FAST, DEFAULT_ROUTES.fast),
    balanced: parseOrder(
      env.OMNIROUTER_ROUTE_BALANCED,
      DEFAULT_ROUTES.balanced,
    ),
    quality: parseOrder(env.OMNIROUTER_ROUTE_QUALITY, DEFAULT_ROUTES.quality),
  };
}

function providerSupports(
  provider: ChatProvider,
  required: readonly Capability[],
): boolean {
  return required.every(
    (capability) =>
      capability === "text" || provider.capabilities?.[capability] === true,
  );
}

export class OmniRouter {
  private readonly providers: ReadonlyMap<ProviderId, ChatProvider>;
  private readonly routeOrder: Record<RouteProfile, readonly ProviderId[]>;
  private readonly maxAttempts: number;
  private readonly maxConcurrentRequests: number;
  private readonly failureThreshold: number;
  private readonly circuitCooldownMs: number;
  private readonly now: () => number;
  private readonly health = new Map<ProviderId, MutableProviderHealth>();
  private activeRequests = 0;
  private readonly onUsage: ((event: OmniRouterUsageEvent) => void) | undefined;

  constructor(options: OmniRouterOptions) {
    this.providers = options.providers;
    this.onUsage = options.onUsage;
    this.routeOrder = {
      fast: options.routeOrder?.fast ?? DEFAULT_ROUTES.fast,
      balanced: options.routeOrder?.balanced ?? DEFAULT_ROUTES.balanced,
      quality: options.routeOrder?.quality ?? DEFAULT_ROUTES.quality,
    };
    this.maxAttempts = options.maxAttempts ?? 2;
    this.maxConcurrentRequests = options.maxConcurrentRequests ?? 24;
    this.failureThreshold = options.failureThreshold ?? 3;
    this.circuitCooldownMs = options.circuitCooldownMs ?? 30_000;
    this.now = options.now ?? Date.now;
    if (
      !Number.isInteger(this.maxAttempts) ||
      this.maxAttempts < 1 ||
      this.maxAttempts > 5
    )
      throw new Error("maxAttempts must be between 1 and 5");
    if (
      !Number.isInteger(this.maxConcurrentRequests) ||
      this.maxConcurrentRequests < 1 ||
      this.maxConcurrentRequests > 256
    )
      throw new Error("maxConcurrentRequests must be between 1 and 256");
    if (
      !Number.isInteger(this.failureThreshold) ||
      this.failureThreshold < 1 ||
      this.failureThreshold > 20
    )
      throw new Error("failureThreshold must be between 1 and 20");
    if (
      !Number.isInteger(this.circuitCooldownMs) ||
      this.circuitCooldownMs < 1_000 ||
      this.circuitCooldownMs > 300_000
    )
      throw new Error("circuitCooldownMs must be between 1000 and 300000");
    for (const id of options.providers.keys()) {
      this.health.set(id, {
        consecutiveFailures: 0,
        openUntil: 0,
        successes: 0,
        failures: 0,
        lastErrorCode: undefined,
      });
    }
  }

  private emitUsage(
    request: OmniRouteRequest,
    usage: {
      readonly providerId: ProviderId;
      readonly model: string;
      readonly latencyMs: number;
      readonly outcome: "success" | "failure";
      readonly errorCode?: string;
      readonly usage?: ChatCompletionUsage;
    },
  ): void {
    if (!this.onUsage) return;
    try {
      this.onUsage({
        ...usage,
        profile: request.profile,
        operation: request.context?.operation ?? "other",
        ...(request.context?.runId ? { runId: request.context.runId } : {}),
        ...(request.context?.taskId ? { taskId: request.context.taskId } : {}),
      });
    } catch {
      // Telemetry must never make inference fail.
    }
  }

  get hasConfiguredProviders(): boolean {
    for (const provider of this.providers.values()) {
      if (provider.isConfigured) return true;
    }
    return false;
  }

  async complete(request: OmniRouteRequest): Promise<OmniRouteResult> {
    if (request.signal?.aborted)
      throw new OmniRouterError(
        "cancelled",
        "The request was cancelled before routing.",
        0,
      );
    if (this.activeRequests >= this.maxConcurrentRequests) {
      throw new OmniRouterError(
        "router_overloaded",
        "OmniRouter reached its concurrent request limit. Retry shortly.",
        0,
        [],
        true,
      );
    }
    this.activeRequests += 1;
    try {
      return await this.route(request);
    } finally {
      this.activeRequests -= 1;
    }
  }

  async stream(request: OmniRouteRequest): Promise<OmniRouteStreamResult> {
    if (request.signal?.aborted) {
      throw new OmniRouterError(
        "cancelled",
        "The request was cancelled before routing.",
        0,
      );
    }
    if (this.activeRequests >= this.maxConcurrentRequests) {
      throw new OmniRouterError(
        "router_overloaded",
        "OmniRouter reached its concurrent request limit. Retry shortly.",
        0,
        [],
        true,
      );
    }
    this.activeRequests += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.activeRequests = Math.max(0, this.activeRequests - 1);
    };
    try {
      const required: Capability[] = [
        ...new Set<Capability>([
          ...(request.requiredCapabilities?.length
            ? request.requiredCapabilities
            : ["text" as const]),
          "streaming",
        ]),
      ];
      const configuredOrder = this.routeOrder[request.profile];
      const orderedIds = request.preferredProvider
        ? request.lockProvider
          ? [request.preferredProvider]
          : [
              request.preferredProvider,
              ...configuredOrder.filter(
                (id) => id !== request.preferredProvider,
              ),
            ]
        : [...configuredOrder];
      const configured = orderedIds
        .map((id) => this.providers.get(id))
        .filter((provider): provider is ChatProvider =>
          Boolean(provider?.isConfigured),
        );
      const candidates = configured.filter(
        (provider) =>
          providerSupports(provider, required) &&
          typeof provider.stream === "function",
      );
      if (candidates.length === 0) {
        const message =
          configured.length === 0
            ? "No configured provider is available for OmniRouter. Configure at least one supported provider and model."
            : "No configured provider supports streaming for this request. Enable the streaming capability for a compatible provider.";
        throw new OmniRouterError(
          "no_provider_available",
          message,
          0,
          [],
          true,
        );
      }

      const providerErrors: Array<{ providerId: ProviderId; code: string }> =
        [];
      let attempts = 0;
      let lastError: unknown;
      for (const provider of candidates) {
        if (attempts >= this.maxAttempts) break;
        if (request.signal?.aborted) {
          throw new OmniRouterError(
            "cancelled",
            "The request was cancelled.",
            attempts,
            providerErrors,
          );
        }
        const health = this.health.get(provider.id) ?? {
          consecutiveFailures: 0,
          openUntil: 0,
          successes: 0,
          failures: 0,
          lastErrorCode: undefined,
        };
        this.health.set(provider.id, health);
        if (health.openUntil > this.now()) {
          providerErrors.push({
            providerId: provider.id,
            code: "circuit_open",
          });
          continue;
        }
        attempts += 1;
        const startedAt = this.now();
        try {
          const chunks = await provider.stream!({
            messages: request.messages,
            ...(request.systemPrompt
              ? { systemPrompt: request.systemPrompt }
              : {}),
            ...(request.maxTokens === undefined
              ? {}
              : { maxTokens: request.maxTokens }),
            ...(request.temperature === undefined
              ? {}
              : { temperature: request.temperature }),
            ...(request.timeoutMs === undefined
              ? {}
              : { timeoutMs: request.timeoutMs }),
            ...(request.signal ? { signal: request.signal } : {}),
            requiredCapabilities: required,
            ...((request.preferredProvider === provider.id && request.model) ||
            !request.preferredProvider
              ? request.model
                ? { model: request.model }
                : {}
              : {}),
          });

          // Force the provider to deliver its first chunk before returning a route.
          // If the connection dies before any output, retry a different capable provider.
          const iterator = chunks[Symbol.asyncIterator]();
          let first: IteratorResult<ChatCompletionStreamChunk>;
          try {
            first = await iterator.next();
          } catch (error) {
            try {
              await iterator.return?.();
            } catch {
              // Preserve the original provider error.
            }
            throw error;
          }
          const prefetched: AsyncIterable<ChatCompletionStreamChunk> = {
            async *[Symbol.asyncIterator]() {
              try {
                if (!first.done) yield first.value;
                while (true) {
                  const next = await iterator.next();
                  if (next.done) return;
                  yield next.value;
                }
              } finally {
                try {
                  await iterator.return?.();
                } catch {
                  // The downstream can close before upstream responds to cancellation.
                }
              }
            },
          };
          const routedModel =
            request.model &&
            (!request.preferredProvider ||
              request.preferredProvider === provider.id)
              ? request.model
              : (provider.defaultModel ?? "");
          const observed = this.observeStream(
            provider,
            prefetched,
            startedAt,
            request.signal,
            release,
            request,
            routedModel,
          );
          return {
            providerId: provider.id,
            model: routedModel,
            routeProfile: request.profile,
            attempts,
            providerErrors: [...providerErrors],
            stream: observed,
            close: release,
          };
        } catch (error) {
          lastError = error;
          const providerError =
            error instanceof ProviderError ? error : undefined;
          const code = providerError?.code ?? "provider_error";
          health.lastErrorCode = code;
          health.failures += 1;
          this.emitUsage(request, {
            providerId: provider.id,
            model:
              request.model &&
              (!request.preferredProvider ||
                request.preferredProvider === provider.id)
                ? request.model
                : provider.defaultModel || "",
            latencyMs: Math.max(0, this.now() - startedAt),
            outcome: "failure",
            errorCode: code,
          });
          providerErrors.push({ providerId: provider.id, code });
          if (providerError?.code === "cancelled" || request.signal?.aborted) {
            throw new OmniRouterError(
              "cancelled",
              "The request was cancelled.",
              attempts,
              providerErrors,
            );
          }
          if (providerError?.retryable) {
            health.consecutiveFailures += 1;
            if (health.consecutiveFailures >= this.failureThreshold)
              health.openUntil = this.now() + this.circuitCooldownMs;
            continue;
          }
          throw new OmniRouterError(
            code,
            providerError?.message ??
              "A model provider failed with an unexpected error.",
            attempts,
            providerErrors,
            false,
          );
        }
      }
      const finalCode =
        lastError instanceof ProviderError
          ? lastError.code
          : "upstream_unavailable";
      throw new OmniRouterError(
        finalCode,
        "All streaming-capable providers failed before the stream could start.",
        attempts,
        providerErrors,
        true,
      );
    } catch (error) {
      release();
      throw error;
    }
  }

  private observeStream(
    provider: ChatProvider,
    source: AsyncIterable<ChatCompletionStreamChunk>,
    startedAt: number,
    signal: AbortSignal | undefined,
    release: () => void,
    request: OmniRouteRequest,
    model: string,
  ): AsyncIterable<ChatCompletionStreamChunk> {
    const health = this.health.get(provider.id)!;
    const now = this.now;
    const failureThreshold = this.failureThreshold;
    const cooldownMs = this.circuitCooldownMs;
    const emitUsage = (
      outcome: "success" | "failure",
      latencyMs: number,
      errorCode?: string,
      usage?: ChatCompletionUsage,
    ) => {
      this.emitUsage(request, {
        providerId: provider.id,
        model,
        latencyMs,
        outcome,
        ...(errorCode ? { errorCode } : {}),
        ...(usage ? { usage } : {}),
      });
    };
    return (async function* () {
      let finished = false;
      let usageRecorded = false;
      let reportedUsage: ChatCompletionUsage | undefined;
      try {
        for await (const chunk of source) {
          if (chunk.usage) reportedUsage = chunk.usage;
          if (signal?.aborted) {
            throw new OmniRouterError(
              "cancelled",
              "The stream was cancelled.",
              1,
            );
          }
          yield chunk;
        }
        finished = true;
        health.consecutiveFailures = 0;
        health.openUntil = 0;
        health.lastLatencyMs = now() - startedAt;
        health.lastErrorCode = undefined;
        health.successes += 1;
        emitUsage(
          "success",
          Math.max(0, now() - startedAt),
          undefined,
          reportedUsage,
        );
        usageRecorded = true;
      } catch (error) {
        const providerError =
          error instanceof ProviderError ? error : undefined;
        const errorCode =
          providerError?.code ??
          (error instanceof OmniRouterError ? error.code : "provider_error");
        emitUsage(
          "failure",
          Math.max(0, now() - startedAt),
          errorCode,
          reportedUsage,
        );
        usageRecorded = true;
        if (providerError?.code !== "cancelled" && !signal?.aborted) {
          const code =
            providerError?.code ??
            (error instanceof OmniRouterError ? error.code : "provider_error");
          health.lastErrorCode = code;
          health.failures += 1;
          if (
            providerError?.retryable ||
            (error instanceof OmniRouterError && error.retryable)
          ) {
            health.consecutiveFailures += 1;
            if (health.consecutiveFailures >= failureThreshold)
              health.openUntil = now() + cooldownMs;
          }
        }
        if (
          signal?.aborted ||
          providerError?.code === "cancelled" ||
          (error instanceof OmniRouterError && error.code === "cancelled")
        ) {
          throw new OmniRouterError(
            "cancelled",
            "The stream was cancelled.",
            1,
          );
        }
        if (error instanceof OmniRouterError) throw error;
        throw new OmniRouterError(
          providerError?.code ?? "upstream_unavailable",
          providerError?.message ?? "The provider stream ended unexpectedly.",
          1,
          [
            {
              providerId: provider.id,
              code: providerError?.code ?? "provider_error",
            },
          ],
          providerError?.retryable ?? true,
        );
      } finally {
        if (!finished && !usageRecorded) {
          emitUsage(
            "failure",
            Math.max(0, now() - startedAt),
            signal?.aborted ? "cancelled" : "stream_closed",
            reportedUsage,
          );
        }
        release();
      }
    })();
  }

  private async route(request: OmniRouteRequest): Promise<OmniRouteResult> {
    const required = [
      ...new Set<Capability>(
        request.requiredCapabilities?.length
          ? request.requiredCapabilities
          : ["text"],
      ),
    ];
    const configuredOrder = this.routeOrder[request.profile];
    const orderedIds = request.preferredProvider
      ? request.lockProvider
        ? [request.preferredProvider]
        : [
            request.preferredProvider,
            ...configuredOrder.filter((id) => id !== request.preferredProvider),
          ]
      : [...configuredOrder];
    const configured = orderedIds
      .map((id) => this.providers.get(id))
      .filter((provider): provider is ChatProvider =>
        Boolean(provider?.isConfigured),
      );
    const candidates = configured.filter((provider) =>
      providerSupports(provider, required),
    );
    if (candidates.length === 0) {
      const message =
        configured.length === 0
          ? "No configured provider is available for OmniRouter. Configure at least one supported provider and model."
          : "No configured provider satisfies the required capabilities for this request.";
      throw new OmniRouterError("no_provider_available", message, 0, [], true);
    }

    const providerErrors: Array<{ providerId: ProviderId; code: string }> = [];
    let attempts = 0;
    let lastError: unknown;
    for (const provider of candidates) {
      if (attempts >= this.maxAttempts) break;
      if (request.signal?.aborted)
        throw new OmniRouterError(
          "cancelled",
          "The request was cancelled.",
          attempts,
          providerErrors,
        );
      const health = this.health.get(provider.id) ?? {
        consecutiveFailures: 0,
        openUntil: 0,
        successes: 0,
        failures: 0,
        lastErrorCode: undefined,
      };
      this.health.set(provider.id, health);
      if (health.openUntil > this.now()) {
        providerErrors.push({ providerId: provider.id, code: "circuit_open" });
        continue;
      }
      attempts += 1;
      const beganAt = this.now();
      try {
        const result = await provider.complete({
          messages: request.messages,
          ...(request.systemPrompt
            ? { systemPrompt: request.systemPrompt }
            : {}),
          ...(request.maxTokens === undefined
            ? {}
            : { maxTokens: request.maxTokens }),
          ...(request.temperature === undefined
            ? {}
            : { temperature: request.temperature }),
          ...(request.timeoutMs === undefined
            ? {}
            : { timeoutMs: request.timeoutMs }),
          ...(request.signal ? { signal: request.signal } : {}),
          requiredCapabilities: required,
          // The explicit model override is passed only to the requested provider.
          ...((request.preferredProvider === provider.id && request.model) ||
          !request.preferredProvider
            ? request.model
              ? { model: request.model }
              : {}
            : {}),
        });
        health.consecutiveFailures = 0;
        health.openUntil = 0;
        health.lastLatencyMs = result.latencyMs;
        health.lastErrorCode = undefined;
        health.successes += 1;
        this.emitUsage(request, {
          providerId: provider.id,
          model: result.model || provider.defaultModel || request.model || "",
          latencyMs: result.latencyMs,
          outcome: "success",
          ...(result.usage ? { usage: result.usage } : {}),
        });
        return {
          ...result,
          routeProfile: request.profile,
          attempts,
          providerErrors,
        };
      } catch (error) {
        lastError = error;
        const providerError =
          error instanceof ProviderError ? error : undefined;
        const code = providerError?.code ?? "provider_error";
        health.lastErrorCode = code;
        health.failures += 1;
        this.emitUsage(request, {
          providerId: provider.id,
          model:
            request.model &&
            (!request.preferredProvider ||
              request.preferredProvider === provider.id)
              ? request.model
              : provider.defaultModel || "",
          latencyMs: Math.max(0, this.now() - beganAt),
          outcome: "failure",
          errorCode: code,
        });
        providerErrors.push({ providerId: provider.id, code });
        if (providerError?.code === "cancelled" || request.signal?.aborted) {
          throw new OmniRouterError(
            "cancelled",
            "The request was cancelled.",
            attempts,
            providerErrors,
          );
        }
        if (providerError?.retryable) {
          health.consecutiveFailures += 1;
          if (health.consecutiveFailures >= this.failureThreshold)
            health.openUntil = this.now() + this.circuitCooldownMs;
          continue;
        }
        throw new OmniRouterError(
          code,
          providerError?.message ??
            "A model provider failed with an unexpected error.",
          attempts,
          providerErrors,
          false,
        );
      }
    }

    if (providerErrors.length === 0) {
      throw new OmniRouterError(
        "no_provider_available",
        "All configured providers are temporarily excluded by circuit breakers.",
        attempts,
        providerErrors,
        true,
      );
    }
    const finalCode =
      lastError instanceof ProviderError
        ? lastError.code
        : "upstream_unavailable";
    throw new OmniRouterError(
      finalCode,
      "All available providers failed for this request.",
      attempts,
      providerErrors,
      true,
    );
  }

  getProviderHealth(
    statuses: readonly ProviderStatus[],
  ): readonly ProviderHealth[] {
    return statuses.map((status) => {
      const state = this.health.get(status.id);
      return {
        id: status.id,
        configured: status.configured,
        circuitOpen: Boolean(state && state.openUntil > this.now()),
        consecutiveFailures: state?.consecutiveFailures ?? 0,
        ...(state?.lastLatencyMs === undefined
          ? {}
          : { lastLatencyMs: state.lastLatencyMs }),
        ...(state?.lastErrorCode === undefined
          ? {}
          : { lastErrorCode: state.lastErrorCode }),
      };
    });
  }
}
