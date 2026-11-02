import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { parseResponse, taskSchema } from "@agent-hub/contracts";
import { buildApp } from "../src/app.js";
import {
  AnalysisError,
  type AnalysisExecutor,
} from "../src/modules/execution/analysis.js";
import { loadExecutionConfig } from "../src/modules/execution/execution-config.js";

let directory: string;
let app: ReturnType<typeof buildApp> | undefined;
let config: ReturnType<typeof loadExecutionConfig>;
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "hub-auto-api-")));
  mkdirSync(join(directory, "home"));
  mkdirSync(join(directory, "workspace"));
  writeFileSync(
    join(directory, "home/auth.json"),
    JSON.stringify({ auth_mode: "chatgpt" }),
  );
  const file = join(directory, "execution.json");
  writeFileSync(
    file,
    JSON.stringify({
      model: "fixture",
      codexHome: "home",
      workspaces: { example: "workspace" },
      timeoutMs: 5000,
      automaticRecovery: { initialDelayMs: 1000, jitterRatio: 0 },
    }),
  );
  config = loadExecutionConfig(file);
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  rmSync(directory, { recursive: true, force: true });
});
async function start(executor: AnalysisExecutor) {
  app = buildApp({
    databasePath: join(directory, "hub.sqlite"),
    execution: { config, executor, pollIntervalMs: 10 },
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const project = (
    await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "Example", workspaceKey: "example" },
    })
  ).json();
  return (
    await app.inject({
      method: "POST",
      url: `/projects/${project.id}/tasks`,
      payload: { instruction: "Analyze", requestKey: randomUUID() },
    })
  ).json().id as string;
}
async function view(id: string) {
  return parseResponse(
    taskSchema,
    (await app!.inject({ method: "GET", url: `/tasks/${id}` })).json(),
  );
}

test("HTTP exposes the persisted wait and the queue performs exactly one delayed replacement", async () => {
  const analyze = vi
    .fn<AnalysisExecutor["analyze"]>()
    .mockRejectedValueOnce(new AnalysisError("transient"))
    .mockResolvedValue({ output: "Recovered analysis", usage: null });
  const id = await start({
    analyze,
    confirmTermination: async () => new Date(),
  });
  await vi.waitFor(async () =>
    expect((await view(id)).status).toBe("waiting_retry"),
  );
  const waiting = await view(id);
  expect(waiting.retryState).toMatchObject({
    retries: 0,
    consecutiveErrors: 1,
    reason: "retry_scheduled",
  });
  expect(waiting.retryState?.nextAttemptAt).not.toBeNull();
  expect(
    (await app!.inject({ method: "GET", url: "/health/live" })).statusCode,
  ).toBe(200);
  await vi.waitFor(
    async () => expect((await view(id)).status).toBe("succeeded"),
    { timeout: 3000 },
  );
  expect(analyze).toHaveBeenCalledTimes(2);
  expect((await view(id)).retryState?.retries).toBe(1);
  const history = (
    await app!.inject({ method: "GET", url: `/tasks/${id}/runs` })
  ).json().runs;
  expect(history.map((run: { attempt: number }) => run.attempt)).toEqual([
    2, 1,
  ]);
});

test("HTTP cancellation during the scheduled wait prevents the automatic call", async () => {
  const analyze = vi
    .fn<AnalysisExecutor["analyze"]>()
    .mockRejectedValue(new AnalysisError("transient"));
  const id = await start({
    analyze,
    confirmTermination: async () => new Date(),
  });
  await vi.waitFor(async () =>
    expect((await view(id)).status).toBe("waiting_retry"),
  );
  const runId = (
    await app!.inject({ method: "GET", url: `/tasks/${id}/runs` })
  ).json().runs[0].id;
  const response = await app!.inject({
    method: "POST",
    url: `/tasks/${id}/recovery-requests`,
    payload: { action: "cancel", requestKey: "cancel", runId },
  });
  expect(response.statusCode).toBe(202);
  await vi.waitFor(async () =>
    expect((await view(id)).status).toBe("cancelled"),
  );
  await new Promise((resolve) => setTimeout(resolve, 1100));
  expect(analyze).toHaveBeenCalledTimes(1);
  expect((await view(id)).retryState?.nextAttemptAt).toBeNull();
});

test("a retry receives only the remaining cumulative time, not another full Run timeout", async () => {
  config.automaticRecovery!.maxTotalRunMs = 1000;
  let calls = 0;
  const id = await start({
    async analyze(request) {
      calls++;
      if (calls === 1) {
        await new Promise((resolve) => setTimeout(resolve, 750));
        throw new AnalysisError("transient");
      }
      return new Promise((_resolve, reject) =>
        request.signal.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        ),
      );
    },
    confirmTermination: async () => new Date(),
  });
  await vi.waitFor(async () => expect((await view(id)).status).toBe("failed"), {
    timeout: 4000,
  });
  expect(calls).toBe(2);
  const detail = (
    await app!.inject({ method: "GET", url: `/tasks/${id}/runs` })
  ).json().runs[0];
  expect(
    Date.parse(detail.finishedAt) - Date.parse(detail.startedAt),
  ).toBeLessThan(600);
  expect((await view(id)).retryState!.totalRunMs).toBeGreaterThanOrEqual(1000);
});

test("automatic recovery cannot start with an executor that cannot prove termination", async () => {
  app = buildApp({
    databasePath: join(directory, "hub.sqlite"),
    execution: {
      config,
      executor: { analyze: async () => ({ output: "unused", usage: null }) },
    },
  });
  await expect(app.ready()).rejects.toThrow("termination tracking");
});

test("capacity recovery waits for provided time, reserves one check and reopens the queue only after success", async () => {
  config.capacityRecovery = {
    version: 1,
    initialDelayMs: 1000,
    maxDelayMs: 2000,
    jitterRatio: 0,
    maxChecks: 3,
  };
  const retryAt = new Date(Date.now() + 1500);
  const analyze = vi
    .fn<AnalysisExecutor["analyze"]>()
    .mockRejectedValueOnce(new AnalysisError("capacity", false, retryAt))
    .mockResolvedValue({ output: "Recovered account", usage: null });
  const id = await start({
    analyze,
    confirmTermination: async () => new Date(),
  });
  await vi.waitFor(async () =>
    expect((await view(id)).status).toBe("waiting_capacity"),
  );
  const before = (
    await app!.inject({ method: "GET", url: "/execution/provider-gate" })
  ).json();
  expect(before).toMatchObject({
    blocked: true,
    retryAt: retryAt.toISOString(),
    capacityState: { checks: 0, nextCheckAt: retryAt.toISOString() },
  });
  expect(analyze).toHaveBeenCalledTimes(1);
  await vi.waitFor(
    async () => expect((await view(id)).status).toBe("succeeded"),
    { timeout: 4000 },
  );
  expect(analyze).toHaveBeenCalledTimes(2);
  expect(
    (
      await app!.inject({ method: "GET", url: "/execution/provider-gate" })
    ).json(),
  ).toMatchObject({ blocked: false, capacityState: null });
  expect((await view(id)).retryState?.retries).toBe(1);
});
