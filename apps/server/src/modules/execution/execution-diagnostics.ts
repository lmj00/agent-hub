import { executionConfigErrors } from "./execution-config.js";

const diagnosticMessages: Record<string, string> = {
  ...executionConfigErrors,
  EACCES: "File access denied",
  EPERM: "Operation not permitted",
  ENOENT: "Required file or directory was not found",
  ENOTDIR: "Expected a directory",
  EISDIR: "Expected a file",
  ELOOP: "Invalid symbolic link chain",
  ENOSPC: "No disk space available",
  EMFILE: "Too many open files",
  SQLITE_BUSY: "Database is busy",
  SQLITE_LOCKED: "Database is locked",
  SQLITE_READONLY: "Database is read-only",
  SQLITE_FULL: "Database storage is full",
  SQLITE_IOERR: "Database I/O failed",
  SQLITE_CANTOPEN: "Database could not be opened",
  SQLITE_CONSTRAINT: "Database constraint rejected the operation",
  SQLITE_CORRUPT: "Database integrity error",
  SQLITE_NOTADB: "Invalid database file",
  INVALID_JSON: "Configuration JSON could not be parsed",
  TYPE_ERROR: "Unexpected value while processing execution",
  UNKNOWN_ERROR: "Unexpected execution queue error; inspect the reported phase",
};

export type QueueDiagnosticContext = {
  phase: "recovery" | "validation" | "planning" | "claim" | "execution";
  reason: "configuration_invalid" | "storage_error";
  runId: string | null;
  taskId: string | null;
};
export type QueueDiagnostic = QueueDiagnosticContext & {
  event: "execution_queue.error" | "execution_queue.recovered";
  code: string;
  message: string;
  occurrences: number;
};

function diagnosticCode(error: unknown) {
  let current = error;
  let fallback = "UNKNOWN_ERROR";
  // Drizzle가 감싼 SQLite 오류도 확인하되 원문·경로·SQL·임의 속성은 로그로 보내지 않습니다.
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    if ("code" in current && typeof current.code === "string") {
      const code = current.code.startsWith("SQLITE_")
        ? current.code.split("_").slice(0, 2).join("_")
        : current.code;
      if (Object.hasOwn(diagnosticMessages, code)) return code;
    }
    if (current instanceof SyntaxError) fallback = "INVALID_JSON";
    else if (current instanceof TypeError) fallback = "TYPE_ERROR";
    current = current.cause;
  }
  return fallback;
}

const REPEATED_ERROR_LOG_INTERVAL_MS = 60000;

export function createQueueDiagnostics(report: (diagnostic: QueueDiagnostic) => void) {
  let previous: { signature: string; loggedAt: number; diagnostic: QueueDiagnostic } | undefined;
  return {
    failure(error: unknown, context: QueueDiagnosticContext) {
      const code = diagnosticCode(error);
      const signature = JSON.stringify([context.phase, context.runId, context.taskId, code]);
      const now = Date.now();
      let occurrences = 1;
      let shouldReport = true;
      let loggedAt = now;
      if (previous?.signature === signature) {
        occurrences = previous.diagnostic.occurrences + 1;
        shouldReport = now - previous.loggedAt >= REPEATED_ERROR_LOG_INTERVAL_MS;
        if (!shouldReport) loggedAt = previous.loggedAt;
      }
      const diagnostic: QueueDiagnostic = {
        ...context,
        event: "execution_queue.error",
        code,
        message: diagnosticMessages[code] ?? "Unexpected execution queue error",
        occurrences,
      };
      previous = { signature, diagnostic, loggedAt };
      if (shouldReport) report(diagnostic);
    },
    recovered(phase: QueueDiagnosticContext["phase"]) {
      if (previous?.diagnostic.phase === phase) {
        report({ ...previous.diagnostic, event: "execution_queue.recovered" });
        previous = undefined;
      }
    },
  };
}
