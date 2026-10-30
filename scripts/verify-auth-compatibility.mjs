import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

// Exercise the application's real configuration without live credentials or users.
process.env.NODE_ENV = "production";
process.env.VERCEL_URL = "auth-check.example.invalid";
process.env.VERCEL_BRANCH_URL = "auth-check.example.invalid";
process.env.VERCEL_PROJECT_PRODUCTION_URL = "auth-check.example.invalid";
process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("hex");
process.env.VERCEL_APP_CLIENT_ID = "compatibility-test-client";
process.env.VERCEL_APP_CLIENT_SECRET = randomBytes(32).toString("hex");

const origin = "https://auth-check.example.invalid";
const calls = [];
const originalFetch = globalThis.fetch;
// These two response shapes follow the versioned Vercel provider implementation:
// https://github.com/better-auth/better-auth/blob/v1.7.7/packages/core/src/social-providers/vercel.ts
// This fixture checks application wiring, not the real Vercel OAuth service.
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  calls.push(url.href);
  if (url.href === "https://api.vercel.com/login/oauth/token") {
    assert.equal(init?.method, "POST");
    return Response.json({
      access_token: "fixture-access-token",
      token_type: "Bearer",
      expires_in: 3600,
    });
  }
  if (url.href === "https://api.vercel.com/login/oauth/userinfo") {
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-access-token");
    return Response.json({
      sub: "fixture-user",
      name: "Compatibility User",
      email: "compatibility@example.invalid",
      email_verified: true,
    });
  }
  throw new Error(`Unexpected external request: ${url.origin}${url.pathname}`);
};

const cookies = new Map();
function updateCookies(response) {
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(";", 1)[0];
    const separator = pair.indexOf("=");
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    if (value === "" || /max-age=0(?:;|$)/i.test(cookie)) cookies.delete(name);
    else cookies.set(name, value);
  }
}
function request(path, { method = "GET", body, cookie = true } = {}) {
  const headers = new Headers({ host: new URL(origin).host, origin });
  if (cookie) headers.set("cookie", [...cookies].map(([name, value]) => `${name}=${value}`).join("; "));
  if (body) headers.set("content-type", "application/json");
  return new Request(origin + path, { method, headers, body: body && JSON.stringify(body) });
}

try {
  const { auth } = await import(new URL("../lib/auth.ts", import.meta.url));
  assert.equal(await auth.api.getSession({ headers: request("/").headers }), null);
  const signIn = await auth.handler(request("/api/auth/sign-in/social", {
    method: "POST", body: { provider: "vercel", callbackURL: origin + "/", disableRedirect: true },
  }));
  assert.equal(signIn.status, 200);
  updateCookies(signIn);
  const authorization = new URL((await signIn.json()).url);
  assert.equal(authorization.origin, "https://vercel.com");
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorization.searchParams.get("redirect_uri"), origin + "/api/auth/callback/vercel");
  const state = authorization.searchParams.get("state");
  assert.ok(state);
  const callback = await auth.handler(request(`/api/auth/callback/vercel?code=fixture-code&state=${encodeURIComponent(state)}`));
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get("location"), origin + "/");
  updateCookies(callback);
  const session = await auth.api.getSession({ headers: request("/").headers });
  assert.equal(session?.user.email, "compatibility@example.invalid");
  assert.equal(session.user.emailVerified, true);
  assert.ok(session.user.id);
  assert.equal((await auth.handler(request("/api/auth/get-session"))).status, 200);
  assert.equal((await auth.handler(request("/api/auth/get-session", { cookie: false }))).status, 200);
  assert.equal(await auth.api.getSession({ headers: request("/", { cookie: false }).headers }), null);

  // Cookie-cache data alone must not authenticate after the session token is lost.
  const tokenName = [...cookies.keys()].find((name) => name.endsWith(".session_token"));
  assert.ok(tokenName);
  const tokenValue = cookies.get(tokenName);
  cookies.delete(tokenName);
  assert.equal(await auth.api.getSession({ headers: request("/").headers }), null);
  cookies.set(tokenName, tokenValue);

  const signOut = await auth.handler(request("/api/auth/sign-out", { method: "POST", body: {} }));
  assert.equal(signOut.status, 200);
  updateCookies(signOut);
  assert.equal(await auth.api.getSession({ headers: request("/").headers }), null);
  assert.deepEqual(calls, ["https://api.vercel.com/login/oauth/token", "https://api.vercel.com/login/oauth/userinfo"]);
  console.log("PASS: application auth configuration, PKCE initiation, fixture OAuth callback, stateless JWE session, missing-token rejection, sign-out");
} finally {
  globalThis.fetch = originalFetch;
}
