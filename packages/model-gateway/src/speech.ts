import type { Environment } from "./config.js";

export interface SpeechEndpointConfig {
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly model?: string;
}

export interface SpeechSynthesisConfig extends SpeechEndpointConfig {
  readonly voice?: string;
  readonly responseFormat?: "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";
  readonly instructions?: string;
}

export interface SpeechTranscriptionStatus {
  readonly enabled: boolean;
  readonly provider: string;
  readonly model: string | null;
  readonly authenticationConfigured: boolean;
  readonly maxAudioBytes: number;
  readonly defaultLanguage: string | null;
}

export interface SpeechSynthesisStatus {
  readonly enabled: boolean;
  readonly provider: string;
  readonly model: string | null;
  readonly voice: string | null;
  readonly format: NonNullable<SpeechSynthesisConfig["responseFormat"]>;
  readonly customInstructionsConfigured: boolean;
  readonly authenticationConfigured: boolean;
  readonly maxTextCharacters: number;
  readonly maxResponseBytes: number;
}

export interface SpeechRuntimeStatus {
  readonly transcription: SpeechTranscriptionStatus;
  readonly synthesis: SpeechSynthesisStatus;
}

export interface SpeechRuntime {
  readonly isTranscriptionConfigured: boolean;
  readonly isSynthesisConfigured: boolean;
  readonly status: SpeechRuntimeStatus;
  transcribe(
    input: SpeechTranscriptionInput,
  ): Promise<SpeechTranscriptionResult>;
  synthesize(input: SpeechSynthesisInput): Promise<SpeechSynthesisResult>;
}

export interface SpeechRuntimeOptions {
  readonly transcription?: SpeechEndpointConfig;
  readonly synthesis?: SpeechSynthesisConfig;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxAudioBytes?: number;
  readonly maxSpeechTextCharacters?: number;
  readonly maxResponseBytes?: number;
  readonly defaultLanguage?: string;
}

export interface SpeechTranscriptionInput {
  readonly audio: Uint8Array;
  readonly filename: string;
  readonly contentType?: string;
  readonly language?: string;
  readonly prompt?: string;
  readonly signal?: AbortSignal;
}

export interface SpeechTranscriptionResult {
  readonly text: string;
  readonly model: string;
  readonly latencyMs: number;
}

export interface SpeechSynthesisInput {
  readonly text: string;
  readonly voice?: string;
  readonly responseFormat?: SpeechSynthesisConfig["responseFormat"];
  readonly instructions?: string;
  readonly signal?: AbortSignal;
}

export interface SpeechSynthesisResult {
  readonly audio: Uint8Array;
  readonly contentType: string;
  readonly format: NonNullable<SpeechSynthesisConfig["responseFormat"]>;
  readonly model: string;
  readonly latencyMs: number;
}

export type SpeechErrorCode =
  | "not_configured"
  | "invalid_configuration"
  | "invalid_audio"
  | "audio_too_large"
  | "text_too_large"
  | "timeout"
  | "cancelled"
  | "rate_limited"
  | "upstream_unavailable"
  | "upstream_rejected"
  | "invalid_response"
  | "response_too_large";

export class SpeechProviderError extends Error {
  readonly code: SpeechErrorCode;
  readonly retryable: boolean;
  readonly statusCode: number | undefined;

  constructor(
    code: SpeechErrorCode,
    message: string,
    options: { retryable?: boolean; statusCode?: number; cause?: unknown } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "SpeechProviderError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.statusCode = options.statusCode;
  }
}

const ALLOWED_AUDIO_TYPES = new Set([
  "audio/flac",
  "audio/mp4",
  "audio/m4a",
  "audio/mpeg",
  "audio/mpga",
  "audio/ogg",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
]);

const AUDIO_EXTENSION_TO_TYPE: Readonly<Record<string, string>> = {
  flac: "audio/flac",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  mpga: "audio/mpga",
  mp4: "audio/mp4",
  oga: "audio/ogg",
  ogg: "audio/ogg",
  wav: "audio/wav",
  webm: "audio/webm",
  mpeg: "audio/mpeg",
};

const FORMAT_CONTENT_TYPES: Readonly<
  Record<NonNullable<SpeechSynthesisConfig["responseFormat"]>, string>
> = {
  mp3: "audio/mpeg",
  opus: "audio/opus",
  aac: "audio/aac",
  flac: "audio/flac",
  wav: "audio/wav",
  pcm: "audio/pcm",
};

function boundedConfig(
  value: string | undefined,
  name: string,
  max: number,
): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (
    normalized.length > max ||
    normalized.includes("\0") ||
    /[\r\n]/.test(normalized)
  ) {
    throw new SpeechProviderError(
      "invalid_configuration",
      name + " has an invalid value.",
    );
  }
  return normalized;
}

function safeBaseUrl(
  value: string | undefined,
  name: string,
): string | undefined {
  const normalized = boundedConfig(value, name, 2048);
  if (!normalized) return undefined;
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new SpeechProviderError(
      "invalid_configuration",
      name + " must be an absolute URL.",
    );
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new SpeechProviderError(
      "invalid_configuration",
      name + " must use HTTPS (HTTP is allowed only for loopback development).",
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new SpeechProviderError(
      "invalid_configuration",
      name + " must not contain credentials, query parameters, or fragments.",
    );
  }
  return url.toString().replace(/\/+$/, "");
}

function endpoint(baseUrl: string, path: string): string {
  return baseUrl + (baseUrl.endsWith("/v1") ? "" : "/v1") + path;
}

function timeoutError(message: string, cause?: unknown): SpeechProviderError {
  return new SpeechProviderError("timeout", message, {
    retryable: true,
    ...(cause === undefined ? {} : { cause }),
  });
}

async function readBoundedBytes(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new SpeechProviderError(
      "response_too_large",
      "Speech service response exceeded the configured size limit.",
    );
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > maxBytes) {
        await reader
          .cancel("response size limit exceeded")
          .catch(() => undefined);
        throw new SpeechProviderError(
          "response_too_large",
          "Speech service response exceeded the configured size limit.",
        );
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function responseFailure(
  response: Response,
): Promise<SpeechProviderError> {
  if (response.status === 401 || response.status === 403) {
    return new SpeechProviderError(
      "upstream_rejected",
      "Speech service did not accept the configured credentials.",
      { statusCode: response.status },
    );
  }
  if (response.status === 429) {
    return new SpeechProviderError(
      "rate_limited",
      "Speech service rate-limited the request.",
      { retryable: true, statusCode: 429 },
    );
  }
  if (response.status === 408 || response.status >= 500) {
    return new SpeechProviderError(
      "upstream_unavailable",
      "Speech service is temporarily unavailable.",
      { retryable: true, statusCode: response.status },
    );
  }
  return new SpeechProviderError(
    "upstream_rejected",
    "Speech service rejected the request (HTTP " + response.status + ").",
    { statusCode: response.status },
  );
}

/**
 * Separate OpenAI-compatible transcription and speech endpoints. This deliberately
 * does not assume that an LLM chat provider also supports audio. A local Whisper/
 * Piper-compatible server can be used without a hosted speech API key.
 */
export class OpenAICompatibleSpeechRuntime implements SpeechRuntime {
  private readonly transcriptionBaseUrl: string | undefined;
  private readonly transcriptionApiKey: string | undefined;
  private readonly transcriptionModel: string | undefined;
  private readonly synthesisBaseUrl: string | undefined;
  private readonly synthesisApiKey: string | undefined;
  private readonly synthesisModel: string | undefined;
  private readonly synthesisVoice: string | undefined;
  private readonly synthesisFormat: NonNullable<
    SpeechSynthesisConfig["responseFormat"]
  >;
  private readonly synthesisInstructions: string | undefined;
  private readonly defaultLanguage: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxAudioBytes: number;
  private readonly maxSpeechTextCharacters: number;
  private readonly maxResponseBytes: number;

  constructor(options: SpeechRuntimeOptions = {}) {
    this.transcriptionBaseUrl = safeBaseUrl(
      options.transcription?.baseUrl,
      "STT base URL",
    );
    this.transcriptionApiKey = boundedConfig(
      options.transcription?.apiKey,
      "STT API key",
      4000,
    );
    this.transcriptionModel = boundedConfig(
      options.transcription?.model,
      "STT model",
      200,
    );
    this.synthesisBaseUrl = safeBaseUrl(
      options.synthesis?.baseUrl,
      "TTS base URL",
    );
    this.synthesisApiKey = boundedConfig(
      options.synthesis?.apiKey,
      "TTS API key",
      4000,
    );
    this.synthesisModel = boundedConfig(
      options.synthesis?.model,
      "TTS model",
      200,
    );
    this.synthesisVoice = boundedConfig(
      options.synthesis?.voice,
      "TTS voice",
      200,
    );
    this.synthesisFormat = options.synthesis?.responseFormat ?? "mp3";
    this.synthesisInstructions = boundedConfig(
      options.synthesis?.instructions,
      "TTS instructions",
      2000,
    );
    this.defaultLanguage = boundedConfig(
      options.defaultLanguage,
      "default transcription language",
      24,
    );
    if (
      this.defaultLanguage &&
      !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(this.defaultLanguage)
    ) {
      throw new Error(
        "Default speech transcription language must be a short language code such as en.",
      );
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxAudioBytes = options.maxAudioBytes ?? 25 * 1024 * 1024;
    this.maxSpeechTextCharacters = options.maxSpeechTextCharacters ?? 20_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 20 * 1024 * 1024;

    if (
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 1_000 ||
      this.timeoutMs > 180_000
    ) {
      throw new Error(
        "Speech request timeout must be between 1000 and 180000 ms.",
      );
    }
    if (
      !Number.isInteger(this.maxAudioBytes) ||
      this.maxAudioBytes < 1024 ||
      this.maxAudioBytes > 25 * 1024 * 1024
    ) {
      throw new Error(
        "Maximum audio upload size must be between 1024 bytes and 25 MiB.",
      );
    }
    if (
      !Number.isInteger(this.maxSpeechTextCharacters) ||
      this.maxSpeechTextCharacters < 1 ||
      this.maxSpeechTextCharacters > 100_000
    ) {
      throw new Error(
        "Maximum speech input text must be between 1 and 100000 characters.",
      );
    }
    if (
      !Number.isInteger(this.maxResponseBytes) ||
      this.maxResponseBytes < 1024 ||
      this.maxResponseBytes > 50 * 1024 * 1024
    ) {
      throw new Error(
        "Maximum speech response size must be between 1024 bytes and 50 MiB.",
      );
    }
  }

  static fromEnvironment(
    env: Environment = process.env,
    overrides: Partial<
      Pick<
        SpeechRuntimeOptions,
        | "fetchImpl"
        | "timeoutMs"
        | "maxAudioBytes"
        | "maxSpeechTextCharacters"
        | "maxResponseBytes"
      >
    > = {},
  ): OpenAICompatibleSpeechRuntime {
    return new OpenAICompatibleSpeechRuntime({
      transcription: {
        ...(env.KUROCHAN_STT_BASE_URL === undefined
          ? {}
          : { baseUrl: env.KUROCHAN_STT_BASE_URL }),
        ...(env.KUROCHAN_STT_API_KEY === undefined
          ? {}
          : { apiKey: env.KUROCHAN_STT_API_KEY }),
        ...(env.KUROCHAN_STT_MODEL === undefined
          ? {}
          : { model: env.KUROCHAN_STT_MODEL }),
      },
      synthesis: {
        ...(env.KUROCHAN_TTS_BASE_URL === undefined
          ? {}
          : { baseUrl: env.KUROCHAN_TTS_BASE_URL }),
        ...(env.KUROCHAN_TTS_API_KEY === undefined
          ? {}
          : { apiKey: env.KUROCHAN_TTS_API_KEY }),
        ...(env.KUROCHAN_TTS_MODEL === undefined
          ? {}
          : { model: env.KUROCHAN_TTS_MODEL }),
        ...(env.KUROCHAN_TTS_VOICE === undefined
          ? {}
          : { voice: env.KUROCHAN_TTS_VOICE }),
        responseFormat: parseSynthesisFormat(env.KUROCHAN_TTS_FORMAT) ?? "mp3",
        ...(env.KUROCHAN_TTS_INSTRUCTIONS === undefined
          ? {}
          : { instructions: env.KUROCHAN_TTS_INSTRUCTIONS }),
      },
      defaultLanguage: env.KUROCHAN_STT_LANGUAGE?.trim() || "en",
      ...overrides,
    });
  }

  get isTranscriptionConfigured(): boolean {
    return Boolean(this.transcriptionBaseUrl && this.transcriptionModel);
  }

  get isSynthesisConfigured(): boolean {
    return Boolean(this.synthesisBaseUrl && this.synthesisModel);
  }

  get status() {
    return {
      transcription: {
        enabled: this.isTranscriptionConfigured,
        provider: "OpenAI-compatible audio transcription",
        model: this.transcriptionModel ?? null,
        authenticationConfigured: Boolean(this.transcriptionApiKey),
        maxAudioBytes: this.maxAudioBytes,
        defaultLanguage: this.defaultLanguage ?? null,
      },
      synthesis: {
        enabled: this.isSynthesisConfigured,
        provider: "OpenAI-compatible text-to-speech",
        model: this.synthesisModel ?? null,
        voice: this.synthesisVoice ?? null,
        format: this.synthesisFormat,
        customInstructionsConfigured: Boolean(this.synthesisInstructions),
        authenticationConfigured: Boolean(this.synthesisApiKey),
        maxTextCharacters: this.maxSpeechTextCharacters,
        maxResponseBytes: this.maxResponseBytes,
      },
    };
  }

  async transcribe(
    input: SpeechTranscriptionInput,
  ): Promise<SpeechTranscriptionResult> {
    if (
      !this.isTranscriptionConfigured ||
      !this.transcriptionBaseUrl ||
      !this.transcriptionModel
    ) {
      throw new SpeechProviderError(
        "not_configured",
        "Configure KUROCHAN_STT_BASE_URL, KUROCHAN_STT_MODEL and, when required, KUROCHAN_STT_API_KEY.",
      );
    }
    if (!(input.audio instanceof Uint8Array) || input.audio.byteLength === 0) {
      throw new SpeechProviderError(
        "invalid_audio",
        "Audio upload is empty or invalid.",
      );
    }
    if (input.audio.byteLength > this.maxAudioBytes) {
      throw new SpeechProviderError(
        "audio_too_large",
        "Audio upload exceeds the configured size limit.",
      );
    }
    const filename = input.filename
      .replace(/[^A-Za-z0-9._-]/g, "_")
      .slice(0, 120);
    const extension = filename.split(".").at(-1)?.toLowerCase() ?? "";
    const inferredType = AUDIO_EXTENSION_TO_TYPE[extension];
    const contentType = (
      input.contentType?.split(";")[0]?.trim().toLowerCase() ||
      inferredType ||
      ""
    ).toLowerCase();
    if (contentType !== inferredType) {
      throw new SpeechProviderError(
        "invalid_audio",
        "The audio content type does not match its file extension.",
      );
    }
    if (
      !inferredType ||
      !contentType ||
      !ALLOWED_AUDIO_TYPES.has(contentType)
    ) {
      throw new SpeechProviderError(
        "invalid_audio",
        "Audio must use a supported extension and an accepted audio content type.",
      );
    }
    const language = input.language?.trim() || this.defaultLanguage;
    if (language && !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(language)) {
      throw new SpeechProviderError(
        "invalid_audio",
        "Language must be a valid short language code such as en or ja.",
      );
    }
    if (input.prompt && input.prompt.length > 4_000) {
      throw new SpeechProviderError(
        "invalid_audio",
        "Transcription prompt cannot exceed 4000 characters.",
      );
    }
    if (input.signal?.aborted)
      throw new SpeechProviderError(
        "cancelled",
        "Audio transcription was cancelled.",
        { retryable: false },
      );

    const form = new FormData();
    const copied = new Uint8Array(input.audio.byteLength);
    copied.set(input.audio);
    form.append(
      "file",
      new Blob([copied.buffer], { type: contentType }),
      filename,
    );
    form.append("model", this.transcriptionModel);
    form.append("response_format", "json");
    if (language) form.append("language", language);
    if (input.prompt?.trim()) form.append("prompt", input.prompt.trim());

    const startedAt = Date.now();
    const response = await this.request(
      endpoint(this.transcriptionBaseUrl, "/audio/transcriptions"),
      form,
      this.transcriptionApiKey,
      input.signal,
      "Audio transcription",
    );
    if (!response.ok) throw await responseFailure(response);
    const bytes = await readBoundedBytes(
      response,
      Math.min(this.maxResponseBytes, 2 * 1024 * 1024),
    );
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch (error) {
      throw new SpeechProviderError(
        "invalid_response",
        "Speech service returned invalid transcription JSON.",
        { cause: error },
      );
    }
    if (
      !json ||
      typeof json !== "object" ||
      !("text" in json) ||
      typeof (json as { text?: unknown }).text !== "string"
    ) {
      throw new SpeechProviderError(
        "invalid_response",
        "Speech service response did not contain transcription text.",
      );
    }
    const text = (json as { text: string }).text.trim();
    if (!text || text.length > 200_000)
      throw new SpeechProviderError(
        "invalid_response",
        "Speech service returned an empty or oversized transcript.",
      );
    return {
      text,
      model: this.transcriptionModel,
      latencyMs: Date.now() - startedAt,
    };
  }

  async synthesize(
    input: SpeechSynthesisInput,
  ): Promise<SpeechSynthesisResult> {
    if (
      !this.isSynthesisConfigured ||
      !this.synthesisBaseUrl ||
      !this.synthesisModel
    ) {
      throw new SpeechProviderError(
        "not_configured",
        "Configure KUROCHAN_TTS_BASE_URL, KUROCHAN_TTS_MODEL and, when required, KUROCHAN_TTS_API_KEY.",
      );
    }
    const text = input.text.trim();
    if (!text)
      throw new SpeechProviderError(
        "invalid_response",
        "Text for speech synthesis cannot be empty.",
      );
    if (text.length > this.maxSpeechTextCharacters)
      throw new SpeechProviderError(
        "text_too_large",
        "Text for speech synthesis exceeds the configured size limit.",
      );
    if (input.instructions && input.instructions.length > 2_000)
      throw new SpeechProviderError(
        "invalid_response",
        "Speech style instructions cannot exceed 2000 characters.",
      );
    if (input.signal?.aborted)
      throw new SpeechProviderError(
        "cancelled",
        "Speech synthesis was cancelled.",
        { retryable: false },
      );

    const voice =
      boundedConfig(input.voice, "TTS voice", 200) ?? this.synthesisVoice;
    const format = input.responseFormat ?? this.synthesisFormat;
    const body: Record<string, unknown> = {
      model: this.synthesisModel,
      input: text,
      response_format: format,
    };
    // Do not silently select a model-specific voice. A provider may have its
    // own default, or the operator can configure a voice after evaluation.
    if (voice) body.voice = voice;
    const instructions =
      input.instructions?.trim() || this.synthesisInstructions;
    if (instructions) body.instructions = instructions;
    const startedAt = Date.now();
    const response = await this.request(
      endpoint(this.synthesisBaseUrl, "/audio/speech"),
      JSON.stringify(body),
      this.synthesisApiKey,
      input.signal,
      "Speech synthesis",
      { "content-type": "application/json" },
    );
    if (!response.ok) throw await responseFailure(response);
    const audio = await readBoundedBytes(response, this.maxResponseBytes);
    if (!audio.byteLength)
      throw new SpeechProviderError(
        "invalid_response",
        "Speech service returned no audio data.",
      );
    const contentType =
      response.headers
        .get("content-type")
        ?.split(";")[0]
        ?.trim()
        .toLowerCase() || FORMAT_CONTENT_TYPES[format];
    if (
      !contentType.startsWith("audio/") &&
      contentType !== "application/octet-stream"
    ) {
      throw new SpeechProviderError(
        "invalid_response",
        "Speech service returned an unexpected content type.",
      );
    }
    return {
      audio,
      contentType,
      format,
      model: this.synthesisModel,
      latencyMs: Date.now() - startedAt,
    };
  }

  private async request(
    url: string,
    body: BodyInit,
    apiKey: string | undefined,
    signal: AbortSignal | undefined,
    operation: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const requestSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;
    try {
      const headers: Record<string, string> = { ...extraHeaders };
      if (apiKey) headers.authorization = "Bearer " + apiKey;
      return await this.fetchImpl(url, {
        method: "POST",
        headers,
        body,
        signal: requestSignal,
      });
    } catch (error) {
      if (signal?.aborted)
        throw new SpeechProviderError(
          "cancelled",
          operation + " was cancelled.",
          { cause: error },
        );
      if (timeoutSignal.aborted)
        throw timeoutError(operation + " exceeded its deadline.", error);
      throw new SpeechProviderError(
        "upstream_unavailable",
        operation + " service could not be reached.",
        { retryable: true, cause: error },
      );
    }
  }
}

function parseSynthesisFormat(
  value: string | undefined,
): SpeechSynthesisConfig["responseFormat"] {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "mp3" ||
    normalized === "opus" ||
    normalized === "aac" ||
    normalized === "flac" ||
    normalized === "wav" ||
    normalized === "pcm"
  )
    return normalized;
  return "mp3";
}
