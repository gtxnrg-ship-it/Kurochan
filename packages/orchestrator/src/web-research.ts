import { z } from "zod";
import type { Evidence } from "@kurochan/storage";

const API_ROOT = "https://api.search.brave.com/res/v1/llm/context";
const MAX_QUERY_LENGTH = 600;
const MAX_RESULTS = 12;
const DEFAULT_RESULTS = 8;
const MAX_CONTEXT_CHARACTERS = 42_000;
const MAX_SNIPPETS_PER_URL = 4;
const MAX_SNIPPET_CHARACTERS = 1_400;
const DEFAULT_TIMEOUT_MS = 15_000;

const SearchArgsSchema = z
  .object({
    query: z
      .string()
      .trim()
      .min(2)
      .max(MAX_QUERY_LENGTH)
      .refine(
        (value) => value.split(/\s+/).filter(Boolean).length <= 75,
        "query must contain at most 75 words",
      ),
    limit: z.number().int().min(1).max(MAX_RESULTS).default(DEFAULT_RESULTS),
    country: z
      .string()
      .trim()
      .regex(/^[a-z]{2}$/i)
      .optional(),
    searchLang: z
      .string()
      .trim()
      .regex(/^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/)
      .optional(),
    freshness: z.enum(["pd", "pw", "pm", "py"]).optional(),
  })
  .strict();

const BraveResponseSchema = z
  .object({
    grounding: z
      .object({
        generic: z
          .array(
            z
              .object({
                url: z.string().url(),
                title: z.string().optional(),
                snippets: z.array(z.string()).optional(),
              })
              .passthrough(),
          )
          .optional()
          .default([]),
      })
      .passthrough(),
    sources: z.record(z.unknown()).optional(),
  })
  .passthrough();

export type WebResearchToolCall = {
  readonly name: "web.search";
  readonly arguments: unknown;
};

export type WebResearchToolResult = {
  readonly name: "web.search";
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
  readonly evidence?: readonly Evidence[];
};

export interface WebResearchExecutor {
  readonly isConfigured: boolean;
  execute(
    call: WebResearchToolCall,
    signal?: AbortSignal,
  ): Promise<WebResearchToolResult>;
}

export interface WebResearchRuntimeOptions {
  readonly apiKey?: string;
  readonly country?: string;
  readonly searchLang?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

class WebResearchError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(
    code: string,
    message: string,
    retryable = false,
    options: { cause?: unknown } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "WebResearchError";
    this.code = code;
    this.retryable = retryable;
  }
}

function trustedSourceUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WebResearchError(
      "invalid_source_url",
      "Search provider returned an invalid source URL.",
    );
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password
  ) {
    throw new WebResearchError(
      "invalid_source_url",
      "Search provider returned a source URL with an unsupported scheme or credentials.",
    );
  }
  return url.toString();
}

function hostname(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return "unknown source";
  }
}

function sourceEvidence(url: string, title: string, snippet: string): Evidence {
  const description = snippet.trim().replace(/\s+/g, " ").slice(0, 1600);
  return {
    kind: "web_source",
    summary:
      (title.trim() || hostname(url)) + (description ? ": " + description : ""),
    uri: url,
    metadata: { hostname: hostname(url) },
  };
}

/**
 * Read-only web research using Brave's pre-extracted LLM Context API.
 * The key is server-side only; this runtime accepts no caller-controlled URLs,
 * never fetches arbitrary source pages, and caps both result count and text.
 */
export class WebResearchRuntime implements WebResearchExecutor {
  private readonly apiKey: string | undefined;
  private readonly country: string;
  private readonly searchLang: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: WebResearchRuntimeOptions = {}) {
    this.apiKey = options.apiKey?.trim() || undefined;
    const country = options.country?.trim() || "US";
    const searchLang = options.searchLang?.trim() || "en";
    if (!/^[a-z]{2}$/i.test(country)) {
      throw new Error(
        "Brave Search country must be a two-letter country code.",
      );
    }
    if (!/^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/.test(searchLang)) {
      throw new Error(
        "Brave Search language must be a supported language tag.",
      );
    }
    this.country = country.toUpperCase();
    this.searchLang = searchLang;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 1_000 ||
      this.timeoutMs > 30_000
    ) {
      throw new Error(
        "Web research timeout must be between 1000 and 30000 milliseconds.",
      );
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async execute(
    call: WebResearchToolCall,
    signal?: AbortSignal,
  ): Promise<WebResearchToolResult> {
    try {
      const args = SearchArgsSchema.parse(call.arguments);
      if (!this.apiKey) {
        throw new WebResearchError(
          "web_research_not_configured",
          "General web research is not configured. Add BRAVE_SEARCH_API_KEY to the server and worker environment.",
        );
      }
      if (signal?.aborted) {
        throw new WebResearchError(
          "cancelled",
          "Web research was cancelled.",
          true,
        );
      }

      const query = new URLSearchParams({
        q: args.query,
        country: args.country?.toUpperCase() ?? this.country,
        search_lang: args.searchLang ?? this.searchLang,
        count: String(args.limit),
        maximum_number_of_urls: String(args.limit),
        maximum_number_of_tokens: String(
          Math.min(16_384, Math.max(4_096, args.limit * 1_024)),
        ),
        maximum_number_of_tokens_per_url: "2048",
        maximum_number_of_snippets: String(Math.min(96, args.limit * 6)),
        maximum_number_of_snippets_per_url: "6",
        context_threshold_mode: "balanced",
        safesearch: "moderate",
        enable_source_metadata: "true",
      });
      if (args.freshness) query.set("freshness", args.freshness);

      const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
      const requestSignal = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal;
      let response: Response;
      try {
        response = await this.fetchImpl(API_ROOT + "?" + query.toString(), {
          method: "GET",
          headers: {
            Accept: "application/json",
            "X-Subscription-Token": this.apiKey,
          },
          signal: requestSignal,
        });
      } catch (error) {
        if (signal?.aborted)
          throw new WebResearchError(
            "cancelled",
            "Web research was cancelled.",
            true,
            { cause: error },
          );
        if (timeoutSignal.aborted)
          throw new WebResearchError(
            "web_research_timeout",
            "Brave Search exceeded the configured request deadline.",
            true,
            { cause: error },
          );
        throw new WebResearchError(
          "web_search_unavailable",
          "Brave Search could not be reached.",
          true,
          { cause: error },
        );
      }

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new WebResearchError(
            "web_search_auth_failed",
            "Brave Search rejected the configured API key or account permissions.",
          );
        }
        if (response.status === 429) {
          throw new WebResearchError(
            "web_search_rate_limited",
            "Brave Search rate-limited the request.",
            true,
          );
        }
        if (response.status >= 500) {
          throw new WebResearchError(
            "web_search_unavailable",
            "Brave Search returned a temporary service error.",
            true,
          );
        }
        throw new WebResearchError(
          "web_search_rejected",
          "Brave Search rejected the research request (HTTP " +
            response.status +
            ").",
        );
      }

      let payload: unknown;
      try {
        payload = (await response.json()) as unknown;
      } catch (error) {
        throw new WebResearchError(
          "invalid_web_search_response",
          "Brave Search returned invalid JSON.",
          true,
          { cause: error },
        );
      }
      const data = BraveResponseSchema.parse(payload);
      let remainingSnippetCharacters = MAX_CONTEXT_CHARACTERS;
      const items = data.grounding.generic
        .slice(0, args.limit)
        .flatMap((item) => {
          let url: string;
          try {
            url = trustedSourceUrl(item.url);
          } catch {
            return [];
          }
          const title = (item.title?.trim() || hostname(url)).slice(0, 500);
          const snippets = (item.snippets ?? [])
            .map((snippet) =>
              snippet.trim().slice(0, MAX_SNIPPET_CHARACTERS),
            )
            .filter(Boolean)
            .slice(0, MAX_SNIPPETS_PER_URL)
            .map((snippet) => {
              if (remainingSnippetCharacters <= 0) return "";
              const bounded = snippet.slice(0, remainingSnippetCharacters);
              remainingSnippetCharacters -= bounded.length;
              return bounded;
            })
            .filter(Boolean);
          const metadataValue = data.sources?.[item.url];
          const age =
            metadataValue &&
            typeof metadataValue === "object" &&
            "age" in metadataValue &&
            Array.isArray((metadataValue as { age?: unknown }).age)
              ? (metadataValue as { age: unknown[] }).age
                  .filter((value): value is string => typeof value === "string")
                  .slice(0, 4)
              : [];
          return [
            {
              url,
              title,
              hostname: hostname(url),
              snippets,
              ...(age.length ? { age } : {}),
            },
          ];
        });

      const evidence = items.map((item) =>
        sourceEvidence(item.url, item.title, item.snippets[0] ?? ""),
      );
      return {
        name: call.name,
        ok: true,
        result: {
          query: args.query,
          provider: "Brave Search LLM Context",
          items,
        },
        evidence,
      };
    } catch (error) {
      const typed = error as {
        code?: unknown;
        message?: unknown;
        retryable?: unknown;
      };
      const code =
        error instanceof z.ZodError
          ? "invalid_arguments"
          : typeof typed.code === "string"
            ? typed.code
            : signal?.aborted
              ? "cancelled"
              : "web_research_failed";
      const message =
        error instanceof z.ZodError
          ? "Web research arguments did not match the supported query schema."
          : typeof typed.message === "string"
            ? typed.message
            : "Web research failed.";
      return {
        name: call.name,
        ok: false,
        error: { code, message: message.slice(0, 1000) },
      };
    }
  }
}
