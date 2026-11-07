import { object, nullable, text, date } from "./schema.js";
import { Type, type Static } from "@sinclair/typebox";

export const sessionSchema = object({
  authenticated: Type.Boolean(),
  csrfToken: text,
  expiresAt: nullable(date),
});
export type Session = Static<typeof sessionSchema>;
export const loginSchema = object({
  password: Type.String({ minLength: 1, maxLength: 1024 }),
});
