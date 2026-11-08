import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { ServiceObservation, ServiceSnapshot } from "@agent-hub/contracts";
import {
  loadServiceConfig,
  type ServiceTargetConfig,
} from "../src/modules/services/service-config.js";
import { interpretObservation, observeService } from "../src/modules/services/observe-service.js";

let directory: string;
let server: Server;
let target: ServiceTargetConfig;
let mode: string;
let seen: {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
}[];
const token = "fixture-bearer-token-for-tests";
function snapshot(patch: Partial<ServiceSnapshot> = {}): ServiceSnapshot {
  const now = new Date().toISOString();
  return {
    observedAt: now,
    processState: "running",
    activityState: "working",
    lastSuccessAt: now,
    nextExpectedAt: null,
    errorCount: 0,
    summary: "Fixture service",
    ...patch,
  };
}
beforeEach(async () => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "hub-observe-")));
  mode = "working";
  seen = [];
  server = createServer((request, response) => {
    seen.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
    });
    if (mode === "timeout") return;
    if (mode === "redirect") {
      response.writeHead(302, { location: "/must-not-follow" });
      response.end();
      return;
    }
    if (mode === "http_error") {
      response.writeHead(503);
      response.end("private upstream failure");
      return;
    }
    if (mode === "html") {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end("private upstream page");
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    if (mode === "large") {
      response.write(" ".repeat(17000));
      response.end("{}");
      return;
    }
    if (mode === "invalid") {
      response.end(JSON.stringify({ status: "ok", secret: token }));
      return;
    }
    if (mode === "bad_date") {
      response.end(
        JSON.stringify(snapshot({ observedAt: "2026-02-30T00:00:00Z", lastSuccessAt: null })),
      );
      return;
    }
    if (mode === "future") {
      response.end(
        JSON.stringify(snapshot({ observedAt: new Date(Date.now() + 60000).toISOString() })),
      );
      return;
    }
    response.end(
      JSON.stringify(
        snapshot({
          activityState: mode === "waiting" ? "waiting" : "working",
          summary: `Fixture ${token} Bearer other-secret sk-example-secret`,
        }),
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/status`;
  const path = join(directory, "services.json");
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      targets: [
        {
          key: "fixture",
          projectId: randomUUID(),
          name: "Fixture",
          url,
          bearerToken: token,
          timeoutMs: 2000,
        },
      ],
    }),
    { mode: 0o600 },
  );
  target = loadServiceConfig(path).targets[0]!;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(directory, { recursive: true, force: true });
});

test("reads an actual HTTP status endpoint with GET and redacts its echoed credentials", async () => {
  const result = await observeService(target, new AbortController().signal);
  expect(result).toMatchObject({
    success: true,
    errorCode: null,
    snapshot: { processState: "running", activityState: "working" },
  });
  expect(seen).toEqual([{ method: "GET", url: "/status", authorization: `Bearer ${token}` }]);
  expect(JSON.stringify(result)).not.toContain(token);
  expect(result.snapshot?.summary).not.toContain("other-secret");
  expect(result.snapshot?.summary).not.toContain("sk-example-secret");
});
test.each([
  ["timeout", "timeout"],
  ["redirect", "redirect_refused"],
  ["http_error", "http_error"],
  ["html", "invalid_payload"],
  ["large", "response_too_large"],
  ["invalid", "invalid_payload"],
  ["bad_date", "invalid_payload"],
  ["future", "invalid_payload"],
])(
  "classifies %s without following redirects or returning upstream details",
  async (responseMode, code) => {
    mode = responseMode;
    const result = await observeService(
      responseMode === "timeout" ? { ...target, timeoutMs: 100 } : target,
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      success: false,
      errorCode: code,
      snapshot: null,
    });
    // A deadline can expire before the local server accepts the connection.
    if (responseMode === "timeout") expect(seen.length).toBeLessThanOrEqual(1);
    else expect(seen).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("private");
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain(target.url);
  },
);
test("connection refusal means observation unavailable, not proof the service stopped", async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const result = await observeService(target, new AbortController().signal);
  const record = {
    ...result,
    id: randomUUID(),
    receivedAt: result.receivedAt.toISOString(),
  };
  expect(interpretObservation(target, record, new Date())).toEqual({
    state: "unavailable",
    reason: "request_failed",
  });
});
test("separates normal waiting, missing progress and overdue work without treating logs as progress", () => {
  const now = new Date();
  const old = new Date(now.getTime() - 100000).toISOString();
  const latest = (patch: Partial<ServiceSnapshot>): ServiceObservation => ({
    id: randomUUID(),
    receivedAt: now.toISOString(),
    success: true,
    errorCode: null,
    snapshot: snapshot(patch),
  });
  expect(
    interpretObservation(
      { ...target, activityTimeoutMs: 10000 },
      latest({ activityState: "waiting", lastSuccessAt: old }),
      now,
    ).state,
  ).toBe("waiting");
  expect(
    interpretObservation(
      { ...target, allowWaiting: false },
      latest({ activityState: "waiting" }),
      now,
    ).reason,
  ).toBe("waiting_not_allowed");
  expect(
    interpretObservation(
      { ...target, activityTimeoutMs: 10000 },
      latest({ lastSuccessAt: old }),
      now,
    ).reason,
  ).toBe("progress_overdue");
  expect(
    interpretObservation(
      { ...target, activityTimeoutMs: 10000 },
      latest({ lastSuccessAt: null }),
      now,
    ).state,
  ).toBe("unknown");
  expect(interpretObservation(target, latest({ processState: "stopped" }), now).state).toBe(
    "stopped",
  );
  expect(
    interpretObservation(target, latest({ activityState: "waiting", nextExpectedAt: old }), now)
      .reason,
  ).toBe("scheduled_work_overdue");
});
test("both stale source timestamps and stale collection timestamps override a past healthy result", () => {
  const now = new Date();
  const old = new Date(now.getTime() - target.staleAfterMs - 1).toISOString();
  const latest: ServiceObservation = {
    id: randomUUID(),
    receivedAt: now.toISOString(),
    success: true,
    errorCode: null,
    snapshot: snapshot(),
  };
  expect(interpretObservation(target, { ...latest, receivedAt: old }, now).state).toBe("stale");
  expect(
    interpretObservation(
      target,
      {
        ...latest,
        snapshot: snapshot({ observedAt: old, lastSuccessAt: old }),
      },
      now,
    ).state,
  ).toBe("stale");
  expect(
    interpretObservation(
      target,
      { ...latest, receivedAt: new Date(now.getTime() + 60000).toISOString() },
      now,
    ).reason,
  ).toBe("clock_skew");
});
test("config requires a private file and rejects ambiguous, credential-bearing or unencrypted remote URLs", () => {
  const path = join(directory, "services.json");
  const value = {
    version: 1,
    targets: [
      {
        key: "fixture",
        projectId: target.projectId,
        name: "Fixture",
        url: target.url,
      },
    ],
  };
  for (const url of [
    "file:///etc/passwd",
    "http://example.com/status",
    "http://user:password@localhost/status",
    "https://example.com/status?token=private",
    "https://example.com/#fragment",
  ]) {
    writeFileSync(path, JSON.stringify({ ...value, targets: [{ ...value.targets[0], url }] }));
    expect(() => loadServiceConfig(path)).toThrow();
  }
  writeFileSync(path, JSON.stringify({ ...value, targets: [value.targets[0], value.targets[0]] }));
  expect(() => loadServiceConfig(path)).toThrow("unique");
  writeFileSync(path, JSON.stringify(value));
  chmodSync(path, 0o644);
  expect(() => loadServiceConfig(path)).toThrow("private");
  chmodSync(path, 0o600);
  const alias = join(directory, "alias.json");
  symlinkSync(path, alias);
  expect(() => loadServiceConfig(alias)).toThrow();
  writeFileSync(path, '{"bearerToken":"private-invalid-json');
  expect(() => loadServiceConfig(path)).toThrow("valid JSON");
});
