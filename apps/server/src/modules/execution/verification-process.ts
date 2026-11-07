import {
  AnalysisError,
  redactOutput,
  type AnalysisRequest,
  type AnalysisResult,
  type ExecutionIdentity,
} from "./analysis.js";
import { attachContainer, readContainerExit } from "./container-runtime.js";
import {
  parseVerificationRequest,
  verificationConfigDigest,
  type VerificationResult,
} from "./verification-config.js";

const maxOutputBytes = 2 * 1024 * 1024;
const maxStoredOutputBytes = 65536;

function summarizeOutput(stdout: Buffer[], stderr: Buffer[]) {
  // Decode and redact each pipe as a whole. Arrival order across pipes must not
  // split UTF-8 characters or credentials, or bury stderr inside a stdout cut.
  const out = Buffer.from(redactOutput(Buffer.concat(stdout).toString("utf8")));
  const err = Buffer.from(redactOutput(Buffer.concat(stderr).toString("utf8")));
  const trim = (value: Buffer, limit: number) => {
    if (value.length <= limit) return value.toString("utf8");
    const marker = "\n... test output truncated ...\n";
    // Each cut may decode to a three-byte UTF-8 replacement character.
    const edge = Math.floor((limit - Buffer.byteLength(marker) - 6) / 2);
    return (
      value.subarray(0, edge).toString("utf8") +
      marker +
      value.subarray(-edge).toString("utf8")
    );
  };
  if (!out.length) return trim(err, maxStoredOutputBytes);
  if (!err.length) return trim(out, maxStoredOutputBytes);
  const separator = "\n--- stderr ---\n";
  const available = maxStoredOutputBytes - Buffer.byteLength(separator);
  const errLimit = Math.min(
    err.length,
    available - Math.min(out.length, Math.floor(available / 2)),
  );
  return trim(out, available - errLimit) + separator + trim(err, errLimit);
}

export function verificationRunnerInput(request: AnalysisRequest) {
  const verification = parseVerificationRequest(request.verification);
  if (
    !request.development ||
    request.workflow ||
    request.responseMode ||
    request.outputSchema ||
    request.planning
  )
    throw new AnalysisError("unsupported_settings");
  const input = JSON.stringify({
    input: request.development,
    command: verification.config.command,
  });
  if (Buffer.byteLength(input) > 1024 * 1024)
    throw new AnalysisError("input_unavailable");
  return input;
}

export async function runVerificationContainer(
  identity: ExecutionIdentity,
  request: AnalysisRequest,
  confirmTermination: () => Promise<Date | null>,
): Promise<AnalysisResult> {
  const verification = parseVerificationRequest(request.verification);
  const input = verificationRunnerInput(request);
  const startedAt = performance.now(),
    child = attachContainer(identity);
  let bytes = 0,
    interrupted: "timed_out" | "output_limit" | undefined;
  let stopping: Promise<Date | null> | undefined;
  const stdout: Buffer[] = [],
    stderr: Buffer[] = [];
  const stop = () => {
    stopping ??= confirmTermination();
    child.kill("SIGKILL");
  };
  const receive = (chunks: Buffer[], chunk: Buffer) => {
    if (bytes >= maxOutputBytes) return;
    const remaining = maxOutputBytes - bytes;
    chunks.push(chunk.subarray(0, remaining));
    bytes += chunk.length;
    if (bytes >= maxOutputBytes) {
      interrupted ??= "output_limit";
      stop();
    }
  };
  child.stdout!.on("data", (chunk: Buffer) => receive(stdout, chunk));
  child.stderr!.on("data", (chunk: Buffer) => receive(stderr, chunk));
  const onAbort = () => stop();
  request.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    interrupted ??= "timed_out";
    stop();
  }, verification.config.timeoutMs);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", () => resolve());
      child.stdin!.on("error", () => {
        /* A failed entrypoint may close stdin early; inspect its real exit status. */
      });
      child.stdin!.end(input);
      if (request.signal.aborted) onAbort();
    });
    clearTimeout(timer);
    if (stopping && !(await stopping))
      throw new AnalysisError("provider_error", true);
    request.signal.throwIfAborted();
    const exit = await readContainerExit(identity);
    const output = summarizeOutput(stdout, stderr);
    const result: VerificationResult = {
      candidateDigest: verification.candidateDigest,
      inputDigest: request.development!.inputDigest,
      configurationDigest: verificationConfigDigest(verification.config),
      configuration: verification.config,
      execution: identity,
      ...exit,
      status:
        interrupted ??
        (exit.exitCode === 0 && !exit.oomKilled ? "passed" : "failed"),
      elapsedMs: Math.ceil(performance.now() - startedAt),
      output,
    };
    return { output, usage: null, verification: result };
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", onAbort);
  }
}
