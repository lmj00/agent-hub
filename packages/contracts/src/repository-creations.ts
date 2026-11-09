import { Type, type Static } from "@sinclair/typebox";
import { object, text, id, date, nullable, enumeration } from "./schema.js";
import { repositoryImportInputSchema } from "./repository-imports.js";

export const repositoryCreationInputSchema = object({
  requestKey: id,
  repositoryName: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$" }),
  name: repositoryImportInputSchema.properties.name,
  profile: repositoryImportInputSchema.properties.profile,
});
export const repositoryCreationSchema = object({
  id,
  repositoryName: text,
  name: text,
  profile: text,
  status: enumeration([
    "queued",
    "authorizing",
    "creating",
    "created",
    "linked",
    "failed",
    "uncertain",
    "cancelled",
  ] as const),
  attempt: Type.Integer(),
  repositoryId: nullable(Type.Integer()),
  fullName: nullable(text),
  importId: nullable(id),
  errorCode: nullable(text),
  createdAt: date,
  updatedAt: date,
});
export const repositoryCreationsSchema = object({
  enabled: Type.Boolean(),
  profiles: Type.Array(text),
  creations: Type.Array(repositoryCreationSchema, { maxItems: 20 }),
});
export type RepositoryCreationInput = Static<typeof repositoryCreationInputSchema>;
export type RepositoryCreation = Static<typeof repositoryCreationSchema>;
