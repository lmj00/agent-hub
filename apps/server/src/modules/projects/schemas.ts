export const createProjectSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "workspaceKey"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 100, pattern: "\\S" },
    workspaceKey: {
      type: "string",
      minLength: 1,
      maxLength: 100,
      pattern: "^[A-Za-z0-9]",
      not: { pattern: "[^A-Za-z0-9._-]" },
    },
  },
};

export const projectParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: { id: { type: "string", format: "uuid" } },
};

export const projectResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "name", "workspaceKey", "createdAt"],
  properties: {
    id: { type: "string", format: "uuid" },
    name: { type: "string" },
    workspaceKey: { type: "string" },
    createdAt: { type: "string", format: "date-time" },
  },
};

export const projectListResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["projects"],
  properties: { projects: { type: "array", items: projectResponseSchema } },
};

const errorResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["error", "message"],
  properties: {
    error: { type: "string" },
    message: { type: "string" },
  },
};

export const projectErrorResponses = { "4xx": errorResponseSchema, "5xx": errorResponseSchema };
