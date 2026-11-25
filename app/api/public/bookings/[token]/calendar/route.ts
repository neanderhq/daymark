import { and, eq } from "drizzle-orm";

import { getDb } from "../../../../../../server/db";
import { booking, bookingLink, eventType, poll } from "../../../../../../server/schema";
import { calendarFile } from "../../../../../../server/calendar-file";

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const [record] = await getDb().select({
    id: booking.id, start: booking.startUtc, end: booking.endUtc, stamp: booking.updatedAt,
    history: booking.rescheduleHistory, title: eventType.name, pollTitle: poll.title,
    linkTitle: bookingLink.meetingName, location: eventType.location, linkLocation: bookingLink.location,
  }).from(booking).leftJoin(eventType, eq(booking.eventTypeId, eventType.id))
    .leftJoin(bookingLink, eq(booking.bookingLinkId, bookingLink.id))
    .leftJoin(poll, eq(booking.pollId, poll.id))
    .where(and(eq(booking.confirmationToken, token), eq(booking.status, "active"))).limit(1);

  const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };
  if (!record) return new Response("Calendar file unavailable.", { status: 404, headers });
  return new Response(calendarFile({
    ...record, revision: record.history.length, name: record.pollTitle ?? record.linkTitle ?? record.title ?? "Meeting",
    location: record.linkLocation ?? record.location,
  }), { headers: { ...headers, "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": "attachment; filename=daymark.ics" } });
}
