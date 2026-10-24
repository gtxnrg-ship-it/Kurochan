import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type OAuthProviderId = "github" | "google";
export type PrincipalProvider = OAuthProviderId | "local";

export interface AuthPrincipal {
  readonly userId: string;
  readonly provider: PrincipalProvider;
  readonly displayName: string;
  readonly email?: string;
  readonly expiresAt?: number;
}

export interface OAuthPublicStatus {
  readonly enabled: boolean;
  readonly sessionDurationSeconds: number;
  readonly providers: readonly {
    readonly id: OAuthProviderId;
    readonly name: string;
    readonly configured: boolean;
  }[];
}

export class OAuthError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "OAuthError";
    this.code = code;
    this.status = status;
  }
}

interface ProviderConfig {
  readonly id: OAuthProviderId;
  readonly clientId: string;
  readonly clientSecret: string;
}

interface TokenPayload {
  readonly iss: "kurochan";
  readonly sub: string;
  readonly provider: OAuthProviderId;
  readonly name: string;
  readonly email?: string;
  readonly iat: number;
  readonly exp: number;
}

const SESSION_SECONDS = 8 * 60 * 60;
const STATE_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 60 * 1000;
const MAX_PENDING = 1000;
const COOKIE_PREFIX = "kurochan_oauth_state_";

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function originOf(raw: string | undefined): string | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const url = new URL(raw.trim());
    const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
      url.hostname.toLowerCase(),
    );
    if (url.username || url.password || url.search || url.hash) return undefined;
    if (url.pathname !== "/" && url.pathname !== "") return undefined;
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

function isLoopback(origin: string): boolean {
  try {
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
      new URL(origin).hostname.toLowerCase(),
    );
  } catch {
    return false;
  }
}

function randomCode(): string {
  return randomBytes(32).toString("base64url");
}

function decodeBase64Url(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  try {
    return Buffer.from(value, "base64url");
  } catch {
    return undefined;
  }
}

export function readOAuthStateCookie(
  cookieHeader: string | undefined,
  provider: OAuthProviderId,
): string | undefined {
  const cookieName = COOKIE_PREFIX + provider;
  for (const part of (cookieHeader ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== cookieName) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function clearOAuthStateCookie(
  provider: OAuthProviderId,
  secure: boolean,
): string {
  return COOKIE_PREFIX + provider + "=; Path=/auth; Max-Age=0; HttpOnly; SameSite=Lax" +
    (secure ? "; Secure" : "");
}

export function isOAuthEnvironmentConfigured(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  const secret = env.KUROCHAN_SESSION_SECRET?.trim() ?? "";
  const apiOrigin = originOf(env.KUROCHAN_PUBLIC_API_URL);
  const webOrigin = originOf(env.WEB_ORIGIN);
  if (secret.length < 32 || !apiOrigin || !webOrigin) return false;
  if (!isLoopback(apiOrigin) && (!apiOrigin.startsWith("https://") || !webOrigin.startsWith("https://"))) {
    return false;
  }
  const github = Boolean(
    env.GITHUB_OAUTH_CLIENT_ID?.trim() && env.GITHUB_OAUTH_CLIENT_SECRET?.trim(),
  );
  const google = Boolean(
    env.GOOGLE_OAUTH_CLIENT_ID?.trim() && env.GOOGLE_OAUTH_CLIENT_SECRET?.trim(),
  );
  return github || google;
}

export class OAuthService {
  private readonly secret: string;
  private readonly apiOrigin: string | undefined;
  private readonly webOrigin: string | undefined;
  private readonly providers = new Map<OAuthProviderId, ProviderConfig>();
  private readonly states = new Map<string, { provider: OAuthProviderId; at: number }>();
  private readonly codes = new Map<string, { principal: Omit<AuthPrincipal, "expiresAt">; expiresAt: number }>();

  constructor(
    private readonly env: Readonly<Record<string, string | undefined>>,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly now: () => number = Date.now,
  ) {
    this.secret = env.KUROCHAN_SESSION_SECRET?.trim() ?? "";
    this.apiOrigin = originOf(env.KUROCHAN_PUBLIC_API_URL);
    this.webOrigin = originOf(env.WEB_ORIGIN);
    const githubId = env.GITHUB_OAUTH_CLIENT_ID?.trim() ?? "";
    const githubSecret = env.GITHUB_OAUTH_CLIENT_SECRET?.trim() ?? "";
    if (githubId && githubSecret) {
      this.providers.set("github", {
        id: "github",
        clientId: githubId,
        clientSecret: githubSecret,
      });
    }
    const googleId = env.GOOGLE_OAUTH_CLIENT_ID?.trim() ?? "";
    const googleSecret = env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() ?? "";
    if (googleId && googleSecret) {
      this.providers.set("google", {
        id: "google",
        clientId: googleId,
        clientSecret: googleSecret,
      });
    }
  }

  get isEnabled(): boolean {
    return this.secret.length >= 32 &&
      Boolean(this.apiOrigin && this.webOrigin) &&
      isOAuthEnvironmentConfigured(this.env);
  }

  get usesHttps(): boolean {
    return Boolean(this.apiOrigin?.startsWith("https://"));
  }

  publicStatus(): OAuthPublicStatus {
    const enabled = this.isEnabled;
    return {
      enabled,
      sessionDurationSeconds: SESSION_SECONDS,
      providers: (["github", "google"] as const).map((id) => ({
        id,
        name: id === "github" ? "GitHub" : "Google",
        configured: enabled && this.providers.has(id),
      })),
    };
  }

  start(providerId: OAuthProviderId): { url: string; cookie: string } {
    if (!this.isEnabled) {
      throw new OAuthError("oauth_not_configured", "OAuth sign-in is not configured.", 503);
    }
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new OAuthError("oauth_provider_unavailable", "That provider is not configured.", 404);
    }
    this.prune();
    this.makeRoom(this.states);
    const state = randomCode();
    this.states.set(state, { provider: providerId, at: this.now() });
    const callback = this.callbackUrl(providerId);
    const url = providerId === "github"
      ? new URL("https://github.com/login/oauth/authorize")
      : new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", provider.clientId);
    url.searchParams.set("redirect_uri", callback);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);
    if (providerId === "github") {
      url.searchParams.set("scope", "read:user user:email");
      url.searchParams.set("allow_signup", "true");
    } else {
      url.searchParams.set("scope", "openid email profile");
      url.searchParams.set("prompt", "select_account");
    }
    const cookie = COOKIE_PREFIX + providerId + "=" + encodeURIComponent(state) +
      "; Path=/auth; Max-Age=600; HttpOnly; SameSite=Lax" +
      (this.usesHttps ? "; Secure" : "");
    return { url: url.toString(), cookie };
  }

  async callback(
    providerId: OAuthProviderId,
    code: string,
    state: string,
    cookieState: string | undefined,
  ): Promise<{ redirectUrl: string; clearCookie: string }> {
    if (!this.isEnabled || !this.providers.has(providerId)) {
      throw new OAuthError("oauth_not_configured", "Sign-in is not configured.", 503);
    }
    if (!code || code.length > 4096 || !state || state.length > 200 ||
        !cookieState || !secureEqual(state, cookieState)) {
      throw new OAuthError("oauth_state_invalid", "Sign-in state validation failed.");
    }
    const pending = this.states.get(state);
    this.states.delete(state);
    if (!pending || pending.provider !== providerId || this.now() - pending.at > STATE_TTL_MS) {
      throw new OAuthError("oauth_state_expired", "Sign-in expired. Please try again.");
    }
    const principal = providerId === "github"
      ? await this.githubIdentity(code)
      : await this.googleIdentity(code);
    this.prune();
    this.makeRoom(this.codes);
    const oneTimeCode = randomCode();
    this.codes.set(oneTimeCode, { principal, expiresAt: this.now() + CODE_TTL_MS });
    return {
      redirectUrl: this.webOrigin + "/#auth_code=" + encodeURIComponent(oneTimeCode),
      clearCookie: clearOAuthStateCookie(providerId, this.usesHttps),
    };
  }

  exchangeCode(code: string): { token: string; user: AuthPrincipal; expiresAt: number } {
    if (!this.isEnabled) {
      throw new OAuthError("oauth_not_configured", "Sign-in is not configured.", 503);
    }
    const pending = this.codes.get(code);
    this.codes.delete(code);
    if (!pending || pending.expiresAt <= this.now()) {
      throw new OAuthError("oauth_code_expired", "That sign-in code expired or was already used.", 400);
    }
    const issuedAt = Math.floor(this.now() / 1000);
    const expiresAt = issuedAt + SESSION_SECONDS;
    const payload: TokenPayload = {
      iss: "kurochan",
      sub: pending.principal.userId,
      provider: pending.principal.provider as OAuthProviderId,
      name: pending.principal.displayName,
      ...(pending.principal.email ? { email: pending.principal.email } : {}),
      iat: issuedAt,
      exp: expiresAt,
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = createHmac("sha256", this.secret).update(encoded).digest("base64url");
    return {
      token: encoded + "." + signature,
      user: { ...pending.principal, expiresAt: expiresAt * 1000 },
      expiresAt: expiresAt * 1000,
    };
  }

  verifySessionToken(token: string): AuthPrincipal | undefined {
    if (!this.isEnabled || !token || token.length > 8192) return undefined;
    const parts = token.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
    const decoded = decodeBase64Url(parts[0]);
    if (!decoded) return undefined;
    const expected = createHmac("sha256", this.secret).update(parts[0]).digest("base64url");
    if (!secureEqual(parts[1], expected)) return undefined;
    let value: unknown;
    try { value = JSON.parse(decoded.toString("utf8")); } catch { return undefined; }
    if (!value || typeof value !== "object") return undefined;
    const payload = value as Partial<TokenPayload>;
    const now = Math.floor(this.now() / 1000);
    if (
      payload.iss !== "kurochan" ||
      typeof payload.sub !== "string" ||
      !/^(github|google):[A-Za-z0-9._:-]{1,200}$/.test(payload.sub) ||
      (payload.provider !== "github" && payload.provider !== "google") ||
      !payload.sub.startsWith(payload.provider + ":") ||
      typeof payload.name !== "string" || !payload.name.trim() ||
      typeof payload.iat !== "number" || !Number.isInteger(payload.iat) ||
      payload.iat > now + 60 ||
      typeof payload.exp !== "number" || !Number.isInteger(payload.exp) ||
      payload.exp <= now || payload.exp - payload.iat > SESSION_SECONDS
    ) return undefined;
    return {
      userId: payload.sub,
      provider: payload.provider,
      displayName: payload.name.slice(0, 200),
      ...(typeof payload.email === "string" && payload.email.length <= 320 ? { email: payload.email } : {}),
      expiresAt: payload.exp * 1000,
    };
  }

  signInErrorRedirect(code = "oauth_failed"): string {
    const allowed = new Set([
      "oauth_failed", "oauth_not_configured", "oauth_provider_unavailable",
      "oauth_state_invalid", "oauth_state_expired", "email_not_verified",
    ]);
    const reason = allowed.has(code) ? code : "oauth_failed";
    return (this.webOrigin ?? "http://127.0.0.1:5173") + "/#auth_error=" + encodeURIComponent(reason);
  }

  private callbackUrl(provider: OAuthProviderId): string {
    return this.apiOrigin + "/auth/" + provider + "/callback";
  }

  private async githubIdentity(code: string): Promise<Omit<AuthPrincipal, "expiresAt">> {
    const provider = this.providers.get("github");
    if (!provider) throw new OAuthError("oauth_provider_unavailable", "GitHub sign-in is unavailable.", 503);
    const response = await this.fetchImpl("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: provider.clientId, client_secret: provider.clientSecret,
        code, redirect_uri: this.callbackUrl("github"),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new OAuthError("oauth_exchange_failed", "GitHub sign-in could not be completed.", 502);
    const token = await response.json() as Record<string, unknown>;
    const accessToken = typeof token.access_token === "string" ? token.access_token : "";
    if (!accessToken || token.error) {
      throw new OAuthError("oauth_exchange_failed", "GitHub sign-in could not be completed.", 502);
    }
    const userResponse = await this.fetchImpl("https://api.github.com/user", {
      headers: {
        authorization: "Bearer " + accessToken,
        accept: "application/vnd.github+json",
        "user-agent": "Kuro-chan",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!userResponse.ok) throw new OAuthError("oauth_identity_failed", "GitHub identity could not be verified.", 502);
    const user = await userResponse.json() as Record<string, unknown>;
    if (!(typeof user.id === "number" || (typeof user.id === "string" && /^\d+$/.test(user.id))) ||
        !Number.isSafeInteger(Number(user.id))) {
      throw new OAuthError("oauth_identity_failed", "GitHub identity could not be verified.", 502);
    }
    let email: string | undefined;
    try {
      const emailResponse = await this.fetchImpl("https://api.github.com/user/emails", {
        headers: {
          authorization: "Bearer " + accessToken,
          accept: "application/vnd.github+json",
          "user-agent": "Kuro-chan",
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (emailResponse.ok) {
        const list = await emailResponse.json() as unknown;
        if (Array.isArray(list)) {
          const primary = list.find((item) => item && typeof item === "object" &&
            (item as Record<string, unknown>).primary === true &&
            (item as Record<string, unknown>).verified === true &&
            typeof (item as Record<string, unknown>).email === "string") as Record<string, unknown> | undefined;
          if (primary) email = (primary.email as string).slice(0, 320);
        }
      }
    } catch {
      // A verified GitHub ID is sufficient when no email is disclosed.
    }
    const displayName = (typeof user.name === "string" && user.name.trim()) ||
      (typeof user.login === "string" && user.login.trim()) || "GitHub user";
    return {
      userId: "github:" + String(user.id),
      provider: "github",
      displayName: displayName.slice(0, 200),
      ...(email ? { email } : {}),
    };
  }

  private async googleIdentity(code: string): Promise<Omit<AuthPrincipal, "expiresAt">> {
    const provider = this.providers.get("google");
    if (!provider) throw new OAuthError("oauth_provider_unavailable", "Google sign-in is unavailable.", 503);
    const form = new URLSearchParams({
      client_id: provider.clientId, client_secret: provider.clientSecret, code,
      redirect_uri: this.callbackUrl("google"), grant_type: "authorization_code",
    });
    const response = await this.fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new OAuthError("oauth_exchange_failed", "Google sign-in could not be completed.", 502);
    const token = await response.json() as Record<string, unknown>;
    const accessToken = typeof token.access_token === "string" ? token.access_token : "";
    if (!accessToken) throw new OAuthError("oauth_exchange_failed", "Google sign-in could not be completed.", 502);
    const userResponse = await this.fetchImpl("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { authorization: "Bearer " + accessToken, accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!userResponse.ok) throw new OAuthError("oauth_identity_failed", "Google identity could not be verified.", 502);
    const user = await userResponse.json() as Record<string, unknown>;
    if (typeof user.sub !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(user.sub) ||
        user.email_verified !== true || typeof user.email !== "string" ||
        !user.email.trim() || user.email.length > 320) {
      throw new OAuthError("email_not_verified", "Google must return a verified email address to sign in.", 403);
    }
    const displayName = (typeof user.name === "string" && user.name.trim()) || user.email;
    return {
      userId: "google:" + user.sub,
      provider: "google",
      displayName: displayName.slice(0, 200),
      email: user.email.trim().toLowerCase(),
    };
  }

  private prune(): void {
    const now = this.now();
    for (const [key, entry] of this.states) {
      if (now - entry.at > STATE_TTL_MS) this.states.delete(key);
    }
    for (const [key, entry] of this.codes) {
      if (entry.expiresAt <= now) this.codes.delete(key);
    }
  }

  private makeRoom<T>(map: Map<string, T>): void {
    while (map.size >= MAX_PENDING) {
      const key = map.keys().next().value;
      if (!key) break;
      map.delete(key);
    }
  }
}
