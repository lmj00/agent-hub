CREATE TABLE `project_publications` (
	`project_id` text PRIMARY KEY NOT NULL,
	`listed` integer DEFAULT false NOT NULL,
	`name` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE restrict
);
