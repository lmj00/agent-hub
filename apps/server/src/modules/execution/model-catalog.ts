import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { efforts, type Effort } from "@agent-hub/contracts";

import { isModelId } from "./model-policy.js";

type Candidate = {
  slug: string;
  description: string;
  priority: number | null;
  eligible: boolean;
  image: boolean;
  upgrade: string | null;
};

// The account's CLI refreshes this file. Read only the metadata needed for routing.
function readCandidates(home: string, requiredEfforts: Effort[]): Candidate[] {
  let fd: number | undefined;
  try {
    fd = openSync(
      join(home, "models_cache.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return [];
    const catalog = JSON.parse(readFileSync(fd, "utf8"));
    if (!Array.isArray(catalog?.models)) return [];
    const candidates: Candidate[] = [];
    for (const m of catalog.models) {
      if (!isModelId(m?.slug)) continue;
      candidates.push({
        slug: m.slug,
        description: typeof m.description === "string" ? m.description : "",
        priority: Number.isSafeInteger(m.priority) ? m.priority : null,
        eligible:
          m.visibility === "list" &&
          Array.isArray(m.input_modalities) &&
          m.input_modalities.includes("text") &&
          Array.isArray(m.supported_reasoning_levels) &&
          requiredEfforts.every((effort) =>
            m.supported_reasoning_levels.some(
              (level: { effort?: string } | null) => level?.effort === effort,
            ),
          ),
        image: Array.isArray(m.input_modalities) && m.input_modalities.includes("image"),
        upgrade: typeof m.upgrade?.model === "string" ? m.upgrade.model : null,
      });
    }
    return candidates;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function bestRanked(models: Candidate[]) {
  const best = models.reduce((rank, model) => Math.min(rank, model.priority ?? Infinity), Infinity);
  return models.filter((model) => model.priority === null || model.priority === best);
}

function family(slug: string) {
  // Only compare release numbers when the vendor and the full family suffix match.
  return slug.replace(/^([a-z]+)-\d+(?:\.\d+)*-([a-z][a-z0-9-]*)$/i, "$1-*-$2");
}

const numericOrder = new Intl.Collator("en", { numeric: true });

function chooseCandidate(matches: Candidate[], preferredFamily?: string) {
  const shortlist = bestRanked(matches);
  const families = Map.groupBy(shortlist, (m) => family(m.slug));
  const rankedFamilies = new Set(
    shortlist.filter((m) => m.priority !== null).map((m) => family(m.slug)),
  );
  const preferred =
    rankedFamilies.size === 1
      ? [...rankedFamilies][0]
      : preferredFamily && (rankedFamilies.size === 0 || rankedFamilies.has(preferredFamily))
        ? preferredFamily
        : undefined;
  const group =
    families.size === 1 ? families.values().next().value : preferred && families.get(preferred);
  if (!group) return undefined;
  return group.sort(
    (a, b) => numericOrder.compare(b.slug, a.slug) || a.slug.localeCompare(b.slug),
  )[0]?.slug;
}

// Codex ModelInfo.upgrade.model names a successor in the same account catalog.
// Resolve each chain once per capability, including retired predecessors.
function replacements(catalog: Map<string, Candidate>, requireImage: boolean) {
  const resolved = new Map<string, Candidate | undefined>();
  const cyclic = new Set<string>();
  const eligible = (m: Candidate) => m.eligible && (!requireImage || m.image);
  for (const origin of catalog.values()) {
    if (resolved.has(origin.slug)) continue;
    const path = new Set<Candidate>();
    let current: Candidate | undefined = origin;
    while (current && !path.has(current) && !resolved.has(current.slug)) {
      path.add(current);
      current = current.upgrade ? catalog.get(current.upgrade) : undefined;
    }
    const cycle = current && (path.has(current) || cyclic.has(current.slug));
    let target = current && resolved.get(current.slug);
    for (const model of [...path].reverse()) {
      if (cycle) {
        cyclic.add(model.slug);
        target = undefined;
      }
      if (!target && eligible(model)) target = model;
      resolved.set(model.slug, target);
    }
  }
  return resolved;
}

export function accountModelRouting(home: string, fallback: string, maxEffort: Effort) {
  const candidates = readCandidates(home, efforts.slice(0, efforts.indexOf(maxEffort) + 1));
  const catalog = new Map(candidates.map((m) => [m.slug, m]));
  const text = replacements(catalog, false);
  const images = replacements(catalog, true);
  const roles = {
    general: /general.purpose|go-to|everyday|general coding/i,
    simple: /affordable|simpler tasks|easier tasks|lightweight/i,
    complex: /most capable|complex|advanced reasoning/i,
    visual: /visual understanding|computer use|image analysis|\bvision\b/i,
  };
  function choose(role: keyof typeof roles | "ranked", preferredFamily?: string) {
    const matches = new Map<string, Candidate>();
    for (const model of catalog.values()) {
      if (role !== "ranked" && !roles[role].test(model.description)) continue;
      if (role === "visual" && !model.image) continue;
      const target = (role === "visual" ? images : text).get(model.slug);
      if (!target) continue;
      const priority = target.priority ?? model.priority;
      if (role === "ranked" && priority === null) continue;
      const existing = matches.get(target.slug);
      if (!existing || (priority ?? Infinity) < (existing.priority ?? Infinity)) {
        matches.set(target.slug, { ...target, priority });
      }
    }
    return chooseCandidate([...matches.values()], preferredFamily);
  }
  const preferredFamily = family(fallback);
  const configured = text.get(fallback)?.slug;
  // With only opaque descriptions, the provider's ranked list can still supply the general default.
  const rankedDefault = () => {
    if (
      candidates.some(
        (m) =>
          text.get(m.slug) && Object.values(roles).some((pattern) => pattern.test(m.description)),
      )
    )
      return undefined;
    return choose("ranked", preferredFamily);
  };
  const general =
    choose("general", preferredFamily) ??
    (configured !== fallback ? configured : undefined) ??
    rankedDefault() ??
    configured ??
    fallback;
  return {
    visual: choose("visual"),
    models: {
      luna: choose("simple") ?? general,
      sol: general,
      astra: choose("complex") ?? general,
    },
  };
}

export function requestsVisualInspection(instruction: string) {
  return /스크린샷|화면\s*(검토|검수|캡처|점검)|시각적?\s*(검토|검수)|screenshot|visual (review|inspection|qa)|screen capture/i.test(
    instruction,
  );
}
