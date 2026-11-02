import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import {
  hashPassword,
  type PasswordHash,
} from "../src/modules/auth/password.js";

let directory: string;
let app: ReturnType<typeof buildApp>;
let password: PasswordHash;
beforeAll(async () => {
  password = await hashPassword("web fixture password");
});
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "hub-web-")));
  const webDirectory = join(directory, "web");
  mkdirSync(join(webDirectory, "assets"), { recursive: true });
  writeFileSync(
    join(webDirectory, "index.html"),
    "<!doctype html><title>Fixture hub</title><main>Login shell</main>",
  );
  writeFileSync(
    join(webDirectory, "assets", "index-fixture.js"),
    "console.log('fixture')",
  );
  writeFileSync(join(directory, "private.txt"), "fixture-private-file");
  writeFileSync(
    join(webDirectory, "assets", ".private"),
    "fixture-hidden-file",
  );
  app = buildApp({
    databasePath: join(directory, "hub.sqlite"),
    webDirectory,
    auth: {
      sourcePath: join(directory, "auth.json"),
      origin: "http://localhost",
      sessionSecret: randomBytes(32).toString("hex"),
      password,
    },
  });
});
afterEach(async () => {
  await app.close();
  rmSync(directory, { recursive: true, force: true });
});

test("the public login shell and built assets are served with CSP while APIs remain private", async () => {
  const index = await app.inject("/");
  expect(index.statusCode).toBe(200);
  expect(index.body).toContain("Login shell");
  expect(index.headers["content-type"]).toContain("text/html");
  expect(index.headers["content-security-policy"]).toContain(
    "default-src 'self'",
  );
  expect(index.headers["cache-control"]).toBe("no-store");
  const asset = await app.inject("/assets/index-fixture.js");
  expect(asset.statusCode).toBe(200);
  expect(asset.body).toContain("fixture");
  for (const url of ["/projects", "/execution", "/health/ready"])
    expect((await app.inject(url)).statusCode).toBe(401);
});

test("asset route traversal, hidden files and unknown paths never fall back to the HTML shell", async () => {
  for (const url of [
    "/assets/../private.txt",
    "/assets/%2e%2e/%2e%2e/private.txt",
    "/assets/.private",
    "/assets/missing.js",
    "/unknown-api",
  ]) {
    const response = await app.inject(url);
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.body).not.toContain("fixture-private-file");
    expect(response.body).not.toContain("fixture-hidden-file");
    expect(response.body).not.toContain("Login shell");
  }
});

test("public shell routes do not allow cross-site access or bypass write authentication", async () => {
  expect(
    (
      await app.inject({
        method: "GET",
        url: "/",
        headers: { host: "other.example" },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (await app.inject({ method: "POST", url: "/assets/index-fixture.js" }))
      .statusCode,
  ).toBe(404);
  expect(() =>
    buildApp({
      databasePath: join(directory, "other.sqlite"),
      webDirectory: join(directory, "web"),
    }),
  ).toThrow("requires authentication");
});
