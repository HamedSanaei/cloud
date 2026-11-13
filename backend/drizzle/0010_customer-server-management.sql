CREATE TABLE "server_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"operation_id" uuid,
	"kind" varchar(20) NOT NULL,
	"encrypted" text,
	"expires_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "termination_state" varchar(30);--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "termination_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "server_secrets" ADD CONSTRAINT "server_secrets_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_secrets" ADD CONSTRAINT "server_secrets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_secrets" ADD CONSTRAINT "server_secrets_operation_id_provider_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."provider_operations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "server_secrets_operation_idx" ON "server_secrets" USING btree ("operation_id") WHERE "server_secrets"."operation_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "server_secrets_expiry_idx" ON "server_secrets" USING btree ("expires_at");