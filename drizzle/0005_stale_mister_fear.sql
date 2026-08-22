ALTER TABLE `content` ADD `didactic` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `content` ADD `syllabus_ref` text;--> statement-breakpoint
ALTER TABLE `items` ADD `syllabus_ref` text;