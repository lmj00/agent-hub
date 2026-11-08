import { generateKeyPairSync, verify } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { parseResponse, githubRepositoriesSchema } from "@agent-hub/contracts";
import { loadGitHubConfig } from "../src/modules/github/github-config.js";
import { createGitHubClient } from "../src/modules/github/github-client.js";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/modules/auth/password.js";
import { loadExecutionConfig } from "../src/modules/execution/execution-config.js";
import { mkdirSync } from "node:fs";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const input = { version: 1, appId: 12, installationId: 34, ownerId: 56, privateKey: pem };
const token = "ghs_fixture_not_a_real_access_token";
const installation = {
  id: 34,
  app_id: 12,
  account: { id: 56, login: "fixture-owner", type: "User" },
  suspended_at: null,
  repository_selection: "selected",
};
const repository = {
  id: 78,
  name: "example",
  full_name: "fixture-owner/example",
  owner: installation.account,
  private: true,
  archived: false,
};
let directory: string;
let config: ReturnType<typeof loadGitHubConfig>;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "hub-github-"));
  writeFileSync(join(directory, "github.json"), JSON.stringify(input), { mode: 0o600 });
  config = loadGitHubConfig(join(directory, "github.json"));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  rmSync(directory, { recursive: true, force: true });
});
const response = (value: unknown, status = 200, headers?: Record<string, string>) =>
  new Response(JSON.stringify(value), { status, ...(headers ? { headers } : {}) });
function transport(overrides: unknown[] = []) {
  const values = [
    installation,
    { token, expires_at: new Date(Date.now() + 3600000).toISOString() },
    { repositories: [repository], total_count: 31 },
  ];
  return vi.fn<typeof fetch>().mockImplementation(async () => {
    const value = overrides.length ? overrides.shift() : values.shift();
    return value instanceof Response ? value : response(value);
  });
}

test("signs a bounded JWT, verifies installation ownership and returns only sanitized paginated metadata", async () => {
  const fetcher = transport();
  const result = await createGitHubClient(config, fetcher).listRepositories(1);
  expect(parseResponse(githubRepositoriesSchema, result)).toMatchObject({
    owner: "fixture-owner",
    repositories: [{ id: 78, fullName: "fixture-owner/example", private: true, archived: false }],
    nextPage: 2,
  });
  expect(JSON.stringify(result)).not.toContain(token);
  expect(JSON.stringify(result)).not.toContain("PRIVATE KEY");
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    "https://api.github.com/app/installations/34",
    "https://api.github.com/app/installations/34/access_tokens",
    "https://api.github.com/installation/repositories?per_page=30&page=1",
  ]);
  const first = fetcher.mock.calls[0]![1]!;
  expect(first.redirect).toBe("error");
  const jwt = (first.headers as Record<string, string>).Authorization!.slice(7);
  const [header, claims, signature] = jwt.split(".");
  expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({
    alg: "RS256",
    typ: "JWT",
  });
  const payload = JSON.parse(Buffer.from(claims!, "base64url").toString());
  expect(payload.iss).toBe("12");
  expect(payload.exp - payload.iat).toBe(600);
  expect(
    verify(
      "RSA-SHA256",
      Buffer.from(`${header}.${claims}`),
      keys.publicKey,
      Buffer.from(signature!, "base64url"),
    ),
  ).toBe(true);
  expect(JSON.parse(fetcher.mock.calls[1]![1]!.body as string)).toEqual({
    permissions: { metadata: "read" },
  });
});

test.each([
  [{ ...installation, account: { ...installation.account, id: 999 } }, "GITHUB_OWNER_MISMATCH"],
  [{ ...installation, app_id: 999 }, "GITHUB_OWNER_MISMATCH"],
  [{ ...installation, id: 999 }, "GITHUB_OWNER_MISMATCH"],
  [{ ...installation, suspended_at: "2026-01-01" }, "GITHUB_PERMISSION"],
  [{ ...installation, repository_selection: "all" }, "GITHUB_SELECTED_REPOSITORIES_REQUIRED"],
])("rejects an incompatible installation before issuing a token", async (value, code) => {
  const fetcher = transport([value]);
  await expect(createGitHubClient(config, fetcher).listRepositories(1)).rejects.toMatchObject({
    code,
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test("rejects repository identity changes and expired tokens without returning provider payloads", async () => {
  const access = { token, expires_at: new Date(Date.now() + 3600000).toISOString() };
  for (const bad of [
    { ...repository, owner: { ...repository.owner, id: 999 } },
    { ...repository, full_name: "another/example" },
    { ...repository, private: "true" },
  ]) {
    const fetcher = transport([installation, access, { repositories: [bad], total_count: 1 }]);
    await expect(createGitHubClient(config, fetcher).listRepositories(1)).rejects.toMatchObject({
      code: "GITHUB_INVALID_RESPONSE",
    });
  }
  const expired = transport([installation, { token, expires_at: "2000-01-01T00:00:00Z" }]);
  await expect(createGitHubClient(config, expired).listRepositories(1)).rejects.toMatchObject({
    code: "GITHUB_INVALID_RESPONSE",
  });
  expect(expired).toHaveBeenCalledTimes(2);
});

test("bounds provider bodies, refuses redirects and exposes only safe error codes", async () => {
  for (const [value, code] of [
    [new Response("private-provider-body", { status: 401 }), "GITHUB_PERMISSION"],
    [
      new Response("private-provider-body", {
        status: 403,
        headers: { "x-ratelimit-remaining": "0" },
      }),
      "GITHUB_RATE_LIMIT",
    ],
    [
      new Response(null, { status: 302, headers: { location: "https://example.invalid" } }),
      "GITHUB_UNAVAILABLE",
    ],
    [new Response("x".repeat(2 * 1024 * 1024 + 1)), "GITHUB_INVALID_RESPONSE"],
  ] as const) {
    const fetcher = transport([value]);
    await expect(createGitHubClient(config, fetcher).listRepositories(1)).rejects.toMatchObject({
      code,
      message: code,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  }
});

test("allows only one in-flight operation and releases it after timeout", async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        options!.signal!.addEventListener(
          "abort",
          () => reject(new Error("private-transport-details")),
          { once: true },
        );
      }),
  );
  const client = createGitHubClient(config, fetcher);
  const pending = client.listRepositories(1);
  const rejected = expect(pending).rejects.toMatchObject({
    code: "GITHUB_UNAVAILABLE",
    message: "GITHUB_UNAVAILABLE",
  });
  await expect(client.listRepositories(1)).rejects.toMatchObject({ code: "GITHUB_BUSY" });
  await rejected;
  fetcher.mockImplementation(async () => response(installation));
  await expect(client.listRepositories(1)).rejects.toMatchObject({
    code: "GITHUB_INVALID_RESPONSE",
  });
  expect(fetcher).toHaveBeenCalledTimes(3);
}, 15000);

test("loads only private RSA config files and refuses malformed identities or keys", () => {
  const path = join(directory, "github.json");
  chmodSync(path, 0o644);
  expect(() => loadGitHubConfig(path)).toThrow("private regular file");
  chmodSync(path, 0o600);
  for (const invalid of [
    { ...input, ownerId: "56" },
    { ...input, appId: -1 },
    { ...input, privateKey: "private-secret-bad-key" },
    { ...input, extra: true },
  ]) {
    writeFileSync(path, JSON.stringify(invalid));
    try {
      loadGitHubConfig(path);
      throw new Error("expected rejection");
    } catch (error) {
      expect(String(error)).not.toContain("private-secret-bad-key");
      expect(String(error)).not.toContain("expected rejection");
    }
  }
  expect(() => buildApp({ databasePath: join(directory, "hub.sqlite"), github: config })).toThrow(
    "requires authentication",
  );
});

test("protects authenticated GitHub routes and keeps GitHub credentials out of configured AI workspaces", async () => {
  const auth = {
    sourcePath: join(directory, "auth.json"),
    origin: "http://localhost",
    sessionSecret: "a".repeat(64),
    password: await hashPassword("fixture-password-only"),
  };
  writeFileSync(auth.sourcePath, "{}", { mode: 0o600 });
  const fetcher = transport();
  vi.stubGlobal("fetch", fetcher);
  const app = buildApp({ databasePath: join(directory, "hub.sqlite"), auth, github: config });
  try {
    expect((await app.inject("/integrations/github")).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/integrations/github/repositories",
          payload: { page: 1 },
        })
      ).statusCode,
    ).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
    const anonymous = await app.inject("/auth/session");
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: {
        cookie: anonymous.headers["set-cookie"]!.toString().split(";")[0]!,
        "x-csrf-token": anonymous.json().csrfToken,
      },
      payload: { password: "fixture-password-only" },
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.headers["set-cookie"]!.toString().split(";")[0]!;
    expect(
      (
        await app.inject({ method: "GET", url: "/integrations/github", headers: { cookie } })
      ).json(),
    ).toEqual({ configured: true });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/integrations/github/repositories",
          headers: { cookie },
          payload: { page: 1 },
        })
      ).statusCode,
    ).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
    const listed = await app.inject({
      method: "POST",
      url: "/integrations/github/repositories",
      headers: { cookie, "x-csrf-token": login.json().csrfToken },
      payload: { page: 1 },
    });
    expect(listed.statusCode).toBe(200);
    expect(parseResponse(githubRepositoriesSchema, listed.json()).repositories).toHaveLength(1);
    expect(listed.body).not.toContain(token);
    expect(listed.body).not.toContain("PRIVATE KEY");
    expect(listed.headers["cache-control"]).toBe("no-store");
  } finally {
    await app.close();
  }
  mkdirSync(join(directory, "codex"));
  writeFileSync(join(directory, "codex/auth.json"), JSON.stringify({ auth_mode: "chatgpt" }), {
    mode: 0o600,
  });
  mkdirSync(join(directory, "workspace"));
  const secret = join(directory, "workspace/github.json");
  writeFileSync(secret, JSON.stringify(input), { mode: 0o600 });
  const executionFile = join(directory, "execution.json");
  writeFileSync(
    executionFile,
    JSON.stringify({ model: "fixture", codexHome: "codex", workspaces: { example: "workspace" } }),
  );
  const unsafe = buildApp({
    databasePath: join(directory, "unsafe.sqlite"),
    auth,
    github: loadGitHubConfig(secret),
    execution: { config: loadExecutionConfig(executionFile) },
  });
  try {
    await expect(unsafe.ready()).rejects.toMatchObject({ code: "SERVER_SECRET_IN_WORKSPACE" });
  } finally {
    await unsafe.close();
  }
});

function archiveTransport(
  options: { location?: string; finalOwner?: number; bytes?: number; total?: number } = {},
) {
  const sha = "a".repeat(40);
  const repo = { ...repository, default_branch: "feature/example" };
  return transport([
    installation,
    { token, expires_at: new Date(Date.now() + 3600000).toISOString() },
    { repositories: [repo], total_count: options.total ?? 1 },
    { sha },
    new Response(null, {
      status: 302,
      headers: {
        location:
          options.location ??
          `https://codeload.github.com/fixture-owner/example/legacy.tar.gz/${sha}?signed=fixture`,
      },
    }),
    new Response(new Uint8Array(options.bytes ?? 5)),
    {
      repositories: [{ ...repo, owner: { ...installation.account, id: options.finalOwner ?? 56 } }],
      total_count: 1,
    },
  ]);
}

test("narrows archive credentials to one repository, pins the revision and never forwards Authorization to the archive host", async () => {
  const fetcher = archiveTransport();
  const result = await createGitHubClient(config, fetcher).downloadRepository(
    78,
    new AbortController().signal,
  );
  expect(result).toMatchObject({
    repositoryId: 78,
    revision: "a".repeat(40),
    fullName: "fixture-owner/example",
  });
  expect(JSON.parse(String(fetcher.mock.calls[1]![1]!.body))).toEqual({
    permissions: { metadata: "read", contents: "read" },
    repository_ids: [78],
  });
  expect(fetcher.mock.calls[3]![0]).toBe(
    "https://api.github.com/repos/fixture-owner/example/commits/feature%2Fexample",
  );
  expect(fetcher.mock.calls[4]![1]!.redirect).toBe("manual");
  expect(fetcher.mock.calls[5]![1]).toMatchObject({
    redirect: "error",
    headers: { "User-Agent": "agent-hub" },
  });
  expect(new Headers(fetcher.mock.calls[5]![1]!.headers).has("Authorization")).toBe(false);
  expect(JSON.stringify(result)).not.toContain(token);
  expect(fetcher).toHaveBeenCalledTimes(7);
});

test.each([
  "https://example.invalid/archive",
  `http://codeload.github.com/fixture-owner/example/legacy.tar.gz/${"a".repeat(40)}`,
  `https://user@codeload.github.com/fixture-owner/example/legacy.tar.gz/${"a".repeat(40)}`,
  `https://codeload.github.com/fixture-owner/another/legacy.tar.gz/${"a".repeat(40)}`,
  `https://codeload.github.com:444/fixture-owner/example/legacy.tar.gz/${"a".repeat(40)}`,
])("rejects an untrusted archive redirect before fetching it: %s", async (location) => {
  const fetcher = archiveTransport({ location });
  await expect(
    createGitHubClient(config, fetcher).downloadRepository(78, new AbortController().signal),
  ).rejects.toThrow("GITHUB_INVALID_RESPONSE");
  expect(fetcher).toHaveBeenCalledTimes(5);
});

test("rejects ownership changes during download, unexpected repository scope and oversized archives", async () => {
  for (const options of [{ finalOwner: 999 }, { total: 2 }, { bytes: 16 * 1048576 + 1 }]) {
    const fetcher = archiveTransport(options);
    await expect(
      createGitHubClient(config, fetcher).downloadRepository(78, new AbortController().signal),
    ).rejects.toThrow(/GITHUB_(REPOSITORY_UNAVAILABLE|INVALID_RESPONSE)/);
  }
});
