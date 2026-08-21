CREATE TABLE `content` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`source` text NOT NULL,
	`source_url` text,
	`type` text NOT NULL,
	`title` text,
	`text` text NOT NULL,
	`transcript` text,
	`word_timestamps` text,
	`difficulty` text,
	`extraction` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `content_user_created_idx` ON `content` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `eval_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`prompt_name` text NOT NULL,
	`prompt_version` text NOT NULL,
	`model` text NOT NULL,
	`agreement` text,
	`cost_usd` real,
	`input_tokens` integer,
	`output_tokens` integer,
	`notes` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`type` text NOT NULL,
	`surface` text NOT NULL,
	`taxonomy` text,
	`severity` text,
	`confidence` real,
	`item_id` text,
	`content_id` text,
	`session_id` text,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`content_id`) REFERENCES `content`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `events_user_created_idx` ON `events` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `events_user_type_idx` ON `events` (`user_id`,`type`);--> statement-breakpoint
CREATE INDEX `events_item_idx` ON `events` (`item_id`);--> statement-breakpoint
CREATE TABLE `gold_set` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`sentence` text NOT NULL,
	`set_name` text NOT NULL,
	`expected_rung` text,
	`expected_tags` text DEFAULT '[]' NOT NULL,
	`origin` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `items` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`chunk` text NOT NULL,
	`register` text NOT NULL,
	`contrast_set` text,
	`origin_content_id` text,
	`origin_sentence` text NOT NULL,
	`why` text NOT NULL,
	`taxonomy` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`origin_content_id`) REFERENCES `content`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `items_user_created_idx` ON `items` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `items_origin_idx` ON `items` (`origin_content_id`);--> statement-breakpoint
CREATE TABLE `model_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`purpose` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`prompt_version` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real NOT NULL,
	`duration_ms` integer NOT NULL,
	`ok` integer NOT NULL,
	`error` text,
	`content_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`content_id`) REFERENCES `content`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `model_calls_user_created_idx` ON `model_calls` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`surface` text NOT NULL,
	`content_id` text,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`duration_s` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`content_id`) REFERENCES `content`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sessions_user_started_idx` ON `sessions` (`user_id`,`started_at`);