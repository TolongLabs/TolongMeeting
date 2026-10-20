CREATE TABLE "ai_keys" (
	"member_id" uuid PRIMARY KEY NOT NULL,
	"dashscope_key_enc" text NOT NULL,
	"workspace_id" text,
	"modelscope_key_enc" text,
	"test_ok" boolean DEFAULT false NOT NULL,
	"test_error" text,
	"tested_at" timestamp with time zone,
	"modelscope_test_ok" boolean,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artefacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurrence_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"path" text NOT NULL,
	"bytes" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artefacts_occurrence_id_path_unique" UNIQUE("occurrence_id","path"),
	CONSTRAINT "artefacts_kind_check" CHECK ("artefacts"."kind" in ('recording', 'summary', 'transcript', 'slides', 'slides_json', 'slide_image', 'chat', 'form_screenshot'))
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"token_enc" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connections_member_id_kind_unique" UNIQUE("member_id","kind"),
	CONSTRAINT "connections_kind_check" CHECK ("connections"."kind" in ('google', 'github', 'notion'))
);
--> statement-breakpoint
CREATE TABLE "details" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"labels" text[] DEFAULT '{}' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "details_member_id_key_unique" UNIQUE("member_id","key")
);
--> statement-breakpoint
CREATE TABLE "device_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "device_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"occurrence_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"type" text NOT NULL,
	"data" jsonb NOT NULL,
	"data_hash" text NOT NULL,
	CONSTRAINT "events_occurrence_id_attempt_at_type_data_hash_unique" UNIQUE("occurrence_id","attempt","at","type","data_hash"),
	CONSTRAINT "events_type_check" CHECK ("events"."type" in ('state', 'joined', 'notice_dismissed', 'form', 'alert', 'error', 'keyframe', 'recording_gap', 'mention', 'deletion'))
);
--> statement-breakpoint
CREATE TABLE "forms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurrence_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"form_key" text NOT NULL,
	"url" text NOT NULL,
	"final_url" text,
	"provider" text,
	"source" text NOT NULL,
	"sender" text,
	"sender_role" text,
	"trust_reason" text,
	"state" text NOT NULL,
	"seen_at" timestamp with time zone NOT NULL,
	"submitted_at" timestamp with time zone,
	"fields_filled" text[] DEFAULT '{}' NOT NULL,
	"result" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forms_occurrence_id_form_key_unique" UNIQUE("occurrence_id","form_key"),
	CONSTRAINT "forms_source_check" CHECK ("forms"."source" in ('qr', 'meeting_chat', 'watched_chat')),
	CONSTRAINT "forms_state_check" CHECK ("forms"."state" in ('detected', 'resolving', 'checking_trust', 'untrusted', 'opening', 'awaiting_signin', 'inspecting', 'not_attendance', 'quiz', 'filling', 'needs_member', 'submitting', 'submitted', 'already_answered', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" uuid NOT NULL,
	"name" text NOT NULL,
	"run_location" text DEFAULT 'server' NOT NULL,
	"zoom_guest_name" text NOT NULL,
	"org_name" text,
	"org_email_domain" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identities_member_id_name_unique" UNIQUE("member_id","name"),
	CONSTRAINT "identities_run_location_check" CHECK ("identities"."run_location" in ('server', 'server_via_home', 'local'))
);
--> statement-breakpoint
CREATE TABLE "members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"github_login" text NOT NULL,
	"github_id" bigint,
	"auth_user_id" text,
	"display_name" text NOT NULL,
	"time_zone" text DEFAULT 'Asia/Kuala_Lumpur' NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"ntfy_topic" text,
	"ntfy_token_enc" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "members_github_login_unique" UNIQUE("github_login"),
	CONSTRAINT "members_github_id_unique" UNIQUE("github_id"),
	CONSTRAINT "members_auth_user_id_unique" UNIQUE("auth_user_id"),
	CONSTRAINT "members_ntfy_topic_unique" UNIQUE("ntfy_topic"),
	CONSTRAINT "members_github_login_lower" CHECK ("members"."github_login" = lower("members"."github_login")),
	CONSTRAINT "members_role_check" CHECK ("members"."role" in ('member', 'admin'))
);
--> statement-breakpoint
CREATE TABLE "mention_names" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" uuid NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" uuid NOT NULL,
	"entry_id" uuid,
	"identity_id" uuid NOT NULL,
	"entry_name" text NOT NULL,
	"entry_type" text NOT NULL,
	"transcription" text NOT NULL,
	"scheduled_start" timestamp with time zone NOT NULL,
	"scheduled_end" timestamp with time zone NOT NULL,
	"actual_start" timestamp with time zone,
	"actual_end" timestamp with time zone,
	"state" text DEFAULT 'scheduled' NOT NULL,
	"state_reason" text,
	"attempt" integer DEFAULT 0 NOT NULL,
	"restarts" integer DEFAULT 0 NOT NULL,
	"entry_snapshot" jsonb,
	"link_used" text,
	"pasted_link" text,
	"container_name" text,
	"control_token_hash" text,
	"last_heartbeat_at" timestamp with time zone,
	"recording" boolean DEFAULT false NOT NULL,
	"participants" integer,
	"pending_commands" text[] DEFAULT '{}' NOT NULL,
	"delete_after" timestamp with time zone NOT NULL,
	"deletion_warned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "occurrences_entry_id_scheduled_start_unique" UNIQUE("entry_id","scheduled_start"),
	CONSTRAINT "occurrences_state_check" CHECK ("occurrences"."state" in ('scheduled', 'starting', 'verifying_accounts', 'waiting_for_signin', 'watching_for_link', 'no_link', 'joining', 'in_lobby', 'denied', 'in_meeting', 'restarting', 'left_by_member', 'leaving', 'uploading', 'transcribing', 'waiting_for_pc', 'post_processing', 'completed', 'skipped_capacity', 'skipped_identity_clash', 'skipped_pc_offline', 'failed', 'deleted'))
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"identity_id" uuid PRIMARY KEY NOT NULL,
	"member_id" uuid NOT NULL,
	"location" text DEFAULT 'server' NOT NULL,
	"latest_checkpoint" text,
	"checkpoint_at" timestamp with time zone,
	"account_status" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"held_by" text,
	"held_since" timestamp with time zone,
	CONSTRAINT "profiles_location_check" CHECK ("profiles"."location" in ('server', 'local'))
);
--> statement-breakpoint
CREATE TABLE "signin_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" uuid NOT NULL,
	"identity_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"occurrence_id" uuid,
	"upstream" text,
	"control_token_hash" text,
	"state" text DEFAULT 'starting' NOT NULL,
	"done_requested" boolean DEFAULT false NOT NULL,
	"last_heartbeat_at" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	CONSTRAINT "signin_sessions_mode_check" CHECK ("signin_sessions"."mode" in ('worker', 'container')),
	CONSTRAINT "signin_sessions_state_check" CHECK ("signin_sessions"."state" in ('starting', 'ready', 'ended'))
);
--> statement-breakpoint
CREATE TABLE "timetable_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" uuid NOT NULL,
	"identity_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"repeat" jsonb NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"link" jsonb NOT NULL,
	"trusted_senders" text[] DEFAULT '{}' NOT NULL,
	"transcription" text NOT NULL,
	"form_details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attendance_keywords" text[] DEFAULT '{}' NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "timetable_entries_type_check" CHECK ("timetable_entries"."type" in ('lecture', 'work')),
	CONSTRAINT "timetable_entries_transcription_check" CHECK ("timetable_entries"."transcription" in ('live', 'native'))
);
--> statement-breakpoint
ALTER TABLE "ai_keys" ADD CONSTRAINT "ai_keys_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artefacts" ADD CONSTRAINT "artefacts_occurrence_id_occurrences_id_fk" FOREIGN KEY ("occurrence_id") REFERENCES "public"."occurrences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artefacts" ADD CONSTRAINT "artefacts_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "details" ADD CONSTRAINT "details_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_occurrence_id_occurrences_id_fk" FOREIGN KEY ("occurrence_id") REFERENCES "public"."occurrences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_occurrence_id_occurrences_id_fk" FOREIGN KEY ("occurrence_id") REFERENCES "public"."occurrences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identities" ADD CONSTRAINT "identities_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mention_names" ADD CONSTRAINT "mention_names_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "occurrences" ADD CONSTRAINT "occurrences_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "occurrences" ADD CONSTRAINT "occurrences_entry_id_timetable_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."timetable_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "occurrences" ADD CONSTRAINT "occurrences_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signin_sessions" ADD CONSTRAINT "signin_sessions_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signin_sessions" ADD CONSTRAINT "signin_sessions_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signin_sessions" ADD CONSTRAINT "signin_sessions_occurrence_id_occurrences_id_fk" FOREIGN KEY ("occurrence_id") REFERENCES "public"."occurrences"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_entries" ADD CONSTRAINT "timetable_entries_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_entries" ADD CONSTRAINT "timetable_entries_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mention_names_member_id_lower_name_unique" ON "mention_names" USING btree ("member_id",lower("name"));--> statement-breakpoint
CREATE INDEX "occurrences_state_idx" ON "occurrences" USING btree ("state");--> statement-breakpoint
CREATE INDEX "occurrences_identity_id_scheduled_start_idx" ON "occurrences" USING btree ("identity_id","scheduled_start");--> statement-breakpoint
CREATE INDEX "occurrences_delete_after_idx" ON "occurrences" USING btree ("delete_after");