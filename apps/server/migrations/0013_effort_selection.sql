ALTER TABLE `runs` ADD `effort_policy` text;--> statement-breakpoint
ALTER TABLE `steps` ADD `effort` text;--> statement-breakpoint
ALTER TABLE `steps` ADD `effort_reason` text;--> statement-breakpoint
ALTER TABLE `steps` ADD `effort_policy_version` integer;