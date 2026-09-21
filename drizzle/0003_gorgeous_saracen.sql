CREATE TABLE `booking_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`appointment_id` text NOT NULL,
	`revision` integer NOT NULL,
	`action` text NOT NULL,
	`actor_id` text NOT NULL,
	`previous_date` text NOT NULL,
	`previous_time` text NOT NULL,
	`new_date` text,
	`new_time` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`appointment_id`) REFERENCES `appointments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `booking_changes_appointment_revision` ON `booking_changes` (`appointment_id`,`revision`);--> statement-breakpoint
ALTER TABLE `appointments` ADD `revision` integer DEFAULT 0 NOT NULL;