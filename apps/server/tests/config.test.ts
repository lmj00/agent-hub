import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { loadConfig } from "../src/config.js";

describe("server configuration", () => {
  test("resolves service observation config only when explicitly provided", () => {
    expect(loadConfig({ SERVICE_CONFIG: ".local/services.json" }).serviceConfigPath).toBe(fileURLToPath(new URL("../../../.local/services.json", import.meta.url)));
    for (const value of ["", " ", "bad\0path"]) expect(() => loadConfig({ SERVICE_CONFIG: value })).toThrow("SERVICE_CONFIG");
  });
  test("authentication and explicit local-only access cannot be configured ambiguously", () => {
    expect(loadConfig({ AUTH_CONFIG: ".local/auth.json" }).authConfigPath).toBe(fileURLToPath(new URL("../../../.local/auth.json", import.meta.url)));
    expect(loadConfig({ LOCAL_API_ONLY: "1" }).localApiOnly).toBe(true);
    expect(() => loadConfig({ AUTH_CONFIG: "" })).toThrow("AUTH_CONFIG");
    expect(() => loadConfig({ LOCAL_API_ONLY: "true" })).toThrow("LOCAL_API_ONLY");
    expect(() => loadConfig({ AUTH_CONFIG: ".local/auth.json", LOCAL_API_ONLY: "1" })).toThrow("cannot be used together");
  });
  test("uses a local address and the default port", () => {
    expect(loadConfig({})).toEqual({
      host: "127.0.0.1",
      localApiOnly: false,
      port: 3000,
      databasePath: fileURLToPath(new URL("../../../data/agent-hub.sqlite", import.meta.url)),
    });
  });

  test.each(["1", "4000", "65535"])("accepts port %s", (port) => {
    expect(loadConfig({ PORT: port }).port).toBe(Number(port));
  });

  test.each(["", "abc", "3000abc", "1.5", "1e3", " 3000 ", "0", "-1", "65536"])(
    "rejects invalid port %j before starting the server",
    (port) => {
      expect(() => loadConfig({ PORT: port })).toThrow("PORT must be an integer between 1 and 65535.");
    },
  );

  test("resolves database paths relative to the repository, including absolute overrides", () => {
    const path = fileURLToPath(new URL("../../../data/custom.sqlite", import.meta.url));
    expect(loadConfig({ DATABASE_PATH: "data/custom.sqlite" }).databasePath).toBe(path);
    expect(loadConfig({ DATABASE_PATH: path }).databasePath).toBe(path);
  });

  test.each(["", "  ", ":memory:", "bad\0path"])("rejects non-persistent database path %j", (path) => {
    expect(() => loadConfig({ DATABASE_PATH: path })).toThrow("DATABASE_PATH must be a non-empty file path.");
  });

  test("enables automatic execution only with an explicit config path resolved from the repository", () => {
    const file = fileURLToPath(new URL("../../../.local/execution.json", import.meta.url));
    expect(loadConfig({ EXECUTION_CONFIG: ".local/execution.json" }).executionConfigPath).toBe(file);
    expect(loadConfig({}).executionConfigPath).toBeUndefined();
    for (const value of ["", "  ", "bad\0path"]) {
      expect(() => loadConfig({ EXECUTION_CONFIG: value })).toThrow("EXECUTION_CONFIG");
    }
  });
});
