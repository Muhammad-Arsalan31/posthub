ALTER TABLE `post` ADD `first_comment` text;--> statement-breakpoint
ALTER TABLE `post` ADD `pin_first_comment` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `post_target` ADD `first_comment_status` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `post_target` ADD `first_comment_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `post_target` ADD `first_comment_next_at` integer;--> statement-breakpoint
ALTER TABLE `post_target` ADD `first_comment_check` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `post_target` ADD `first_comment_external_id` text;--> statement-breakpoint
ALTER TABLE `post_target` ADD `first_comment_error` text;--> statement-breakpoint
ALTER TABLE `post_target` ADD `pinned_at` integer;