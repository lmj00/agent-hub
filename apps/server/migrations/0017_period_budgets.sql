CREATE TABLE `budget_periods` (
	`id` text PRIMARY KEY NOT NULL,
	`account_key` text NOT NULL,
	`project_id` text NOT NULL,
	`goal_id` text,
	`started_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`policy` text NOT NULL,
	`calls` integer DEFAULT 0 NOT NULL,
	`run_ms` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`goal_id`) REFERENCES `goals`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "budget_periods_valid" CHECK("budget_periods"."ends_at" > "budget_periods"."started_at" AND "budget_periods"."calls" >= 0 AND "budget_periods"."run_ms" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `budget_periods_account_start_unique` ON `budget_periods` (`account_key`,`started_at`);--> statement-breakpoint
CREATE TABLE `budget_reservations` (
	`run_id` text PRIMARY KEY NOT NULL,
	`project_period_id` text NOT NULL,
	`goal_period_id` text,
	`started_at` integer NOT NULL,
	`reserved_run_ms` integer NOT NULL,
	`settled_run_ms` integer,
	`settled_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_period_id`) REFERENCES `budget_periods`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`goal_period_id`) REFERENCES `budget_periods`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "budget_reservations_valid" CHECK("budget_reservations"."reserved_run_ms" > 0 AND ("budget_reservations"."settled_run_ms" IS NULL OR "budget_reservations"."settled_run_ms" >= 0))
);
--> statement-breakpoint
CREATE TABLE `project_budgets` (
	`project_id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`policy` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `tasks` ADD `budget_wait` text;