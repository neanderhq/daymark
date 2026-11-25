import { googleBusyTimes, recordCalendarFailure } from "./google-calendar";
import { deliverBookingEmail, queueBookingEmail } from "./booking-email";
import { randomBytes } from "node:crypto";

import { and, eq, gt, lt } from "drizzle-orm";

import { upsertBookingContact } from "./contacts";
import { getDb } from "./db";
import {
  invalidEmailMessage,
  invalidTimezoneMessage,
  normalizeEmail,
  normalizeUserName,
} from "./profile-validation";
import { invalidQuestionDetailsMessage, isUniqueViolation } from "./scheduling";
import { availabilityRule, booking, bookingAnswer, bookingAttendee, bookingLink, eventType, poll, pollOption, user } from "./schema";
import {
  bufferedInterval,
  getAvailabilityRules,
  getAvailableProposedStarts,
  getAvailableSlots,
  intervalsOverlap,
  normalizeAvailabilityRules,
} from "./slots";
import { getDateInTimezone, isIanaTimezone } from "./timezone";

export const invalidBookingDetailsMessage = "Enter valid booking details.";
export const slotTakenMessage = "This time was just booked, please choose another";
export const invalidCancellationReasonMessage = "Keep the cancellation reason under 500 characters.";
export const bookingNotAvailableMessage = "This booking is no longer available to change.";
export const pollNotOpenMessage = "This poll is no longer open.";
export const invalidAttendeeMessage = "Enter a valid attendee name and email.";

export class SlotTakenError extends Error {
  constructor() {
    super(slotTakenMessage);
  }
}

export class StaleBookingDetailsError extends Error {
  constructor() {
    super("Choose an available time.");
  }
}

export class BookingNotFoundError extends Error {
  constructor() {
    super("Booking not found.");
  }
}

export class BookingNotAvailableError extends Error {
  constructor() {
    super(bookingNotAvailableMessage);
  }
}

export class BookingLinkNotFoundError extends Error {
  constructor() {
    super("This link is no longer available.");
  }
}

export class BookingLinkAlreadyUsedError extends Error {
  constructor() {
    super("This link has already been used");
  }
}

export class BookingLinkUnavailableError extends Error {
  constructor() {
    super("This link is no longer available");
  }
}

export class BookingLinkNotActiveError extends Error {
  constructor() {
    super("This link is no longer active.");
  }
}

export class OneOffBookingCannotRescheduleError extends Error {
  constructor() {
    super("This one-off meeting cannot be rescheduled.");
  }
}

export function validateCancellationReason(value: unknown):
  | { ok: true; value: string | null }
  | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, error: invalidCancellationReasonMessage };
  const reason = value.trim();
  if (reason.length > 500) return { ok: false, error: invalidCancellationReasonMessage };
  return { ok: true, value: reason.length === 0 ? null : reason };
}

export type BookingInput = {
  inviteeName: string;
  inviteeEmail: string;
  inviteeTimezone: string;
  startUtc: Date;
  answers: { questionId: string; questionLabel: string; answer: string }[];
};

export function validateBookingInput(
  body: Record<string, unknown>,
  questions: {
    id: string;
    label: string;
    questionType: "short_text" | "long_text" | "single_choice";
    options: string[] | null;
    required: boolean;
  }[],
): { ok: true; value: BookingInput } | { ok: false; error: string } {
  const inviteeName = normalizeUserName(body.name);
  if (inviteeName === null) return { ok: false, error: "Enter your name." };

  const inviteeEmail = normalizeEmail(body.email);
  if (inviteeEmail === null) return { ok: false, error: invalidEmailMessage };

  if (!isIanaTimezone(body.timezone)) return { ok: false, error: invalidTimezoneMessage };
  const inviteeTimezone = body.timezone;

  if (typeof body.startUtc !== "string") return { ok: false, error: invalidBookingDetailsMessage };
  const startTimestamp = Date.parse(body.startUtc);
  const startUtc = new Date(startTimestamp);
  if (!Number.isFinite(startTimestamp) || startUtc.toISOString() !== body.startUtc) {
    return { ok: false, error: invalidBookingDetailsMessage };
  }

  if (!Array.isArray(body.answers)) return { ok: false, error: invalidBookingDetailsMessage };
  const questionById = new Map(questions.map((question) => [question.id, question]));
  const answerByQuestionId = new Map<string, string>();

  for (const item of body.answers) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, error: invalidBookingDetailsMessage };
    }
    const answerRecord = item as Record<string, unknown>;
    if (
      Object.keys(answerRecord).length !== 2 ||
      !Object.hasOwn(answerRecord, "questionId") ||
      !Object.hasOwn(answerRecord, "answer") ||
      typeof answerRecord.questionId !== "string" ||
      answerRecord.questionId.length === 0 ||
      typeof answerRecord.answer !== "string"
    ) {
      return { ok: false, error: invalidBookingDetailsMessage };
    }

    const question = questionById.get(answerRecord.questionId);
    if (!question || answerByQuestionId.has(question.id)) {
      return { ok: false, error: invalidQuestionDetailsMessage };
    }
    answerByQuestionId.set(question.id, answerRecord.answer);
  }

  for (const question of questions) {
    const answer = answerByQuestionId.get(question.id) ?? "";
    if (question.required && answer.trim().length === 0) {
      return { ok: false, error: "Answer the required questions." };
    }
    if (answer.trim().length === 0) {
      answerByQuestionId.delete(question.id);
      continue;
    }
    if (question.questionType === "single_choice") {
      if (!question.options?.includes(answer)) return { ok: false, error: "Choose one of the options." };
      continue;
    }
    const maxLength = question.questionType === "short_text" ? 500 : 2000;
    if (answer.length > maxLength) return { ok: false, error: invalidQuestionDetailsMessage };
  }

  return {
    ok: true,
    value: {
      inviteeName,
      inviteeEmail,
      inviteeTimezone,
      startUtc,
      answers: questions
        .filter((question) => answerByQuestionId.has(question.id))
        .map((question) => ({
          questionId: question.id,
          questionLabel: question.label,
          answer: answerByQuestionId.get(question.id) ?? "",
        })),
    },
  };
}

export async function createBooking(input: {
  hostId: string;
  eventTypeId?: string;
  bookingLinkId?: string;
  startUtc: Date;
  endUtc: Date;
  inviteeName: string;
  inviteeEmail: string;
  inviteeTimezone: string;
  answers: BookingInput["answers"];
  durationMinutes?: number;
  pollId?: string;
  attendees?: { name: string; email: string }[];
}): Promise<{ id: string; confirmationToken: string }> {
  const inviteeName = normalizeUserName(input.inviteeName);
  const inviteeEmail = normalizeEmail(input.inviteeEmail);
  if (inviteeName === null || inviteeEmail === null) throw new Error(invalidBookingDetailsMessage);
  if (input.durationMinutes !== undefined) {
    if (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 5 || input.durationMinutes > 480) {
      throw new Error(invalidBookingDetailsMessage);
    }
  }
  if (!input.bookingLinkId && !input.eventTypeId) throw new Error(invalidBookingDetailsMessage);

  try {
    const result = await getDb().transaction(async (transaction) => {
      await lockBookingHost(transaction, input.hostId);
      let resolvedEventTypeId = input.eventTypeId ?? null;
      let meetingDuration: number;
      let link: typeof bookingLink.$inferSelect | null = null;
      if (input.bookingLinkId) {
        const [lockedLink] = await transaction
          .select()
          .from(bookingLink)
          .where(eq(bookingLink.id, input.bookingLinkId))
          .for("update");
        if (!lockedLink || lockedLink.hostId !== input.hostId) throw new BookingLinkNotFoundError();
        if (lockedLink.status === "used") throw new BookingLinkAlreadyUsedError();
        if (lockedLink.status !== "active") throw new BookingLinkUnavailableError();
        link = lockedLink;

        if (lockedLink.kind === "event_type") {
          if (!lockedLink.eventTypeId || (input.eventTypeId && input.eventTypeId !== lockedLink.eventTypeId)) {
            throw new StaleBookingDetailsError();
          }
          resolvedEventTypeId = lockedLink.eventTypeId;
          const lockedEvent = await lockEventForBooking(transaction, input.hostId, resolvedEventTypeId);
          if (!lockedEvent.active) throw new StaleBookingDetailsError();
          meetingDuration = lockedEvent.durationMinutes;
        } else {
          if (!lockedLink.durationMinutes || !lockedLink.proposedStarts) throw new BookingLinkUnavailableError();
          if (!lockedLink.proposedStarts.some((start) => start.getTime() === input.startUtc.getTime())) {
            throw new StaleBookingDetailsError();
          }
          resolvedEventTypeId = null;
          meetingDuration = lockedLink.durationMinutes;
        }
      } else {
        if (!resolvedEventTypeId) throw new Error(invalidBookingDetailsMessage);
        const lockedEvent = await lockEventForBooking(transaction, input.hostId, resolvedEventTypeId);
        if (!lockedEvent.active && !input.pollId) throw new StaleBookingDetailsError();
        meetingDuration = input.durationMinutes ?? lockedEvent.durationMinutes;
      }

    const endUtc = new Date(input.startUtc.getTime() + meetingDuration * 60_000);
    if (endUtc.getTime() !== input.endUtc.getTime()) throw new StaleBookingDetailsError();

    if (input.pollId) {
      const [lockedPoll] = await transaction.select().from(poll).where(eq(poll.id, input.pollId)).for("update");
      if (!lockedPoll || lockedPoll.hostId !== input.hostId) throw new Error("Poll not found.");
      if (lockedPoll.status !== "open") throw new Error(pollNotOpenMessage);
      if (lockedPoll.durationMinutes !== meetingDuration) throw new Error(invalidBookingDetailsMessage);
      const [pollOptionRow] = await transaction
        .select({ id: pollOption.id })
        .from(pollOption)
        .where(and(eq(pollOption.pollId, lockedPoll.id), eq(pollOption.startUtc, input.startUtc)))
        .limit(1);
      if (!pollOptionRow) throw new Error(invalidBookingDetailsMessage);
      if (input.startUtc.getTime() <= Date.now()) throw new StaleBookingDetailsError();
    }

    const [ruleRow] = await transaction
      .select({
        bufferBeforeMinutes: availabilityRule.bufferBeforeMinutes,
        bufferAfterMinutes: availabilityRule.bufferAfterMinutes,
        minimumNoticeHours: availabilityRule.minimumNoticeHours,
        bookingHorizonDays: availabilityRule.bookingHorizonDays,
        startTimeIncrementMinutes: availabilityRule.startTimeIncrementMinutes,
        dailyMeetingLimit: availabilityRule.dailyMeetingLimit,
        weeklyMeetingLimit: availabilityRule.weeklyMeetingLimit,
        monthlyMeetingLimit: availabilityRule.monthlyMeetingLimit,
      })
      .from(availabilityRule)
      .where(eq(availabilityRule.userId, input.hostId))
      .limit(1);
    const rules = normalizeAvailabilityRules(ruleRow ?? null);
    if (link && input.startUtc.getTime() < Date.now() + rules.minimumNoticeHours * 3_600_000) {
      throw new StaleBookingDetailsError();
    }

    const candidateInterval = bufferedInterval(input.startUtc, endUtc, rules);
    const bufferMs = (rules.bufferBeforeMinutes + rules.bufferAfterMinutes) * 60_000;
    const overlaps = await transaction
      .select({ startUtc: booking.startUtc, endUtc: booking.endUtc })
      .from(booking)
      .where(
        and(
          eq(booking.hostId, input.hostId),
          eq(booking.status, "active"),
          lt(booking.startUtc, new Date(candidateInterval.end.getTime() + bufferMs)),
          gt(booking.endUtc, new Date(candidateInterval.start.getTime() - bufferMs)),
        ),
      );
    const hasConflict = overlaps.some((existingBooking) =>
      intervalsOverlap(
        candidateInterval,
        bufferedInterval(existingBooking.startUtc, existingBooking.endUtc, rules),
      ),
    );
    if (hasConflict) throw new SlotTakenError();

    if (resolvedEventTypeId && !input.pollId) {
      const [host] = await transaction
        .select({ timezone: user.timezone })
        .from(user)
        .where(eq(user.id, input.hostId))
        .limit(1);
      if (!host || !isIanaTimezone(host.timezone) || !isIanaTimezone(input.inviteeTimezone)) {
        throw new StaleBookingDetailsError();
      }
      const slots = await getAvailableSlots({
        hostId: input.hostId,
        hostTimezone: host.timezone,
        durationMinutes: meetingDuration,
        date: getDateInTimezone(input.startUtc, input.inviteeTimezone),
        timezone: input.inviteeTimezone,
        executor: transaction,
      });
      if (!slots.some((slot) => slot.getTime() === input.startUtc.getTime())) throw new StaleBookingDetailsError();
    }

    if (link?.kind === "one_off") {
      const [host] = await transaction
        .select({ timezone: user.timezone })
        .from(user)
        .where(eq(user.id, input.hostId))
        .limit(1);
      if (!host || !isIanaTimezone(host.timezone)) throw new StaleBookingDetailsError();
      const slots = await getAvailableProposedStarts({
        hostId: input.hostId,
        hostTimezone: host.timezone,
        durationMinutes: meetingDuration,
        starts: [input.startUtc],
        executor: transaction,
      });
      if (!slots.some((slot) => slot.getTime() === input.startUtc.getTime())) throw new StaleBookingDetailsError();
    }

    await checkCalendarConflict(transaction, input.hostId, candidateInterval);

    const id = crypto.randomUUID();
    const confirmationToken = randomBytes(24).toString("base64url");
    await transaction.insert(booking).values({
      id,
      hostId: input.hostId,
      eventTypeId: resolvedEventTypeId,
      bookingLinkId: input.bookingLinkId ?? null,
      inviteeName,
      inviteeEmail,
      inviteeTimezone: input.inviteeTimezone,
      startUtc: input.startUtc,
      endUtc,
      status: "active",
      confirmationToken,
      pollId: input.pollId ?? null,
    });

    if (input.answers.length > 0) {
      await transaction.insert(bookingAnswer).values(
        input.answers.map((answer, index) => ({
          id: crypto.randomUUID(),
          bookingId: id,
          questionId: answer.questionId,
          questionLabel: answer.questionLabel,
          answer: answer.answer,
          position: index,
        })),
      );
    }

    await upsertBookingContact(transaction, input.hostId, inviteeName, inviteeEmail);

    if (input.attendees && input.attendees.length > 0) {
      const normalizedAttendees: { name: string; email: string }[] = [];
      const emails = new Set<string>();
      for (const attendee of input.attendees) {
        const name = normalizeUserName(attendee.name);
        const email = normalizeEmail(attendee.email);
        if (name === null || email === null || emails.has(email)) throw new Error(invalidAttendeeMessage);
        emails.add(email);
        normalizedAttendees.push({ name, email });
      }
      await transaction.insert(bookingAttendee).values(
        normalizedAttendees.map((attendee, index) => ({
          id: crypto.randomUUID(),
          bookingId: id,
          name: attendee.name,
          email: attendee.email,
          position: index,
        })),
      );
      for (const attendee of normalizedAttendees) {
        await upsertBookingContact(transaction, input.hostId, attendee.name, attendee.email);
      }
    }

    if (input.pollId) {
      await transaction
        .update(poll)
        .set({ status: "closed", updatedAt: new Date() })
        .where(and(eq(poll.id, input.pollId), eq(poll.status, "open")));
    }

    if (link) {
      const [usedLink] = await transaction
        .update(bookingLink)
        .set({ status: "used" })
        .where(and(eq(bookingLink.id, link.id), eq(bookingLink.status, "active")))
        .returning({ id: bookingLink.id });
      if (!usedLink) throw new BookingLinkAlreadyUsedError();
    }

    const deliveryId = await queueBookingEmail(transaction, id, "confirmed");
    return { id, confirmationToken, deliveryId };
    });
    await deliverBookingEmail(result.deliveryId);
    return { id: result.id, confirmationToken: result.confirmationToken };
  } catch (error) {
    if (isUniqueViolation(error, "booking_bookingLinkId_unique")) throw new BookingLinkAlreadyUsedError();
    await recordCalendarFailure(error);
    throw error;
  }
}

type BookingActionSelector =
  | { kind: "host"; hostId: string; bookingId: string }
  | { kind: "invitee"; confirmationToken: string };

type BookingTransaction = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

async function getLockedBooking(transaction: BookingTransaction, selector: BookingActionSelector) {
  const condition = selector.kind === "host"
    ? and(eq(booking.id, selector.bookingId), eq(booking.hostId, selector.hostId))
    : eq(booking.confirmationToken, selector.confirmationToken);
  const [owner] = await transaction.select({ hostId: booking.hostId }).from(booking).where(condition);
  if (!owner) throw new BookingNotFoundError();
  await lockBookingHost(transaction, owner.hostId);
  const [record] = await transaction.select().from(booking).where(condition).for("update");
  if (!record) throw new BookingNotFoundError();
  return record;
}

async function lockEventForBooking(
  transaction: BookingTransaction,
  hostId: string,
  eventTypeId: string,
) {
  const [event] = await transaction
    .select({ id: eventType.id, userId: eventType.userId, active: eventType.active, durationMinutes: eventType.durationMinutes })
    .from(eventType)
    .where(and(eq(eventType.id, eventTypeId), eq(eventType.userId, hostId)))
    .for("update");
  if (!event) throw new BookingNotFoundError();
  return event;
}

async function checkCalendarConflict(transaction: BookingTransaction, hostId: string, interval: { start: Date; end: Date }) {
  const busy = await googleBusyTimes(hostId, interval.start, interval.end, transaction);
  if (busy.some((entry) => intervalsOverlap(interval, entry))) throw new SlotTakenError();
}

async function lockBookingHost(transaction: BookingTransaction, hostId: string) {
  // An event row only protects one page. Serialize every time-changing write for this host.
  const [host] = await transaction.select({ id: user.id }).from(user)
    .where(eq(user.id, hostId)).for("no key update");
  if (!host) throw new BookingNotFoundError();
}

async function cancelBooking(selector: BookingActionSelector, actor: "host" | "invitee", reasonValue: unknown) {
  const validatedReason = validateCancellationReason(reasonValue);
  if (!validatedReason.ok) throw new Error(validatedReason.error);

  const result = await getDb().transaction(async (transaction) => {
    const existing = await getLockedBooking(transaction, selector);
    const now = new Date();
    if (existing.status !== "active" || existing.startUtc.getTime() <= now.getTime()) {
      throw new BookingNotAvailableError();
    }

    const [cancelled] = await transaction
      .update(booking)
      .set({
        status: "cancelled",
        cancelledAt: now,
        cancellationActor: actor,
        cancellationReason: validatedReason.value,
        updatedAt: now,
      })
      .where(and(eq(booking.id, existing.id), eq(booking.status, "active"), gt(booking.startUtc, now)))
      .returning({ id: booking.id });
    if (!cancelled) throw new BookingNotAvailableError();
    const deliveryId = await queueBookingEmail(transaction, cancelled.id, "cancelled");
    return { cancelled, deliveryId };
  });
  await deliverBookingEmail(result.deliveryId);
  return result.cancelled;
}

export function cancelBookingAsHost(input: { hostId: string; bookingId: string; reason?: unknown }) {
  return cancelBooking({ kind: "host", hostId: input.hostId, bookingId: input.bookingId }, "host", input.reason);
}

export function cancelBookingByConfirmationToken(input: { confirmationToken: string; reason?: unknown }) {
  return cancelBooking({ kind: "invitee", confirmationToken: input.confirmationToken }, "invitee", input.reason);
}

async function rescheduleBooking(selector: BookingActionSelector, startUtc: Date) {
  if (!(startUtc instanceof Date) || !Number.isFinite(startUtc.getTime())) throw new StaleBookingDetailsError();

  const result = await getDb().transaction(async (transaction) => {
    const existing = await getLockedBooking(transaction, selector);
    const now = new Date();
    if (existing.status !== "active" || existing.startUtc.getTime() <= now.getTime()) {
      throw new BookingNotAvailableError();
    }
    if (existing.bookingLinkId) {
      const [link] = await transaction
        .select({ kind: bookingLink.kind })
        .from(bookingLink)
        .where(eq(bookingLink.id, existing.bookingLinkId))
        .limit(1);
      if (link?.kind === "one_off") throw new OneOffBookingCannotRescheduleError();
    }
    if (!existing.eventTypeId) throw new BookingNotAvailableError();
    if (startUtc.getTime() <= now.getTime()) throw new StaleBookingDetailsError();
    if (existing.startUtc.getTime() === startUtc.getTime()) throw new StaleBookingDetailsError();

    const durationMinutes = (existing.endUtc.getTime() - existing.startUtc.getTime()) / 60_000;
    const [host] = await transaction
      .select({ timezone: user.timezone })
      .from(user)
      .where(eq(user.id, existing.hostId))
      .limit(1);
    if (!host || !isIanaTimezone(host.timezone) || !isIanaTimezone(existing.inviteeTimezone)) {
      throw new StaleBookingDetailsError();
    }

    const endUtc = new Date(startUtc.getTime() + durationMinutes * 60_000);
    const slots = await getAvailableSlots({
      hostId: existing.hostId,
      hostTimezone: host.timezone,
      durationMinutes,
      date: getDateInTimezone(startUtc, existing.inviteeTimezone),
      timezone: existing.inviteeTimezone,
      executor: transaction,
      excludeBookingId: existing.id,
      applySchedulingLimits: existing.pollId === null,
    });
    if (!slots.some((slot) => slot.getTime() === startUtc.getTime())) throw new StaleBookingDetailsError();

    const rules = await getAvailabilityRules(existing.hostId, transaction);
    await checkCalendarConflict(transaction, existing.hostId, bufferedInterval(startUtc, endUtc, rules));

    const history = Array.isArray(existing.rescheduleHistory) ? existing.rescheduleHistory : [];
    const [updated] = await transaction
      .update(booking)
      .set({
        startUtc,
        endUtc,
        rescheduleHistory: [...history, { startUtc: existing.startUtc.toISOString(), endUtc: existing.endUtc.toISOString() }],
        updatedAt: new Date(),
      })
      .where(and(eq(booking.id, existing.id), eq(booking.status, "active"), gt(booking.startUtc, now)))
      .returning({ id: booking.id });
    if (!updated) throw new BookingNotAvailableError();

    await upsertBookingContact(transaction, existing.hostId, existing.inviteeName, existing.inviteeEmail);
    const deliveryId = await queueBookingEmail(transaction, updated.id, "rescheduled");
    return { updated, deliveryId };
  }).catch(async (error: unknown) => {
    await recordCalendarFailure(error);
    throw error;
  });
  await deliverBookingEmail(result.deliveryId);
  return result.updated;
}

export function rescheduleBookingAsHost(input: { hostId: string; bookingId: string; startUtc: Date }) {
  return rescheduleBooking({ kind: "host", hostId: input.hostId, bookingId: input.bookingId }, input.startUtc);
}

export function rescheduleBookingByConfirmationToken(input: { confirmationToken: string; startUtc: Date }) {
  return rescheduleBooking({ kind: "invitee", confirmationToken: input.confirmationToken }, input.startUtc);
}
