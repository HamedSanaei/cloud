CREATE TABLE "wallet_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"wallet_id" uuid NOT NULL,
	"charge_request_id" uuid NOT NULL,
	"idempotency_key" varchar(200) NOT NULL,
	"amount_rial" bigint NOT NULL,
	"status" varchar(20) DEFAULT 'creating' NOT NULL,
	"sandbox" boolean NOT NULL,
	"merchant_fingerprint" varchar(64) NOT NULL,
	"gateway_token" uuid,
	"provider_reference" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "server_id" uuid;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "server_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "wallet_payments" ADD CONSTRAINT "wallet_payments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_payments" ADD CONSTRAINT "wallet_payments_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_payments" ADD CONSTRAINT "wallet_payments_charge_request_id_charge_requests_id_fk" FOREIGN KEY ("charge_request_id") REFERENCES "public"."charge_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_payments_user_key_idx" ON "wallet_payments" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_payments_token_idx" ON "wallet_payments" USING btree ("gateway_token");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_payments_reference_idx" ON "wallet_payments" USING btree ("provider_reference");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_payments_charge_idx" ON "wallet_payments" USING btree ("charge_request_id");--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE set null ON UPDATE no action;