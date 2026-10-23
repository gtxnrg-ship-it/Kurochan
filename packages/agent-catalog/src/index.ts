import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

export const AGENCY_AGENTS_COMMIT = "4e3ac3ca6604c75113f52c695dbddcc7af928b46";
export const AGENCY_AGENTS_REPOSITORY =
  "https://github.com/msitarzewski/agency-agents";
export const AGENCY_AGENTS_LICENSE = "MIT";

const DEFAULT_ROOT = fileURLToPath(
  new URL("../vendor/agency-agents/", import.meta.url),
);
const DIVISION_ALLOWLIST = new Set([
  "academic",
  "design",
  "engineering",
  "finance",
  "game-development",
  "gis",
  "healthcare",
  "marketing",
  "paid-media",
  "product",
  "project-management",
  "research",
  "sales",
  "security",
  "spatial-computing",
  "specialized",
  "support",
  "testing",
]);

export interface AgentProfile {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly division: string;
  readonly sourcePath: string;
  readonly color?: string;
  readonly emoji?: string;
  readonly vibe?: string;
  readonly sourceSha256: string;
  readonly tools: readonly string[];
}

export interface AgentDefinition extends AgentProfile {
  readonly instructions: string;
}

export interface AgentSearchOptions {
  readonly division?: string;
  readonly limit?: number;
}

export interface AgentCatalogMetadata {
  readonly source: string;
  readonly pinnedCommit: string;
  readonly license: string;
  readonly count: number;
  readonly divisions: readonly { name: string; count: number }[];
}

export interface AgentRunbook {
  readonly slug: string;
  readonly title: string;
  readonly mode: string;
  readonly duration: string;
  readonly summary: string;
  readonly doc: string;
  readonly roster: readonly {
    readonly group: string;
    readonly activation: string;
    readonly agents: readonly string[];
  }[];
}

interface AgentDocument {
  name?: string;
  description?: string;
  color?: string;
  emoji?: string;
  vibe?: string;
  tools?: string | string[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stringField(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function parseFrontmatter(content: string): {
  metadata: AgentDocument;
  instructions: string;
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match)
    throw new Error("Agent profile is missing valid YAML frontmatter.");
  const parsed: unknown = parseYaml(match[1] ?? "");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Agent frontmatter must be a YAML object.");
  }
  const metadata = parsed as AgentDocument;
  const instructions = content.slice(match[0].length).trim();
  if (!instructions) throw new Error("Agent profile has empty instructions.");
  return { metadata, instructions };
}

function toolList(value: unknown): readonly string[] {
  if (Array.isArray(value))
    return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string")
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  return [];
}

function normalizeDivision(value: string): string {
  return value.toLowerCase().replaceAll("_", "-").replaceAll(" ", "-");
}

async function listProfilePaths(root: string): Promise<string[]> {
  const divisions = await readdir(root, { withFileTypes: true });
  const paths: string[] = [];
  for (const division of divisions) {
    if (!division.isDirectory() || !DIVISION_ALLOWLIST.has(division.name))
      continue;
    const directory = resolve(root, division.name);
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children) {
      if (child.isFile() && extname(child.name).toLowerCase() === ".md") {
        paths.push(resolve(directory, child.name));
      }
    }
  }
  return paths.sort((a, b) => a.localeCompare(b));
}

export class AgentCatalog {
  readonly root: string;
  private loadPromise: Promise<AgentDefinition[]> | undefined;

  constructor(root = DEFAULT_ROOT) {
    if (!isAbsolute(root))
      throw new Error("Agent catalog root must be an absolute path.");
    this.root = resolve(root);
  }

  async metadata(): Promise<AgentCatalogMetadata> {
    const agents = await this.load();
    const counts = new Map<string, number>();
    for (const agent of agents)
      counts.set(agent.division, (counts.get(agent.division) ?? 0) + 1);
    return {
      source: AGENCY_AGENTS_REPOSITORY,
      pinnedCommit: AGENCY_AGENTS_COMMIT,
      license: AGENCY_AGENTS_LICENSE,
      count: agents.length,
      divisions: [...counts.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, count]) => ({ name, count })),
    };
  }

  async list(
    options: AgentSearchOptions = {},
  ): Promise<readonly AgentProfile[]> {
    const limit = options.limit ?? 500;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new Error("Agent list limit must be between 1 and 1000.");
    const division = options.division
      ? normalizeDivision(options.division)
      : undefined;
    return (await this.load())
      .filter((agent) => !division || agent.division === division)
      .slice(0, limit)
      .map(({ instructions: _instructions, ...profile }) => profile);
  }

  async get(id: string): Promise<AgentDefinition | undefined> {
    if (
      typeof id !== "string" ||
      id.length > 400 ||
      id.includes("..") ||
      id.startsWith("/") ||
      id.includes("\\")
    ) {
      return undefined;
    }
    return (await this.load()).find((agent) => agent.id === id);
  }

  async search(
    query: string,
    options: AgentSearchOptions = {},
  ): Promise<readonly (AgentProfile & { score: number })[]> {
    const normalized = query
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, " ")
      .replace(/\s+/g, " ");
    if (!normalized) return [];
    const terms = [
      ...new Set(normalized.split(" ").filter((term) => term.length > 1)),
    ];
    if (!terms.length) return [];
    const division = options.division
      ? normalizeDivision(options.division)
      : undefined;
    const limit = options.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error("Agent search limit must be between 1 and 100.");
    const documents = (await this.load()).filter(
      (agent) => !division || agent.division === division,
    );
    const scored = documents
      .map((agent) => {
        const name = agent.name.toLowerCase();
        const id = agent.id.toLowerCase().replaceAll("/", " ");
        const description = agent.description.toLowerCase();
        const vibe = (agent.vibe ?? "").toLowerCase();
        const tools = agent.tools.join(" ").toLowerCase();
        const corpus = `${name} ${id} ${agent.division} ${description} ${vibe} ${tools}`;
        let score = 0;
        for (const term of terms) {
          if (name === term) score += 14;
          else if (name.includes(term)) score += 7;
          if (id.includes(term)) score += 5;
          if (description.includes(term)) score += 3;
          if (agent.division.includes(term)) score += 2;
          if (vibe.includes(term) || tools.includes(term)) score += 1;
          if (!corpus.includes(term)) score -= 0.25;
        }
        if (normalized === name) score += 50;
        return { agent, score };
      })
      .filter((item) => item.score > 0)
      .sort(
        (a, b) => b.score - a.score || a.agent.name.localeCompare(b.agent.name),
      )
      .slice(0, limit);
    return scored.map(({ agent, score }) => {
      const { instructions: _instructions, ...profile } = agent;
      return { ...profile, score };
    });
  }

  async listRunbooks(): Promise<readonly AgentRunbook[]> {
    const file = resolve(this.root, "strategy", "runbooks.json");
    const source = await readFile(file, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(source) as unknown;
    } catch (error) {
      throw new Error("Agency NEXUS runbooks file is not valid JSON.", { cause: error });
    }
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { runbooks?: unknown }).runbooks)) {
      throw new Error("Agency NEXUS runbooks file must contain a runbooks array.");
    }

    const agents = await this.load();
    const idsByStem = new Map<string, string>();
    const ambiguous = new Set<string>();
    for (const agent of agents) {
      const stem = basename(agent.sourcePath, ".md");
      if (idsByStem.has(stem)) ambiguous.add(stem);
      else idsByStem.set(stem, agent.id);
    }

    const runbooks: AgentRunbook[] = [];
    for (const raw of (parsed as { runbooks: unknown[] }).runbooks) {
      if (!raw || typeof raw !== "object") throw new Error("NEXUS runbook entry must be an object.");
      const value = raw as Record<string, unknown>;
      const textFieldValue = (key: string): string => {
        const field = value[key];
        if (typeof field !== "string" || !field.trim()) throw new Error("NEXUS runbook has a missing or invalid " + key + ".");
        return field.trim();
      };
      if (!Array.isArray(value.roster)) throw new Error("NEXUS runbook roster must be an array.");
      const roster = value.roster.map((rawGroup) => {
        if (!rawGroup || typeof rawGroup !== "object") throw new Error("NEXUS runbook roster group must be an object.");
        const group = rawGroup as Record<string, unknown>;
        if (typeof group.group !== "string" || typeof group.activation !== "string" || !Array.isArray(group.agents)) {
          throw new Error("NEXUS runbook roster group has invalid fields.");
        }
        const resolvedAgents = group.agents.map((slug) => {
          if (typeof slug !== "string" || ambiguous.has(slug) || !idsByStem.has(slug)) {
            throw new Error("NEXUS runbook references an unknown or ambiguous agent slug: " + String(slug));
          }
          return idsByStem.get(slug)!;
        });
        return { group: group.group, activation: group.activation, agents: resolvedAgents };
      });
      runbooks.push({
        slug: textFieldValue("slug"),
        title: textFieldValue("title"),
        mode: textFieldValue("mode"),
        duration: textFieldValue("duration"),
        summary: textFieldValue("summary"),
        doc: textFieldValue("doc"),
        roster,
      });
    }
    return runbooks;
  }

  async readNexusStrategy(maxCharacters = 24_000): Promise<string> {
    if (!Number.isInteger(maxCharacters) || maxCharacters < 1000 || maxCharacters > 100_000) {
      throw new Error("NEXUS strategy character limit must be between 1000 and 100000.");
    }
    const strategyPath = resolve(this.root, "strategy", "nexus-strategy.md");
    const strategy = await readFile(strategyPath, "utf8");
    return strategy.slice(0, maxCharacters);
  }

  async reload(): Promise<void> {
    this.loadPromise = undefined;
    await this.load();
  }

  private load(): Promise<AgentDefinition[]> {
    if (!this.loadPromise)
      this.loadPromise = this.loadFromDisk().catch((error: unknown) => {
        this.loadPromise = undefined;
        throw error;
      });
    return this.loadPromise;
  }

  private async loadFromDisk(): Promise<AgentDefinition[]> {
    const rootStat = await stat(this.root).catch(() => undefined);
    if (!rootStat?.isDirectory()) {
      throw new Error(
        `Agency Agents submodule is missing at ${this.root}. Initialize git submodules or configure the catalog root.`,
      );
    }
    const paths = await listProfilePaths(this.root);
    const agents: AgentDefinition[] = [];
    for (const path of paths) {
      const sourcePath = relative(this.root, path).split(sep).join("/");
      const division = normalizeDivision(
        dirname(sourcePath).split(sep).join("/"),
      );
      if (!DIVISION_ALLOWLIST.has(division)) continue;
      const raw = await readFile(path, "utf8");
      const { metadata, instructions } = parseFrontmatter(raw);
      const name = stringField(metadata.name, basename(path, ".md"));
      const id = `${division}/${basename(path, ".md")}`;
      agents.push({
        id,
        name,
        description: stringField(metadata.description, name),
        division,
        sourcePath,
        instructions,
        sourceSha256: sha256(raw),
        ...(typeof metadata.color === "string"
          ? { color: metadata.color }
          : {}),
        ...(typeof metadata.emoji === "string"
          ? { emoji: metadata.emoji }
          : {}),
        ...(typeof metadata.vibe === "string" ? { vibe: metadata.vibe } : {}),
        tools: toolList(metadata.tools),
      });
    }
    if (agents.length === 0)
      throw new Error(
        "Agency Agents catalog is empty; check the pinned submodule checkout.",
      );
    return agents;
  }
}
