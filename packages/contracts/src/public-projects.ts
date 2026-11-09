import { Type, type Static } from "@sinclair/typebox";
import { object, id } from "./schema.js";

export const projectPublicationSchema = object({
  listed: Type.Boolean(),
  name: Type.String({ maxLength: 100 }),
});
export const updateProjectPublicationSchema = object({
  listed: Type.Boolean(),
  name: Type.String({ minLength: 1, maxLength: 100, pattern: "\\S" }),
});
export const publicProjectsSchema = object({
  projects: Type.Array(
    object({
      id,
      name: Type.String({ maxLength: 100 }),
      state: Type.Union([Type.Literal("running"), Type.Literal("attention"), Type.Literal("idle")]),
    }),
  ),
  privateCount: Type.Integer({ minimum: 0 }),
  nextOffset: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
});
export type ProjectPublication = Static<typeof projectPublicationSchema>;
export type PublicProjects = Static<typeof publicProjectsSchema>;
