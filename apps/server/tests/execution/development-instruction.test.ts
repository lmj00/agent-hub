import { expect, test } from "vitest";
import type { PlannedWork } from "../../src/modules/goals/goal-plan-policy.js";
import { developmentInstruction } from "../../src/modules/execution/development-workflow.js";
import type { VerificationResult } from "../../src/modules/execution/verification-config.js";

const work: PlannedWork = {
  planningTaskId: "planning",
  sourceRevision: "a".repeat(40),
  sourceDigest: "b".repeat(64),
  problemKey: "calculation",
  title: "Fix calculation",
  paths: ["src/calculate.ts", "tests/calculate.test.ts"],
  acceptanceCriteria: "Reproduce the original failure and pass the fixed tests.",
  evidence: ["The original calculation loses precision."],
};
const configuration = { image: "verification:local", command: ["test"], timeoutMs: 10000 };
function result(output: string): VerificationResult {
  return {
    candidateDigest: "c".repeat(64),
    inputDigest: "d".repeat(64),
    configurationDigest: "e".repeat(64),
    configuration,
    execution: { kind: "docker", containerId: "f".repeat(64), token: "test", engineId: "test" },
    imageId: `sha256:${"a".repeat(64)}`,
    status: "passed",
    exitCode: 0,
    oomKilled: false,
    elapsedMs: 1,
    output,
  };
}
function instruction(verification: VerificationResult, extraInstruction = "Fix calculation") {
  return developmentInstruction({
    instruction: extraInstruction,
    work,
    round: 1,
    role: "reviewer",
    verificationConfig: configuration,
    verification,
  });
}
const context = (prompt: string) => JSON.parse(prompt.split("\n").at(-1)!);

test("keeps middle-of-log regression evidence when the complete prompt fits", () => {
  const output = `${"setup\n".repeat(3000)}original-code regression failed\n${"test passed\n".repeat(1900)}`;
  const verification = result(output);
  const prompt = instruction(verification);
  expect(Buffer.byteLength(JSON.stringify({ instruction: prompt }))).toBeLessThanOrEqual(60000);
  expect(context(prompt).actualTest).toMatchObject({
    output,
    outputTruncated: false,
    storedOutputBytes: Buffer.byteLength(output),
    candidateDigest: verification.candidateDigest,
  });
  expect(verification.output).toBe(output);
});

test("uses the remaining serialized prompt budget without damaging Unicode or authority", () => {
  const output = `BEGIN\n${'한글🙂"\\\n'.repeat(7000)}\nEND`;
  const verification = { ...result(output), status: "failed" as const, exitCode: 1 };
  const prompt = instruction(verification, "required task context ".repeat(900));
  const data = context(prompt);
  expect(Buffer.byteLength(JSON.stringify({ instruction: prompt }))).toBeLessThanOrEqual(60000);
  expect(Buffer.byteLength(JSON.stringify({ instruction: prompt }))).toBeGreaterThan(59000);
  expect(data.actualTest).toMatchObject({
    status: "failed",
    exitCode: 1,
    outputTruncated: true,
    storedOutputBytes: Buffer.byteLength(output),
    candidateDigest: verification.candidateDigest,
    command: configuration.command,
  });
  expect(data.actualTest.output).toMatch(/^BEGIN/);
  expect(data.actualTest.output).toMatch(/END$/);
  expect(data.actualTest.output).not.toContain("\uFFFD");
  expect(data.actualTest.output).toContain("truncated");
  expect(data.acceptanceCriteria).toBe(work.acceptanceCriteria);
  expect(data.writePaths).toEqual(work.paths);
  expect(data.instruction).toBe("required task context ".repeat(900));
  expect(verification.output).toBe(output);
  expect(
    Buffer.byteLength(
      JSON.stringify({
        instruction: prompt,
        model: "fixture",
        effort: "medium",
        responseMode: "assessment",
      }),
    ),
  ).toBeLessThan(65536);
});

test("does not truncate task authority to make oversized non-log context fit", () => {
  expect(() => instruction(result("small test output"), "x".repeat(60000))).toThrow();
});

test("preserves an empty test output without marking it truncated", () => {
  expect(context(instruction(result(""))).actualTest).toMatchObject({
    output: "",
    outputTruncated: false,
    storedOutputBytes: 0,
  });
});
