import type { ProviderId, ProviderStatus } from "@kurochan/contracts";
import { OpenAICompatibleChatProvider } from "./openai-compatible.js";
import type { ChatProvider } from "./provider.js";

export type Environment = Readonly<Record<string, string | undefined>>;
export interface ProviderRegistry {
  readonly providers: ReadonlyMap<ProviderId, ChatProvider>;
  readonly statuses: readonly ProviderStatus[];
}

const definitions: Record<ProviderId, { name: string; capabilityNotes: string[] }> = {
  openrouter: { name: "OpenRouter", capabilityNotes: ["OpenAI-compatible text chat", "Model features vary; vision/tools must be verified per model"] },
  freellmapi: { name: "FreeLLMAPI", capabilityNotes: ["Configurable OpenAI-compatible chat endpoint", "Availability and free-tier quotas depend on the configured gateway/providers"] },
};

export function createProviderRegistry(env: Environment = process.env): ProviderRegistry {
  const openRouterKey = env.OPENROUTER_API_KEY?.trim();
  const openRouterModel = env.OPENROUTER_MODEL?.trim();
  const freeBaseUrl = env.FREELLMAPI_BASE_URL?.trim();
  const freeKey = env.FREELLMAPI_API_KEY?.trim();
  const freeModel = env.FREELLMAPI_MODEL?.trim();
  const openRouter = openRouterKey && openRouterModel
    ? new OpenAICompatibleChatProvider({
        id: "openrouter", displayName: definitions.openrouter.name,
        baseUrl: env.OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api/v1",
        apiKey: openRouterKey, defaultModel: openRouterModel,
        extraHeaders: {
          ...(env.OPENROUTER_SITE_URL?.trim() ? { "http-referer": env.OPENROUTER_SITE_URL.trim() } : {}),
          "x-title": "Kuro-chan",
        },
      })
    : undefined;
  const freeLlmApi = freeBaseUrl && freeKey && freeModel
    ? new OpenAICompatibleChatProvider({
        id: "freellmapi", displayName: definitions.freellmapi.name, baseUrl: freeBaseUrl,
        apiKey: freeKey, defaultModel: freeModel,
      })
    : undefined;

  const providers = new Map<ProviderId, ChatProvider>();
  if (openRouter?.isConfigured) providers.set("openrouter", openRouter);
  if (freeLlmApi?.isConfigured) providers.set("freellmapi", freeLlmApi);

  const statuses: ProviderStatus[] = (["openrouter", "freellmapi"] as const).map((id) => {
    const provider = providers.get(id);
    return {
      id, name: definitions[id].name, configured: Boolean(provider?.isConfigured),
      ...(provider?.defaultModel ? { defaultModel: provider.defaultModel } : {}),
      capabilityNotes: definitions[id].capabilityNotes,
    };
  });
  return { providers, statuses };
}
