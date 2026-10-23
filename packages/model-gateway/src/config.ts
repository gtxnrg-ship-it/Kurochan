import type {
  Capability,
  ProviderCapabilities,
  ProviderId,
  ProviderStatus,
} from "@kurochan/contracts";
import { OpenAICompatibleChatProvider } from "./openai-compatible.js";
import type { ChatProvider } from "./provider.js";

export type Environment = Readonly<Record<string, string | undefined>>;
export interface ProviderRegistry {
  readonly providers: ReadonlyMap<ProviderId, ChatProvider>;
  readonly statuses: readonly ProviderStatus[];
}

const definitions: Record<
  ProviderId,
  { name: string; capabilityNotes: string[] }
> = {
  openrouter: {
    name: "OpenRouter",
    capabilityNotes: [
      "OpenAI-compatible text chat",
      "Capabilities must be enabled only for the chosen model",
    ],
  },
  freellmapi: {
    name: "FreeLLMAPI",
    capabilityNotes: [
      "Configured OpenAI-compatible chat endpoint",
      "Availability and quotas depend on the self-hosted gateway and upstream providers",
    ],
  },
};

function capabilitiesFromEnvironment(
  env: Environment,
  prefix: string,
  defaults: readonly Exclude<Capability, "text">[] = [],
): ProviderCapabilities {
  const isEnabled = (capability: Exclude<Capability, "text">) => {
    const configured = env[`${prefix}_CAP_${capability.toUpperCase()}`];
    if (configured === "true") return true;
    if (configured === "false") return false;
    return defaults.includes(capability);
  };
  return {
    text: true,
    vision: isEnabled("vision"),
    tools: isEnabled("tools"),
    json: isEnabled("json"),
    streaming: isEnabled("streaming"),
    reasoning: isEnabled("reasoning"),
  };
}

export function createProviderRegistry(
  env: Environment = process.env,
): ProviderRegistry {
  const specifications = [
    {
      id: "openrouter" as const,
      key: env.OPENROUTER_API_KEY?.trim(),
      model: env.OPENROUTER_MODEL?.trim(),
      baseUrl:
        env.OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api/v1",
      capabilityPrefix: "OPENROUTER",
      extraHeaders: {
        ...(env.OPENROUTER_SITE_URL?.trim()
          ? { "HTTP-Referer": env.OPENROUTER_SITE_URL.trim() }
          : {}),
        "X-OpenRouter-Title": "Kuro-chan",
      },
    },
    {
      id: "freellmapi" as const,
      key: env.FREELLMAPI_API_KEY?.trim(),
      model: env.FREELLMAPI_MODEL?.trim() || "auto",
      baseUrl: env.FREELLMAPI_BASE_URL?.trim() || "http://127.0.0.1:3001/v1",
      capabilityPrefix: "FREELLMAPI",
      defaultCapabilities: ["streaming"] as const,
      extraHeaders: {},
    },
  ];

  const providers = new Map<ProviderId, ChatProvider>();
  const statuses: ProviderStatus[] = [];
  for (const spec of specifications) {
    let provider: OpenAICompatibleChatProvider | undefined;
    let configurationError: string | undefined;
    if (spec.key && spec.model && spec.baseUrl) {
      try {
        provider = new OpenAICompatibleChatProvider({
          id: spec.id,
          displayName: definitions[spec.id].name,
          baseUrl: spec.baseUrl,
          apiKey: spec.key,
          defaultModel: spec.model,
          includeStreamUsage:
            env[`${spec.capabilityPrefix}_STREAM_USAGE`]?.trim().toLowerCase() === "true",
          capabilities: capabilitiesFromEnvironment(
            env,
            spec.capabilityPrefix,
            "defaultCapabilities" in spec ? spec.defaultCapabilities : [],
          ),
          extraHeaders: spec.extraHeaders,
        });
      } catch (error) {
        configurationError =
          error instanceof Error
            ? error.message
            : "Invalid provider configuration.";
      }
    }
    if (provider?.isConfigured) providers.set(provider.id, provider);
    statuses.push({
      id: spec.id,
      name: definitions[spec.id].name,
      configured: Boolean(provider?.isConfigured),
      ...(provider?.defaultModel
        ? { defaultModel: provider.defaultModel }
        : {}),
      capabilityNotes: configurationError
        ? [configurationError]
        : definitions[spec.id].capabilityNotes,
      ...(provider ? { capabilities: provider.capabilities } : {}),
    });
  }
  return { providers, statuses };
}
