import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type Server, type RequestListener } from "node:http";
import { once } from "node:events";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import { openDatabase } from "../src/db/connection.js";
import { authSessions } from "../src/db/schema.js";
import { loadAuthConfig, type AuthConfig } from "../src/modules/auth/auth-config.js";
import { readinessToken } from "../src/modules/auth/readiness-token.js";
import {
  checkHealth,
  loadHealthMonitorConfig,
  type HealthMonitorConfig,
} from "../src/modules/operations/health-monitor.js";

let directory: string;
const servers: Server[] = [];
const apps: ReturnType<typeof buildApp>[] = [];
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "hub-monitor-")));
});
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  rmSync(directory, { recursive: true, force: true });
});
function authConfig(origin = "http://localhost"): AuthConfig {
  return {
    sourcePath: join(directory, "auth.json"),
    origin,
    sessionSecret: randomBytes(32).toString("hex"),
    password: { salt: "00".repeat(16), hash: "00".repeat(64) },
  };
}
function appWithAuth(auth = authConfig()) {
  const databasePath = join(directory, "state.sqlite");
  const app = buildApp({ databasePath, auth });
  apps.push(app);
  return { app, auth, databasePath };
}
async function receiver(handler: RequestListener): Promise<HealthMonitorConfig> {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    bearerToken: readinessToken(authConfig()),
    timeoutMs: 1000,
  };
}
const signal = () => new AbortController().signal;
const ready = () => ({
  status: "ok",
  database: "ok",
  checkedAt: new Date().toISOString(),
});
function writeConfig(config: HealthMonitorConfig, path = join(directory, "monitor.json")) {
  writeFileSync(path, JSON.stringify({ version: 1, ...config }), {
    mode: 0o600,
  });
  return path;
}
const runCli = (args: string[]) =>
  promisify(execFile)(process.execPath, ["--import", "tsx", "src/monitor-cli.ts", ...args], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    timeout: 8000,
    maxBuffer: 65536,
  });

test("a scoped token reads readiness without a browser session or persistent session rows", async () => {
  const { app, auth, databasePath } = appWithAuth();
  const response = await app.inject({
    method: "GET",
    url: "/health/ready",
    headers: { authorization: `Bearer ${readinessToken(auth)}` },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ status: "ok", database: "ok" });
  expect(response.headers["set-cookie"]).toBeUndefined();
  expect(response.headers["cache-control"]).toBe("no-store");
  const database = openDatabase(databasePath);
  try {
    expect(database.db.select().from(authSessions).all()).toEqual([]);
  } finally {
    database.close();
  }
});

test("the monitor token grants no private read, write, HEAD or session authentication", async () => {
  const { app, auth } = appWithAuth();
  const headers = { authorization: `Bearer ${readinessToken(auth)}` };
  for (const request of [
    { method: "GET" as const, url: "/projects" },
    { method: "GET" as const, url: "/execution" },
    { method: "HEAD" as const, url: "/health/ready" },
    {
      method: "POST" as const,
      url: "/projects",
      payload: { name: "Unallowed", workspaceKey: "unallowed" },
    },
  ])
    expect((await app.inject({ ...request, headers })).statusCode).toBe(401);
  expect(
    (await app.inject({ method: "GET", url: "/auth/session", headers })).json().authenticated,
  ).toBe(false);
});

test("readiness token still requires the configured Host and same-origin metadata", async () => {
  const { app, auth } = appWithAuth();
  for (const header of [
    { host: "other.example" },
    { origin: "https://other.example" },
    { "sec-fetch-site": "cross-site" },
  ]) {
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/health/ready",
          headers: {
            authorization: `Bearer ${readinessToken(auth)}`,
            ...header,
          },
        })
      ).statusCode,
    ).toBe(403);
  }
});

test("malformed, foreign and revoked readiness credentials never become a browser login", async () => {
  const { app, auth } = appWithAuth();
  const token = readinessToken(auth);
  for (const value of [
    undefined,
    "Bearer short",
    `Bearer ${token}x`,
    `Basic ${token}`,
    `Bearer ${readinessToken(authConfig())}`,
    `Bearer ${readinessToken({ ...auth, origin: "https://other.example" })}`,
  ]) {
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/health/ready",
          headers: value ? { authorization: value } : {},
        })
      ).statusCode,
    ).toBe(401);
  }
  await app.close();
  apps.splice(apps.indexOf(app), 1);
  const rotated = appWithAuth({
    ...auth,
    sessionSecret: randomBytes(32).toString("hex"),
  });
  expect(
    (
      await rotated.app.inject({
        method: "GET",
        url: "/health/ready",
        headers: { authorization: `Bearer ${token}` },
      })
    ).statusCode,
  ).toBe(401);
});

test("a valid token observes a real database failure as unavailable", async () => {
  const { app, auth, databasePath } = appWithAuth();
  await app.ready();
  const database = openDatabase(databasePath);
  try {
    database.client.exec("DROP TABLE events");
  } finally {
    database.close();
  }
  const response = await app.inject({
    method: "GET",
    url: "/health/ready",
    headers: { authorization: `Bearer ${readinessToken(auth)}` },
  });
  expect(response.statusCode).toBe(503);
  expect(response.json()).toMatchObject({
    status: "unavailable",
    database: "unavailable",
  });
  expect(response.body).not.toContain(databasePath);
});

test("external HTTP check targets only readiness and returns no remote data or credential", async () => {
  let observed: { url: string | undefined; authorization: string | undefined } | undefined;
  const config = await receiver((req, res) => {
    observed = { url: req.url, authorization: req.headers.authorization };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(ready()));
  });
  const result = await checkHealth(config, signal());
  expect(observed).toEqual({
    url: "/health/ready",
    authorization: `Bearer ${config.bearerToken}`,
  });
  expect(result).toEqual({
    status: "available",
    reason: "ready",
    checkedAt: expect.any(String),
  });
  expect(JSON.stringify(result)).not.toContain(config.bearerToken);
  expect(JSON.stringify(result)).not.toContain(config.origin);
});

test.each([
  [401, "authentication_required"],
  [403, "authentication_required"],
  [500, "http_error"],
  [302, "redirect_refused"],
] as const)(
  "classifies HTTP %s and never follows an untrusted response",
  async (status, reason) => {
    let redirected = 0;
    const target = await receiver((_req, res) => {
      redirected++;
      res.end("private-remote-content");
    });
    const config = await receiver((_req, res) => {
      res.writeHead(status, { location: target.origin });
      res.end("private-remote-content");
    });
    expect(await checkHealth(config, signal())).toMatchObject({
      status: "unavailable",
      reason,
    });
    expect(redirected).toBe(0);
  },
);

test("a structured 503 distinguishes database unavailability from successful readiness", async () => {
  const config = await receiver((_req, res) => {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ...ready(),
        status: "unavailable",
        database: "unavailable",
      }),
    );
  });
  expect(await checkHealth(config, signal())).toMatchObject({
    reason: "database_unavailable",
  });
});

test.each([
  "extra-fields",
  "wrong-state",
  "bad-time",
  "invalid-json",
  "wrong-type",
  "large-chunked",
  "large-declared",
])("refuses %s replies without returning their contents", async (mode) => {
  const config = await receiver((_req, res) => {
    res.setHeader("content-type", mode === "wrong-type" ? "text/html" : "application/json");
    if (mode === "large-declared") res.setHeader("content-length", "5000");
    const body =
      mode === "extra-fields"
        ? { ...ready(), secret: "private-response" }
        : mode === "wrong-state"
          ? { ...ready(), database: "unavailable" }
          : mode === "bad-time"
            ? { ...ready(), checkedAt: "yesterday" }
            : ready();
    if (mode.startsWith("large")) {
      res.write("x".repeat(4097));
      res.end();
    } else res.end(mode === "invalid-json" ? "private-response" : JSON.stringify(body));
  });
  const result = await checkHealth(config, signal());
  expect(result).toMatchObject({
    status: "unavailable",
    reason: mode.startsWith("large") ? "response_too_large" : "invalid_response",
  });
  expect(JSON.stringify(result)).not.toContain("private-response");
});

test.each(["headers", "body"])("a stalled %s response has a bounded deadline", async (mode) => {
  const config = await receiver((_req, res) => {
    if (mode === "body") {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{");
    }
  });
  expect(await checkHealth({ ...config, timeoutMs: 100 }, signal())).toMatchObject({
    status: "unavailable",
    reason: "timeout",
  });
});

test("an unreachable service and a cancelled monitor have distinct safe results", async () => {
  const config = await receiver((_req, res) => res.end());
  const server = servers.pop()!;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  expect(await checkHealth(config, signal())).toMatchObject({
    reason: "request_failed",
  });
  const stopped = new AbortController();
  stopped.abort();
  expect(await checkHealth(config, stopped.signal)).toMatchObject({
    reason: "stopped",
  });
});

test("monitor settings require a private regular file and accept HTTPS or local HTTP only", () => {
  const config = {
    origin: "https://hub.example",
    bearerToken: readinessToken(authConfig()),
    timeoutMs: 3000,
  };
  const path = writeConfig(config);
  expect(loadHealthMonitorConfig(path)).toEqual(config);
  chmodSync(path, 0o644);
  expect(() => loadHealthMonitorConfig(path)).toThrow("private");
  chmodSync(path, 0o600);
  const link = join(directory, "link.json");
  symlinkSync(path, link);
  expect(() => loadHealthMonitorConfig(link)).toThrow();
  for (const overrides of [
    { origin: "http://remote.example" },
    { origin: "https://hub.example/path" },
    { origin: "https://example:YOUR_PASSWORD@hub.example" },
    { bearerToken: "invalid" },
    { timeoutMs: 0 },
    { timeoutMs: 10001 },
    { unknown: true },
  ]) {
    writeFileSync(path, JSON.stringify({ version: 1, ...config, ...overrides }));
    expect(() => loadHealthMonitorConfig(path)).toThrow();
  }
});

test("actual setup CLI exports only a scoped credential into a private file", async () => {
  const auth = authConfig();
  const source = JSON.stringify({
    version: 1,
    origin: auth.origin,
    sessionSecret: auth.sessionSecret,
    password: auth.password,
  });
  writeFileSync(auth.sourcePath, source, { mode: 0o600 });
  const destination = join(directory, "monitor.json");
  const result = await runCli([
    "setup",
    "--auth-config",
    auth.sourcePath,
    "--destination",
    destination,
  ]);
  const config = loadHealthMonitorConfig(destination);
  expect(config.bearerToken).toBe(readinessToken(loadAuthConfig(auth.sourcePath)));
  expect(statSync(destination).mode & 0o777).toBe(0o600);
  expect(readFileSync(auth.sourcePath, "utf8")).toBe(source);
  for (const secret of [auth.sessionSecret, auth.password.hash, config.bearerToken])
    expect(result.stdout + result.stderr).not.toContain(secret);
  expect(readFileSync(destination, "utf8")).not.toContain(auth.sessionSecret);
});

test("actual setup CLI refuses to replace an existing destination", async () => {
  const auth = authConfig();
  writeFileSync(auth.sourcePath, JSON.stringify({ version: 1, ...auth, sourcePath: undefined }), {
    mode: 0o600,
  });
  const destination = join(directory, "existing.json");
  writeFileSync(destination, "original", { mode: 0o600 });
  await expect(
    runCli(["setup", "--auth-config", auth.sourcePath, "--destination", destination]),
  ).rejects.toMatchObject({ code: 2 });
  expect(readFileSync(destination, "utf8")).toBe("original");
});

test("actual check CLI reports success with exit zero", async () => {
  const config = await receiver((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(ready()));
  });
  const result = await runCli(["check", "--config", writeConfig(config)]);
  expect(JSON.parse(result.stdout)).toMatchObject({
    status: "available",
    reason: "ready",
  });
  expect(result.stderr).toBe("");
});

test("actual check CLI reports failure with exit one and no private response", async () => {
  const config = await receiver((_req, res) => {
    res.writeHead(500);
    res.end("private-response");
  });
  try {
    await runCli(["check", "--config", writeConfig(config)]);
    throw new Error("Expected CLI failure");
  } catch (error) {
    expect(error).toMatchObject({ code: 1, stderr: "" });
    const output = (error as { stdout: string }).stdout;
    expect(JSON.parse(output)).toMatchObject({
      status: "unavailable",
      reason: "http_error",
    });
    expect(output).not.toContain("private-response");
    expect(output).not.toContain(config.bearerToken);
  }
});
