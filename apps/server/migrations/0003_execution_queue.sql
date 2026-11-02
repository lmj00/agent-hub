CREATE TABLE `execution_owner` (
	`slot` integer PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`hostname` text NOT NULL,
	`pid` integer NOT NULL,
	CONSTRAINT "execution_owner_single_slot" CHECK("execution_owner"."slot" = 1),
	CONSTRAINT "execution_owner_positive_pid" CHECK("execution_owner"."pid" > 0)
);
--> statement-breakpoint
CREATE INDEX `tasks_status_created_at_idx` ON `tasks` (`status`,`created_at`,`id`);