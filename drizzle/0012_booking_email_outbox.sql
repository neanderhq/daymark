CREATE TABLE "booking_email" (
	"id" text PRIMARY KEY NOT NULL,
	"booking_id" text NOT NULL,
	"revision" integer NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"sender" text,
	"recipient" text NOT NULL,
	"subject" text NOT NULL,
	"message" text NOT NULL,
	"first_attempt_at" timestamp,
	"next_attempt_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "booking_email" ADD CONSTRAINT "booking_email_booking_id_booking_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."booking"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "booking_email_revision_idx" ON "booking_email" USING btree ("booking_id","revision");