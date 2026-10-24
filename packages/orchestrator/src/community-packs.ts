import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const COMMUNITY_PACK_MODES = [
  "vendored-skill-pack",
  "plugin-adapter-required",
  "discovery-catalog",
  "external-runtime",
  "license-review-required",
] as const;

export type CommunityPackMode = (typeof COMMUNITY_PACK_MODES)[number];

export interface CommunityPack {
  readonly id: string;
  readonly name: string;
  readonly repository: string;
  readonly pinnedRevision: string;
  readonly license: string | null;
  readonly mode: CommunityPackMode;
  readonly category: string;
  readonly summary: string;
  readonly sourceIncluded: boolean;
  readonly notes: string;
}

const PACKS: readonly CommunityPack[] = [
  {
    id: "superpowers",
    name: "Superpowers",
    repository: "https://github.com/obra/superpowers",
    pinnedRevision: "2ce8aa15d05bd57213e6f746f953aafb7ded7a8b",
    license: "MIT",
    mode: "vendored-skill-pack",
    category: "engineering-workflows",
    summary:
      "Planning, TDD, systematic debugging, code review, and verification skills.",
    sourceIncluded: true,
    notes:
      "Pinned Git submodule. Only SKILL.md instructions are loaded; helper scripts are not executed.",
  },
  {
    id: "wshobson-agents",
    name: "wshobson/agents",
    repository: "https://github.com/wshobson/agents",
    pinnedRevision: "0874a27b17a22e2b7c2e2bcd725768e0803cad06",
    license: "MIT",
    mode: "vendored-skill-pack",
    category: "multi-agent-engineering",
    summary:
      "Multi-harness specialist agent plugins, skills, and workflow commands.",
    sourceIncluded: true,
    notes:
      "Pinned Git submodule. Kurochan reads selected SKILL.md files only, not native plugin hooks or commands.",
  },
  {
    id: "compound-engineering",
    name: "Compound Engineering",
    repository: "https://github.com/EveryInc/compound-engineering-plugin",
    pinnedRevision: "786ac0194183fadc3d0e2525b2ba6d40353926d3",
    license: "MIT",
    mode: "plugin-adapter-required",
    category: "engineering-workflows",
    summary:
      "Plan, implement, review, and learn from engineering work with coordinated workflows.",
    sourceIncluded: false,
    notes:
      "Registered for a dedicated adapter. Native plugin hooks are not imported or executed.",
  },
  {
    id: "awesome-agent-skills",
    name: "Awesome Agent Skills",
    repository: "https://github.com/VoltAgent/awesome-agent-skills",
    pinnedRevision: "f737f2891ebc9fdf8f255b3322b0ae7bb360805e",
    license: "MIT",
    mode: "discovery-catalog",
    category: "skill-discovery",
    summary:
      "A discovery index of skills published by official teams and community authors.",
    sourceIncluded: false,
    notes:
      "The catalogue license does not automatically relicense the repositories it links to. Review each imported source separately.",
  },
  {
    id: "anthropic-agent-skills",
    name: "Anthropic Skills",
    repository: "https://github.com/anthropics/skills",
    pinnedRevision: "dbd4588f9e1033efb41dad4bef2f7947c8993d44",
    license: null,
    mode: "license-review-required",
    category: "agent-skills",
    summary:
      "Anthropic's public Agent Skills examples and reusable instructions.",
    sourceIncluded: false,
    notes:
      "No license was declared in the repository metadata checked for this pin; reference only until licensing is clarified.",
  },
  {
    id: "everything-claude-code",
    name: "Everything Claude Code",
    repository: "https://github.com/affaan-m/ECC",
    pinnedRevision: "90606c8315ee09cafc303515c5f33024db6b9882",
    license: "MIT",
    mode: "plugin-adapter-required",
    category: "agent-harness",
    summary:
      "Skills, memory, security, and research-first workflows for coding agents.",
    sourceIncluded: false,
    notes:
      "Large multi-harness project. Integrate selected capabilities through an adapter instead of importing its runtime wholesale.",
  },
  {
    id: "gstack",
    name: "gstack",
    repository: "https://github.com/garrytan/gstack",
    pinnedRevision: "6f7488a70f23bc71745bde704eda98033cc33bfa",
    license: "MIT",
    mode: "plugin-adapter-required",
    category: "engineering-team-workflows",
    summary:
      "Opinionated engineering workflows spanning planning, design, implementation, QA, and release.",
    sourceIncluded: false,
    notes:
      "Large repository with its own runtime assumptions; retain as a pinned reference until an isolated adapter exists.",
  },
  {
    id: "graphify",
    name: "Graphify",
    repository: "https://github.com/Graphify-Labs/graphify",
    pinnedRevision: "92741d162b2094ffc2fed58cfbd8ee823e9da62c",
    license: "Apache-2.0",
    mode: "external-runtime",
    category: "codebase-understanding",
    summary:
      "Builds a queryable knowledge graph from source code and related project files.",
    sourceIncluded: false,
    notes:
      "Optional runtime with separate dependencies. Do not execute imported scripts automatically; implement and test an isolated adapter first.",
  },
  {
    id: "mattpocock-skills",
    name: "Matt Pocock Skills",
    repository: "https://github.com/mattpocock/skills",
    pinnedRevision: "5beb35b040e3de97e54fa9e386d7e42d15c295c2",
    license: "MIT",
    mode: "vendored-skill-pack",
    category: "engineering-skills",
    summary:
      "Skills for codebase design, debugging, specification, code review, and test-driven development.",
    sourceIncluded: true,
    notes:
      "Pinned Git submodule. Selected skills are loaded as bounded, untrusted supplemental instructions.",
  },
  {
    id: "claude-mem",
    name: "claude-mem",
    repository: "https://github.com/thedotmack/claude-mem",
    pinnedRevision: "c12d2dd58b9188dbe705f59d0e02e945f68df466",
    license: "Apache-2.0",
    mode: "external-runtime",
    category: "persistent-memory",
    summary:
      "Persistent cross-session memory and context retrieval for multiple agent harnesses.",
    sourceIncluded: false,
    notes:
      "Very large project with a separate runtime. Evaluate privacy, storage, deployment, and resource costs before optional installation.",
  },
  {
    id: "claude-plugins-official",
    name: "Claude Code Official Plugins",
    repository: "https://github.com/anthropics/claude-plugins-official",
    pinnedRevision: "58267944f92187b7d6a1c822165c96c81c864806",
    license: "Apache-2.0",
    mode: "plugin-adapter-required",
    category: "plugin-marketplace",
    summary: "Anthropic-managed directory of Claude Code plugin bundles.",
    sourceIncluded: false,
    notes:
      "Discovery source only. Check each plugin's dependencies, permissions, and licensing before enabling.",
  },
  {
    id: "awesome-mcp-servers",
    name: "Awesome MCP Servers",
    repository: "https://github.com/punkpeye/awesome-mcp-servers",
    pinnedRevision: "f225f117f92626e6b7d5d2912746d9269e3d037b",
    license: "MIT",
    mode: "discovery-catalog",
    category: "tool-integrations",
    summary:
      "A broad index of Model Context Protocol servers for connecting external tools.",
    sourceIncluded: false,
    notes:
      "Catalogue license is not a license grant for linked servers. Prefer reviewed official servers with least-privileged credentials.",
  },
  {
    id: "addyosmani-agent-skills",
    name: "Addy Osmani Agent Skills",
    repository: "https://github.com/addyosmani/agent-skills",
    pinnedRevision: "aeac41d4d005999432bb7312f7ff06383a91d59d",
    license: "MIT",
    mode: "vendored-skill-pack",
    category: "engineering-skills",
    summary:
      "Production-focused skills for debugging, planning, testing, security, documentation, and release.",
    sourceIncluded: true,
    notes:
      "Pinned Git submodule. Kurochan loads selected SKILL.md instructions only.",
  },
  {
    id: "context7",
    name: "Context7",
    repository: "https://github.com/upstash/context7",
    pinnedRevision: "b5e81de845092694ba1bfc5af15400f319c89b6d",
    license: "MIT",
    mode: "external-runtime",
    category: "documentation-context",
    summary:
      "Provides version-aware library documentation through a dedicated MCP service.",
    sourceIncluded: false,
    notes:
      "Configure as a separate server through Kurochan's existing MCP bridge; do not embed its runtime into the API process.",
  },
  {
    id: "playwright-mcp",
    name: "Microsoft Playwright MCP",
    repository: "https://github.com/microsoft/playwright-mcp",
    pinnedRevision: "0c4107acbecb75472b23c05c0e42471a0011874f",
    license: "Apache-2.0",
    mode: "external-runtime",
    category: "browser-testing",
    summary:
      "Browser inspection and automation for UI and end-to-end verification.",
    sourceIncluded: false,
    notes:
      "Configure through the existing MCP bridge with test-environment boundaries and approval for state-changing actions.",
  },
  {
    id: "github-mcp-server",
    name: "GitHub MCP Server",
    repository: "https://github.com/github/github-mcp-server",
    pinnedRevision: "f38526264abb14961b32cea386e38ec6d3cf674f",
    license: "MIT",
    mode: "external-runtime",
    category: "repository-tools",
    summary: "Official GitHub tools exposed through MCP.",
    sourceIncluded: false,
    notes:
      "Compare with Kurochan's native GitHub tools before enabling to avoid duplicated capabilities and permissions.",
  },
];

export interface CommunityPackListOptions {
  readonly query?: string;
  readonly mode?: CommunityPackMode;
  readonly limit?: number;
}

export function listCommunityPacks(
  options: CommunityPackListOptions = {},
): readonly CommunityPack[] {
  const query = options.query?.trim().toLowerCase() ?? "";
  const limit = options.limit ?? 100;

  if (query.length > 200) {
    throw new Error("Community pack query must not exceed 200 characters.");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Community pack limit must be between 1 and 100.");
  }
  if (options.mode && !COMMUNITY_PACK_MODES.includes(options.mode)) {
    throw new Error("Community pack mode is invalid.");
  }

  return PACKS.filter((pack) => {
    if (options.mode && pack.mode !== options.mode) return false;
    if (!query) return true;
    return [
      pack.id,
      pack.name,
      pack.repository,
      pack.category,
      pack.summary,
      pack.notes,
    ].some((value) => value.toLowerCase().includes(query));
  })
    .map((pack) => {
      const name = pack.name.toLowerCase();
      const score =
        (name === query ? 20 : 0) +
        (name.includes(query) ? 8 : 0) +
        (pack.id.includes(query) ? 6 : 0) +
        (pack.category.includes(query) ? 3 : 0);
      return { pack, score };
    })
    .sort((a, b) => b.score - a.score || a.pack.name.localeCompare(b.pack.name))
    .slice(0, limit)
    .map(({ pack }) => ({ ...pack }));
}

export function getCommunityPack(id: string): CommunityPack | undefined {
  if (typeof id !== "string" || id.length > 100) return undefined;
  const pack = PACKS.find((candidate) => candidate.id === id);
  return pack ? { ...pack } : undefined;
}

export interface CommunityMcpPreset {
  readonly id: string;
  readonly packId: string;
  readonly name: string;
  readonly summary: string;
  readonly transport: "stdio" | "streamable-http";
  readonly configuration: Readonly<Record<string, unknown>>;
  readonly requiredEnvironment: readonly {
    readonly name: string;
    readonly purpose: string;
  }[];
  readonly notes: string;
}

const MCP_PRESETS: readonly CommunityMcpPreset[] = [
  {
    id: "context7",
    packId: "context7",
    name: "Context7 Documentation MCP",
    summary:
      "Version-aware library documentation for better API and framework implementations.",
    transport: "streamable-http",
    configuration: {
      id: "context7",
      name: "Context7 Documentation",
      transport: "streamable-http",
      url: "https://mcp.context7.com/mcp",
      headers: { Authorization: "CONTEXT7_AUTHORIZATION" },
    },
    requiredEnvironment: [
      {
        name: "CONTEXT7_AUTHORIZATION",
        purpose:
          "Set to 'Bearer <your Context7 API key>' in the server/worker secret environment.",
      },
    ],
    notes:
      "Remote service; no source is executed locally. Configure an API key and review Context7's current usage terms.",
  },
  {
    id: "playwright-mcp",
    packId: "playwright-mcp",
    name: "Microsoft Playwright MCP",
    summary:
      "Browser inspection and repeatable UI workflows for test environments.",
    transport: "stdio",
    configuration: {
      id: "playwright",
      name: "Playwright Browser Testing",
      transport: "stdio",
      command: "npx",
      args: ["--yes", "@playwright/mcp@0.0.83"],
      env: {},
    },
    requiredEnvironment: [],
    notes:
      "Requires Node.js and npm/npx on the worker host. The package version is pinned. Use a dedicated test browser/profile and test environment; browser actions can change external state.",
  },
  {
    id: "github-mcp-server",
    packId: "github-mcp-server",
    name: "GitHub MCP Server",
    summary:
      "Official GitHub repository, issue, and pull-request tools through GitHub's hosted MCP endpoint.",
    transport: "streamable-http",
    configuration: {
      id: "github-mcp-server",
      name: "GitHub MCP Server",
      transport: "streamable-http",
      url: "https://api.githubcopilot.com/mcp/",
      headers: { Authorization: "GITHUB_MCP_AUTHORIZATION" },
    },
    requiredEnvironment: [
      {
        name: "GITHUB_MCP_AUTHORIZATION",
        purpose:
          "Set to 'Bearer <least-privilege fine-grained GitHub token>' in the server/worker secret environment.",
      },
    ],
    notes:
      "Use minimal repository permissions and retain per-tool approval for writes. This is separate from Kurochan's native GitHub project connector.",
  },
];

export interface CommunityMcpPresetListOptions {
  readonly query?: string;
  readonly limit?: number;
}

export function listCommunityMcpPresets(
  options: CommunityMcpPresetListOptions = {},
): readonly CommunityMcpPreset[] {
  const query = options.query?.trim().toLowerCase() ?? "";
  const limit = options.limit ?? 100;
  if (query.length > 200) {
    throw new Error(
      "Community MCP preset query must not exceed 200 characters.",
    );
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Community MCP preset limit must be between 1 and 100.");
  }

  return MCP_PRESETS.filter((preset) =>
    [preset.id, preset.packId, preset.name, preset.summary, preset.notes].some(
      (value) => value.toLowerCase().includes(query),
    ),
  )
    .slice(0, limit)
    .map((preset) => ({
      ...preset,
      configuration: { ...preset.configuration },
      requiredEnvironment: preset.requiredEnvironment.map((item) => ({
        ...item,
      })),
    }));
}

export function getCommunityMcpPreset(
  id: string,
): CommunityMcpPreset | undefined {
  if (typeof id !== "string" || id.length > 100) return undefined;
  const preset = MCP_PRESETS.find((candidate) => candidate.id === id);
  return preset
    ? {
        ...preset,
        configuration: { ...preset.configuration },
        requiredEnvironment: preset.requiredEnvironment.map((item) => ({
          ...item,
        })),
      }
    : undefined;
}

export interface CommunitySkillSummary {
  readonly id: string;
  readonly packId: string;
  readonly packName: string;
  readonly name: string;
  readonly description: string;
  readonly sourcePath: string;
  readonly repository: string;
  readonly pinnedRevision: string;
}

export interface CommunitySkill extends CommunitySkillSummary {
  readonly content: string;
}

interface SkillSource {
  readonly packId: string;
  readonly packName: string;
  readonly repository: string;
  readonly pinnedRevision: string;
  readonly relativeRoot: string;
}

const SKILL_SOURCES: readonly SkillSource[] = [
  {
    packId: "superpowers",
    packName: "Superpowers",
    repository: "https://github.com/obra/superpowers",
    pinnedRevision: "2ce8aa15d05bd57213e6f746f953aafb7ded7a8b",
    relativeRoot: "vendor/community/superpowers/skills",
  },
  {
    packId: "wshobson-agents",
    packName: "wshobson/agents",
    repository: "https://github.com/wshobson/agents",
    pinnedRevision: "0874a27b17a22e2b7c2e2bcd725768e0803cad06",
    relativeRoot: "vendor/community/wshobson-agents/plugins",
  },
  {
    packId: "mattpocock-skills",
    packName: "Matt Pocock Skills",
    repository: "https://github.com/mattpocock/skills",
    pinnedRevision: "5beb35b040e3de97e54fa9e386d7e42d15c295c2",
    relativeRoot: "vendor/community/mattpocock-skills/skills",
  },
  {
    packId: "addyosmani-agent-skills",
    packName: "Addy Osmani Agent Skills",
    repository: "https://github.com/addyosmani/agent-skills",
    pinnedRevision: "aeac41d4d005999432bb7312f7ff06383a91d59d",
    relativeRoot: "vendor/community/addyosmani-agent-skills/skills",
  },
];

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "code",
  "do",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "please",
  "that",
  "the",
  "their",
  "this",
  "to",
  "up",
  "use",
  "using",
  "we",
  "with",
  "you",
  "your",
]);

function textTerms(value: string): string[] {
  return [
    ...new Set(value.toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? []),
  ].filter((term) => !STOP_WORDS.has(term));
}

function scalar(frontmatter: string, key: string): string | undefined {
  const match = frontmatter.match(new RegExp("^" + key + ":\\s*(.+)$", "im"));
  const value = match?.[1]?.trim();
  if (
    !value ||
    value === "|" ||
    value === ">" ||
    value === "|-" ||
    value === ">-"
  ) {
    return undefined;
  }
  return value.replace(/^["']|["']$/g, "").slice(0, 600);
}

function parseSkill(
  source: SkillSource,
  root: string,
  filePath: string,
  raw: string,
): CommunitySkill | undefined {
  if (raw.length > 60_000) return undefined;
  const front = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
  if (!front) return undefined;
  const body = raw.slice(front[0].length).trim();
  if (!body) return undefined;

  const pathFromRoot = relative(root, filePath).split(sep).join("/");
  if (
    !pathFromRoot ||
    pathFromRoot.startsWith("../") ||
    isAbsolute(pathFromRoot)
  ) {
    return undefined;
  }
  const folderName = pathFromRoot.split("/").slice(-2, -1)[0] ?? "skill";
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const name = scalar(front[1] ?? "", "name") ?? heading ?? folderName;
  const description =
    scalar(front[1] ?? "", "description") ??
    body
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith("#")) ??
    "Reusable workflow guidance.";
  const id =
    source.packId +
    ":" +
    pathFromRoot.replace(/\/SKILL\.md$/i, "").toLowerCase();

  return {
    id,
    packId: source.packId,
    packName: source.packName,
    name: name.slice(0, 160),
    description: description.slice(0, 600),
    sourcePath: pathFromRoot,
    repository: source.repository,
    pinnedRevision: source.pinnedRevision,
    content: body.slice(0, 7_000),
  };
}

function scoreSkill(skill: CommunitySkill, query: string): number {
  const terms = textTerms(query);
  const lowerName = skill.name.toLowerCase();
  const lowerDescription = skill.description.toLowerCase();
  const lowerPath = skill.sourcePath.toLowerCase();
  const lowerBody = skill.content.slice(0, 2_500).toLowerCase();
  const aliases: string[] = [];
  if (/\b(debug|debugging|bug|broken|failure|crash|error|fix)\b/i.test(query)) {
    aliases.push("debugging", "systematic", "diagnosing", "error");
  }
  if (/\b(test|testing|tdd|verify|verification|regression)\b/i.test(query)) {
    aliases.push("test", "testing", "verification", "tdd");
  }
  if (/\b(review|audit|quality|secure|security)\b/i.test(query)) {
    aliases.push("review", "security", "quality", "audit");
  }
  if (/\b(plan|planning|design|architecture|brainstorm)\b/i.test(query)) {
    aliases.push("planning", "brainstorming", "architecture", "spec");
  }
  if (/\b(research|docs|documentation|api|library)\b/i.test(query)) {
    aliases.push("research", "docs", "documentation", "grill-with-docs");
  }
  const allTerms = [...new Set([...terms, ...aliases])];
  let score = lowerName.includes(query.toLowerCase()) ? 16 : 0;
  for (const term of allTerms) {
    if (lowerName.includes(term)) score += 7;
    if (lowerDescription.includes(term)) score += 4;
    if (lowerPath.includes(term)) score += 3;
    if (lowerBody.includes(term)) score += 1;
  }
  return score;
}

export interface CommunitySkillStatus {
  readonly packId: string;
  readonly available: boolean;
  readonly skillCount: number;
}

export class CommunitySkillCatalog {
  private readonly repositoryRoot: string;
  private readonly maxFiles: number;
  private loadPromise: Promise<CommunitySkill[]> | undefined;
  private readonly counts = new Map<string, number>();

  constructor(
    options: {
      readonly repositoryRoot?: string;
      readonly maxFiles?: number;
    } = {},
  ) {
    this.repositoryRoot = resolve(options.repositoryRoot ?? process.cwd());
    this.maxFiles = options.maxFiles ?? 2_000;
    if (
      !Number.isInteger(this.maxFiles) ||
      this.maxFiles < 1 ||
      this.maxFiles > 10_000
    ) {
      throw new Error(
        "Community skill file limit must be between 1 and 10000.",
      );
    }
  }

  async status(): Promise<readonly CommunitySkillStatus[]> {
    await this.load();
    return SKILL_SOURCES.map((source) => {
      const skillCount = this.counts.get(source.packId) ?? 0;
      return { packId: source.packId, available: skillCount > 0, skillCount };
    });
  }

  async search(
    query: string,
    limit = 30,
  ): Promise<readonly CommunitySkillSummary[]> {
    const normalized = query.trim();
    if (!normalized || normalized.length > 200) {
      throw new Error(
        "Community skill query must contain 1 to 200 characters.",
      );
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Community skill limit must be between 1 and 100.");
    }

    const skills = await this.load();
    return skills
      .map((skill) => ({ skill, score: scoreSkill(skill, normalized) }))
      .filter((entry) => entry.score > 0)
      .sort(
        (a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name),
      )
      .slice(0, limit)
      .map(({ skill }) => this.summary(skill));
  }

  async selectForTask(
    taskDescription: string,
    options: {
      readonly maxSkills?: number;
      readonly maxCharacters?: number;
    } = {},
  ): Promise<readonly CommunitySkill[]> {
    const query = taskDescription.trim();
    if (!query || query.length > 10_000) return [];
    const maxSkills = options.maxSkills ?? 3;
    const maxCharacters = options.maxCharacters ?? 12_000;
    if (!Number.isInteger(maxSkills) || maxSkills < 1 || maxSkills > 5) {
      throw new Error(
        "Community skill selection limit must be between 1 and 5.",
      );
    }
    if (
      !Number.isInteger(maxCharacters) ||
      maxCharacters < 1_000 ||
      maxCharacters > 24_000
    ) {
      throw new Error(
        "Community skill context budget must be between 1000 and 24000 characters.",
      );
    }

    const skills = await this.load();
    const scored = skills
      .map((skill) => ({ skill, score: scoreSkill(skill, query) }))
      .filter((entry) => entry.score >= 2)
      .sort(
        (a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name),
      );

    const selected: CommunitySkill[] = [];
    let remaining = maxCharacters;
    for (const { skill } of scored) {
      if (selected.length >= maxSkills || remaining < 300) break;
      const content = skill.content.slice(
        0,
        Math.min(skill.content.length, remaining),
      );
      selected.push({ ...skill, content });
      remaining -= content.length;
    }
    return selected;
  }

  private summary(skill: CommunitySkill): CommunitySkillSummary {
    const { content: _content, ...summary } = skill;
    return summary;
  }

  private load(): Promise<CommunitySkill[]> {
    if (!this.loadPromise) {
      this.loadPromise = this.loadFromDisk().catch((error: unknown) => {
        this.loadPromise = undefined;
        throw error;
      });
    }
    return this.loadPromise;
  }

  private async loadFromDisk(): Promise<CommunitySkill[]> {
    const result: CommunitySkill[] = [];
    this.counts.clear();
    let visitedFiles = 0;

    for (const source of SKILL_SOURCES) {
      const root = resolve(this.repositoryRoot, source.relativeRoot);
      const rootRelative = relative(this.repositoryRoot, root);
      if (
        rootRelative.startsWith(".." + sep) ||
        rootRelative === ".." ||
        isAbsolute(rootRelative)
      ) {
        this.counts.set(source.packId, 0);
        continue;
      }
      const startCount = result.length;
      const visit = async (directory: string, depth: number): Promise<void> => {
        if (depth > 10 || visitedFiles >= this.maxFiles) return;
        let entries;
        try {
          entries = await readdir(directory, { withFileTypes: true });
        } catch {
          return;
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
          if (visitedFiles >= this.maxFiles || entry.isSymbolicLink()) continue;
          const filePath = resolve(directory, entry.name);
          const safeRelative = relative(root, filePath);
          if (
            safeRelative === ".." ||
            safeRelative.startsWith(".." + sep) ||
            isAbsolute(safeRelative)
          ) {
            continue;
          }
          if (entry.isDirectory()) {
            await visit(filePath, depth + 1);
          } else if (
            entry.isFile() &&
            entry.name.toLowerCase() === "skill.md"
          ) {
            visitedFiles += 1;
            try {
              const raw = await readFile(filePath, "utf8");
              const skill = parseSkill(source, root, filePath, raw);
              if (skill) result.push(skill);
            } catch {
              // One third-party file must not break other installed skills.
            }
          }
        }
      };
      await visit(root, 0);
      this.counts.set(source.packId, result.length - startCount);
    }
    return result;
  }
}
