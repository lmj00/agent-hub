import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, test } from "vitest";
import { isWithin, loadExecutionConfig, validateExecutionEnvironment } from "../src/modules/execution/execution-config.js";

let directory: string;
let file: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "hub-config-"));
  mkdirSync(join(directory, "auth")); mkdirSync(join(directory, "workspace"));
  writeFileSync(join(directory, "auth", "auth.json"), JSON.stringify({ auth_mode: "chatgpt" }));
  file = join(directory, "execution.json");
  writeFileSync(file, JSON.stringify({ model: "test-model", codexHome: "auth", workspaces: { example: "workspace" } }));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

test("resolves prepared workspaces relative to the private config", () => {
  const config = loadExecutionConfig(file);
  expect(config.model).toBe("test-model");
  expect(config.timeoutMs).toBe(300000);
  expect(config.workspaces.get("example")).toMatch(/\/workspace$/);
  expect(isWithin(config.workspaces.get("example")!, config.codexHome)).toBe(false);
  const workspace = config.workspaces.get("example")!;
  expect(isWithin(workspace, workspace)).toBe(true);
  expect(isWithin(workspace, join(workspace, "..private", "auth.json"))).toBe(true);
  expect(isWithin(workspace, join(workspace, "..", "sibling"))).toBe(false);
});

test("rejects inherited Codex configuration and API-key authentication", () => {
  writeFileSync(join(directory, "auth", "config.toml"), "");
  expect(() => loadExecutionConfig(file)).toThrow("dedicated Codex home");
  rmSync(join(directory, "auth", "config.toml"));
  writeFileSync(join(directory, "auth", "auth.json"), JSON.stringify({ auth_mode: "apikey" }));
  expect(() => loadExecutionConfig(file)).toThrow("ChatGPT");
});

test("accepts Codex-generated built-in skills after a run but rejects user-installed skills", () => {
  mkdirSync(join(directory, "auth", "skills", ".system"), { recursive: true });
  expect(loadExecutionConfig(file).model).toBe("test-model");
  mkdirSync(join(directory, "auth", "skills", "custom-skill"));
  expect(() => loadExecutionConfig(file)).toThrow("dedicated Codex home");
});

test("permits inert SDK plugin caches but rejects added plugin configuration", () => {
  mkdirSync(join(directory, "auth", "plugins", "cache"), { recursive: true });
  mkdirSync(join(directory, "auth", "plugins", ".remote-plugin-install-staging"));
  expect(loadExecutionConfig(file).model).toBe("test-model");
  writeFileSync(join(directory, "auth", "plugins", "custom.json"), "{}");
  expect(() => loadExecutionConfig(file)).toThrow("dedicated Codex home");
});

test("rejects authentication inside the analyzed workspace and project-level overrides", () => {
  writeFileSync(file, JSON.stringify({ model: "test-model", codexHome: "auth", workspaces: { example: "." } }));
  expect(() => loadExecutionConfig(file)).toThrow("separate");
  writeFileSync(file, JSON.stringify({ model: "test-model", codexHome: "auth", workspaces: { example: "workspace" } }));
  mkdirSync(join(directory, "workspace", ".codex"));
  writeFileSync(join(directory, "workspace", ".codex", "config.toml"), "");
  expect(() => loadExecutionConfig(file)).toThrow("project Codex config");
});

test("server login secrets cannot be placed inside an AI workspace", () => {
  const config = loadExecutionConfig(file);
  const databasePath = join(directory, "hub.sqlite"); writeFileSync(databasePath, "");
  const secret = join(config.workspaces.get("example")!, "server-auth.json"); writeFileSync(secret, "{}");
  expect(() => validateExecutionEnvironment(config, databasePath, [secret])).toThrow("Private server configuration");
  const outside = join(directory, "server-auth.json"); writeFileSync(outside, "{}");
  expect(() => validateExecutionEnvironment(config, databasePath, [outside])).not.toThrow();
});
