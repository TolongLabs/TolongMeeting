ALTER TABLE "artefacts" DROP CONSTRAINT "artefacts_occurrence_id_occurrences_id_fk";--> statement-breakpoint
ALTER TABLE "events" DROP CONSTRAINT "events_occurrence_id_occurrences_id_fk";--> statement-breakpoint
ALTER TABLE "forms" DROP CONSTRAINT "forms_occurrence_id_occurrences_id_fk";--> statement-breakpoint
ALTER TABLE "occurrences" DROP CONSTRAINT "occurrences_entry_id_timetable_entries_id_fk";--> statement-breakpoint
ALTER TABLE "occurrences" DROP CONSTRAINT "occurrences_identity_id_identities_id_fk";--> statement-breakpoint
ALTER TABLE "profiles" DROP CONSTRAINT "profiles_identity_id_identities_id_fk";--> statement-breakpoint
ALTER TABLE "signin_sessions" DROP CONSTRAINT "signin_sessions_identity_id_identities_id_fk";--> statement-breakpoint
ALTER TABLE "signin_sessions" DROP CONSTRAINT "signin_sessions_occurrence_id_occurrences_id_fk";--> statement-breakpoint
ALTER TABLE "timetable_entries" DROP CONSTRAINT "timetable_entries_identity_id_identities_id_fk";--> statement-breakpoint
ALTER TABLE "identities" ADD CONSTRAINT "identities_id_member_id_unique" UNIQUE("id","member_id");--> statement-breakpoint
ALTER TABLE "occurrences" ADD CONSTRAINT "occurrences_id_member_id_unique" UNIQUE("id","member_id");--> statement-breakpoint
ALTER TABLE "timetable_entries" ADD CONSTRAINT "timetable_entries_id_member_id_unique" UNIQUE("id","member_id");--> statement-breakpoint
ALTER TABLE "artefacts" ADD CONSTRAINT "artefacts_occurrence_id_occurrences_id_fk" FOREIGN KEY ("occurrence_id","member_id") REFERENCES "public"."occurrences"("id","member_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_occurrence_id_occurrences_id_fk" FOREIGN KEY ("occurrence_id","member_id") REFERENCES "public"."occurrences"("id","member_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_occurrence_id_occurrences_id_fk" FOREIGN KEY ("occurrence_id","member_id") REFERENCES "public"."occurrences"("id","member_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "occurrences" ADD CONSTRAINT "occurrences_entry_id_timetable_entries_id_fk" FOREIGN KEY ("entry_id","member_id") REFERENCES "public"."timetable_entries"("id","member_id") ON DELETE set null ("entry_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "occurrences" ADD CONSTRAINT "occurrences_identity_id_identities_id_fk" FOREIGN KEY ("identity_id","member_id") REFERENCES "public"."identities"("id","member_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_identity_id_identities_id_fk" FOREIGN KEY ("identity_id","member_id") REFERENCES "public"."identities"("id","member_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signin_sessions" ADD CONSTRAINT "signin_sessions_identity_id_identities_id_fk" FOREIGN KEY ("identity_id","member_id") REFERENCES "public"."identities"("id","member_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signin_sessions" ADD CONSTRAINT "signin_sessions_occurrence_id_occurrences_id_fk" FOREIGN KEY ("occurrence_id","member_id") REFERENCES "public"."occurrences"("id","member_id") ON DELETE set null ("occurrence_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_entries" ADD CONSTRAINT "timetable_entries_identity_id_identities_id_fk" FOREIGN KEY ("identity_id","member_id") REFERENCES "public"."identities"("id","member_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artefacts_member_id_idx" ON "artefacts" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "device_tokens_member_id_idx" ON "device_tokens" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "events_member_id_idx" ON "events" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "forms_member_id_idx" ON "forms" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "occurrences_state_scheduled_start_idx" ON "occurrences" USING btree ("state","scheduled_start");--> statement-breakpoint
CREATE INDEX "occurrences_member_id_scheduled_start_idx" ON "occurrences" USING btree ("member_id","scheduled_start");--> statement-breakpoint
CREATE INDEX "signin_sessions_member_id_idx" ON "signin_sessions" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "signin_sessions_identity_id_idx" ON "signin_sessions" USING btree ("identity_id");--> statement-breakpoint
CREATE INDEX "signin_sessions_occurrence_id_idx" ON "signin_sessions" USING btree ("occurrence_id");--> statement-breakpoint
CREATE INDEX "timetable_entries_member_id_idx" ON "timetable_entries" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "timetable_entries_identity_id_idx" ON "timetable_entries" USING btree ("identity_id");
