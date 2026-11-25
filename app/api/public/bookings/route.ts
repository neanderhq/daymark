import { calendarErrorResponse } from "../../../../server/google-calendar";
import { and, eq, gt, lt } from "drizzle-orm";

import {
  createBooking,
  invalidBookingDetailsMessage,
  SlotTakenError,
  slotTakenMessage,
  StaleBookingDetailsError,
  validateBookingInput,
} from "../../../../server/bookings";
import { getDb } from "../../../../server/db";
import { normalizeSlug } from "../../../../server/profile-validation";
import { getQuestions, hasOnlyKeys, readJsonBody } from "../../../../server/scheduling";
import { getAvailableSlots } from "../../../../server/slots";
import { booking, eventType, user } from "../../../../server/schema";
import { getDateInTimezone } from "../../../../server/timezone";

const allowedKeys = ["username", "eventSlug", "startUtc", "timezone", "name", "email", "answers"];

export async function POST(request: Request) {
  const body = await readJsonBody(request);
  if (!body || !hasOnlyKeys(body, allowedKeys)) {
    return Response.json({ error: invalidBookingDetailsMessage }, { status: 400 });
  }
  const username = normalizeSlug(body.username);
  const eventSlug = normalizeSlug(body.eventSlug);
  if (username === null || eventSlug === null) {
    return Response.json({ error: invalidBookingDetailsMessage }, { status: 400 });
  }

  const [event] = await getDb()
    .select({
      id: eventType.id,
      durationMinutes: eventType.durationMinutes,
      hostId: user.id,
      hostTimezone: user.timezone,
    })
    .from(eventType)
    .innerJoin(user, eq(eventType.userId, user.id))
    .where(and(eq(user.username, username), eq(eventType.slug, eventSlug), eq(eventType.active, true)))
    .limit(1);
  if (!event) return Response.json({ error: "This booking page isn’t available." }, { status: 404 });

  const questions = await getQuestions(event.hostId);
  const validated = validateBookingInput(body, questions);
  if (!validated.ok) return Response.json({ error: validated.error }, { status: 400 });

  const value = validated.value;
  const endUtc = new Date(value.startUtc.getTime() + event.durationMinutes * 60_000);
  const availableSlots = await getAvailableSlots({
    hostId: event.hostId,
    hostTimezone: event.hostTimezone,
    durationMinutes: event.durationMinutes,
    date: getDateInTimezone(value.startUtc, value.inviteeTimezone),
    timezone: value.inviteeTimezone,
  });
  const isAvailable = availableSlots.some((slot) => slot.getTime() === value.startUtc.getTime());
  if (!isAvailable) {
    const overlaps = await getDb()
      .select({ id: booking.id })
      .from(booking)
      .where(
        and(
          eq(booking.hostId, event.hostId),
          eq(booking.status, "active"),
          lt(booking.startUtc, endUtc),
          gt(booking.endUtc, value.startUtc),
        ),
      )
      .limit(1);
    if (overlaps[0]) return Response.json({ error: slotTakenMessage }, { status: 409 });
    return Response.json({ error: "Choose an available time." }, { status: 400 });
  }

  try {
    const created = await createBooking({
      hostId: event.hostId,
      eventTypeId: event.id,
      startUtc: value.startUtc,
      endUtc,
      inviteeName: value.inviteeName,
      inviteeEmail: value.inviteeEmail,
      inviteeTimezone: value.inviteeTimezone,
      answers: value.answers,
    });
    return Response.json(created, { status: 201 });
  } catch (error) {
    const calendarUnavailable = calendarErrorResponse(error);
    if (calendarUnavailable) return calendarUnavailable;
    if (error instanceof StaleBookingDetailsError) {
      return Response.json({ error: "Choose an available time." }, { status: 400 });
    }
    if (error instanceof SlotTakenError) {
      return Response.json({ error: slotTakenMessage }, { status: 409 });
    }
    throw error;
  }
}
