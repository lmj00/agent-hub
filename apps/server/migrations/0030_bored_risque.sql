CREATE TABLE `repository_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`request_key` text NOT NULL,
	`command_hash` text NOT NULL,
	`repository_id` integer NOT NULL,
	`name` text NOT NULL,
	`profile` text NOT NULL,
	`status` text NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`attempt_id` text,
	`full_name` text,
	`revision` text,
	`local_revision` text,
	`error_code` text,
	`project_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "repository_imports_status_valid" CHECK("repository_imports"."status" IN ('queued','preparing','ready','failed','cancelled')),
	CONSTRAINT "repository_imports_attempt_valid" CHECK("repository_imports"."attempt" >= 0 AND "repository_imports"."attempt" <= 5),
	CONSTRAINT "repository_imports_repo_valid" CHECK("repository_imports"."repository_id" > 0),
	CONSTRAINT "repository_imports_ready_valid" CHECK(("repository_imports"."status" = 'ready') = ("repository_imports"."project_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repository_imports_request_unique` ON `repository_imports` (`request_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `repository_imports_repo_unique` ON `repository_imports` (`repository_id`);--> statement-breakpoint
CREATE INDEX `repository_imports_queue_idx` ON `repository_imports` (`status`,`created_at`,`id`);