import { expect, test } from "vitest";
import {
  parseDevelopmentChanges,
  parseDevelopmentInput,
  type DevelopmentExecutionInput,
  developmentWriteDirectories,
} from "../src/modules/execution/development-capture.js";

const input: DevelopmentExecutionInput = {
  baseRevision: "a".repeat(40),
  inputDigest: "b".repeat(64),
  scope: {
    goalId: "goal",
    goalVersion: 1,
    allowedPaths: ["src", "tests"],
    excludedPaths: ["src/private"],
  },
  writePaths: ["src"],
  files: [{ path: "src/main.ts", bytes: 0, blob: "c".repeat(40), mode: "100644" }],
};

test("only fixed verification accepts an input without developer write paths", () => {
  const readonly = { ...input, writePaths: [] };
  expect(() => parseDevelopmentInput(readonly)).toThrow();
  expect(parseDevelopmentInput(readonly, { verification: true }).writePaths).toEqual([]);
  expect(() =>
    parseDevelopmentInput(
      { ...readonly, files: [{ ...input.files[0]!, path: "src/.env" }] },
      { verification: true },
    ),
  ).toThrow();
});

test("maps file and missing paths to existing sandbox directories without broadening accepted Task changes", () => {
  expect(
    developmentWriteDirectories({
      ...input,
      writePaths: ["src/main.ts", "src/new.ts"],
    }),
  ).toEqual(["src"]);
  expect(
    developmentWriteDirectories({
      ...input,
      writePaths: ["new-folder/file.ts"],
    }),
  ).toEqual(["."]);
  expect(
    developmentWriteDirectories({
      ...input,
      writePaths: ["src", "src/main.ts"],
    }),
  ).toEqual(["src"]);
  const exact = { ...input, writePaths: ["src/main.ts"] };
  expect(() =>
    parseDevelopmentChanges(
      {
        baseRevision: exact.baseRevision,
        inputDigest: exact.inputDigest,
        changes: [{ path: "src/sibling.ts", mode: "100644", content: "YQ==" }],
      },
      exact,
    ),
  ).toThrow("permitted scope");
});

test.each([
  "path",
  "manifest-private",
  "manifest-mode",
  "manifest-size",
  "manifest-hash",
  "write-scope",
])("rejects invalid development input before starting the container: %s", (kind) => {
  const value = structuredClone(input);
  if (kind === "path") value.files[0]!.path = "src/../../escape";
  if (kind === "manifest-private") value.files[0]!.path = "src/.env";
  if (kind === "manifest-mode") Object.assign(value.files[0]!, { mode: "120000" });
  if (kind === "manifest-size") value.files[0]!.bytes = 1048577;
  if (kind === "manifest-hash") value.files[0]!.blob = "x".repeat(40);
  if (kind === "write-scope") value.writePaths = ["outside"];
  expect(() => parseDevelopmentInput(value)).toThrow();
});

test.each(["binding", "scope", "private", "mode", "encoding", "alias"])(
  "rejects forged child artifacts: %s",
  (kind) => {
    const result = {
      baseRevision: input.baseRevision,
      inputDigest: input.inputDigest,
      changes: [{ path: "src/main.ts", mode: "100644", content: "YQ==" }],
    };
    if (kind === "binding") result.inputDigest = "f".repeat(64);
    if (kind === "scope") result.changes[0]!.path = "tests/main.test.ts";
    if (kind === "private") result.changes[0]!.path = "src/.env";
    if (kind === "mode") result.changes[0]!.mode = "120000";
    if (kind === "encoding") result.changes[0]!.content = "not canonical base64";
    if (kind === "alias")
      result.changes.push({
        path: "src/Main.ts",
        mode: "100644",
        content: "Yg==",
      });
    expect(() => parseDevelopmentChanges(result, input)).toThrow();
  },
);

test("retains arbitrary code bytes, execution mode and deletions without treating them as model prose", () => {
  const content = Buffer.from([0, 255, 10]).toString("base64");
  const result = {
    baseRevision: input.baseRevision,
    inputDigest: input.inputDigest,
    changes: [
      { path: "src/binary", mode: "100755", content },
      { path: "src/main.ts", mode: null, content: null },
    ],
  };
  expect(parseDevelopmentChanges(result, parseDevelopmentInput(input))).toEqual(result);
});
