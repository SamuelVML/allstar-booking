CREATE TABLE `appointment_slots` (
	`slot_start` text PRIMARY KEY NOT NULL,
	`appointment_id` text NOT NULL,
	FOREIGN KEY (`appointment_id`) REFERENCES `appointments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_appointment_slots_appointment` ON `appointment_slots` (`appointment_id`);--> statement-breakpoint
CREATE TABLE `appointments` (
	`id` text PRIMARY KEY NOT NULL,
	`reference` text NOT NULL,
	`service_id` text NOT NULL,
	`service_name` text NOT NULL,
	`duration_minutes` integer NOT NULL,
	`price_cents` integer NOT NULL,
	`appointment_date` text NOT NULL,
	`start_time` text NOT NULL,
	`end_time` text NOT NULL,
	`customer_name` text NOT NULL,
	`customer_email` text NOT NULL,
	`customer_phone` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'confirmed' NOT NULL,
	`payment_method` text DEFAULT 'pay_at_shop' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `appointments_reference_unique` ON `appointments` (`reference`);--> statement-breakpoint
CREATE INDEX `idx_appointments_date_status` ON `appointments` (`appointment_date`,`status`);