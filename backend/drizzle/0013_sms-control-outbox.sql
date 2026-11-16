CREATE TABLE "service_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"opened_by" uuid NOT NULL,
	"note" text NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sms_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" text NOT NULL,
	"key" varchar(64) NOT NULL,
	"user_id" uuid NOT NULL,
	"recipient_hash" text NOT NULL,
	"masked_recipient" text NOT NULL,
	"values" jsonb NOT NULL,
	"status" varchar(40) NOT NULL,
	"segments" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempted_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sms_preferences" (
	"key" varchar(64) PRIMARY KEY NOT NULL,
	"enabled" boolean NOT NULL,
	"approval" varchar(32) NOT NULL,
	"pattern_hash" text NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_replies_request_id_unique" UNIQUE("request_id")
);
--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "pricing_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "service_incidents" ADD CONSTRAINT "service_incidents_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_incidents" ADD CONSTRAINT "service_incidents_opened_by_users_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_outbox" ADD CONSTRAINT "sms_outbox_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_replies" ADD CONSTRAINT "ticket_replies_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_replies" ADD CONSTRAINT "ticket_replies_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "service_incidents_open" ON "service_incidents" USING btree ("server_id") WHERE "service_incidents"."resolved_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "sms_outbox_event_recipient" ON "sms_outbox" USING btree ("event_id","key","user_id");--> statement-breakpoint
CREATE INDEX "sms_outbox_pending" ON "sms_outbox" USING btree ("status","created_at");