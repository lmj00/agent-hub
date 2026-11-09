import type { FastifyPluginAsync } from "fastify";
import {
  errorResponses,
  githubConnectionSchema,
  githubRepositoriesInputSchema,
  githubRepositoriesSchema,
} from "@agent-hub/contracts";
import { type createGitHubClient, GitHubError } from "./github-client.js";

export const githubRoutes: FastifyPluginAsync<{
  client?: ReturnType<typeof createGitHubClient>;
}> = async (app, { client }) => {
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
  });
  app.get(
    "/integrations/github",
    { schema: { response: { 200: githubConnectionSchema } } },
    async () => ({ configured: !!client }),
  );
  app.post<{ Body: { page: number } }>(
    "/integrations/github/repositories",
    {
      schema: {
        body: githubRepositoriesInputSchema,
        response: { 200: githubRepositoriesSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      if (!client)
        return reply
          .code(409)
          .send({ error: "GITHUB_NOT_CONFIGURED", message: "GitHub connection is not configured" });
      try {
        return await client.listRepositories(request.body.page);
      } catch (error) {
        const code = error instanceof GitHubError ? error.code : "GITHUB_UNAVAILABLE";
        return reply
          .code(code === "GITHUB_BUSY" || code === "GITHUB_RATE_LIMIT" ? 429 : 502)
          .send({ error: code, message: "Unable to read GitHub repositories" });
      }
    },
  );
};
