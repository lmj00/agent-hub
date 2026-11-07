import { object, text, id } from "./schema.js";

export const errorSchema = object({ error: text, message: text });
export const errorResponses = { "4xx": errorSchema, "5xx": errorSchema };
export const idParamsSchema = object({ id });
export const projectParamsSchema = object({ projectId: id });
