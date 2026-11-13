import { expect, test } from "vitest";
import {
  observeCi,
  initialCiState,
  reserveCiRepair,
  ciServiceSnapshot,
  cleanCiText,
  ciPublicationIndex,
  type CiState,
} from "../src/modules/github/ci-recovery.js";
const head = "a".repeat(40);
const prefix = "/repos/example/project";
function fixture() {
  let state = initialCiState();
  let ref = head;
  let configured = true;
  let workflowIds = [4];
  let lost = false;
  let log = "Error: Failed to download Chromium: ECONNRESET";
  let steps = ["Install Chromium"];
  let run = {
    id: 12,
    workflow_id: 4,
    head_sha: head,
    head_branch: "agent-hub/example",
    event: "push",
    status: "completed",
    conclusion: "failure",
    run_attempt: 1,
  };
  const writes: string[] = [];
  const saved: CiState[] = [];
  const api = async (path: string, method = "GET"): Promise<unknown> => {
    if (method === "POST") {
      expect(state.retries["12"]?.state).toBe("reserved");
      writes.push(path);
      if (lost) throw new Error("connection lost");
      return {};
    }
    if (path.includes("/git/ref/heads/")) return { object: { sha: ref } };
    if (path.includes("/actions/workflows?"))
      return {
        total_count: configured ? 1 : 0,
        workflows: configured ? [{ id: 4, state: "active" }] : [],
      };
    if (path.includes("/actions/runs?")) return { total_count: 1, workflow_runs: [run] };
    if (path.endsWith("/actions/runs/12")) return run;
    if (path.includes("/jobs?"))
      return {
        total_count: 1,
        jobs: [
          {
            id: 21,
            run_id: 12,
            name: "Linux tests",
            conclusion: "failure",
            steps: steps.map((name) => ({ name, conclusion: "failure" })),
          },
        ],
      };
    throw Error(`Unexpected request ${path}`);
  };
  const save = (value: CiState) => {
    state = structuredClone(value);
    saved.push(state);
  };
  const observe = () =>
    observeCi({
      api,
      prefix,
      branch: "agent-hub/example",
      workflowIds,
      head: ref,
      previous: state,
      save,
      readLog: async () => log,
      now: new Date("2026-11-12T12:00:00Z"),
    });
  return {
    api,
    save,
    observe,
    writes,
    saved,
    state: () => state,
    setWorkflowIds: (value: number[]) => {
      workflowIds = value;
    },
    configure: (value: boolean) => {
      configured = value;
    },
    failWrite: () => {
      lost = true;
    },
    setRun: (value: Partial<typeof run>) => {
      run = { ...run, ...value };
    },
    setHead: (value: string) => {
      ref = value;
    },
    diagnostic: (value: string, names = ["Test"]) => {
      log = value;
      steps = names;
    },
  };
}

test("reruns a proven transient installation failure once, after persisting intent", async () => {
  const f = fixture();
  expect((await f.observe()).status).toBe("retrying");
  expect(f.writes).toEqual([`${prefix}/actions/runs/12/rerun-failed-jobs`]);
  await f.observe();
  expect(f.writes).toHaveLength(1);
  f.setRun({ run_attempt: 2 });
  expect((await f.observe()).status).toBe("blocked");
  expect(f.writes).toHaveLength(1);
});
test("a lost rerun response is reconciled without another POST, including after restart", async () => {
  const f = fixture();
  f.failWrite();
  expect((await f.observe()).status).toBe("blocked");
  await f.observe();
  expect(f.writes).toHaveLength(1);
  f.setRun({ run_attempt: 2, conclusion: "success" });
  const recovered = await f.observe();
  expect(recovered.status).toBe("passed");
  expect(recovered.incident).toBeNull();
});
test("source failures are passed to planning and only two evidence-linked repairs can be published", async () => {
  const f = fixture();
  f.diagnostic("AssertionError: expected total to be 42 at src/TotalTest.java:16");
  const state = await f.observe();
  expect(state.status).toBe("code_failure");
  expect(f.writes).toHaveLength(0);
  expect(() => reserveCiRepair(state, "b".repeat(40), [], f.save)).toThrow(
    "CI_REPAIR_EVIDENCE_REQUIRED",
  );
  const evidence = [`CI:${state.incident!.key}`];
  reserveCiRepair(state, "b".repeat(40), evidence, f.save);
  reserveCiRepair(state, "b".repeat(40), evidence, f.save);
  reserveCiRepair(state, "c".repeat(40), evidence, f.save);
  expect(() => reserveCiRepair(state, "d".repeat(40), evidence, f.save)).toThrow("CI_REPAIR_LIMIT");
  expect(ciServiceSnapshot(state, new Date(state.checkedAt)).activityState).toBe("degraded");
  expect(ciServiceSnapshot(state, new Date(state.checkedAt)).summary).toContain(evidence[0]);
});
test("repair budget survives a new SHA while the same CI incident remains unresolved", async () => {
  const f = fixture();
  f.diagnostic("Tests failed in the summary suite");
  const state = await f.observe();
  const key = state.incident!.key;
  reserveCiRepair(state, "b".repeat(40), [`CI:${key}`], f.save);
  f.setHead("b".repeat(40));
  f.setRun({ head_sha: "b".repeat(40) });
  const next = await f.observe();
  expect(next.incident).toEqual({ key, repairCommits: ["b".repeat(40)] });
});
test("retains the failed test and its cause before generic Gradle failure footers", async () => {
  const f = fixture();
  f.diagnostic(
    [
      "Received 128 of 128 (100.0%), 10 MBs/sec",
      "Received 256 of 256 (100.0%), 20 MBs/sec",
      'SocketClientTest > cancellationTerminatesTheActualConnection(Lookup, boolean) > [4] lookup = "CLOSED", closeClient = "true" FAILED',
      "    java.util.concurrent.ExecutionException at SocketClientTest.java:89",
      "        Caused by: java.net.SocketException at SocketClientTest.java:69",
      "1018 tests completed, 1 failed",
      "> Task :test FAILED",
      "FAILURE: Build failed with an exception.",
      "Execution failed for task ':test'.",
      "> There were failing tests. See the report at: file:///workspace/build/reports/tests/test/index.html",
      "BUILD FAILED in 4m 29s",
      "##[error]Process completed with exit code 1.",
    ]
      .map((line) => `2026-01-01T00:00:00.1234567Z ${line}`)
      .join("\n"),
  );
  const state = await f.observe();
  expect(state.status).toBe("code_failure");
  expect(state.summary).toContain("SocketClientTest > cancellationTerminatesTheActualConnection");
  expect(state.summary).toContain(
    "Caused by: java.net.SocketException at SocketClientTest.java:69",
  );
  expect(state.summary).not.toContain("2026-01-01T");
  expect(state.summary.length).toBeLessThanOrEqual(500);
  expect(f.writes).toHaveLength(0);
});
test("retains assertion values after a Jest failure heading", async () => {
  const f = fixture();
  f.diagnostic(
    "FAIL tests/total.test.ts\nExpected: 42\nReceived: 41\nTest Suites: 1 failed\nTests: 1 failed\nProcess completed with exit code 1.",
  );
  const state = await f.observe();
  expect(state.status).toBe("code_failure");
  expect(state.summary).toContain("FAIL tests/total.test.ts");
  expect(state.summary).toContain("Expected: 42");
  expect(state.summary).toContain("Received: 41");
  expect(f.writes).toHaveLength(0);
});
test("keeps actionable CI diagnostics bounded and redacted", async () => {
  const f = fixture();
  f.diagnostic(
    `AssertionError: expected token=fixture-private-value ${"detail ".repeat(100)}\nBUILD FAILED\n##[error]Process completed with exit code 1.`,
  );
  const state = await f.observe();
  expect(state.status).toBe("code_failure");
  expect(state.summary).toContain("AssertionError: expected token=[REDACTED]");
  expect(state.summary).not.toContain("fixture-private-value");
  expect(state.summary.length).toBeLessThanOrEqual(500);
  expect(f.writes).toHaveLength(0);
});
test("test network errors do not trigger an infrastructure retry", async () => {
  const f = fixture();
  f.diagnostic("Error: ECONNRESET during the API integration test");
  expect((await f.observe()).status).toBe("blocked");
  expect(f.writes).toHaveLength(0);
});
test("unknown errors, skipped checks and manual cancellations never count as success", async () => {
  const f = fixture();
  f.diagnostic("Process completed with exit code 1");
  expect((await f.observe()).status).toBe("blocked");
  for (const conclusion of ["cancelled", "skipped", "action_required", "neutral"]) {
    f.setRun({ conclusion });
    expect((await f.observe()).status).toBe("blocked");
  }
  expect(f.writes).toHaveLength(0);
});
test("absence of CI is visible, and removing CI cannot clear an unresolved failure", async () => {
  const f = fixture();
  f.configure(false);
  f.setWorkflowIds([]);
  expect((await f.observe()).status).toBe("unconfigured");
  expect(f.state().lastSuccessAt).toBeNull();
  expect(ciServiceSnapshot(f.state(), new Date(f.state().checkedAt)).activityState).toBe("unknown");
  f.configure(true);
  f.setWorkflowIds([4]);
  f.diagnostic("Tests failed");
  await f.observe();
  f.configure(false);
  expect((await f.observe()).status).toBe("blocked");
});
test("ignores other branches and rejects a mismatched SHA or an incomplete response", async () => {
  const f = fixture();
  f.setRun({ head_branch: "someone-else" });
  expect((await f.observe()).status).toBe("pending");
  f.setRun({ head_branch: "agent-hub/example", head_sha: "c".repeat(40) });
  await expect(f.observe()).rejects.toThrow("CI_HEAD_MISMATCH");
  await expect(
    observeCi({
      api: async (path) =>
        path.includes("/git/ref/")
          ? { object: { sha: head } }
          : { total_count: 101, workflows: [] },
      readLog: async () => "",
      prefix,
      branch: "agent-hub/example",
      workflowIds: [4],
      head,
      previous: initialCiState(),
      save: f.save,
    }),
  ).rejects.toThrow("CI_RESPONSE_INCOMPLETE");
  expect(f.writes).toHaveLength(0);
});
test("requires the branch to stay on the observed head immediately before retrying", async () => {
  const f = fixture();
  let reads = 0;
  const api = async (path: string, method?: "GET" | "POST") => {
    if (path.includes("/git/ref/") && ++reads === 3) return { object: { sha: "f".repeat(40) } };
    return f.api(path, method);
  };
  await expect(
    observeCi({
      api,
      readLog: async () => "ECONNRESET",
      prefix,
      branch: "agent-hub/example",
      workflowIds: [4],
      head,
      previous: initialCiState(),
      save: f.save,
    }),
  ).rejects.toThrow("CI_HEAD_CHANGED");
  expect(f.writes).toHaveLength(0);
});
test("old observations do not advertise current CI success and logs redact credentials", () => {
  const state: CiState = {
    ...initialCiState(),
    status: "passed",
    summary: "passed",
    checkedAt: "2026-11-12T00:00:00Z",
  };
  expect(ciServiceSnapshot(state, new Date("2026-11-12T01:00:00Z")).activityState).toBe("unknown");
  const cleaned = cleanCiText(
    "Bearer example-secret ghp_exampletoken github_pat_exampletoken password=example-password sk-examplekey",
  );
  expect(cleaned).not.toMatch(/example/);
});

test("requires an explicit CI workflow allowlist and does not rerun deployment workflows", async () => {
  const f = fixture();
  f.setWorkflowIds([]);
  expect((await f.observe()).status).toBe("blocked");
  f.setWorkflowIds([4]);
  f.setRun({ workflow_id: 9 });
  expect((await f.observe()).status).toBe("pending");
  expect(f.writes).toHaveLength(0);
  f.configure(false);
  expect((await f.observe()).status).toBe("blocked");
});

test("a running check blocks follow-up publication until its exact head is evaluated", async () => {
  const f = fixture();
  f.setRun({ status: "in_progress" });
  const state = await f.observe();
  expect(state.status).toBe("pending");
  expect(() => reserveCiRepair(state, "b".repeat(40), [], f.save)).toThrow(
    "CI_NOT_READY_FOR_PUBLICATION",
  );
  expect(f.writes).toHaveLength(0);
});

test("recognizes Gradle and JUnit failures and can reach a repair behind verified local backlog", async () => {
  const f = fixture();
  f.diagnostic(
    "> Task :test FAILED\nOrderTest > parsesOrders() FAILED\norg.opentest4j.AssertionFailedError: expected: <A> but was: <B>\n1 test completed, 1 failed\nExecution failed for task ':test'.\nThere were failing tests.",
  );
  const state = await f.observe();
  expect(state.status).toBe("code_failure");
  const evidence = [`CI:${state.incident!.key}`];
  const backlog = [{ evidence: ["independent verified feature"] }, { evidence }];
  expect(ciPublicationIndex(state, backlog)).toBe(1);
  reserveCiRepair(state, "c".repeat(40), evidence, f.save);
  expect(state.incident!.repairCommits).toEqual(["c".repeat(40)]);
  expect(f.writes).toHaveLength(0);
  expect(ciPublicationIndex({ ...state, status: "pending" }, backlog)).toBe(-1);
});

test("recovers the exact second repair reservation without allocating a third attempt", async () => {
  const f = fixture();
  f.diagnostic("There were failing tests.");
  const first = await f.observe();
  const evidence = [`CI:${first.incident!.key}`];
  reserveCiRepair(first, "b".repeat(40), evidence, f.save);
  reserveCiRepair(first, "c".repeat(40), evidence, f.save);
  const observed = await f.observe();
  expect(observed.status).toBe("blocked");
  reserveCiRepair(observed, "c".repeat(40), evidence, f.save);
  expect(observed.incident!.repairCommits).toHaveLength(2);
  expect(() => reserveCiRepair(observed, "d".repeat(40), evidence, f.save)).toThrow();
  expect(() =>
    reserveCiRepair({ ...observed, blockedReason: null }, "c".repeat(40), evidence, f.save),
  ).toThrow();
  expect(() =>
    reserveCiRepair(observed, "c".repeat(40), ["CI:another-incident"], f.save),
  ).toThrow();
});

test("a generic Gradle test-task failure caused by dependency resolution is not a code defect", async () => {
  const f = fixture();
  f.diagnostic(
    "> Task :test FAILED\nCould not resolve all files for configuration ':testRuntimeClasspath'.\nCould not GET dependency metadata. Connection timed out.",
    ["Run tests"],
  );
  expect((await f.observe()).status).toBe("blocked");
  expect(f.writes).toHaveLength(0);
});
