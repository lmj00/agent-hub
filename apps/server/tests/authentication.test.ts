import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { openDatabase } from "../src/db/connection.js";
import { authSessions } from "../src/db/schema.js";
import { loadAuthConfig, validateOrigin, type AuthConfig } from "../src/modules/auth/auth-config.js";
import { createDrizzleSessionStore } from "../src/modules/auth/drizzle-session-store.js";
import { hashPassword, verifyPassword, type PasswordHash } from "../src/modules/auth/password.js";
import type { Session } from "fastify";

const password = "fixture-password-for-tests-only";
let passwordHash: PasswordHash;
let directory: string;
let databasePath: string;
let auth: AuthConfig;
let app: ReturnType<typeof buildApp>;
let database: ReturnType<typeof openDatabase>;
beforeAll(async () => { passwordHash = await hashPassword(password); });
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "hub-auth-"))); databasePath = join(directory, "hub.sqlite");
  const config = { version: 1, origin: "http://localhost", sessionSecret: randomBytes(32).toString("hex"), password: passwordHash };
  const path = join(directory, "auth.json"); writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
  auth = loadAuthConfig(path); database = openDatabase(databasePath); app = buildApp({ databasePath, auth });
});
afterEach(async () => { await app.close(); database.close(); rmSync(directory, { recursive: true, force: true }); vi.useRealTimers(); });

type Browser = { cookie: string; csrfToken: string };
function browser(response: { headers: Record<string, unknown>; json: () => { csrfToken: string } }): Browser {
  const setCookie = response.headers["set-cookie"];
  const value = Array.isArray(setCookie) ? setCookie.find((value: string) => value.startsWith("agent_hub_session=")) : setCookie;
  return { cookie: String(value).split(";")[0]!, csrfToken: response.json().csrfToken };
}
async function anonymous() { return browser(await app.inject({ method: "GET", url: "/auth/session" })); }
async function login(session?: Browser) {
  const current = session ?? await anonymous();
  const response = await app.inject({ method: "POST", url: "/auth/login", headers: { cookie: current.cookie, "x-csrf-token": current.csrfToken, origin: auth.origin }, payload: { password } });
  expect(response.statusCode).toBe(200);
  return { ...browser(response), response };
}

test("only liveness and authentication endpoints are public; private reads and writes require a session", async () => {
  expect((await app.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200);
  for (const url of ["/health/ready", "/projects", "/execution", "/execution/provider-gate", "/projects/00000000-0000-4000-8000-000000000001/services", "/projects/00000000-0000-4000-8000-000000000001/budget", "/projects/00000000-0000-4000-8000-000000000001/goals", "/goals/00000000-0000-4000-8000-000000000001/revisions"]) {
    const response = await app.inject({ method: "GET", url }); expect(response.statusCode).toBe(401);
    expect(response.headers["cache-control"]).toBe("no-store");
  }
  expect((await app.inject({ method: "POST", url: "/projects", payload: { name: "Example", workspaceKey: "example" } })).statusCode).toBe(401);
  const response = await app.inject({ method: "GET", url: "/auth/session" });
  expect(response.json()).toMatchObject({ authenticated: false, expiresAt: null, csrfToken: expect.any(String) });
  expect(JSON.stringify(response.json())).not.toContain(auth.sessionSecret);
  expect(JSON.stringify(response.json())).not.toContain(passwordHash.hash);
});

test("login rotates the session and CSRF secret; logout revokes a copied authenticated cookie", async () => {
  const before = await anonymous(); const signedIn = await login(before);
  expect(signedIn.cookie).not.toBe(before.cookie); expect(signedIn.csrfToken).not.toBe(before.csrfToken);
  expect(signedIn.response.headers["set-cookie"]).toContain("HttpOnly");
  expect(signedIn.response.headers["set-cookie"]).toContain("SameSite=Strict");
  expect((await app.inject({ method: "GET", url: "/projects", headers: { cookie: before.cookie } })).statusCode).toBe(401);
  expect((await app.inject({ method: "GET", url: "/projects", headers: { cookie: signedIn.cookie } })).statusCode).toBe(200);
  const logout = await app.inject({ method: "POST", url: "/auth/logout", headers: { cookie: signedIn.cookie, "x-csrf-token": signedIn.csrfToken } });
  expect(logout.statusCode).toBe(204); expect(database.db.select().from(authSessions).all()).toEqual([]);
  expect((await app.inject({ method: "GET", url: "/projects", headers: { cookie: signedIn.cookie } })).statusCode).toBe(401);
});

test("session persistence survives restart but absolute expiry is not extended by polling", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); const start = Date.now();
  const signedIn = await login(); await app.close(); app = buildApp({ databasePath, auth });
  vi.setSystemTime(start + 20 * 60 * 1000);
  expect((await app.inject({ method: "GET", url: "/projects", headers: { cookie: signedIn.cookie } })).statusCode).toBe(200);
  vi.setSystemTime(start + 8 * 60 * 60 * 1000 - 1000);
  expect((await app.inject({ method: "GET", url: "/auth/session", headers: { cookie: signedIn.cookie } })).json().authenticated).toBe(true);
  vi.setSystemTime(start + 8 * 60 * 60 * 1000 + 1000);
  expect((await app.inject({ method: "GET", url: "/projects", headers: { cookie: signedIn.cookie } })).statusCode).toBe(401);
});

test("missing, stale, or cross-session CSRF tokens cannot register a task or sign in", async () => {
  const before = await anonymous(); const signedIn = await login(before); const other = await anonymous();
  for (const csrfToken of [undefined, before.csrfToken, other.csrfToken, "forged"]) {
    const headers = { cookie: signedIn.cookie, ...(csrfToken ? { "x-csrf-token": csrfToken } : {}) };
    const response = await app.inject({ method: "POST", url: "/projects", headers, payload: { name: "Example", workspaceKey: "example" } });
    expect(response.statusCode).toBe(403);
  }
  expect((await app.inject({ method: "POST", url: "/auth/login", payload: { password } })).statusCode).toBe(403);
  expect((await app.inject({ method: "PATCH", url: "/goals/00000000-0000-4000-8000-000000000001", headers: { cookie: signedIn.cookie }, payload: {} })).statusCode).toBe(403);
  expect((await app.inject({ method: "PUT", url: "/projects/00000000-0000-4000-8000-000000000001/budget", headers: { cookie: signedIn.cookie }, payload: {} })).statusCode).toBe(403);
  const created = await app.inject({ method: "POST", url: "/projects", headers: { cookie: signedIn.cookie, "x-csrf-token": signedIn.csrfToken }, payload: { name: "Example", workspaceKey: "example" } });
  expect(created.statusCode).toBe(201);
});

test("Host, Origin and fetch metadata checks reject cross-site requests even with valid credentials", async () => {
  const signedIn = await login();
  for (const header of [{ host: "attacker.example" }, { origin: "https://attacker.example" }, { origin: "null" }, { "sec-fetch-site": "cross-site" }]) {
    const response = await app.inject({ method: "POST", url: "/projects", headers: { cookie: signedIn.cookie, "x-csrf-token": signedIn.csrfToken, ...header }, payload: { name: "Example", workspaceKey: "example" } });
    expect(response.statusCode).toBe(403); expect(response.json().error).toBe("ORIGIN_NOT_ALLOWED");
  }
});

test("incorrect passwords are rejected and repeated attempts are bounded", async () => {
  const session = await anonymous(); const headers = { cookie: session.cookie, "x-csrf-token": session.csrfToken };
  for (let index = 0; index < 5; index++) {
    expect((await app.inject({ method: "POST", url: "/auth/login", headers, payload: { password: "incorrect" } })).statusCode).toBe(401);
  }
  expect((await app.inject({ method: "POST", url: "/auth/login", headers, payload: { password } })).statusCode).toBe(429);
  expect((await app.inject({ method: "GET", url: "/projects", headers })).statusCode).toBe(401);
});

test("a failed session transaction never turns an anonymous session into an authenticated one", async () => {
  const session = await anonymous();
  database.client.exec("CREATE TRIGGER reject_session BEFORE UPDATE ON auth_sessions BEGIN SELECT RAISE(ABORT, 'private fixture secret'); END;");
  const response = await app.inject({ method: "POST", url: "/auth/login", headers: { cookie: session.cookie, "x-csrf-token": session.csrfToken }, payload: { password } });
  expect(response.statusCode).toBe(503); expect(response.body).not.toContain("private fixture");
  expect((await app.inject({ method: "GET", url: "/projects", headers: { cookie: session.cookie } })).statusCode).toBe(401);
});

test("session compare-and-set rejects both stale generations and writes after logout", async () => {
  await anonymous(); const row = database.db.select().from(authSessions).get()!;
  const store = createDrizzleSessionStore(database.db); const data = JSON.parse(row.data) as Session;
  const cas = (generation: string) => new Promise<unknown>(resolve => store.compareAndSet(row.id, generation, data, resolve));
  expect(await cas("obsolete")).toMatchObject({ code: "ENOENT" });
  expect(database.db.select().from(authSessions).get()?.generation).toBe(row.generation);
  await new Promise<void>((resolve, reject) => store.destroy(row.id, error => error ? reject(error) : resolve()));
  expect(await cas(row.generation)).toMatchObject({ code: "ENOENT" });
  expect(database.db.select().from(authSessions).all()).toEqual([]);
});

test("HTTPS uses a secure host-only cookie and accepts forwarding only from a trusted proxy", async () => {
  await app.close(); auth = { ...auth, origin: "https://hub.example" };
  app = buildApp({ databasePath, auth, trustProxy: "loopback" });
  const response = await app.inject({ method: "GET", url: "/auth/session", headers: { host: "hub.example", "x-forwarded-proto": "https" }, remoteAddress: "127.0.0.1" });
  expect(response.statusCode).toBe(200);
  expect(response.headers["set-cookie"]).toContain("__Host-agent_hub_session=");
  expect(response.headers["set-cookie"]).toContain("Secure");
  expect(response.headers["set-cookie"]).not.toContain("Domain=");
  const untrusted = await app.inject({ method: "GET", url: "/auth/session", headers: { host: "hub.example", "x-forwarded-proto": "https" }, remoteAddress: "198.51.100.9" });
  expect(untrusted.headers["set-cookie"]).toBeUndefined();
});

test("authentication config requires a private file, valid origin and exact supported hash format", () => {
  expect(readFileSync(auth.sourcePath, "utf8")).not.toContain(password);
  chmodSync(auth.sourcePath, 0o644); expect(() => loadAuthConfig(auth.sourcePath)).toThrow("private"); chmodSync(auth.sourcePath, 0o600);
  for (const origin of ["http://example.com", "http://localhost/", "http://user:pass@localhost", "https://example.com?x=1", "null"]) {
    expect(() => validateOrigin(origin)).toThrow();
  }
  expect(validateOrigin("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
  const value = JSON.parse(readFileSync(auth.sourcePath, "utf8")); value.password.hash = "invalid"; writeFileSync(auth.sourcePath, JSON.stringify(value));
  expect(() => loadAuthConfig(auth.sourcePath)).toThrow("scrypt");
});

test("password hashing distinguishes correct and incorrect values without retaining plaintext", async () => {
  expect(await verifyPassword(password, passwordHash)).toBe(true);
  expect(await verifyPassword(password + "x", passwordHash)).toBe(false);
  await expect(hashPassword("short")).rejects.toThrow("12 characters");
});
