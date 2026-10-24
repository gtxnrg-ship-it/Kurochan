import { describe, expect, it, vi } from "vitest";
import {
  OAuthError,
  OAuthService,
  isOAuthEnvironmentConfigured,
  readOAuthStateCookie,
} from "../src/auth.js";

const configuredEnvironment = {
  KUROCHAN_SESSION_SECRET: "kurochan-test-session-secret-which-is-long-enough",
  KUROCHAN_PUBLIC_API_URL: "https://api.example.test",
  WEB_ORIGIN: "https://app.example.test",
  GITHUB_OAUTH_CLIENT_ID: "github-client-id",
  GITHUB_OAUTH_CLIENT_SECRET: "github-client-secret",
  GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
  GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret",
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("OAuthService", () => {
  it("does not enable sign-in until a provider, long session secret and HTTPS origins are configured", () => {
    expect(isOAuthEnvironmentConfigured({})).toBe(false);
    expect(
      isOAuthEnvironmentConfigured({
        ...configuredEnvironment,
        KUROCHAN_SESSION_SECRET: "too-short",
      }),
    ).toBe(false);
    expect(
      isOAuthEnvironmentConfigured({
        ...configuredEnvironment,
        KUROCHAN_PUBLIC_API_URL: "http://api.example.test",
      }),
    ).toBe(false);
    expect(
      isOAuthEnvironmentConfigured({
        ...configuredEnvironment,
        GITHUB_OAUTH_CLIENT_ID: "",
        GITHUB_OAUTH_CLIENT_SECRET: "",
        GOOGLE_OAUTH_CLIENT_ID: "",
        GOOGLE_OAUTH_CLIENT_SECRET: "",
      }),
    ).toBe(false);
  });

  it("creates a provider redirect with a random HttpOnly state cookie", () => {
    const service = new OAuthService(configuredEnvironment);
    const first = service.start("github");
    const second = service.start("github");
    const firstUrl = new URL(first.url);

    expect(firstUrl.origin).toBe("https://github.com");
    expect(firstUrl.pathname).toBe("/login/oauth/authorize");
    expect(firstUrl.searchParams.get("client_id")).toBe("github-client-id");
    expect(firstUrl.searchParams.get("redirect_uri")).toBe(
      "https://api.example.test/auth/github/callback",
    );
    expect(firstUrl.searchParams.get("scope")).toBe("read:user user:email");
    expect(firstUrl.searchParams.get("state")).toBeTruthy();
    expect(firstUrl.searchParams.get("state")).not.toBe(
      new URL(second.url).searchParams.get("state"),
    );
    expect(first.cookie).toContain("HttpOnly");
    expect(first.cookie).toContain("SameSite=Lax");
    expect(first.cookie).toContain("Secure");
    expect(readOAuthStateCookie(first.cookie, "github")).toBe(
      firstUrl.searchParams.get("state"),
    );
    expect(service.publicStatus()).toMatchObject({
      enabled: true,
      providers: [
        { id: "github", configured: true },
        { id: "google", configured: true },
      ],
    });
  });

  it("exchanges a GitHub code, verifies identity and only accepts a single-use sign-in code", async () => {
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL): Promise<Response> => {
        const url = String(input);
        if (url === "https://github.com/login/oauth/access_token") {
          return jsonResponse({ access_token: "short-lived-provider-token" });
        }
        if (url === "https://api.github.com/user") {
          return jsonResponse({
            id: 123456,
            login: "kuro-user",
            name: "Kuro User",
          });
        }
        if (url === "https://api.github.com/user/emails") {
          return jsonResponse([
            { email: "kuro-user@example.test", primary: true, verified: true },
            {
              email: "unverified@example.test",
              primary: false,
              verified: false,
            },
          ]);
        }
        return jsonResponse({ error: "unexpected endpoint" }, 404);
      },
    );
    let now = 1_800_000_000_000;
    const service = new OAuthService(
      configuredEnvironment,
      fetchImpl as typeof fetch,
      () => now,
    );
    const start = service.start("github");
    const state = new URL(start.url).searchParams.get("state")!;
    const cookieState = readOAuthStateCookie(start.cookie, "github");
    const callback = await service.callback(
      "github",
      "authorization-code",
      state,
      cookieState,
    );
    const oneTimeCode = new URL(callback.redirectUrl).hash.split(
      "auth_code=",
    )[1];
    expect(oneTimeCode).toBeTruthy();
    expect(callback.redirectUrl).toContain(
      "https://app.example.test/#auth_code=",
    );
    expect(callback.clearCookie).toContain("Max-Age=0");

    const session = service.exchangeCode(decodeURIComponent(oneTimeCode!));
    expect(session.user).toMatchObject({
      userId: "github:123456",
      provider: "github",
      displayName: "Kuro User",
      email: "kuro-user@example.test",
    });
    expect(session.expiresAt).toBe(now + 8 * 60 * 60 * 1000);
    expect(service.verifySessionToken(session.token)).toMatchObject({
      userId: "github:123456",
      provider: "github",
      displayName: "Kuro User",
    });
    expect(session.token).not.toContain("short-lived-provider-token");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(() =>
      service.exchangeCode(decodeURIComponent(oneTimeCode!)),
    ).toThrow(expect.objectContaining({ code: "oauth_code_expired" }));

    now += 8 * 60 * 60 * 1000 + 1;
    expect(service.verifySessionToken(session.token)).toBeUndefined();
  });

  it("rejects state mismatches and consumes the state after a callback attempt", async () => {
    const service = new OAuthService(configuredEnvironment, (async () =>
      jsonResponse({})) as typeof fetch);
    const start = service.start("google");
    const state = new URL(start.url).searchParams.get("state")!;
    await expect(
      service.callback("google", "authorization-code", state, "wrong-state"),
    ).rejects.toMatchObject({ code: "oauth_state_invalid" });
    await expect(
      service.callback(
        "google",
        "authorization-code",
        state,
        readOAuthStateCookie(start.cookie, "google"),
      ),
    ).rejects.toBeInstanceOf(OAuthError);
  });

  it("rejects Google identities without verified email", async () => {
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL): Promise<Response> => {
        const url = String(input);
        if (url === "https://oauth2.googleapis.com/token") {
          return jsonResponse({ access_token: "google-provider-token" });
        }
        if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
          return jsonResponse({
            sub: "google-subject",
            email: "not-verified@example.test",
            email_verified: false,
            name: "Unverified User",
          });
        }
        return jsonResponse({}, 404);
      },
    );
    const service = new OAuthService(
      configuredEnvironment,
      fetchImpl as typeof fetch,
    );
    const start = service.start("google");
    const state = new URL(start.url).searchParams.get("state")!;
    await expect(
      service.callback(
        "google",
        "authorization-code",
        state,
        readOAuthStateCookie(start.cookie, "google"),
      ),
    ).rejects.toMatchObject({ code: "email_not_verified", status: 403 });
  });

  it("rejects modified bearer sessions and does not disclose OAuth configuration secrets", () => {
    const service = new OAuthService(configuredEnvironment);
    const fakeToken =
      Buffer.from(
        JSON.stringify({
          iss: "kurochan",
          sub: "github:1",
          provider: "github",
          name: "A user",
          iat: 1_800_000_000,
          exp: 1_800_028_800,
        }),
      ).toString("base64url") + ".not-a-valid-signature";
    expect(service.verifySessionToken(fakeToken)).toBeUndefined();
    const publicStatus = JSON.stringify(service.publicStatus());
    expect(publicStatus).not.toContain("github-client-secret");
    expect(publicStatus).not.toContain("google-client-secret");
    expect(publicStatus).not.toContain(
      configuredEnvironment.KUROCHAN_SESSION_SECRET,
    );
  });

  it("keeps unavailable providers unavailable instead of silently accepting them", () => {
    const service = new OAuthService({
      ...configuredEnvironment,
      GOOGLE_OAUTH_CLIENT_ID: "",
      GOOGLE_OAUTH_CLIENT_SECRET: "",
    });
    expect(() => service.start("google")).toThrow(
      expect.objectContaining({ code: "oauth_provider_unavailable" }),
    );
  });
});
