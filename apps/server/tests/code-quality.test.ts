import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const biome = join(root, "node_modules/.bin/biome");

function check(command: "lint" | "format", source: string, path: string) {
  const directory = mkdtempSync(join(tmpdir(), "agent-hub-quality-"));
  try {
    copyFileSync(join(root, "biome.json"), join(directory, "biome.json"));
    const file = join(directory, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, source);
    // This isolated probe has no Git checkout; all lint/format rules use the actual config.
    const result = spawnSync(biome, [command, "--vcs-enabled=false", path], {
      cwd: directory,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    expect(result.error).toBeUndefined();
    expect(readFileSync(file, "utf8")).toBe(source);
    return result;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test.each(["apps/server/src/quality-probe.ts", "apps/web/src/QualityProbe.tsx"])(
  "basic lint accepts valid code and rejects debugger in %s",
  (path) => {
    const valid = check("lint", "export const value = 1;\n", path);
    expect(valid.status, valid.stderr).toBe(0);
    const invalid = check("lint", "debugger;\n", path);
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("lint/suspicious/noDebugger");
  },
);

test("format check rejects inconsistent layout without changing the input", () => {
  const path = "packages/contracts/src/quality-probe.ts";
  const valid = check("format", "export const value = { count: 1 };\n", path);
  expect(valid.status, valid.stderr).toBe(0);
  const invalid = check("format", "export const value={count:1};\n", path);
  expect(invalid.status).toBe(1);
  expect(invalid.stderr).toContain("Formatter would have printed");
});
