DROP INDEX `idx_files_account_slug`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_files_account_name` ON `files` (`account_id`,`name`);--> statement-breakpoint
ALTER TABLE `files` DROP COLUMN `slug`;