ALTER TABLE "provider_products" ALTER COLUMN "enabled" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "product_sync_runs" ADD COLUMN "combinations_seen" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "product_sync_runs" ADD COLUMN "monthly_eligible" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "product_sync_runs" ADD COLUMN "missing_price" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "product_sync_runs" ADD COLUMN "missing_billing_options" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "product_sync_runs" ADD COLUMN "http_errors" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_products" ADD COLUMN "monthly_eligible" boolean DEFAULT false NOT NULL;