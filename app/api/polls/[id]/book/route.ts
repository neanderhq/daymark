import { calendarErrorResponse } from "../../../../../server/google-calendar";
import { getAuth } from "../../../../../server/auth";
import {
  invalidBookingDetailsMessage,
  SlotTakenError,
  slotTakenMessage,
  StaleBookingDetailsError,
} from "../../../../../server/bookings";
import {
  AlreadyVotedError,
  bookPollOption,
  invalidOptionIdsMessage,
  invalidPollDetailsMessage,
  PollBookedError,
  PollNotFoundError,
  pollNotFoundMessage,
} from "../../../../../server/polls";
import { hasOnlyKeys, readJsonBody } from "../../../../../server/scheduling";
import { parseUtcStart } from "../../../bookings/action-utils";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  const session = await getAuth().api.getSession({ headers: request.headers });
  if (!session) return Response.json({ error: "Sign in to book this time." }, { status: 401 });

  const { id } = await context.params;
  const body = await readJsonBody(request);
  if (!body || !hasOnlyKeys(body, ["startUtc", "extraAttendees"]) || !("startUtc" in body)) {
    return Response.json({ error: invalidPollDetailsMessage }, { status: 400 });
  }
  const startUtc = parseUtcStart(body.startUtc);
  if (!startUtc) return Response.json({ error: "Enter a valid UTC start time." }, { status: 400 });

  let extraAttendees: { name: string; email: string }[] | undefined;
  if (body.extraAttendees !== undefined) {
    if (!Array.isArray(body.extraAttendees) || body.extraAttendees.length > 40) {
      return Response.json({ error: invalidPollDetailsMessage }, { status: 400 });
    }
    const validAttendees = body.extraAttendees.every((attendee) => {
      if (!attendee || typeof attendee !== "object" || Array.isArray(attendee)) return false;
      if (!hasOnlyKeys(attendee, ["name", "email"])) return false;
      return typeof attendee.name === "string" && typeof attendee.email === "string";
    });
    if (!validAttendees) return Response.json({ error: invalidPollDetailsMessage }, { status: 400 });
    extraAttendees = body.extraAttendees as { name: string; email: string }[];
  }

  try {
    const created = await bookPollOption({
      hostId: session.user.id,
      pollId: id,
      startUtc,
      extraAttendees,
    });
    return Response.json(created, { status: 201 });
  } catch (error) {
    const calendarUnavailable = calendarErrorResponse(error);
    if (calendarUnavailable) return calendarUnavailable;
    if (error instanceof PollNotFoundError) {
      return Response.json({ error: pollNotFoundMessage }, { status: 404 });
    }
    if (error instanceof SlotTakenError) {
      return Response.json({ error: slotTakenMessage }, { status: 409 });
    }
    if (error instanceof StaleBookingDetailsError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    if (
      error instanceof Error &&
      (error.message === invalidPollDetailsMessage ||
        error.message === invalidOptionIdsMessage ||
        error.message === invalidBookingDetailsMessage)
    ) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    return Response.json({ error: "Unable to book this time." }, { status: 500 });
  }
}
