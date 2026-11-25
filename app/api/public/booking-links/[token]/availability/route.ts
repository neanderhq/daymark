import { availabilityDates, availabilityPayload } from "../../../../../../server/calendar-availability";
import { BookingLinkAlreadyUsedError, BookingLinkNotFoundError, BookingLinkUnavailableError } from "../../../../../../server/bookings";
import { bookingLinkTokenPattern, getPublicBookingLink, proposedStartsForDate } from "../../../../../../server/booking-links";
import { getAvailableProposedStarts, getAvailableSlots } from "../../../../../../server/slots";
import { calendarErrorResponse, googleBusyForDates } from "../../../../../../server/google-calendar";
import { getDateInTimezone, isIanaTimezone } from "../../../../../../server/timezone";

type RouteContext = { params: Promise<{ token: string }> };

function unavailableResponse(error: unknown) {
  if (error instanceof BookingLinkAlreadyUsedError) {
    return Response.json({ error: "This link has already been used" }, { status: 410 });
  }
  if (error instanceof BookingLinkUnavailableError) {
    return Response.json({ error: "This link is no longer available" }, { status: 410 });
  }
  if (error instanceof BookingLinkNotFoundError) {
    return Response.json({ error: "This link is no longer available" }, { status: 404 });
  }
  return null;
}

export async function GET(request: Request, context: RouteContext) {
  const { token } = await context.params;
  if (!bookingLinkTokenPattern.test(token)) {
    return Response.json({ error: "This link is no longer available" }, { status: 404 });
  }

  const query = new URL(request.url).searchParams;
  const dates = availabilityDates(query);
  const timezone = query.get("tz");
  if (!dates) return Response.json({ error: "Choose a date." }, { status: 400 });
  if (!isIanaTimezone(timezone)) return Response.json({ error: "Enter a valid IANA timezone." }, { status: 400 });

  try {
    const link = await getPublicBookingLink(token);
    const busyTimes = await googleBusyForDates(link.hostId, dates);
    if (link.kind === "event_type") {
      const payload = await availabilityPayload(dates, query.has("month"), date => getAvailableSlots({
        hostId: link.hostId,
        hostTimezone: link.hostTimezone,
        durationMinutes: link.durationMinutes,
        date,
        timezone,
        busyTimes,
      }));
      return Response.json(payload);
    }

    const payload = await availabilityPayload(dates, query.has("month"), async date => {
      const proposed = proposedStartsForDate(link.proposedStarts ?? [], date, timezone);
      const free = await getAvailableProposedStarts({ hostId: link.hostId, hostTimezone: link.hostTimezone, durationMinutes: link.durationMinutes, starts: proposed, busyTimes });
      return free.filter(start => getDateInTimezone(start, timezone) === date);
    });
    return Response.json(payload);
  } catch (error) {
    return unavailableResponse(error) ?? calendarErrorResponse(error) ?? Response.json({ error: "Unable to load available times." }, { status: 500 });
  }
}
