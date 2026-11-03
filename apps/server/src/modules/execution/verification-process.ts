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
  const chunks: Buffer[] = [];
  const stop = () => {
    stopping ??= confirmTermination();
    child.kill("SIGKILL");
  };
  const receive = (chunk: Buffer) => {
    if (bytes >= maxOutputBytes) return;
    const remaining = maxOutputBytes - bytes;
    chunks.push(chunk.subarray(0, remaining));
    bytes += chunk.length;
    if (bytes >= maxOutputBytes) {
      interrupted ??= "output_limit";
      stop();
    }
  };
  child.stdout!.on("data", receive);
  child.stderr!.on("data", receive);
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
    const redacted = Buffer.from(
      redactOutput(Buffer.concat(chunks).toString("utf8")),
    );
    // Preserve the final assertion/stack trace as well as startup context.
    // Leave byte margin for UTF-8 replacement characters at either cut.
    const output =
      redacted.length <= 65533
        ? redacted.toString("utf8")
        : `${redacted.subarray(0, 32700).toString("utf8")}\n... test output truncated ...\n${redacted.subarray(-32700).toString("utf8")}`;
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
