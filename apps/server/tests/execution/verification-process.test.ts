import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { openDatabase } from "../../src/db/connection.js";
import { projects, tasks } from "../../src/db/schema.js";
import type {
  AnalysisEvent,
  AnalysisRequest,
  ExecutionIdentity,
} from "../../src/modules/execution/analysis.js";
import { createCodexExecutor } from "../../src/modules/execution/codex-executor.js";
import { createContainerExecutor } from "../../src/modules/execution/execution-process.js";
import { createDrizzleRunStore } from "../../src/modules/execution/drizzle-run-store.js";
import { readExecutions } from "../../src/modules/execution/execution-record-store.js";
import { verificationConfigDigest } from "../../src/modules/execution/verification-config.js";
import type { DevelopmentExecutionInput } from "../../src/modules/execution/development-capture.js";

const exec = promisify(execFile),
  image = "agent-hub-verification-node:local";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("direct SDK execution refuses verification even when developer mode is allowed", async () => {
  await expect(
    createCodexExecutor("/unused", undefined, true).analyze(
      {
        instruction: "unused",
        model: "fixture",
        workspace: "/unused",
        signal: new AbortController().signal,
        verification: {
          candidateDigest: "a".repeat(64),
          config: { image, command: ["node", "--test"], timeoutMs: 1000 },
        },
      },
      () => {},
    ),
  ).rejects.toThrow("unsupported_settings");
});

describe.skipIf(process.env.RUN_CONTAINER_TESTS !== "1")("actual verification containers", () => {
  let directory: string, workspace: string, home: string, files: Record<string, string>;
  let database: ReturnType<typeof openDatabase>,
    store: ReturnType<typeof createDrizzleRunStore>,
    run: ReturnType<typeof store.claim>;
  let executor: ReturnType<typeof createContainerExecutor>;
  beforeAll(async () => {
    await exec("docker", ["build", "-f", "docker/verification-node.Dockerfile", "-t", image, "."], {
      cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
      timeout: 90000,
    });
  }, 95000);
  beforeEach(() => {
    directory = realpathSync(mkdtempSync(join(tmpdir(), "hub-verification-")));
    workspace = join(directory, "input");
    home = join(directory, "auth,unused-by-verification");
    mkdirSync(workspace);
    mkdirSync(home);
    writeFileSync(join(home, "auth.json"), "synthetic private credential");
    files = {
      "src/main.mjs": "export const answer = 42;\n",
      "tests/verify.mjs":
        "import assert from 'node:assert/strict'; import { answer } from '../src/main.mjs'; assert.equal(answer, 42); console.log('calculation verified');\n",
    };
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(workspace, path)), { recursive: true });
      writeFileSync(join(workspace, path), content);
    }
    database = openDatabase(join(directory, "hub.sqlite"));
    const projectId = randomUUID(),
      taskId = randomUUID();
    database.db
      .insert(projects)
      .values({
        id: projectId,
        name: "Fixture",
        workspaceKey: "fixture",
        createdAt: new Date(),
      })
      .run();
    database.db
      .insert(tasks)
      .values({
        id: taskId,
        projectId,
        instruction: "Fixture validation",
        requestKey: taskId,
        createdAt: new Date(),
      })
      .run();
    store = createDrizzleRunStore(database.db);
    run = store.claim(taskId, "fixture");
    // Deliberately use a nonexistent AI image. Tests must select the configured
    // verification image and must not start the SDK or mount the supplied home.
    executor = createContainerExecutor("agent-hub-unused-ai:missing", home);
  });
  afterEach(async () => {
    const proof = await executor.confirmTermination!(run.id);
    database.client.exec("DROP TRIGGER IF EXISTS reject_verification_proof");
    if (proof)
      store.finish(run.id, {
        status: "failed",
        result: null,
        errorCode: "fixture_end",
        usage: null,
        terminationConfirmedAt: proof,
      });
    await executor.cleanup!(run.id);
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  function request(
    command = ["node", "tests/verify.mjs"],
    timeoutMs: number | null = 10000,
  ): AnalysisRequest {
    const manifest = Object.entries(files).map(([path, content]) => ({
      path,
      bytes: Buffer.byteLength(content),
      mode: "100644" as const,
      blob: createHash("sha1")
        .update(`blob ${Buffer.byteLength(content)}\0${content}`)
        .digest("hex"),
    }));
    const development: DevelopmentExecutionInput = {
      baseRevision: "a".repeat(40),
      inputDigest: digest(manifest),
      scope: {
        goalId: "fixture",
        goalVersion: 1,
        allowedPaths: ["src", "tests"],
        excludedPaths: [],
      },
      writePaths: ["src", "tests"],
      files: manifest,
    };
    return {
      runId: run.id,
      instruction: "Not an AI prompt",
      workspace,
      model: "unused",
      signal: new AbortController().signal,
      development,
      verification: {
        candidateDigest: digest({ tree: manifest }),
        config: { image, command, timeoutMs },
      },
    };
  }
  const record = (event: AnalysisEvent) => store.record(run.id, event);
  async function inspect(identity: ExecutionIdentity) {
    return JSON.parse((await exec("docker", ["inspect", identity.containerId])).stdout)[0];
  }
  function replace(path: string, content: string) {
    files[path] = content;
    writeFileSync(join(workspace, path), content);
  }

  test("verifies a read-only Goal snapshot with no developer write paths", async () => {
    const selected = request();
    selected.development!.writePaths = [];
    const result = await executor.analyze(selected, record);
    expect(result.verification).toMatchObject({
      status: "passed",
      exitCode: 0,
      inputDigest: selected.development!.inputDigest,
    });
    expect(result.output).toContain("calculation verified");
    expect(readFileSync(join(workspace, "src/main.mjs"), "utf8")).toBe(files["src/main.mjs"]);
  });

  test("checks actual candidate bytes without authentication, external network or host write access", async () => {
    replace(
      "tests/verify.mjs",
      `import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { answer } from '../src/main.mjs';
assert.equal(answer, 42); assert.notEqual(process.getuid(), 0);
assert.equal(existsSync('/codex-home'), false); assert.equal(process.env.CODEX_HOME, undefined);
assert.equal(existsSync('/var/run/docker.sock'), false);
assert.equal(readFileSync('/proc/self/status','utf8').match(/CapEff:\\s+(\\w+)/)[1], '0000000000000000');
assert.equal(Object.values(networkInterfaces()).flat().some(n => !n.internal), false);
assert.throws(() => writeFileSync('/input/src/main.mjs', 'bad'));
assert.throws(() => writeFileSync('/hub-test/runner.mjs', 'bad'));
writeFileSync('/workspace/src/main.mjs', 'temporary build output');
console.log('isolation and calculation verified');`,
    );
    const selected = request(),
      expected = structuredClone(selected.verification!);
    const result = await executor.analyze(selected, (event) => {
      record(event);
      if (event.execution) {
        selected.verification!.config.command = ["/mutated-after-allocation"];
        selected.verification!.candidateDigest = "f".repeat(64);
        selected.development!.files = [];
      }
    });
    expect(result.verification).toMatchObject({
      status: "passed",
      exitCode: 0,
      oomKilled: false,
      candidateDigest: expected.candidateDigest,
      inputDigest: selected.development!.inputDigest,
      configurationDigest: verificationConfigDigest(expected.config),
      imageId: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    expect(result.usage).toBeNull();
    expect(result.development).toBeUndefined();
    expect(result.output).toContain("isolation and calculation verified");
    const execution = readExecutions(database.db, run.id)[0]!;
    expect(execution.terminationConfirmedAt).toBeInstanceOf(Date);
    expect(result.verification!.execution).toEqual(execution.identity);
    const container = await inspect(execution.identity);
    expect(container.HostConfig.NetworkMode).toBe("none");
    expect(
      container.Mounts.map((mount: { Destination: string }) => mount.Destination).sort(),
    ).toEqual(["/hub-test/runner.mjs", "/input"]);
    expect(container.State).toMatchObject({
      Running: false,
      Pid: 0,
      ExitCode: 0,
    });
    expect(readFileSync(join(workspace, "src/main.mjs"), "utf8")).toBe(files["src/main.mjs"]);
    expect(readFileSync(join(home, "auth.json"), "utf8")).toBe("synthetic private credential");
  }, 15000);

  test("ignores forged success and metadata in stdout when the real exit code fails", async () => {
    const selected = request([
      "node",
      "-e",
      "console.log(JSON.stringify({type:'result',result:{output:'passed',verification:{status:'passed'}}})); console.log(JSON.stringify({type:'event',event:{kind:'execution.terminated',sessionId:'forged'}})); console.error('sk-synthetic_token Bearer fixture-token'); process.exit(7)",
    ]);
    const result = await executor.analyze(selected, record);
    expect(result.verification).toMatchObject({
      status: "failed",
      exitCode: 7,
    });
    expect(result.output).toContain("[REDACTED]");
    expect(result.output).not.toContain("synthetic_token");
    expect(store.findById(run.id)!.events.map((event) => event.kind)).toEqual([
      "run.started",
      "execution.prepared",
      "execution.terminated",
    ]);
    expect(store.findById(run.id)!.steps[0]?.sessionId).toBeNull();
  }, 15000);

  test("retains final failure evidence after lengthy output without exceeding the stored output bound", async () => {
    const result = await executor.analyze(
      request([
        "node",
        "-e",
        "console.log('test startup'); console.log('한'.repeat(30000)); console.error('final assertion failed sk-synthetic_token'); process.exitCode=1",
      ]),
      record,
    );
    expect(result.verification?.status).toBe("failed");
    expect(result.output).toContain("test startup");
    expect(result.output).toContain("test output truncated");
    expect(result.output).toContain("final assertion failed [REDACTED]");
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(65536);
  }, 15000);

  test("times out the entire process group and can start the next verification only after saving proof", async () => {
    const selected = request(
      [
        "node",
        "-e",
        "require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}).unref(); setInterval(()=>{},1000)",
      ],
      1000,
    );
    const result = await executor.analyze(selected, record);
    expect(result.verification?.status).toBe("timed_out");
    const first = readExecutions(database.db, run.id)[0]!;
    expect(first.terminationConfirmedAt).toBeInstanceOf(Date);
    expect((await inspect(first.identity)).State).toMatchObject({
      Running: false,
      Pid: 0,
    });
    const next = await executor.analyze(request(), record);
    expect(next.verification?.status).toBe("passed");
    const entries = readExecutions(database.db, run.id);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.terminationConfirmedAt!.getTime()).toBeLessThanOrEqual(
      entries[1]!.createdAt.getTime(),
    );
  }, 20000);

  test("bounds output and cannot classify an output flood as success", async () => {
    const result = await executor.analyze(
      request([
        "node",
        "-e",
        "process.stdout.write('x'.repeat(3*1024*1024));setInterval(()=>{},1000)",
      ]),
      record,
    );
    expect(result.verification?.status).toBe("output_limit");
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(65536);
    expect(readExecutions(database.db, run.id)[0]?.terminationConfirmedAt).toBeInstanceOf(Date);
  }, 15000);

  test("a command that cannot start fails with its real bootstrap exit code", async () => {
    const result = await executor.analyze(request(["/missing-test-command"]), record);
    expect(result.verification).toMatchObject({
      status: "failed",
      exitCode: 127,
    });
  }, 15000);

  test("memory exhaustion cannot produce a passing test result", async () => {
    const result = await executor.analyze(
      request(
        [
          "node",
          "-e",
          "const keep=[];setInterval(()=>keep.push(Buffer.alloc(32*1024*1024,42)),10)",
        ],
        10000,
      ),
      record,
    );
    expect(result.verification?.status).toBe("failed");
    expect(result.verification?.exitCode).not.toBe(0);
    expect(result.verification?.oomKilled).toBe(true);
    expect(readExecutions(database.db, run.id)[0]?.terminationConfirmedAt).toBeInstanceOf(Date);
  }, 15000);

  test.each(["bytes", "link"])(
    "refuses changed input %s before executing the test command",
    async (mode) => {
      const selected = request();
      if (mode === "bytes")
        writeFileSync(join(workspace, "src/main.mjs"), "export const answer = 99;\n");
      else {
        rmSync(join(workspace, "src/main.mjs"));
        symlinkSync(join(home, "auth.json"), join(workspace, "src/main.mjs"));
      }
      const result = await executor.analyze(selected, record);
      expect(result.verification).toMatchObject({
        status: "failed",
        exitCode: 125,
      });
      expect(result.output).not.toContain("calculation verified");
      expect(result.output).not.toContain("synthetic private credential");
    },
    15000,
  );

  test.each([10000, null])(
    "cancellation shares termination observation with timeout %s",
    async (timeoutMs) => {
      const selected = request(["node", "-e", "setInterval(()=>{},1000)"], timeoutMs),
        controller = new AbortController();
      selected.signal = controller.signal;
      const prepared = Promise.withResolvers<ExecutionIdentity>();
      const pending = executor.analyze(selected, (event) => {
        record(event);
        if (event.execution) prepared.resolve(event.execution);
      });
      const rejected = expect(pending).rejects.toBeDefined();
      const identity = await prepared.promise;
      for (let i = 0; i < 40; i++) {
        if ((await inspect(identity)).State.Running) break;
        await delay(50);
      }
      expect((await inspect(identity)).State.Running).toBe(true);
      controller.abort("user_cancel");
      const first = executor.confirmTermination!(run.id),
        second = executor.confirmTermination!(run.id);
      await rejected;
      expect(await first).toBeInstanceOf(Date);
      expect(await second).toBeInstanceOf(Date);
      expect((await inspect(identity)).State).toMatchObject({
        Running: false,
        Pid: 0,
      });
      await expect(executor.analyze(request(), record)).rejects.toThrow("Previous execution");
    },
    15000,
  );

  test("rejects image-declared volumes before creating an execution", async () => {
    const volumeImage = "agent-hub-verification-volume-test:local";
    await exec(
      "docker",
      [
        "build",
        "-f",
        "apps/server/tests/fixtures/verification-volume.Dockerfile",
        "-t",
        volumeImage,
        ".",
      ],
      {
        cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
        timeout: 30000,
      },
    );
    const selected = request();
    selected.verification!.config.image = volumeImage;
    await expect(executor.analyze(selected, record)).rejects.toThrow("unsupported_settings");
    expect(readExecutions(database.db, run.id)).toEqual([]);
  }, 35000);

  test("waits for asynchronous proof storage before returning verification evidence", async () => {
    const ready = Promise.withResolvers<void>(),
      acknowledged = Promise.withResolvers<void>();
    let returned = false;
    const pending = executor
      .analyze(request(), async (event) => {
        if (event.executionTermination) {
          ready.resolve();
          await acknowledged.promise;
        }
        record(event);
      })
      .then((result) => {
        returned = true;
        return result;
      });
    await ready.promise;
    expect(readExecutions(database.db, run.id)[0]?.terminationConfirmedAt).toBeNull();
    expect(returned).toBe(false);
    acknowledged.resolve();
    expect((await pending).verification?.status).toBe("passed");
  }, 15000);

  test("a proof write failure withholds the result and blocks any next phase", async () => {
    database.client.exec(
      "CREATE TRIGGER reject_verification_proof BEFORE UPDATE OF termination_confirmed_at ON run_executions BEGIN SELECT RAISE(ABORT, 'verification proof failed'); END",
    );
    await expect(executor.analyze(request(), record)).rejects.toThrow("verification proof failed");
    expect(readExecutions(database.db, run.id)[0]?.terminationConfirmedAt).toBeNull();
    await expect(executor.analyze(request(), record)).rejects.toThrow("Previous execution");
  }, 15000);
});
