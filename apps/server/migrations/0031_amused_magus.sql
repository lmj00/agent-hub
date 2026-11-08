CREATE TABLE `repository_creations` (
	`id` text PRIMARY KEY NOT NULL,
	`request_key` text NOT NULL,
	`command_hash` text NOT NULL,
	`repository_name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`name` text NOT NULL,
	`profile` text NOT NULL,
	`status` text NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`repository_id` integer,
	`full_name` text,
	`import_id` text,
	`error_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`import_id`) REFERENCES `repository_imports`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "repository_creations_attempt_valid" CHECK("repository_creations"."attempt" BETWEEN 0 AND 5),
	CONSTRAINT "repository_creations_status_valid" CHECK("repository_creations"."status" IN ('queued', 'authorizing', 'creating', 'created', 'linked', 'failed', 'uncertain', 'cancelled')),
	CONSTRAINT "repository_creations_identity_valid" CHECK(("repository_creations"."status" IN ('created', 'linked') AND "repository_creations"."repository_id" IS NOT NULL AND "repository_creations"."repository_id" > 0 AND "repository_creations"."full_name" IS NOT NULL) OR ("repository_creations"."status" NOT IN ('created', 'linked') AND "repository_creations"."repository_id" IS NULL AND "repository_creations"."full_name" IS NULL)),
	CONSTRAINT "repository_creations_link_valid" CHECK(("repository_creations"."status" = 'linked' AND "repository_creations"."import_id" IS NOT NULL) OR ("repository_creations"."status" != 'linked' AND "repository_creations"."import_id" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repository_creations_request_key_unique` ON `repository_creations` (`request_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `repository_creations_normalized_name_unique` ON `repository_creations` (`normalized_name`);--> statement-breakpoint
CREATE INDEX `repository_creations_status_idx` ON `repository_creations` (`status`,`created_at`);