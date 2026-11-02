CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_run_sequence_unique` ON `events` (`run_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`instance_id` text NOT NULL,
	`slot` integer DEFAULT 1 NOT NULL,
	`status` text NOT NULL,
	`model` text NOT NULL,
	`effort` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`last_activity_at` integer NOT NULL,
	`result` text,
	`error_code` text,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "runs_slot_valid" CHECK("runs"."slot" = 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runs_one_active` ON `runs` (`slot`) WHERE "runs"."status" IN ('running', 'interrupted');--> statement-breakpoint
CREATE INDEX `runs_task_started_at_idx` ON `runs` (`task_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `steps` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`status` text NOT NULL,
	`session_id` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`usage` text,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `steps_run_sequence_unique` ON `steps` (`run_id`,`sequence`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`instruction` text NOT NULL,
	`request_key` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "tasks_instruction_not_blank" CHECK(length(trim("__new_tasks"."instruction")) > 0),
	CONSTRAINT "tasks_request_key_not_blank" CHECK(length(trim("__new_tasks"."request_key")) > 0),
	CONSTRAINT "tasks_status_valid" CHECK("__new_tasks"."status" IN ('queued', 'running', 'succeeded', 'failed', 'interrupted', 'blocked', 'waiting_capacity', 'waiting_retry'))
);
--> statement-breakpoint
INSERT INTO `__new_tasks`("id", "project_id", "instruction", "request_key", "status", "created_at") SELECT "id", "project_id", "instruction", "request_key", "status", "created_at" FROM `tasks`;--> statement-breakpoint
DROP TABLE `tasks`;--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_project_request_key_unique` ON `tasks` (`project_id`,`request_key`);--> statement-breakpoint
CREATE INDEX `tasks_project_created_at_idx` ON `tasks` (`project_id`,`created_at`,`id`);