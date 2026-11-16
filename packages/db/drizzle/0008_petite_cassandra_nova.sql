CREATE TABLE `account_metric_snapshot` (
	`id` text PRIMARY KEY NOT NULL,
	`social_account_id` text NOT NULL,
	`captured_at` integer NOT NULL,
	`followers` integer,
	`reach` integer,
	`raw` text,
	FOREIGN KEY (`social_account_id`) REFERENCES `social_account`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_metric_account_time_idx` ON `account_metric_snapshot` (`social_account_id`,`captured_at`);--> statement-breakpoint
CREATE TABLE `post_metric_snapshot` (
	`id` text PRIMARY KEY NOT NULL,
	`post_target_id` text NOT NULL,
	`captured_at` integer NOT NULL,
	`source` text DEFAULT 'platform' NOT NULL,
	`views` integer,
	`reach` integer,
	`likes` integer,
	`comments` integer,
	`shares` integer,
	`saves` integer,
	`clicks` integer,
	`watch_time_sec` integer,
	`raw` text,
	FOREIGN KEY (`post_target_id`) REFERENCES `post_target`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `post_metric_target_time_idx` ON `post_metric_snapshot` (`post_target_id`,`captured_at`);--> statement-breakpoint
CREATE TABLE `sync_job` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`subject_id` text NOT NULL,
	`social_account_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_run_at` integer,
	`last_run_at` integer,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`social_account_id`) REFERENCES `social_account`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sync_job_kind_subject_idx` ON `sync_job` (`kind`,`subject_id`);--> statement-breakpoint
CREATE INDEX `sync_job_due_idx` ON `sync_job` (`status`,`next_run_at`);--> statement-breakpoint
ALTER TABLE `social_account` ADD `granted_scopes` text;