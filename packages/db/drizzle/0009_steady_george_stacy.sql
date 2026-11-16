CREATE TABLE `comment` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`post_target_id` text NOT NULL,
	`external_id` text NOT NULL,
	`parent_external_id` text,
	`author_name` text NOT NULL,
	`author_avatar_url` text,
	`author_id` text,
	`text` text NOT NULL,
	`like_count` integer,
	`liked_by_me` integer DEFAULT false NOT NULL,
	`hidden` integer DEFAULT false NOT NULL,
	`is_own` integer DEFAULT false NOT NULL,
	`external_created_at` integer NOT NULL,
	`read_at` integer,
	`archived_at` integer,
	`deleted_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`post_target_id`) REFERENCES `post_target`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `comment_target_external_idx` ON `comment` (`post_target_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `comment_user_idx` ON `comment` (`user_id`,`external_created_at`);--> statement-breakpoint
CREATE TABLE `comment_action` (
	`id` text PRIMARY KEY NOT NULL,
	`comment_id` text NOT NULL,
	`kind` text NOT NULL,
	`text` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`check_first` integer DEFAULT false NOT NULL,
	`next_attempt_at` integer,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`comment_id`) REFERENCES `comment`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `comment_action_status_idx` ON `comment_action` (`status`);--> statement-breakpoint
CREATE TABLE `saved_reply` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `saved_reply_user_idx` ON `saved_reply` (`user_id`);