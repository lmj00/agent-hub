import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { AnalysisError } from "../src/modules/execution/analysis.js";
import {
  loadRuntimeSkill,
  maxRuntimeSkillBundleBytes,
  maxRuntimeSkillBytes,
  runtimeSkillRoles,
  type RuntimeSkillRole,
} from "../src/modules/execution/runtime-skills.js";

const exec = promisify(execFile);
const assets = fileURLToPath(new URL("../skills/gstack/", import.meta.url));
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

test("loads four distinct pinned profiles with their provenance and license", () => {
  const manifest = JSON.parse(
    readFileSync(join(assets, "manifest.json"), "utf8"),
  );
  expect(Object.keys(manifest.profiles).sort()).toEqual(
    [...runtimeSkillRoles].sort(),
  );
  const selections = runtimeSkillRoles.map((role) => {
    const loaded = loadRuntimeSkill(role);
    expect(loaded.selection).toMatchObject({
      id: `gstack-agent-hub/${role}`,
      role,
      version: 1,
      mode: "adapted_instructions",
      upstreamVersion: "1.93.11.0",
      upstreamCommit: "24a47db3d9e12a1f6ead6919306ef0da3b5696d9",
    });
    expect(loaded.instructions).toBe(
      readFileSync(join(assets, `${role}.md`), "utf8"),
    );
    expect(loaded.selection.digest).toBe(
      createHash("sha256").update(loaded.instructions).digest("hex"),
    );
    expect(loaded.bytes).toBe(Buffer.byteLength(loaded.instructions));
    expect(loaded.bytes).toBeLessThanOrEqual(maxRuntimeSkillBytes);
    expect(
      manifest.profiles[role].sources.every((source: string) =>
        /^[a-f0-9]{64}$/.test(manifest.sources[source]),
      ),
    ).toBe(true);
    expect(loadRuntimeSkill(role, loaded.selection)).toEqual(loaded);
    return loaded.selection;
  });
  expect(new Set(selections.map((selection) => selection.digest)).size).toBe(4);
  expect(
    new Set(selections.map((selection) => selection.bundleDigest)).size,
  ).toBe(1);
  expect(readFileSync(join(assets, "LICENSE"), "utf8")).toContain(
    "Copyright (c) 2026 Garry Tan",
  );
  expect(readFileSync(join(assets, "NOTICE.md"), "utf8")).toContain(
    "adapted_instructions",
  );
  const bundleFiles = [
    "manifest.json",
    ...Object.keys(manifest.notices),
    ...runtimeSkillRoles.map((role) => `${role}.md`),
  ];
  expect(
    bundleFiles.reduce(
      (total, file) => total + readFileSync(join(assets, file)).length,
      0,
    ),
  ).toBeLessThanOrEqual(maxRuntimeSkillBundleBytes);
});

test.each([
  "id",
  "role",
  "version",
  "mode",
  "upstreamVersion",
  "upstreamCommit",
  "digest",
  "bundleDigest",
])(
  "rejects a different expected %s instead of silently selecting another profile",
  (field) => {
    const expected = {
      ...loadRuntimeSkill("developer").selection,
      [field]: "different",
    };
    expect(() => loadRuntimeSkill("developer", expected)).toThrowError(
      new AnalysisError("unsupported_settings"),
    );
  },
);

test.each([null, [], {}, "gstack", { injected: true }])(
  "rejects malformed expected selection %j",
  (expected) => {
    expect(() => loadRuntimeSkill("planner", expected)).toThrowError(
      new AnalysisError("unsupported_settings"),
    );
  },
);

test("rejects extra selection fields and unknown roles, including path-like values", () => {
  const selected = loadRuntimeSkill("analyst").selection;
  expect(() =>
    loadRuntimeSkill("analyst", { ...selected, instructions: "untrusted" }),
  ).toThrowError(new AnalysisError("unsupported_settings"));
  for (const role of ["../../outside", "reviewer.md", "", null, 1]) {
    expect(() => loadRuntimeSkill(role as RuntimeSkillRole)).toThrowError(
      new AnalysisError("unsupported_settings"),
    );
  }
});

// Copy the actual loader and assets into a separate deployment. Mutating that
// copy exercises real filesystem errors without changing shared repository data
// or adding a configurable runtime asset path solely for tests.
function deployment() {
  const directory = mkdtempSync(join(tmpdir(), "hub-skills-"));
  directories.push(directory);
  const source = join(directory, "src/modules/execution");
  mkdirSync(source, { recursive: true });
  for (const file of ["runtime-skills.ts", "analysis.ts"]) {
    copyFileSync(
      fileURLToPath(
        new URL(`../src/modules/execution/${file}`, import.meta.url),
      ),
      join(source, file),
    );
  }
  cpSync(assets, join(directory, "skills/gstack"), { recursive: true });
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ type: "module" }),
  );
  symlinkSync(
    fileURLToPath(new URL("../node_modules/", import.meta.url)),
    join(directory, "node_modules"),
    "dir",
  );
  writeFileSync(
    join(directory, "probe.mjs"),
    `
import { loadRuntimeSkill } from './src/modules/execution/runtime-skills.ts';
import { AnalysisError } from './src/modules/execution/analysis.ts';
try { console.log(JSON.stringify({ ok: true, selection: loadRuntimeSkill('planner').selection })); }
catch (error) { console.log(JSON.stringify({ ok: false, code: error instanceof AnalysisError ? error.code : 'unexpected', message: error.message })); }
`,
  );
  return directory;
}

async function inspectDeployment(directory: string) {
  const result = await exec(
    process.execPath,
    ["--import", "tsx", "probe.mjs"],
    { cwd: directory, timeout: 8000 },
  );
  return JSON.parse(result.stdout);
}

test("loads the same profile from a separate server deployment", async () => {
  expect(await inspectDeployment(deployment())).toEqual({
    ok: true,
    selection: loadRuntimeSkill("planner").selection,
  });
});

test.each([
  "missing manifest",
  "modified manifest",
  "oversized manifest",
  "modified profile",
  "missing profile",
  "missing license",
  "modified notice",
  "symlink profile",
  "directory profile",
  "oversized profile",
  "missing other role",
  "rewritten manifest and profile",
])(
  "refuses a deployment with %s and returns no private path or asset content",
  async (failure) => {
    const directory = deployment();
    const root = join(directory, "skills/gstack");
    const profile = join(root, "planner.md");
    const manifest = join(root, "manifest.json");
    switch (failure) {
      case "missing manifest":
        rmSync(manifest);
        break;
      case "modified manifest":
        writeFileSync(manifest, readFileSync(manifest, "utf8") + "\n");
        break;
      case "oversized manifest":
        writeFileSync(manifest, "x".repeat(16 * 1024 + 1));
        break;
      case "modified profile":
        writeFileSync(profile, "untrusted replacement");
        break;
      case "missing profile":
        rmSync(profile);
        break;
      case "missing license":
        rmSync(join(root, "LICENSE"));
        break;
      case "modified notice":
        writeFileSync(join(root, "NOTICE.md"), "untrusted notice");
        break;
      case "symlink profile": {
        const outside = join(directory, "outside.md");
        copyFileSync(profile, outside);
        rmSync(profile);
        symlinkSync(outside, profile);
        break;
      }
      case "directory profile":
        rmSync(profile);
        mkdirSync(profile);
        break;
      case "oversized profile":
        writeFileSync(profile, "x".repeat(maxRuntimeSkillBytes + 1));
        break;
      case "missing other role":
        rmSync(join(root, "reviewer.md"));
        break;
      case "rewritten manifest and profile": {
        const contents = "untrusted replacement";
        const metadata = JSON.parse(readFileSync(manifest, "utf8"));
        metadata.profiles.planner.sha256 = createHash("sha256")
          .update(contents)
          .digest("hex");
        writeFileSync(profile, contents);
        writeFileSync(manifest, JSON.stringify(metadata));
        break;
      }
    }
    expect(await inspectDeployment(directory)).toEqual({
      ok: false,
      code: "unsupported_settings",
      message: "unsupported_settings",
    });
  },
);
