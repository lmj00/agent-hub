import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { loadConfig } from "../src/config.js";

describe("server configuration", () => {
  test("uses a local address and the default port", () => {
    expect(loadConfig({})).toEqual({
      host: "127.0.0.1",
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
});
