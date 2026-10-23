import type {
  Capability,
  ChatMessage,
  ProviderCapabilities,
  ProviderId,
} from "@kurochan/contracts";

export interface ChatCompletionInput {
  readonly messages: readonly ChatMessage[];
  readonly model?: string;
  readonly systemPrompt?: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly requiredCapabilities?: readonly Capability[];
}

export interface ChatCompletionUsage {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
}

export interface ChatCompletionStreamChunk {
  readonly content: string;
}

export interface ChatCompletionOutput {
  readonly providerId: ProviderId;
  readonly model: string;
  readonly content: string;
  readonly usage?: ChatCompletionUsage;
  readonly latencyMs: number;
}

export interface ChatProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly defaultModel: string | undefined;
  readonly isConfigured: boolean;
  /** Missing flags are conservatively treated as false except for text. */
  readonly capabilities?: Partial<ProviderCapabilities>;
  complete(input: ChatCompletionInput): Promise<ChatCompletionOutput>;
  /** Available only when the provider's selected model is configured for streaming. */
  stream?(input: ChatCompletionInput): Promise<AsyncIterable<ChatCompletionStreamChunk>>;
}

export type ProviderErrorCode =
  | "not_configured"
  | "invalid_configuration"
  | "timeout"
  | "cancelled"
  | "rate_limited"
  | "upstream_unavailable"
  | "upstream_rejected"
  | "invalid_response";

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;
  readonly statusCode: number | undefined;

  constructor(
    code: ProviderErrorCode,
    message: string,
    options: { retryable?: boolean; statusCode?: number; cause?: unknown } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "ProviderError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.statusCode = options.statusCode;
  }
}
