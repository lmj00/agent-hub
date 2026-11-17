CREATE TABLE `service_inspections` (
	`run_id` text NOT NULL,
	`target_key` text NOT NULL,
	`fingerprint` text NOT NULL,
	`requested_at` integer NOT NULL,
	`completed_at` integer,
	PRIMARY KEY(`run_id`, `target_key`),
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`target_key`) REFERENCES `service_targets`(`key`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `service_inspections_pending_idx` ON `service_inspections` (`completed_at`,`target_key`);--> statement-breakpoint
ALTER TABLE `service_targets` ADD `on_demand` integer DEFAULT false NOT NULL;