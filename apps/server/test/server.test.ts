import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer, validateServerConfiguration } from "../src/server.js";

describe("Kuro-chan API", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => { await app?.close(); app = undefined; });

  it("returns a liveness response without provider credentials", async () => {
    app = buildServer({ env: { HOST: "127.0.0.1", PORT: "8787" }, logger: false });
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, service: "kurochan-api" });
  });

  it("does not report ready when no provider is configured", async () => {
    app = buildServer({ env: {}, logger: false });
    const response = await app.inject({ method: "GET", url: "/readyz" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ ready: false, configuredProviders: 0 });
  });

  it("provides public, secret-free provider configuration", async () => {
    app = buildServer({ env: { OPENROUTER_API_KEY: "top-secret", OPENROUTER_MODEL: "configured-model" }, logger: false });
    const response = await app.inject({ method: "GET", url: "/v1/config" });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("top-secret");
    expect(response.json().providers).toContainEqual(expect.objectContaining({ id: "openrouter", configured: true }));
  });

  it("requires an API token when one is configured", async () => {
    app = buildServer({ env: { KUROCHAN_API_TOKEN: "test-token" }, logger: false });
    const response = await app.inject({ method: "GET", url: "/v1/models" });
    expect(response.statusCode).toBe(401);
    const ok = await app.inject({ method: "GET", url: "/v1/models", headers: { authorization: "Bearer test-token" } });
    expect(ok.statusCode).toBe(200);
  });

  it("validates external bind safety and port configuration", () => {
    expect(() => validateServerConfiguration({ HOST: "0.0.0.0" })).toThrow(/KUROCHAN_API_TOKEN/);
    expect(validateServerConfiguration({ HOST: "0.0.0.0", KUROCHAN_API_TOKEN: "token", PORT: "8080" }))
      .toEqual({ host: "0.0.0.0", port: 8080 });
    expect(() => validateServerConfiguration({ PORT: "90000" })).toThrow(/PORT/);
  });

  it("validates malformed inference requests before contacting a provider", async () => {
    app = buildServer({ env: {}, logger: false });
    const response = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      payload: { model: "omni/balanced", messages: [] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "invalid_request" } });
  });
});
