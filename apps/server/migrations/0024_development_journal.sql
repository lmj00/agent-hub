CREATE TABLE `development_repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`created_by_run_id` text NOT NULL,
	`intent` text NOT NULL,
	`prepared` text,
	`created_at` integer NOT NULL,
	`prepared_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by_run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "development_repository_preparation_valid" CHECK(("development_repositories"."prepared" IS NULL AND "development_repositories"."prepared_at" IS NULL) OR ("development_repositories"."prepared" IS NOT NULL AND "development_repositories"."prepared_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `development_repositories_project_unique` ON `development_repositories` (`project_id`);--> statement-breakpoint
CREATE TABLE `development_rounds` (
	`run_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`repository_id` text NOT NULL,
	`input_id` text NOT NULL,
	`planning_revision` text NOT NULL,
	`intent` text NOT NULL,
	`input` text,
	`candidate` text,
	`execution_offset` integer NOT NULL,
	`created_at` integer NOT NULL,
	`prepared_at` integer,
	`captured_at` integer,
	PRIMARY KEY(`run_id`, `sequence`),
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`repository_id`) REFERENCES `development_repositories`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "development_rounds_sequence_valid" CHECK("development_rounds"."sequence" BETWEEN 1 AND 3),
	CONSTRAINT "development_rounds_execution_offset_valid" CHECK("development_rounds"."execution_offset" BETWEEN 0 AND 11),
	CONSTRAINT "development_rounds_preparation_valid" CHECK(("development_rounds"."input" IS NULL AND "development_rounds"."prepared_at" IS NULL) OR ("development_rounds"."input" IS NOT NULL AND "development_rounds"."prepared_at" IS NOT NULL)),
	CONSTRAINT "development_rounds_capture_valid" CHECK(("development_rounds"."candidate" IS NULL AND "development_rounds"."captured_at" IS NULL) OR ("development_rounds"."input" IS NOT NULL AND "development_rounds"."candidate" IS NOT NULL AND "development_rounds"."captured_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `development_rounds_input_unique` ON `development_rounds` (`input_id`);