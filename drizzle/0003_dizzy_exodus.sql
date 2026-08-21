CREATE TABLE `talk_turns` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`session_id` text NOT NULL,
	`role` text NOT NULL,
	`text` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `talk_turns_session_created_idx` ON `talk_turns` (`session_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `topic` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `seed_items` text;