import { expect, test, vi } from "vitest";
import {
  projectsSchema,
  queueSchema,
  recoverySchema,
} from "@agent-hub/contracts";
import { ApiError, createApiClient, errorMessage } from "../src/api.js";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });

test("concurrent session initialization shares one request and mutations use the rotated CSRF token", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      json({
        authenticated: false,
        csrfToken: "anonymous-test-token",
        expiresAt: null,
      }),
    )
    .mockResolvedValueOnce(
      json({
        authenticated: true,
        csrfToken: "rotated-test-token",
        expiresAt: "2026-11-03T07:00:00Z",
      }),
    )
    .mockResolvedValueOnce(json({ projects: [] }));
  const client = createApiClient(fetcher);
  await Promise.all([client.session(), client.session(), client.session()]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await client.login("test fixture password");
  expect(fetcher.mock.calls[1]?.[1]?.headers).toMatchObject({
    "X-CSRF-Token": "anonymous-test-token",
  });
  await client.request("/test-mutation", projectsSchema, {
    method: "POST",
    body: {},
  });
  expect(fetcher.mock.calls[2]?.[1]).toMatchObject({
    credentials: "same-origin",
    headers: { "X-CSRF-Token": "rotated-test-token" },
  });
});

test("unexpected status values, extra properties and invalid timestamps are rejected at the API boundary", async () => {
  const normal = {
    state: "idle",
    runId: null,
    taskId: null,
    reason: null,
    lastCheckedAt: "2026-11-03T01:00:00Z",
    automaticRecoveryEnabled: false,
    capacityRecoveryEnabled: false,
  };
  for (const value of [
    { ...normal, state: "made-up" },
    { ...normal, secret: "should-not-be-rendered" },
    { ...normal, lastCheckedAt: "yesterday" },
  ]) {
    const client = createApiClient(
      vi.fn<typeof fetch>().mockResolvedValueOnce(json(value)),
    );
    await expect(
      client.request("/execution", queueSchema),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  }
});

test("server HTML, error details and unknown errors are never surfaced as user-facing text", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response("<html>private error</html>", { status: 502 }),
    );
  const client = createApiClient(fetcher);
  const failure = await client
    .request("/projects", projectsSchema)
    .catch((error) => error);
  expect(failure).toBeInstanceOf(ApiError);
  expect(errorMessage(failure)).not.toContain("private error");
  expect(
    errorMessage(new ApiError(409, "<script>private payload</script>")),
  ).not.toContain("private payload");
});

test("a pending recovery receipt is returned as pending, without retries or premature success", async () => {
  const receipt = {
    id: "00000000-0000-4000-8000-000000000001",
    taskId: "00000000-0000-4000-8000-000000000002",
    runId: null,
    requestKey: "fixture",
    action: "cancel",
    providerGateVersion: null,
    status: "pending",
    resultStatus: null,
    errorCode: null,
    createdAt: "2026-11-03T01:00:00Z",
    finishedAt: null,
  };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(json(receipt, 202));
  const client = createApiClient(fetcher);
  expect(
    await client.request("/tasks/fixture/recovery-requests", recoverySchema, {
      method: "POST",
      body: { requestKey: "fixture", action: "cancel", runId: null },
    }),
  ).toMatchObject({ status: "pending", finishedAt: null });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test("caller cancellation reaches fetch and a failed write is not automatically repeated", async () => {
  const controller = new AbortController();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async (_input, init) => {
      controller.abort();
      expect(init?.signal?.aborted).toBe(true);
      throw new TypeError("offline");
    });
  const client = createApiClient(fetcher);
  await expect(
    client.request("/projects", projectsSchema, {
      method: "POST",
      signal: controller.signal,
      body: {},
    }),
  ).rejects.toThrow("offline");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
