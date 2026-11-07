import { createHmac, timingSafeEqual } from "node:crypto";
import type { AuthConfig } from "./auth-config.js";

// A scoped credential can be exported without copying the session signing key.
// Replacing the auth secret or origin also revokes previously exported tokens.
export function readinessToken(
  config: Pick<AuthConfig, "sessionSecret" | "origin">,
): string {
  return createHmac("sha256", Buffer.from(config.sessionSecret, "hex"))
    .update(`agent-hub:readiness:v1\0${config.origin}`)
    .digest("base64url");
}

export function acceptsReadinessToken(
  header: unknown,
  expected: string,
): boolean {
  return (
    typeof header === "string" &&
    /^Bearer [A-Za-z0-9_-]{43}$/.test(header) &&
    timingSafeEqual(Buffer.from(header.slice(7)), Buffer.from(expected))
  );
}
