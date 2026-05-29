CREATE TABLE `authors` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`source_id` text(26),
	`created_at` integer NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_authors_kind` ON `authors` (`kind`);--> statement-breakpoint
CREATE INDEX `idx_authors_source_id` ON `authors` (`source_id`);--> statement-breakpoint
CREATE TABLE `conflict_entries` (
	`conflict_id` text(26) NOT NULL,
	`entry_id` text(26) NOT NULL,
	PRIMARY KEY(`conflict_id`, `entry_id`),
	FOREIGN KEY (`conflict_id`) REFERENCES `conflicts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`entry_id`) REFERENCES `entries`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `conflicts` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`file_id` text(26) NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`detected_at` integer NOT NULL,
	`resolved_at` integer,
	`resolution_entry_id` text(26),
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resolution_entry_id`) REFERENCES `entries`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_conflicts_file_id` ON `conflicts` (`file_id`);--> statement-breakpoint
CREATE INDEX `idx_conflicts_status` ON `conflicts` (`status`);--> statement-breakpoint
CREATE TABLE `entries` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`file_id` text(26) NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`sequence_number` integer NOT NULL,
	`global_position` integer NOT NULL,
	`hlc` integer NOT NULL,
	`idempotency_key` text(26) NOT NULL,
	`content` text,
	`content_ref` text,
	`content_type` text DEFAULT 'text/markdown' NOT NULL,
	`type` text NOT NULL,
	`intent` text NOT NULL,
	`tombstone` integer DEFAULT 0 NOT NULL,
	`author_id` text(26) NOT NULL,
	`source_id` text(26) NOT NULL,
	`confidence` text DEFAULT 'medium' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_id`) REFERENCES `authors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `entries_global_position_unique` ON `entries` (`global_position`);--> statement-breakpoint
CREATE UNIQUE INDEX `entries_idempotency_key_unique` ON `entries` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_entries_file_seq` ON `entries` (`file_id`,`sequence_number`);--> statement-breakpoint
CREATE INDEX `idx_entries_global_pos` ON `entries` (`global_position`);--> statement-breakpoint
CREATE INDEX `idx_entries_source_id` ON `entries` (`source_id`);--> statement-breakpoint
CREATE INDEX `idx_entries_author_id` ON `entries` (`author_id`);--> statement-breakpoint
CREATE INDEX `idx_entries_type` ON `entries` (`type`);--> statement-breakpoint
CREATE INDEX `idx_entries_hlc` ON `entries` (`hlc`);--> statement-breakpoint
CREATE TABLE `entry_references` (
	`from_entry_id` text(26) NOT NULL,
	`to_entry_id` text(26) NOT NULL,
	PRIMARY KEY(`from_entry_id`, `to_entry_id`),
	FOREIGN KEY (`from_entry_id`) REFERENCES `entries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_entry_id`) REFERENCES `entries`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_entry_refs_to` ON `entry_references` (`to_entry_id`);--> statement-breakpoint
CREATE TABLE `files` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`current_version` integer DEFAULT 0 NOT NULL,
	`snapshot_policy` text DEFAULT '{"type":"n_events","value":500}' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `files_slug_unique` ON `files` (`slug`);--> statement-breakpoint
CREATE INDEX `idx_files_type` ON `files` (`type`);--> statement-breakpoint
CREATE INDEX `idx_files_status` ON `files` (`status`);--> statement-breakpoint
CREATE INDEX `idx_files_updated` ON `files` (`updated_at`);--> statement-breakpoint
CREATE TABLE `projections` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`file_id` text(26) NOT NULL,
	`content` text NOT NULL,
	`last_global_position` integer NOT NULL,
	`materialized_at` integer NOT NULL,
	`freshness` text DEFAULT 'fresh' NOT NULL,
	`rebuild_status` text DEFAULT 'idle' NOT NULL,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projections_file_id_unique` ON `projections` (`file_id`);--> statement-breakpoint
CREATE INDEX `idx_projections_freshness` ON `projections` (`freshness`);--> statement-breakpoint
CREATE INDEX `idx_projections_rebuild` ON `projections` (`rebuild_status`);--> statement-breakpoint
CREATE TABLE `snapshots` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`file_id` text(26) NOT NULL,
	`at_sequence` integer NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_snapshots_file_seq` ON `snapshots` (`file_id`,`at_sequence`);--> statement-breakpoint
CREATE INDEX `idx_snapshots_file_id` ON `snapshots` (`file_id`);--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`confidence` text DEFAULT 'medium' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`last_sync_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_sources_type` ON `sources` (`type`);--> statement-breakpoint
CREATE INDEX `idx_sources_status` ON `sources` (`status`);--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`actor_id` text(26) NOT NULL,
	`filter` text DEFAULT '{}' NOT NULL,
	`channel` text NOT NULL,
	`channel_config` text DEFAULT '{}' NOT NULL,
	`last_notified_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `authors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_subscriptions_actor_id` ON `subscriptions` (`actor_id`);--> statement-breakpoint
CREATE TABLE `tokens` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`name` text NOT NULL,
	`actor_id` text(26) NOT NULL,
	`parent_id` text(26),
	`read_scope` text DEFAULT '[]' NOT NULL,
	`write_scope` text DEFAULT '[]' NOT NULL,
	`propose_only` integer DEFAULT 0 NOT NULL,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `authors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tokens_token_hash_unique` ON `tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_tokens_actor_id` ON `tokens` (`actor_id`);--> statement-breakpoint
CREATE TABLE `upcasters` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`from_version` integer NOT NULL,
	`to_version` integer NOT NULL,
	`transform_fn` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `sources` (`id`, `name`, `type`, `config`, `confidence`, `status`, `created_at`)
VALUES ('01SYSTEM000000000000000000', 'vault-system', 'local_folder', '{}', 'high', 'active', 0);
--> statement-breakpoint
INSERT INTO `authors` (`id`, `name`, `kind`, `source_id`, `created_at`)
VALUES ('01SYSTEM000000000000000001', 'vault-system', 'system', '01SYSTEM000000000000000000', 0);
