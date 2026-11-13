ALTER TABLE "notifications" ADD COLUMN "event_key" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "href" text;--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_user_event_idx" ON "notifications" USING btree ("user_id","event_key");