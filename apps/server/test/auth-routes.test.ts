import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { RunStore } from "@kurochan/storage";
import {
  OAuthService,
  readOAuthStateCookie,
  type OAuthSessionRevocationStore,
} from "../src/auth.js";
import { buildServer, validateServerConfiguration } from "../src/server.js";

const authEnvironment = {
  HOST: "127.0.0.1",
  PORT: "8787",
  WEB_ORIGIN: "https://app.example.test",
  KUROCHAN_PUBLIC_API_URL: "https://api.example.test",
  KUROCHAN_SESSION_SECRET: "kurochan-integration-session-secret-is-long-enough",
  GITHUB_OAUTH_CLIENT_ID: "github-client-id",
  GITHUB_OAUTH_CLIENT_SECRET: "github-client-secret",
  GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
  GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret",
};

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeOAuth(revocationStore?: OAuthSessionRevocationStore) {
  const fetchImpl = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url === "https://github.com/login/oauth/access_token") {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          code?: string;
        };
        return response({ access_token: "access-" + (body.code ?? "unknown") });
      }
      if (url === "https://api.github.com/user") {
        const authorization =
          new Headers(init?.headers).get("authorization") ?? "";
        const alice = authorization.includes("access-alice-code");
        return response({
          id: alice ? 101 : 202,
          login: alice ? "alice" : "bob",
          name: alice ? "Alice Example" : "Bob Example",
        });
      }
      if (url === "https://api.github.com/user/emails") {
        const authorization =
          new Headers(init?.headers).get("authorization") ?? "";
        return response([
          {
            email: authorization.includes("access-alice-code")
              ? "alice@example.test"
              : "bob@example.test",
            primary: true,
            verified: true,
          },
        ]);
      }
      if (url === "https://oauth2.googleapis.com/token") {
        return response({ access_token: "google-access" });
      }
      if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
        return response({
          sub: "google-user",
          email: "google@example.test",
          email_verified: true,
          name: "Google Example",
        });
      }
      return response({ message: "unexpected test endpoint" }, 404);
    },
  );
  const service = new OAuthService(
    authEnvironment,
    fetchImpl as typeof fetch,
    Date.now,
    revocationStore,
  );
  return { service, fetchImpl };
}

async function issueGithubSession(
  service: OAuthService,
  code: string,
): Promise<string> {
  const start = service.start("github");
  const state = new URL(start.url).searchParams.get("state")!;
  const callback = await service.callback(
    "github",
    code,
    state,
    readOAuthStateCookie(start.cookie, "github"),
  );
  const fragment = new URLSearchParams(callback.redirectUrl.split("#")[1]);
  return service.exchangeCode(fragment.get("auth_code")!).token;
}

describe("Kuro-chan OAuth API", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("reports only public provider configuration and starts OAuth with a protected state cookie", async () => {
    const { service } = makeOAuth();
    app = buildServer({
      env: authEnvironment,
      oauth: service,
      logger: false,
      store: new RunStore(":memory:"),
    });

    const status = await app.inject({ method: "GET", url: "/auth/providers" });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      enabled: true,
      providers: [
        { id: "github", configured: true },
        { id: "google", configured: true },
      ],
    });
    expect(status.body).not.toContain("github-client-secret");
    expect(status.body).not.toContain("kurochan-integration-session-secret");

    const start = await app.inject({
      method: "GET",
      url: "/auth/google/start",
    });
    expect(start.statusCode).toBe(302);
    expect(start.headers.location).toContain(
      "accounts.google.com/o/oauth2/v2/auth",
    );
    expect(start.headers["set-cookie"]).toContain("HttpOnly");
    expect(start.headers["set-cookie"]).toContain("SameSite=Lax");
    expect(start.headers["set-cookie"]).toContain("Secure");
  });

  it("requires a valid account session on protected API routes when OAuth is enabled", async () => {
    const { service } = makeOAuth();
    app = buildServer({
      env: authEnvironment,
      oauth: service,
      logger: false,
      store: new RunStore(":memory:"),
    });

    const response = await app.inject({ method: "GET", url: "/v1/config" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: { code: "unauthorized" },
    });

    const invalidExchange = await app.inject({
      method: "POST",
      url: "/auth/session/exchange",
      payload: { code: "not-a-real-single-use-code" },
    });
    expect(invalidExchange.statusCode).toBe(400);
  });

  it("keeps conversations, runs and artifacts isolated by the signed-in account", async () => {
    const { service } = makeOAuth();
    const aliceToken = await issueGithubSession(service, "alice-code");
    const bobToken = await issueGithubSession(service, "bob-code");
    const store = new RunStore(":memory:");
    store.createConversation({
      id: "conversation-alice",
      title: "Alice's private conversation",
      createdBy: "github:101",
    });
    store.createConversation({
      id: "conversation-bob",
      title: "Bob's private conversation",
      createdBy: "github:202",
    });
    store.createRun({
      id: "run-alice",
      goal: "Alice's private run",
      profile: "balanced",
      createdBy: "github:101",
      tasks: [
        {
          key: "work",
          agentId: "engineering/test-agent",
          objective: "Work only for Alice.",
        },
      ],
    });
    store.recordWorkerHeartbeat(
      "worker-private",
      "busy",
      "task-private",
      { activeRunIds: ["run-alice"], secretInternalMetadata: "private" },
      Date.now(),
    );
    app = buildServer({
      env: authEnvironment,
      oauth: service,
      logger: false,
      store,
    });

    const aliceConversations = await app.inject({
      method: "GET",
      url: "/v1/conversations",
      headers: { authorization: "Bearer " + aliceToken },
    });
    expect(aliceConversations.statusCode).toBe(200);
    expect(
      aliceConversations.json().data.map((item: { id: string }) => item.id),
    ).toEqual(["conversation-alice"]);

    const crossedConversation = await app.inject({
      method: "GET",
      url: "/v1/conversations/conversation-bob",
      headers: { authorization: "Bearer " + aliceToken },
    });
    expect(crossedConversation.statusCode).toBe(404);

    const crossedRun = await app.inject({
      method: "GET",
      url: "/v1/runs/run-alice",
      headers: { authorization: "Bearer " + bobToken },
    });
    expect(crossedRun.statusCode).toBe(404);

    const crossedEvents = await app.inject({
      method: "GET",
      url: "/v1/runs/run-alice/events",
      headers: { authorization: "Bearer " + bobToken },
    });
    expect(crossedEvents.statusCode).toBe(404);

    const crossedArtifacts = await app.inject({
      method: "GET",
      url: "/v1/runs/run-alice/artifacts",
      headers: { authorization: "Bearer " + bobToken },
    });
    expect(crossedArtifacts.statusCode).toBe(404);

    const ownedRun = await app.inject({
      method: "GET",
      url: "/v1/runs/run-alice",
      headers: { authorization: "Bearer " + aliceToken },
    });
    expect(ownedRun.statusCode).toBe(200);
    expect(ownedRun.json().run.createdBy).toBe("github:101");

    const newRun = await app.inject({
      method: "POST",
      url: "/v1/runs",
      headers: { authorization: "Bearer " + aliceToken },
      payload: {
        goal: "Create an Alice-owned run",
        profile: "balanced",
        createdBy: "github:202",
        tasks: [
          {
            key: "work",
            agentId: "game-development/unreal-engine/unreal-world-builder",
            objective: "Create a task in Alice's run.",
          },
        ],
      },
    });
    expect(newRun.statusCode).toBe(201);
    expect(newRun.json().run.createdBy).toBe("github:101");

    const bobRuns = await app.inject({
      method: "GET",
      url: "/v1/runs",
      headers: { authorization: "Bearer " + bobToken },
    });
    expect(bobRuns.statusCode).toBe(200);
    expect(
      bobRuns.json().data.map((run: { id: string }) => run.id),
    ).not.toContain("run-alice");

    const workerList = await app.inject({
      method: "GET",
      url: "/v1/workers",
      headers: { authorization: "Bearer " + bobToken },
    });
    expect(workerList.statusCode).toBe(200);
    expect(workerList.body).not.toContain("task-private");
    expect(workerList.body).not.toContain("run-alice");
    expect(workerList.body).not.toContain("secretInternalMetadata");
    expect(workerList.json().data[0]).not.toHaveProperty("metadata");
    expect(workerList.json().data[0]).not.toHaveProperty("currentTaskId");

    const workerStatus = await app.inject({
      method: "GET",
      url: "/v1/worker/status",
      headers: { authorization: "Bearer " + bobToken },
    });
    expect(workerStatus.statusCode).toBe(200);
    expect(workerStatus.body).not.toContain("task-private");
    expect(workerStatus.body).not.toContain("run-alice");
    expect(workerStatus.body).not.toContain("secretInternalMetadata");
  });

  it("revokes an account session on sign-out and rejects the same token afterward", async () => {
    const store = new RunStore(":memory:");
    try {
      const { service } = makeOAuth(store);
      const token = await issueGithubSession(service, "logout-code");
      app = buildServer({
        env: authEnvironment,
        oauth: service,
        logger: false,
        store,
      });

      const before = await app.inject({
        method: "GET",
        url: "/v1/session",
        headers: { authorization: "Bearer " + token },
      });
      expect(before.statusCode).toBe(200);
      expect(before.json().user.userId).toBe("github:202");

      const logout = await app.inject({
        method: "POST",
        url: "/v1/session/logout",
        headers: { authorization: "Bearer " + token },
        payload: {},
      });
      expect(logout.statusCode).toBe(200);
      expect(logout.json()).toEqual({ signedOut: true, revoked: true });

      const after = await app.inject({
        method: "GET",
        url: "/v1/session",
        headers: { authorization: "Bearer " + token },
      });
      expect(after.statusCode).toBe(401);
    } finally {
      await app?.close();
      app = undefined;
      store.close();
    }
  });

  it("permits a remote bind only when a token or valid OAuth configuration is present", () => {
    expect(() => validateServerConfiguration({ HOST: "0.0.0.0" })).toThrow(
      /KUROCHAN_API_TOKEN/,
    );

    expect(
      validateServerConfiguration({
        ...authEnvironment,
        HOST: "0.0.0.0",
        PORT: "8787",
      }),
    ).toEqual({ host: "0.0.0.0", port: 8787 });
  });
});
