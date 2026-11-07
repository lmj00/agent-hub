// Destructive fixture setup is restricted to a disposable GitHub-hosted Linux VM.
// Uses the production unit and real Docker, but only synthetic authentication/model output.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cgroupDirectory, cgroupUsage, hostMemory, treeSize } from "./linux-resource-snapshot.mjs";

const source = fileURLToPath(new URL("../", import.meta.url));
const root = "/opt/agent-hub";
const config = "/etc/agent-hub";
const state = "/var/lib/agent-hub";
const unit = "agent-hub.service";
const unitPath = `/run/systemd/system/${unit}`;
const dropin = `${unitPath}.d`;
const image = "agent-hub-execution-test:local";
const owned = [];
const taskIds = [];
const runIds = [];
let accountCreated = false;
let unitInstalled = false;
let headers = {};
let origin;
let stage = "preflight";
let journalPaths = [];
let scenarioDeadline = Infinity;
const scenarioStarted = performance.now();
const repeatedTasks = 10;

function command(file, args, options = {}) {
  return execFileSync(file, args, {
    encoding: "utf8",
    timeout: 45000,
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}
function systemctl(...args) {
  return command("systemctl", args);
}
function property(name) {
  return systemctl("show", unit, `--property=${name}`, "--value");
}
function absent(path) {
  try {
    lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Refusing existing fixture path: ${path}`);
}
function makeOwned(path, mode = 0o755) {
  // Non-recursive/exclusive creation: cleanup may remove only paths this invocation created.
  mkdirSync(path, { mode });
  owned.push(path);
}
async function waitFor(probe, description, timeout = 30000) {
  const deadline = Math.min(Date.now() + timeout, scenarioDeadline);
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) return result;
    await delay(150);
  }
  throw new Error(`Timed out: ${description}`);
}
async function api(path, body, expected = 200) {
  const response = await fetch(`${origin}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error",
    signal: AbortSignal.timeout(3000),
  });
  assert.equal(response.status, expected, `HTTP ${path}`);
  return { response, value: await response.json() };
}
async function ready() {
  return waitFor(async () => {
    try {
      return (
        await fetch(`${origin}/health/live`, {
          signal: AbortSignal.timeout(1000),
        })
      ).ok;
    } catch {
      return false;
    }
  }, "service HTTP startup");
}
function session(result) {
  const csrf = result.value.csrfToken;
  return {
    cookie: result.response.headers.get("set-cookie").split(";")[0],
    "x-csrf-token": csrf,
    origin,
    "content-type": "application/json",
  };
}
function containers(runId) {
  return command("docker", [
    "ps",
    "--all",
    "--no-trunc",
    "--quiet",
    "--filter",
    `label=io.agent-hub.run=${runId}`,
  ])
    .split("\n")
    .filter(Boolean);
}
function snapshot(phase) {
  const started = performance.now();
  const pid = Number(property("MainPID"));
  const service = pid ? { pid, ...cgroupUsage(cgroupDirectory(pid)) } : null;
  // Listing labels is read-only; inspect only executions owned by this invocation.
  const known = new Set(runIds);
  const ownedContainers = command("docker", [
    "ps", "--all", "--no-trunc", "--filter", "label=io.agent-hub.run",
    "--format", '{{.ID}} {{.Label "io.agent-hub.run"}}',
  ]).split("\n").filter(Boolean).map((line) => line.split(" "))
    .filter(([, runId]) => known.has(runId));
  const executions = ownedContainers.map(([id]) => {
    const containerPid = Number(command("docker", ["inspect", "--format", "{{.State.Pid}}", id]));
    assert.ok(containerPid > 0, "Stopped owned container was not removed");
    return cgroupUsage(cgroupDirectory(containerPid));
  });
  for (const usage of [service, ...executions].filter(Boolean)) {
    assert.equal(usage.oom, 0, "Owned cgroup recorded OOM");
    assert.equal(usage.oomKill, 0, "Owned cgroup recorded OOM kill");
  }
  const sample = {
    kind: "resource-sample", phase,
    elapsedMs: Math.round(started - scenarioStarted),
    host: hostMemory(), service, executions,
    // Metadata only. Opening/closing SQLite files here could invalidate its locks.
    state: treeSize(state),
    database: treeSize(join(state, "hub.sqlite")),
    wal: treeSize(join(state, "hub.sqlite-wal")),
    journals: journalPaths.map((path) => treeSize(path)),
    durationMs: Math.round(performance.now() - started),
  };
  console.log(JSON.stringify(sample));
  return sample;
}

async function completeTask(projectId) {
  const task = (await api(`/projects/${projectId}/tasks`, {
    instruction: "resource-cycle", requestKey: `systemd-${taskIds.length}`,
  }, 201)).value;
  taskIds.push(task.id);
  const run = await waitFor(async () => {
    const { runs } = (await api(`/tasks/${task.id}/runs`)).value;
    assert.ok(runs.length <= 1, "Unexpected retry during repeat workload");
    if (runs[0]?.status !== "succeeded") return false;
    if (containers(runs[0].id).length) return false;
    return (await api(`/runs/${runs[0].id}`)).value;
  }, "repeat task completion and container removal");
  runIds.push(run.id);
  assert.ok(run.terminationConfirmedAt);
  assert.equal(run.result, "fixture report");
}
async function startTask(projectId) {
  const task = (
    await api(
      `/projects/${projectId}/tasks`,
      { instruction: "wait-once", requestKey: `systemd-${taskIds.length}` },
      201,
    )
  ).value;
  taskIds.push(task.id);
  const run = await waitFor(async () => {
    const { runs } = (await api(`/tasks/${task.id}/runs`)).value;
    assert.ok(runs.length <= 1, "Unexpected retry before fault injection");
    if (!runs[0]) return false;
    const detail = (await api(`/runs/${runs[0].id}`)).value;
    return detail.status === "running" &&
      detail.events.some((event) => event.kind === "fixture.ready") &&
      existsSync(join(state, "codex/attempted"))
      ? detail
      : false;
  }, "first container waiting");
  runIds.push(run.id);
  const ids = containers(run.id);
  assert.equal(ids.length, 1);
  assert.equal(
    command("docker", ["inspect", "--format", "{{.State.Running}}", ids[0]]),
    "true",
  );
  return { task, run, containerId: ids[0] };
}
async function recovered(fixture, errorCode) {
  const attempts = await waitFor(async () => {
    const { runs } = (await api(`/tasks/${fixture.task.id}/runs`)).value;
    assert.ok(runs.length <= 2, "Duplicate retry");
    if (runs.length !== 2 || runs[0].status !== "succeeded") return false;
    // runTask saves success after termination, then awaits removal. Observe both
    // within this same deadline; a saved result alone is not finished cleanup.
    if (containers(fixture.run.id).length || containers(runs[0].id).length)
      return false;
    return runs;
  }, "automatic recovery and single replacement");
  const old = (await api(`/runs/${fixture.run.id}`)).value;
  const replacement = (await api(`/runs/${attempts[0].id}`)).value;
  runIds.push(replacement.id);
  assert.equal(old.status, "waiting_retry");
  assert.equal(old.errorCode, errorCode);
  assert.ok(old.terminationConfirmedAt);
  assert.ok(replacement.terminationConfirmedAt);
  assert.equal(replacement.attempt, 2);
  assert.equal(replacement.result, "fixture report");
  assert.ok(
    Date.parse(old.terminationConfirmedAt) <= Date.parse(replacement.startedAt),
    "Old execution must terminate before replacement starts",
  );
  assert.deepEqual(
    containers(fixture.run.id),
    [],
    "Old container survives recovery",
  );
  assert.deepEqual(
    containers(replacement.id),
    [],
    "Completed replacement container leaked",
  );
  return {
    oldAttempt: old.attempt,
    newAttempt: replacement.attempt,
    errorCode,
    terminationBeforeRetry: true,
  };
}
function inspectStoppedDatabase() {
  assert.equal(property("ActiveState"), "inactive");
  assert.equal(property("MainPID"), "0");
  const Database = createRequire(join(root, "apps/server/package.json"))(
    "better-sqlite3",
  );
  // No second SQLite connection while the server is running.
  const db = new Database(join(state, "hub.sqlite"), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    assert.deepEqual(db.pragma("integrity_check"), [{ integrity_check: "ok" }]);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM execution_owner").get().n,
      0,
    );
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS n FROM run_executions WHERE termination_confirmed_at IS NULL",
        )
        .get().n,
      0,
    );
    return db
      .prepare(
        "SELECT id, task_id, status, error_code, termination_confirmed_at FROM runs ORDER BY started_at",
      )
      .all();
  } finally {
    db.close();
  }
}

try {
  assert.ok(
    process.argv.length === 3 &&
      process.argv[2] === "--disposable-github-runner" &&
      process.platform === "linux" &&
      process.env.GITHUB_ACTIONS === "true" &&
      process.env.RUNNER_ENVIRONMENT === "github-hosted" &&
      process.getuid?.() === 0,
    "This check requires an explicitly opted-in disposable GitHub-hosted Linux runner as root",
  );
  assert.equal(readFileSync("/proc/1/comm", "utf8").trim(), "systemd");
  assert.ok(existsSync("/sys/fs/cgroup/cgroup.controllers"), "cgroup v2 is required");
  const machineId = readFileSync("/etc/machine-id", "utf8").trim();
  assert.match(machineId, /^[a-f0-9]{32}$/);
  journalPaths = ["/var/log/journal", "/run/log/journal"]
    .map((path) => join(path, `${machineId}.agent-hub`));
  for (const path of journalPaths) absent(path);
  for (const path of [
    root,
    config,
    state,
    unitPath,
    dropin,
    `/etc/systemd/system/${unit}`,
    `/etc/systemd/system/${unit}.d`,
  ])
    absent(path);
  assert.equal(
    property("LoadState"),
    "not-found",
    "Refusing an existing service",
  );
  for (const database of ["passwd", "group"]) {
    try {
      command("getent", [database, "agent-hub"]);
      throw new Error("Existing fixture account");
    } catch (error) {
      assert.equal(
        error.status,
        2,
        "Refusing an existing account or failed account lookup",
      );
    }
  }
  assert.equal(systemctl("is-active", "docker.service"), "active");
  command("docker", ["image", "inspect", image]);
  const portProbe = createServer();
  await new Promise((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
  const port = portProbe.address().port;
  await new Promise((resolve) => portProbe.close(resolve));
  origin = `http://127.0.0.1:${port}`;

  stage = "fixture installation";
  makeOwned(root);
  makeOwned(config, 0o700);
  makeOwned(state, 0o700);
  command("useradd", [
    "--system",
    "--user-group",
    "--no-create-home",
    "--home-dir",
    state,
    "--shell",
    "/usr/sbin/nologin",
    "agent-hub",
  ]);
  accountCreated = true;
  // Preserve pnpm's relative workspace links; never copy local config, .git or private evidence.
  for (const path of [
    "package.json",
    "node_modules",
    "apps/server/package.json",
    "apps/server/node_modules",
    "apps/server/dist",
    "apps/server/migrations",
    "apps/server/security",
    "apps/server/runtime",
    "apps/server/skills",
    "apps/web/dist",
    "packages/contracts/package.json",
    "packages/contracts/node_modules",
    "packages/contracts/dist",
  ]) {
    cpSync(join(source, path), join(root, path), {
      recursive: true,
      verbatimSymlinks: true,
    });
  }
  cpSync(process.execPath, join(root, "node"));
  mkdirSync(join(state, "codex"), { mode: 0o700 });
  mkdirSync(join(state, "workspace"), { mode: 0o700 });
  writeFileSync(
    join(state, "workspace/README.md"),
    "Synthetic lifecycle fixture\n",
  );
  writeFileSync(
    join(state, "codex/auth.json"),
    JSON.stringify({ auth_mode: "chatgpt" }),
    { mode: 0o600 },
  );
  const password = randomBytes(24).toString("hex");
  const { hashPassword } = await import(
    pathToFileURL(join(root, "apps/server/dist/modules/auth/password.js"))
  );
  const sessionSecret = randomBytes(32).toString("hex");
  writeFileSync(
    join(config, "auth.json"),
    JSON.stringify({
      version: 1,
      origin,
      sessionSecret,
      password: await hashPassword(password),
    }),
    { mode: 0o600 },
  );
  writeFileSync(
    join(config, "execution.json"),
    JSON.stringify({
      model: "fixture",
      timeoutMs: 120000,
      codexHome: join(state, "codex"),
      containerImage: image,
      workspaces: { example: join(state, "workspace") },
      automaticRecovery: {
        initialDelayMs: 1000,
        jitterRatio: 0,
        maxRetries: 1,
        capacity: false,
      },
    }),
    { mode: 0o600 },
  );
  writeFileSync(
    join(config, "server.env"),
    `PORT=${port}\nDATABASE_PATH=${state}/hub.sqlite\nAUTH_CONFIG=${config}/auth.json\nEXECUTION_CONFIG=${config}/execution.json\n`,
    { mode: 0o600 },
  );
  command("chown", ["-R", "agent-hub:agent-hub", config, state]);
  writeFileSync(unitPath, readFileSync(join(source, "ops/agent-hub.service")), {
    flag: "wx",
    mode: 0o644,
  });
  owned.push(unitPath);
  makeOwned(dropin);
  // Only the Node executable location changes. Keep production service restrictions/restart timing.
  writeFileSync(
    join(dropin, "fixture.conf"),
    `[Service]\nExecStart=\nExecStart=${root}/node ${root}/apps/server/dist/main.js\n`,
    { flag: "wx" },
  );
  unitInstalled = true;
  systemctl("daemon-reload");
  snapshot("before-service-start");
  scenarioDeadline = Date.now() + 300000;
  systemctl("start", unit);
  await ready();
  const initial = await api("/auth/session");
  headers = session(initial);
  headers = session(await api("/auth/login", { password }));
  await api("/health/ready");
  const project = (
    await api(
      "/projects",
      { name: "Systemd fixture", workspaceKey: "example" },
      201,
    )
  ).value;
  snapshot("idle-baseline");

  stage = "SIGKILL and systemd restart";
  const crash = await startTask(project.id);
  assert.equal(snapshot("crash-active").executions.length, 1);
  const previousPid = property("MainPID");
  assert.notEqual(previousPid, "0");
  assert.equal(property("NRestarts"), "0");
  systemctl("kill", "--kill-who=main", "--signal=SIGKILL", unit);
  await waitFor(() => {
    const pid = property("MainPID");
    return (
      pid !== "0" && pid !== previousPid && property("ActiveState") === "active"
    );
  }, "systemd automatic restart");
  await ready();
  assert.equal(property("NRestarts"), "1");
  const crashResult = await recovered(crash, "owner_lost");
  assert.equal(snapshot("crash-recovered").executions.length, 0);

  stage = "graceful stop during execution";
  rmSync(join(state, "codex/attempted"));
  const graceful = await startTask(project.id);
  assert.equal(snapshot("graceful-active").executions.length, 1);
  systemctl("stop", unit);
  assert.equal(snapshot("graceful-stopped").executions.length, 0);
  const stopped = inspectStoppedDatabase().find(
    (run) => run.id === graceful.run.id,
  );
  assert.equal(stopped.error_code, "server_shutdown");
  assert.notEqual(stopped.status, "succeeded");
  assert.ok(stopped.termination_confirmed_at);
  assert.deepEqual(containers(graceful.run.id), []);
  // Longer than the unchanged production RestartSec: an explicit stop must stay stopped.
  await delay(6000);
  assert.equal(property("ActiveState"), "inactive");
  assert.equal(property("MainPID"), "0");
  systemctl("start", unit);
  await ready();
  const gracefulResult = await recovered(graceful, "server_shutdown");
  assert.equal(snapshot("graceful-recovered").executions.length, 0);

  stage = "bounded repeat workload";
  for (let cycle = 1; cycle <= repeatedTasks; cycle++) {
    await completeTask(project.id);
    await delay(1000);
    assert.equal(snapshot(`repeat-idle-${cycle}`).executions.length, 0);
  }

  stage = "completed-state restart";
  systemctl("restart", unit);
  await ready();
  await api("/health/ready"); // The original login session must survive every restart.
  await delay(3000);
  for (const [index, id] of taskIds.entries()) {
    const { runs } = (await api(`/tasks/${id}/runs`)).value;
    assert.equal(runs.length, index < 2 ? 2 : 1, "Completed task executed again after restart");
    assert.equal(runs[0].status, "succeeded");
  }
  assert.equal(snapshot("completed-restart").executions.length, 0);
  systemctl("stop", unit);
  assert.equal(inspectStoppedDatabase().length, 4 + repeatedTasks);
  assert.equal(snapshot("final-stopped").executions.length, 0);
  console.log(
    JSON.stringify({
      status: "passed",
      systemd: command("systemctl", ["--version"]).split("\n")[0],
      node: process.version,
      productionUnitWithNodePathOverride: true,
      modelCalls: 0,
      tasks: 2 + repeatedTasks,
      attempts: 4 + repeatedTasks,
      repeatedTasks,
      measurement: "lifecycle-checkpoints-cgroup-v2",
      elapsedMs: Math.round(performance.now() - scenarioStarted),
      crash: crashResult,
      graceful: gracefulResult,
      completedRestartDuplicates: 0,
      databaseIntegrity: "ok",
      remote24hTested: false,
    }),
  );
} catch (error) {
  // Fixed stage plus assertion text; no configs, cookies, auth files or raw app journal.
  console.error(`Systemd lifecycle failed at ${stage}: ${error.message}`);
  if (unitInstalled) {
    try {
      console.error(
        systemctl(
          "show",
          unit,
          "--property=ActiveState,SubState,Result,ExecMainCode,ExecMainStatus,NRestarts",
        ),
      );
    } catch {
      /* Original failure retained. */
    }
  }
  process.exitCode = 1;
} finally {
  let safeToRemove = true;
  if (unitInstalled) {
    try {
      systemctl("stop", unit);
      assert.equal(property("MainPID"), "0");
    } catch {
      safeToRemove = false;
      process.exitCode = 1;
      console.error("Unable to stop owned fixture; retaining its files");
    }
  }
  // Only containers for task/run IDs created by this invocation may be removed.
  if (safeToRemove && unitInstalled) {
    try {
      const Database = createRequire(join(root, "apps/server/package.json"))(
        "better-sqlite3",
      );
      if (existsSync(join(state, "hub.sqlite"))) {
        const db = new Database(join(state, "hub.sqlite"), { readonly: true });
        try {
          for (const taskId of taskIds)
            for (const row of db
              .prepare("SELECT id FROM runs WHERE task_id = ?")
              .all(taskId))
              runIds.push(row.id);
        } finally {
          db.close();
        }
      }
      for (const runId of new Set(runIds))
        for (const id of containers(runId))
          command("docker", ["rm", "--force", id]);
    } catch {
      safeToRemove = false;
      process.exitCode = 1;
      console.error(
        "Unable to clean owned executions; retaining fixture files",
      );
    }
  }
  if (safeToRemove) {
    for (const path of owned.reverse())
      rmSync(path, { recursive: true, force: true });
    if (unitInstalled) systemctl("daemon-reload");
    if (accountCreated) command("userdel", ["agent-hub"]);
    if (unitInstalled) console.log(JSON.stringify({ kind: "fixture-cleanup", completed: true }));
  }
}
