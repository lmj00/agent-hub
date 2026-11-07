CREATE TABLE `notifications` (
	`source_key` text PRIMARY KEY NOT NULL,
	`condition_key` text NOT NULL,
	`id` text NOT NULL,
	`destination_hash` text NOT NULL,
	`reason` text NOT NULL,
	`project_id` text,
	`task_id` text,
	`run_id` text,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`last_attempt_at` integer,
	`last_result` text,
	`detected_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "notifications_status_valid" CHECK("notifications"."status" IN ('pending', 'delivered', 'exhausted', 'resolved')),
	CONSTRAINT "notifications_attempts_valid" CHECK("notifications"."attempts" >= 0 AND "notifications"."attempts" <= 20),
	CONSTRAINT "notifications_pending_due" CHECK(("notifications"."status" = 'pending') = ("notifications"."next_attempt_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_id_unique` ON `notifications` (`id`);--> statement-breakpoint
CREATE INDEX `notifications_due_idx` ON `notifications` (`status`,`next_attempt_at`,`source_key`);--> statement-breakpoint
CREATE INDEX `notifications_updated_idx` ON `notifications` (`updated_at`,`source_key`);