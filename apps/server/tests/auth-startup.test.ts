import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { loadAuthConfig } from "../src/modules/auth/auth-config.js";
import { verifyPassword } from "../src/modules/auth/password.js";

const serverDirectory = fileURLToPath(new URL("../", import.meta.url));
let directory: string;
const children: ChildProcess[] = [];
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "hub-auth-startup-"));
});
afterEach(async () => {
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null) {
      const ended = once(child, "exit");
      child.kill("SIGTERM");
      await ended;
    }
  rmSync(directory, { recursive: true, force: true });
});
function launch(file: string, args: string[] = [], overrides: NodeJS.ProcessEnv = {}) {
  const env = { ...process.env };
  delete env.AUTH_CONFIG;
  delete env.LOCAL_API_ONLY;
  delete env.EXECUTION_CONFIG;
  delete env.NOTIFICATION_CONFIG;
  const child = spawn(process.execPath, ["--import", "tsx", `src/${file}`, ...args], {
    cwd: serverDirectory,
    env: { ...env, DATABASE_PATH: join(directory, "hub.sqlite"), ...overrides },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  child.stdout!.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr!.on("data", (chunk) => {
    output += chunk;
  });
  return { child, completed: once(child, "exit"), output: () => output };
}
async function freePort() {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP listener");
  await new Promise<void>((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

test("setup reads a private password from stdin, writes only its hash and refuses to overwrite credentials", async () => {
  const file = join(directory, "auth.json");
  const password = "startup-fixture-password-only";
  const args = ["--config", file, "--origin", "http://127.0.0.1:3000", "--password-stdin"];
  const first = launch("auth-setup-cli.ts", args);
  first.child.stdin!.end(password + "\n");
  expect((await first.completed)[0]).toBe(0);
  expect(first.output()).not.toContain(password);
  const original = readFileSync(file, "utf8");
  expect(original).not.toContain(password);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(await verifyPassword(password, loadAuthConfig(file).password)).toBe(true);
  const repeat = launch("auth-setup-cli.ts", args);
  repeat.child.stdin!.end("another-fixture-password\n");
  expect((await repeat.completed)[0]).toBe(1);
  expect(readFileSync(file, "utf8")).toBe(original);
});

test("the server refuses implicit anonymous access and explicit local API mode rejects cross-site writes", async () => {
  const missing = launch("main.ts");
  expect((await missing.completed)[0]).toBe(1);
  expect(missing.output()).toContain("AUTH_CONFIG");
  const port = await freePort();
  const running = launch("main.ts", [], { PORT: String(port), LOCAL_API_ONLY: "1" });
  await vi.waitFor(() => expect(running.output()).toContain("Server listening"), { timeout: 5000 });
  const base = `http://127.0.0.1:${port}`;
  expect((await fetch(`${base}/health/ready`)).status).toBe(200);
  expect(
    (
      await fetch(`${base}/projects`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://other.example" },
        body: JSON.stringify({ name: "Example", workspaceKey: "example" }),
      })
    ).status,
  ).toBe(403);
  running.child.kill("SIGTERM");
  expect((await running.completed)[0]).toBe(0);
});

test("the actual HTTP server accepts login, protected writes and logout with its configured origin", async () => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const file = join(directory, "auth.json");
  const password = "http-fixture-password-only";
  const setup = launch("auth-setup-cli.ts", [
    "--config",
    file,
    "--origin",
    origin,
    "--password-stdin",
  ]);
  setup.child.stdin!.end(password);
  expect((await setup.completed)[0]).toBe(0);
  const running = launch("main.ts", [], { PORT: String(port), AUTH_CONFIG: file });
  await vi.waitFor(() => expect(running.output()).toContain("Server listening"), { timeout: 5000 });
  expect((await fetch(`${origin}/projects`)).status).toBe(401);
  const initial = await fetch(`${origin}/auth/session`);
  const csrf = ((await initial.json()) as { csrfToken: string }).csrfToken;
  const login = await fetch(`${origin}/auth/login`, {
    method: "POST",
    headers: {
      cookie: initial.headers.getSetCookie()[0]!.split(";")[0]!,
      "x-csrf-token": csrf,
      origin,
      "content-type": "application/json",
    },
    body: JSON.stringify({ password }),
  });
  expect(login.status).toBe(200);
  const headers = {
    cookie: login.headers.getSetCookie()[0]!.split(";")[0]!,
    "x-csrf-token": ((await login.json()) as { csrfToken: string }).csrfToken,
    origin,
  };
  expect(
    (
      await fetch(`${origin}/projects`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ name: "Example", workspaceKey: "example" }),
      })
    ).status,
  ).toBe(201);
  expect((await fetch(`${origin}/auth/logout`, { method: "POST", headers })).status).toBe(204);
  expect((await fetch(`${origin}/projects`, { headers })).status).toBe(401);
  expect(running.output()).not.toContain(password);
  running.child.kill("SIGTERM");
  expect((await running.completed)[0]).toBe(0);
});
