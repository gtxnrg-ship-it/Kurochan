import { describe, expect, it } from "vitest";
import {
  INTEGRATION_CATALOG,
  buildMcpConfig,
  filterIntegrations,
  resolveIntegrationStatus,
} from "../public/integrations.mjs";

describe("Kuro-chan integration directory", () => {
  it("includes the requested GitHub, Firebase and Supabase integrations", () => {
    expect(INTEGRATION_CATALOG.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        "github-research",
        "github-project",
        "github-mcp-server",
        "firebase",
        "supabase",
      ]),
    );
  });

  it("filters by case-insensitive vendor, category and integration type", () => {
    expect(
      filterIntegrations(INTEGRATION_CATALOG, { query: "FIREBASE" }).map(
        (item) => item.id,
      ),
    ).toEqual(["firebase"]);
    expect(
      filterIntegrations(INTEGRATION_CATALOG, {
        category: "Data & backend",
        kind: "MCP",
      }).map((item) => item.id),
    ).toEqual(expect.arrayContaining(["firebase", "supabase", "postgresql"]));
    expect(
      filterIntegrations(INTEGRATION_CATALOG, { kind: "Built in" }).every(
        (item) => item.kind === "native",
      ),
    ).toBe(true);
  });

  it("builds supported MCP config templates using environment variable names, never secret values", () => {
    const supabase = INTEGRATION_CATALOG.find((item) => item.id === "supabase");
    const firebase = INTEGRATION_CATALOG.find((item) => item.id === "firebase");
    const supabaseConfig = buildMcpConfig(supabase);
    const firebaseConfig = buildMcpConfig(firebase);

    expect(supabaseConfig).toMatchObject({
      id: "supabase",
      transport: "streamable-http",
      url: "https://mcp.supabase.com/mcp?read_only=true&project_ref=YOUR_PROJECT_REF",
      headers: { Authorization: "SUPABASE_MCP_AUTHORIZATION" },
    });
    expect(JSON.stringify(supabaseConfig)).not.toContain("Bearer ");
    expect(firebaseConfig).toMatchObject({
      id: "firebase",
      transport: "stdio",
      command: "npx",
      args: ["-y", "firebase-tools@latest", "mcp"],
    });
    expect(
      buildMcpConfig(INTEGRATION_CATALOG.find((item) => item.id === "figma")),
    ).toBeNull();
  });

  it("distinguishes configured, unprobed and OAuth-blocked MCP services", () => {
    const supabase = INTEGRATION_CATALOG.find((item) => item.id === "supabase");
    const figma = INTEGRATION_CATALOG.find((item) => item.id === "figma");
    const connected = resolveIntegrationStatus(supabase, {
      mcp: {
        servers: [
          {
            id: "supabase",
            name: "Supabase",
            connected: true,
            toolCount: 8,
          },
        ],
      },
    });
    const unprobed = resolveIntegrationStatus(supabase, {
      mcp: {
        servers: [{ id: "supabase", name: "Supabase", connected: false }],
      },
    });
    const oauth = resolveIntegrationStatus(figma, {});

    expect(connected).toMatchObject({
      label: "Connected",
      tone: "success",
    });
    expect(unprobed).toMatchObject({
      label: "Probe to verify",
      tone: "neutral",
    });
    expect(oauth).toMatchObject({
      label: "OAuth support needed",
      tone: "warning",
    });
  });

  it("reports GitHub write access as needing setup until the native connector is configured", () => {
    const github = INTEGRATION_CATALOG.find(
      (item) => item.id === "github-project",
    );
    expect(
      resolveIntegrationStatus(github, { research: { githubProject: {} } }),
    ).toMatchObject({
      label: "Needs setup",
      tone: "neutral",
    });
    expect(
      resolveIntegrationStatus(github, {
        research: {
          githubProject: { configured: true, publishingEnabled: false },
        },
      }),
    ).toMatchObject({
      label: "Configured",
      detail: expect.stringContaining("publishing remains disabled"),
    });
  });
});
