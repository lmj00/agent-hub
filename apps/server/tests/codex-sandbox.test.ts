import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, test } from "vitest";
import { containerSecurityOptions } from "../src/modules/execution/container-runtime.js";
import { createHash, randomUUID } from "node:crypto";
import { createContainerExecutor } from "../src/modules/execution/execution-process.js";
import type { ExecutionIdentity } from "../src/modules/execution/analysis.js";
import {
  developmentInputIntent,
  developmentRepositoryIntent,
  developmentRoot,
  prepareDevelopmentRepository,
  prepareDevelopmentInput,
  stageDevelopmentCandidate,
} from "../src/modules/goals/development-workspace.js";
import { preparedInputRoot } from "../src/modules/goals/prepared-workspace.js";
import { loadRuntimeSkill, runtimeSkillRoles } from "../src/modules/execution/runtime-skills.js";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const image = "agent-hub-sandbox-test:local";

// Uses the production image and pinned CLI, without authentication or a model call.
describe.skipIf(process.env.RUN_CONTAINER_TESTS !== "1")("Codex container sandbox", () => {
  beforeAll(async () => {
    await exec("docker", ["build", "-f", "docker/analysis-runner.Dockerfile", "-t", image, "."], {
      cwd: root,
      timeout: 90000,
    });
    await exec(
      "docker",
      [
        "build",
        "-f",
        "apps/server/tests/fixtures/development-runner.Dockerfile",
        "-t",
        "agent-hub-development-test:local",
        ".",
      ],
      { cwd: root, timeout: 30000 },
    );
  }, 95000);

  test("packages the pinned role instructions and rejects changed image assets", async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "hub-skill-image-")));
    const changed = join(directory, "changed.md");
    writeFileSync(changed, "untrusted replacement", { mode: 0o644 });
    const probe = `
      import { loadRuntimeSkill, runtimeSkillRoles } from '/app/apps/server/dist/modules/execution/runtime-skills.js';
      try { console.log(JSON.stringify({ selections: runtimeSkillRoles.map(role => loadRuntimeSkill(role).selection) })); }
      catch (error) { console.log(JSON.stringify({ error: error.code })); }
    `;
    const args = ["run", "--rm", "--network", "none", "--read-only", "--entrypoint", "node"];
    try {
      const normal = await exec(
        "docker",
        [...args, image, "--input-type=module", "--eval", probe],
        { timeout: 15000 },
      );
      expect(JSON.parse(normal.stdout)).toEqual({
        selections: runtimeSkillRoles.map((role) => loadRuntimeSkill(role).selection),
      });
      const modified = await exec(
        "docker",
        [
          ...args,
          "--mount",
          `type=bind,src=${changed},dst=/app/apps/server/skills/gstack/planner.md,readonly`,
          image,
          "--input-type=module",
          "--eval",
          probe,
        ],
        { timeout: 15000 },
      );
      expect(JSON.parse(modified.stdout)).toEqual({ error: "unsupported_settings" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 35000);

  test.each([
    "wrong-ack",
    "missing-selection",
    "wrong-digest",
    "changed-file",
    "missing-hello",
    "wrong-bundle",
  ])(
    "production runner blocks %s before SDK invocation",
    async (mode) => {
      const directory = realpathSync(mkdtempSync(join(tmpdir(), "hub-skill-runner-")));
      const changed = join(directory, "changed.md");
      writeFileSync(changed, "untrusted replacement", { mode: 0o644 });
      const selection = loadRuntimeSkill("analyst").selection;
      const hello = {
        type: "runner.hello",
        runtimeSkillVersion: 1,
        bundleDigest: mode === "wrong-bundle" ? "a".repeat(64) : selection.bundleDigest,
      };
      const request = {
        instruction: "Inspect",
        model: "fixture",
        runtimeSkillVersion: 1,
        stepSequence: 1,
        ...(mode === "missing-selection"
          ? {}
          : {
              runtimeSkill: {
                sequence: 1,
                selection: {
                  ...selection,
                  ...(mode === "wrong-digest" ? { digest: "a".repeat(64) } : {}),
                },
              },
            }),
      };
      const name = `hub-skill-runner-${randomUUID()}`;
      try {
        const output = await new Promise<string>((resolve, reject) => {
          const child = execFile(
            "docker",
            [
              "run",
              "--rm",
              "-i",
              "--name",
              name,
              "--network",
              "none",
              "--read-only",
              ...(mode === "changed-file"
                ? [
                    "--mount",
                    `type=bind,src=${changed},dst=/app/apps/server/skills/gstack/planner.md,readonly`,
                  ]
                : []),
              image,
            ],
            { timeout: 15000 },
            (error, stdout) => {
              // Input validation exits nonzero; both paths still emit a bounded error.
              if (error && !stdout) reject(error);
              else resolve(stdout);
            },
          );
          child.stdin!.end(
            (mode === "missing-hello" ? "" : JSON.stringify(hello) + "\n") +
              JSON.stringify(request) +
              "\n" +
              JSON.stringify({ type: "skill.saved", sequence: 1, digest: "wrong" }) +
              "\n",
          );
        });
        const messages = output
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        if (!["changed-file", "missing-hello", "wrong-bundle"].includes(mode)) {
          expect(messages.shift()).toEqual({
            type: "runner.ready",
            runtimeSkillVersion: 1,
            bundleDigest: selection.bundleDigest,
          });
        }
        if (mode === "wrong-ack") {
          expect(messages).toEqual([
            {
              type: "event",
              event: {
                kind: "skill.loaded",
                runtimeSkill: { type: "loaded", sequence: 1, selection },
              },
            },
            { type: "error", code: "provider_error", retryAt: null },
          ]);
        } else
          expect(messages).toEqual([
            expect.objectContaining({ type: "error", code: "unsupported_settings" }),
          ]);
      } finally {
        await exec("docker", ["rm", "-f", name]).catch(() => {});
        rmSync(directory, { recursive: true, force: true });
      }
    },
    20000,
  );

  test("can execute the bundled tools and read the project while denying writes, private files and network", async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "hub-sandbox-")));
    const home = join(directory, "home"),
      workspace = join(directory, "workspace"),
      outside = join(directory, "outside");
    for (const path of [home, workspace, outside]) mkdirSync(path);
    writeFileSync(join(home, "auth.json"), "synthetic credential");
    writeFileSync(join(outside, "private.txt"), "synthetic outside file");
    writeFileSync(join(workspace, "example.txt"), "prepared input");
    writeFileSync(
      join(workspace, "check.mjs"),
      readFileSync(new URL("./fixtures/codex-sandbox-check.mjs", import.meta.url)),
    );
    const uid = process.getuid!(),
      gid = process.getgid!();
    try {
      const security = await containerSecurityOptions();
      const result = await exec(
        "docker",
        [
          "run",
          "--rm",
          "--init",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          ...security,
          ...(security.includes("apparmor=agent-hub-codex-v1")
            ? ["--env", "EXPECT_APPARMOR=agent-hub-codex-v1"]
            : []),
          "--pids-limit",
          "128",
          "--memory",
          "768m",
          "--cpus",
          "1",
          "--user",
          `${uid}:${gid}`,
          "--tmpfs",
          "/tmp:rw,nosuid,nodev,size=64m",
          "--mount",
          `type=bind,src=${home},dst=/codex-home`,
          "--mount",
          `type=bind,src=${workspace},dst=/workspace,readonly`,
          "--mount",
          `type=bind,src=${outside},dst=/outside,readonly`,
          "--env",
          "HOME=/codex-home",
          "--env",
          "CODEX_HOME=/codex-home",
          "--workdir",
          "/workspace",
          "--entrypoint",
          "node",
          image,
          "/workspace/check.mjs",
        ],
        { timeout: 30000 },
      );
      expect(result.stdout).toContain("network denial: passed");
      expect(readFileSync(join(workspace, "example.txt"), "utf8")).toBe("prepared input");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 35000);

  test("writes only Task paths inside bounded tmpfs and captures changes without following links to credentials", async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "hub-development-sandbox-")));
    const home = join(directory, "home"),
      workspace = join(directory, "input");
    mkdirSync(home);
    mkdirSync(workspace);
    mkdirSync(join(workspace, "src"));
    mkdirSync(join(workspace, "tests"));
    writeFileSync(join(home, "auth.json"), "synthetic credential");
    writeFileSync(join(home, "value.txt"), "synthetic credential for traversal");
    const files = Object.entries({
      "src/main.txt": "original",
      "src/delete.txt": "delete",
      "tests/fixed.txt": "readonly context",
    }).map(([path, content]) => {
      writeFileSync(join(workspace, path), content, { mode: 0o600 });
      return {
        path,
        bytes: Buffer.byteLength(content),
        mode: "100644",
        blob: createHash("sha1")
          .update(`blob ${Buffer.byteLength(content)}\0`)
          .update(content)
          .digest("hex"),
      };
    });
    const development = {
      baseRevision: "a".repeat(40),
      inputDigest: "b".repeat(64),
      scope: { goalId: "goal", goalVersion: 1, allowedPaths: ["."], excludedPaths: [] },
      writePaths: ["src"],
      files,
    };
    const check = fileURLToPath(
      new URL("./fixtures/development-capture-check.mjs", import.meta.url),
    );
    const uid = process.getuid!(),
      gid = process.getgid!();
    try {
      const result = await exec(
        "docker",
        [
          "run",
          "--rm",
          "--init",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          ...(await containerSecurityOptions()),
          "--pids-limit",
          "128",
          "--memory",
          "768m",
          "--cpus",
          "1",
          "--user",
          `${uid}:${gid}`,
          "--tmpfs",
          "/tmp:rw,nosuid,nodev,size=64m",
          "--tmpfs",
          `/workspace:rw,nosuid,nodev,size=32m,nr_inodes=4096,uid=${uid},gid=${gid},mode=0700`,
          "--mount",
          `type=bind,src=${home},dst=/codex-home`,
          "--mount",
          `type=bind,src=${workspace},dst=/input,readonly`,
          "--mount",
          `type=bind,src=${check},dst=/check.mjs,readonly`,
          "--env",
          `DEVELOPMENT_INPUT=${JSON.stringify(development)}`,
          "--env",
          "HOME=/codex-home",
          "--env",
          "CODEX_HOME=/codex-home",
          "--workdir",
          "/workspace",
          "--entrypoint",
          "node",
          image,
          "/check.mjs",
        ],
        { timeout: 35000 },
      );
      expect(result.stdout).toContain("link races and tmpfs bound: passed");
      expect(readFileSync(join(workspace, "src/main.txt"), "utf8")).toBe("original");
      expect(readFileSync(join(home, "auth.json"), "utf8")).toBe("synthetic credential");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 40000);

  test.each(["large", "outside", "forged", "wait"])(
    "collects bounded development bytes through the actual container protocol: %s",
    async (mode) => {
      const directory = realpathSync(mkdtempSync(join(tmpdir(), "hub-development-protocol-")));
      const home = join(directory, "home"),
        source = join(directory, "source");
      mkdirSync(home);
      mkdirSync(source);
      mkdirSync(join(source, "src"));
      mkdirSync(join(source, "tests"));
      writeFileSync(join(home, "auth.json"), "synthetic credential");
      writeFileSync(join(source, "src/main.txt"), "original");
      writeFileSync(join(source, "tests/fixed.txt"), "fixed");
      const git = async (...args: string[]) =>
        (
          await exec(
            "git",
            [
              "-c",
              "user.name=Fixture",
              "-c",
              "user.email=fixture@example.test",
              "-c",
              "commit.gpgsign=false",
              ...args,
            ],
            {
              cwd: source,
              env: {
                PATH: process.env.PATH,
                GIT_CONFIG_NOSYSTEM: "1",
                GIT_CONFIG_GLOBAL: "/dev/null",
              },
            },
          )
        ).stdout.trim();
      await git("init", "--quiet", "--template=");
      await git("add", ".");
      await git("commit", "--quiet", "-m", "fixture");
      const controller = new AbortController(),
        runId = randomUUID();
      const executor = createContainerExecutor("agent-hub-development-test:local", home);
      let identity: ExecutionIdentity | undefined;
      let terminated = false;
      try {
        const repo = await prepareDevelopmentRepository(
          developmentRepositoryIntent(
            developmentRoot(join(directory, "hub.sqlite")),
            source,
            randomUUID(),
          ),
          controller.signal,
        );
        const scope = { goalId: "goal", goalVersion: 1, allowedPaths: ["."], excludedPaths: [] };
        const prepared = await prepareDevelopmentInput(
          developmentInputIntent(
            preparedInputRoot(join(directory, "hub.sqlite")),
            repo,
            runId,
            scope,
            ["src"],
          ),
          repo,
          controller.signal,
        );
        const development = {
          baseRevision: prepared.revision,
          inputDigest: prepared.digest,
          scope,
          writePaths: prepared.writePaths,
          files: prepared.files,
        };
        const pending = executor.analyze(
          {
            instruction: mode,
            workspace: prepared.directory,
            model: "fixture",
            runId,
            signal: controller.signal,
            development,
          },
          async (event) => {
            if (event.execution) identity = event.execution;
            if (event.executionTermination) terminated = true;
            if (event.kind === "fixture.ready") {
              controller.abort();
              await executor.confirmTermination!(runId);
            }
          },
        );
        if (mode === "large") {
          const result = await pending;
          expect(terminated).toBe(true);
          expect(JSON.stringify(result.development).length).toBeGreaterThan(2 * 1048576);
          expect(result.development?.changes).toHaveLength(3);
          const candidate = await stageDevelopmentCandidate(
            repo,
            prepared,
            result.development,
            controller.signal,
          );
          expect(candidate.changes.map((file) => file.bytes)).toEqual([700000, 700000, 700000]);
        } else await expect(pending).rejects.toBeDefined();
        expect(identity?.containerId).toMatch(/^[a-f0-9]{64}$/);
        expect(readFileSync(join(source, "src/main.txt"), "utf8")).toBe("original");
        expect(await git("status", "--porcelain")).toBe("");
      } finally {
        expect(await executor.confirmTermination!(runId)).toBeInstanceOf(Date);
        await executor.cleanup!(runId);
        rmSync(directory, { recursive: true, force: true });
      }
    },
    20000,
  );
});
