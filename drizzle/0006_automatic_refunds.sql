CREATE TABLE `payment_refunds` (
	`id` text PRIMARY KEY NOT NULL,
	`appointment_id` text NOT NULL,
	`stripe_refund_id` text,
	`amount_cents` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`requested_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`appointment_id`) REFERENCES `appointments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_refunds_appointment_id_unique` ON `payment_refunds` (`appointment_id`);
