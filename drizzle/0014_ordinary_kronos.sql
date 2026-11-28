CREATE TABLE "booking_reminder" (
	"booking_id" text PRIMARY KEY NOT NULL,
	"schedule_name" text NOT NULL,
	"revision" integer NOT NULL,
	"status" text NOT NULL,
	"scheduled_for" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "booking_reminder" ADD CONSTRAINT "booking_reminder_booking_id_booking_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."booking"("id") ON DELETE cascade ON UPDATE no action;