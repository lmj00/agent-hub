-- Add fields in place: rebuilding tasks would disturb existing Run and recovery references.
ALTER TABLE `tasks` ADD `kind` text NOT NULL DEFAULT 'work'
  CONSTRAINT `tasks_kind_valid` CHECK (`kind` IN ('planning', 'work'));
--> statement-breakpoint
ALTER TABLE `tasks` ADD `goal_id` text REFERENCES `goals`(`id`) ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `goal_version` integer
  CONSTRAINT `tasks_goal_binding_valid` CHECK (
    (`goal_id` IS NULL AND `goal_version` IS NULL AND `kind` = 'work')
    OR (`goal_id` IS NOT NULL AND `goal_version` IS NOT NULL AND `goal_version` > 0)
  );
--> statement-breakpoint
CREATE INDEX `tasks_goal_status_idx` ON `tasks` (`goal_id`, `status`, `created_at`, `id`);
--> statement-breakpoint
ALTER TABLE `runs` ADD `goal_version` integer;
