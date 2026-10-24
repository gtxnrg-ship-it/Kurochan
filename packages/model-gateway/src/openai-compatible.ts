import type {
  Capability,
  ProviderCapabilities,
  ProviderId,
} from "@kurochan/contracts";
import {
  ProviderError,
  type ChatCompletionInput,
  type ChatCompletionOutput,
  type ChatCompletionStreamChunk,
  type ChatProvider,
  type ChatCompletionUsage,
  type ProviderModelInfo,
} from "./provider.js";

export interface OpenAICompatibleProviderOptions {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly defaultModel: string | undefined;
  readonly capabilities?: Partial<ProviderCapabilities>;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly includeStreamUsage?: boolean;
  readonly fetchImpl?: typeof fetch;
  readonly extraHeaders?: Readonly<Record<string, string>>;
  readonly allowInsecureHttp?: boolean;
}

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  text: true,
  vision: false,
  tools: false,
  json: false,
  streaming: false,
  reasoning: false,
};

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function usageFrom(value: unknown): ChatCompletionUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as {
    usage?: unknown;
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
  };
  const usage =
    record.usage && typeof record.usage === "object"
      ? (record.usage as {
          prompt_tokens?: unknown;
          completion_tokens?: unknown;
          total_tokens?: unknown;
        })
      : record;
  const promptTokens = optionalNumber(usage.prompt_tokens);
  const completionTokens = optionalNumber(usage.completion_tokens);
  const totalTokens = optionalNumber(usage.total_tokens);
  if (
    promptTokens === undefined &&
    completionTokens === undefined &&
    totalTokens === undefined
  )
    return undefined;
  return {
    ...(promptTokens === undefined ? {} : { promptTokens }),
    ...(completionTokens === undefined ? {} : { completionTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
}

function contentFrom(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const choices = (data as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object")
    return undefined;
  const message = (choices[0] as { message?: unknown }).message;
  if (!message || typeof message !== "object") return undefined;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string" && content.trim()) return content;
  if (Array.isArray(content)) {
    const joined = content
      .flatMap((part: unknown) => {
        if (!part || typeof part !== "object") return [];
        const record = part as { type?: unknown; text?: unknown };
        return record.type === "text" && typeof record.text === "string"
          ? [record.text]
          : [];
      })
      .join("");
    if (joined.trim()) return joined;
  }
  return undefined;
}

function streamDeltaFrom(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object")
    return undefined;
  const delta = (choices[0] as { delta?: unknown }).delta;
  if (!delta || typeof delta !== "object") return undefined;
  const content = (delta as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content
      .flatMap((part: unknown) => {
        if (!part || typeof part !== "object") return [];
        const item = part as { type?: unknown; text?: unknown };
        return item.type === "text" && typeof item.text === "string"
          ? [item.text]
          : [];
      })
      .join("");
    return text || undefined;
  }
  return undefined;
}

function parseStreamEvent(event: string): {
  done: boolean;
  chunks: ChatCompletionStreamChunk[];
} {
  const data = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n")
    .trim();
  if (!data) return { done: false, chunks: [] };
  if (data === "[DONE]") return { done: true, chunks: [] };
  let payload: unknown;
  try {
    payload = JSON.parse(data) as unknown;
  } catch (error) {
    throw new ProviderError(
      "invalid_response",
      "Provider returned a malformed streaming event.",
      { cause: error },
    );
  }
  const content = streamDeltaFrom(payload);
  const usage = usageFrom(payload);
  return {
    done: false,
    chunks:
      content !== undefined || usage
        ? [{ content: content ?? "", ...(usage ? { usage } : {}) }]
        : [],
  };
}

function safeEndpoint(baseUrl: string, allowInsecureHttp = false): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ProviderError(
      "invalid_configuration",
      "Provider base URL must be an absolute URL.",
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ProviderError(
      "invalid_configuration",
      "Provider URL must use HTTP or HTTPS.",
    );
  }
  const isLoopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol === "http:" && !isLoopback && !allowInsecureHttp) {
    throw new ProviderError(
      "invalid_configuration",
      "Remote provider endpoints must use HTTPS. HTTP is permitted for loopback development; insecure FreeLLMAPI endpoints require explicit opt-in.",
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ProviderError(
      "invalid_configuration",
      "Provider base URL must not contain credentials, query parameters, or fragments.",
    );
  }
  return url.toString().replace(/\/+$/, "");
}

async function readBoundedBody(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new ProviderError(
      "invalid_response",
      "Provider response exceeded the configured size limit.",
    );
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
        throw new ProviderError(
          "invalid_response",
          "Provider response exceeded the configured size limit.",
        );
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
  readonly defaultModel: string | undefined;
  readonly isConfigured: boolean;
  readonly capabilities: ProviderCapabilities;
  private readonly endpoint: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly includeStreamUsage: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly extraHeaders: Readonly<Record<string, string>>;

  constructor(options: OpenAICompatibleProviderOptions) {
    this.id = options.id;
    this.displayName = options.displayName;
    this.endpoint = safeEndpoint(
      options.baseUrl,
      options.id === "freellmapi" && options.allowInsecureHttp === true,
    );
    this.apiKey = options.apiKey?.trim() || undefined;
    this.defaultModel = options.defaultModel?.trim() || undefined;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 2_000_000;
    this.includeStreamUsage = options.includeStreamUsage ?? false;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.extraHeaders = options.extraHeaders ?? {};
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...options.capabilities };
    this.isConfigured = Boolean(this.apiKey && this.defaultModel);
    if (
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 1_000 ||
      this.timeoutMs > 300_000
    ) {
      throw new ProviderError(
        "invalid_configuration",
        "Provider timeout must be between 1000 and 300000 milliseconds.",
      );
    }
    if (
      !Number.isInteger(this.maxResponseBytes) ||
      this.maxResponseBytes < 1024 ||
      this.maxResponseBytes > 10_000_000
    ) {
      throw new ProviderError(
        "invalid_configuration",
        "Provider response limit must be between 1024 and 10000000 bytes.",
      );
    }
  }

  async listModels(): Promise<readonly ProviderModelInfo[]> {
    if (!this.apiKey) {
      throw new ProviderError(
        "not_configured",
        `${this.displayName} is missing its server-side API key.`,
      );
    }

    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.endpoint}/models`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          accept: "application/json",
          ...this.extraHeaders,
        },
        signal: timeoutSignal,
      });
    } catch (error) {
      throw new ProviderError(
        "upstream_unavailable",
        `${this.displayName} model catalog could not be reached.`,
        { retryable: true, cause: error },
      );
    }

    const body = await readBoundedBody(response, this.maxResponseBytes);
    if (!response.ok) {
      if (response.status === 402) {
        throw new ProviderError(
          "quota_exhausted",
          `${this.displayName} has exhausted its available credits or quota.`,
          { retryable: true, statusCode: 402 },
        );
      }
      if (
        response.status === 429 ||
        response.status === 408 ||
        response.status >= 500
      ) {
        throw new ProviderError(
          response.status === 429 ? "rate_limited" : "upstream_unavailable",
          `${this.displayName} model catalog is temporarily unavailable.`,
          { retryable: true, statusCode: response.status },
        );
      }
      throw new ProviderError(
        "upstream_rejected",
        `${this.displayName} rejected the model catalog request (HTTP ${response.status}).`,
        { statusCode: response.status },
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body) as unknown;
    } catch (error) {
      throw new ProviderError(
        "invalid_response",
        `${this.displayName} returned an invalid model catalog.`,
        { cause: error },
      );
    }

    const rawModels =
      payload &&
      typeof payload === "object" &&
      Array.isArray((payload as { data?: unknown }).data)
        ? (payload as { data: unknown[] }).data
        : undefined;
    if (!rawModels) {
      throw new ProviderError(
        "invalid_response",
        `${this.displayName} returned an unsupported model catalog format.`,
      );
    }

    const stringValue = (
      value: unknown,
      maximumLength: number,
    ): string | undefined =>
      typeof value === "string" && value.trim()
        ? value.trim().slice(0, maximumLength)
        : undefined;
    const numericValue = (value: unknown): number | undefined => {
      const number =
        typeof value === "number"
          ? value
          : typeof value === "string" && value.trim()
            ? Number(value)
            : Number.NaN;
      return Number.isFinite(number) && number >= 0 ? number : undefined;
    };
    const stringArray = (value: unknown): string[] | undefined =>
      Array.isArray(value)
        ? value
            .filter((entry): entry is string => typeof entry === "string")
            .map((entry) => entry.trim().slice(0, 80))
            .filter(Boolean)
            .slice(0, 100)
        : undefined;

    return rawModels
      .flatMap((item): ProviderModelInfo[] => {
        if (!item || typeof item !== "object") return [];
        const record = item as {
          id?: unknown;
          name?: unknown;
          description?: unknown;
          context_length?: unknown;
          pricing?: { prompt?: unknown; completion?: unknown };
          architecture?: { input_modalities?: unknown; modality?: unknown };
          supported_parameters?: unknown;
        };
        const id = stringValue(record.id, 200);
        if (!id) return [];
        const name = stringValue(record.name, 180);
        const description = stringValue(record.description, 400);
        const contextLength = numericValue(record.context_length);
        const inputPricePerToken = numericValue(record.pricing?.prompt);
        const outputPricePerToken = numericValue(record.pricing?.completion);
        const modalities =
          stringArray(record.architecture?.input_modalities) ??
          stringArray(record.architecture?.modality);
        const supportedParameters = stringArray(record.supported_parameters);
        return [
          {
            id,
            ...(name ? { name } : {}),
            ...(description ? { description } : {}),
            ...(contextLength === undefined ? {} : { contextLength }),
            ...(inputPricePerToken === undefined ? {} : { inputPricePerToken }),
            ...(outputPricePerToken === undefined
              ? {}
              : { outputPricePerToken }),
            ...(modalities ? { modalities } : {}),
            ...(supportedParameters ? { supportedParameters } : {}),
          },
        ];
      })
      .slice(0, 5_000);
  }

  async stream(
    input: ChatCompletionInput,
  ): Promise<AsyncIterable<ChatCompletionStreamChunk>> {
    if (!this.apiKey) {
      throw new ProviderError(
        "not_configured",
        `${this.displayName} is missing its server-side API key.`,
      );
    }
    const model = input.model?.trim() || this.defaultModel;
    if (!model)
      throw new ProviderError(
        "not_configured",
        `${this.displayName} has no model configured.`,
      );
    const requiredCapabilities: readonly Capability[] =
      input.requiredCapabilities ?? ["text", "streaming"];
    const missingCapability = requiredCapabilities.find(
      (capability) => !this.capabilities[capability],
    );
    if (missingCapability) {
      throw new ProviderError(
        "upstream_rejected",
        `${this.displayName} is not configured for the required ${missingCapability} capability.`,
      );
    }
    if (input.messages.length === 0)
      throw new ProviderError(
        "invalid_response",
        "At least one chat message is required.",
      );

    const messages = [
      ...(input.systemPrompt?.trim()
        ? [{ role: "system", content: input.systemPrompt.trim() }]
        : []),
      ...input.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    ];
    const timeoutSignal = AbortSignal.timeout(
      Math.min(input.timeoutMs ?? this.timeoutMs, this.timeoutMs),
    );
    const signal = input.signal
      ? AbortSignal.any([input.signal, timeoutSignal])
      : timeoutSignal;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.endpoint}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
          accept: "text/event-stream",
          ...this.extraHeaders,
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: input.maxTokens ?? 1024,
          temperature: input.temperature ?? 0.2,
          stream: true,
          ...(this.includeStreamUsage
            ? { stream_options: { include_usage: true } }
            : {}),
        }),
        signal,
      });
    } catch (error) {
      if (input.signal?.aborted)
        throw new ProviderError(
          "cancelled",
          "The model request was cancelled.",
          { cause: error },
        );
      if (timeoutSignal.aborted)
        throw new ProviderError(
          "timeout",
          `${this.displayName} exceeded the request deadline.`,
          { retryable: true, cause: error },
        );
      throw new ProviderError(
        "upstream_unavailable",
        `${this.displayName} could not be reached.`,
        { retryable: true, cause: error },
      );
    }
    if (!response.ok) {
      if (response.status === 402)
        throw new ProviderError(
          "quota_exhausted",
          `${this.displayName} has exhausted its available credits or quota.`,
          { retryable: true, statusCode: 402 },
        );
      if (response.status === 429)
        throw new ProviderError(
          "rate_limited",
          `${this.displayName} rate-limited the request.`,
          { retryable: true, statusCode: 429 },
        );
      if (response.status === 408 || response.status >= 500)
        throw new ProviderError(
          "upstream_unavailable",
          `${this.displayName} returned an upstream error.`,
          { retryable: true, statusCode: response.status },
        );
      throw new ProviderError(
        "upstream_rejected",
        `${this.displayName} rejected the request (HTTP ${response.status}).`,
        { statusCode: response.status },
      );
    }
    if (!response.body)
      throw new ProviderError(
        "invalid_response",
        "Provider returned an empty streaming response.",
      );
    const contentType = response.headers.get("content-type");
    if (
      contentType &&
      !contentType.toLowerCase().includes("text/event-stream")
    ) {
      throw new ProviderError(
        "invalid_response",
        "Provider did not return a server-sent event stream.",
      );
    }
    const startedAt = Date.now();
    return this.parseStream(
      response.body,
      input.signal,
      timeoutSignal,
      startedAt,
    );
  }

  private async *parseStream(
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal | undefined,
    timeoutSignal: AbortSignal,
    startedAt: number,
  ): AsyncGenerator<ChatCompletionStreamChunk> {
    void startedAt;
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let totalBytes = 0;
    let receivedDone = false;
    try {
      while (true) {
        if (signal?.aborted)
          throw new ProviderError(
            "cancelled",
            "The model request was cancelled.",
          );
        let item: ReadableStreamReadResult<Uint8Array>;
        try {
          item = await reader.read();
        } catch (error) {
          if (signal?.aborted)
            throw new ProviderError(
              "cancelled",
              "The model request was cancelled.",
              { cause: error },
            );
          if (timeoutSignal.aborted)
            throw new ProviderError(
              "timeout",
              "Provider streaming exceeded the request deadline.",
              { retryable: true, cause: error },
            );
          throw new ProviderError(
            "upstream_unavailable",
            "Provider streaming was interrupted.",
            { retryable: true, cause: error },
          );
        }
        if (item.done) break;
        totalBytes += item.value.byteLength;
        if (totalBytes > this.maxResponseBytes) {
          await reader
            .cancel("provider stream exceeded response limit")
            .catch(() => undefined);
          throw new ProviderError(
            "invalid_response",
            "Provider stream exceeded the configured size limit.",
          );
        }
        buffer += decoder.decode(item.value, { stream: true });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() ?? "";
        for (const event of events) {
          const parsed = parseStreamEvent(event);
          if (parsed.done) {
            receivedDone = true;
            await reader.cancel().catch(() => undefined);
            return;
          }
          for (const chunk of parsed.chunks) yield chunk;
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) {
        const parsed = parseStreamEvent(buffer);
        if (parsed.done) receivedDone = true;
        for (const chunk of parsed.chunks) yield chunk;
      }
      if (!receivedDone) {
        throw new ProviderError(
          "invalid_response",
          "Provider stream ended before its [DONE] marker.",
        );
      }
    } finally {
      reader.releaseLock();
    }
  }

  async complete(input: ChatCompletionInput): Promise<ChatCompletionOutput> {
    if (!this.apiKey)
      throw new ProviderError(
        "not_configured",
        `${this.displayName} is missing its server-side API key.`,
      );
    const model = input.model?.trim() || this.defaultModel;
    if (!model)
      throw new ProviderError(
        "not_configured",
        `${this.displayName} has no model configured.`,
      );
    const requiredCapabilities: readonly Capability[] =
      input.requiredCapabilities ?? ["text"];
    const missingCapability = requiredCapabilities.find(
      (capability) => !this.capabilities[capability],
    );
    if (missingCapability) {
      throw new ProviderError(
        "upstream_rejected",
        `${this.displayName} is not configured for the required ${missingCapability} capability.`,
      );
    }
    if (input.messages.length === 0)
      throw new ProviderError(
        "invalid_response",
        "At least one chat message is required.",
      );

    const messages = [
      ...(input.systemPrompt?.trim()
        ? [{ role: "system", content: input.systemPrompt.trim() }]
        : []),
      ...input.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    ];
    const payload = {
      model,
      messages,
      max_tokens: input.maxTokens ?? 1024,
      temperature: input.temperature ?? 0.2,
      stream: false,
    };
    const startedAt = Date.now();
    const timeoutSignal = AbortSignal.timeout(
      Math.min(input.timeoutMs ?? this.timeoutMs, this.timeoutMs),
    );
    const signal = input.signal
      ? AbortSignal.any([input.signal, timeoutSignal])
      : timeoutSignal;
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
      if (input.signal?.aborted)
        throw new ProviderError(
          "cancelled",
          "The model request was cancelled.",
          { cause: error },
        );
      if (timeoutSignal.aborted)
        throw new ProviderError(
          "timeout",
          `${this.displayName} exceeded the request deadline.`,
          { retryable: true, cause: error },
        );
      throw new ProviderError(
        "upstream_unavailable",
        `${this.displayName} could not be reached.`,
        { retryable: true, cause: error },
      );
    }

    const body = await readBoundedBody(response, this.maxResponseBytes);
    if (!response.ok) {
      if (response.status === 402)
        throw new ProviderError(
          "quota_exhausted",
          `${this.displayName} has exhausted its available credits or quota.`,
          { retryable: true, statusCode: 402 },
        );
      if (response.status === 429)
        throw new ProviderError(
          "rate_limited",
          `${this.displayName} rate-limited the request.`,
          { retryable: true, statusCode: 429 },
        );
      if (response.status === 408 || response.status >= 500) {
        throw new ProviderError(
          "upstream_unavailable",
          `${this.displayName} returned an upstream error.`,
          { retryable: true, statusCode: response.status },
        );
      }
      throw new ProviderError(
        "upstream_rejected",
        `${this.displayName} rejected the request (HTTP ${response.status}).`,
        { statusCode: response.status },
      );
    }

    let data: unknown;
    try {
      data = JSON.parse(body) as unknown;
    } catch (error) {
      throw new ProviderError(
        "invalid_response",
        "Provider returned invalid JSON.",
        { cause: error },
      );
    }
    const content = contentFrom(data);
    if (!content)
      throw new ProviderError(
        "invalid_response",
        "Provider response contained no usable text answer.",
      );
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
