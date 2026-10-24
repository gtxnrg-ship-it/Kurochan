export class ApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ApiError";
    this.status = options.status ?? 0;
    this.code = options.code ?? "request_failed";
    this.retryable = options.retryable ?? false;
    this.requestId = options.requestId;
  }
}

export function normalizeApiBaseUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) throw new TypeError("Enter the URL of your Kuro-chan API.");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError("Enter a complete API address, including http:// or https://.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("The API address must use HTTP or HTTPS.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError("The API address cannot contain credentials, a query, or a fragment.");
  }
  if (url.pathname.includes("..")) {
    throw new TypeError("The API address cannot contain parent-directory segments.");
  }
  return (url.origin + url.pathname.replace(/\/+$/, "")).replace(/\/$/, "");
}

export function parseSseEvent(block) {
  const event = { event: "message", data: "", id: undefined };
  const dataLines = [];
  for (const line of String(block).replace(/\r/g, "").split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event.event = value || "message";
    else if (field === "id" && !value.includes("\0")) event.id = value;
    else if (field === "data") dataLines.push(value);
  }
  event.data = dataLines.join("\n");
  return dataLines.length ? event : null;
}

export async function consumeSse(response, onEvent) {
  if (!response?.body?.getReader) {
    throw new ApiError("The server did not provide a readable event stream.", {
      code: "stream_unavailable",
      status: response?.status ?? 0,
      retryable: true,
    });
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let match;
      while ((match = /(?:\r\n|\n|\r){2}/.exec(buffer))) {
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const event = parseSseEvent(block);
        if (event) await onEvent(event);
      }
      if (done) break;
    }
    if (buffer.trim()) {
      const event = parseSseEvent(buffer);
      if (event) await onEvent(event);
    }
  } finally {
    reader.releaseLock();
  }
}

export class ApiClient {
  constructor({ getBaseUrl, getToken = () => "", fetchImpl = globalThis.fetch }) {
    if (typeof getBaseUrl !== "function") throw new TypeError("getBaseUrl is required.");
    if (typeof fetchImpl !== "function") throw new TypeError("fetch is not available in this environment.");
    this.getBaseUrl = getBaseUrl;
    this.getToken = getToken;
    this.fetchImpl = fetchImpl;
  }

  get baseUrl() {
    return normalizeApiBaseUrl(this.getBaseUrl());
  }

  async request(path, options = {}) {
    const headers = new Headers(options.headers ?? {});
    const token = String(this.getToken() ?? "").trim();
    if (token) headers.set("authorization", "Bearer " + token);
    if (options.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    headers.set("accept", "application/json");
    let response;
    try {
      response = await this.fetchImpl(this.baseUrl + path, {
        method: options.method ?? "GET",
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: options.signal,
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
      });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      throw new ApiError("Could not reach the Kuro-chan API. Check the address, network, and CORS settings.", {
        code: "api_unreachable",
        retryable: true,
      });
    }
    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { message: text.slice(0, 300) };
      }
    }
    if (!response.ok) throw apiErrorFromBody(response.status, body);
    return body;
  }

  async stream(path, options = {}) {
    const headers = new Headers(options.headers ?? {});
    const token = String(this.getToken() ?? "").trim();
    if (token) headers.set("authorization", "Bearer " + token);
    headers.set("accept", "text/event-stream");
    if (options.body !== undefined) headers.set("content-type", "application/json");
    let response;
    try {
      response = await this.fetchImpl(this.baseUrl + path, {
        method: options.method ?? "GET",
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: options.signal,
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
      });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      throw new ApiError("The live connection could not be opened. Check the API address and network.", {
        code: "stream_unavailable",
        retryable: true,
      });
    }
    if (!response.ok) {
      let body;
      try { body = await response.json(); } catch { body = null; }
      throw apiErrorFromBody(response.status, body);
    }
    return response;
  }

  authProviders(options) { return this.request("/auth/providers", options); }

  exchangeOAuthCode(code, options = {}) {
    return this.request("/auth/session/exchange", {
      ...options,
      method: "POST",
      body: { code: String(code ?? "").trim() },
    });
  }

  health(options) { return this.request("/healthz", options); }
  readiness(options) { return this.request("/readyz", options); }
  config(options) { return this.request("/v1/config", options); }
  speechStatus(options) { return this.request("/v1/speech/status", options); }
  workerStatus(options) { return this.request("/v1/worker/status", options); }
  workers(options) { return this.request("/v1/workers?staleAfterMs=30000", options); }
  routerStatus(options) { return this.request("/v1/omnirouter/status", options); }
  researchStatus(options) { return this.request("/v1/research/status", options); }
  mcpStatus({ probe = false, ...options } = {}) {
    return this.request("/v1/mcp/status?probe=" + (probe ? "true" : "false"), options);
  }
  communityMcpPresets(query = "", options = {}) {
    const params = new URLSearchParams({ limit: "100" });
    if (query.trim()) params.set("q", query.trim().slice(0, 200));
    return this.request("/v1/community-mcp-presets?" + params.toString(), options);
  }
  listConversations(options) { return this.request("/v1/conversations?limit=50&offset=0", options); }

  createConversation(title, options = {}) {
    return this.request("/v1/conversations", {
      ...options,
      method: "POST",
      body: title ? { title: String(title).slice(0, 160) } : {},
    });
  }

  conversation(id, options) {
    return this.request("/v1/conversations/" + encodeURIComponent(id) + "?messageLimit=100", options);
  }

  deleteConversation(id, options = {}) {
    return this.request("/v1/conversations/" + encodeURIComponent(id), {
      ...options,
      method: "DELETE",
    });
  }

  async streamChat(id, { content, model = "omni/balanced", clientMessageId, signal, onDelta }) {
    const response = await this.stream("/v1/conversations/" + encodeURIComponent(id) + "/messages", {
      method: "POST",
      signal,
      body: { content, model, clientMessageId, stream: true },
    });
    let providerError = null;
    await consumeSse(response, (event) => {
      if (event.data === "[DONE]") return;
      let payload;
      try { payload = JSON.parse(event.data); } catch { return; }
      if (payload?.error) {
        providerError = new ApiError(payload.error.message || "The response stream failed.", {
          status: response.status,
          code: payload.error.code || "stream_interrupted",
          retryable: payload.error.retryable ?? true,
          requestId: payload.error.requestId,
        });
        return;
      }
      const delta = payload?.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta) onDelta?.(delta);
    });
    if (providerError) throw providerError;
  }

  async voiceTurn(conversationId, formData, { signal } = {}) {
    if (!(formData instanceof FormData)) {
      throw new TypeError("voiceTurn expects a FormData payload.");
    }
    const headers = new Headers({ accept: "application/json" });
    const token = String(this.getToken() ?? "").trim();
    if (token) headers.set("authorization", "Bearer " + token);
    let response;
    try {
      response = await this.fetchImpl(
        this.baseUrl +
          "/v1/conversations/" +
          encodeURIComponent(conversationId) +
          "/voice-turn",
        {
          method: "POST",
          headers,
          body: formData,
          signal,
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
        },
      );
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      throw new ApiError(
        "The voice turn could not reach the Kuro-chan API.",
        { code: "voice_unavailable", retryable: true },
      );
    }
    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { message: text.slice(0, 300) };
      }
    }
    if (!response.ok) throw apiErrorFromBody(response.status, body);
    return body;
  }

  async conversationAudio(conversationId, messageId, { signal } = {}) {
    const headers = new Headers();
    const token = String(this.getToken() ?? "").trim();
    if (token) headers.set("authorization", "Bearer " + token);
    let response;
    try {
      response = await this.fetchImpl(
        this.baseUrl +
          "/v1/conversations/" +
          encodeURIComponent(conversationId) +
          "/audio/" +
          encodeURIComponent(messageId),
        {
          method: "GET",
          headers,
          signal,
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
        },
      );
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      throw new ApiError(
        "The saved audio reply could not be downloaded.",
        { code: "audio_unavailable", retryable: true },
      );
    }
    if (!response.ok) {
      let body;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      throw apiErrorFromBody(response.status, body);
    }
    return response.blob();
  }

  startRun(conversationId, goal, profile = "balanced", options = {}) {
    return this.request("/v1/conversations/" + encodeURIComponent(conversationId) + "/runs", {
      ...options,
      method: "POST",
      body: { goal, profile },
    });
  }

  listRuns(options) { return this.request("/v1/runs?limit=50", options); }
  run(id, options) { return this.request("/v1/runs/" + encodeURIComponent(id), options); }

  cancelRun(id, reason = "Cancelled from the Kuro-chan workbench", options = {}) {
    return this.request("/v1/runs/" + encodeURIComponent(id) + "/cancel", {
      ...options,
      method: "POST",
      body: { reason },
    });
  }

  listAgents(query = "", options = {}) {
    const params = new URLSearchParams({ limit: "30" });
    if (query.trim()) params.set("q", query.trim().slice(0, 200));
    return this.request("/v1/agents?" + params.toString(), options);
  }

  streamRunEvents(id, { afterId, signal, onEvent } = {}) {
    const params = new URLSearchParams();
    if (afterId !== undefined && afterId !== null) params.set("afterId", String(afterId));
    const suffix = params.size ? "?" + params.toString() : "";
    return this.stream("/v1/runs/" + encodeURIComponent(id) + "/events/stream" + suffix, {
      signal,
      headers: afterId === undefined || afterId === null ? {} : { "last-event-id": String(afterId) },
    }).then((response) => consumeSse(response, onEvent ?? (() => {})));
  }
}

function apiErrorFromBody(status, body) {
  const error = body?.error && typeof body.error === "object" ? body.error : {};
  const message = error.message || body?.message || "The API request failed.";
  return new ApiError(message, {
    status,
    code: error.code || "http_" + status,
    retryable: error.retryable ?? status >= 500,
    requestId: error.requestId,
  });
}
