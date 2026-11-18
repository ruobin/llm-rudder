CREATE TABLE `attempts` (
	`request_id` char(26) NOT NULL,
	`n` smallint NOT NULL,
	`target_id` varchar(255) NOT NULL,
	`account_id` varchar(64) NOT NULL,
	`model` varchar(128) NOT NULL,
	`returned_model` varchar(128),
	`started_at` datetime(3) NOT NULL,
	`ttft_ms` int,
	`duration_ms` int,
	`http_status` smallint,
	`outcome` varchar(32) NOT NULL,
	`error_code` varchar(128),
	`input_tokens` int,
	`cached_tokens` int,
	`output_tokens` int,
	`usage_complete` boolean NOT NULL DEFAULT true,
	`cost_micro_usd` bigint,
	`list_micro_usd` bigint,
	CONSTRAINT `attempts_request_id_n_pk` PRIMARY KEY(`request_id`,`n`)
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`at` datetime(3) NOT NULL,
	`kind` varchar(48) NOT NULL,
	`subject` varchar(160) NOT NULL,
	`message` varchar(500) NOT NULL,
	CONSTRAINT `events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `quota_state` (
	`account_id` varchar(64) NOT NULL,
	`scope` varchar(160) NOT NULL,
	`status` varchar(16) NOT NULL,
	`retry_at` datetime(3),
	`backoff_s` int,
	`detail` varchar(255),
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `quota_state_account_id_scope_pk` PRIMARY KEY(`account_id`,`scope`)
);
--> statement-breakpoint
CREATE TABLE `requests` (
	`id` char(26) NOT NULL,
	`started_at` datetime(3) NOT NULL,
	`finished_at` datetime(3),
	`client_id` varchar(64) NOT NULL,
	`session_hash` char(16) NOT NULL,
	`requested_model` varchar(128) NOT NULL,
	`requested_tier` varchar(64),
	`served_tier` varchar(64),
	`served_target` varchar(255),
	`stream` boolean NOT NULL,
	`outcome` varchar(32),
	`http_status` smallint,
	`attempt_count` smallint NOT NULL DEFAULT 0,
	CONSTRAINT `requests_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `spend` (
	`account_id` varchar(64) NOT NULL,
	`period` varchar(16) NOT NULL,
	`spent_micro_usd` bigint NOT NULL DEFAULT 0,
	CONSTRAINT `spend_account_id_period_pk` PRIMARY KEY(`account_id`,`period`)
);
--> statement-breakpoint
CREATE INDEX `attempts_account_started` ON `attempts` (`account_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `events_at` ON `events` (`at`);--> statement-breakpoint
CREATE INDEX `requests_started` ON `requests` (`started_at`);--> statement-breakpoint
CREATE INDEX `requests_client_started` ON `requests` (`client_id`,`started_at`);