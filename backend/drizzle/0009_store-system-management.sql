CREATE TABLE "admin_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid NOT NULL,
	"approved_by" uuid,
	"user_id" uuid NOT NULL,
	"wallet_id" uuid NOT NULL,
	"key" varchar(200) NOT NULL,
	"direction" varchar(6) NOT NULL,
	"amount_rial" bigint NOT NULL,
	"reason" text NOT NULL,
	"reference" varchar(120) NOT NULL,
	"status" varchar(20) DEFAULT 'awaiting_approval' NOT NULL,
	"before_rial" bigint,
	"after_rial" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "admin_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"action" varchar(60) NOT NULL,
	"payload_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "gateway_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"encrypted" text NOT NULL,
	"suffix" varchar(4) NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"level" varchar(10) NOT NULL,
	"service" varchar(40) NOT NULL,
	"event" varchar(100) NOT NULL,
	"request_id" varchar(100),
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_adjustments" ADD CONSTRAINT "admin_adjustments_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_adjustments" ADD CONSTRAINT "admin_adjustments_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_adjustments" ADD CONSTRAINT "admin_adjustments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_adjustments" ADD CONSTRAINT "admin_adjustments_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_authorizations" ADD CONSTRAINT "admin_authorizations_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_authorizations" ADD CONSTRAINT "admin_authorizations_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_credentials" ADD CONSTRAINT "gateway_credentials_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_adjustments_actor_key_idx" ON "admin_adjustments" USING btree ("actor_id","key");--> statement-breakpoint
CREATE INDEX "admin_adjustments_wallet_idx" ON "admin_adjustments" USING btree ("wallet_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_credentials_fingerprint_idx" ON "gateway_credentials" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "system_events_created_idx" ON "system_events" USING btree ("created_at");