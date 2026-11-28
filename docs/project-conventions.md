# Project conventions

## Stack and folders

- Next.js App Router, React, and TypeScript provide pages, UI, and server routes.
- PostgreSQL is the application database and Drizzle maps its tables. Neander-managed Identity Platform/Firebase owns authentication; native SDKs verify identities and issue server session cookies.
- `app/` contains pages, route handlers, shared UI, and forms. `server/` contains database, authentication, session, and validation code. `drizzle/` contains committed SQL migrations and Drizzle history. `.neander/` contains the deployment recipe and explicit migration runner.

## Tables and migrations

- Keep existing migration history and the generated legacy auth tables for data compatibility. The app uses `user` for profiles keyed by the verified native UID and `session` for one-way cookie hashes, expiry, logout and Calendar OAuth state binding. It does not authenticate database passwords or adopt identities by matching email. Do not seed native identities or credentials into SQL.
- Application schema changes go through `pnpm db:generate`; review and commit generated SQL and `drizzle/meta/` history. Do not drop old tables merely because their provider implementation changed.
- Scheduling uses host-owned `event_type`, `booking_question`, `availability_range`, `availability_override`, `blocked_time` and `availability_rule` rows. Weekdays run Sunday=0 through Saturday=6. Ranges use minutes after host-local midnight; override/blocked dates are host-local `YYYY-MM-DD` dates. An unavailable override closes the date; available overrides replace weekly hours on that date. Preserve the existing slot calculation and booking constraints.
- `booking_reminder` tracks the stable native Scheduler name, revision, scheduled time and reconciliation status for each booking. `booking_email` tracks immutable message snapshots and delivery state. Never automatically resend an ambiguous SES outcome; the provider has no send idempotency key.
- Polls use a `poll` row per host, ordered-by-time `poll_option` rows containing UTC instants, one `poll_vote` per poll and lowercase-normalized voter email, and `poll_vote_option` rows linking each vote to its selected options. The database enforces one final vote per poll and normalized email. Poll option times are stored as UTC instants; convert them to an IANA time zone for display and entry. Keep vote details available on public pages only when the host enables `showVotes`. A booking made from a poll links back through `booking.poll_id`; preserve the poll and its votes when a time is booked. `booking_attendee` stores normalized attendee records attached to bookings; poll bookings include voters plus any host-added attendees, deduplicated by email.
- `booking_link` rows belong to a host and have a unique, unguessable 24-byte base64url token, kind `event_type` or `one_off`, and status `active`, `used`, or `deleted`. Event-type links reference that host's event type; one-off links store the meeting name, optional details, duration, and 1–20 unique future UTC proposed starts. `booking.booking_link_id` references the resulting booking link and is unique, so a link can produce at most one booking. Soft-delete links to preserve history; cancelling a booking does not reactivate a used link.
- Keep cancellation metadata and `reschedule_history` on the original booking row; history stores previous UTC times and does not create replacement bookings. Contacts are unique per host and lowercase-normalized email; backfill them from retained bookings. Derive booking count and last booking date from booking rows, and never delete bookings when deleting a contact.
- Apply migrations explicitly with `pnpm db:migrate` against an isolated local database. Production uses the declared `nextjs-drizzle` migration action before rollout, not image build or app startup. Never use `drizzle-kit push` for production.
- PostgreSQL connections use UTC. Store future scheduling instants as UTC; convert to a person's IANA time zone only for display and entry.

## Login and data ownership

- Read the native tenant session and unexpired hashed application session on the server for each protected page or private request. Redirect signed-out visitors from `/dashboard` to `/login`. Email is owned by Identity Platform; profile settings may change the app-owned name and timezone.
- Scope every private read and write to the authenticated session user's ID. Never accept a user ID from the browser as authority.
- Scope host booking actions and contact create/read/update/delete to the current session user. Authorize invitee actions only with the booking's unguessable confirmation token.
- Require a session for host link management at `/dashboard/links` and its APIs, and scope every operation to the session user's host ID. `/link/[token]` is public and authorizes link access with its unguessable token.
- Poll pages at `/polls/[token]` use an unguessable token and allow public voting. Expose only the poll data needed by voters and include voter identities/selections only when `showVotes` is enabled. Validate votes against options belonging to that poll; the database enforces one final vote per normalized email per poll. Keep poll-management pages and host poll management, results, and booking APIs private and scope every host operation to the current session user.
- Keep `/api/health` public for app readiness checks. It does not expose account or scheduling data.
- Use relative `/api` requests in the browser. Keep auth secrets and database URLs server-side; production builds and app startup do not apply migrations or need credentials embedded in the image.

## Validation and errors

- Validate input on the server even when a browser form also has required fields or limits. Check names, email addresses, and IANA time zones before writing.
- Validate public slugs with lowercase URL-safe segments, enforce global username uniqueness and per-user event-slug uniqueness, and return a clear `409` for duplicates. Also reserve the app's static page segments (`api`, `booking`, `dashboard`, `login`, `polls`, `settings`, `signup`) as usernames. Validate event duration, question type/options, and weekly ranges before writing. Sort same-day availability server-side and reject overlaps.
- Materialize a new host's default event type and Mon–Fri 09:00–17:00 availability additively on first use. The server assigns question positions; reorder requests must contain every owned question exactly once.
- Validate availability rules on the server: buffers 0–120 minutes each, minimum notice 0–720 hours, booking horizon 1–365 days, start spacing of 5, 10, 15, 20, 30, 45, or 60 minutes (or null for event duration), and optional meeting caps of 1–100. Count cap periods by each active booking's start in the host's IANA time zone; include poll and one-off bookings in counts, but exempt those booking types from the new limits. Keep cap checks in the existing booking transaction and shared event-row lock. Date-hour ranges must be within 00:00–23:59 with the end after the start and no overlaps within a submitted date. Limit block notes to 200 characters.
- Date-specific hours replace the weekly hours for that date, a date marked unavailable offers no times, and a slot overlapping a blocked range is never offered.
- A booking plus its buffers must not overlap another active booking plus its buffers, and a slot inside the minimum-notice window is not offered. Re-check these rules on the server inside the booking transaction so a stale open page cannot create a booking that breaks them.
- Validate one-off link details and 1–20 distinct future UTC proposed starts on the server. During redemption, lock and check the active link, recheck availability through `server/slots.ts` and existing double-booking protection, then create the booking and mark the link used in the same transaction. One-off bookings have no event type, remain in booking history/details, can be cancelled, and cannot be rescheduled; event-type-link bookings retain normal rescheduling.
- Reject cancellation and rescheduling after a booking has started. Rescheduling locks and atomically updates the same booking row; inside the transaction, use the single `server/slots.ts` rules path and exclude the booking being moved.
- Enforce per-host limits on the number of date-specific dates and blocked ranges.
- `server/slots.ts` remains the single place that computes available times; date overrides, blocked ranges, buffers, minimum notice, booking horizon, start spacing, and meeting caps all live there, and no second slot calculation may be added. Booking and reschedule transactions recheck eligible event-type slots through this module after taking the host's shared event-row lock.
- Return a clear field or form error for invalid input, duplicate email, and incorrect login details. Never show database internals or secret values to visitors.
- Normalize email addresses to lowercase before saving. Neander supplies managed bindings at runtime. Keep isolated verification fixtures in ignored files; `.env.example` contains placeholders only.

## UI and project rules

- Reuse `Button`, `Input`, `ErrorField`, `Card`, `PageHeader`, and `EmptyState` from `app/components/ui.tsx` before introducing another one-off pattern.
- Keep screens responsive, keyboard accessible, and visually consistent with the quiet neutral palette. Label inputs and connect validation messages to their fields.
- Keep each change focused on the requested step. Do not add later scheduling workflows until they are requested.
- Preserve the deployment contract, the public health route, and existing data. Scope all local Docker Compose commands with an explicit unique `-p` and `-f`; never remove the database volume during routine shutdown.
