import { Type, type Static } from "@sinclair/typebox";
import { date, nullable, object, text } from "./schema.js";

export const githubConnectionSchema = object({ configured: Type.Boolean() });
export const githubRepositoriesInputSchema = object({
  page: Type.Integer({ minimum: 1, maximum: 1000 }),
});
export const githubRepositoriesSchema = object({
  owner: text,
  checkedAt: date,
  repositories: Type.Array(
    object({
      id: Type.Integer({ minimum: 1 }),
      name: text,
      fullName: text,
      private: Type.Boolean(),
      archived: Type.Boolean(),
    }),
    { maxItems: 30 },
  ),
  nextPage: nullable(Type.Integer({ minimum: 2, maximum: 1000 })),
});
export type GitHubRepositories = Static<typeof githubRepositoriesSchema>;
