import { describe, expect, it } from "vitest";
import { createProviderRegistry } from "../src/config.js";

describe("OpenRouter provider configuration", () => {
  it("uses the free-only router and enables streaming when only the key is supplied", () => {
    const registry = createProviderRegistry({
      OPENROUTER_API_KEY: "openrouter-test-key",
    });
    const provider = registry.providers.get("openrouter");

    expect(provider).toBeDefined();
    expect(provider?.defaultModel).toBe("openrouter/free");
    expect(registry.statuses).toContainEqual(
      expect.objectContaining({
        id: "openrouter",
        configured: true,
        defaultModel: "openrouter/free",
        capabilities: expect.objectContaining({
          text: true,
          streaming: true,
        }),
      }),
    );
  });

  it("respects an explicit model override and disabled streaming", () => {
    const registry = createProviderRegistry({
      OPENROUTER_API_KEY: "openrouter-test-key",
      OPENROUTER_MODEL: "vendor/custom-model",
      OPENROUTER_CAP_STREAMING: "false",
    });
    const provider = registry.providers.get("openrouter");

    expect(provider?.defaultModel).toBe("vendor/custom-model");
    expect(provider?.capabilities?.streaming).toBe(false);
  });
});

describe("FreeLLMAPI provider configuration", () => {
  it("uses the documented local OpenAI-compatible endpoint and automatic model with a unified key", () => {
    const registry = createProviderRegistry({
      FREELLMAPI_API_KEY: "freellmapi-test-key",
    });
    const provider = registry.providers.get("freellmapi");

    expect(provider).toBeDefined();
    expect(provider?.defaultModel).toBe("auto");
    expect(registry.statuses).toContainEqual(
      expect.objectContaining({
        id: "freellmapi",
        configured: true,
        defaultModel: "auto",
        capabilities: expect.objectContaining({
          text: true,
          streaming: true,
        }),
      }),
    );
  });

  it("allows streaming capability to be explicitly disabled", () => {
    const registry = createProviderRegistry({
      FREELLMAPI_API_KEY: "freellmapi-test-key",
      FREELLMAPI_CAP_STREAMING: "false",
    });

    expect(registry.providers.get("freellmapi")?.capabilities?.streaming).toBe(
      false,
    );
  });

  it("does not configure remote HTTP endpoints without an explicit opt-in", () => {
    const registry = createProviderRegistry({
      FREELLMAPI_API_KEY: "freellmapi-test-key",
      FREELLMAPI_BASE_URL: "http://freellmapi:3001/v1",
    });

    expect(registry.providers.has("freellmapi")).toBe(false);
    expect(registry.statuses).toContainEqual(
      expect.objectContaining({
        id: "freellmapi",
        configured: false,
        capabilityNotes: expect.arrayContaining([
          expect.stringContaining("HTTPS"),
        ]),
      }),
    );
  });

  it("allows remote HTTP FreeLLMAPI only when explicitly opted in", () => {
    const registry = createProviderRegistry({
      FREELLMAPI_API_KEY: "freellmapi-test-key",
      FREELLMAPI_BASE_URL: "http://freellmapi:3001/v1",
      FREELLMAPI_ALLOW_INSECURE_HTTP: "true",
    });

    expect(registry.providers.get("freellmapi")?.isConfigured).toBe(true);
  });

  it("does not invent or configure a key when no key is supplied", () => {
    const registry = createProviderRegistry({});

    expect(registry.providers.has("freellmapi")).toBe(false);
    expect(registry.statuses).toContainEqual(
      expect.objectContaining({
        id: "freellmapi",
        configured: false,
      }),
    );
  });
});
