CREATE TABLE "google_calendar_connection" (
	"host_id" text PRIMARY KEY NOT NULL,
	"id" text NOT NULL,
	"refresh_cipher" text NOT NULL,
	"access_cipher" text NOT NULL,
	"access_expires_at" timestamp NOT NULL,
	"needs_reconnect" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "google_calendar_request" (
	"host_id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"state_hash" text NOT NULL,
	"verifier_cipher" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"used" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "google_calendar_connection" ADD CONSTRAINT "google_calendar_connection_host_id_user_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_calendar_request" ADD CONSTRAINT "google_calendar_request_host_id_user_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_calendar_request" ADD CONSTRAINT "google_calendar_request_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;