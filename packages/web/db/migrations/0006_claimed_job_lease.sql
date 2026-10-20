UPDATE "companion_jobs" SET "state" = 'pending', "device_id" = NULL WHERE "state" = 'claimed' AND "lease_until" IS NULL;--> statement-breakpoint
ALTER TABLE "companion_jobs" ADD CONSTRAINT "companion_jobs_claimed_lease_check" CHECK ("companion_jobs"."state" <> 'claimed' or "companion_jobs"."lease_until" is not null);
