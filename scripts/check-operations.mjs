// Run inside docker/operations-check.Dockerfile. No host mounts, network or real credentials.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = "/opt/agent-hub";
const directory = mkdtempSync(join(tmpdir(), "hub-operations-"));
const origin = "https://localhost:8443";
const password = randomBytes(24).toString("hex");
const children = [];
const env = {
  ...process.env,
  NODE_ENV: "production",
  XDG_DATA_HOME: join(directory, "caddy-data"),
  XDG_CONFIG_HOME: join(directory, "caddy-config"),
};
for (const key of [
  "AUTH_CONFIG",
  "EXECUTION_CONFIG",
  "SERVICE_CONFIG",
  "LOCAL_API_ONLY",
  "DATABASE_PATH",
  "PORT",
])
  delete env[key];
const environment = Object.fromEntries(
  readFileSync(join(root, "ops/server.env.example"), "utf8")
    .split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const index = line.indexOf("=");
      return [
        line.slice(0, index),
        line
          .slice(index + 1)
          .replace("/etc/agent-hub", directory)
          .replace("/var/lib/agent-hub", directory),
      ];
    }),
);
const runtime = { ...env, ...environment };
const main = join(root, "apps/server/dist/main.js");

function command(file, args) {
  return execFileSync(file, args, {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 15000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function launch(file, args, childEnv = runtime) {
  const child = spawn(file, args, {
    cwd: root,
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output = (output + chunk).slice(-65536);
  });
  child.stderr.on("data", (chunk) => {
    output = (output + chunk).slice(-65536);
  });
  const ended = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  // Attach before a possible early exit/error; awaiting ended still propagates the failure.
  void ended.catch(() => {});
  const process = { child, ended, output: () => output };
  children.push(process);
  return process;
}
async function waitUntil(check, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error(`Timed out: ${label}`);
}
async function stop(process) {
  if (process.child.exitCode === null && process.child.signalCode === null) {
    process.child.kill("SIGTERM");
    const timer = setTimeout(() => process.child.kill("SIGKILL"), 12000);
    try {
      return await process.ended;
    } finally {
      clearTimeout(timer);
    }
  }
  return process.ended;
}
function http(path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      `${origin}${path}`,
      {
        method,
        headers,
        ca: readFileSync(
          join(env.XDG_DATA_HOME, "caddy/pki/authorities/local/root.crt"),
        ),
        // The fixture CA is trusted explicitly; certificate and hostname validation remain on.
        timeout: 3000,
      },
      (response) => {
        let text = "";
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            text,
            json: () => JSON.parse(text),
          }),
        );
      },
    );
    req.on("error", reject);
    req.on("timeout", () =>
      req.destroy(new Error("HTTPS fixture request timed out")),
    );
    req.end(body);
  });
}
function sessionHeaders(response) {
  const cookie = response.headers["set-cookie"][0].split(";")[0];
  const data = response.json();
  const csrf = data.csrfToken;
  return {
    cookie,
    "x-csrf-token": csrf,
    origin,
    "content-type": "application/json",
  };
}
async function startApp() {
  const process = launch(processExec, [main]);
  await waitUntil(() => {
    assert.equal(process.child.exitCode, null, "App exited before listening");
    return process.output().includes("Server listening");
  }, "app startup");
  return process;
}
const processExec = process.execPath;

try {
  const systemd = command("systemd-analyze", ["--version"]).split("\n")[0];
  command("systemd-analyze", [
    "verify",
    "--man=no",
    join(root, "ops/agent-hub.service"),
  ]);
  command("caddy", [
    "validate",
    "--config",
    join(root, "ops/Caddyfile"),
    "--adapter",
    "caddyfile",
  ]);

  const setup = launch(
    processExec,
    [
      join(root, "apps/server/dist/auth-setup-cli.js"),
      "--config",
      runtime.AUTH_CONFIG,
      "--origin",
      origin,
      "--password-stdin",
    ],
    env,
  );
  setup.child.stdin.end(password);
  assert.equal((await setup.ended).code, 0, "Authentication setup failed");
  mkdirSync(join(directory, "codex"), { mode: 0o700 });
  writeFileSync(
    join(directory, "codex/auth.json"),
    JSON.stringify({ auth_mode: "chatgpt" }),
    { mode: 0o600 },
  );
  writeFileSync(
    runtime.EXECUTION_CONFIG,
    JSON.stringify({
      model: "fixture-no-calls",
      codexHome: join(directory, "codex"),
      workspaces: {},
      containerImage: "unused:no-calls",
    }),
    { mode: 0o600 },
  );

  // Exercise the actual unit's file preconditions with isolated paths. PID 1 supervision is separate.
  const preconditions = readFileSync(
    join(root, "ops/agent-hub.service"),
    "utf8",
  )
    .split("\n")
    .filter((line) => line.startsWith("ExecStartPre="));
  function preflight(values, missingWeb = false) {
    for (const line of preconditions) {
      let expanded = line
        .slice("ExecStartPre=".length)
        .replace(/\$\{(\w+)\}/g, (_, key) => values[key] ?? "");
      if (missingWeb)
        expanded = expanded.replace(
          join(root, "apps/web/dist/index.html"),
          join(directory, "missing-web.html"),
        );
      const [file, ...args] = expanded.split(" ");
      command(file, args);
    }
  }
  preflight(runtime);
  for (const key of ["AUTH_CONFIG", "EXECUTION_CONFIG"]) {
    assert.throws(
      () => preflight({ ...runtime, [key]: "" }),
      `Unset ${key} must fail before starting`,
    );
    assert.throws(
      () => preflight({ ...runtime, [key]: join(directory, "missing-file") }),
      `Missing ${key} must fail before starting`,
    );
  }
  assert.throws(
    () => preflight(runtime, true),
    "Missing web build must fail before starting",
  );
  const absentAuth = launch(processExec, [main], {
    ...runtime,
    AUTH_CONFIG: join(directory, "absent-auth.json"),
  });
  assert.equal((await absentAuth.ended).code, 1);
  const absentExecution = launch(processExec, [main], {
    ...runtime,
    EXECUTION_CONFIG: join(directory, "absent-execution.json"),
  });
  assert.equal((await absentExecution.ended).code, 1);
  const wrongPort = launch(processExec, [main], {
    ...runtime,
    PORT: "invalid",
  });
  assert.equal((await wrongPort.ended).code, 1);
  const invalidState = launch(processExec, [main], {
    ...runtime,
    DATABASE_PATH: join(runtime.AUTH_CONFIG, "invalid.sqlite"),
  });
  assert.equal((await invalidState.ended).code, 1);

  const fixtureCaddy = join(directory, "Caddyfile");
  writeFileSync(
    fixtureCaddy,
    "{\n admin off\n skip_install_trust\n http_port 8080\n https_port 8443\n}\n" +
      readFileSync(join(root, "ops/Caddyfile"), "utf8").replaceAll(
        "agent-hub.example.com",
        "localhost:8443",
      ),
  );
  const caddy = launch(
    "caddy",
    ["run", "--config", fixtureCaddy, "--adapter", "caddyfile"],
    env,
  );
  let app = await startApp();
  await waitUntil(async () => {
    assert.equal(caddy.child.exitCode, null, "Caddy exited before listening");
    if (
      !existsSync(
        join(env.XDG_DATA_HOME, "caddy/pki/authorities/local/root.crt"),
      )
    )
      return false;
    try {
      return (await http("/health/live")).status === 200;
    } catch {
      return false;
    }
  }, "trusted local HTTPS");
  assert.equal((await http("/")).status, 200);
  assert.equal((await http("/health/ready")).status, 401);
  assert.equal((await http("/projects")).status, 401);
  const monitorConfig = join(directory, "monitor.json");
  command(process.execPath, [
    join(root, "apps/server/dist/monitor-cli.js"),
    "setup",
    "--auth-config",
    runtime.AUTH_CONFIG,
    "--destination",
    monitorConfig,
  ]);
  const monitorCredential = JSON.parse(
    readFileSync(monitorConfig, "utf8"),
  ).bearerToken;
  const monitorHeaders = { authorization: `Bearer ${monitorCredential}` };
  assert.equal(
    (await http("/health/ready", { headers: monitorHeaders })).status,
    200,
  );
  assert.equal(
    (await http("/projects", { headers: monitorHeaders })).status,
    401,
  );
  const monitorEnvironment = {
    ...env,
    NODE_EXTRA_CA_CERTS: join(
      env.XDG_DATA_HOME,
      "caddy/pki/authorities/local/root.crt",
    ),
  };
  async function monitor(expectedStatus, expectedReason, trusted = true) {
    const probe = launch(
      process.execPath,
      [
        join(root, "apps/server/dist/monitor-cli.js"),
        "check",
        "--config",
        monitorConfig,
      ],
      trusted ? monitorEnvironment : env,
    );
    const result = await probe.ended;
    assert.equal(result.code, expectedStatus === "available" ? 0 : 1);
    const output = JSON.parse(probe.output());
    assert.equal(output.status, expectedStatus);
    assert.equal(output.reason, expectedReason);
    assert.ok(
      !probe.output().includes(monitorCredential),
      "Monitor credential leaked to output",
    );
  }
  await monitor("unavailable", "request_failed", false);
  await monitor("available", "ready");
  const initial = await http("/auth/session");
  const login = await http("/auth/login", {
    method: "POST",
    headers: sessionHeaders(initial),
    body: JSON.stringify({ password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers["set-cookie"][0];
  assert.ok(cookie.startsWith("__Host-agent_hub_session="));
  assert.match(cookie, /; Secure(?:;|$)/);
  assert.match(cookie, /; HttpOnly(?:;|$)/);
  assert.match(cookie, /; SameSite=Strict(?:;|$)/i);
  assert.doesNotMatch(cookie, /; Domain=/i);
  const headers = sessionHeaders(login);
  assert.equal((await http("/health/ready", { headers })).status, 200);
  assert.equal(
    (
      await http("/projects", {
        method: "POST",
        headers: { ...headers, "x-csrf-token": "invalid" },
        body: JSON.stringify({ name: "Rejected", workspaceKey: "example" }),
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await http("/projects", {
        method: "POST",
        headers: { ...headers, origin: "https://wrong.example" },
        body: JSON.stringify({ name: "Rejected", workspaceKey: "example" }),
      })
    ).status,
    403,
  );
  const created = await http("/projects", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "Operations fixture",
      workspaceKey: "example",
    }),
  });
  assert.equal(created.status, 201);
  assert.equal((await stop(app)).code, 0);
  await monitor("unavailable", "http_error");
  app = await startApp();
  const projects = await http("/projects", { headers });
  assert.equal(
    projects.status,
    200,
    "Session must persist across a clean restart",
  );
  assert.equal(projects.json().projects.length, 1);
  assert.equal(projects.json().projects[0].id, created.json().id);
  assert.equal((await http("/health/ready", { headers })).status, 200);
  await monitor("available", "ready");
  assert.equal((await stop(app)).code, 0);
  assert.equal((await stop(caddy)).code, 0);
  await monitor("unavailable", "request_failed");
  for (const child of children)
    assert.ok(
      !child.output().includes(password),
      "Password leaked to process output",
    );
  console.log(
    JSON.stringify({
      systemd,
      caddy: command("caddy", ["version"]).split(" ")[0],
      node: process.version,
      unitParsed: true,
      preconditionsChecked: true,
      missingConfigRejected: true,
      httpsValidated: true,
      authenticationChecked: true,
      scopedMonitorHttpsChecked: true,
      monitorDetectsAppAndProxyStop: true,
      restartPreservedDataAndSession: true,
      modelCalls: 0,
      systemdSupervisionTested: false,
      publicCertificateTested: false,
    }),
  );
} catch (error) {
  // Never print child output: it can contain auth/session material. Assertion messages carry no tokens.
  console.error(
    `Operations check failed: ${error instanceof Error ? error.message : "unknown failure"}`,
  );
  process.exitCode = 1;
} finally {
  for (const child of children.reverse()) await stop(child);
  rmSync(directory, { recursive: true, force: true });
}
