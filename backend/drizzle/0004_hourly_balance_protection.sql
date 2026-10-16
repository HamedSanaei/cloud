ALTER TABLE "servers" ADD COLUMN "billing_power_blocked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "billing_power_blocked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "low_balance_warned_at" timestamp with time zone;