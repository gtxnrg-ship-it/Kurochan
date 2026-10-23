import { describe, expect, it, vi } from "vitest";
import { OmniRouter } from "../src/index.js";
import { ProviderError, type ChatProvider } from "@kurochan/model-gateway";

function provider(id: "openrouter" | "freellmapi", complete: ChatProvider["complete"]): ChatProvider {
  return { id, displayName: id, isConfigured: true, defaultModel: "test-model", complete };
}

const success = async (): Promise<Awaited<ReturnType<ChatProvider["complete"]>>> => ({
  providerId: "openrouter", model: "test-model", content: "hello", latencyMs: 12,
});

describe("OmniRouter", () => {
  it("routes according to the chosen profile and reports attempts", async () => {
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

  it("fails over on retryable provider failure", async () => {
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
    expect(result.providerId).toBe("freellmapi");
  });

  it("does not fail over for a non-retryable provider error", async () => {
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

  it("returns a clear error when no provider is configured", async () => {
    const router = new OmniRouter({ providers: new Map() });
    await expect(router.complete({ profile: "balanced", messages: [{ role: "user", content: "test" }] }))
      .rejects.toMatchObject({ code: "no_provider_available" });
  });

  it("opens a circuit after repeated retryable errors and skips the provider", async () => {
    let now = 10_000;
    const first = vi.fn(async () => { throw new ProviderError("upstream_unavailable", "down", { retryable: true }); });
    const second = vi.fn(success);
    const router = new OmniRouter({
      providers: new Map([["openrouter", provider("openrouter", first)], ["freellmapi", provider("freellmapi", second)]]),
      routeOrder: { balanced: ["openrouter", "freellmapi"] },
      maxAttempts: 2, failureThreshold: 1, circuitCooldownMs: 5_000, now: () => now,
    });
    await router.complete({ profile: "balanced", messages: [{ role: "user", content: "test" }] });
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
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
});
