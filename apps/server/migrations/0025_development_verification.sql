PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_development_rounds` (
	`run_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`repository_id` text NOT NULL,
	`input_id` text NOT NULL,
	`planning_revision` text NOT NULL,
	`intent` text NOT NULL,
	`input` text,
	`candidate` text,
	`verification_intent` text,
	`verification_input` text,
	`verification_result` text,
	`review` text,
	`execution_offset` integer NOT NULL,
	`created_at` integer NOT NULL,
	`prepared_at` integer,
	`captured_at` integer,
	`verification_prepared_at` integer,
	`verified_at` integer,
	`reviewed_at` integer,
	PRIMARY KEY(`run_id`, `sequence`),
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`repository_id`) REFERENCES `development_repositories`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "development_rounds_sequence_valid" CHECK("__new_development_rounds"."sequence" BETWEEN 1 AND 3),
	CONSTRAINT "development_rounds_execution_offset_valid" CHECK("__new_development_rounds"."execution_offset" BETWEEN 0 AND 11),
	CONSTRAINT "development_rounds_preparation_valid" CHECK(("__new_development_rounds"."input" IS NULL AND "__new_development_rounds"."prepared_at" IS NULL) OR ("__new_development_rounds"."input" IS NOT NULL AND "__new_development_rounds"."prepared_at" IS NOT NULL)),
	CONSTRAINT "development_rounds_capture_valid" CHECK(("__new_development_rounds"."candidate" IS NULL AND "__new_development_rounds"."captured_at" IS NULL) OR ("__new_development_rounds"."input" IS NOT NULL AND "__new_development_rounds"."candidate" IS NOT NULL AND "__new_development_rounds"."captured_at" IS NOT NULL)),
	CONSTRAINT "development_rounds_verification_intent_valid" CHECK("__new_development_rounds"."verification_intent" IS NULL OR "__new_development_rounds"."candidate" IS NOT NULL),
	CONSTRAINT "development_rounds_verification_input_valid" CHECK(("__new_development_rounds"."verification_input" IS NULL AND "__new_development_rounds"."verification_prepared_at" IS NULL) OR ("__new_development_rounds"."verification_intent" IS NOT NULL AND "__new_development_rounds"."verification_input" IS NOT NULL AND "__new_development_rounds"."verification_prepared_at" IS NOT NULL)),
	CONSTRAINT "development_rounds_verification_result_valid" CHECK(("__new_development_rounds"."verification_result" IS NULL AND "__new_development_rounds"."verified_at" IS NULL) OR ("__new_development_rounds"."verification_input" IS NOT NULL AND "__new_development_rounds"."verification_result" IS NOT NULL AND "__new_development_rounds"."verified_at" IS NOT NULL)),
	CONSTRAINT "development_rounds_review_valid" CHECK(("__new_development_rounds"."review" IS NULL AND "__new_development_rounds"."reviewed_at" IS NULL) OR ("__new_development_rounds"."verification_result" IS NOT NULL AND "__new_development_rounds"."review" IS NOT NULL AND "__new_development_rounds"."reviewed_at" IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_development_rounds`("run_id", "sequence", "repository_id", "input_id", "planning_revision", "intent", "input", "candidate", "verification_intent", "verification_input", "verification_result", "review", "execution_offset", "created_at", "prepared_at", "captured_at", "verification_prepared_at", "verified_at", "reviewed_at") SELECT "run_id", "sequence", "repository_id", "input_id", "planning_revision", "intent", "input", "candidate", NULL, NULL, NULL, NULL, "execution_offset", "created_at", "prepared_at", "captured_at", NULL, NULL, NULL FROM `development_rounds`;--> statement-breakpoint
DROP TABLE `development_rounds`;--> statement-breakpoint
ALTER TABLE `__new_development_rounds` RENAME TO `development_rounds`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `development_rounds_input_unique` ON `development_rounds` (`input_id`);