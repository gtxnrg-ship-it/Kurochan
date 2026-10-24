import { ApiClient, ApiError, normalizeApiBaseUrl } from "./api.mjs";
import { renderMarkdown } from "./markdown.mjs";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const API_BASE_KEY = "kurochan.apiBaseUrl.v1";
const API_TOKEN_KEY = "kurochan.apiToken.session.v1";
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const state = {
  view: "chat",
  apiBaseUrl: localStorage.getItem(API_BASE_KEY) || defaultApiBaseUrl(),
  apiToken: sessionStorage.getItem(API_TOKEN_KEY) || "",
  conversations: [],
  currentConversationId: null,
  currentConversation: null,
  messages: [],
  mediaRecorder: null,
  recordingStream: null,
  recordingChunks: [],
  recording: false,
  recordingError: "",
  voiceAudioUrls: new Map(),
  voiceAudioLoading: new Set(),
  runs: [],
  runDetails: new Map(),
  runStreams: new Map(),
  lastEventIds: new Map(),
  selectedRunId: null,
  selectedModel: "balanced",
  connected: false,
  authenticated: false,
  providers: [],
  worker: null,
  speech: null,
  router: null,
  agentQuery: "",
  agentResults: [],
  loading: false,
  sending: false,
  transientMessage: "",
  lastError: "",
};
const api = new ApiClient({
  getBaseUrl: () => state.apiBaseUrl,
  getToken: () => state.apiToken,
});

const viewMeta = {
  chat: { eyebrow: "YOUR SPACE", title: "A thought is enough to begin." },
  runs: {
    eyebrow: "COORDINATED WORK",
    title: "Progress you can actually see.",
  },
  agents: {
    eyebrow: "THE SPECIALIST LIBRARY",
    title: "The right minds for the work.",
  },
  system: {
    eyebrow: "UNDER THE HOOD",
    title: "A clear view of what is connected.",
  },
};

function defaultApiBaseUrl() {
  const hostname = location.hostname || "127.0.0.1";
  const local = ["localhost", "127.0.0.1", "::1"].includes(hostname);
  const scheme = location.protocol === "https:" ? "https:" : "http:";
  return scheme + "//" + (local ? "127.0.0.1" : hostname) + ":8787";
}

function escapeText(value) {
  return String(value ?? "");
}

function makeElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = escapeText(text);
  return element;
}

function setText(selector, text) {
  const element = $(selector);
  if (element) element.textContent = escapeText(text);
}

function setHidden(element, hidden) {
  if (element) element.hidden = hidden;
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "—";
  if (milliseconds < 1000) return Math.round(milliseconds) + " ms";
  if (milliseconds < 60_000) return (milliseconds / 1000).toFixed(1) + " s";
  return Math.floor(milliseconds / 60_000) + " min";
}

function prettyStatus(status) {
  return String(status || "unknown").replaceAll("_", " ");
}

function terminal(status) {
  return TERMINAL.has(status);
}

function errorMessage(error) {
  if (error instanceof ApiError) {
    if (error.code === "unauthorized")
      return "This API requires an access token. Open Connection settings to add it.";
    if (error.code === "no_provider_available")
      return "No model provider is ready yet. Configure a provider on the API server, then try again.";
    if (error.code === "api_unreachable") return error.message;
    return error.message;
  }
  return error instanceof Error
    ? error.message
    : "Something unexpected happened.";
}

function showToast(message, tone = "normal") {
  const region = $("#toast-region");
  const toast = makeElement(
    "div",
    "toast " +
      (tone === "error"
        ? "toast-error"
        : tone === "success"
          ? "toast-success"
          : ""),
  );
  toast.textContent = message;
  region.append(toast);
  requestAnimationFrame(() => toast.classList.add("is-visible"));
  window.setTimeout(() => {
    toast.classList.remove("is-visible");
    window.setTimeout(() => toast.remove(), 240);
  }, 3600);
}

function updateConnectionBadge(label, status) {
  const pill = $("#connection-pill");
  pill.replaceChildren();
  const dot = makeElement("span", "status-dot " + status);
  const text = makeElement("span", "", label);
  pill.append(dot, text);
  const sidebarDot = $("#sidebar-status-dot");
  sidebarDot.className = "status-dot " + status;
  setText("#sidebar-status-label", label);
  setText(
    "#sidebar-status-detail",
    status === "is-online"
      ? "API is reachable"
      : status === "is-warning"
        ? "Check connection settings"
        : "Connect your API",
  );
}

function updateInspector() {
  const readyProviders = state.providers.filter(
    (provider) => provider.configured,
  );
  setText(
    "#pulse-routing",
    readyProviders.length
      ? readyProviders.length +
          " provider" +
          (readyProviders.length === 1 ? "" : "s") +
          " ready"
      : state.authenticated
        ? "No provider ready"
        : "Not connected",
  );
  setText(
    "#pulse-routing-detail",
    readyProviders.length
      ? readyProviders
          .map((provider) => provider.name || provider.id)
          .join(" · ")
      : state.authenticated
        ? "Configure a model provider on the API server."
        : "Connect to your Kuro-chan API first.",
  );
  const worker = state.worker;
  setText(
    "#pulse-workers",
    worker
      ? worker.running
        ? "Running"
        : worker.enabled
          ? "Starting"
          : "Not enabled"
      : "—",
  );
  setText(
    "#pulse-workers-detail",
    worker
      ? worker.running
        ? "Concurrency " +
          worker.concurrency +
          " · " +
          (worker.workerId || "worker online")
        : "Enable a worker process to execute coordinated runs."
      : "Waiting for API connection.",
  );
  const speech = state.speech;
  const voiceEnabled = Boolean(speech?.voiceTurn?.enabled);
  setText(
    "#pulse-voice",
    speech ? (voiceEnabled ? "Configured" : "Not configured") : "Not checked",
  );
  setText(
    "#pulse-voice-detail",
    speech
      ? voiceEnabled
        ? "Recorded audio turns are available. Real-time duplex may still be unsupported."
        : "No working transcription + synthesis pair is configured yet."
      : "Voice provider status is not available until the API is connected.",
  );
  const active = state.runs.filter((run) => !terminal(run.status)).length;
  setText("#active-run-count", String(active));
}

async function refreshConnection({ quiet = true } = {}) {
  try {
    const health = await api.health();
    state.connected = Boolean(health?.ok);
    if (!state.connected)
      throw new Error("The API responded, but health check did not pass.");
    try {
      const config = await api.config();
      state.authenticated = true;
      state.providers = Array.isArray(config?.providers)
        ? config.providers
        : [];
      updateConnectionBadge("Connected", "is-online");
    } catch (error) {
      if (error?.status === 401 || error?.code === "unauthorized") {
        state.authenticated = false;
        updateConnectionBadge("Token needed", "is-warning");
      } else {
        state.authenticated = false;
        updateConnectionBadge("API reachable", "is-warning");
        if (!quiet) throw error;
      }
    }
    if (state.authenticated) {
      const [worker, speech, router] = await Promise.allSettled([
        api.workerStatus(),
        api.speechStatus(),
        api.routerStatus(),
      ]);
      state.worker = worker.status === "fulfilled" ? worker.value : null;
      state.speech = speech.status === "fulfilled" ? speech.value : null;
      state.router = router.status === "fulfilled" ? router.value : null;
      updateInspector();
    }
    return true;
  } catch (error) {
    state.connected = false;
    state.authenticated = false;
    state.providers = [];
    state.worker = null;
    state.speech = null;
    state.router = null;
    updateConnectionBadge("Offline", "is-offline");
    updateInspector();
    if (!quiet) throw error;
    return false;
  }
}

function setView(view) {
  if (!viewMeta[view]) return;
  state.view = view;
  const meta = viewMeta[view];
  setText("#view-eyebrow", meta.eyebrow);
  setText("#view-title", meta.title);
  $$(".nav-item").forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  $("#sidebar").classList.remove("is-open");
  $("#sidebar-scrim").classList.remove("is-visible");
  renderView();
}

function renderView() {
  const workspace = $("#workspace");
  workspace.replaceChildren();
  if (state.view === "chat") renderChatView(workspace);
  else if (state.view === "runs") renderRunsView(workspace);
  else if (state.view === "agents") renderAgentsView(workspace);
  else renderSystemView(workspace);
}

function renderChatView(workspace) {
  const shell = makeElement("div", "chat-view");
  const scroll = makeElement("div", "chat-scroll");
  scroll.id = "chat-scroll";
  const list = makeElement("div", "message-list");
  list.id = "message-list";
  list.setAttribute("role", "log");
  list.setAttribute("aria-live", "polite");
  list.setAttribute("aria-relevant", "additions text");
  if (!state.messages.length) {
    const welcome = makeElement("div", "welcome-block");
    const badge = makeElement("div", "welcome-mark");
    badge.innerHTML =
      '<svg viewBox="0 0 44 44" aria-hidden="true"><rect x="2" y="2" width="40" height="40" rx="14" fill="currentColor"/><path d="M13 12v20m0-9 11-10m-8 8 12 11" fill="none" stroke="#f4f1e9" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="32" cy="12" r="3" fill="#d87952"/></svg>';
    const greeting = makeElement(
      "div",
      "welcome-kicker",
      "A CLEARER WAY TO GET THERE",
    );
    const title = makeElement("h2", "welcome-title");
    title.append(
      "Start with the idea. ",
      makeElement("span", "", "We'll find the shape."),
    );
    const copy = makeElement(
      "p",
      "welcome-copy",
      "You don't need the perfect prompt. Say what you're trying to do, what you already know, or where you're stuck.",
    );
    const suggestions = makeElement("div", "suggestion-grid");
    [
      [
        "Make my idea clearer",
        "I have a rough idea but I’m not sure how to explain it. Help me clarify the goal, then suggest the simplest next step.",
      ],
      [
        "Research before I decide",
        "Research this question carefully, compare the strongest options, and explain your recommendation in plain language.",
      ],
      [
        "Build something real",
        "Help me turn this goal into a practical plan. Break down the work, choose useful specialists, and tell me how we will verify the result.",
      ],
    ].forEach(([titleText, prompt]) => {
      const button = makeElement("button", "suggestion-card");
      button.type = "button";
      button.dataset.prompt = prompt;
      const heading = makeElement("strong", "", titleText);
      const description = makeElement("span", "", prompt);
      button.append(heading, description);
      suggestions.append(button);
    });
    welcome.append(badge, greeting, title, copy, suggestions);
    scroll.append(welcome);
  }
  state.messages.forEach((message) => list.append(renderMessage(message)));
  if (state.transientMessage) {
    const transient = makeElement(
      "div",
      "stream-error",
      state.transientMessage,
    );
    list.append(transient);
  }
  if (state.sending) {
    const status = makeElement("div", "typing-status");
    status.append(
      makeElement("span", "typing-dots", "•••"),
      makeElement("span", "", "Kuro-chan is thinking"),
    );
    list.append(status);
  }
  if (state.messages.length || state.sending || state.transientMessage)
    scroll.append(list);
  shell.append(scroll);
  const compose = makeElement("form", "composer");
  compose.id = "message-form";
  const composeBox = makeElement("div", "composer-box");
  const textarea = makeElement("textarea", "composer-input");
  textarea.id = "message-input";
  textarea.name = "message";
  textarea.rows = 1;
  textarea.maxLength = 200000;
  textarea.placeholder = state.currentConversation
    ? "Continue the thought…"
    : "Tell Kuro-chan what you have in mind…";
  textarea.setAttribute("aria-label", "Message Kuro-chan");
  textarea.required = true;
  textarea.disabled = state.sending || state.recording || !state.authenticated;
  const toolbar = makeElement("div", "composer-toolbar");
  const hint = makeElement(
    "span",
    "composer-hint",
    "↵ send · shift + ↵ new line",
  );
  const actions = makeElement("div", "composer-actions");
  const runButton = makeElement("button", "button button-run");
  runButton.type = "button";
  runButton.id = "start-run";
  runButton.disabled = state.sending || state.recording || !state.authenticated;
  runButton.append(
    makeElement("span", "button-icon", "✳"),
    makeElement("span", "", "Build with agents"),
  );
  const voiceButton = makeElement("button", "button button-voice");
  voiceButton.type = "button";
  voiceButton.id = "voice-turn";
  const recordingSupported =
    typeof MediaRecorder !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia);
  voiceButton.disabled =
    !state.authenticated ||
    state.sending ||
    (!state.recording && !recordingSupported);
  voiceButton.title = !recordingSupported
    ? "Microphone recording requires a supported browser and secure context."
    : !state.speech?.voiceTurn?.enabled && !state.recording
      ? "Configure speech-to-text and text-to-speech on the API server."
      : "Record a voice turn and receive an audio reply.";
  voiceButton.setAttribute(
    "aria-label",
    state.recording
      ? "Stop recording and send voice turn"
      : "Record a voice turn",
  );
  voiceButton.append(
    makeElement("span", "button-icon", state.recording ? "■" : "♫"),
    makeElement("span", "", state.recording ? "Stop & send" : "Voice turn"),
  );
  const sendButton = makeElement("button", "button button-send");
  sendButton.type = "submit";
  sendButton.id = "send-message";
  sendButton.disabled =
    state.sending || state.recording || !state.authenticated;
  sendButton.append(
    makeElement("span", "", state.sending ? "Sending…" : "Send"),
    makeElement("span", "send-arrow", "↗"),
  );
  actions.append(runButton, voiceButton, sendButton);
  toolbar.append(hint, actions);
  composeBox.append(textarea, toolbar);
  compose.append(
    composeBox,
    makeElement(
      "p",
      "composer-footnote",
      state.authenticated
        ? "Your provider credentials stay on the server. Replies are streamed as they arrive."
        : "Connect your Kuro-chan API to start chatting.",
    ),
  );
  shell.append(compose);
  workspace.append(shell);
  textarea.addEventListener("input", resizeTextarea);
  compose.addEventListener("submit", (event) => {
    event.preventDefault();
    void sendMessage();
  });
  runButton.addEventListener("click", () => void startCoordinatedRun());
  voiceButton.addEventListener("click", () => {
    if (state.recording) stopVoiceRecording();
    else void startVoiceRecording();
  });
  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void sendMessage();
    }
  });
  const input = $("#message-input");
  if (state.transientMessage && input)
    input.setAttribute("aria-describedby", "stream-error");
  scroll.scrollTop = scroll.scrollHeight;
}

function renderMessage(message) {
  const role = message.role === "user" ? "user" : "assistant";
  const row = makeElement("article", "message-row message-" + role);
  row.dataset.sequence = String(message.sequence ?? "");
  row.dataset.messageId = String(message.id ?? "");
  const avatar = makeElement(
    "div",
    "message-avatar",
    role === "user" ? "Y" : "k",
  );
  const contentWrap = makeElement("div", "message-content");
  const meta = makeElement("div", "message-meta");
  meta.append(makeElement("strong", "", role === "user" ? "You" : "Kuro-chan"));
  if (message.createdAt)
    meta.append(makeElement("time", "", formatDate(message.createdAt)));
  const content = makeElement("div", "message-text");
  if (role === "assistant") renderMarkdown(content, message.content);
  else content.textContent = escapeText(message.content);
  contentWrap.append(meta, content);
  const kind = message.metadata?.kind;
  if (kind === "run_started" && message.runId) {
    const link = makeElement("button", "inline-run-link", "Open task run ↗");
    link.type = "button";
    link.addEventListener("click", () => {
      state.selectedRunId = message.runId;
      setView("runs");
      void refreshRun(message.runId);
    });
    contentWrap.append(link);
  }
  if (message.metadata?.kind === "run_clarification") {
    const badge = makeElement("span", "message-note", "Clarification");
    contentWrap.append(badge);
  }
  if (role === "assistant" && kind === "voice_response" && message.id) {
    const key = voiceAudioKey(state.currentConversationId, message.id);
    const audioActions = makeElement("div", "voice-audio-actions");
    const playButton = makeElement(
      "button",
      "voice-audio-button",
      state.voiceAudioLoading.has(key)
        ? "Loading audio…"
        : state.voiceAudioUrls.has(key)
          ? "Reload audio"
          : "Load audio reply",
    );
    playButton.type = "button";
    playButton.disabled = state.voiceAudioLoading.has(key);
    playButton.addEventListener(
      "click",
      () => void loadVoiceAudio(state.currentConversationId, message.id),
    );
    audioActions.append(playButton);
    const audioUrl = state.voiceAudioUrls.get(key);
    if (audioUrl) {
      const audio = makeElement("audio", "voice-audio");
      audio.controls = true;
      audio.preload = "metadata";
      audio.src = audioUrl;
      audio.setAttribute("aria-label", "Audio reply from Kuro-chan");
      audioActions.append(audio);
    }
    contentWrap.append(audioActions);
  }
  row.append(avatar, contentWrap);
  return row;
}

function resizeTextarea() {
  const textarea = $("#message-input");
  if (!textarea) return;
  textarea.style.height = "auto";
  textarea.style.height = Math.min(textarea.scrollHeight, 180) + "px";
}

async function ensureConversation(firstMessage) {
  if (state.currentConversationId) return state.currentConversationId;
  const title =
    String(firstMessage).replace(/\s+/g, " ").trim().slice(0, 64) ||
    "New conversation";
  const result = await api.createConversation(title);
  state.currentConversation = result.conversation;
  state.currentConversationId = result.conversation.id;
  state.messages = [];
  await refreshConversations({ preserveSelection: true });
  return state.currentConversationId;
}

async function sendMessage() {
  const textarea = $("#message-input");
  const content = textarea?.value.trim();
  if (!content || state.sending) return;
  if (!state.authenticated) {
    showToast(
      "Connect to the Kuro-chan API before sending a message.",
      "error",
    );
    openSettings();
    return;
  }
  state.sending = true;
  state.transientMessage = "";
  let conversationId;
  let draftAssistant = { role: "assistant", content: "", temporary: true };
  try {
    conversationId = await ensureConversation(content);
    const userDraft = {
      role: "user",
      content,
      temporary: true,
      createdAt: new Date().toISOString(),
    };
    state.messages = [...state.messages, userDraft, draftAssistant];
    renderView();
    const input = $("#message-input");
    if (input) input.value = "";
    const model = "omni/" + state.selectedModel;
    const clientMessageId = makeId();
    await api.streamChat(conversationId, {
      content,
      model,
      clientMessageId,
      onDelta: (delta) => {
        draftAssistant.content += delta;
        const bubble = $(
          "#message-list .message-row:last-of-type .message-text",
        );
        if (bubble) bubble.textContent = draftAssistant.content;
        const scroll = $("#chat-scroll");
        if (scroll) scroll.scrollTop = scroll.scrollHeight;
      },
    });
    await loadConversation(conversationId);
  } catch (error) {
    state.transientMessage = errorMessage(error);
    showToast(state.transientMessage, "error");
    if (conversationId) {
      try {
        await loadConversation(conversationId);
      } catch {
        /* keep the visible error */
      }
    }
  } finally {
    state.sending = false;
    renderView();
    void refreshConversations({ preserveSelection: true });
  }
}

function makeId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return "message-" + Date.now() + "-" + Math.random().toString(36).slice(2);
}

function voiceAudioKey(conversationId, messageId) {
  return String(conversationId) + ":" + String(messageId);
}

function stopRecordingTracks() {
  for (const track of state.recordingStream?.getTracks?.() ?? []) {
    track.stop();
  }
  state.recordingStream = null;
}

function chooseRecordingType() {
  const candidates = [
    {
      mimeType: "audio/webm;codecs=opus",
      contentType: "audio/webm",
      extension: "webm",
    },
    { mimeType: "audio/webm", contentType: "audio/webm", extension: "webm" },
    {
      mimeType: "audio/ogg;codecs=opus",
      contentType: "audio/ogg",
      extension: "ogg",
    },
    { mimeType: "audio/mp4", contentType: "audio/mp4", extension: "m4a" },
  ];
  const candidate = candidates.find(
    (entry) =>
      typeof MediaRecorder.isTypeSupported !== "function" ||
      MediaRecorder.isTypeSupported(entry.mimeType),
  );
  return candidate ?? null;
}

async function startVoiceRecording() {
  if (!state.authenticated || state.sending || state.recording) return;
  if (
    !navigator.mediaDevices?.getUserMedia ||
    typeof MediaRecorder === "undefined"
  ) {
    showToast(
      "This browser cannot record audio. Open Kuro-chan over HTTPS on your phone, or use a supported browser.",
      "error",
    );
    return;
  }
  if (!state.speech?.voiceTurn?.enabled) {
    showToast(
      "Voice turns need both speech-to-text and text-to-speech configured on the API server.",
      "error",
    );
    setView("system");
    return;
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    const preferred = chooseRecordingType();
    const recorder = preferred
      ? new MediaRecorder(stream, { mimeType: preferred.mimeType })
      : new MediaRecorder(stream);
    const actualType = (recorder.mimeType || preferred?.mimeType || "")
      .split(";")[0]
      .toLowerCase();
    const details = {
      "audio/webm": { extension: "webm", contentType: "audio/webm" },
      "audio/ogg": { extension: "ogg", contentType: "audio/ogg" },
      "audio/mp4": { extension: "m4a", contentType: "audio/mp4" },
      "audio/m4a": { extension: "m4a", contentType: "audio/mp4" },
    }[actualType];
    if (!details) {
      stream.getTracks().forEach((track) => track.stop());
      showToast(
        "This browser's recording format is not supported by the configured speech adapter.",
        "error",
      );
      return;
    }
    state.recordingStream = stream;
    state.recordingChunks = [];
    state.recordingError = "";
    state.mediaRecorder = recorder;
    state.recording = true;
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data?.size) state.recordingChunks.push(event.data);
    });
    recorder.addEventListener("error", () => {
      state.recordingError =
        "The microphone recording failed. Check browser microphone permission and try again.";
      if (recorder.state !== "inactive") recorder.stop();
    });
    recorder.addEventListener("stop", () => {
      const recorded = state.recordingChunks.slice();
      state.recordingChunks = [];
      state.mediaRecorder = null;
      state.recording = false;
      stopRecordingTracks();
      if (state.recordingError) {
        const error = state.recordingError;
        state.recordingError = "";
        showToast(error, "error");
        renderView();
        return;
      }
      const blob = new Blob(recorded, { type: details.contentType });
      if (!blob.size) {
        showToast(
          "No audio was captured. Try again and speak after recording starts.",
          "error",
        );
        renderView();
        return;
      }
      if (blob.size > 24 * 1024 * 1024) {
        showToast(
          "That recording is too large. Please record a shorter voice message.",
          "error",
        );
        renderView();
        return;
      }
      void submitVoiceTurn(blob, details);
    });
    recorder.start(500);
    renderView();
    showToast("Listening. Tap Stop & send when you finish.", "success");
  } catch (error) {
    if (stream) stream.getTracks().forEach((track) => track.stop());
    state.recording = false;
    state.mediaRecorder = null;
    state.recordingStream = null;
    renderView();
    const name = error?.name;
    showToast(
      name === "NotAllowedError" || name === "PermissionDeniedError"
        ? "Microphone access was denied. Allow microphone permission for this site and try again."
        : name === "NotFoundError"
          ? "No microphone was found on this device."
          : "Could not start recording. Use HTTPS on a phone and check microphone permissions.",
      "error",
    );
  }
}

function stopVoiceRecording() {
  const recorder = state.mediaRecorder;
  if (!recorder || recorder.state === "inactive") return;
  try {
    recorder.stop();
  } catch {
    state.recording = false;
    state.mediaRecorder = null;
    stopRecordingTracks();
    renderView();
    showToast(
      "The recording could not be stopped cleanly. Please try again.",
      "error",
    );
  }
}

async function submitVoiceTurn(blob, details) {
  state.sending = true;
  state.transientMessage = "";
  renderView();
  let conversationId;
  try {
    conversationId = await ensureConversation("Voice conversation");
    const form = new FormData();
    form.append("file", blob, "kurochan-recording." + details.extension);
    form.append("clientMessageId", makeId());
    form.append("model", "omni/" + state.selectedModel);
    const language = state.speech?.transcription?.defaultLanguage;
    if (typeof language === "string" && language.trim()) {
      form.append("language", language.trim());
    }
    const result = await api.voiceTurn(conversationId, form);
    await loadConversation(conversationId);
    if (result.audio?.messageId) {
      await loadVoiceAudio(conversationId, result.audio.messageId, {
        autoplay: true,
      });
    }
    const heardText = result.transcript?.text || result.userMessage?.content;
    if (heardText) {
      showToast("Heard: " + heardText.slice(0, 150), "success");
    } else {
      showToast("Voice reply is ready.", "success");
    }
  } catch (error) {
    state.transientMessage = errorMessage(error);
    showToast(state.transientMessage, "error");
    if (conversationId) {
      try {
        await loadConversation(conversationId);
      } catch {
        /* keep the visible error */
      }
    }
  } finally {
    state.sending = false;
    renderView();
    void refreshConversations({ preserveSelection: true });
  }
}

async function loadVoiceAudio(
  conversationId,
  messageId,
  { autoplay = false } = {},
) {
  if (!conversationId || !messageId) return;
  const key = voiceAudioKey(conversationId, messageId);
  const currentUrl = state.voiceAudioUrls.get(key);
  if (currentUrl) {
    const row = $(".message-row").find(
      (element) => element.dataset.messageId === String(messageId),
    );
    const audio = row?.querySelector("audio");
    if (autoplay && audio) {
      try {
        await audio.play();
      } catch {
        showToast("Audio is ready. Tap Play to hear the reply.");
      }
    }
    return;
  }
  if (state.voiceAudioLoading.has(key)) return;
  state.voiceAudioLoading.add(key);
  if (state.view === "chat") renderView();
  try {
    const blob = await api.conversationAudio(conversationId, messageId);
    const url = URL.createObjectURL(blob);
    state.voiceAudioUrls.set(key, url);
    if (state.view === "chat") renderView();
    const row = $(".message-row").find(
      (element) => element.dataset.messageId === String(messageId),
    );
    const audio = row?.querySelector("audio");
    if (autoplay && audio) {
      try {
        await audio.play();
      } catch {
        showToast("Audio is ready. Tap Play to hear the reply.");
      }
    }
  } catch (error) {
    showToast(errorMessage(error), "error");
  } finally {
    state.voiceAudioLoading.delete(key);
    if (state.view === "chat") renderView();
  }
}

async function startCoordinatedRun() {
  const textarea = $("#message-input");
  const goal = textarea?.value.trim();
  if (!goal || state.sending) {
    if (!goal) {
      textarea?.focus();
      showToast("Describe what you want to accomplish first.");
    }
    return;
  }
  if (!state.authenticated) {
    openSettings();
    showToast("Connect to the API before starting a run.", "error");
    return;
  }
  state.sending = true;
  state.transientMessage = "";
  renderView();
  let conversationId;
  try {
    conversationId = await ensureConversation(goal);
    const result = await api.startRun(
      conversationId,
      goal,
      state.selectedModel,
    );
    if (result.status === "clarification_required" || result.clarification) {
      const question =
        result.clarification?.question ||
        result.clarification?.intent ||
        "Could you clarify the outcome you want?";
      await loadConversation(conversationId);
      state.transientMessage =
        "One quick clarification will help Kuro-chan plan this properly: " +
        question;
      showToast("One clarification needed before planning.", "normal");
      state.view = "chat";
      renderView();
      return;
    }
    if (!result.run?.id) throw new Error("The API did not return a run ID.");
    if (textarea) textarea.value = "";
    state.selectedRunId = result.run.id;
    state.runDetails.set(result.run.id, {
      run: result.run,
      tasks: result.tasks || [],
      events: result.events || [],
      plan: result.plan,
    });
    await loadConversation(conversationId);
    await loadRuns();
    connectRunStream(result.run.id);
    setView("runs");
    showToast("Coordinated run started.", "success");
  } catch (error) {
    state.transientMessage = errorMessage(error);
    showToast(state.transientMessage, "error");
    renderView();
  } finally {
    state.sending = false;
    if (state.view === "chat") renderView();
  }
}

async function refreshConversations({ preserveSelection = true } = {}) {
  if (!state.authenticated) {
    state.conversations = [];
    renderConversationList();
    return;
  }
  try {
    const response = await api.listConversations();
    state.conversations = Array.isArray(response?.data) ? response.data : [];
    renderConversationList();
    if (
      !preserveSelection &&
      !state.conversations.some(
        (item) => item.id === state.currentConversationId,
      )
    ) {
      state.currentConversationId = null;
      state.currentConversation = null;
      state.messages = [];
    }
  } catch (error) {
    renderConversationList(errorMessage(error));
  }
}

function renderConversationList(error) {
  const list = $("#conversation-list");
  list.replaceChildren();
  if (error) {
    list.append(makeElement("div", "sidebar-empty", error));
    return;
  }
  if (!state.conversations.length) {
    list.append(
      makeElement(
        "div",
        "sidebar-empty",
        state.authenticated
          ? "Your conversations will appear here."
          : "Connect your API to load conversations.",
      ),
    );
    return;
  }
  state.conversations.forEach((conversation) => {
    const button = makeElement(
      "button",
      "conversation-item" +
        (conversation.id === state.currentConversationId ? " is-selected" : ""),
    );
    button.type = "button";
    button.setAttribute("role", "listitem");
    button.addEventListener(
      "click",
      () => void loadConversation(conversation.id),
    );
    const title = makeElement(
      "span",
      "conversation-title",
      conversation.title || "Untitled conversation",
    );
    const date = makeElement(
      "span",
      "conversation-date",
      formatDate(conversation.updatedAt || conversation.createdAt),
    );
    button.append(title, date);
    list.append(button);
  });
}

async function newConversation() {
  state.currentConversationId = null;
  state.currentConversation = null;
  state.messages = [];
  state.transientMessage = "";
  setView("chat");
  $("#message-input")?.focus();
  renderConversationList();
}

async function loadConversation(id) {
  if (!state.authenticated) return;
  try {
    const response = await api.conversation(id);
    state.currentConversationId = id;
    state.currentConversation = response.conversation;
    state.messages = Array.isArray(response.messages) ? response.messages : [];
    state.transientMessage = "";
    renderConversationList();
    if (state.view !== "chat") setView("chat");
    else renderView();
    const scroll = $("#chat-scroll");
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  } catch (error) {
    showToast(errorMessage(error), "error");
  }
}

async function loadRuns() {
  if (!state.authenticated) {
    state.runs = [];
    updateInspector();
    return;
  }
  try {
    const response = await api.listRuns();
    state.runs = Array.isArray(response?.data) ? response.data : [];
    updateInspector();
    if (state.view === "runs") renderView();
  } catch (error) {
    showToast(errorMessage(error), "error");
  }
}

async function refreshRun(id, { quiet = true } = {}) {
  if (!state.authenticated || !id) return null;
  try {
    const response = await api.run(id);
    state.runDetails.set(id, {
      ...(state.runDetails.get(id) || {}),
      run: response.run,
      tasks: response.tasks || [],
      events: response.events || [],
    });
    const index = state.runs.findIndex((run) => run.id === id);
    if (index >= 0) state.runs[index] = response.run;
    else state.runs.unshift(response.run);
    updateInspector();
    if (state.view === "runs") renderView();
    return response;
  } catch (error) {
    if (!quiet) showToast(errorMessage(error), "error");
    return null;
  }
}

function connectRunStream(id) {
  if (!id || state.runStreams.has(id) || !state.authenticated) return;
  const controller = new AbortController();
  state.runStreams.set(id, controller);
  void (async () => {
    try {
      let finished = false;
      while (!controller.signal.aborted && !finished) {
        try {
          await api.streamRunEvents(id, {
            afterId: state.lastEventIds.get(id),
            signal: controller.signal,
            onEvent: async (event) => {
              if (event.id !== undefined && /^\d+$/.test(event.id)) {
                state.lastEventIds.set(id, Number(event.id));
              }
              if (event.event === "stream.end") finished = true;
              if (event.data) {
                try {
                  const payload = JSON.parse(event.data);
                  if (payload?.status && terminal(payload.status))
                    finished = true;
                } catch {
                  /* custom events may carry plain text */
                }
              }
              await refreshRun(id);
              if (state.view !== "runs" && event.event !== "message") {
                setText(
                  "#pulse-workers-detail",
                  "Latest run event: " + event.event.replaceAll(".", " "),
                );
              }
            },
          });
          await refreshRun(id);
          const run = state.runDetails.get(id)?.run;
          if (terminal(run?.status)) finished = true;
        } catch (error) {
          if (controller.signal.aborted) break;
          if (!quietStreamError(error))
            showToast("Live run updates paused. Reconnecting…", "normal");
        }
        if (!finished && !controller.signal.aborted)
          await wait(1800, controller.signal);
      }
    } finally {
      state.runStreams.delete(id);
      if (state.authenticated) {
        const detail = state.runDetails.get(id);
        if (
          detail &&
          !terminal(detail.run?.status) &&
          !controller.signal.aborted
        ) {
          window.setTimeout(() => connectRunStream(id), 1200);
        }
      }
    }
  })();
}

function quietStreamError(error) {
  return (
    error?.status === 401 ||
    error?.code === "run_not_found" ||
    error?.name === "AbortError"
  );
}

function wait(milliseconds, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = window.setTimeout(done, milliseconds);
    function done() {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function stopAllRunStreams() {
  for (const controller of state.runStreams.values()) controller.abort();
  state.runStreams.clear();
}

function renderRunsView(workspace) {
  const page = makeElement("div", "page-view runs-page");
  const intro = makeElement("div", "page-intro");
  intro.append(
    makeElement("span", "section-kicker", "FROM IDEA TO OUTCOME"),
    makeElement("h2", "", "Real work. Visible progress."),
    makeElement(
      "p",
      "",
      "Each run has a plan, assigned specialists, status, evidence, and a clear finish line. Nothing is marked complete just because it sounds plausible.",
    ),
  );
  const toolbar = makeElement("div", "page-toolbar");
  toolbar.append(
    makeElement(
      "span",
      "subtle-label",
      state.runs.length + " saved run" + (state.runs.length === 1 ? "" : "s"),
    ),
  );
  const refresh = makeElement(
    "button",
    "button button-subtle button-small",
    "Refresh",
  );
  refresh.type = "button";
  refresh.addEventListener("click", () => void loadRuns());
  toolbar.append(refresh);
  const layout = makeElement("div", "runs-layout");
  const runList = makeElement("div", "run-list");
  runList.id = "run-list";
  if (!state.runs.length) {
    const empty = makeElement("div", "empty-card");
    empty.append(
      makeElement("span", "empty-icon", "↗"),
      makeElement("strong", "", "No task runs yet"),
      makeElement(
        "p",
        "",
        "Start a coordinated run from Chat when your goal needs multiple steps, research, or verification.",
      ),
    );
    const start = makeElement(
      "button",
      "button button-primary",
      "Start a new task",
    );
    start.type = "button";
    start.addEventListener("click", () => setView("chat"));
    empty.append(start);
    runList.append(empty);
  } else {
    state.runs.forEach((run) => runList.append(renderRunListItem(run)));
  }
  const detail = makeElement("section", "run-detail-panel");
  detail.id = "run-detail-panel";
  const selected = state.selectedRunId
    ? state.runDetails.get(state.selectedRunId)
    : null;
  if (selected?.run) renderRunDetail(detail, selected);
  else {
    detail.append(
      makeElement("div", "detail-empty-icon", "✳"),
      makeElement("h3", "", "Select a task run"),
      makeElement(
        "p",
        "",
        "Choose a run to inspect its steps, handoffs, evidence, and approval requests.",
      ),
    );
  }
  layout.append(runList, detail);
  page.append(intro, toolbar, layout);
  workspace.append(page);
}

function renderRunListItem(run) {
  const button = makeElement(
    "button",
    "run-list-item" + (run.id === state.selectedRunId ? " is-selected" : ""),
  );
  button.type = "button";
  button.addEventListener("click", () => {
    state.selectedRunId = run.id;
    void refreshRun(run.id);
    connectRunStream(run.id);
    renderView();
  });
  const top = makeElement("div", "run-list-top");
  top.append(
    makeElement(
      "span",
      "run-status-dot status-" + String(run.status || "unknown"),
    ),
    makeElement("time", "", formatDate(run.updatedAt || run.createdAt)),
  );
  const title = makeElement(
    "strong",
    "run-list-title",
    run.goal || run.title || "Untitled run",
  );
  const bottom = makeElement("div", "run-list-bottom");
  bottom.append(makeElement("span", "status-label", prettyStatus(run.status)));
  const detail = state.runDetails.get(run.id);
  if (detail?.tasks?.length)
    bottom.append(makeElement("span", "", detail.tasks.length + " steps"));
  button.append(top, title, bottom);
  return button;
}

function renderRunDetail(container, detail) {
  const run = detail.run;
  const header = makeElement("div", "run-detail-heading");
  const status = makeElement(
    "span",
    "run-status-chip status-" + String(run.status || "unknown"),
    prettyStatus(run.status),
  );
  const actions = makeElement("div", "run-detail-actions");
  const refresh = makeElement("button", "icon-button", "↻");
  refresh.type = "button";
  refresh.title = "Refresh run";
  refresh.setAttribute("aria-label", "Refresh run");
  refresh.addEventListener(
    "click",
    () => void refreshRun(run.id, { quiet: false }),
  );
  actions.append(refresh);
  if (!terminal(run.status)) {
    const cancel = makeElement(
      "button",
      "button button-danger button-small",
      "Cancel run",
    );
    cancel.type = "button";
    cancel.addEventListener("click", async () => {
      cancel.disabled = true;
      try {
        await api.cancelRun(run.id);
        const controller = state.runStreams.get(run.id);
        controller?.abort();
        await refreshRun(run.id);
        await loadRuns();
        showToast("Run cancelled.", "success");
      } catch (error) {
        showToast(errorMessage(error), "error");
        cancel.disabled = false;
      }
    });
    actions.append(cancel);
  }
  header.append(status, actions);
  container.append(
    header,
    makeElement("h2", "run-detail-title", run.goal || "Task run"),
    makeElement(
      "p",
      "run-detail-summary",
      detail.plan?.summary ||
        run.plan?.summary ||
        "Kuro-chan is coordinating the work and collecting evidence.",
    ),
  );
  const metricRow = makeElement("div", "run-metrics");
  const succeeded = detail.tasks.filter(
    (task) => task.status === "succeeded",
  ).length;
  const failed = detail.tasks.filter((task) => task.status === "failed").length;
  const pending = detail.tasks.length - succeeded - failed;
  [
    ["STEPS", String(detail.tasks.length)],
    ["DONE", String(succeeded)],
    ["IN PROGRESS", String(Math.max(0, pending))],
  ].forEach(([label, value]) => {
    const card = makeElement("div", "run-metric");
    card.append(
      makeElement("span", "", label),
      makeElement("strong", "", value),
    );
    metricRow.append(card);
  });
  container.append(
    metricRow,
    makeElement("h3", "detail-section-title", "Plan and specialist handoffs"),
  );
  const taskList = makeElement("div", "task-timeline");
  if (!detail.tasks.length)
    taskList.append(
      makeElement("p", "subtle-copy", "Task details have not loaded yet."),
    );
  detail.tasks.forEach((task, index) =>
    taskList.append(renderTaskItem(task, index)),
  );
  container.append(taskList);
  if (detail.events?.length) {
    container.append(
      makeElement("h3", "detail-section-title", "Recent activity"),
    );
    const events = makeElement("div", "event-list");
    detail.events
      .slice(-12)
      .reverse()
      .forEach((event) => {
        const item = makeElement("div", "event-item");
        item.append(
          makeElement("span", "event-line"),
          makeElement("div", "event-copy", prettyStatus(event.type)),
          makeElement("time", "", formatDate(event.createdAt)),
        );
        events.append(item);
      });
    container.append(events);
  }
  if (terminal(run.status)) {
    const finish = makeElement(
      "div",
      "run-finish-note " +
        (run.status === "completed" ? "is-success" : "is-muted"),
    );
    finish.append(
      makeElement(
        "strong",
        "",
        run.status === "completed"
          ? "Run completed"
          : run.status === "cancelled"
            ? "Run cancelled"
            : "Run stopped",
      ),
      makeElement(
        "p",
        "",
        run.errorMessage ||
          "Review the recorded evidence and outputs before relying on the result.",
      ),
    );
    container.append(finish);
  }
}

function renderTaskItem(task, index) {
  const item = makeElement("article", "task-item");
  const rail = makeElement("div", "task-rail");
  rail.append(makeElement("span", "task-number", String(index + 1)));
  const body = makeElement("div", "task-body");
  const top = makeElement("div", "task-topline");
  top.append(
    makeElement(
      "strong",
      "",
      task.planKey || task.key || "Task " + (index + 1),
    ),
    makeElement(
      "span",
      "task-status status-" + String(task.status || "unknown"),
      prettyStatus(task.status),
    ),
  );
  body.append(
    top,
    makeElement(
      "p",
      "task-objective",
      task.objective || "No objective recorded.",
    ),
    makeElement(
      "div",
      "task-agent",
      "⌘  " + (task.agentId || "Unassigned specialist"),
    ),
  );
  const dependencies = Array.isArray(task.dependencies)
    ? task.dependencies
    : [];
  if (dependencies.length)
    body.append(
      makeElement(
        "p",
        "task-dependencies",
        "Depends on " + dependencies.join(", "),
      ),
    );
  if (task.errorMessage)
    body.append(makeElement("p", "task-error", task.errorMessage));
  if (Array.isArray(task.evidence) && task.evidence.length) {
    const evidence = makeElement("details", "task-evidence");
    const summary = makeElement(
      "summary",
      "",
      task.evidence.length +
        " evidence item" +
        (task.evidence.length === 1 ? "" : "s"),
    );
    evidence.append(summary);
    task.evidence.forEach((entry) => {
      const block = makeElement("div", "evidence-entry");
      block.append(
        makeElement("strong", "", entry.kind || "Evidence"),
        makeElement("p", "", entry.summary || "Evidence captured."),
      );
      if (entry.uri) block.append(makeElement("code", "", entry.uri));
      evidence.append(block);
    });
    body.append(evidence);
  }
  rail.append(body);
  item.append(rail);
  return item;
}

function renderAgentsView(workspace) {
  const page = makeElement("div", "page-view agents-page");
  const intro = makeElement("div", "page-intro");
  intro.append(
    makeElement("span", "section-kicker", "SPECIALIST ROUTING"),
    makeElement("h2", "", "Expertise, only when it helps."),
    makeElement(
      "p",
      "",
      "Search the pinned specialist catalog. Profiles guide the work; Kuro-chan's runtime still decides what tools and permissions are allowed.",
    ),
  );
  const search = makeElement("form", "agent-search");
  search.id = "agent-search-form";
  const input = makeElement("input");
  input.id = "agent-search-input";
  input.type = "search";
  input.maxLength = 200;
  input.placeholder = "Find a specialist, skill, or domain…";
  input.value = state.agentQuery;
  input.setAttribute("aria-label", "Search specialist catalog");
  const submit = makeElement("button", "button button-primary", "Search");
  submit.type = "submit";
  search.append(input, submit);
  search.addEventListener("submit", (event) => {
    event.preventDefault();
    state.agentQuery = input.value.trim();
    void searchAgents();
  });
  page.append(intro, search);
  const results = makeElement("div", "agent-results");
  results.id = "agent-results";
  if (!state.agentResults.length) {
    results.append(
      makeElement(
        "div",
        "empty-card",
        state.agentQuery
          ? "No specialists found yet. Try a broader phrase."
          : "Search the catalog to see the specialists available to Kuro-chan.",
      ),
    );
  } else {
    const count = makeElement(
      "p",
      "subtle-label",
      state.agentResults.length + " matching profiles",
    );
    results.append(count);
    const grid = makeElement("div", "agent-grid");
    state.agentResults.forEach((agent) => {
      const card = makeElement("article", "agent-card");
      const top = makeElement("div", "agent-card-top");
      top.append(
        makeElement("span", "agent-avatar", initials(agent.name)),
        makeElement("span", "agent-division", agent.division || "Specialist"),
      );
      card.append(
        top,
        makeElement("h3", "", agent.name || agent.id),
        makeElement(
          "p",
          "",
          agent.description || "No short description available.",
        ),
      );
      const footer = makeElement("div", "agent-card-footer");
      footer.append(
        makeElement("code", "", agent.id || "unknown-agent"),
        makeElement(
          "span",
          "",
          Array.isArray(agent.tools)
            ? agent.tools.slice(0, 3).join(" · ")
            : "Catalog profile",
        ),
      );
      card.append(footer);
      grid.append(card);
    });
    results.append(grid);
  }
  page.append(results);
  workspace.append(page);
  input.focus();
}

function initials(name) {
  return String(name || "?")
    .split(/[\s/-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("");
}

async function searchAgents() {
  const region = $("#agent-results");
  if (region) {
    region.replaceChildren(
      makeElement("div", "loading-line", "Searching the pinned catalog…"),
    );
  }
  try {
    const response = await api.listAgents(state.agentQuery);
    state.agentResults = Array.isArray(response?.data) ? response.data : [];
    renderView();
  } catch (error) {
    state.agentResults = [];
    renderView();
    showToast(errorMessage(error), "error");
  }
}

function renderSystemView(workspace) {
  const page = makeElement("div", "page-view system-page");
  const intro = makeElement("div", "page-intro");
  intro.append(
    makeElement("span", "section-kicker", "REAL STATUS, NO GUESSWORK"),
    makeElement("h2", "", "Know what's ready, and what isn't."),
    makeElement(
      "p",
      "",
      "This view reflects the API's current diagnostics. A configured provider is not automatically a successful provider; use the provider test on the server to verify live access.",
    ),
  );
  const refresh = makeElement(
    "button",
    "button button-subtle",
    "Refresh diagnostics ↻",
  );
  refresh.type = "button";
  refresh.addEventListener("click", () => void loadSystemView());
  const grid = makeElement("div", "system-grid");
  grid.id = "system-grid";
  grid.append(
    makeElement(
      "div",
      "loading-card",
      "Checking API, provider routing, workers, and voice configuration…",
    ),
  );
  page.append(intro, refresh, grid);
  workspace.append(page);
  void loadSystemView();
}

async function loadSystemView() {
  const region = $("#system-grid");
  if (!region) return;
  region.replaceChildren(
    makeElement("div", "loading-card", "Refreshing diagnostics…"),
  );
  const results = await Promise.allSettled([
    api.health(),
    api.readiness(),
    api.config(),
    api.workerStatus(),
    api.speechStatus(),
    api.routerStatus(),
    api.workers(),
  ]);
  const [health, readiness, config, worker, speech, router, workers] =
    results.map((result) =>
      result.status === "fulfilled" ? result.value : result.reason,
    );
  state.providers = Array.isArray(config?.providers)
    ? config.providers
    : state.providers;
  state.worker = worker && !(worker instanceof Error) ? worker : null;
  state.speech = speech && !(speech instanceof Error) ? speech : null;
  state.router = router && !(router instanceof Error) ? router : null;
  updateInspector();
  region.replaceChildren();
  const connected = health?.ok === true;
  region.append(
    systemCard(
      "API",
      connected ? "Reachable" : "Unavailable",
      connected ? "The API is responding." : errorMessage(health),
      connected ? "is-success" : "is-danger",
    ),
    systemCard(
      "Inference",
      readiness?.ready ? "Ready" : "Not ready",
      readiness?.requirement ||
        readiness?.error?.message ||
        (readiness instanceof Error
          ? readiness.message
          : "Check provider configuration."),
      readiness?.ready ? "is-success" : "is-warning",
    ),
    systemCard(
      "Workers",
      worker?.running
        ? "Running"
        : worker?.enabled
          ? "Enabled, idle"
          : "Not enabled",
      worker instanceof Error
        ? worker.message
        : worker?.workerId
          ? worker.workerId + " · concurrency " + worker.concurrency
          : "Start the standalone worker or enable the in-process worker.",
      worker?.running ? "is-success" : "is-warning",
    ),
    systemCard(
      "Voice",
      speech?.voiceTurn?.enabled ? "Recorded turns ready" : "Not configured",
      speech instanceof Error
        ? speech.message
        : speech?.voiceTurn?.realtimeDuplex
          ? "Realtime voice is enabled."
          : "Realtime duplex and barge-in are not available through the current recorded-turn mode.",
      speech?.voiceTurn?.enabled ? "is-success" : "is-warning",
    ),
  );
  const providerSection = makeElement("section", "system-wide-card");
  providerSection.append(makeElement("h3", "", "Provider configuration"));
  if (state.providers.length) {
    state.providers.forEach((provider) => {
      const row = makeElement("div", "provider-row");
      row.append(
        makeElement(
          "span",
          "status-dot " + (provider.configured ? "is-online" : "is-offline"),
        ),
        makeElement("strong", "", provider.name || provider.id),
        makeElement(
          "span",
          "provider-model",
          provider.defaultModel || "No default model",
        ),
        makeElement(
          "span",
          "status-label",
          provider.configured ? "Configured" : "Missing config",
        ),
      );
      providerSection.append(row);
    });
  } else
    providerSection.append(
      makeElement(
        "p",
        "subtle-copy",
        config instanceof Error
          ? config.message
          : "No provider metadata available. Check authentication and server configuration.",
      ),
    );
  const workerSection = makeElement("section", "system-wide-card");
  workerSection.append(makeElement("h3", "", "Worker heartbeat"));
  if (workers?.data?.length) {
    workers.data.forEach((item) => {
      const row = makeElement("div", "provider-row");
      row.append(
        makeElement(
          "span",
          "status-dot " + (item.stale ? "is-offline" : "is-online"),
        ),
        makeElement("strong", "", item.workerId),
        makeElement("span", "provider-model", prettyStatus(item.state)),
        makeElement("span", "status-label", item.stale ? "Stale" : "Live"),
      );
      workerSection.append(row);
    });
  } else
    workerSection.append(
      makeElement(
        "p",
        "subtle-copy",
        workers instanceof Error
          ? workers.message
          : "No worker heartbeats recorded yet.",
      ),
    );
  region.append(providerSection, workerSection);
}

function systemCard(title, value, detail, tone) {
  const card = makeElement("article", "system-card " + tone);
  card.append(
    makeElement("span", "system-card-label", title),
    makeElement("strong", "system-card-value", value),
    makeElement("p", "", detail || "No detail reported."),
  );
  return card;
}

function openSettings() {
  $("#api-base-url").value = state.apiBaseUrl;
  $("#api-token").value = "";
  $("#api-token").placeholder = state.apiToken
    ? "Token already set for this session; leave empty to keep it"
    : "Only if your API requires it";
  setText(
    "#settings-status",
    state.connected ? "API is reachable." : "Not tested yet.",
  );
  $("#settings-error").hidden = true;
  $("#settings-backdrop").hidden = false;
  $("#api-base-url").focus();
}

function closeSettings() {
  $("#settings-backdrop").hidden = true;
}

async function testConnection() {
  const button = $("#test-connection");
  const errorBox = $("#settings-error");
  errorBox.hidden = true;
  button.disabled = true;
  setText("#settings-status", "Testing API connection…");
  const previousBase = state.apiBaseUrl;
  const previousToken = state.apiToken;
  try {
    const candidateBase = normalizeApiBaseUrl($("#api-base-url").value);
    const candidateToken = $("#api-token").value.trim() || state.apiToken;
    state.apiBaseUrl = candidateBase;
    state.apiToken = candidateToken;
    const ok = await refreshConnection({ quiet: false });
    if (!ok) throw new Error("The API health check did not pass.");
    if (!state.authenticated)
      throw new Error(
        "The API is reachable but the access token was not accepted.",
      );
    setText(
      "#settings-status",
      "Connected. " +
        state.providers.filter((provider) => provider.configured).length +
        " provider(s) configured.",
    );
  } catch (error) {
    setText("#settings-status", "Connection test failed.");
    errorBox.textContent = errorMessage(error);
    errorBox.hidden = false;
  } finally {
    state.apiBaseUrl = previousBase;
    state.apiToken = previousToken;
    await refreshConnection({ quiet: true });
    button.disabled = false;
  }
}

async function saveSettings(event) {
  event.preventDefault();
  const errorBox = $("#settings-error");
  errorBox.hidden = true;
  const button = $('#settings-form button[type="submit"]');
  const previousBase = state.apiBaseUrl;
  const previousToken = state.apiToken;
  button.disabled = true;
  try {
    const candidateBase = normalizeApiBaseUrl($("#api-base-url").value);
    const typedToken = $("#api-token").value.trim();
    state.apiBaseUrl = candidateBase;
    if (typedToken) state.apiToken = typedToken;
    await refreshConnection({ quiet: false });
    if (!state.connected) throw new Error("The API health check did not pass.");
    if (!state.authenticated)
      throw new Error(
        "The API is reachable but authentication is required or rejected.",
      );
    localStorage.setItem(API_BASE_KEY, state.apiBaseUrl);
    if (state.apiToken) sessionStorage.setItem(API_TOKEN_KEY, state.apiToken);
    else sessionStorage.removeItem(API_TOKEN_KEY);
    closeSettings();
    await Promise.all([
      refreshConversations({ preserveSelection: true }),
      loadRuns(),
    ]);
    if (state.conversations.length && !state.currentConversationId)
      await loadConversation(state.conversations[0].id);
    if (state.view === "system") renderView();
    showToast("Workbench connected.", "success");
  } catch (error) {
    state.apiBaseUrl = previousBase;
    state.apiToken = previousToken;
    await refreshConnection({ quiet: true });
    errorBox.textContent = errorMessage(error);
    errorBox.hidden = false;
  } finally {
    button.disabled = false;
  }
}

function clearApiToken() {
  state.apiToken = "";
  sessionStorage.removeItem(API_TOKEN_KEY);
  $("#api-token").value = "";
  $("#api-token").placeholder =
    "Token cleared. Enter a new token if your API requires one.";
  showToast("Session token cleared. Save settings to reconnect without it.");
}

function toggleSidebar() {
  const open = !$("#sidebar").classList.contains("is-open");
  $("#sidebar").classList.toggle("is-open", open);
  $("#sidebar-scrim").classList.toggle("is-visible", open);
}

function init() {
  $("#model-profile").addEventListener("change", (event) => {
    state.selectedModel = event.target.value;
  });
  $$(".nav-item").forEach((button) =>
    button.addEventListener("click", () => {
      const view = button.dataset.view;
      setView(view);
      if (view === "runs") void loadRuns();
      if (view === "agents" && !state.agentResults.length) void searchAgents();
      if (view === "system") void loadSystemView();
    }),
  );
  $("#new-chat").addEventListener("click", () => void newConversation());
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      void newConversation();
    }
  });
  $("#refresh-conversations").addEventListener(
    "click",
    () => void refreshConversations(),
  );
  $("#open-settings").addEventListener("click", openSettings);
  $("#open-settings-secondary").addEventListener("click", openSettings);
  $("#close-settings").addEventListener("click", closeSettings);
  $("#settings-backdrop").addEventListener("click", (event) => {
    if (event.target === $("#settings-backdrop")) closeSettings();
  });
  $("#settings-form").addEventListener("submit", saveSettings);
  $("#test-connection").addEventListener("click", testConnection);
  $("#open-sidebar").addEventListener("click", toggleSidebar);
  $("#close-sidebar").addEventListener("click", toggleSidebar);
  $("#sidebar-scrim").addEventListener("click", toggleSidebar);
  $("#settings-backdrop").addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeSettings();
  });
  $("#clear-token")?.addEventListener("click", clearApiToken);
  document.addEventListener("click", (event) => {
    const suggestion = event.target.closest("[data-prompt]");
    if (suggestion) {
      setView("chat");
      const input = $("#message-input");
      if (input) {
        input.value = suggestion.dataset.prompt || "";
        resizeTextarea();
        input.focus();
      }
    }
  });
  window.addEventListener("online", () => void refreshConnection());
  window.addEventListener("beforeunload", () => {
    stopAllRunStreams();
    stopRecordingTracks();
    for (const url of state.voiceAudioUrls.values()) URL.revokeObjectURL(url);
  });
  setView("chat");
  void boot();
  if (
    "serviceWorker" in navigator &&
    (location.protocol === "https:" ||
      ["localhost", "127.0.0.1"].includes(location.hostname))
  ) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
  window.setInterval(() => {
    if (document.visibilityState === "visible") void refreshConnection();
  }, 45_000);
}

async function boot() {
  await refreshConnection();
  if (!state.authenticated) {
    renderView();
    openSettings();
    return;
  }
  await Promise.all([
    refreshConversations({ preserveSelection: true }),
    loadRuns(),
  ]);
  if (state.conversations.length) {
    const current =
      state.conversations.find(
        (conversation) => conversation.id === state.currentConversationId,
      ) || state.conversations[0];
    if (current) await loadConversation(current.id);
  }
  for (const run of state.runs) {
    if (!terminal(run.status)) {
      void refreshRun(run.id);
      connectRunStream(run.id);
    }
  }
  updateInspector();
}

init();
