CREATE TABLE `booking_obligations` (
	`id` text PRIMARY KEY NOT NULL,
	`appointment_id` text NOT NULL,
	`change_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT 0 NOT NULL,
	`outcome` text,
	`last_error` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`appointment_id`) REFERENCES `appointments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`change_id`) REFERENCES `booking_changes`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "booking_obligations_kind" CHECK("booking_obligations"."kind" IN ('refund','notify')),
	CONSTRAINT "booking_obligations_status" CHECK("booking_obligations"."status" IN ('pending','done','failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `booking_obligations_change_kind` ON `booking_obligations` (`change_id`,`kind`);--> statement-breakpoint
CREATE INDEX `booking_obligations_due` ON `booking_obligations` (`status`,`next_attempt_at`);