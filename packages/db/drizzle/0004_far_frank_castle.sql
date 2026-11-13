ALTER TABLE `post` ADD `featured_media_id` text REFERENCES media_asset(id);--> statement-breakpoint
ALTER TABLE `post` ADD `thumbnail_media_id` text REFERENCES media_asset(id);