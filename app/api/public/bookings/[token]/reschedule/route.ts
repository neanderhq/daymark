import { rescheduleBookingByConfirmationToken } from "../../../../../../server/bookings";
import { hasOnlyKeys, readJsonBody } from "../../../../../../server/scheduling";
import { bookingActionErrorResponse, parseUtcStart } from "../../../../bookings/action-utils";

type RouteContext = { params: Promise<{ token: string }> };

const confirmationTokenPattern = /^(?:[A-Za-z0-9_-]{32}|[a-f0-9]{48})$/;

export async function POST(request: Request, context: RouteContext) {
  const { token } = await context.params;
  if (!confirmationTokenPattern.test(token)) {
    return Response.json({ error: "Booking not found." }, { status: 404 });
  }

  const body = await readJsonBody(request);
  if (!body || !hasOnlyKeys(body, ["startUtc"])) {
    return Response.json({ error: "Enter a valid UTC start time." }, { status: 400 });
  }
  const startUtc = parseUtcStart(body.startUtc);
  if (!startUtc) return Response.json({ error: "Enter a valid UTC start time." }, { status: 400 });

  try {
    const updated = await rescheduleBookingByConfirmationToken({ confirmationToken: token, startUtc });
    return Response.json({ ...updated, startUtc: startUtc.toISOString() });
  } catch (error) {
    return bookingActionErrorResponse(error);
  }
}
