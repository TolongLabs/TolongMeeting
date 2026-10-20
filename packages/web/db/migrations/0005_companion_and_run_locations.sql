CREATE TABLE "companion_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"member_id" uuid NOT NULL,
	"device_id" uuid,
	"command" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companion_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" uuid NOT NULL,
	"occurrence_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"payload" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"device_id" uuid,
	"target_device_id" uuid,
	"lease_until" timestamp with time zone,
	"pc_ping_sent_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "companion_jobs_kind_check" CHECK ("companion_jobs"."kind" in ('native_transcription', 'local_run')),
	CONSTRAINT "companion_jobs_state_check" CHECK ("companion_jobs"."state" in ('pending', 'claimed', 'done', 'failed', 'cancelled')),
	CONSTRAINT "companion_jobs_attempts_check" CHECK ("companion_jobs"."attempts" >= 0),
	CONSTRAINT "companion_jobs_local_run_target_check" CHECK ("companion_jobs"."kind" <> 'local_run' or "companion_jobs"."target_device_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "device_pairings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_pairings_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "home_exit_nodes" (
	"member_id" uuid PRIMARY KEY NOT NULL,
	"node_id" text NOT NULL,
	"hostname" text NOT NULL,
	"ipv4" text NOT NULL,
	"checked_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "identities" ADD COLUMN "local_device_id" uuid;--> statement-breakpoint
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_id_member_id_unique" UNIQUE("id","member_id");--> statement-breakpoint
ALTER TABLE "companion_events" ADD CONSTRAINT "companion_events_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion_events" ADD CONSTRAINT "companion_events_device_id_device_tokens_id_fk" FOREIGN KEY ("device_id","member_id") REFERENCES "public"."device_tokens"("id","member_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion_jobs" ADD CONSTRAINT "companion_jobs_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion_jobs" ADD CONSTRAINT "companion_jobs_occurrence_id_occurrences_id_fk" FOREIGN KEY ("occurrence_id","member_id") REFERENCES "public"."occurrences"("id","member_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion_jobs" ADD CONSTRAINT "companion_jobs_device_id_device_tokens_id_fk" FOREIGN KEY ("device_id","member_id") REFERENCES "public"."device_tokens"("id","member_id") ON DELETE set null ("device_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion_jobs" ADD CONSTRAINT "companion_jobs_target_device_id_device_tokens_id_fk" FOREIGN KEY ("target_device_id","member_id") REFERENCES "public"."device_tokens"("id","member_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_pairings" ADD CONSTRAINT "device_pairings_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "home_exit_nodes" ADD CONSTRAINT "home_exit_nodes_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "companion_events_member_id_id_idx" ON "companion_events" USING btree ("member_id","id");--> statement-breakpoint
CREATE INDEX "companion_events_member_id_created_at_idx" ON "companion_events" USING btree ("member_id","created_at");--> statement-breakpoint
CREATE INDEX "companion_events_device_id_idx" ON "companion_events" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "companion_jobs_member_id_state_idx" ON "companion_jobs" USING btree ("member_id","state");--> statement-breakpoint
CREATE INDEX "companion_jobs_occurrence_id_idx" ON "companion_jobs" USING btree ("occurrence_id");--> statement-breakpoint
CREATE INDEX "companion_jobs_device_id_idx" ON "companion_jobs" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "companion_jobs_target_device_id_idx" ON "companion_jobs" USING btree ("target_device_id");--> statement-breakpoint
CREATE INDEX "companion_jobs_lease_until_idx" ON "companion_jobs" USING btree ("lease_until") WHERE "companion_jobs"."state" = 'claimed';--> statement-breakpoint
CREATE INDEX "device_pairings_member_id_idx" ON "device_pairings" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "device_pairings_expires_at_idx" ON "device_pairings" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "identities" ADD CONSTRAINT "identities_local_device_id_device_tokens_id_fk" FOREIGN KEY ("local_device_id","member_id") REFERENCES "public"."device_tokens"("id","member_id") ON DELETE set null ("local_device_id") ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "identities_local_device_id_idx" ON "identities" USING btree ("local_device_id");--> statement-breakpoint
ALTER TABLE "identities" ADD CONSTRAINT "identities_local_device_id_check" CHECK ("identities"."local_device_id" is null or "identities"."run_location" = 'local');