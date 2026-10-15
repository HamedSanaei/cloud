ALTER TYPE "billing_interval" ADD VALUE IF NOT EXISTS 'HOURLY';
--> statement-breakpoint
ALTER TYPE "billing_interval" ADD VALUE IF NOT EXISTS 'DAILY';
--> statement-breakpoint
ALTER TABLE "quotes" ALTER COLUMN "provider_amount_cents" TYPE numeric(20, 6) USING "provider_amount_cents"::numeric;
