CREATE TABLE "platform_links" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"platform_user_id" uuid NOT NULL,
	"token_encrypted" text NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_links_platform_user_id_unique" UNIQUE("platform_user_id")
);
--> statement-breakpoint
ALTER TABLE "platform_links" ADD CONSTRAINT "platform_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;