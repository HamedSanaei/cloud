CREATE TYPE "public"."billing_interval" AS ENUM('MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('draft', 'open', 'paid', 'void', 'refunded', 'overdue');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('draft', 'quoted', 'awaiting_payment', 'paid', 'queued', 'provisioning', 'active', 'failed', 'cancelled', 'requires_review', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."provider_mode" AS ENUM('mock', 'live');--> statement-breakpoint
CREATE TYPE "public"."provider_op_status" AS ENUM('pending', 'running', 'succeeded', 'failed', 'unknown', 'needs_reconciliation');--> statement-breakpoint
CREATE TYPE "public"."quote_status" AS ENUM('valid', 'accepted', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."server_status" AS ENUM('provisioning', 'active', 'suspended', 'terminated', 'failed');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('active', 'grace', 'suspended', 'cancelled', 'expired');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('user', 'admin');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'pending', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."wallet_tx_type" AS ENUM('deposit', 'purchase', 'renewal', 'refund', 'manual_credit', 'manual_debit', 'adjustment');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_logs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"actor_id" uuid,
	"action" varchar(100) NOT NULL,
	"target_type" varchar(50),
	"target_id" uuid,
	"metadata" jsonb,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "charge_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"number" varchar(40) NOT NULL,
	"amount_rial" bigint NOT NULL,
	"status" varchar(30) DEFAULT 'pending' NOT NULL,
	"invoice_number" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fx_rates" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "fx_rates_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"from_currency" varchar(8) DEFAULT 'EUR' NOT NULL,
	"to_currency" varchar(8) DEFAULT 'IRR' NOT NULL,
	"rate" numeric(20, 6) NOT NULL,
	"set_by" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" varchar(100) NOT NULL,
	"key" varchar(200) NOT NULL,
	"response_status" integer NOT NULL,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"description" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_amount_rial" bigint NOT NULL,
	"total_rial" bigint NOT NULL,
	"reference_type" varchar(50),
	"reference_id" uuid
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_number" varchar(40) NOT NULL,
	"user_id" uuid NOT NULL,
	"order_id" uuid,
	"subscription_id" uuid,
	"status" "invoice_status" DEFAULT 'draft' NOT NULL,
	"subtotal_rial" bigint NOT NULL,
	"tax_rial" bigint NOT NULL,
	"discount_rial" bigint DEFAULT 0 NOT NULL,
	"total_rial" bigint NOT NULL,
	"currency" varchar(8) DEFAULT 'IRR' NOT NULL,
	"description" text,
	"snapshot" jsonb,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"type" varchar(30) DEFAULT 'info' NOT NULL,
	"read" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "order_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"order_id" uuid NOT NULL,
	"from_status" "order_status",
	"to_status" "order_status" NOT NULL,
	"actor_id" uuid,
	"reason" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"kind" varchar(30) DEFAULT 'vps' NOT NULL,
	"description" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_amount_rial" bigint NOT NULL,
	"total_rial" bigint NOT NULL,
	"provider_ref" text,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_number" varchar(40) NOT NULL,
	"user_id" uuid NOT NULL,
	"wallet_id" uuid,
	"quote_id" uuid,
	"status" "order_status" DEFAULT 'draft' NOT NULL,
	"total_rial" bigint NOT NULL,
	"currency" varchar(8) DEFAULT 'IRR' NOT NULL,
	"billing_interval" "billing_interval" DEFAULT 'MONTHLY' NOT NULL,
	"provider" varchar(50) NOT NULL,
	"provider_product_id" varchar(100) NOT NULL,
	"provider_location" varchar(20) NOT NULL,
	"hostname" text NOT NULL,
	"operating_system" text NOT NULL,
	"billing_option" jsonb,
	"idempotency_key" text,
	"paid_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pricing_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" varchar(50) DEFAULT 'leaseweb' NOT NULL,
	"markup_percent" numeric(10, 4) DEFAULT '25' NOT NULL,
	"markup_fixed_rial" bigint DEFAULT 0 NOT NULL,
	"tax_percent" numeric(8, 4) DEFAULT '0' NOT NULL,
	"rounding_to_rial" bigint DEFAULT 1000 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" varchar(50) NOT NULL,
	"mode" "provider_mode" NOT NULL,
	"status" varchar(20) DEFAULT 'running' NOT NULL,
	"products_seen" integer DEFAULT 0 NOT NULL,
	"locations_seen" integer DEFAULT 0 NOT NULL,
	"error" text,
	"raw" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "provider_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" varchar(50) NOT NULL,
	"code" varchar(20) NOT NULL,
	"country" text,
	"city" text,
	"available" boolean DEFAULT true NOT NULL,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" varchar(50) NOT NULL,
	"kind" varchar(30) NOT NULL,
	"action" varchar(50),
	"reference_type" varchar(30) NOT NULL,
	"reference_id" uuid NOT NULL,
	"business_key" varchar(200) NOT NULL,
	"status" "provider_op_status" DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"request_metadata" jsonb,
	"response_metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "provider_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" varchar(50) NOT NULL,
	"provider_product_id" varchar(100) NOT NULL,
	"location_id" uuid,
	"name" text NOT NULL,
	"category" varchar(30) DEFAULT 'vps' NOT NULL,
	"vcpu" integer NOT NULL,
	"memory_mb" integer NOT NULL,
	"disk_gb" integer NOT NULL,
	"traffic_gb" integer,
	"ipv4_count" integer DEFAULT 1 NOT NULL,
	"ipv6_available" boolean DEFAULT true NOT NULL,
	"billing_options" jsonb,
	"operating_systems" jsonb,
	"service_levels" jsonb,
	"configurable_options" jsonb,
	"provider_currency" varchar(8) DEFAULT 'EUR' NOT NULL,
	"provider_price_cents" bigint,
	"available" boolean DEFAULT true NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"raw" jsonb,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "providers" (
	"id" varchar(50) PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"mode" "provider_mode" DEFAULT 'mock' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"health_status" text,
	"last_sync_at" timestamp with time zone,
	"capabilities" jsonb,
	"config" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"product_id" uuid,
	"location_id" uuid,
	"provider" varchar(50) NOT NULL,
	"provider_product_id" varchar(100) NOT NULL,
	"provider_currency" varchar(8) NOT NULL,
	"provider_amount_cents" bigint NOT NULL,
	"fx_rate" numeric(20, 6) NOT NULL,
	"markup_percent" numeric(10, 4) NOT NULL,
	"markup_fixed_rial" bigint NOT NULL,
	"tax_percent" numeric(8, 4) NOT NULL,
	"subtotal_rial" bigint NOT NULL,
	"tax_rial" bigint NOT NULL,
	"total_rial" bigint NOT NULL,
	"currency" varchar(8) DEFAULT 'IRR' NOT NULL,
	"billing_interval" "billing_interval" DEFAULT 'MONTHLY' NOT NULL,
	"billing_option" jsonb,
	"operating_system" text,
	"service_level" jsonb,
	"status" "quote_status" DEFAULT 'valid' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "renewal_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"invoice_id" uuid,
	"status" varchar(30) NOT NULL,
	"amount_rial" bigint NOT NULL,
	"error" text,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"subscription_id" uuid,
	"provider" varchar(50) NOT NULL,
	"provider_server_id" text,
	"provider_order_id" text,
	"provider_product_id" varchar(100) NOT NULL,
	"provider_location" varchar(20) NOT NULL,
	"hostname" text NOT NULL,
	"status" "server_status" DEFAULT 'provisioning' NOT NULL,
	"operating_system" text NOT NULL,
	"ipv4" text,
	"ipv6" text,
	"vcpu" integer NOT NULL,
	"memory_mb" integer NOT NULL,
	"disk_gb" integer NOT NULL,
	"traffic_limit_gb" integer,
	"traffic_used_gb" integer DEFAULT 0 NOT NULL,
	"provider_metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"terminated_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"user_agent" text,
	"ip" text,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" varchar(100) PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "subscription_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"subscription_id" uuid NOT NULL,
	"event" varchar(50) NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"server_id" uuid,
	"order_id" uuid,
	"billing_interval" "billing_interval" DEFAULT 'MONTHLY' NOT NULL,
	"price_rial" bigint NOT NULL,
	"currency" varchar(8) DEFAULT 'IRR' NOT NULL,
	"auto_renew" boolean DEFAULT true NOT NULL,
	"status" "subscription_status" DEFAULT 'active' NOT NULL,
	"current_period_start" timestamp with time zone DEFAULT now() NOT NULL,
	"current_period_end" timestamp with time zone NOT NULL,
	"next_invoice_at" timestamp with time zone NOT NULL,
	"next_due_at" timestamp with time zone NOT NULL,
	"grace_until" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"department" varchar(30) DEFAULT 'technical' NOT NULL,
	"description" text,
	"status" varchar(30) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"mobile" text,
	"national_code" text,
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"email_verified_at" timestamp with time zone,
	"timezone" text DEFAULT 'Asia/Tehran',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"amount_rial" bigint NOT NULL,
	"type" "wallet_tx_type" NOT NULL,
	"reference_type" varchar(50),
	"reference_id" uuid,
	"idempotency_key" text,
	"balance_before_rial" bigint NOT NULL,
	"balance_after_rial" bigint NOT NULL,
	"description" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"currency" text DEFAULT 'IRR' NOT NULL,
	"balance_rial" bigint DEFAULT 0 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charge_requests" ADD CONSTRAINT "charge_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fx_rates" ADD CONSTRAINT "fx_rates_set_by_users_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_rules" ADD CONSTRAINT "pricing_rules_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_locations" ADD CONSTRAINT "provider_locations_provider_providers_id_fk" FOREIGN KEY ("provider") REFERENCES "public"."providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_products" ADD CONSTRAINT "provider_products_provider_providers_id_fk" FOREIGN KEY ("provider") REFERENCES "public"."providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_products" ADD CONSTRAINT "provider_products_location_id_provider_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."provider_locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_product_id_provider_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."provider_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_location_id_provider_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."provider_locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renewal_attempts" ADD CONSTRAINT "renewal_attempts_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renewal_attempts" ADD CONSTRAINT "renewal_attempts_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_action_created_idx" ON "audit_logs" USING btree ("action","created_at");--> statement-breakpoint
CREATE INDEX "audit_actor_idx" ON "audit_logs" USING btree ("actor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "charge_requests_number_idx" ON "charge_requests" USING btree ("number");--> statement-breakpoint
CREATE INDEX "charge_requests_user_idx" ON "charge_requests" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "fx_pair_created_idx" ON "fx_rates" USING btree ("from_currency","to_currency","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_keys_scope_key_idx" ON "idempotency_keys" USING btree ("scope","key");--> statement-breakpoint
CREATE INDEX "invoice_items_invoice_idx" ON "invoice_items" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_number_idx" ON "invoices" USING btree ("invoice_number");--> statement-breakpoint
CREATE INDEX "invoices_user_idx" ON "invoices" USING btree ("user_id","issued_at");--> statement-breakpoint
CREATE INDEX "invoices_status_idx" ON "invoices" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "order_events_order_idx" ON "order_events" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE INDEX "order_items_order_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_number_idx" ON "orders" USING btree ("order_number");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_idempotency_idx" ON "orders" USING btree ("idempotency_key") WHERE "orders"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "orders_user_idx" ON "orders" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "orders_status_idx" ON "orders" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "pricing_rules_provider_idx" ON "pricing_rules" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "product_sync_runs_provider_idx" ON "product_sync_runs" USING btree ("provider","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_locations_code_idx" ON "provider_locations" USING btree ("provider","code");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_ops_business_key_idx" ON "provider_operations" USING btree ("business_key");--> statement-breakpoint
CREATE INDEX "provider_ops_ref_idx" ON "provider_operations" USING btree ("reference_type","reference_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_products_uniq_idx" ON "provider_products" USING btree ("provider","provider_product_id","location_id");--> statement-breakpoint
CREATE INDEX "provider_products_cat_idx" ON "provider_products" USING btree ("provider","category","available","enabled");--> statement-breakpoint
CREATE INDEX "quotes_user_status_idx" ON "quotes" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "quotes_expiry_idx" ON "quotes" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "renewal_attempts_sub_idx" ON "renewal_attempts" USING btree ("subscription_id","attempted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "servers_order_idx" ON "servers" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "servers_provider_server_idx" ON "servers" USING btree ("provider","provider_server_id") WHERE "servers"."provider_server_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "servers_user_idx" ON "servers" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "servers_provider_idx" ON "servers" USING btree ("provider","status");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_idx" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "subscription_events_sub_idx" ON "subscription_events" USING btree ("subscription_id","created_at");--> statement-breakpoint
CREATE INDEX "subscriptions_due_idx" ON "subscriptions" USING btree ("status","next_due_at");--> statement-breakpoint
CREATE INDEX "subscriptions_user_idx" ON "subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "tickets_user_idx" ON "tickets" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_idx" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "users_role_idx" ON "users" USING btree ("role");--> statement-breakpoint
CREATE INDEX "wallet_tx_wallet_idx" ON "wallet_transactions" USING btree ("wallet_id","created_at");--> statement-breakpoint
CREATE INDEX "wallet_tx_user_idx" ON "wallet_transactions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_tx_idempotency_idx" ON "wallet_transactions" USING btree ("wallet_id","idempotency_key") WHERE "wallet_transactions"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "wallets_user_idx" ON "wallets" USING btree ("user_id");