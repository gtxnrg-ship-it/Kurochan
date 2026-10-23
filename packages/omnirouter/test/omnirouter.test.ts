import { describe, expect, it, vi } from "vitest";
import type { ProviderId } from "@kurochan/contracts";
import { OmniRouter } from "../src/index.js";
import { ProviderError, type ChatProvider } from "@kurochan/model-gateway";

function provider(id: ProviderId, complete: ChatProvider["complete"], capabilities?: ChatProvider["capabilities"]): ChatProvider {
  return {
    id, displayName: id, isConfigured: true, defaultModel: "test-model",
    ...(capabilities ? { capabilities } : {}),
    complete,
  };
}

const success = async (): Promise<Awaited<ReturnType<ChatProvider["complete"]>>> => ({
  providerId: "openrouter", model: "test-model", content: "hello", latencyMs: 12,
});

describe("OmniRouter", () => {
  it("routes according to the selected profile", async () => {
    const first = vi.fn(success);
    const second = vi.fn(success);
    const router = new OmniRouter({
      providers: new Map([["openrouter", provider("openrouter", first)], ["freellmapi", provider("freellmapi", second)]]),
      routeOrder: { balanced: ["openrouter", "freellmapi"] },
    });
    const result = await router.complete({ profile: "balanced", messages: [{ role: "user", content: "test" }] });
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    expect(result.attempts).toBe(1);
    expect(result.routeProfile).toBe("balanced");
  });

  it("forces an explicitly requested provider and model", async () => {
    const open = vi.fn(success);
    const free = vi.fn(success);
    const router = new OmniRouter({
      providers: new Map([["openrouter", provider("openrouter", open)], ["freellmapi", provider("freellmapi", free)]]),
    });
    await router.complete({
      profile: "balanced", preferredProvider: "freellmapi", lockProvider: true,
      model: "custom/model-name", messages: [{ role: "user", content: "test" }],
    });
    expect(free).toHaveBeenCalledWith(expect.objectContaining({ model: "custom/model-name" }));
    expect(open).not.toHaveBeenCalled();
  });

  it("fails over on retryable provider failures and records them", async () => {
    const first = vi.fn(async () => { throw new ProviderError("rate_limited", "limited", { retryable: true }); });
    const second = vi.fn(success);
    const router = new OmniRouter({
      providers: new Map([["openrouter", provider("openrouter", first)], ["freellmapi", provider("freellmapi", second)]]),
      routeOrder: { balanced: ["openrouter", "freellmapi"] },
    });
    const result = await router.complete({ profile: "balanced", messages: [{ role: "user", content: "test" }] });
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(result.attempts).toBe(2);
    expect(result.providerErrors).toEqual([{ providerId: "openrouter", code: "rate_limited" }]);
  });

  it("does not fail over after a non-retryable provider error", async () => {
    const first = vi.fn(async () => { throw new ProviderError("upstream_rejected", "bad model"); });
    const second = vi.fn(success);
    const router = new OmniRouter({
      providers: new Map([["openrouter", provider("openrouter", first)], ["freellmapi", provider("freellmapi", second)]]),
      routeOrder: { balanced: ["openrouter", "freellmapi"] },
    });
    await expect(router.complete({ profile: "balanced", messages: [{ role: "user", content: "test" }] }))
      .rejects.toMatchObject({ code: "upstream_rejected" });
    expect(second).not.toHaveBeenCalled();
  });

  it("does not select providers that lack required capabilities", async () => {
    const complete = vi.fn(success);
    const router = new OmniRouter({
      providers: new Map([["openrouter", provider("openrouter", complete)]]),
    });
    await expect(router.complete({
      profile: "balanced", requiredCapabilities: ["vision"], messages: [{ role: "user", content: "test" }],
    })).rejects.toMatchObject({ code: "no_provider_available" });
    expect(complete).not.toHaveBeenCalled();
  });

  it("opens circuit breakers after repeated retryable errors", async () => {
    let now = 10_000;
    const first = vi.fn(async () => { throw new ProviderError("upstream_unavailable", "down", { retryable: true }); });
    const second = vi.fn(success);
    const router = new OmniRouter({
      providers: new Map([["openrouter", provider("openrouter", first)], ["freellmapi", provider("freellmapi", second)]]),
      routeOrder: { balanced: ["openrouter", "freellmapi"] },
      maxAttempts: 2, failureThreshold: 1, circuitCooldownMs: 5_000, now: () => now,
    });
    await router.complete({ profile: "balanced", messages: [{ role: "user", content: "test" }] });
    first.mockClear();
    second.mockClear();
    now += 1_000;
    await router.complete({ profile: "balanced", messages: [{ role: "user", content: "test" }] });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it("honors cancellation before issuing provider calls", async () => {
    const complete = vi.fn(success);
    const router = new OmniRouter({ providers: new Map([["openrouter", provider("openrouter", complete)]]) });
    const abort = new AbortController();
    abort.abort();
    await expect(router.complete({ profile: "balanced", messages: [{ role: "user", content: "test" }], signal: abort.signal }))
      .rejects.toMatchObject({ code: "cancelled" });
    expect(complete).not.toHaveBeenCalled();
  });

  it("rejects overload rather than growing an unbounded queue", async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const complete = vi.fn(async () => { await held; return success(); });
    const router = new OmniRouter({
      providers: new Map([["openrouter", provider("openrouter", complete)]]),
      maxConcurrentRequests: 1,
    });
    const pending = router.complete({ profile: "balanced", messages: [{ role: "user", content: "first" }] });
    await expect(router.complete({ profile: "balanced", messages: [{ role: "user", content: "second" }] }))
      .rejects.toMatchObject({ code: "router_overloaded" });
    release?.();
    await pending;
  });
});
