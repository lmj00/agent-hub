import { describe, expect, test } from "vitest";
import { loadConfig } from "../src/config.js";

describe("server configuration", () => {
  test("uses a local address and the default port", () => {
    expect(loadConfig({})).toEqual({ host: "127.0.0.1", port: 3000 });
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
});
