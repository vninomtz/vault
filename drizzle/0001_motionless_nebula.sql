CREATE TABLE `accounts` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_slug_unique` ON `accounts` (`slug`);--> statement-breakpoint
DROP INDEX `files_slug_unique`;--> statement-breakpoint
ALTER TABLE `files` ADD `account_id` text(26) NOT NULL REFERENCES accounts(id);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_files_account_slug` ON `files` (`account_id`,`slug`);--> statement-breakpoint
CREATE INDEX `idx_files_account` ON `files` (`account_id`);--> statement-breakpoint
ALTER TABLE `authors` ADD `account_id` text(26) REFERENCES accounts(id);--> statement-breakpoint
CREATE INDEX `idx_authors_account_id` ON `authors` (`account_id`);--> statement-breakpoint
ALTER TABLE `tokens` ADD `account_id` text(26) NOT NULL REFERENCES accounts(id);--> statement-breakpoint
CREATE INDEX `idx_tokens_account_id` ON `tokens` (`account_id`);--> statement-breakpoint
INSERT INTO `accounts` (`id`, `name`, `slug`, `created_at`)
VALUES ('01SYSTEM000000000000000000', 'system', 'system', 0);
--> statement-breakpoint
UPDATE `authors` SET `account_id` = '01SYSTEM000000000000000000' WHERE `id` = '01SYSTEM000000000000000001';
