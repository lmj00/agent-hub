import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Effort } from "@agent-hub/contracts";

type Candidate = { slug: string; description: string; priority: number; image: boolean };

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
        !Number.isFinite(m.priority) ||
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
        priority: m.priority,
        image: m.input_modalities.includes("image"),
      });
    }
    return candidates.sort((a, b) => a.priority - b.priority || a.slug.localeCompare(b.slug));
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function accountModelRouting(home: string, fallback: string, maxEffort: Effort) {
  const levels = ["medium", "high", "xhigh"];
  const candidates = readCandidates(home, levels.slice(0, levels.indexOf(maxEffort) + 1));
  const choose = (pattern: RegExp) => candidates.find((m) => pattern.test(m.description))?.slug;
  const general = choose(/general.purpose|go-to|everyday|general coding/i) ?? fallback;
  const specialist = candidates.find(
    (m) =>
      m.image && /visual understanding|computer use|image analysis|\bvision\b/i.test(m.description),
  );
  return {
    visual: specialist?.slug,
    models: {
      luna: choose(/affordable|simpler tasks|easier tasks|lightweight/i) ?? general,
      sol: general,
      astra: choose(/most capable|complex|advanced reasoning/i) ?? general,
    },
  };
}

export function requestsVisualInspection(instruction: string) {
  return /스크린샷|화면\s*(검토|검수|캡처|점검)|시각적?\s*(검토|검수)|screenshot|visual (review|inspection|qa)|screen capture/i.test(
    instruction,
  );
}
