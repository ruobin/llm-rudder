CREATE TABLE `session_pins` (
	`client_id` varchar(64) NOT NULL,
	`session_hash` char(16) NOT NULL,
	`tier` varchar(64) NOT NULL,
	`target_id` varchar(255) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `session_pins_client_id_session_hash_tier_pk` PRIMARY KEY(`client_id`,`session_hash`,`tier`)
);
--> statement-breakpoint
CREATE INDEX `session_pins_updated` ON `session_pins` (`updated_at`);