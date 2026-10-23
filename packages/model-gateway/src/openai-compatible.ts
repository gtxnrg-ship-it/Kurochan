import type { Capability, ProviderCapabilities, ProviderId } from "@kurochan/contracts";
import {
  ProviderError,
  type ChatCompletionInput,
  type ChatCompletionOutput,
  type ChatProvider,
  type ChatCompletionUsage,
} from "./provider.js";

export interface OpenAICompatibleProviderOptions {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly defaultModel?: string;
  readonly capabilities?: Partial<ProviderCapabilities>;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly fetchImpl?: typeof fetch;
  readonly extraHeaders?: Readonly<Record<string, string>>;
}

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  text: true, vision: false, tools: false, json: false, streaming: false, reasoning: false,
};

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function usageFrom(value: unknown): ChatCompletionUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
  const promptTokens = optionalNumber(usage.prompt_tokens);
  const completionTokens = optionalNumber(usage.completion_tokens);
  const totalTokens = optionalNumber(usage.total_tokens);
  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) return undefined;
  return {
    ...(promptTokens === undefined ? {} : { promptTokens }),
    ...(completionTokens === undefined ? {} : { completionTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
}

function contentFrom(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const choices = (data as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") return undefined;
  const message = (choices[0] as { message?: unknown }).message;
  if (!message || typeof message !== "object") return undefined;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string" && content.trim()) return content;
  if (Array.isArray(content)) {
    const joined = content.flatMap((part: unknown) => {
      if (!part || typeof part !== "object") return [];
      const record = part as { type?: unknown; text?: unknown };
      return record.type === "text" && typeof record.text === "string" ? [record.text] : [];
    }).join("");
    if (joined.trim()) return joined;
  }
  return undefined;
}

function safeEndpoint(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ProviderError("invalid_configuration", "Provider base URL must be an absolute URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ProviderError("invalid_configuration", "Provider URL must use HTTP or HTTPS.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ProviderError("invalid_configuration", "Provider base URL must not contain credentials, query parameters, or fragments.");
  }
  return url.toString().replace(/\/+$/, "");
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new ProviderError("invalid_response", "Provider response exceeded the configured size limit.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      totalBytes += item.value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel("provider response too large");
        throw new ProviderError("invalid_response", "Provider response exceeded the configured size limit.");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(output);
}

export class OpenAICompatibleChatProvider implements ChatProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly defaultModel?: string;
  readonly isConfigured: boolean;
  readonly capabilities: ProviderCapabilities;
  private readonly endpoint: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly fetchImpl: typeof fetch;
  private readonly extraHeaders: Readonly<Record<string, string>>;

  constructor(options: OpenAICompatibleProviderOptions) {
    this.id = options.id;
    this.displayName = options.displayName;
    this.endpoint = safeEndpoint(options.baseUrl);
    this.apiKey = options.apiKey?.trim() || undefined;
    this.defaultModel = options.defaultModel?.trim() || undefined;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 2_000_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.extraHeaders = options.extraHeaders ?? {};
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...options.capabilities };
    this.isConfigured = Boolean(this.apiKey && this.defaultModel);
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 300_000) {
      throw new ProviderError("invalid_configuration", "Provider timeout must be between 1000 and 300000 milliseconds.");
    }
    if (!Number.isInteger(this.maxResponseBytes) || this.maxResponseBytes < 1024 || this.maxResponseBytes > 10_000_000) {
      throw new ProviderError("invalid_configuration", "Provider response limit must be between 1024 and 10000000 bytes.");
    }
  }

  async complete(input: ChatCompletionInput): Promise<ChatCompletionOutput> {
    if (!this.apiKey) throw new ProviderError("not_configured", `${this.displayName} is missing its server-side API key.`);
    const model = input.model?.trim() || this.defaultModel;
    if (!model) throw new ProviderError("not_configured", `${this.displayName} has no model configured.`);
    const requiredCapabilities: readonly Capability[] = input.requiredCapabilities ?? ["text"];
    const missingCapability = requiredCapabilities.find((capability) => !this.capabilities[capability]);
    if (missingCapability) {
      throw new ProviderError("upstream_rejected", `${this.displayName} is not configured for the required ${missingCapability} capability.`);
    }
    if (input.messages.length === 0) throw new ProviderError("invalid_response", "At least one chat message is required.");

    const messages = [
      ...(input.systemPrompt?.trim() ? [{ role: "system", content: input.systemPrompt.trim() }] : []),
      ...input.messages.map((message) => ({ role: message.role, content: message.content })),
    ];
    const payload = {
      model, messages, max_tokens: input.maxTokens ?? 1024,
      temperature: input.temperature ?? 0.2, stream: false,
    };
    const startedAt = Date.now();
    const timeoutSignal = AbortSignal.timeout(Math.min(input.timeoutMs ?? this.timeoutMs, this.timeoutMs));
    const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.endpoint}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
          ...this.extraHeaders,
        },
        body: JSON.stringify(payload),
        signal,
      });
    } catch (error) {
      if (input.signal?.aborted) throw new ProviderError("cancelled", "The model request was cancelled.", { cause: error });
      if (timeoutSignal.aborted) throw new ProviderError("timeout", `${this.displayName} exceeded the request deadline.`, { retryable: true, cause: error });
      throw new ProviderError("upstream_unavailable", `${this.displayName} could not be reached.`, { retryable: true, cause: error });
    }

    const body = await readBoundedBody(response, this.maxResponseBytes);
    if (!response.ok) {
      if (response.status === 429) throw new ProviderError("rate_limited", `${this.displayName} rate-limited the request.`, { retryable: true, statusCode: 429 });
      if (response.status === 408 || response.status >= 500) {
        throw new ProviderError("upstream_unavailable", `${this.displayName} returned an upstream error.`, { retryable: true, statusCode: response.status });
      }
      throw new ProviderError("upstream_rejected", `${this.displayName} rejected the request (HTTP ${response.status}).`, { statusCode: response.status });
    }

    let data: unknown;
    try { data = JSON.parse(body) as unknown; }
    catch (error) { throw new ProviderError("invalid_response", "Provider returned invalid JSON.", { cause: error }); }
    const content = contentFrom(data);
    if (!content) throw new ProviderError("invalid_response", "Provider response contained no usable text answer.");
    const record = data as { usage?: unknown; model?: unknown };
    const usage = usageFrom(record.usage);
    return {
      providerId: this.id,
      model: typeof record.model === "string" ? record.model : model,
      content,
      ...(usage ? { usage } : {}),
      latencyMs: Date.now() - startedAt,
    };
  }
}
