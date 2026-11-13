ALTER TABLE `post` ADD `link` text;--> statement-breakpoint
ALTER TABLE `post_target` ADD `next_attempt_at` integer;--> statement-breakpoint
CREATE INDEX `media_asset_user_idx` ON `media_asset` (`user_id`);--> statement-breakpoint
CREATE INDEX `post_media_media_idx` ON `post_media` (`media_id`);