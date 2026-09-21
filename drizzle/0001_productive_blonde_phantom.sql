CREATE TABLE `stripe_events` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE `appointments` ADD `payment_status` text DEFAULT 'due_at_shop' NOT NULL;--> statement-breakpoint
ALTER TABLE `appointments` ADD `stripe_checkout_session_id` text;--> statement-breakpoint
ALTER TABLE `appointments` ADD `payment_expires_at` text;--> statement-breakpoint
ALTER TABLE `appointments` ADD `paid_at` text;--> statement-breakpoint
CREATE UNIQUE INDEX `appointments_stripe_checkout_session_id_unique` ON `appointments` (`stripe_checkout_session_id`);