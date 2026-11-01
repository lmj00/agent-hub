export const createTaskSchema = {
  type: "object",
  additionalProperties: false,
  required: ["instruction", "requestKey"],
  properties: {
    instruction: { type: "string", minLength: 1, maxLength: 10000, pattern: "\\S" },
    requestKey: {
      type: "string", minLength: 1, maxLength: 100,
      pattern: "^[A-Za-z0-9]", not: { pattern: "[^A-Za-z0-9._-]" },
    },
  },
};

export const taskProjectParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["projectId"],
  properties: { projectId: { type: "string", format: "uuid" } },
};

export const taskParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: { id: { type: "string", format: "uuid" } },
};

export const taskResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "projectId", "instruction", "requestKey", "status", "createdAt"],
  properties: {
    id: { type: "string", format: "uuid" },
    projectId: { type: "string", format: "uuid" },
    instruction: { type: "string" },
    requestKey: { type: "string" },
    status: { type: "string", enum: ["queued"] },
    createdAt: { type: "string", format: "date-time" },
  },
};

export const taskListResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["tasks"],
  properties: { tasks: { type: "array", items: taskResponseSchema } },
};

const errorResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["error", "message"],
  properties: { error: { type: "string" }, message: { type: "string" } },
};

export const taskErrorResponses = { "4xx": errorResponseSchema, "5xx": errorResponseSchema };
