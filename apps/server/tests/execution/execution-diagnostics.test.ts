import { afterEach, expect, test, vi } from "vitest";
import {
  createQueueDiagnostics,
  type QueueDiagnosticContext,
} from "../../src/modules/execution/execution-diagnostics.js";
import { ExecutionConfigError } from "../../src/modules/execution/execution-config.js";

const context: QueueDiagnosticContext = {
  phase: "validation",
  reason: "configuration_invalid",
  runId: null,
  taskId: null,
};
afterEach(() => vi.restoreAllMocks());

test("logs causes using fixed codes and messages, excluding raw messages, SQL, paths and unknown properties", () => {
  const report = vi.fn();
  const diagnostics = createQueueDiagnostics(report);
  const cause = Object.assign(new Error("SQL with secret_value"), {
    code: "SQLITE_BUSY",
    path: "/private/secret_value",
  });
  diagnostics.failure(new Error("Bearer secret_value", { cause }), {
    ...context,
    phase: "claim",
    reason: "storage_error",
  });
  expect(report.mock.calls[0]?.[0]).toMatchObject({
    phase: "claim",
    code: "SQLITE_BUSY",
    message: "Database is busy",
  });
  diagnostics.failure(
    Object.assign(new Error("secret_value"), { code: "secret_value", name: "secret_value" }),
    context,
  );
  expect(report.mock.calls[1]?.[0].code).toBe("UNKNOWN_ERROR");
  diagnostics.failure(new ExecutionConfigError("PROJECT_CONFIG_NOT_ALLOWED"), context);
  expect(report.mock.calls[2]?.[0].code).toBe("PROJECT_CONFIG_NOT_ALLOWED");
  expect(JSON.stringify(report.mock.calls)).not.toContain("secret_value");
});

test("reports repeated failures once per minute with counts and resets after recovery or a changed cause", () => {
  let time = 0;
  vi.spyOn(Date, "now").mockImplementation(() => time);
  const report = vi.fn();
  const diagnostics = createQueueDiagnostics(report);
  const error = new SyntaxError("private input");
  diagnostics.failure(error, context);
  time = 59999;
  diagnostics.failure(error, context);
  expect(report).toHaveBeenCalledTimes(1);
  time = 60000;
  diagnostics.failure(error, context);
  expect(report.mock.calls[1]?.[0]).toMatchObject({ code: "INVALID_JSON", occurrences: 3 });
  diagnostics.recovered("claim");
  expect(report).toHaveBeenCalledTimes(2);
  diagnostics.recovered("validation");
  expect(report.mock.calls[2]?.[0]).toMatchObject({
    event: "execution_queue.recovered",
    occurrences: 3,
  });
  diagnostics.failure(error, context);
  expect(report.mock.calls[3]?.[0].occurrences).toBe(1);
  diagnostics.failure(Object.assign(new Error(), { code: "ENOENT" }), context);
  expect(report.mock.calls[4]?.[0]).toMatchObject({ code: "ENOENT", occurrences: 1 });
});
