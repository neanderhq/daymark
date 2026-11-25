import { and, asc, eq } from "drizzle-orm";

import { invalidSlugMessage, normalizeSlug } from "./profile-validation";
import { getDb } from "./db";
import { availabilityRange, bookingQuestion, eventType } from "./schema";

export const invalidEventDetailsMessage = "Enter valid event details.";
export const invalidQuestionDetailsMessage = "Enter valid question details.";
export const invalidAvailabilityDetailsMessage = "Enter valid availability details.";

export type EventTypeInput = {
  name: string;
  description: string | null;
  durationMinutes: number;
  location: string | null;
  slug: string;
  active: boolean;
};

export type QuestionInput = {
  label: string;
  questionType: "short_text" | "long_text" | "single_choice";
  options: string[] | null;
  required: boolean;
};

export type AvailabilityInput = {
  weekday: number;
  startMinute: number;
  endMinute: number;
};

export type AvailabilityRules = {
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  minimumNoticeHours: number;
  bookingHorizonDays: number;
  startTimeIncrementMinutes: number | null;
  dailyMeetingLimit: number | null;
  weeklyMeetingLimit: number | null;
  monthlyMeetingLimit: number | null;
};

export const defaultAvailabilityRules: AvailabilityRules = {
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  minimumNoticeHours: 0,
  bookingHorizonDays: 60,
  startTimeIncrementMinutes: null,
  dailyMeetingLimit: null,
  weeklyMeetingLimit: null,
  monthlyMeetingLimit: null,
};

export type AvailabilityOverrideInput = {
  date: string;
  unavailable: boolean;
  ranges: { startMinute: number; endMinute: number }[];
};

export type BlockedTimeInput = {
  date: string;
  startMinute: number;
  endMinute: number;
  note: string | null;
};

type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

export const invalidAvailabilityRulesMessage =
  "Enter valid buffers, notice, booking horizon, start-time increment and meeting limits.";
export const invalidAvailabilityOverrideMessage = "Enter valid date hours.";
export const invalidOverrideDateMessage = "Choose a date.";
export const overlappingAvailabilityOverrideMessage = "Times for the same day must not overlap.";
export const invalidBlockedTimeMessage = "Enter the blocked date and the times to block.";
export const invalidBlockedTimeNoteMessage = "Keep the note under 200 characters.";

export const maxAvailabilityOverrides = 200;
export const maxBlockedTimes = 200;

const maxAvailabilityOverrideRanges = 10;

export async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function hasOnlyKeys(body: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(body).every((key) => keys.includes(key));
}

function normalizeOptionalText(value: unknown, maxLength: number): string | null | "invalid" {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return "invalid";
  const text = value.trim();
  return text.length <= maxLength ? (text.length === 0 ? null : text) : "invalid";
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

export function validateEventInput(body: Record<string, unknown>): Validated<EventTypeInput> {
  if (
    typeof body.name !== "string" ||
    body.name.trim().length < 1 ||
    body.name.trim().length > 80 ||
    typeof body.durationMinutes !== "number" ||
    !Number.isInteger(body.durationMinutes) ||
    body.durationMinutes < 5 ||
    body.durationMinutes > 480 ||
    typeof body.active !== "boolean"
  ) {
    return { ok: false, error: invalidEventDetailsMessage };
  }

  const description = normalizeOptionalText(body.description, 2000);
  const location = normalizeOptionalText(body.location, 500);
  const slug = normalizeSlug(body.slug);
  if (description === "invalid" || location === "invalid" || slug === null) {
    return { ok: false, error: slug === null ? invalidSlugMessage : invalidEventDetailsMessage };
  }

  return {
    ok: true,
    value: {
      name: body.name.trim(),
      description,
      durationMinutes: body.durationMinutes,
      location,
      slug,
      active: body.active,
    },
  };
}

export function validateUsernameInput(value: unknown): Validated<string> {
  const username = normalizeSlug(value);
  return username === null ? { ok: false, error: invalidSlugMessage } : { ok: true, value: username };
}

export function validateQuestionInput(body: Record<string, unknown>): Validated<QuestionInput> {
  const questionTypes = ["short_text", "long_text", "single_choice"] as const;
  if (
    typeof body.label !== "string" ||
    body.label.trim().length < 1 ||
    body.label.trim().length > 160 ||
    typeof body.questionType !== "string" ||
    !questionTypes.includes(body.questionType as (typeof questionTypes)[number]) ||
    typeof body.required !== "boolean"
  ) {
    return { ok: false, error: invalidQuestionDetailsMessage };
  }

  const questionType = body.questionType as QuestionInput["questionType"];
  let options: string[] | null = null;
  if (body.options !== null && body.options !== undefined) {
    if (!Array.isArray(body.options) || questionType !== "single_choice") {
      return { ok: false, error: invalidQuestionDetailsMessage };
    }
    if (body.options.length < 1 || body.options.length > 20 || body.options.some((option) => typeof option !== "string" || option.trim().length === 0)) {
      return { ok: false, error: "Single-choice questions need 1–20 non-empty options." };
    }
    options = body.options.map((option) => (option as string).trim());
  } else if (questionType === "single_choice") {
    return { ok: false, error: "Single-choice questions need 1–20 non-empty options." };
  }

  return {
    ok: true,
    value: { label: body.label.trim(), questionType, options, required: body.required },
  };
}

export function validateAvailabilityInput(body: Record<string, unknown>): Validated<AvailabilityInput[]> {
  if (!Array.isArray(body.ranges)) return { ok: false, error: invalidAvailabilityDetailsMessage };
  if (body.ranges.length === 0) return { ok: false, error: "Add at least one time range." };

  const ranges: AvailabilityInput[] = [];
  for (const item of body.ranges) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, error: invalidAvailabilityDetailsMessage };
    }
    const range = item as Record<string, unknown>;
    if (!hasOnlyKeys(range, ["weekday", "startMinute", "endMinute"])) {
      return { ok: false, error: invalidAvailabilityDetailsMessage };
    }
    if (
      typeof range.weekday !== "number" ||
      !Number.isInteger(range.weekday) ||
      range.weekday < 0 ||
      range.weekday > 6
    ) {
      return { ok: false, error: "Choose a day of the week." };
    }
    if (
      typeof range.startMinute !== "number" ||
      !Number.isInteger(range.startMinute) ||
      range.startMinute < 0 ||
      range.startMinute > 1439 ||
      typeof range.endMinute !== "number" ||
      !Number.isInteger(range.endMinute) ||
      range.endMinute < 0 ||
      range.endMinute > 1439 ||
      range.endMinute <= range.startMinute
    ) {
      return { ok: false, error: "Enter times from 00:00 to 23:59, with the end time after the start time." };
    }
    ranges.push({ weekday: range.weekday, startMinute: range.startMinute, endMinute: range.endMinute });
  }

  ranges.sort((left, right) => left.weekday - right.weekday || left.startMinute - right.startMinute);
  for (let index = 1; index < ranges.length; index += 1) {
    const current = ranges[index];
    const previous = ranges[index - 1];
    if (current.weekday === previous.weekday && current.startMinute < previous.endMinute) {
      return { ok: false, error: "Times for the same day must not overlap." };
    }
  }

  return { ok: true, value: ranges };
}

export function validateAvailabilityRulesInput(body: Record<string, unknown>): Validated<AvailabilityRules> {
  const validLimit = (value: unknown) => value === null || (
    typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 100
  );
  if (
    typeof body.bufferBeforeMinutes !== "number" ||
    !Number.isInteger(body.bufferBeforeMinutes) ||
    body.bufferBeforeMinutes < 0 ||
    body.bufferBeforeMinutes > 120 ||
    typeof body.bufferAfterMinutes !== "number" ||
    !Number.isInteger(body.bufferAfterMinutes) ||
    body.bufferAfterMinutes < 0 ||
    body.bufferAfterMinutes > 120 ||
    typeof body.minimumNoticeHours !== "number" ||
    !Number.isInteger(body.minimumNoticeHours) ||
    body.minimumNoticeHours < 0 ||
    body.minimumNoticeHours > 720 ||
    typeof body.bookingHorizonDays !== "number" ||
    !Number.isInteger(body.bookingHorizonDays) ||
    body.bookingHorizonDays < 1 ||
    body.bookingHorizonDays > 365 ||
    !(body.startTimeIncrementMinutes === null || [5, 10, 15, 20, 30, 45, 60].includes(body.startTimeIncrementMinutes as number)) ||
    !validLimit(body.dailyMeetingLimit) ||
    !validLimit(body.weeklyMeetingLimit) ||
    !validLimit(body.monthlyMeetingLimit)
  ) {
    return { ok: false, error: invalidAvailabilityRulesMessage };
  }

  return {
    ok: true,
    value: {
      bufferBeforeMinutes: body.bufferBeforeMinutes,
      bufferAfterMinutes: body.bufferAfterMinutes,
      minimumNoticeHours: body.minimumNoticeHours,
      bookingHorizonDays: body.bookingHorizonDays,
      startTimeIncrementMinutes: body.startTimeIncrementMinutes as number | null,
      dailyMeetingLimit: body.dailyMeetingLimit as number | null,
      weeklyMeetingLimit: body.weeklyMeetingLimit as number | null,
      monthlyMeetingLimit: body.monthlyMeetingLimit as number | null,
    },
  };
}

export function validateAvailabilityOverrideInput(body: Record<string, unknown>): Validated<AvailabilityOverrideInput> {
  if (!isCalendarDate(body.date)) return { ok: false, error: invalidOverrideDateMessage };
  if (typeof body.unavailable !== "boolean" || !Array.isArray(body.ranges)) {
    return { ok: false, error: invalidAvailabilityOverrideMessage };
  }

  if (body.unavailable) {
    if (body.ranges.length > 0) return { ok: false, error: invalidAvailabilityOverrideMessage };
    return { ok: true, value: { date: body.date, unavailable: true, ranges: [] } };
  }

  if (body.ranges.length < 1 || body.ranges.length > maxAvailabilityOverrideRanges) {
    return { ok: false, error: invalidAvailabilityOverrideMessage };
  }

  const ranges: AvailabilityOverrideInput["ranges"] = [];
  for (const item of body.ranges) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, error: invalidAvailabilityOverrideMessage };
    }
    const range = item as Record<string, unknown>;
    if (
      typeof range.startMinute !== "number" ||
      !Number.isInteger(range.startMinute) ||
      range.startMinute < 0 ||
      range.startMinute > 1439 ||
      typeof range.endMinute !== "number" ||
      !Number.isInteger(range.endMinute) ||
      range.endMinute < 0 ||
      range.endMinute > 1439 ||
      range.endMinute <= range.startMinute
    ) {
      return { ok: false, error: invalidAvailabilityOverrideMessage };
    }
    ranges.push({ startMinute: range.startMinute, endMinute: range.endMinute });
  }

  ranges.sort((left, right) => left.startMinute - right.startMinute);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index].startMinute < ranges[index - 1].endMinute) {
      return { ok: false, error: overlappingAvailabilityOverrideMessage };
    }
  }

  return { ok: true, value: { date: body.date, unavailable: false, ranges } };
}

export function validateBlockedTimeInput(body: Record<string, unknown>): Validated<BlockedTimeInput> {
  if (
    !isCalendarDate(body.date) ||
    typeof body.startMinute !== "number" ||
    !Number.isInteger(body.startMinute) ||
    body.startMinute < 0 ||
    body.startMinute > 1439 ||
    typeof body.endMinute !== "number" ||
    !Number.isInteger(body.endMinute) ||
    body.endMinute < 0 ||
    body.endMinute > 1439 ||
    body.endMinute <= body.startMinute
  ) {
    return { ok: false, error: invalidBlockedTimeMessage };
  }

  const note = normalizeOptionalText(body.note, 200);
  if (note === "invalid") return { ok: false, error: invalidBlockedTimeNoteMessage };

  return {
    ok: true,
    value: { date: body.date, startMinute: body.startMinute, endMinute: body.endMinute, note },
  };
}

export async function getOrCreateEventType(userId: string) {
  const database = getDb();
  const existing = await database.select().from(eventType).where(and(eq(eventType.userId, userId), eq(eventType.isDefault, true))).limit(1);
  if (existing[0]) return existing[0];

  const inserted = await database
    .insert(eventType)
    .values({
      id: crypto.randomUUID(),
      userId,
      name: "30 Minute Meeting",
      description: null,
      durationMinutes: 30,
      location: null,
      slug: "30min",
      active: true,
      isDefault: true,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return inserted[0];

  const current = await database.select().from(eventType).where(and(eq(eventType.userId, userId), eq(eventType.isDefault, true))).limit(1);
  if (!current[0]) throw new Error("Event type could not be created.");
  return current[0];
}

export async function ensureAvailabilityDefaults(userId: string) {
  const database = getDb();
  const existing = await database
    .select({ id: availabilityRange.id })
    .from(availabilityRange)
    .where(eq(availabilityRange.userId, userId))
    .limit(1);
  if (existing[0]) return;

  await database
    .insert(availabilityRange)
    .values(
      [1, 2, 3, 4, 5].map((weekday) => ({
        id: crypto.randomUUID(),
        userId,
        weekday,
        startMinute: 540,
        endMinute: 1020,
      })),
    )
    .onConflictDoNothing({
      target: [
        availabilityRange.userId,
        availabilityRange.weekday,
        availabilityRange.startMinute,
        availabilityRange.endMinute,
      ],
    });
}

export async function ensureSchedulingDefaults(userId: string) {
  await getOrCreateEventType(userId);
  await ensureAvailabilityDefaults(userId);
}

export async function getQuestions(userId: string) {
  return getDb()
    .select()
    .from(bookingQuestion)
    .where(eq(bookingQuestion.userId, userId))
    .orderBy(asc(bookingQuestion.position));
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("code" in error && error.code === "23505") {
    if (!constraint) return true;
    return "constraint" in error && error.constraint === constraint;
  }
  return "cause" in error && isUniqueViolation(error.cause, constraint);
}
