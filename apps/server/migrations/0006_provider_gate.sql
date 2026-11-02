CREATE TABLE `provider_gates` (
	`scope` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`blocked` integer NOT NULL,
	`reason` text,
	`blocked_at` integer,
	`retry_at` integer,
	`source_run_id` text,
	`probe_task_id` text,
	`probe_run_id` text,
	FOREIGN KEY (`source_run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`probe_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`probe_run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "provider_gate_version_positive" CHECK("provider_gates"."version" > 0)
);
--> statement-breakpoint
DROP INDEX `runs_one_active`;--> statement-breakpoint
ALTER TABLE `runs` ADD `retry_at` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `provider_gate_version` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `runs_one_active` ON `runs` (`slot`) WHERE "runs"."status" = 'running' OR ("runs"."status" IN ('interrupted', 'blocked', 'waiting_capacity') AND "runs"."termination_confirmed_at" IS NULL);
--> statement-breakpoint
INSERT INTO `provider_gates` (`scope`, `version`, `blocked`, `reason`, `blocked_at`, `source_run_id`)
SELECT 'openai:chatgpt', 1, 1,
  CASE WHEN `error_code` = 'authentication' THEN 'authentication'
       WHEN `error_code` = 'capacity' OR `status` = 'waiting_capacity' THEN 'capacity'
       ELSE 'configuration' END,
  COALESCE(`finished_at`, `started_at`), `id`
FROM `runs`
WHERE `status` IN ('blocked', 'waiting_capacity')
   OR (`status` = 'interrupted' AND `error_code` IN ('authentication', 'capacity', 'unsupported_settings'))
ORDER BY `started_at` DESC, `id` DESC
LIMIT 1;
