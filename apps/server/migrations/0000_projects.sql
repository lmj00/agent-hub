CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`workspace_key` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "projects_name_not_blank" CHECK(length(trim("projects"."name")) > 0),
	CONSTRAINT "projects_workspace_key_not_blank" CHECK(length(trim("projects"."workspace_key")) > 0)
);
