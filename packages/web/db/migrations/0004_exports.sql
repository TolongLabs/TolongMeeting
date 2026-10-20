CREATE TABLE "exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurrence_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"target" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"title" text,
	"url" text,
	"file_path" text,
	"note" text,
	"error_code" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "exports_target_check" CHECK ("exports"."target" in ('zip', 'pdf', 'github', 'gdocs', 'notion')),
	CONSTRAINT "exports_status_check" CHECK ("exports"."status" in ('queued', 'running', 'succeeded', 'failed')),
	CONSTRAINT "exports_error_code_check" CHECK ("exports"."error_code" in ('not_connected', 'reconnect_needed', 'invalid_settings', 'not_found', 'already_running', 'not_ready', 'meeting_deleted', 'rate_limited', 'interrupted', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "status" text DEFAULT 'ok' NOT NULL;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_occurrence_id_occurrences_id_fk" FOREIGN KEY ("occurrence_id","member_id") REFERENCES "public"."occurrences"("id","member_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "exports_member_id_idx" ON "exports" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "exports_occurrence_id_created_at_idx" ON "exports" USING btree ("occurrence_id","created_at");--> statement-breakpoint
CREATE INDEX "exports_status_created_at_idx" ON "exports" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "exports_one_active_idx" ON "exports" USING btree ("occurrence_id","target") WHERE "exports"."status" in ('queued', 'running');--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_status_check" CHECK ("connections"."status" in ('ok', 'reconnect_needed'));