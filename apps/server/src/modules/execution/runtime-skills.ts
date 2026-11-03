import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { AnalysisError } from "./analysis.js";

export const runtimeSkillRoles = [
  "planner",
  "developer",
  "reviewer",
  "analyst",
] as const;
export type RuntimeSkillRole = (typeof runtimeSkillRoles)[number];
export const runtimeSkillPolicyVersion = 1;
export const maxRuntimeSkillBytes = 32 * 1024;
export const maxRuntimeSkillBundleBytes = 128 * 1024;

// This pins the manifest itself, including provenance, notices and profile hashes.
// A deployment upgrade must change this value together with the packaged assets.
const manifestDigest =
  "ac5f2e47e1cb6ca2869238eec9be3c96e5f1385ce941cf6d0186aee122b78599";
const assetRoot = new URL("../../../skills/gstack/", import.meta.url);

export type RuntimeSkillSelection = {
  id: string;
  role: RuntimeSkillRole;
  version: number;
  mode: "adapted_instructions";
  upstreamVersion: string;
  upstreamCommit: string;
  digest: string;
  bundleDigest: string;
};

type Manifest = {
  id: string;
  version: number;
  mode: RuntimeSkillSelection["mode"];
  upstream: { version: string; commit: string };
  notices: Record<string, string>;
  profiles: Record<RuntimeSkillRole, { file: string; sha256: string }>;
};

function digest(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readAsset(name: string, limit: number): Buffer {
  // Paths come only from the fixed filenames below, never from a request. Refuse
  // links and special files; bounded reads also handle growth after the stat.
  const fd = openSync(
    new URL(name, assetRoot),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit)
      throw new Error("Invalid skill asset");
    const buffer = Buffer.alloc(limit + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (!count) break;
      bytes += count;
    }
    if (bytes > limit) throw new Error("Skill asset exceeds limit");
    return buffer.subarray(0, bytes);
  } finally {
    closeSync(fd);
  }
}

function matchesSelection(expected: unknown, actual: RuntimeSkillSelection) {
  if (!expected || typeof expected !== "object" || Array.isArray(expected))
    return false;
  const keys = Object.keys(actual) as Array<keyof RuntimeSkillSelection>;
  return (
    Object.keys(expected).length === keys.length &&
    keys.every(
      (key) =>
        Object.hasOwn(expected, key) &&
        (expected as Record<string, unknown>)[key] === actual[key],
    )
  );
}

// Both the parent and the execution image read their own deployment. The child
// supplies the parent's expected selection to reject mixed versions before use.
// This loader performs I/O and must be called outside database transactions.
export function loadRuntimeSkill(
  role: RuntimeSkillRole,
  expected?: unknown,
): {
  selection: RuntimeSkillSelection;
  instructions: string;
  bytes: number;
} {
  try {
    if (!runtimeSkillRoles.includes(role))
      throw new Error("Unknown skill role");
    const manifestBytes = readAsset("manifest.json", 16 * 1024);
    if (digest(manifestBytes) !== manifestDigest)
      throw new Error("Skill manifest differs");
    // Only these exact, pinned bytes are parsed. Filenames are still fixed here.
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as Manifest;
    if (
      manifest.version !== runtimeSkillPolicyVersion ||
      manifest.mode !== "adapted_instructions" ||
      Object.keys(manifest.profiles).length !== runtimeSkillRoles.length
    )
      throw new Error("Unsupported skill manifest");
    let total = manifestBytes.length;
    const readVerified = (name: string, expectedDigest: string) => {
      const bytes = readAsset(name, maxRuntimeSkillBytes);
      total += bytes.length;
      if (
        total > maxRuntimeSkillBundleBytes ||
        digest(bytes) !== expectedDigest
      )
        throw new Error("Skill asset differs");
      return bytes;
    };
    for (const notice of ["LICENSE", "NOTICE.md"])
      readVerified(notice, manifest.notices[notice]!);
    const profiles = new Map<RuntimeSkillRole, Buffer>();
    for (const key of runtimeSkillRoles) {
      const profile = manifest.profiles[key];
      if (profile.file !== `${key}.md`)
        throw new Error("Unsupported skill filename");
      profiles.set(key, readVerified(`${key}.md`, profile.sha256));
    }
    const selection: RuntimeSkillSelection = {
      id: `${manifest.id}/${role}`,
      role,
      version: manifest.version,
      mode: manifest.mode,
      upstreamVersion: manifest.upstream.version,
      upstreamCommit: manifest.upstream.commit,
      digest: manifest.profiles[role].sha256,
      bundleDigest: manifestDigest,
    };
    if (expected !== undefined && !matchesSelection(expected, selection))
      throw new Error("Skill selection differs");
    const bytes = profiles.get(role)!;
    return {
      selection,
      instructions: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      bytes: bytes.length,
    };
  } catch {
    // Missing, malformed or mismatched assets never fall back to unskilled work.
    // Do not expose deployment paths or raw file contents in the error.
    throw new AnalysisError("unsupported_settings");
  }
}
