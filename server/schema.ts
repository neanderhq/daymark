import { pgTable, text, timestamp, integer, boolean, jsonb, uniqueIndex, index, check, primaryKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { session, user } from "./auth-schema";

export * from "./auth-schema";

export type BookingQuestionType = "short_text" | "long_text" | "single_choice";

export const eventType = pgTable(
  "event_type",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    durationMinutes: integer("duration_minutes").notNull(),
    location: text("location"),
    slug: text("slug").notNull(),
    active: boolean("active").default(true).notNull(),
    isDefault: boolean("is_default").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("event_type_default_owner_idx").on(table.userId).where(sql`${table.isDefault}`),
    uniqueIndex("event_type_userId_slug_unique").on(table.userId, table.slug),
  ],
);

export const bookingQuestion = pgTable(
  "booking_question",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    questionType: text("question_type").$type<BookingQuestionType>().notNull(),
    options: jsonb("options").$type<string[]>(),
    required: boolean("required").default(false).notNull(),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("booking_question_userId_idx").on(table.userId)],
);

export const availabilityRange = pgTable(
  "availability_range",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    weekday: integer("weekday").notNull(),
    startMinute: integer("start_minute").notNull(),
    endMinute: integer("end_minute").notNull(),
  },
  (table) => [
    index("availability_range_userId_idx").on(table.userId),
    uniqueIndex("availability_range_userId_weekday_start_end_unique").on(
      table.userId,
      table.weekday,
      table.startMinute,
      table.endMinute,
    ),
  ],
);

export type BookingStatus = "active" | "cancelled";
export type BookingCancellationActor = "host" | "invitee";
export type BookingRescheduleHistoryEntry = { startUtc: string; endUtc: string };
export type PollStatus = "open" | "closed";
export type BookingLinkKind = "event_type" | "one_off";
export type BookingLinkStatus = "active" | "used" | "deleted";

export type AvailabilityOverrideKind = "available" | "unavailable";

export const availabilityOverride = pgTable(
  "availability_override",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    kind: text("kind").$type<AvailabilityOverrideKind>().notNull(),
    startMinute: integer("start_minute"),
    endMinute: integer("end_minute"),
  },
  (table) => [index("availability_override_userId_date_idx").on(table.userId, table.date)],
);

export const blockedTime = pgTable(
  "blocked_time",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    startMinute: integer("start_minute").notNull(),
    endMinute: integer("end_minute").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("blocked_time_userId_date_idx").on(table.userId, table.date)],
);

export const availabilityRule = pgTable(
  "availability_rule",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    bufferBeforeMinutes: integer("buffer_before_minutes").default(0).notNull(),
    bufferAfterMinutes: integer("buffer_after_minutes").default(0).notNull(),
    minimumNoticeHours: integer("minimum_notice_hours").default(0).notNull(),
    bookingHorizonDays: integer("booking_horizon_days").default(60).notNull(),
    startTimeIncrementMinutes: integer("start_time_increment_minutes"),
    dailyMeetingLimit: integer("daily_meeting_limit"),
    weeklyMeetingLimit: integer("weekly_meeting_limit"),
    monthlyMeetingLimit: integer("monthly_meeting_limit"),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [uniqueIndex("availability_rule_userId_unique").on(table.userId)],
);

export const booking = pgTable(
  "booking",
  {
    id: text("id").primaryKey(),
    hostId: text("host_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    eventTypeId: text("event_type_id")
      .references(() => eventType.id, { onDelete: "cascade" }),
    inviteeName: text("invitee_name").notNull(),
    inviteeEmail: text("invitee_email").notNull(),
    inviteeTimezone: text("invitee_timezone").notNull(),
    startUtc: timestamp("start_utc").notNull(),
    endUtc: timestamp("end_utc").notNull(),
    status: text("status").$type<BookingStatus>().default("active").notNull(),
    cancelledAt: timestamp("cancelled_at"),
    cancellationActor: text("cancellation_actor").$type<BookingCancellationActor>(),
    cancellationReason: text("cancellation_reason"),
    rescheduleHistory: jsonb("reschedule_history").$type<BookingRescheduleHistoryEntry[]>().default([]).notNull(),
    confirmationToken: text("confirmation_token").notNull(),
    pollId: text("poll_id").references(() => poll.id, { onDelete: "set null" }),
    bookingLinkId: text("booking_link_id").references(() => bookingLink.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("booking_hostId_startUtc_idx").on(table.hostId, table.startUtc),
    uniqueIndex("booking_confirmationToken_unique").on(table.confirmationToken),
    index("booking_pollId_idx").on(table.pollId),
    uniqueIndex("booking_bookingLinkId_unique").on(table.bookingLinkId),
  ],
);

export const contact = pgTable(
  "contact",
  {
    id: text("id").primaryKey(),
    hostId: text("host_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    email: text("email").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("contact_hostId_email_unique").on(table.hostId, table.email),
    check("contact_email_lowercase_check", sql`${table.email} = lower(${table.email})`),
  ],
);

export const bookingAnswer = pgTable(
  "booking_answer",
  {
    id: text("id").primaryKey(),
    bookingId: text("booking_id")
      .notNull()
      .references(() => booking.id, { onDelete: "cascade" }),
    questionId: text("question_id").references(() => bookingQuestion.id, { onDelete: "set null" }),
    questionLabel: text("question_label").notNull(),
    answer: text("answer").notNull(),
    position: integer("position").notNull(),
  },
  (table) => [index("booking_answer_bookingId_idx").on(table.bookingId)],
);

export const poll = pgTable(
  "poll",
  {
    id: text("id").primaryKey(),
    hostId: text("host_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    durationMinutes: integer("duration_minutes").notNull(),
    token: text("token").notNull(),
    showVotes: boolean("show_votes").default(false).notNull(),
    status: text("status").$type<PollStatus>().default("open").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("poll_token_unique").on(table.token),
    index("poll_hostId_idx").on(table.hostId),
  ],
);

export const bookingLink = pgTable(
  "booking_link",
  {
    id: text("id").primaryKey(),
    hostId: text("host_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    kind: text("kind").$type<BookingLinkKind>().notNull(),
    status: text("status").$type<BookingLinkStatus>().default("active").notNull(),
    eventTypeId: text("event_type_id").references(() => eventType.id, { onDelete: "cascade" }),
    meetingName: text("meeting_name"),
    durationMinutes: integer("duration_minutes"),
    description: text("description"),
    location: text("location"),
    proposedStarts: timestamp("proposed_starts", { mode: "date" }).array(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("booking_link_token_unique").on(table.token),
    index("booking_link_hostId_idx").on(table.hostId),
    index("booking_link_eventTypeId_idx").on(table.eventTypeId),
    check("booking_link_kind_check", sql`${table.kind} in ('event_type', 'one_off')`),
    check("booking_link_status_check", sql`${table.status} in ('active', 'used', 'deleted')`),
    check(
      "booking_link_details_check",
      sql`(${table.kind} = 'event_type' and ${table.eventTypeId} is not null and ${table.meetingName} is null and ${table.durationMinutes} is null and ${table.description} is null and ${table.location} is null and ${table.proposedStarts} is null) or (${table.kind} = 'one_off' and ${table.eventTypeId} is null and ${table.meetingName} is not null and ${table.durationMinutes} is not null and ${table.durationMinutes} > 0 and ${table.proposedStarts} is not null and cardinality(${table.proposedStarts}) between 1 and 20)`,
    ),
  ],
);

export const pollOption = pgTable(
  "poll_option",
  {
    id: text("id").primaryKey(),
    pollId: text("poll_id")
      .notNull()
      .references(() => poll.id, { onDelete: "cascade" }),
    startUtc: timestamp("start_utc").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("poll_option_pollId_startUtc_unique").on(table.pollId, table.startUtc),
    index("poll_option_pollId_idx").on(table.pollId),
  ],
);

export const pollVote = pgTable(
  "poll_vote",
  {
    id: text("id").primaryKey(),
    pollId: text("poll_id")
      .notNull()
      .references(() => poll.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    email: text("email").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("poll_vote_pollId_email_unique").on(table.pollId, table.email),
    check("poll_vote_email_lowercase_check", sql`${table.email} = lower(${table.email})`),
    index("poll_vote_pollId_idx").on(table.pollId),
  ],
);

export const pollVoteOption = pgTable(
  "poll_vote_option",
  {
    voteId: text("vote_id")
      .notNull()
      .references(() => pollVote.id, { onDelete: "cascade" }),
    optionId: text("option_id")
      .notNull()
      .references(() => pollOption.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.voteId, table.optionId] }),
    index("poll_vote_option_optionId_idx").on(table.optionId),
  ],
);

export const bookingAttendee = pgTable(
  "booking_attendee",
  {
    id: text("id").primaryKey(),
    bookingId: text("booking_id")
      .notNull()
      .references(() => booking.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    email: text("email").notNull(),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("booking_attendee_bookingId_email_unique").on(table.bookingId, table.email),
    check("booking_attendee_email_lowercase_check", sql`${table.email} = lower(${table.email})`),
    index("booking_attendee_bookingId_idx").on(table.bookingId),
  ],
);

export type BookingEmailKind = "confirmed" | "rescheduled" | "cancelled";
export type BookingEmailStatus = "pending" | "accepted" | "failed" | "unconfigured" | "superseded";

export const bookingEmail = pgTable(
  "booking_email",
  {
    id: text("id").primaryKey(),
    bookingId: text("booking_id").notNull().references(() => booking.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    kind: text("kind").$type<BookingEmailKind>().notNull(),
    status: text("status").$type<BookingEmailStatus>().notNull(),
    sender: text("sender"),
    recipient: text("recipient").notNull(),
    subject: text("subject").notNull(),
    message: text("message").notNull(),
    firstAttemptAt: timestamp("first_attempt_at"),
    nextAttemptAt: timestamp("next_attempt_at").defaultNow().notNull(),
  },
  (table) => [uniqueIndex("booking_email_revision_idx").on(table.bookingId, table.revision)],
);

export const googleCalendarConnection = pgTable("google_calendar_connection", {
  hostId: text("host_id").primaryKey().references(() => user.id, { onDelete: "cascade" }),
  id: text("id").notNull(),
  refreshCipher: text("refresh_cipher").notNull(),
  accessCipher: text("access_cipher").notNull(),
  accessExpiresAt: timestamp("access_expires_at").notNull(),
  needsReconnect: boolean("needs_reconnect").default(false).notNull(),
});

export const googleCalendarRequest = pgTable("google_calendar_request", {
  hostId: text("host_id").primaryKey().references(() => user.id, { onDelete: "cascade" }),
  sessionId: text("session_id").notNull().references(() => session.id, { onDelete: "cascade" }),
  stateHash: text("state_hash").notNull(),
  verifierCipher: text("verifier_cipher").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  used: boolean("used").default(false).notNull(),
});
