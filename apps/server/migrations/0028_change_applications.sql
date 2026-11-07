CREATE TABLE `change_applications` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`run_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`round_sequence` integer NOT NULL,
	`goal_version` integer NOT NULL,
	`base_revision` text NOT NULL,
	`tree` text NOT NULL,
	`candidate_digest` text NOT NULL,
	`evidence_digest` text NOT NULL,
	`result_commit` text NOT NULL,
	`target_ref` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`applied_at` integer,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`repository_id`) REFERENCES `development_repositories`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "change_applications_status_valid" CHECK(("change_applications"."status" = 'pending' AND "change_applications"."applied_at" IS NULL) OR ("change_applications"."status" = 'applied' AND "change_applications"."applied_at" IS NOT NULL)),
	CONSTRAINT "change_applications_round_valid" CHECK("change_applications"."round_sequence" BETWEEN 1 AND 3),
	CONSTRAINT "change_applications_goal_version_valid" CHECK("change_applications"."goal_version" > 0),
	CONSTRAINT "change_applications_ref_valid" CHECK("change_applications"."target_ref" = 'refs/heads/development')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `change_applications_task_unique` ON `change_applications` (`task_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `change_applications_run_unique` ON `change_applications` (`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `change_applications_repository_pending` ON `change_applications` (`repository_id`) WHERE "change_applications"."status" = 'pending';