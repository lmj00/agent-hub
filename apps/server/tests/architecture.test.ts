import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const script = fileURLToPath(new URL("../../../scripts/check-boundaries.mjs", import.meta.url));
const check = (root?: string) =>
  spawnSync(process.execPath, [script, ...(root ? [root] : [])], {
    encoding: "utf8",
    timeout: 10000,
  });

test("authored modules respect the documented import boundaries", () => {
  const result = check();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("Module boundaries passed");
});

test("the boundary check accepts shared operations and rejects reverse imports", () => {
  const root = mkdtempSync(join(tmpdir(), "hub-boundaries-"));
  function file(path: string, content: string) {
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  }
  try {
    file(
      "apps/server/src/modules/goals/example.ts",
      'import type { RunCompletion } from "../execution/run-task.js";',
    );
    file("apps/web/src/features/example.ts", 'import { api } from "../shared/api.js";');
    file("packages/contracts/src/tasks.ts", 'export { id } from "./schema.js";');
    expect(check(root).status).toBe(0);
    file(
      "apps/server/src/modules/workspace/example.ts",
      'import "../execution/execution-config.js";',
    );
    file(
      "apps/server/src/modules/goals/example.ts",
      'import { execute } from "../execution/workflows/prepared-executor.js";',
    );
    file("apps/web/src/shared/example.ts", 'const feature = import("../features/example.js");');
    file("packages/contracts/src/tasks.ts", 'export { taskSchema } from "./index.js";');
    const rejected = check(root);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("workspace must not depend");
    expect(rejected.stderr).toContain("goals must use documented execution operations");
    expect(rejected.stderr).toContain("shared web code must not depend");
    expect(rejected.stderr).toContain("contracts internals must not import");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
