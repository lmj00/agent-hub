CREATE TABLE `task_releases` (
	`source_task_id` text PRIMARY KEY NOT NULL,
	`new_task_id` text NOT NULL,
	`goal_id` text NOT NULL,
	`goal_version` integer NOT NULL,
	`request_key` text NOT NULL,
	`command_hash` text NOT NULL,
	`prior_attempts` integer NOT NULL,
	`prior_retry_state` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`source_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`new_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`goal_id`) REFERENCES `goals`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "task_releases_distinct_tasks" CHECK("task_releases"."source_task_id" <> "task_releases"."new_task_id"),
	CONSTRAINT "task_releases_attempts_valid" CHECK("task_releases"."prior_attempts" >= 0),
	CONSTRAINT "task_releases_goal_version_valid" CHECK("task_releases"."goal_version" > 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_releases_new_task_unique` ON `task_releases` (`new_task_id`);