import { calendarErrorResponse } from "../../../../../server/google-calendar";
import {
  BookingLinkAlreadyUsedError,
  BookingLinkNotFoundError,
  BookingLinkUnavailableError,
  SlotTakenError,
  StaleBookingDetailsError,
  createBooking,
  invalidBookingDetailsMessage,
  slotTakenMessage,
  validateBookingInput,
} from "../../../../../server/bookings";
import {
  bookingLinkTokenPattern,
  getPublicBookingLink,
} from "../../../../../server/booking-links";
import { getQuestions, hasOnlyKeys, readJsonBody } from "../../../../../server/scheduling";
import { getAvailabilityRules } from "../../../../../server/slots";

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

export async function GET(_request: Request, context: RouteContext) {
  const { token } = await context.params;
  if (!bookingLinkTokenPattern.test(token)) {
    return Response.json({ error: "This link is no longer available" }, { status: 404 });
  }

  try {
    const link = await getPublicBookingLink(token);
    const questions = link.kind === "event_type" ? await getQuestions(link.hostId) : [];
    const rules = await getAvailabilityRules(link.hostId);
    return Response.json({
      kind: link.kind,
      bookingHorizonDays: rules.bookingHorizonDays,
      host: { name: link.hostName, timezone: link.hostTimezone, username: link.username },
      meeting: {
        name: link.name,
        durationMinutes: link.durationMinutes,
        description: link.description,
        location: link.location,
      },
      questions: questions.map(({ id, label, questionType, options, required }) => ({
        id,
        label,
        questionType,
        options,
        required,
      })),
      ...(link.kind === "one_off" ? { proposedStarts: link.proposedStarts.map((start) => start.toISOString()) } : {}),
    });
  } catch (error) {
    return unavailableResponse(error) ?? Response.json({ error: "Unable to load this booking link." }, { status: 500 });
  }
}

export async function POST(request: Request, context: RouteContext) {
  const { token } = await context.params;
  if (!bookingLinkTokenPattern.test(token)) {
    return Response.json({ error: "This link is no longer available" }, { status: 404 });
  }

  const body = await readJsonBody(request);
  const allowedKeys = ["name", "email", "timezone", "startUtc", "answers"];
  if (!body || !hasOnlyKeys(body, allowedKeys)) {
    return Response.json({ error: invalidBookingDetailsMessage }, { status: 400 });
  }

  try {
    const link = await getPublicBookingLink(token);
    const questions = link.kind === "event_type" ? await getQuestions(link.hostId) : [];
    const validated = validateBookingInput(body, questions);
    if (!validated.ok) return Response.json({ error: validated.error }, { status: 400 });

    const created = await createBooking({
      hostId: link.hostId,
      bookingLinkId: link.id,
      ...(link.eventTypeId ? { eventTypeId: link.eventTypeId } : {}),
      startUtc: validated.value.startUtc,
      endUtc: new Date(validated.value.startUtc.getTime() + link.durationMinutes * 60_000),
      inviteeName: validated.value.inviteeName,
      inviteeEmail: validated.value.inviteeEmail,
      inviteeTimezone: validated.value.inviteeTimezone,
      answers: validated.value.answers,
    });
    return Response.json(created, { status: 201 });
  } catch (error) {
    const calendarUnavailable = calendarErrorResponse(error);
    if (calendarUnavailable) return calendarUnavailable;
    const unavailable = unavailableResponse(error);
    if (unavailable) return unavailable;
    if (error instanceof SlotTakenError) return Response.json({ error: slotTakenMessage }, { status: 409 });
    if (error instanceof StaleBookingDetailsError) return Response.json({ error: error.message }, { status: 409 });
    return Response.json({ error: "Unable to create this booking." }, { status: 500 });
  }
}
