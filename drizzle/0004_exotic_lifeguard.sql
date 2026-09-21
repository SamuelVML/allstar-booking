CREATE TABLE `payment_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`appointment_id` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`method` text NOT NULL,
	`actor_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`appointment_id`) REFERENCES `appointments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_receipts_appointment_id_unique` ON `payment_receipts` (`appointment_id`);--> statement-breakpoint
CREATE TABLE `time_off` (
	`id` text PRIMARY KEY NOT NULL,
	`date` text NOT NULL,
	`start_time` text NOT NULL,
	`end_time` text NOT NULL,
	`reason` text NOT NULL,
	`actor_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`removed_at` text,
	`removed_by` text
);
--> statement-breakpoint
CREATE TABLE `time_off_slots` (
	`slot_start` text PRIMARY KEY NOT NULL,
	`time_off_id` text NOT NULL,
	FOREIGN KEY (`time_off_id`) REFERENCES `time_off`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `appointments` ADD `source` text DEFAULT 'online' NOT NULL;--> statement-breakpoint
ALTER TABLE `appointments` ADD `created_by` text;--> statement-breakpoint
-- Both insertion paths enforce the shared capacity constraint, including races.
CREATE TRIGGER appointment_respects_time_off BEFORE INSERT ON appointment_slots
WHEN EXISTS (SELECT 1 FROM time_off_slots WHERE slot_start = NEW.slot_start)
BEGIN SELECT RAISE(ABORT, 'Slot unavailable'); END;
--> statement-breakpoint
CREATE TRIGGER time_off_respects_appointment BEFORE INSERT ON time_off_slots
WHEN EXISTS (SELECT 1 FROM appointment_slots WHERE slot_start = NEW.slot_start)
BEGIN SELECT RAISE(ABORT, 'Slot unavailable'); END;
