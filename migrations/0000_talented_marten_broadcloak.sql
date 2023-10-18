CREATE TABLE `action_items` (
	`id` integer PRIMARY KEY NOT NULL,
	`slack_id` integer,
	`github_id` integer,
	`resolved_by` text,
	`status` text NOT NULL,
	`project` text NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now')),
	`updated_at` integer DEFAULT (strftime('%s', 'now')),
	FOREIGN KEY (`slack_id`) REFERENCES `slack_messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`github_id`) REFERENCES `github_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `github_items` (
	`id` integer PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`user` text NOT NULL,
	`state` text NOT NULL,
	`participants` blob NOT NULL,
	`comments` blob NOT NULL,
	`node_id` text NOT NULL,
	`database_id` integer NOT NULL,
	`repository` text NOT NULL,
	`owner` text NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now')),
	`updated_at` integer DEFAULT (strftime('%s', 'now'))
);
--> statement-breakpoint
CREATE TABLE `slack_messages` (
	`id` integer PRIMARY KEY NOT NULL,
	`user` text NOT NULL,
	`channel` text NOT NULL,
	`text` text NOT NULL,
	`ts` text NOT NULL,
	`participants` text NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now')),
	`updated_at` integer DEFAULT (strftime('%s', 'now'))
);
