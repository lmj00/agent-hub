PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_budget_reservations` (
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
	CONSTRAINT "budget_reservations_valid" CHECK("__new_budget_reservations"."reserved_run_ms" >= 0 AND ("__new_budget_reservations"."settled_run_ms" IS NULL OR "__new_budget_reservations"."settled_run_ms" >= 0))
);
--> statement-breakpoint
INSERT INTO `__new_budget_reservations`("run_id", "project_period_id", "goal_period_id", "started_at", "reserved_run_ms", "settled_run_ms", "settled_at") SELECT "run_id", "project_period_id", "goal_period_id", "started_at", "reserved_run_ms", "settled_run_ms", "settled_at" FROM `budget_reservations`;--> statement-breakpoint
DROP TABLE `budget_reservations`;--> statement-breakpoint
ALTER TABLE `__new_budget_reservations` RENAME TO `budget_reservations`;--> statement-breakpoint
PRAGMA foreign_keys=ON;