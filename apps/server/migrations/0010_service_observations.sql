CREATE TABLE `service_observations` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`target_key` text NOT NULL,
	`fingerprint` text NOT NULL,
	`received_at` integer NOT NULL,
	`success` integer NOT NULL,
	`error_code` text,
	`snapshot` text,
	FOREIGN KEY (`target_key`) REFERENCES `service_targets`(`key`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "service_observation_result_valid" CHECK(("service_observations"."success" = 1 AND "service_observations"."snapshot" IS NOT NULL AND json_valid("service_observations"."snapshot") AND "service_observations"."error_code" IS NULL) OR ("service_observations"."success" = 0 AND "service_observations"."snapshot" IS NULL AND "service_observations"."error_code" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `service_observations_id_unique` ON `service_observations` (`id`);--> statement-breakpoint
CREATE INDEX `service_observations_target_sequence_idx` ON `service_observations` (`target_key`,`sequence`);--> statement-breakpoint
CREATE TABLE `service_targets` (
	`key` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`fingerprint` text NOT NULL,
	`configured` integer NOT NULL,
	`interval_ms` integer NOT NULL,
	`stale_after_ms` integer NOT NULL,
	`allow_waiting` integer NOT NULL,
	`activity_timeout_ms` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `service_targets_project_idx` ON `service_targets` (`project_id`);