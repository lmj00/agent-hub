// Read-only checkpoint measurements for the disposable Linux lifecycle fixture.
// Never read database/journal contents, process arguments or environment variables.
import assert from "node:assert/strict";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, posix } from "node:path";

function integer(text) {
  assert.match(text, /^\d+$/);
  const value = Number(text);
  assert.ok(Number.isSafeInteger(value));
  return value;
}

function keyed(text) {
  return Object.fromEntries(text.trim().split("\n").map((line) => {
    const [key, value] = line.trim().split(/\s+/);
    return [key, integer(value)];
  }));
}

export function hostMemory(path = "/proc/meminfo") {
  const text = readFileSync(path, "utf8");
  const bytes = (key) => {
    const match = text.match(new RegExp(`^${key}:\\s+(\\d+) kB$`, "m"));
    assert.ok(match, `Missing ${key} in meminfo`);
    return integer(match[1]) * 1024;
  };
  const totalBytes = bytes("MemTotal");
  const availableBytes = bytes("MemAvailable");
  assert.ok(availableBytes <= totalBytes);
  return { totalBytes, availableBytes, usedEstimateBytes: totalBytes - availableBytes };
}

export function cgroupDirectory(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  const path = readFileSync(`/proc/${pid}/cgroup`, "utf8")
    .split("\n").find((line) => line.startsWith("0::"))?.slice(3);
  assert.ok(path && path.startsWith("/") && posix.normalize(path) === path,
    "Expected a normalized cgroup v2 path");
  return join("/sys/fs/cgroup", path);
}

export function cgroupUsage(directory) {
  const identity = lstatSync(directory);
  const read = (name) => readFileSync(join(directory, name), "utf8").trim();
  const cpu = keyed(read("cpu.stat"));
  const events = keyed(read("memory.events"));
  let peakBytes = null;
  try {
    peakBytes = integer(read("memory.peak"));
  } catch (error) {
    // Older supported kernels may not expose memory.peak. Missing is not zero.
    if (error.code !== "ENOENT") throw error;
  }
  for (const value of [cpu.usage_usec, events.oom, events.oom_kill])
    assert.ok(Number.isSafeInteger(value));
  return {
    // A restarted service can reuse its path but has new counters.
    identity: `${identity.dev}:${identity.ino}`,
    memoryBytes: integer(read("memory.current")),
    peakBytes,
    cpuUsageUsec: cpu.usage_usec,
    oom: events.oom,
    oomKill: events.oom_kill,
  };
}

export function treeSize(path) {
  const result = { exists: false, files: 0, bytes: 0, allocatedBytes: 0, vanishedEntries: 0 };
  const seen = new Set();
  function visit(current, root = false) {
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (!root) result.vanishedEntries++;
      return;
    }
    if (root) result.exists = true;
    // Do not follow symlinks. Count hard-linked regular files only once per tree.
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      let entries;
      try {
        entries = readdirSync(current);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        result.vanishedEntries++;
        return;
      }
      for (const name of entries) visit(join(current, name));
    } else if (stat.isFile()) {
      const identity = `${stat.dev}:${stat.ino}`;
      if (seen.has(identity)) return;
      seen.add(identity);
      result.files++;
      result.bytes += stat.size;
      result.allocatedBytes += stat.blocks * 512;
    }
  }
  visit(path, true);
  return result;
}
