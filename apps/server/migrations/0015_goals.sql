CREATE TABLE `goal_revisions` (
	`goal_id` text NOT NULL,
	`version` integer NOT NULL,
	`request_key` text NOT NULL,
	`command_hash` text NOT NULL,
	`snapshot` text NOT NULL,
	FOREIGN KEY (`goal_id`) REFERENCES `goals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `goal_revisions_version_unique` ON `goal_revisions` (`goal_id`,`version`);--> statement-breakpoint
CREATE UNIQUE INDEX `goal_revisions_request_unique` ON `goal_revisions` (`goal_id`,`request_key`);--> statement-breakpoint
CREATE TABLE `goals` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`request_key` text NOT NULL,
	`definition` text NOT NULL,
	`status` text NOT NULL,
	`version` integer NOT NULL,
	`next_check_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `goals_project_request_unique` ON `goals` (`project_id`,`request_key`);