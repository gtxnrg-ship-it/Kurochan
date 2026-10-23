import { describe, expect, it } from "vitest";
import { createProviderRegistry } from "../src/config.js";

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
