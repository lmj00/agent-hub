import { execFileSync } from "node:child_process";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, expect, test } from "vitest";
// The CI script is native JavaScript; load its real exports without a TS-only copy.
const { cgroupUsage, hostMemory, treeSize } = createRequire(import.meta.url)(
  "../../../scripts/linux-resource-snapshot.mjs",
);

const directories: string[] = [];
function fixture() {
  const path = mkdtempSync(join(tmpdir(), "hub-resource-"));
  directories.push(path);
  return path;
}
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("host memory uses available memory, not free memory, and reports bytes", () => {
  const path = join(fixture(), "meminfo");
  writeFileSync(
    path,
    "MemTotal:       1024 kB\nMemFree:          16 kB\nMemAvailable:    256 kB\n",
  );
  expect(hostMemory(path)).toEqual({
    totalBytes: 1048576,
    availableBytes: 262144,
    usedEstimateBytes: 786432,
  });
  writeFileSync(path, "MemTotal:       1024 kB\nMemFree:          16 kB\n");
  expect(() => hostMemory(path)).toThrow("Missing MemAvailable");
});

test("cgroup counters use keys and distinguish an unsupported peak from zero", () => {
  const path = fixture();
  writeFileSync(join(path, "cpu.stat"), "system_usec 10\nusage_usec 123450\nuser_usec 123440\n");
  writeFileSync(join(path, "memory.events"), "high 2\noom_kill 0\nmax 0\noom 0\n");
  writeFileSync(join(path, "memory.current"), "8192\n");
  const expected = { memoryBytes: 8192, peakBytes: null, cpuUsageUsec: 123450, oom: 0, oomKill: 0 };
  expect(cgroupUsage(path)).toMatchObject(expected);
  writeFileSync(join(path, "memory.peak"), "16384\n");
  expect(cgroupUsage(path)).toMatchObject({ ...expected, peakBytes: 16384 });
  writeFileSync(join(path, "cpu.stat"), "user_usec 10\n");
  expect(() => cgroupUsage(path)).toThrow();
});

test("disk accounting skips symlink targets, deduplicates hardlinks and distinguishes absence", () => {
  const path = fixture();
  const tree = join(path, "state");
  mkdirSync(tree);
  const file = join(tree, "data");
  writeFileSync(file, "fixture");
  linkSync(file, join(tree, "same-inode"));
  const outside = join(path, "outside");
  writeFileSync(outside, "not part of owned state");
  symlinkSync(outside, join(tree, "external-link"));
  symlinkSync("missing", join(tree, "dangling-link"));
  expect(treeSize(tree)).toEqual({
    exists: true,
    files: 1,
    bytes: 7,
    allocatedBytes: lstatSync(file).blocks * 512,
    vanishedEntries: 0,
  });
  expect(treeSize(join(path, "absent"))).toEqual({
    exists: false,
    files: 0,
    bytes: 0,
    allocatedBytes: 0,
    vanishedEntries: 0,
  });
});

test.each(["WAL", "DELETE"])(
  "metadata measurement preserves actual SQLite %s write locks",
  (mode) => {
    const directory = fixture();
    const path = join(directory, "hub.sqlite");
    const db = new Database(path);
    const writer = fileURLToPath(new URL("./fixtures/database-lock-probe.mjs", import.meta.url));
    const competingWrite = () =>
      JSON.parse(
        execFileSync(process.execPath, [writer, "writer", path], {
          encoding: "utf8",
          timeout: 5000,
        }),
      ).outcome;
    try {
      db.pragma(`journal_mode = ${mode}`);
      db.exec("CREATE TABLE fixture (id INTEGER); BEGIN IMMEDIATE");
      expect(competingWrite()).toBe("SQLITE_BUSY");
      expect(treeSize(directory).bytes).toBeGreaterThan(0);
      expect(competingWrite()).toBe("SQLITE_BUSY");
    } finally {
      if (db.inTransaction) db.exec("ROLLBACK");
      db.close();
    }
  },
);
