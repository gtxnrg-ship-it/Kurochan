import type { ProviderId, RouteProfile, ProviderStatus } from "@kurochan/contracts";
import type { ChatCompletionInput, ChatCompletionOutput, ChatProvider } from "@kurochan/model-gateway";
import { ProviderError } from "@kurochan/model-gateway";

export type { ProviderId, RouteProfile };

export interface OmniRouteRequest extends ChatCompletionInput {
  readonly profile: RouteProfile;
  readonly requiredCapabilities?: readonly string[];
}

export interface OmniRouteResult extends ChatCompletionOutput {
  readonly routeProfile: RouteProfile;
  readonly attempts: number;
}

export interface OmniRouterOptions {
  readonly providers: ReadonlyMap<ProviderId, ChatProvider>;
  readonly routeOrder?: Partial<Record<RouteProfile, readonly ProviderId[]>>;
  readonly maxAttempts?: number;
  readonly failureThreshold?: number;
  readonly circuitCooldownMs?: number;
  readonly now?: () => number;
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
  lastErrorCode?: string;
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

function parseOrder(value: string | undefined, fallback: readonly ProviderId[]): readonly ProviderId[] {
  if (!value?.trim()) return fallback;
  const parsed: ProviderId[] = [];
  for (const candidate of value.split(",").map((part) => part.trim().toLowerCase())) {
    if ((candidate === "openrouter" || candidate === "freellmapi") && !parsed.includes(candidate)) parsed.push(candidate);
  }
  return parsed.length > 0 ? parsed : fallback;
}

export function routeOrdersFromEnvironment(env: Readonly<Record<string, string | undefined>> = process.env): Record<RouteProfile, readonly ProviderId[]> {
  return {
    fast: parseOrder(env.OMNIROUTER_ROUTE_FAST, DEFAULT_ROUTES.fast),
    balanced: parseOrder(env.OMNIROUTER_ROUTE_BALANCED, DEFAULT_ROUTES.balanced),
    quality: parseOrder(env.OMNIROUTER_ROUTE_QUALITY, DEFAULT_ROUTES.quality),
  };
}

export class OmniRouter {
  private readonly providers: ReadonlyMap<ProviderId, ChatProvider>;
  private readonly routeOrder: Record<RouteProfile, readonly ProviderId[]>;
  private readonly maxAttempts: number;
  private readonly failureThreshold: number;
  private readonly circuitCooldownMs: number;
  private readonly now: () => number;
  private readonly health = new Map<ProviderId, MutableProviderHealth>();

  constructor(options: OmniRouterOptions) {
    this.providers = options.providers;
    this.routeOrder = {
      fast: options.routeOrder?.fast ?? DEFAULT_ROUTES.fast,
      balanced: options.routeOrder?.balanced ?? DEFAULT_ROUTES.balanced,
      quality: options.routeOrder?.quality ?? DEFAULT_ROUTES.quality,
    };
    this.maxAttempts = options.maxAttempts ?? 2;
    this.failureThreshold = options.failureThreshold ?? 3;
    this.circuitCooldownMs = options.circuitCooldownMs ?? 30_000;
    this.now = options.now ?? Date.now;
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1 || this.maxAttempts > 5) throw new Error("maxAttempts must be between 1 and 5");
    if (!Number.isInteger(this.failureThreshold) || this.failureThreshold < 1 || this.failureThreshold > 20) throw new Error("failureThreshold must be between 1 and 20");
    if (!Number.isInteger(this.circuitCooldownMs) || this.circuitCooldownMs < 1_000) throw new Error("circuitCooldownMs must be at least 1000");
    for (const id of options.providers.keys()) this.health.set(id, { consecutiveFailures: 0, openUntil: 0 });
  }

  async complete(request: OmniRouteRequest): Promise<OmniRouteResult> {
    if (request.signal?.aborted) throw new OmniRouterError("cancelled", "The request was cancelled before routing.", 0);
    const order = this.routeOrder[request.profile];
    const candidates = order
      .map((id) => this.providers.get(id))
      .filter((provider): provider is ChatProvider => Boolean(provider?.isConfigured))
      .slice(0, this.maxAttempts);
    if (candidates.length === 0) {
      throw new OmniRouterError("no_provider_available", "No configured provider is available for OmniRouter. Configure at least one supported provider and model.", 0, [], true);
    }

    const providerErrors: Array<{ providerId: ProviderId; code: string }> = [];
    let attempts = 0;
    let lastError: unknown;
    for (const provider of candidates) {
      if (request.signal?.aborted) throw new OmniRouterError("cancelled", "The request was cancelled.", attempts, providerErrors);
      const health = this.health.get(provider.id) ?? { consecutiveFailures: 0, openUntil: 0 };
      this.health.set(provider.id, health);
      if (health.openUntil > this.now()) {
        providerErrors.push({ providerId: provider.id, code: "circuit_open" });
        continue;
      }
      attempts += 1;
      try {
        const result = await provider.complete(request);
        health.consecutiveFailures = 0;
        health.openUntil = 0;
        health.lastLatencyMs = result.latencyMs;
        health.lastErrorCode = undefined;
        return { ...result, routeProfile: request.profile, attempts };
      } catch (error) {
        lastError = error;
        const providerError = error instanceof ProviderError ? error : undefined;
        const code = providerError?.code ?? "provider_error";
        health.lastErrorCode = code;
        providerErrors.push({ providerId: provider.id, code });
        if (providerError?.code === "cancelled" || request.signal?.aborted) {
          throw new OmniRouterError("cancelled", "The request was cancelled.", attempts, providerErrors);
        }
        if (providerError?.retryable) {
          health.consecutiveFailures += 1;
          if (health.consecutiveFailures >= this.failureThreshold) health.openUntil = this.now() + this.circuitCooldownMs;
          continue;
        }
        throw new OmniRouterError(code, providerError?.message ?? "A model provider failed with an unexpected error.", attempts, providerErrors, false);
      }
    }

    if (providerErrors.length === 0) {
      throw new OmniRouterError("no_provider_available", "All configured providers are temporarily excluded by circuit breakers.", attempts, providerErrors, true);
    }
    const finalCode = lastError instanceof ProviderError ? lastError.code : "upstream_unavailable";
    throw new OmniRouterError(finalCode, "All available providers failed for this request.", attempts, providerErrors, true);
  }

  getProviderHealth(statuses: readonly ProviderStatus[]): readonly ProviderHealth[] {
    return statuses.map((status) => {
      const state = this.health.get(status.id);
      return {
        id: status.id, configured: status.configured,
        circuitOpen: Boolean(state && state.openUntil > this.now()),
        consecutiveFailures: state?.consecutiveFailures ?? 0,
        ...(state?.lastLatencyMs === undefined ? {} : { lastLatencyMs: state.lastLatencyMs }),
        ...(state?.lastErrorCode === undefined ? {} : { lastErrorCode: state.lastErrorCode }),
      };
    });
  }
}
