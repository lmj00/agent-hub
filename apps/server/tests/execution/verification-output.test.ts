import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ attach: vi.fn() }));
vi.mock("../../src/modules/execution/container-runtime.js", () => ({
  attachContainer: mocks.attach,
  readContainerExit: async () => ({
    exitCode: 1,
    oomKilled: false,
    imageId: "sha256:" + "a".repeat(64),
  }),
}));
import { runVerificationContainer } from "../../src/modules/execution/verification-process.js";

// Control pipe delivery order; keep the production collector, redactor and
// truncation. Actual container exit/termination is covered by verification-process.
function execution(timeoutMs: number | null = 1000) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  mocks.attach.mockReturnValue(child);
  const pending = runVerificationContainer(
    {
      kind: "docker",
      containerId: "a".repeat(64),
      token: "fixture",
      engineId: "fixture",
    },
    {
      instruction: "Fixture",
      model: "fixture",
      workspace: "/fixture",
      signal: new AbortController().signal,
      development: {
        baseRevision: "a".repeat(40),
        inputDigest: "b".repeat(64),
        scope: {
          goalId: "fixture",
          goalVersion: 1,
          allowedPaths: ["src"],
          excludedPaths: [],
        },
        writePaths: ["src"],
        files: [],
      },
      verification: {
        candidateDigest: "c".repeat(64),
        config: {
          image: "fixture",
          command: ["node", "--test"],
          timeoutMs,
        },
      },
    },
    async () => new Date(),
  );
  return { child, pending };
}

test("an explicit unlimited timeout preserves a long verification until its real exit", async () => {
  vi.useFakeTimers();
  try {
    const { child, pending } = execution(null);
    await vi.advanceTimersByTimeAsync(600001);
    expect(child.kill).not.toHaveBeenCalled();
    child.emit("close", 1);
    const result = await pending;
    expect(result.verification).toMatchObject({
      status: "failed",
      exitCode: 1,
      configuration: { timeoutMs: null },
    });
  } finally {
    vi.useRealTimers();
  }
});

test.each(["stdout", "stderr"] as const)(
  "preserves diagnostics arriving between long %s chunks",
  async (stream) => {
    const { child, pending } = execution();
    const other = stream === "stdout" ? "stderr" : "stdout";
    child[stream].write("test startup\n" + "한".repeat(15000));
    child[other].write("final assertion failed sk-synthetic_token\n");
    child[stream].write("한".repeat(15000) + "\nstream end");
    child.emit("close", 1);
    const result = await pending;
    expect(result.verification?.status).toBe("failed");
    expect(result.output.includes("test startup")).toBe(true);
    expect(result.output.includes("stream end")).toBe(true);
    expect(result.output.includes("final assertion failed [REDACTED]")).toBe(true);
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(65536);
  },
);

test("redacts and decodes each pipe before combining interleaved byte fragments", async () => {
  const { child, pending } = execution();
  const korean = Buffer.from("가");
  child.stdout.write("credential sk-synthe");
  child.stderr.write(korean.subarray(0, 1));
  child.stdout.write("tic_token\n");
  child.stderr.write(korean.subarray(1));
  child.emit("close", 1);
  const result = await pending;
  expect(result.output).toContain("credential [REDACTED]");
  expect(result.output).toContain("가");
  expect(result.output).not.toContain("tic_token");
  expect(result.output).not.toContain("�");
});

test("keeps the beginning and end of both busy pipes within the stored byte limit", async () => {
  const { child, pending } = execution();
  for (const stream of ["stdout", "stderr"] as const) {
    child[stream].write(`${stream} start\n${"한".repeat(30000)}\n${stream} end`);
  }
  child.emit("close", 1);
  const result = await pending;
  for (const stream of ["stdout", "stderr"]) {
    expect(result.output.includes(`${stream} start`)).toBe(true);
    expect(result.output.includes(`${stream} end`)).toBe(true);
  }
  expect(result.output).toContain("test output truncated");
  expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(65536);
});
