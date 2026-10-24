import { ApiClient, ApiError, normalizeApiBaseUrl } from "./api.mjs";
import { renderMarkdown } from "./markdown.mjs";
import {
  INTEGRATION_CATALOG,
  buildMcpConfig,
  filterIntegrations,
  resolveIntegrationStatus,
} from "./integrations.mjs";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const API_BASE_KEY = "kurochan.apiBaseUrl.v1";
const API_TOKEN_KEY = "kurochan.apiToken.session.v1";
const FRONTEND_PREVIEW =
  new URLSearchParams(location.search).get("preview") === "1";
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
  selectedModel: "auto",
  modelCatalog: [],
  modelCatalogLoaded: false,
  modelCatalogLoading: false,
  modelCatalogUpdatedAt: null,
  connected: false,
  authenticated: false,
  authStatus: null,
  authUser: null,
  providers: [],
  worker: null,
  speech: null,
  router: null,
  agentQuery: "",
  agentResults: [],
  integrationTab: "connectors",
  integrationSearch: "",
  integrationCategory: "All",
  integrationKind: "Built in",
  integrationSelectedId: "github-project",
  integrationSnapshot: {},
  integrationPresets: [],
  integrationsLoaded: false,
  integrationsLoading: false,
  integrationProbeAt: null,
  integrationError: "",
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
  integrations: {
    eyebrow: "YOUR TOOLKIT",
    title: "Connect the tools behind the work.",
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

function renderAuthProviderPanel() {
  const panel = $("#auth-provider-panel");
  const buttons = $("#auth-provider-buttons");
  const note = $("#auth-provider-note");
  const signOutRow = $("#auth-sign-out-row");
  if (!panel || !buttons || !note || !signOutRow) return;

  buttons.replaceChildren();
  const providers = Array.isArray(state.authStatus?.providers)
    ? state.authStatus.providers.filter((provider) => provider.configured)
    : [];
  if (state.authUser) {
    panel.hidden = false;
    setText(
      "#auth-provider-title",
      "Signed in as " + (state.authUser.displayName || "your account"),
    );
    note.textContent = state.authUser.email
      ? state.authUser.email +
        " · " +
        (state.authUser.provider === "google" ? "Google" : "GitHub")
      : "Connected with " +
        (state.authUser.provider === "google" ? "Google" : "GitHub");
    signOutRow.hidden = false;
  } else if (state.authStatus?.enabled && providers.length) {
    panel.hidden = false;
    setText("#auth-provider-title", "Sign in to Kuro-chan");
    note.textContent =
      "Use your account to keep conversations and runs separate from other users of this server.";
    signOutRow.hidden = true;
  } else {
    panel.hidden = true;
    signOutRow.hidden = true;
    return;
  }

  for (const provider of providers) {
    const button = makeElement(
      "button",
      "button button-subtle auth-provider-button",
    );
    button.type = "button";
    button.dataset.oauthProvider = provider.id;
    button.append(
      makeElement(
        "span",
        "auth-provider-logo",
        provider.id === "github" ? "⌘" : "G",
      ),
      makeElement("span", "", "Continue with " + provider.name),
    );
    button.addEventListener("click", () => {
      try {
        const base = normalizeApiBaseUrl(state.apiBaseUrl);
        location.href =
          base + "/auth/" + encodeURIComponent(provider.id) + "/start";
      } catch (error) {
        showToast(errorMessage(error), "error");
      }
    });
    buttons.append(button);
  }
}

async function signOutOfAccount() {
  const wasOAuthAccount = Boolean(state.authUser);
  let serverRevoked = false;
  if (wasOAuthAccount) {
    try {
      const result = await api.logoutSession();
      serverRevoked = result?.revoked === true;
    } catch {
      serverRevoked = false;
    }
  }
  state.apiToken = "";
  state.authUser = null;
  sessionStorage.removeItem(API_TOKEN_KEY);
  stopAllRunStreams();
  state.currentConversationId = null;
  state.currentConversation = null;
  state.messages = [];
  state.conversations = [];
  state.runs = [];
  state.runDetails.clear();
  state.lastEventIds.clear();
  state.authenticated = false;
  renderAuthProviderPanel();
  showToast(
    wasOAuthAccount && !serverRevoked
      ? "Signed out on this device. Server-side revocation could not be confirmed, so this token may remain valid until expiry."
      : "Signed out. Your server-side conversation history was not deleted.",
    wasOAuthAccount && !serverRevoked ? "error" : "success",
  );
  await refreshConnection();
  renderView();
}
async function handleOAuthReturn() {
  const fragment = new URLSearchParams(location.hash.replace(/^#/, ""));
  const code = fragment.get("auth_code");
  const errorCode = fragment.get("auth_error");
  if (!code && !errorCode) return;
  history.replaceState(null, "", location.pathname + location.search);

  if (errorCode) {
    const friendly = {
      oauth_not_configured: "Account sign-in is not configured on this server.",
      oauth_provider_unavailable: "That sign-in provider is not configured.",
      oauth_state_invalid:
        "The sign-in could not be verified. Please try again.",
      oauth_state_expired: "The sign-in took too long. Please try again.",
      email_not_verified:
        "The Google account must have a verified email address.",
    };
    showToast(
      friendly[errorCode] || "Sign-in did not complete. Please try again.",
      "error",
    );
    return;
  }

  try {
    const session = await api.exchangeOAuthCode(code);
    state.apiToken = session.token;
    state.authUser = session.user;
    sessionStorage.setItem(API_TOKEN_KEY, session.token);
    showToast(
      "Signed in as " + (session.user?.displayName || "your account") + ".",
      "success",
    );
  } catch (error) {
    state.apiToken = "";
    state.authUser = null;
    sessionStorage.removeItem(API_TOKEN_KEY);
    showToast(errorMessage(error), "error");
  }
}

async function refreshConnection({ quiet = true } = {}) {
  try {
    const health = await api.health();
    state.connected = Boolean(health?.ok);
    state.authStatus = await api.authProviders().catch(() => null);
    if (!state.connected)
      throw new Error("The API responded, but health check did not pass.");
    try {
      const config = await api.config();
      state.authenticated = true;
      state.providers = Array.isArray(config?.providers)
        ? config.providers
        : [];
      const currentSession = await api.session().catch(() => null);
      state.authUser =
        currentSession?.user?.provider &&
        currentSession.user.provider !== "local"
          ? currentSession.user
          : null;
      updateConnectionBadge("Connected", "is-online");
    } catch (error) {
      if (error?.status === 401 || error?.code === "unauthorized") {
        state.authenticated = false;
        state.authUser = null;
        state.apiToken = "";
        sessionStorage.removeItem(API_TOKEN_KEY);
        state.authStatus = await api
          .authProviders()
          .catch(() => state.authStatus);
        updateConnectionBadge(
          state.authStatus?.enabled ? "Sign in required" : "Token needed",
          "is-warning",
        );
      } else {
        state.authenticated = false;
        updateConnectionBadge("API reachable", "is-warning");
        if (!quiet) throw error;
      }
    }
    renderAuthProviderPanel();
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
    state.authStatus = null;
    state.providers = [];
    renderAuthProviderPanel();
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
  else if (state.view === "integrations") renderIntegrationsView(workspace);
  else renderSystemView(workspace);
}

function selectedRouteProfile() {
  return ["fast", "balanced", "quality"].includes(state.selectedModel)
    ? state.selectedModel
    : "quality";
}

function selectedChatModel() {
  if (state.selectedModel === "auto") return "omni/quality";
  if (["fast", "balanced", "quality"].includes(state.selectedModel))
    return "omni/" + state.selectedModel;
  return state.selectedModel;
}

function populateModelOptions(select) {
  const currentValue = state.selectedModel;
  select.replaceChildren();
  const addOption = (parent, value, label, title) => {
    const option = makeElement("option", "", label);
    option.value = value;
    if (title) option.title = title;
    parent.append(option);
  };

  addOption(
    select,
    "auto",
    "Auto · OmniRoute",
    "Automatic routing with provider fallback.",
  );
  const profiles = document.createElement("optgroup");
  profiles.label = "Routing profiles";
  [
    ["fast", "Fast"],
    ["balanced", "Balanced"],
    ["quality", "Quality"],
  ].forEach(([value, label]) => addOption(profiles, value, label));
  select.append(profiles);

  for (const provider of state.modelCatalog) {
    if (!Array.isArray(provider.models) || provider.models.length === 0)
      continue;
    const group = document.createElement("optgroup");
    group.label = provider.name || provider.providerId;
    for (const model of provider.models) {
      const id = String(model.id || "");
      const value = String(model.value || provider.providerId + "/" + id);
      if (!id || !value) continue;
      const name = String(model.name || id);
      const label = name === id ? id : name + " · " + id;
      const titleParts = [
        id,
        model.description,
        model.contextLength ? "Context: " + model.contextLength : "",
      ].filter(Boolean);
      addOption(group, value, label, titleParts.join("\n"));
    }
    select.append(group);
  }

  if ([...select.options].some((option) => option.value === currentValue)) {
    select.value = currentValue;
  } else if (state.modelCatalogLoaded && currentValue !== "auto") {
    state.selectedModel = "auto";
    select.value = "auto";
  } else {
    select.value = "auto";
  }
}

async function loadModelCatalog() {
  if (
    FRONTEND_PREVIEW ||
    !state.authenticated ||
    state.modelCatalogLoading ||
    state.modelCatalogLoaded
  )
    return;
  state.modelCatalogLoading = true;
  try {
    const response = await api.models();
    state.modelCatalog = Array.isArray(response?.providers)
      ? response.providers
      : [];
    state.modelCatalogUpdatedAt =
      response?.fetchedAt || new Date().toISOString();
    state.modelCatalogLoaded = true;
  } catch {
    // Model selection must still work with route profiles if upstream
    // discovery is offline or unsupported.
    state.modelCatalog = [];
  } finally {
    state.modelCatalogLoading = false;
    const select = $("#model-profile");
    if (select) populateModelOptions(select);
  }
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
    title.append("OmniRoute");
    const copy = makeElement(
      "p",
      "welcome-copy",
      "Choose a routing profile below. OmniRoute uses configured providers and can fall back when a provider cannot serve the request.",
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
  const modelRow = makeElement("div", "composer-model-row");
  const modelLabel = makeElement("label", "model-select-wrap");
  modelLabel.append(makeElement("span", "sr-only", "Model routing mode"));
  const modelSelect = makeElement("select", "model-profile-select");
  modelSelect.id = "model-profile";
  modelSelect.setAttribute("aria-label", "Model routing mode");
  populateModelOptions(modelSelect);
  modelLabel.append(modelSelect);
  modelRow.append(modelLabel);

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
  textarea.disabled =
    state.sending ||
    state.recording ||
    (!state.authenticated && !FRONTEND_PREVIEW);
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
  const integrationsButton = makeElement(
    "button",
    "button button-integrations",
  );
  integrationsButton.type = "button";
  integrationsButton.id = "open-integrations-from-composer";
  integrationsButton.title = "Browse integrations";
  integrationsButton.setAttribute("aria-label", "Browse integrations");
  integrationsButton.append(
    makeElement("span", "button-icon", "⌘"),
    makeElement("span", "", "Integrations"),
  );
  integrationsButton.addEventListener("click", () => {
    setView("integrations");
    if (!state.integrationsLoaded && !state.integrationsLoading)
      void loadIntegrations();
  });

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
    state.sending ||
    state.recording ||
    (!state.authenticated && !FRONTEND_PREVIEW);
  sendButton.append(
    makeElement("span", "", state.sending ? "Sending…" : "Send"),
    makeElement("span", "send-arrow", "↗"),
  );
  actions.append(runButton, integrationsButton, voiceButton, sendButton);
  toolbar.append(hint, actions);
  composeBox.append(textarea, toolbar);
  compose.append(
    composeBox,
    makeElement(
      "p",
      "composer-footnote",
      FRONTEND_PREVIEW
        ? "Frontend preview only · messages here never leave this page."
        : state.authenticated
          ? "Provider credentials stay on the server. Replies stream as they arrive."
          : "Connect your Kuro-chan API to start chatting.",
    ),
  );
  shell.append(modelRow, compose);
  workspace.append(shell);
  const updateComposerAction = () => {
    const hasText = Boolean(textarea.value.trim());
    voiceButton.hidden = hasText;
    sendButton.hidden = !hasText;
  };
  textarea.addEventListener("input", () => {
    resizeTextarea();
    updateComposerAction();
  });
  updateComposerAction();
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
  if (!state.authenticated && FRONTEND_PREVIEW) {
    state.messages = [
      ...state.messages,
      { role: "user", content, createdAt: new Date().toISOString() },
      {
        role: "assistant",
        content:
          "This is a frontend-only preview. No AI model was called and your message was not sent anywhere. Connect a running Kuro-chan API to use real inference.",
        createdAt: new Date().toISOString(),
      },
    ];
    state.transientMessage = "";
    renderView();
    return;
  }
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
    const model = selectedChatModel();
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
    form.append("model", selectedChatModel());
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
      selectedRouteProfile(),
      { model: selectedChatModel() },
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

function renderIntegrationsView(workspace) {
  const page = makeElement("div", "page-view integrations-page");
  const tabs = makeElement("div", "integration-tabs");
  [
    ["connectors", "Connectors"],
    ["mcp", "MCP"],
    ["api", "API"],
    ["tools", "Tools"],
  ].forEach(([id, label]) => {
    const tab = makeElement("button", "integration-tab", label);
    tab.type = "button";
    tab.dataset.integrationTab = id;
    tab.classList.toggle("is-active", state.integrationTab === id);
    tab.setAttribute("aria-pressed", String(state.integrationTab === id));
    tab.addEventListener("click", () => {
      state.integrationTab = id;
      state.integrationKind =
        id === "connectors" ? "Built in" : id === "mcp" ? "MCP" : "All";
      state.integrationCategory = "All";
      state.integrationSearch = "";
      renderView();
      if (!state.integrationsLoaded && !state.integrationsLoading)
        void loadIntegrations();
    });
    tabs.append(tab);
  });
  const intro = makeElement("div", "page-intro integration-intro");
  intro.append(
    makeElement("span", "section-kicker", "INTEGRATIONS"),
    makeElement("h2", "", "Connect apps, APIs, and custom tools."),
    makeElement(
      "p",
      "",
      "Choose a connector, MCP server, provider API, or custom tool. Connection status comes from the running Kuro-chan API.",
    ),
  );

  const actions = makeElement("div", "integration-actions");
  const probe = makeElement(
    "button",
    "button button-primary",
    state.integrationsLoading ? "Checking…" : "Test MCP connections",
  );
  probe.type = "button";
  probe.disabled = state.integrationsLoading;
  probe.addEventListener("click", () => void loadIntegrations({ probe: true }));
  const refresh = makeElement(
    "button",
    "button button-subtle",
    "Refresh status ↻",
  );
  refresh.type = "button";
  refresh.disabled = state.integrationsLoading;
  refresh.addEventListener("click", () => void loadIntegrations());
  actions.append(probe, refresh);

  const message = makeElement("div", "integration-notice");
  message.id = "integration-status";
  message.setAttribute("role", "status");
  message.textContent = state.integrationError
    ? state.integrationError
    : state.integrationProbeAt
      ? "Last connection probe: " +
        new Date(state.integrationProbeAt).toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit",
        })
      : "Secrets stay on the server or worker. This screen never asks you to paste a provider key into the browser.";

  const summary = makeElement("div", "integration-summary");
  summary.id = "integration-summary";
  const filters = makeElement("div", "integration-filters");
  filters.id = "integration-filters";
  const searchWrap = makeElement("label", "integration-search-wrap");
  const searchLabel = makeElement("span", "sr-only", "Search integrations");
  const search = makeElement("input", "integration-search");
  search.id = "integration-search";
  search.type = "search";
  search.placeholder = "Search GitHub, Firebase, Supabase…";
  search.autocomplete = "off";
  search.value = state.integrationSearch;
  search.addEventListener("input", () => {
    state.integrationSearch = search.value;
    renderIntegrationCards();
  });
  searchWrap.append(searchLabel, search);

  const kindLabel = makeElement("label", "integration-filter-label");
  kindLabel.append(makeElement("span", "", "Type"));
  const kind = makeElement("select", "integration-filter");
  kind.id = "integration-kind-filter";
  [
    ["All", "All integrations"],
    ["Built in", "Built in"],
    ["MCP", "MCP directory"],
  ].forEach(([value, label]) => {
    const option = makeElement("option", "", label);
    option.value = value;
    kind.append(option);
  });
  kind.value = state.integrationKind;
  kind.addEventListener("change", () => {
    state.integrationKind = kind.value;
    renderIntegrationCards();
  });
  kindLabel.append(kind);

  const categoryLabel = makeElement("label", "integration-filter-label");
  categoryLabel.append(makeElement("span", "", "Category"));
  const category = makeElement("select", "integration-filter");
  category.id = "integration-category-filter";
  const categories = [
    "All",
    ...new Set(INTEGRATION_CATALOG.map((item) => item.category).sort()),
  ];
  categories.forEach((value) => {
    const option = makeElement(
      "option",
      "",
      value === "All" ? "All categories" : value,
    );
    option.value = value;
    category.append(option);
  });
  category.value = state.integrationCategory;
  category.addEventListener("change", () => {
    state.integrationCategory = category.value;
    renderIntegrationCards();
  });
  categoryLabel.append(category);

  filters.append(searchWrap, kindLabel, categoryLabel);
  kindLabel.hidden = true;
  categoryLabel.hidden = true;
  const grid = makeElement("div", "integration-grid");
  grid.id = "integration-cards";
  const detail = makeElement("section", "integration-detail");
  detail.id = "integration-detail";
  detail.setAttribute("aria-live", "polite");

  actions.hidden =
    state.integrationTab === "api" || state.integrationTab === "tools";
  message.hidden =
    state.integrationTab === "api" || state.integrationTab === "tools";
  page.append(intro, tabs, actions, message, summary, filters, grid, detail);
  workspace.append(page);
  renderIntegrationCards();
  if (
    !state.integrationsLoaded &&
    !state.integrationsLoading &&
    !state.integrationError
  ) {
    grid.replaceChildren(
      makeElement(
        "div",
        "loading-card",
        "Loading integration and connection status…",
      ),
    );
  }
}

async function loadIntegrations({ probe = false } = {}) {
  if (state.integrationsLoading) return;
  state.integrationsLoading = true;
  state.integrationError = "";
  const notice = $("#integration-status");
  if (notice) {
    notice.textContent = probe
      ? "Checking configured MCP servers and discovering their tools…"
      : "Refreshing the API's current integration status…";
  }
  const results = await Promise.allSettled([
    api.mcpStatus({ probe }),
    api.communityMcpPresets(),
    api.researchStatus(),
    api.workerStatus(),
    api.speechStatus(),
    api.config(),
    api.workers(),
  ]);
  const values = results.map((result) =>
    result.status === "fulfilled" ? result.value : result.reason,
  );
  const [mcp, presets, research, worker, speech, config, workers] = values;
  state.integrationSnapshot = {
    mcp: mcp && !(mcp instanceof Error) ? mcp : null,
    research: research && !(research instanceof Error) ? research : null,
    worker: worker && !(worker instanceof Error) ? worker : null,
    speech: speech && !(speech instanceof Error) ? speech : null,
    config: config && !(config instanceof Error) ? config : null,
    workers: workers && !(workers instanceof Error) ? workers : null,
  };
  state.integrationPresets = Array.isArray(presets?.data) ? presets.data : [];
  state.integrationsLoaded = results.some(
    (result) => result.status === "fulfilled",
  );
  state.integrationsLoading = false;
  if (probe) state.integrationProbeAt = Date.now();
  const firstError = results.find((result) => result.status === "rejected");
  if (!state.integrationsLoaded) {
    const reason =
      firstError && firstError.status === "rejected"
        ? firstError.reason
        : new Error("The API did not return integration diagnostics.");
    state.integrationError =
      !state.authenticated || reason?.code === "unauthorized"
        ? "Connect to your Kuro-chan API in Connection settings to inspect real connection status."
        : errorMessage(reason);
  } else if (
    state.integrationSnapshot.mcp?.security?.secretsReturned === true
  ) {
    state.integrationError =
      "The API reported an unexpected security configuration. Do not add secrets here.";
  }
  if (state.view === "integrations") renderView();
}

function renderIntegrationCards() {
  const grid = $("#integration-cards");
  const summary = $("#integration-summary");
  if (!grid || !summary) return;
  const snapshot = state.integrationSnapshot;
  const filters = $("#integration-filters");
  const detailPanel = $("#integration-detail");
  const actions = $(".integration-actions");
  const notice = $("#integration-status");

  if (state.integrationTab === "api") {
    if (filters) filters.hidden = true;
    if (detailPanel) detailPanel.hidden = true;
    if (actions) actions.hidden = true;
    if (notice) notice.hidden = true;
    const providers = Array.isArray(snapshot.config?.providers)
      ? snapshot.config.providers
      : [];
    const configured = providers.filter(
      (provider) =>
        provider.configured === true || provider.isConfigured === true,
    ).length;
    summary.replaceChildren(
      integrationMetric(String(configured), "Providers configured"),
      integrationMetric(String(providers.length), "Providers reported by API"),
      integrationMetric("Server-side", "Credential storage"),
    );
    grid.replaceChildren();
    if (!providers.length) {
      grid.append(
        makeElement(
          "div",
          "empty-state-card",
          "Connect to a running Kuro-chan API to inspect real provider status. Provider keys stay on the server and are never displayed here.",
        ),
      );
      return;
    }
    providers.forEach((provider) => {
      const isConfigured =
        provider.configured === true || provider.isConfigured === true;
      const name =
        provider.name || provider.id || provider.provider || "Model provider";
      const card = makeElement("article", "integration-card");
      const top = makeElement("div", "integration-card-top");
      top.append(
        makeElement("span", "integration-symbol", "◎"),
        makeElement("div", "integration-vendor", "MODEL PROVIDER"),
      );
      card.append(
        top,
        makeElement("h3", "integration-card-name", name),
        makeElement(
          "p",
          "integration-card-copy",
          provider.model || provider.defaultModel
            ? "Configured model: " + (provider.model || provider.defaultModel)
            : "Provider configuration is managed on the API server.",
        ),
      );
      const meta = makeElement("div", "integration-card-meta");
      meta.append(
        integrationBadge(
          isConfigured ? "Configured" : "Needs setup",
          isConfigured ? "success" : "warning",
        ),
      );
      card.append(meta);
      grid.append(card);
    });
    return;
  }

  if (state.integrationTab === "tools") {
    if (filters) filters.hidden = true;
    if (detailPanel) detailPanel.hidden = true;
    if (actions) actions.hidden = true;
    if (notice) notice.hidden = true;
    summary.replaceChildren(
      integrationMetric("Not available", "Custom tool builder"),
      integrationMetric("Server-side", "Execution boundary"),
      integrationMetric("Approval-gated", "External writes"),
    );
    grid.replaceChildren();
    const card = makeElement("article", "integration-card custom-tools-status");
    const top = makeElement("div", "integration-card-top");
    top.append(
      makeElement("span", "integration-symbol", "⚒"),
      makeElement("div", "integration-vendor", "CUSTOM INTEGRATIONS"),
    );
    card.append(
      top,
      makeElement("h3", "integration-card-name", "Custom Tools"),
      integrationBadge("Coming soon", "warning"),
      makeElement(
        "p",
        "integration-card-copy",
        "Webhook creation and custom-tool management are not implemented in this client yet. No inactive Connect button is shown.",
      ),
    );
    grid.append(card);
    return;
  }

  if (filters) filters.hidden = false;
  if (detailPanel) detailPanel.hidden = false;
  if (actions) actions.hidden = false;
  if (notice) notice.hidden = false;

  const nativeReady = INTEGRATION_CATALOG.filter((item) => {
    if (item.kind !== "native") return false;
    return resolveIntegrationStatus(item, snapshot).tone === "success";
  }).length;
  const connectedMcp = (snapshot.mcp?.servers || []).filter(
    (server) => server.connected,
  ).length;
  const configuredMcp = Number(snapshot.mcp?.configuredServerCount ?? 0);
  summary.replaceChildren(
    integrationMetric(String(connectedMcp), "MCP servers connected"),
    integrationMetric(String(nativeReady), "Native capabilities ready"),
    integrationMetric(String(INTEGRATION_CATALOG.length), "Directory entries"),
  );

  const results = filterIntegrations(INTEGRATION_CATALOG, {
    query: state.integrationSearch,
    category: state.integrationCategory,
    kind: state.integrationKind,
  });
  grid.replaceChildren();
  if (!results.length) {
    grid.append(
      makeElement(
        "div",
        "empty-state-card",
        "No integrations match that search. Try a vendor, tool name, or another category.",
      ),
    );
  }
  for (const integration of results) {
    const status = resolveIntegrationStatus(integration, snapshot);
    const card = makeElement("article", "integration-card");
    card.dataset.tone = status.tone;
    const top = makeElement("div", "integration-card-top");
    const symbol = makeElement(
      "span",
      "integration-symbol",
      integrationSymbol(integration),
    );
    symbol.setAttribute("aria-hidden", "true");
    const vendor = makeElement(
      "div",
      "integration-vendor",
      integration.vendor + " · " + integration.category,
    );
    top.append(symbol, vendor);
    const name = makeElement("h3", "integration-card-name", integration.name);
    const description = makeElement(
      "p",
      "integration-card-copy",
      integration.description,
    );
    const meta = makeElement("div", "integration-card-meta");
    const isReviewedPreset = state.integrationPresets.some(
      (preset) =>
        preset.id === integration.id || preset.id === integration.mcpServerId,
    );
    meta.append(
      integrationBadge(status.label, status.tone),
      makeElement(
        "span",
        "integration-kind",
        integration.kind === "native" ? "Built in" : "MCP adapter",
      ),
    );
    if (isReviewedPreset) {
      meta.append(integrationBadge("Reviewed template", "neutral"));
    }
    const foot = makeElement("div", "integration-card-foot");
    foot.append(
      makeElement("span", "integration-permissions", integration.permissions),
    );
    const button = makeElement(
      "button",
      "button button-subtle integration-details-button",
      state.integrationSelectedId === integration.id
        ? "Hide details"
        : "Details",
    );
    button.type = "button";
    button.setAttribute(
      "aria-expanded",
      String(state.integrationSelectedId === integration.id),
    );
    button.addEventListener("click", () => {
      state.integrationSelectedId =
        state.integrationSelectedId === integration.id ? null : integration.id;
      renderIntegrationCards();
    });
    foot.append(button);
    card.append(top, name, description, meta, foot);
    grid.append(card);
  }
  if (
    configuredMcp > 0 &&
    connectedMcp === 0 &&
    snapshot.mcp?.probed !== true
  ) {
    const note = makeElement(
      "p",
      "integration-probe-note",
      configuredMcp +
        " MCP server" +
        (configuredMcp === 1 ? " is" : "s are") +
        " configured. Run “Test MCP connections” to check reachability and discover available tools.",
    );
    summary.append(note);
  }
  renderIntegrationDetail();
}

function integrationMetric(value, label) {
  const card = makeElement("div", "integration-metric");
  card.append(makeElement("strong", "", value), makeElement("span", "", label));
  return card;
}

function integrationBadge(label, tone = "neutral") {
  const badge = makeElement("span", "integration-badge is-" + tone, label);
  return badge;
}

function integrationSymbol(item) {
  if (item.kind === "native") {
    const symbols = {
      workspace: "⌘",
      githubResearch: "GH",
      githubProject: "GH",
      webResearch: "↗",
      sandbox: "▣",
      speech: "◖",
      modelRouting: "◎",
    };
    return symbols[item.nativeKey] || "✳";
  }
  const symbols = {
    Code: "⌘",
    "Data & backend": "DB",
    "Developer tools": "⌁",
    Research: "↗",
    Design: "◫",
    "Project management": "≋",
    Knowledge: "▤",
    Communication: "↗",
    Observability: "◉",
    Infrastructure: "⌘",
    Payments: "$",
  };
  return symbols[item.category] || item.name.slice(0, 2).toUpperCase();
}

function renderIntegrationDetail() {
  const panel = $("#integration-detail");
  if (!panel) return;
  const item = INTEGRATION_CATALOG.find(
    (integration) => integration.id === state.integrationSelectedId,
  );
  panel.replaceChildren();
  panel.hidden = !item;
  if (!item) return;

  const snapshot = state.integrationSnapshot;
  const status = resolveIntegrationStatus(item, snapshot);
  const top = makeElement("div", "integration-detail-top");
  const titleBlock = makeElement("div", "integration-detail-heading");
  titleBlock.append(
    makeElement("span", "section-kicker", item.vendor.toUpperCase()),
    makeElement("h3", "", item.name),
  );
  top.append(titleBlock, integrationBadge(status.label, status.tone));
  panel.append(top, makeElement("p", "integration-detail-copy", item.detail));
  panel.append(makeElement("p", "integration-detail-status", status.detail));

  const facts = makeElement("div", "integration-facts");
  facts.append(
    integrationFact(
      "Connection path",
      item.kind === "native"
        ? "Native backend capability"
        : "MCP server adapter",
    ),
    integrationFact("Access policy", item.permissions),
  );
  if (item.mcpServerId)
    facts.append(integrationFact("Server ID", item.mcpServerId));
  panel.append(facts);

  if (item.kind === "mcp") {
    const server = (snapshot.mcp?.servers || []).find(
      (candidate) => candidate.id === item.mcpServerId,
    );
    const tools = (snapshot.mcp?.tools || []).filter(
      (tool) => tool.serverId === item.mcpServerId,
    );
    if (server) {
      panel.append(
        makeElement(
          "p",
          "integration-detail-status",
          server.connected
            ? "The API currently reports this server as connected."
            : server.lastError
              ? "Last connection error: " + server.lastError
              : "Configuration exists, but a successful probe has not been confirmed.",
        ),
      );
    }
    if (tools.length) {
      const toolSection = makeElement("div", "integration-tools-section");
      toolSection.append(
        makeElement("h4", "", "Discovered tools (" + tools.length + ")"),
      );
      const list = makeElement("div", "integration-tools-list");
      tools.slice(0, 24).forEach((tool) => {
        const row = makeElement("div", "integration-tool-row");
        row.append(
          makeElement("span", "", tool.name),
          integrationBadge(
            tool.readOnly ? "Read-only" : "Approval required",
            tool.readOnly ? "success" : "warning",
          ),
        );
        list.append(row);
      });
      if (tools.length > 24) {
        list.append(
          makeElement(
            "p",
            "subtle-copy",
            tools.length -
              24 +
              " more tool definitions are available from the API.",
          ),
        );
      }
      toolSection.append(list);
      panel.append(toolSection);
    }

    if (item.setupMode === "oauth-required") {
      panel.append(
        makeElement(
          "p",
          "integration-callout is-warning",
          "This service uses interactive OAuth. Kuro-chan's current MCP runtime accepts operator-supplied environment/header credentials, but does not yet complete an OAuth sign-in flow. It is listed for visibility, not as a working connection.",
        ),
      );
    } else {
      const code = integrationConfigSnippet(item);
      if (code) {
        const configSection = makeElement("div", "integration-config-section");
        configSection.append(
          makeElement(
            "h4",
            "",
            item.setupMode === "operator-config"
              ? "Starter configuration shape"
              : "MCP configuration",
          ),
          makeElement(
            "p",
            "subtle-copy",
            item.setupMode === "operator-config"
              ? "This is a structural example, not runnable as-is. Replace the endpoint, transport, and auth map using the official server's documentation."
              : "Add this entry to KUROCHAN_MCP_SERVERS in the worker environment. Merge it with existing entries rather than replacing other configured servers.",
          ),
        );
        const pre = makeElement("pre", "integration-code");
        pre.append(makeElement("code", "", code));
        configSection.append(pre);
        const copy = makeElement(
          "button",
          "button button-subtle",
          "Copy configuration",
        );
        copy.type = "button";
        copy.addEventListener("click", () => void copyIntegrationText(code));
        configSection.append(copy);
        panel.append(configSection);
      }
      if (item.envHints) {
        const values = Object.entries(item.envHints)
          .map(([name, value]) => name + "=" + value)
          .join("\n");
        const envSection = makeElement("div", "integration-config-section");
        envSection.append(
          makeElement("h4", "", "Worker environment variables"),
          makeElement(
            "p",
            "subtle-copy",
            "These are variable names and safe placeholders. Put real values in your worker's secret environment, never in chat or this browser.",
          ),
        );
        const pre = makeElement("pre", "integration-code");
        pre.append(makeElement("code", "", values));
        const copy = makeElement(
          "button",
          "button button-subtle",
          "Copy variable names",
        );
        copy.type = "button";
        copy.addEventListener("click", () => void copyIntegrationText(values));
        envSection.append(pre, copy);
        panel.append(envSection);
      }
    }
  } else {
    const envLines = nativeEnvironmentHints(item);
    if (envLines) {
      const envSection = makeElement("div", "integration-config-section");
      envSection.append(
        makeElement("h4", "", "Server environment"),
        makeElement(
          "p",
          "subtle-copy",
          "Configure these on the API/worker host. The browser never receives secret values.",
        ),
      );
      const pre = makeElement("pre", "integration-code");
      pre.append(makeElement("code", "", envLines));
      const copy = makeElement(
        "button",
        "button button-subtle",
        "Copy variable names",
      );
      copy.type = "button";
      copy.addEventListener("click", () => void copyIntegrationText(envLines));
      envSection.append(pre, copy);
      panel.append(envSection);
    }
  }

  if (item.docsUrl) {
    const docs = makeElement(
      "a",
      "integration-docs-link",
      "Official setup guide ↗",
    );
    docs.href = item.docsUrl;
    docs.target = "_blank";
    docs.rel = "noopener noreferrer";
    panel.append(docs);
  }
}

function integrationFact(label, value) {
  const row = makeElement("div", "integration-fact");
  row.append(makeElement("span", "", label), makeElement("strong", "", value));
  return row;
}

function integrationConfigSnippet(item) {
  const configuration = buildMcpConfig(item);
  if (configuration) return JSON.stringify([configuration], null, 2);
  if (item.kind === "mcp" && item.setupMode === "operator-config") {
    return JSON.stringify(
      [
        {
          id: item.mcpServerId,
          name: item.name,
          transport: "streamable-http",
          url: "https://REPLACE_WITH_OFFICIAL_MCP_ENDPOINT",
          headers: { Authorization: "MCP_AUTHORIZATION_ENV_VAR" },
        },
      ],
      null,
      2,
    );
  }
  return null;
}

function nativeEnvironmentHints(item) {
  const values = {
    workspace: "KUROCHAN_WORKER_ENABLED=true\nKUROCHAN_WORKER_CONCURRENCY=4",
    githubResearch: "",
    githubProject:
      "KUROCHAN_GITHUB_TOKEN=<secret in server environment>\nKUROCHAN_GITHUB_ALLOWED_REPOSITORIES=owner/repository\nKUROCHAN_GITHUB_WRITE_ENABLED=false",
    githubResearch:
      "Built in: public GitHub research is read-only and does not need a token.",
    webResearch:
      "BRAVE_SEARCH_API_KEY=<secret in server environment>\nBRAVE_SEARCH_COUNTRY=BD\nBRAVE_SEARCH_LANG=en",
    sandbox:
      "KUROCHAN_SANDBOX_ENABLED=true\nKUROCHAN_SANDBOX_IMAGE=node:22-bookworm-slim\nKUROCHAN_SANDBOX_NETWORK=none",
    speech:
      "KUROCHAN_STT_BASE_URL=<provider endpoint>\nKUROCHAN_STT_API_KEY=<secret in server environment>\nKUROCHAN_STT_MODEL=<compatible model>\nKUROCHAN_TTS_BASE_URL=<provider endpoint>\nKUROCHAN_TTS_API_KEY=<secret in server environment>\nKUROCHAN_TTS_MODEL=<compatible model>",
    modelRouting:
      "OPENROUTER_API_KEY=<secret in server environment>\nOPENROUTER_MODEL=<supported model>",
  };
  return values[item.nativeKey] || "";
}

async function copyIntegrationText(value) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      showToast("Copied. Add it to your server-side configuration.");
      return;
    }
  } catch {
    // Use the selection fallback below on non-secure origins.
  }
  const temporary = makeElement("textarea", "clipboard-fallback");
  temporary.value = value;
  temporary.readOnly = true;
  document.body.append(temporary);
  temporary.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  temporary.remove();
  showToast(
    copied
      ? "Copied. Add it to your server-side configuration."
      : "Clipboard isn't available here. Select the configuration text and copy it manually.",
    copied ? "success" : "normal",
  );
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
  document.addEventListener("change", (event) => {
    if (
      event.target instanceof HTMLSelectElement &&
      event.target.id === "model-profile"
    ) {
      state.selectedModel = event.target.value;
    }
  });
  $$(".nav-item").forEach((button) =>
    button.addEventListener("click", () => {
      const view = button.dataset.view;
      setView(view);
      if (view === "runs") void loadRuns();
      if (view === "agents" && !state.agentResults.length) void searchAgents();
      if (
        view === "integrations" &&
        !state.integrationsLoaded &&
        !state.integrationsLoading
      )
        void loadIntegrations();
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
  $("#sign-out")?.addEventListener("click", () => void signOutOfAccount());
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
    navigator.serviceWorker
      .register(new URL("./sw.js", import.meta.url))
      .catch(() => {});
  }
  if (!FRONTEND_PREVIEW) {
    window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshConnection();
    }, 45_000);
  }
}

async function boot() {
  if (FRONTEND_PREVIEW) {
    state.connected = false;
    state.authenticated = false;
    updateConnectionBadge("Preview only", "is-offline");
    renderView();
    return;
  }
  await handleOAuthReturn();
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
  void loadModelCatalog();
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
