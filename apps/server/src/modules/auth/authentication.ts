import { errorSchema, sessionSchema, loginSchema } from "@agent-hub/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import session, { type SessionStore } from "@fastify/session";
import csrf from "@fastify/csrf-protection";
import rateLimit from "@fastify/rate-limit";
import type { AuthConfig } from "./auth-config.js";
import { verifyPassword } from "./password.js";

declare module "fastify" {
  interface Session { authenticated?: boolean; expiresAt?: number; }
}
const anonymousTtl = 10 * 60 * 1000;
const authenticatedTtl = 8 * 60 * 60 * 1000;
const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);
const publicRoutes = new Set(["/health/live", "/auth/session", "/auth/login", "/", "/favicon.svg", "/assets/*"]);
function matchesHost(host: string | undefined, origin: URL) {
  if (!host) return false;
  try {
    const url = new URL(`${origin.protocol}//${host}`);
    return url.origin === origin.origin && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash;
  } catch { return false; }
}

export async function installAuthentication(app: FastifyInstance, config: AuthConfig, store: SessionStore) {
  const origin = new URL(config.origin);
  const secure = origin.protocol === "https:";
  const cookieName = secure ? "__Host-agent_hub_session" : "agent_hub_session";
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
    if (!matchesHost(request.headers.host, origin) || (request.headers.origin !== undefined && request.headers.origin !== config.origin)
      || request.headers["sec-fetch-site"] === "cross-site") {
      return reply.code(403).send({ error: "ORIGIN_NOT_ALLOWED", message: "Request origin does not match the application" });
    }
  });
  await app.register(cookie);
  await app.register(session, {
    secret: config.sessionSecret, cookieName, store, saveUninitialized: false, rolling: false,
    cookie: { path: "/", httpOnly: true, secure, sameSite: "strict", maxAge: anonymousTtl },
  });
  await app.register(csrf, { sessionPlugin: "@fastify/session", getToken: request => typeof request.headers["x-csrf-token"] === "string" ? request.headers["x-csrf-token"] : undefined, logLevel: "debug" });
  await app.register(rateLimit, { global: false, max: 10, timeWindow: 60000 });
  app.addHook("onRequest", (request, reply, done) => {
    if (!publicRoutes.has(request.routeOptions.url ?? "") && request.session.authenticated !== true) {
      void reply.code(401).send({ error: "AUTHENTICATION_REQUIRED", message: "Sign in to continue" }); return;
    }
    if (!safeMethods.has(request.method)) return app.csrfProtection(request, reply, done);
    done();
  });

  app.register(async routes => {
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof Error && "statusCode" in error && typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500) {
        return reply.code(error.statusCode).send({ error: error.statusCode === 429 ? "TOO_MANY_REQUESTS" : "INVALID_REQUEST", message: "Authentication request was rejected" });
      }
      return reply.code(503).send({ error: "AUTHENTICATION_UNAVAILABLE", message: "Unable to access authentication storage" });
    });
    const response = (request: FastifyRequest, reply: FastifyReply) => {
      request.session.expiresAt ??= Date.now() + anonymousTtl;
      return { authenticated: request.session.authenticated === true, csrfToken: reply.generateCsrf(),
        expiresAt: request.session.authenticated ? new Date(request.session.expiresAt).toISOString() : null };
    };
    routes.get("/auth/session", { config: { rateLimit: { max: 30 } }, schema: { response: { 200: sessionSchema, "4xx": errorSchema, "5xx": errorSchema } } }, response);
    let verifying = false;
    routes.post<{ Body: { password: string } }>("/auth/login", {
      config: { rateLimit: { max: 5 } }, bodyLimit: 4096,
      schema: { body: loginSchema, response: { 200: sessionSchema, "4xx": errorSchema, "5xx": errorSchema } },
    }, async (request, reply) => {
      if (verifying) return reply.code(429).send({ error: "TOO_MANY_REQUESTS", message: "A sign-in attempt is already being checked" });
      verifying = true;
      let valid: boolean;
      try { valid = await verifyPassword(request.body.password, config.password); } finally { verifying = false; }
      if (!valid) return reply.code(401).send({ error: "INVALID_CREDENTIALS", message: "Incorrect password" });
      await request.session.regenerate();
      request.session.authenticated = true;
      request.session.expiresAt = Date.now() + authenticatedTtl;
      request.session.options({ maxAge: authenticatedTtl, expires: new Date(request.session.expiresAt) });
      return response(request, reply);
    });
    routes.post("/auth/logout", { schema: { response: { 204: { type: "null" }, "4xx": errorSchema, "5xx": errorSchema } } }, async (request, reply) => {
      await request.session.destroy();
      reply.clearCookie(cookieName, { path: "/", secure, httpOnly: true, sameSite: "strict" });
      return reply.code(204).send();
    });
  });
}
