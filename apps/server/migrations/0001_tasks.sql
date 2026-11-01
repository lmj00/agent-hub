CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`instruction` text NOT NULL,
	`request_key` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "tasks_instruction_not_blank" CHECK(length(trim("tasks"."instruction")) > 0),
	CONSTRAINT "tasks_request_key_not_blank" CHECK(length(trim("tasks"."request_key")) > 0),
	CONSTRAINT "tasks_status_valid" CHECK("tasks"."status" = 'queued')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_project_request_key_unique` ON `tasks` (`project_id`,`request_key`);--> statement-breakpoint
CREATE INDEX `tasks_project_created_at_idx` ON `tasks` (`project_id`,`created_at`,`id`);