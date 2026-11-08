import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const exec = promisify(execFile);
const script = fileURLToPath(new URL("../../../scripts/check-systemd.mjs", import.meta.url));

// These refusal checks also run on developer machines. Actual PID 1 behavior runs in Linux CI.
test.each([
  { name: "no explicit opt-in", args: [], environment: "github-hosted" },
  {
    name: "a self-hosted runner",
    args: ["--disposable-github-runner"],
    environment: "self-hosted",
  },
])(
  "systemd fixture refuses $name before probing or installing host resources",
  async ({ args, environment }) => {
    const result = await exec(process.execPath, [script, ...args], {
      env: {
        PATH: "",
        GITHUB_ACTIONS: "true",
        RUNNER_ENVIRONMENT: environment,
      },
    }).then(
      () => {
        throw new Error("Unsafe fixture unexpectedly succeeded");
      },
      (error) => error,
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "failed at preflight: This check requires an explicitly opted-in disposable GitHub-hosted Linux runner as root",
    );
    expect(result.stderr).not.toContain("ENOENT");
  },
);
