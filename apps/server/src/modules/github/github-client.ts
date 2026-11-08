import { sign } from "node:crypto";
import type { GitHubRepositories } from "@agent-hub/contracts";
import type { GitHubConfig } from "./github-config.js";

export class GitHubError extends Error {
  constructor(
    public readonly code:
      | "GITHUB_UNAVAILABLE"
      | "GITHUB_PERMISSION"
      | "GITHUB_OWNER_MISMATCH"
      | "GITHUB_SELECTED_REPOSITORIES_REQUIRED"
      | "GITHUB_RATE_LIMIT"
      | "GITHUB_BUSY"
      | "GITHUB_INVALID_RESPONSE"
      | "GITHUB_REPOSITORY_UNAVAILABLE",
  ) {
    super(code);
  }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new GitHubError("GITHUB_INVALID_RESPONSE");
  return value as Record<string, unknown>;
}
function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function login(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(value);
}

// No token is retained in the DB, returned to the browser or inserted into a URL.
export function createGitHubClient(config: GitHubConfig, fetcher: typeof fetch = fetch) {
  let busy = false;
  async function json(
    path: string,
    token: string,
    signal: AbortSignal,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    const response = await fetcher(`https://api.github.com${path}`, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      signal,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2026-03-10",
        "User-Agent": "agent-hub",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (
        response.status === 429 ||
        (response.status === 403 &&
          (response.headers.get("x-ratelimit-remaining") === "0" ||
            response.headers.has("retry-after")))
      )
        throw new GitHubError("GITHUB_RATE_LIMIT");
      if ([401, 403, 404].includes(response.status)) throw new GitHubError("GITHUB_PERMISSION");
      throw new GitHubError("GITHUB_UNAVAILABLE");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new GitHubError("GITHUB_INVALID_RESPONSE");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 2 * 1024 * 1024) {
          await reader.cancel();
          throw new GitHubError("GITHUB_INVALID_RESPONSE");
        }
        chunks.push(chunk.value);
      }
      return record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } finally {
      reader.releaseLock();
    }
  }
  async function authorize(
    permissions: Record<string, string>,
    signal: AbortSignal,
    repositoryId?: number,
  ): Promise<{ token: string; owner: string }> {
    const now = Math.floor(Date.now() / 1000);
    const payload = [
      { alg: "RS256", typ: "JWT" },
      { iat: now - 60, exp: now + 540, iss: String(config.appId) },
    ]
      .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
      .join(".");
    const jwt = `${payload}.${sign("RSA-SHA256", Buffer.from(payload), config.privateKey).toString("base64url")}`;
    const installation = await json(`/app/installations/${config.installationId}`, jwt, signal);
    const account = record(installation.account);
    if (
      installation.id !== config.installationId ||
      installation.app_id !== config.appId ||
      account.id !== config.ownerId ||
      account.type !== "User" ||
      !login(account.login)
    )
      throw new GitHubError("GITHUB_OWNER_MISMATCH");
    if (installation.suspended_at !== null) throw new GitHubError("GITHUB_PERMISSION");
    if (installation.repository_selection !== "selected")
      throw new GitHubError("GITHUB_SELECTED_REPOSITORIES_REQUIRED");
    const access = await json(
      `/app/installations/${config.installationId}/access_tokens`,
      jwt,
      signal,
      { permissions, ...(repositoryId ? { repository_ids: [repositoryId] } : {}) },
    );
    if (
      typeof access.token !== "string" ||
      !/^[A-Za-z0-9_.-]{20,512}$/.test(access.token) ||
      typeof access.expires_at !== "string" ||
      !(Date.parse(access.expires_at) > Date.now())
    )
      throw new GitHubError("GITHUB_INVALID_RESPONSE");
    return { token: access.token, owner: account.login };
  }
  return {
    async downloadRepository(repositoryId: number, callerSignal: AbortSignal) {
      if (!positiveId(repositoryId)) throw new GitHubError("GITHUB_INVALID_RESPONSE");
      if (busy) throw new GitHubError("GITHUB_BUSY");
      busy = true;
      const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(120000)]);
      try {
        const access = await authorize(
          { metadata: "read", contents: "read" },
          signal,
          repositoryId,
        );
        async function selected() {
          const result = await json("/installation/repositories?per_page=1", access.token, signal);
          if (
            result.total_count !== 1 ||
            !Array.isArray(result.repositories) ||
            result.repositories.length !== 1
          )
            throw new GitHubError("GITHUB_REPOSITORY_UNAVAILABLE");
          const repo = record(result.repositories[0]),
            owner = record(repo.owner);
          if (
            repo.id !== repositoryId ||
            owner.id !== config.ownerId ||
            owner.login !== access.owner ||
            typeof repo.name !== "string" ||
            !/^[A-Za-z0-9_.-]{1,100}$/.test(repo.name) ||
            repo.full_name !== `${access.owner}/${repo.name}` ||
            repo.archived !== false ||
            typeof repo.private !== "boolean" ||
            typeof repo.default_branch !== "string" ||
            !repo.default_branch ||
            repo.default_branch.length > 255
          )
            throw new GitHubError("GITHUB_REPOSITORY_UNAVAILABLE");
          return { fullName: repo.full_name as string, branch: repo.default_branch };
        }
        const repo = await selected();
        const commit = await json(
          `/repos/${repo.fullName}/commits/${encodeURIComponent(repo.branch)}`,
          access.token,
          signal,
        );
        if (typeof commit.sha !== "string" || !/^[a-f0-9]{40}$/.test(commit.sha))
          throw new GitHubError("GITHUB_INVALID_RESPONSE");
        const redirect = await fetcher(
          `https://api.github.com/repos/${repo.fullName}/tarball/${commit.sha}`,
          {
            signal,
            redirect: "manual",
            headers: {
              Authorization: `Bearer ${access.token}`,
              "User-Agent": "agent-hub",
              "X-GitHub-Api-Version": "2026-03-10",
              Accept: "application/vnd.github+json",
            },
          },
        );
        await redirect.body?.cancel();
        if (redirect.status !== 302) throw new GitHubError("GITHUB_REPOSITORY_UNAVAILABLE");
        const location = new URL(redirect.headers.get("location") ?? "");
        if (
          location.origin !== "https://codeload.github.com" ||
          location.username ||
          location.password ||
          location.hash ||
          location.pathname !== `/${repo.fullName}/legacy.tar.gz/${commit.sha}`
        )
          throw new GitHubError("GITHUB_INVALID_RESPONSE");
        // Signed archive URL is transient. Do not forward the installation Authorization header.
        const archive = await fetcher(location, {
          signal,
          redirect: "error",
          headers: { "User-Agent": "agent-hub" },
        });
        if (!archive.ok) {
          await archive.body?.cancel();
          throw new GitHubError("GITHUB_REPOSITORY_UNAVAILABLE");
        }
        const reader = archive.body?.getReader();
        if (!reader) throw new GitHubError("GITHUB_INVALID_RESPONSE");
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > 16 * 1048576) {
              await reader.cancel();
              throw new GitHubError("GITHUB_INVALID_RESPONSE");
            }
            chunks.push(part.value);
          }
        } finally {
          reader.releaseLock();
        }
        const current = await selected();
        if (current.fullName !== repo.fullName)
          throw new GitHubError("GITHUB_REPOSITORY_UNAVAILABLE");
        return {
          repositoryId,
          fullName: repo.fullName,
          revision: commit.sha,
          archive: Buffer.concat(chunks),
        };
      } catch (error) {
        if (error instanceof GitHubError) throw error;
        throw new GitHubError("GITHUB_UNAVAILABLE");
      } finally {
        busy = false;
      }
    },
    async listRepositories(page: number): Promise<GitHubRepositories> {
      if (!Number.isSafeInteger(page) || page < 1 || page > 1000)
        throw new GitHubError("GITHUB_INVALID_RESPONSE");
      if (busy) throw new GitHubError("GITHUB_BUSY");
      busy = true;
      const signal = AbortSignal.timeout(8000);
      try {
        const access = await authorize({ metadata: "read" }, signal);
        const result = await json(
          `/installation/repositories?per_page=30&page=${page}`,
          access.token,
          signal,
        );
        if (
          !Array.isArray(result.repositories) ||
          result.repositories.length > 30 ||
          !Number.isSafeInteger(result.total_count) ||
          (result.total_count as number) < 0
        )
          throw new GitHubError("GITHUB_INVALID_RESPONSE");
        const repositories = result.repositories.map((value) => {
          const repo = record(value),
            owner = record(repo.owner);
          if (
            !positiveId(repo.id) ||
            typeof repo.name !== "string" ||
            !/^[A-Za-z0-9_.-]{1,100}$/.test(repo.name) ||
            owner.id !== config.ownerId ||
            owner.login !== access.owner ||
            repo.full_name !== `${access.owner}/${repo.name}` ||
            typeof repo.private !== "boolean" ||
            typeof repo.archived !== "boolean"
          )
            throw new GitHubError("GITHUB_INVALID_RESPONSE");
          return {
            id: repo.id,
            name: repo.name,
            fullName: repo.full_name as string,
            private: repo.private,
            archived: repo.archived,
          };
        });
        if (page === 1000 && page * 30 < (result.total_count as number))
          throw new GitHubError("GITHUB_INVALID_RESPONSE");
        return {
          owner: access.owner,
          repositories,
          checkedAt: new Date().toISOString(),
          nextPage: page * 30 < (result.total_count as number) ? page + 1 : null,
        };
      } catch (error) {
        if (error instanceof GitHubError) throw error;
        // Provider errors can contain request headers. Never retain or log the cause.
        throw new GitHubError("GITHUB_UNAVAILABLE");
      } finally {
        busy = false;
      }
    },
  };
}
