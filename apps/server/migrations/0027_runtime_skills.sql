-- Keep populated Run/Step histories and their foreign keys in place.
ALTER TABLE `runs` ADD `runtime_skill_version` integer CONSTRAINT `runs_runtime_skill_version_valid` CHECK (`runtime_skill_version` IS NULL OR `runtime_skill_version` = 1);
--> statement-breakpoint
ALTER TABLE `steps` ADD `runtime_skill` text;
--> statement-breakpoint
ALTER TABLE `steps` ADD `runtime_skill_selected_at` integer;
--> statement-breakpoint
ALTER TABLE `steps` ADD `runtime_skill_loaded_at` integer;
