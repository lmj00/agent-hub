CREATE TABLE `recovery_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`run_id` text,
	`request_key` text NOT NULL,
	`action` text NOT NULL,
	`provider_gate_version` integer,
	`status` text NOT NULL,
	`result_status` text,
	`error_code` text,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recovery_task_request_key_unique` ON `recovery_requests` (`task_id`,`request_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `recovery_one_pending_per_task` ON `recovery_requests` (`task_id`) WHERE "recovery_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX `recovery_pending_order_idx` ON `recovery_requests` (`status`,`created_at`,`id`);