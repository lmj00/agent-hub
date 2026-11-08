import { Type, type Static } from "@sinclair/typebox";
import { object, text, id, date, nullable, enumeration } from "./schema.js";
import { createProjectSchema } from "./projects.js";

export const repositoryImportInputSchema = object({
  requestKey: id,
  repositoryId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  name: createProjectSchema.properties.name,
  profile: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$" }),
});
export const repositoryImportSchema = object({
  id,
  repositoryId: Type.Integer(),
  name: text,
  profile: text,
  status: enumeration(["queued", "preparing", "ready", "failed", "cancelled"] as const),
  attempt: Type.Integer(),
  fullName: nullable(text),
  revision: nullable(text),
  errorCode: nullable(text),
  projectId: nullable(id),
  createdAt: date,
  updatedAt: date,
});
export const repositoryImportsSchema = object({
  enabled: Type.Boolean(),
  profiles: Type.Array(text),
  imports: Type.Array(repositoryImportSchema, { maxItems: 20 }),
});
export const repositoryImportActionSchema = object({
  action: enumeration(["retry", "cancel"] as const),
});
export type RepositoryImportInput = Static<typeof repositoryImportInputSchema>;
export type RepositoryImport = Static<typeof repositoryImportSchema>;
