import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, test } from "vitest";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const image = "agent-hub-sandbox-test:local";

// Uses the production image and pinned CLI, without authentication or a model call.
describe.skipIf(process.env.RUN_CONTAINER_TESTS !== "1")("Codex container sandbox", () => {
  beforeAll(async () => {
    await exec("docker", ["build", "-f", "docker/analysis-runner.Dockerfile", "-t", image, "."], { cwd: root, timeout: 90000 });
  }, 95000);

  test("can execute the bundled tools and read the project while denying writes, private files and network", async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "hub-sandbox-")));
    const home = join(directory, "home"), workspace = join(directory, "workspace"), outside = join(directory, "outside");
    for (const path of [home, workspace, outside]) mkdirSync(path);
    writeFileSync(join(home, "auth.json"), "synthetic credential");
    writeFileSync(join(outside, "private.txt"), "synthetic outside file");
    writeFileSync(join(workspace, "example.txt"), "prepared input");
    writeFileSync(join(workspace, "check.mjs"), readFileSync(new URL("./fixtures/codex-sandbox-check.mjs", import.meta.url)));
    const uid = process.getuid!(), gid = process.getgid!();
    try {
      const result = await exec("docker", [
        "run", "--rm", "--init", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--pids-limit", "128", "--memory", "768m", "--cpus", "1", "--user", `${uid}:${gid}`,
        "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m",
        "--mount", `type=bind,src=${home},dst=/codex-home`,
        "--mount", `type=bind,src=${workspace},dst=/workspace,readonly`,
        "--mount", `type=bind,src=${outside},dst=/outside,readonly`,
        "--env", "HOME=/codex-home", "--env", "CODEX_HOME=/codex-home", "--workdir", "/workspace",
        "--entrypoint", "node", image, "/workspace/check.mjs",
      ], { timeout: 30000 });
      expect(result.stdout).toContain("network denial: passed");
      expect(readFileSync(join(workspace, "example.txt"), "utf8")).toBe("prepared input");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 35000);
});
