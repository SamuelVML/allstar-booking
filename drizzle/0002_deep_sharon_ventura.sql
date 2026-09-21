CREATE TABLE `customer_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`phone` text NOT NULL,
	`reminder_opt_in` integer DEFAULT true NOT NULL,
	`marketing_consent` integer DEFAULT false NOT NULL,
	`loyalty_points` integer DEFAULT 0 NOT NULL,
	`completed_visits` integer DEFAULT 0 NOT NULL,
	`last_visit_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customer_accounts_email_unique` ON `customer_accounts` (`email`);--> statement-breakpoint
CREATE INDEX `idx_customer_accounts_phone` ON `customer_accounts` (`phone`);--> statement-breakpoint
CREATE TABLE `loyalty_events` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_account_id` text NOT NULL,
	`appointment_id` text NOT NULL,
	`points_delta` integer NOT NULL,
	`event_type` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`customer_account_id`) REFERENCES `customer_accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`appointment_id`) REFERENCES `appointments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `loyalty_events_appointment_id_unique` ON `loyalty_events` (`appointment_id`);--> statement-breakpoint
CREATE INDEX `idx_loyalty_events_customer` ON `loyalty_events` (`customer_account_id`);--> statement-breakpoint
ALTER TABLE `appointments` ADD `customer_account_id` text REFERENCES customer_accounts(id);--> statement-breakpoint
ALTER TABLE `appointments` ADD `handling_minutes` integer DEFAULT 10 NOT NULL;--> statement-breakpoint
INSERT OR IGNORE INTO `appointment_slots` (`slot_start`, `appointment_id`)
SELECT `appointment_date` || 'T' || `end_time`, `id`
FROM `appointments`
WHERE `status` IN ('confirmed', 'payment_pending');--> statement-breakpoint
INSERT OR IGNORE INTO `appointment_slots` (`slot_start`, `appointment_id`)
SELECT `appointment_date` || 'T' || strftime('%H:%M', datetime('2000-01-01 ' || `end_time`, '+5 minutes')), `id`
FROM `appointments`
WHERE `status` IN ('confirmed', 'payment_pending');
