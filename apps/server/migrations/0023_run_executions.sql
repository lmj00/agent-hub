CREATE TABLE `run_executions` (
	`run_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`container_id` text NOT NULL,
	`token` text NOT NULL,
	`engine_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`termination_confirmed_at` integer,
	PRIMARY KEY(`run_id`, `sequence`),
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "run_executions_sequence_valid" CHECK("run_executions"."sequence" BETWEEN 1 AND 12)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_executions_container_unique` ON `run_executions` (`run_id`,`container_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `run_executions_one_unconfirmed` ON `run_executions` (`run_id`) WHERE "run_executions"."termination_confirmed_at" IS NULL;--> statement-breakpoint
INSERT INTO `run_executions` (`run_id`, `sequence`, `container_id`, `token`, `engine_id`, `created_at`, `termination_confirmed_at`)
SELECT `id`, 1,
  CASE WHEN json_extract(`execution`, '$.kind') = 'docker' THEN json_extract(`execution`, '$.containerId') ELSE NULL END,
  json_extract(`execution`, '$.token'), json_extract(`execution`, '$.engineId'), `started_at`, `termination_confirmed_at`
FROM `runs` WHERE `execution` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `runs` DROP COLUMN `execution`;
