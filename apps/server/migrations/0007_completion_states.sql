-- Drizzle runs this file inside a transaction; foreign_keys=OFF would be a no-op.
-- Defer references while replacing the parent, then explicitly validate the final schema.
PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`instruction` text NOT NULL,
	`request_key` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`cancel_requested_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "tasks_instruction_not_blank" CHECK(length(trim("__new_tasks"."instruction")) > 0),
	CONSTRAINT "tasks_request_key_not_blank" CHECK(length(trim("__new_tasks"."request_key")) > 0),
	CONSTRAINT "tasks_status_valid" CHECK("__new_tasks"."status" IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted', 'blocked', 'waiting_capacity', 'waiting_retry'))
);
--> statement-breakpoint
INSERT INTO `__new_tasks`("id", "project_id", "instruction", "request_key", "status", "cancel_requested_at", "created_at") SELECT "id", "project_id", "instruction", "request_key", "status", "cancel_requested_at", "created_at" FROM `tasks`;--> statement-breakpoint
DROP TABLE `tasks`;--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_project_request_key_unique` ON `tasks` (`project_id`,`request_key`);--> statement-breakpoint
CREATE INDEX `tasks_project_created_at_idx` ON `tasks` (`project_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `tasks_status_created_at_idx` ON `tasks` (`status`,`created_at`,`id`);--> statement-breakpoint
ALTER TABLE `runs` ADD `attempt` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
WITH ranked AS (
  SELECT `id`, row_number() OVER (PARTITION BY `task_id` ORDER BY `started_at`, rowid) AS attempt_number FROM `runs`
)
UPDATE `runs` SET `attempt` = (SELECT attempt_number FROM ranked WHERE ranked.id = runs.id);
--> statement-breakpoint
CREATE UNIQUE INDEX `runs_task_attempt_unique` ON `runs` (`task_id`,`attempt`);
--> statement-breakpoint
CREATE TEMP TABLE migration_fk_guard (violations INTEGER NOT NULL CHECK (violations = 0));
--> statement-breakpoint
INSERT INTO migration_fk_guard SELECT count(*) FROM pragma_foreign_key_check;
--> statement-breakpoint
DROP TABLE migration_fk_guard;
--> statement-breakpoint
-- Only after the check succeeds, discard the deferred counters for the replaced parent.
PRAGMA defer_foreign_keys=OFF;
