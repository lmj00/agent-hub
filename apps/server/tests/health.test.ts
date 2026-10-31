import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { buildApp } from "../src/app.js";

test("reports a live server with the observation time and disables caching", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-hub-health-"));
  const app = buildApp({ databasePath: join(directory, "hub.sqlite") });

  try {
    const before = Date.now();
    const response = await app.inject({ method: "GET", url: "/health/live" });
    const after = Date.now();
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(body).toEqual({ status: "ok", checkedAt: expect.any(String) });
    expect(Date.parse(body.checkedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(body.checkedAt)).toBeLessThanOrEqual(after);
    expect(new Date(body.checkedAt).toISOString()).toBe(body.checkedAt);
  } finally {
    try {
      await app.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});
