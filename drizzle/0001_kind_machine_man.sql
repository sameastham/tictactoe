CREATE TABLE `writings` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`task` text,
	`text` text NOT NULL,
	`judgment` text,
	`prompt_version` text,
	`model` text,
	`session_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `writings_user_created_idx` ON `writings` (`user_id`,`created_at`);