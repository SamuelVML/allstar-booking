CREATE TABLE `launch_list_subscribers` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `email` text NOT NULL,
  `consent` integer DEFAULT true NOT NULL,
  `source` text DEFAULT 'mobile_barber_launch_list' NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE UNIQUE INDEX `launch_list_subscribers_email_unique` ON `launch_list_subscribers` (`email`);
