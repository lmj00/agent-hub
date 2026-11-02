ALTER TABLE `runs` ADD `accounted_duration_ms` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `retry_state` text;