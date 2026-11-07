import { join } from "node:path";
import type { FastifyPluginAsync } from "fastify";
import staticFiles from "@fastify/static";

export const webRoutes: FastifyPluginAsync<{ directory: string }> = async (app, { directory }) => {
  await app.register(staticFiles, {
    root: join(directory, "assets"),
    prefix: "/assets/",
    index: false,
    dotfiles: "deny",
    maxAge: "1d",
    immutable: true,
  });
  app.get("/", async (_request, reply) =>
    reply.sendFile("index.html", directory, { cacheControl: false }),
  );
  app.get("/favicon.svg", async (_request, reply) =>
    reply.sendFile("favicon.svg", directory, { cacheControl: false }),
  );
};
