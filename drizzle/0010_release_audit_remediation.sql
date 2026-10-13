-- Release audit remediation (findings 1-8). Applies after 0009.
-- booking_obligations is rebuilt to add the 'reconcile' status and the stored
-- notification payload; no table references it, so the rebuild needs no
-- foreign-key pragma (D1 enforces foreign keys during migrations).
CREATE TABLE `bookly_conflicts` (
	`local_id` text PRIMARY KEY NOT NULL,
	`remote_id` text,
	`remote_version` text,
	`reason` text NOT NULL,
	`detected_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `__new_booking_obligations` (
	`id` text PRIMARY KEY NOT NULL,
	`appointment_id` text NOT NULL,
	`change_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT 0 NOT NULL,
	`outcome` text,
	`last_error` text,
	`payload` text,
	`first_attempt_at` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`appointment_id`) REFERENCES `appointments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`change_id`) REFERENCES `booking_changes`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "booking_obligations_kind" CHECK("__new_booking_obligations"."kind" IN ('refund','notify')),
	CONSTRAINT "booking_obligations_status" CHECK("__new_booking_obligations"."status" IN ('pending','done','failed','reconcile'))
);
--> statement-breakpoint
INSERT INTO `__new_booking_obligations`("id", "appointment_id", "change_id", "kind", "status", "attempts", "next_attempt_at", "outcome", "last_error", "payload", "first_attempt_at", "created_at", "updated_at") SELECT "id", "appointment_id", "change_id", "kind", "status", "attempts", "next_attempt_at", "outcome", "last_error", NULL, NULL, "created_at", "updated_at" FROM `booking_obligations`;--> statement-breakpoint
DROP TABLE `booking_obligations`;--> statement-breakpoint
ALTER TABLE `__new_booking_obligations` RENAME TO `booking_obligations`;--> statement-breakpoint
CREATE UNIQUE INDEX `booking_obligations_change_kind` ON `booking_obligations` (`change_id`,`kind`);--> statement-breakpoint
CREATE INDEX `booking_obligations_due` ON `booking_obligations` (`status`,`next_attempt_at`);--> statement-breakpoint
ALTER TABLE `payment_refunds` ADD `attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `payment_refunds` ADD `next_attempt_at` integer DEFAULT 0 NOT NULL;