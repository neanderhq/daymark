import { and, eq, gt } from "drizzle-orm";

import { availabilityDates, availabilityPayload } from "../../../../server/calendar-availability";
import { getAuth } from "../../../../server/auth";
import { getDb } from "../../../../server/db";
import { invalidSlugMessage, invalidTimezoneMessage, normalizeSlug } from "../../../../server/profile-validation";
import { getAvailableSlots } from "../../../../server/slots";
import { booking, eventType, user } from "../../../../server/schema";
import { isIanaTimezone } from "../../../../server/timezone";

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  const username = normalizeSlug(query.get("username"));
  const eventSlug = normalizeSlug(query.get("eventSlug"));
  if (username === null || eventSlug === null) {
    return Response.json({ error: invalidSlugMessage }, { status: 400 });
  }

  const dates = availabilityDates(query);
  if (!dates) return Response.json({ error: "Choose a date." }, { status: 400 });

  const timezone = query.get("tz");
  if (!isIanaTimezone(timezone)) {
    return Response.json({ error: invalidTimezoneMessage }, { status: 400 });
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

  const rescheduleBookingId = query.get("rescheduleBookingId");
  const rescheduleToken = query.get("rescheduleToken");
  let isPollReschedule = false;
  let excludeBookingId: string | undefined;
  if (rescheduleBookingId || rescheduleToken) {
    if (rescheduleBookingId && rescheduleToken) {
      return Response.json({ error: "This booking is no longer available to change." }, { status: 400 });
    }
    const currentTime = new Date();
    const selector = rescheduleBookingId
      ? and(eq(booking.id, rescheduleBookingId), eq(booking.hostId, event.hostId))
      : eq(booking.confirmationToken, rescheduleToken!);
    const [reschedulingBooking] = await getDb()
      .select({
        id: booking.id,
        hostId: booking.hostId,
        eventTypeId: booking.eventTypeId,
        pollId: booking.pollId,
        status: booking.status,
        startUtc: booking.startUtc,
      })
      .from(booking)
      .where(and(selector, eq(booking.status, "active"), gt(booking.startUtc, currentTime)))
      .limit(1);
    if (!reschedulingBooking || reschedulingBooking.eventTypeId !== event.id) {
      return Response.json({ error: "This booking is no longer available to change." }, { status: 404 });
    }
    if (rescheduleBookingId) {
      const session = await getAuth().api.getSession({ headers: request.headers });
      if (!session || session.user.id !== reschedulingBooking.hostId) {
        return Response.json({ error: "This booking is no longer available to change." }, { status: 404 });
      }
    }
    excludeBookingId = reschedulingBooking.id;
    isPollReschedule = reschedulingBooking.pollId !== null;
  }

  const payload = await availabilityPayload(dates, query.has("month"), date => getAvailableSlots({
    hostId: event.hostId,
    hostTimezone: event.hostTimezone,
    durationMinutes: event.durationMinutes,
    date,
    timezone,
    excludeBookingId,
    applySchedulingLimits: !isPollReschedule,
  }));
  return Response.json(payload);
}
