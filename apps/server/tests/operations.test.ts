import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, test } from "vitest";

const exec = promisify(execFile);

// Cold prebuild runs outside test timeouts in CI. Rebuild from current sources so stale tags cannot pass.
describe.skipIf(process.env.RUN_CONTAINER_TESTS !== "1")("Linux operations", () => {
  beforeAll(async () => {
    await exec(
      "docker",
      [
        "build",
        "-f",
        "docker/operations-check.Dockerfile",
        "-t",
        "agent-hub-operations-test:local",
        ".",
      ],
      {
        cwd: fileURLToPath(new URL("../../../", import.meta.url)),
        timeout: 90000,
      },
    );
  }, 95000);
  test("Linux configuration and real HTTPS preserve authentication and state across app restart", async () => {
    const name = `hub-operations-${randomUUID()}`;
    try {
      const { stdout } = await exec(
        "docker",
        [
          "run",
          "--rm",
          "--pull=never",
          "--name",
          name,
          "--network",
          "none",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges:true",
          "--pids-limit",
          "128",
          "--memory",
          "512m",
          "--tmpfs",
          "/tmp:rw,nosuid,nodev,size=128m,mode=1777",
          "agent-hub-operations-test:local",
        ],
        { timeout: 60000 },
      );
      expect(JSON.parse(stdout)).toMatchObject({
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
      });
    } finally {
      // An interrupted Docker client can leave the container alive; remove only this test's UUID container.
      await exec("docker", ["rm", "--force", name], { timeout: 10000 }).catch(() => {});
    }
  }, 75000);
});
