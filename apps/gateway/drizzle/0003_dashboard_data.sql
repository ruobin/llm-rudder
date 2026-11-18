CREATE TABLE `client_keys` (
	`id` varchar(64) NOT NULL,
	`key_hash` char(64) NOT NULL,
	`key_prefix` varchar(16) NOT NULL,
	`notice` varchar(8) NOT NULL,
	`rpm` int,
	`max_concurrent` int NOT NULL,
	`allow_accounts` json,
	`allow_fallback` boolean NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`last_used_at` datetime(3),
	`revoked_at` datetime(3),
	CONSTRAINT `client_keys_id` PRIMARY KEY(`id`),
	CONSTRAINT `client_keys_hash` UNIQUE(`key_hash`)
);
--> statement-breakpoint
CREATE TABLE `usage_daily` (
	`day` char(10) NOT NULL,
	`client_id` varchar(64) NOT NULL,
	`account_id` varchar(64) NOT NULL,
	`model` varchar(128) NOT NULL,
	`served` int NOT NULL,
	`failed` int NOT NULL,
	`input_tokens` bigint NOT NULL,
	`cached_tokens` bigint NOT NULL,
	`cache_write_tokens` bigint NOT NULL,
	`output_tokens` bigint NOT NULL,
	`cost_micro_usd` bigint NOT NULL,
	`list_micro_usd` bigint NOT NULL,
	CONSTRAINT `usage_daily_day_client_id_account_id_model_pk` PRIMARY KEY(`day`,`client_id`,`account_id`,`model`)
);
--> statement-breakpoint
CREATE INDEX `attempts_started` ON `attempts` (`started_at`);