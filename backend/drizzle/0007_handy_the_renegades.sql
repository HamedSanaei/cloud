CREATE TABLE "hetzner_inventory" (
	"provider_server_id" varchar(128) PRIMARY KEY NOT NULL,
	"account_id" varchar(63) NOT NULL,
	"name" text NOT NULL,
	"status" varchar(30) NOT NULL,
	"ipv4" text,
	"ipv6" text,
	"vcpu" integer,
	"memory_mb" integer,
	"disk_gb" integer,
	"location" text,
	"server_type" text,
	"operating_system" text,
	"created_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone NOT NULL,
	"present" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE INDEX "hetzner_inventory_account_idx" ON "hetzner_inventory" USING btree ("account_id","present");