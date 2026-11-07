import {
  parseResponse,
  runtimeSkillEvidenceSchema,
  type RuntimeSkillEvidence,
} from "@agent-hub/contracts";
import type { steps } from "../../db/schema.js";

// Project saved metadata only. Do not consult today's deployment bundle or
// expose arbitrary JSON fields from the journal in the public read model.
export function readRuntimeSkillEvidence(
  step: Pick<
    typeof steps.$inferSelect,
    "runtimeSkill" | "runtimeSkillSelectedAt" | "runtimeSkillLoadedAt"
  >,
): RuntimeSkillEvidence | null {
  const skill = step.runtimeSkill;
  if (!skill && !step.runtimeSkillSelectedAt && !step.runtimeSkillLoadedAt)
    return null;
  if (
    !skill ||
    !step.runtimeSkillSelectedAt ||
    skill.id !== `gstack-agent-hub/${skill.role}`
  ) {
    throw new Error("Invalid recorded runtime skill");
  }
  return parseResponse(runtimeSkillEvidenceSchema, {
    id: skill.id,
    role: skill.role,
    version: skill.version,
    mode: skill.mode,
    upstreamVersion: skill.upstreamVersion,
    upstreamCommit: skill.upstreamCommit,
    digest: skill.digest,
    bundleDigest: skill.bundleDigest,
    bytes: skill.bytes,
    selectedAt: step.runtimeSkillSelectedAt.toISOString(),
    loadedAt: step.runtimeSkillLoadedAt?.toISOString() ?? null,
  });
}
