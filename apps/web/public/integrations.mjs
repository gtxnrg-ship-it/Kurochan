export const INTEGRATION_CATALOG = [
  {
    id: "workspace",
    name: "Workspace & files",
    vendor: "Kuro-chan",
    category: "Core",
    kind: "native",
    nativeKey: "workspace",
    description: "Scoped project files, search, reads and writes for specialist tasks.",
    detail: "Kuro-chan provides workspace tools directly. Each coordinated run receives a scoped workspace; arbitrary code execution is a separate, optional sandbox capability.",
    docsUrl: "https://github.com/gtxnrg-ship-it/Kurochan/blob/main/docs/TARGET_BACKEND_ARCHITECTURE.md",
    permissions: "Project-scoped file access",
  },
  {
    id: "github-research",
    name: "GitHub research",
    vendor: "GitHub",
    category: "Code",
    kind: "native",
    nativeKey: "githubResearch",
    description: "Search public repositories and inspect files without repository write access.",
    detail: "The built-in research adapter is public-repository read-only. It does not imply access to private repositories.",
    docsUrl: "https://github.com/gtxnrg-ship-it/Kurochan/blob/main/docs/GITHUB_PROJECTS_SETUP.md",
    permissions: "Public repositories · read-only",
  },
  {
    id: "github-project",
    name: "GitHub projects",
    vendor: "GitHub",
    category: "Code",
    kind: "native",
    nativeKey: "githubProject",
    description: "Check out allowlisted repositories and prepare changes for review.",
    detail: "Requires a server-side GitHub token and an explicit repository allowlist. Publishing is separately disabled by default and external writes require approval.",
    docsUrl: "https://github.com/gtxnrg-ship-it/Kurochan/blob/main/docs/GITHUB_PROJECTS_SETUP.md",
    permissions: "Allowlisted repositories · approval-gated writes",
  },
  {
    id: "web-research",
    name: "Web research",
    vendor: "Brave Search",
    category: "Research",
    kind: "native",
    nativeKey: "webResearch",
    description: "Ground research tasks in bounded, source-backed web context.",
    detail: "Requires a server-side Brave Search API key. Search results are evidence, not trusted instructions, and arbitrary URL fetching is not enabled by this adapter.",
    docsUrl: "https://github.com/gtxnrg-ship-it/Kurochan/blob/main/docs/WEB_RESEARCH_SETUP.md",
    permissions: "Search · source evidence",
  },
  {
    id: "sandbox",
    name: "Isolated command runner",
    vendor: "Kuro-chan",
    category: "Developer tools",
    kind: "native",
    nativeKey: "sandbox",
    description: "Run build and test commands in an optional isolated Docker sandbox.",
    detail: "Disabled by default. When enabled, command execution uses configured resource limits and network policy. A successful command is evidence, not a guarantee of complete verification.",
    docsUrl: "https://github.com/gtxnrg-ship-it/Kurochan/blob/main/docs/EXTENSION_AND_CLOUD_WORKER_ARCHITECTURE.md",
    permissions: "Sandboxed process execution",
  },
  {
    id: "speech",
    name: "Speech input & output",
    vendor: "Kuro-chan",
    category: "Voice",
    kind: "native",
    nativeKey: "speech",
    description: "Optional transcription and speech synthesis through configured server-side providers.",
    detail: "The diagnostics show the actual configured capabilities. Recorded audio turns do not imply real-time duplex conversation, interruption handling, or a selected human-like voice model.",
    docsUrl: "https://github.com/gtxnrg-ship-it/Kurochan/blob/main/docs/SPEECH_SETUP.md",
    permissions: "Audio sent to configured speech provider",
  },
  {
    id: "model-routing",
    name: "Model routing",
    vendor: "OmniRouter",
    category: "AI models",
    kind: "native",
    nativeKey: "modelRouting",
    description: "Route tasks across configured model providers with capability checks and bounded failover.",
    detail: "OmniRouter is Kuro-chan's routing policy layer. Provider keys stay on the server; a configured provider is not proof that live inference succeeds.",
    docsUrl: "https://github.com/gtxnrg-ship-it/Kurochan/blob/main/docs/TARGET_BACKEND_ARCHITECTURE.md",
    permissions: "Server-side inference",
  },
  {
    id: "github-mcp-server",
    name: "GitHub MCP Server",
    vendor: "GitHub",
    category: "Code",
    kind: "mcp",
    mcpServerId: "github-mcp-server",
    setupMode: "http-header",
    transport: "streamable-http",
    endpoint: "https://api.githubcopilot.com/mcp/",
    headers: { Authorization: "GITHUB_MCP_AUTHORIZATION" },
    envHints: { GITHUB_MCP_AUTHORIZATION: "Bearer <least-privilege fine-grained token>" },
    description: "Optional GitHub-hosted MCP tools for repository, issue and pull-request context.",
    detail: "Use a fine-grained token and scope access to only the repositories and operations needed. This is separate from the built-in GitHub project connector.",
    docsUrl: "https://github.com/github/github-mcp-server",
    permissions: "Depends on token scopes · mutating tools require approval",
  },
  {
    id: "supabase",
    name: "Supabase",
    vendor: "Supabase",
    category: "Data & backend",
    kind: "mcp",
    mcpServerId: "supabase",
    setupMode: "http-header",
    transport: "streamable-http",
    endpoint: "https://mcp.supabase.com/mcp?read_only=true&project_ref=YOUR_PROJECT_REF",
    headers: { Authorization: "SUPABASE_MCP_AUTHORIZATION" },
    envHints: { SUPABASE_MCP_AUTHORIZATION: "Bearer <scoped Supabase personal access token>" },
    description: "Inspect project schema, query data in read-only mode and investigate backend issues.",
    detail: "The sample is deliberately project-scoped and read-only. Replace YOUR_PROJECT_REF with your real project reference. For hosted browser-based OAuth, this Kuro-chan adapter currently needs an explicit server-side token header; keep the token in the worker's secret environment.",
    docsUrl: "https://supabase.com/docs/guides/ai-tools/mcp",
    permissions: "Project-scoped · read-only by default",
  },
  {
    id: "firebase",
    name: "Firebase",
    vendor: "Google Firebase",
    category: "Data & backend",
    kind: "mcp",
    mcpServerId: "firebase",
    setupMode: "stdio",
    transport: "stdio",
    command: "npx",
    args: ["-y", "firebase-tools@latest", "mcp"],
    env: {},
    description: "Work with Firebase projects, Authentication, Firestore, SQL Connect and security rules.",
    detail: "Runs the official Firebase CLI MCP server as a local worker process. Authenticate the Firebase CLI on the worker host first. Review and pin the package version before production use; Firebase tools can make changes, so keep approval gates enabled.",
    docsUrl: "https://firebase.google.com/docs/ai-assistance/mcp-server",
    permissions: "Firebase CLI identity · potentially mutating operations",
  },
  {
    id: "context7",
    name: "Context7 documentation",
    vendor: "Upstash",
    category: "Developer tools",
    kind: "mcp",
    mcpServerId: "context7",
    setupMode: "http-header",
    transport: "streamable-http",
    endpoint: "https://mcp.context7.com/mcp",
    headers: { Authorization: "CONTEXT7_AUTHORIZATION" },
    envHints: { CONTEXT7_AUTHORIZATION: "Provider-issued authorization value; never paste it into Kuro-chan chat" },
    description: "Retrieve version-aware library documentation and reduce stale API assumptions.",
    detail: "Configure only if the selected Context7 plan requires authentication. Values in the MCP headers map are environment-variable names, not literal secrets.",
    docsUrl: "https://context7.com/docs/overview",
    permissions: "Documentation retrieval",
  },
  {
    id: "playwright-mcp",
    name: "Playwright browser testing",
    vendor: "Microsoft Playwright",
    category: "Developer tools",
    kind: "mcp",
    mcpServerId: "playwright",
    setupMode: "stdio",
    transport: "stdio",
    command: "npx",
    args: ["--yes", "@playwright/mcp@0.0.83"],
    env: {},
    description: "Exercise browser journeys and inspect UI behavior in a dedicated test environment.",
    detail: "Use test accounts and non-production data. Browser tools can submit forms and change remote state; actions that are not explicitly read-only require Kuro-chan approval.",
    docsUrl: "https://github.com/microsoft/playwright-mcp",
    permissions: "Browser automation · test environments only",
  },
  {
    id: "sentry",
    name: "Sentry",
    vendor: "Sentry",
    category: "Observability",
    kind: "mcp",
    mcpServerId: "sentry",
    setupMode: "operator-config",
    description: "Investigate issues, traces and regressions using project-scoped observability data.",
    detail: "Add a reviewed Sentry MCP configuration to KUROCHAN_MCP_SERVERS. Use a dedicated least-privilege credential and begin read-only.",
    docsUrl: "https://mcp.sentry.dev/",
    permissions: "Read-only first · project-scoped",
  },
  {
    id: "figma",
    name: "Figma design context",
    vendor: "Figma",
    category: "Design",
    kind: "mcp",
    mcpServerId: "figma",
    setupMode: "oauth-required",
    endpoint: "https://mcp.figma.com/mcp",
    description: "Bring frames, components, variables and design-system context into implementation tasks.",
    detail: "Figma's hosted server uses interactive OAuth. Kuro-chan's current MCP transport does not complete that OAuth flow, so this card is a catalog entry, not a working one-click connection. OAuth-aware MCP transport is required before claiming it is connected.",
    docsUrl: "https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/",
    permissions: "Figma account permissions · write access depends on plan and seat",
  },
  {
    id: "linear",
    name: "Linear",
    vendor: "Linear",
    category: "Project management",
    kind: "mcp",
    mcpServerId: "linear",
    setupMode: "oauth-required",
    description: "Bring issues, project context, and acceptance criteria into planning and handoffs.",
    detail: "Use the official MCP integration. Interactive OAuth is not currently brokered by Kuro-chan's MCP transport; connect only after an OAuth-capable adapter is implemented or use a reviewed compatible bridge.",
    docsUrl: "https://linear.app/docs/mcp",
    permissions: "Read-only first · ticket writes require approval",
  },
  {
    id: "notion",
    name: "Notion",
    vendor: "Notion",
    category: "Knowledge",
    kind: "mcp",
    mcpServerId: "notion",
    setupMode: "oauth-required",
    description: "Retrieve approved project notes, runbooks and product requirements.",
    detail: "The standard hosted MCP setup uses interactive authorization. The current Kuro-chan transport does not perform that OAuth flow, so this needs an OAuth-capable adapter or a reviewed compatible bridge.",
    docsUrl: "https://developers.notion.com/docs/mcp",
    permissions: "Explicitly shared pages · read-only first",
  },
  {
    id: "slack",
    name: "Slack",
    vendor: "Slack",
    category: "Communication",
    kind: "mcp",
    mcpServerId: "slack",
    setupMode: "operator-config",
    description: "Retrieve relevant decisions and project context from approved conversations.",
    detail: "Configure a reviewed MCP server with least-privilege scopes. Reading conversations may expose private team data; sending messages or changing channels must stay approval-gated.",
    docsUrl: "https://docs.slack.dev/",
    permissions: "Scoped workspace access · message sending requires approval",
  },
  {
    id: "postgresql",
    name: "PostgreSQL",
    vendor: "PostgreSQL ecosystem",
    category: "Data & backend",
    kind: "mcp",
    mcpServerId: "postgresql",
    setupMode: "operator-config",
    description: "Inspect database schema and run approved diagnostic queries.",
    detail: "Choose a maintained MCP server, scope it to a dedicated database user and default to read-only. Avoid production write credentials and never expose the database directly to the public internet.",
    docsUrl: "https://github.com/gtxnrg-ship-it/Kurochan/blob/main/docs/MCP_TOOLS_SETUP.md",
    permissions: "Read-only database role recommended",
  },
  {
    id: "mongodb",
    name: "MongoDB",
    vendor: "MongoDB",
    category: "Data & backend",
    kind: "mcp",
    mcpServerId: "mongodb",
    setupMode: "operator-config",
    description: "Inspect document models and investigate data issues with scoped access.",
    detail: "Use an official or reviewed maintained MCP server and a least-privilege database user. A catalog entry does not install the driver or connect to a cluster.",
    docsUrl: "https://github.com/gtxnrg-ship-it/Kurochan/blob/main/docs/MCP_TOOLS_SETUP.md",
    permissions: "Read-only database role recommended",
  },
  {
    id: "redis",
    name: "Redis",
    vendor: "Redis",
    category: "Data & backend",
    kind: "mcp",
    mcpServerId: "redis",
    setupMode: "operator-config",
    description: "Diagnose cache behavior and inspect approved keys.",
    detail: "Use a dedicated identity and key prefix, and avoid broad cache mutation permissions unless a task has explicit approval.",
    docsUrl: "https://github.com/gtxnrg-ship-it/Kurochan/blob/main/docs/MCP_TOOLS_SETUP.md",
    permissions: "Scoped keys · read-only first",
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    vendor: "Cloudflare",
    category: "Infrastructure",
    kind: "mcp",
    mcpServerId: "cloudflare",
    setupMode: "operator-config",
    description: "Inspect supported platform configuration and diagnose deployment issues.",
    detail: "Choose the official or reviewed MCP server for the needed Cloudflare product and limit credentials to the correct account and zones. Changes to DNS, security rules or deployment require approval.",
    docsUrl: "https://developers.cloudflare.com/",
    permissions: "Read-only diagnostics first",
  },
  {
    id: "aws",
    name: "AWS",
    vendor: "Amazon Web Services",
    category: "Infrastructure",
    kind: "mcp",
    mcpServerId: "aws",
    setupMode: "operator-config",
    description: "Investigate cloud configuration and service logs with narrowly scoped access.",
    detail: "Use short-lived or workload credentials with only the required IAM permissions. Begin with read-only diagnostics; infrastructure changes and deployments require approval.",
    docsUrl: "https://aws.amazon.com/",
    permissions: "Least-privilege IAM · read-only first",
  },
  {
    id: "vercel",
    name: "Vercel",
    vendor: "Vercel",
    category: "Infrastructure",
    kind: "mcp",
    mcpServerId: "vercel",
    setupMode: "operator-config",
    description: "Review deployment state, preview environments and build logs.",
    detail: "A reviewed server configuration is required. Use a team- and project-scoped token; deployments remain external write actions and must be approved.",
    docsUrl: "https://vercel.com/docs",
    permissions: "Read-only first · deployments require approval",
  },
  {
    id: "stripe",
    name: "Stripe",
    vendor: "Stripe",
    category: "Payments",
    kind: "mcp",
    mcpServerId: "stripe",
    setupMode: "operator-config",
    description: "Investigate payment integration errors and test-mode events.",
    detail: "Start with test mode and read-only access. Never trigger real charges, refunds, payouts or other financial side effects without explicit approval.",
    docsUrl: "https://docs.stripe.com/",
    permissions: "Test mode · read-only first",
  },
  {
    id: "gitlab",
    name: "GitLab",
    vendor: "GitLab",
    category: "Code",
    kind: "mcp",
    mcpServerId: "gitlab",
    setupMode: "operator-config",
    description: "Bring repository, issue, merge-request and CI context into code tasks.",
    detail: "Use a supported official or reviewed MCP server and restrict access to named groups or projects. Writes must require approval.",
    docsUrl: "https://docs.gitlab.com/",
    permissions: "Project-scoped · read-only first",
  },
];

export function filterIntegrations(
  integrations = INTEGRATION_CATALOG,
  { query = "", category = "All", kind = "All" } = {},
) {
  const needle = String(query).trim().toLowerCase();
  return integrations.filter((item) => {
    const categoryMatches = category === "All" || item.category === category;
    const kindMatches =
      kind === "All" ||
      (kind === "Built in" && item.kind === "native") ||
      (kind === "MCP" && item.kind === "mcp");
    const haystack = [
      item.name,
      item.vendor,
      item.category,
      item.description,
      item.detail,
      item.permissions,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return categoryMatches && kindMatches && (!needle || haystack.includes(needle));
  });
}

export function buildMcpConfig(integration) {
  if (!integration || integration.kind !== "mcp") return null;
  if (!["http-header", "stdio"].includes(integration.setupMode)) return null;
  if (integration.transport === "stdio") {
    return {
      id: integration.mcpServerId,
      name: integration.name,
      transport: "stdio",
      command: integration.command,
      args: integration.args ?? [],
      env: integration.env ?? {},
    };
  }
  return {
    id: integration.mcpServerId,
    name: integration.name,
    transport: "streamable-http",
    url: integration.endpoint,
    ...(integration.headers ? { headers: integration.headers } : {}),
  };
}

export function resolveIntegrationStatus(integration, snapshot = {}) {
  const mcpServers = Array.isArray(snapshot.mcp?.servers)
    ? snapshot.mcp.servers
    : [];
  if (integration.kind === "mcp") {
    const server = mcpServers.find(
      (item) =>
        item.id === integration.mcpServerId ||
        item.name?.toLowerCase() === integration.name.toLowerCase(),
    );
    if (server?.connected) {
      return {
        label: "Connected",
        tone: "success",
        detail: server.toolCount
          ? "Connected · " + server.toolCount + " discovered tools."
          : "Connected; tool discovery has not reported a tool count yet.",
      };
    }
    if (server) {
      return {
        label: "Needs attention",
        tone: "warning",
        detail:
          server.lastError || "The server is configured but not currently connected.",
      };
    }
    if (integration.setupMode === "oauth-required") {
      return {
        label: "OAuth support needed",
        tone: "warning",
        detail: "The current Kuro-chan MCP transport does not complete an interactive OAuth flow.",
      };
    }
    if (integration.setupMode === "operator-config") {
      return {
        label: "Operator setup",
        tone: "neutral",
        detail: "Add a reviewed server entry to KUROCHAN_MCP_SERVERS, then probe the connection.",
      };
    }
    return {
      label: "Not connected",
      tone: "neutral",
      detail: "Available through the MCP directory; it is not configured on this server yet.",
    };
  }

  switch (integration.nativeKey) {
    case "workspace": {
      const onlineWorkers =
        Number(snapshot.workers?.summary?.active ?? 0) > 0 ||
        Boolean(snapshot.worker?.running);
      return {
        label: onlineWorkers ? "Ready" : "Worker needed",
        tone: onlineWorkers ? "success" : "warning",
        detail: onlineWorkers
          ? "A worker is available to execute scoped workspace tasks."
          : "Start the standalone worker or enable KUROCHAN_WORKER_ENABLED for in-process work.",
      };
    }
    case "githubResearch":
      return {
        label: "Built in",
        tone: "success",
        detail: "Public repository search and file reading are available; private repository access is separate.",
      };
    case "githubProject": {
      const project = snapshot.research?.githubProject ?? snapshot.worker?.githubProject;
      return project?.configured || snapshot.worker?.githubProject?.enabled
        ? {
            label: "Configured",
            tone: "success",
            detail: project?.publishingEnabled || snapshot.worker?.githubProject?.publishEnabled
              ? "Configured; publishing is enabled but still requires per-action approval."
              : "Configured for allowlisted checkout. Repository publishing remains disabled.",
          }
        : {
            label: "Needs setup",
            tone: "neutral",
            detail: "Configure a server-side GitHub token and KUROCHAN_GITHUB_ALLOWED_REPOSITORIES.",
          };
    }
    case "webResearch": {
      const configured = Boolean(snapshot.research?.web?.configured ?? snapshot.worker?.webResearch?.enabled);
      return {
        label: configured ? "Configured" : "Needs setup",
        tone: configured ? "success" : "neutral",
        detail: configured
          ? "Brave search is configured; verify it with a live research task."
          : "Add BRAVE_SEARCH_API_KEY to the server/worker environment.",
      };
    }
    case "sandbox": {
      const enabled = Boolean(snapshot.worker?.sandbox?.enabled);
      return {
        label: enabled ? "Enabled" : "Disabled",
        tone: enabled ? "success" : "neutral",
        detail: enabled
          ? "The command sandbox reports an enabled runtime."
          : "Optional. Enable Docker sandbox settings on the worker host.",
      };
    }
    case "speech": {
      const voice = snapshot.speech?.voiceTurn;
      return {
        label: voice?.realtimeDuplex
          ? "Realtime duplex"
          : voice?.enabled
            ? "Recorded turns"
            : "Not configured",
        tone: voice?.enabled ? "success" : "neutral",
        detail: voice?.realtimeDuplex
          ? "The API reports realtime duplex speech support."
          : voice?.enabled
            ? "Recorded audio input/output is configured; this does not mean realtime duplex."
            : "Select and configure compatible STT/TTS models on the server.",
      };
    }
    case "modelRouting": {
      const providers = Array.isArray(snapshot.config?.providers)
        ? snapshot.config.providers
        : [];
      const configured = providers.filter((provider) => provider.configured);
      return {
        label: configured.length ? configured.length + " ready" : "Needs setup",
        tone: configured.length ? "success" : "warning",
        detail: configured.length
          ? configured.map((provider) => provider.name || provider.id).join(" · ")
          : "Configure a supported model provider in the server environment.",
      };
    }
    default:
      return {
        label: "Status unknown",
        tone: "neutral",
        detail: "The server does not report a status for this integration.",
      };
  }
}
