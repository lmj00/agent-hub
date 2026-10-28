import { expect, test } from "vitest";
import { buildApp } from "../src/app.js";

test("reports a live server with the observation time and disables caching", async () => {
  const app = buildApp();

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
    await app.close();
  }
});
