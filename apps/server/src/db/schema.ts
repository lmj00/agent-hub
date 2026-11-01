import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey().notNull(),
    name: text("name").notNull(),
    workspaceKey: text("workspace_key").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    check("projects_name_not_blank", sql`length(trim(${table.name})) > 0`),
    check("projects_workspace_key_not_blank", sql`length(trim(${table.workspaceKey})) > 0`),
  ],
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey().notNull(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "restrict" }),
    instruction: text("instruction").notNull(),
    requestKey: text("request_key").notNull(),
    status: text("status", { enum: ["queued"] }).notNull().default("queued"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("tasks_project_request_key_unique").on(table.projectId, table.requestKey),
    index("tasks_project_created_at_idx").on(table.projectId, table.createdAt, table.id),
    check("tasks_instruction_not_blank", sql`length(trim(${table.instruction})) > 0`),
    check("tasks_request_key_not_blank", sql`length(trim(${table.requestKey})) > 0`),
    check("tasks_status_valid", sql`${table.status} = 'queued'`),
  ],
);
