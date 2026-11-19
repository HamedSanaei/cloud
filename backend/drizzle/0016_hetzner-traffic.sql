ALTER TYPE "public"."wallet_tx_type" ADD VALUE IF NOT EXISTS 'traffic_overage' BEFORE 'refund';
--> statement-breakpoint
CREATE TABLE "hetzner_traffic_periods" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "server_id" uuid NOT NULL CONSTRAINT "hetzner_traffic_periods_server_id_servers_id_fk" REFERENCES "servers"("id") ON DELETE RESTRICT,
  "subscription_id" uuid NOT NULL CONSTRAINT "hetzner_traffic_periods_subscription_id_subscriptions_id_fk" REFERENCES "subscriptions"("id") ON DELETE RESTRICT,
  "month" varchar(7) NOT NULL,
  "provider_server_id" text NOT NULL,
  "server_type" text NOT NULL,
  "location" text NOT NULL,
  "previous_outgoing_bytes" bigint NOT NULL,
  "outgoing_bytes" bigint NOT NULL,
  "included_bytes" bigint NOT NULL,
  "excluded_blocks" bigint DEFAULT 0 NOT NULL,
  "paid_blocks" bigint DEFAULT 0 NOT NULL,
  "observed_at" timestamp with time zone NOT NULL,
  "settled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "hetzner_traffic_server_month_idx" ON "hetzner_traffic_periods" ("server_id", "month");
--> statement-breakpoint
INSERT INTO "settings" ("key", "value") VALUES ('billing.hetzner_traffic_cutover', 'true'::jsonb) ON CONFLICT DO NOTHING;
