-- Write migration SQL here.
CREATE TABLE `suplex_oauth_clients` (
  `id` text PRIMARY KEY NOT NULL,
  `client_name` text NOT NULL,
  `redirect_uris_json` text NOT NULL,
  `grant_types_json` text NOT NULL,
  `response_types_json` text NOT NULL,
  `token_endpoint_auth_method` text NOT NULL DEFAULT 'none',
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  CONSTRAINT `suplex_oauth_clients_auth_method_check` CHECK (`token_endpoint_auth_method` = 'none')
);
--> statement-breakpoint
CREATE TABLE `suplex_oauth_pending_authorizations` (
  `id` text PRIMARY KEY NOT NULL,
  `client_id` text NOT NULL,
  `redirect_uri` text NOT NULL,
  `state` text,
  `scope` text NOT NULL,
  `resource` text NOT NULL,
  `code_challenge` text NOT NULL,
  `code_challenge_method` text NOT NULL,
  `expires_at` text NOT NULL,
  `consumed_at` text,
  `created_at` text NOT NULL,
  CONSTRAINT `suplex_oauth_pending_authorizations_method_check` CHECK (`code_challenge_method` = 'S256'),
  FOREIGN KEY (`client_id`) REFERENCES `suplex_oauth_clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `suplex_oauth_pending_authorizations_expiry_idx` ON `suplex_oauth_pending_authorizations` (`expires_at`);
--> statement-breakpoint
CREATE TABLE `suplex_oauth_grants` (
  `id` text PRIMARY KEY NOT NULL,
  `client_id` text NOT NULL,
  `user_id` text NOT NULL,
  `company_id` text NOT NULL,
  `agent_id` text NOT NULL,
  `scope` text NOT NULL,
  `resource` text NOT NULL,
  `cursor_key` text NOT NULL,
  `revoked_at` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  CONSTRAINT `suplex_oauth_grants_identity_unique` UNIQUE(`client_id`, `user_id`, `company_id`),
  CONSTRAINT `suplex_oauth_grants_cursor_key_unique` UNIQUE(`cursor_key`),
  FOREIGN KEY (`client_id`) REFERENCES `suplex_oauth_clients`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`user_id`) REFERENCES `suplex_users`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`company_id`) REFERENCES `suplex_companies`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`agent_id`, `company_id`) REFERENCES `suplex_external_agents`(`id`, `company_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `suplex_oauth_authorization_codes` (
  `id` text PRIMARY KEY NOT NULL,
  `grant_id` text NOT NULL,
  `code_hash` text NOT NULL,
  `redirect_uri` text NOT NULL,
  `resource` text NOT NULL,
  `code_challenge` text NOT NULL,
  `expires_at` text NOT NULL,
  `consumed_at` text,
  `created_at` text NOT NULL,
  CONSTRAINT `suplex_oauth_authorization_codes_hash_unique` UNIQUE(`code_hash`),
  FOREIGN KEY (`grant_id`) REFERENCES `suplex_oauth_grants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `suplex_oauth_authorization_codes_expiry_idx` ON `suplex_oauth_authorization_codes` (`expires_at`);
--> statement-breakpoint
CREATE TABLE `suplex_oauth_token_families` (
  `id` text PRIMARY KEY NOT NULL,
  `grant_id` text NOT NULL,
  `client_id` text NOT NULL,
  `resource` text NOT NULL,
  `revoked_at` text,
  `reuse_detected_at` text,
  `created_at` text NOT NULL,
  FOREIGN KEY (`grant_id`) REFERENCES `suplex_oauth_grants`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`client_id`) REFERENCES `suplex_oauth_clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `suplex_oauth_access_tokens` (
  `id` text PRIMARY KEY NOT NULL,
  `family_id` text NOT NULL,
  `token_hash` text NOT NULL,
  `expires_at` text NOT NULL,
  `revoked_at` text,
  `last_used_at` text,
  `created_at` text NOT NULL,
  CONSTRAINT `suplex_oauth_access_tokens_hash_unique` UNIQUE(`token_hash`),
  FOREIGN KEY (`family_id`) REFERENCES `suplex_oauth_token_families`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `suplex_oauth_access_tokens_expiry_idx` ON `suplex_oauth_access_tokens` (`expires_at`);
--> statement-breakpoint
CREATE TABLE `suplex_oauth_refresh_tokens` (
  `id` text PRIMARY KEY NOT NULL,
  `family_id` text NOT NULL,
  `token_hash` text NOT NULL,
  `generation` integer NOT NULL,
  `expires_at` text NOT NULL,
  `consumed_at` text,
  `created_at` text NOT NULL,
  CONSTRAINT `suplex_oauth_refresh_tokens_hash_unique` UNIQUE(`token_hash`),
  CONSTRAINT `suplex_oauth_refresh_tokens_generation_unique` UNIQUE(`family_id`, `generation`),
  FOREIGN KEY (`family_id`) REFERENCES `suplex_oauth_token_families`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `suplex_oauth_refresh_tokens_expiry_idx` ON `suplex_oauth_refresh_tokens` (`expires_at`);
