CREATE TABLE `planning_cycles` (
	`task_id` text PRIMARY KEY NOT NULL,
	`goal_id` text NOT NULL,
	`goal_version` integer NOT NULL,
	`status` text NOT NULL,
	`result_run_id` text,
	`reason` text,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`goal_id`) REFERENCES `goals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`result_run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "planning_cycles_status_valid" CHECK("planning_cycles"."status" IN ('reserved', 'applied', 'rejected'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `planning_cycles_one_reservation` ON `planning_cycles` (`goal_id`) WHERE "planning_cycles"."status" = 'reserved';--> statement-breakpoint
CREATE INDEX `planning_cycles_goal_created_idx` ON `planning_cycles` (`goal_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `runs` ADD `plan_result` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `planned_work` text;