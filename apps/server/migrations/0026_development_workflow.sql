-- Add the version marker in place so existing execution/review foreign keys
-- remain valid. Older Runs do not inherit the managed no-start guarantee.
ALTER TABLE `runs` ADD `development_version` integer CONSTRAINT `runs_development_version_valid` CHECK (`development_version` IS NULL OR `development_version` = 1);
