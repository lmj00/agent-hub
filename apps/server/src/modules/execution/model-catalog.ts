import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Effort } from "@agent-hub/contracts";

type Candidate = { slug: string; description: string; priority: number | null; image: boolean };

// The account's CLI refreshes this file. Read only the metadata needed for routing.
function readCandidates(home: string, efforts: string[]): Candidate[] {
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
      if (
        m?.visibility !== "list" ||
        typeof m.slug !== "string" ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(m.slug) ||
        typeof m.description !== "string" ||
        !Array.isArray(m.input_modalities) ||
        !m.input_modalities.includes("text") ||
        !Array.isArray(m.supported_reasoning_levels) ||
        !efforts.every((effort) =>
          m.supported_reasoning_levels.some(
            (level: { effort?: string } | null) => level?.effort === effort,
          ),
        )
      )
        continue;
      candidates.push({
        slug: m.slug,
        description: m.description,
        priority: Number.isFinite(m.priority) ? m.priority : null,
        image: m.input_modalities.includes("image"),
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

function chooseCandidate(matches: Candidate[], preferredFamily: string) {
  const families = Map.groupBy(bestRanked(matches), (m) => family(m.slug));
  const group =
    families.size === 1 ? families.values().next().value : families.get(preferredFamily);
  return group?.sort(
    (a, b) => numericOrder.compare(b.slug, a.slug) || a.slug.localeCompare(b.slug),
  )[0]?.slug;
}

export function accountModelRouting(home: string, fallback: string, maxEffort: Effort) {
  const levels = ["medium", "high", "xhigh"];
  const candidates = readCandidates(home, levels.slice(0, levels.indexOf(maxEffort) + 1));
  const choose = (pattern: RegExp, preferredFamily: string) =>
    chooseCandidate(
      candidates.filter((m) => pattern.test(m.description)),
      preferredFamily,
    );
  const general =
    choose(/general.purpose|go-to|everyday|general coding/i, family(fallback)) ?? fallback;
  const visual = chooseCandidate(
    candidates.filter(
      (m) =>
        m.image &&
        /visual understanding|computer use|image analysis|\bvision\b/i.test(m.description),
    ),
    "gpt-*-terra",
  );
  return {
    visual,
    models: {
      luna: choose(/affordable|simpler tasks|easier tasks|lightweight/i, "gpt-*-luna") ?? general,
      sol: general,
      astra: choose(/most capable|complex|advanced reasoning/i, "gpt-*-astra") ?? general,
    },
  };
}

export function requestsVisualInspection(instruction: string) {
  return /스크린샷|화면\s*(검토|검수|캡처|점검)|시각적?\s*(검토|검수)|screenshot|visual (review|inspection|qa)|screen capture/i.test(
    instruction,
  );
}
