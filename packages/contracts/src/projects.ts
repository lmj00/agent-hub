import { object, text, id, date, requestKey } from "./schema.js";
import { Type, type Static } from "@sinclair/typebox";

export const createProjectSchema = object({
  name: Type.String({ minLength: 1, maxLength: 100, pattern: "\\S" }),
  workspaceKey: requestKey,
});
export const projectSchema = object({
  id,
  name: text,
  workspaceKey: text,
  createdAt: date,
});
export const projectsSchema = object({ projects: Type.Array(projectSchema) });
export type Project = Static<typeof projectSchema>;
export type CreateProject = Static<typeof createProjectSchema>;
