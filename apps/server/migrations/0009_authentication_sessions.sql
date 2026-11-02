CREATE TABLE `auth_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`generation` text NOT NULL,
	`data` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `auth_sessions_expiry_idx` ON `auth_sessions` (`expires_at`);