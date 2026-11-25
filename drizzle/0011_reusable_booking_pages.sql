DROP INDEX "event_type_userId_unique";--> statement-breakpoint
ALTER TABLE "event_type" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "event_type" SET "is_default" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "event_type_default_owner_idx" ON "event_type" USING btree ("user_id") WHERE "event_type"."is_default";
