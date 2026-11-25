import { cancelBookingByConfirmationToken, validateCancellationReason } from "../../../../../../server/bookings";
import { hasOnlyKeys, readJsonBody } from "../../../../../../server/scheduling";
import { bookingActionErrorResponse } from "../../../../bookings/action-utils";

type RouteContext = { params: Promise<{ token: string }> };

const confirmationTokenPattern = /^(?:[A-Za-z0-9_-]{32}|[a-f0-9]{48})$/;

export async function POST(request: Request, context: RouteContext) {
  const { token } = await context.params;
  if (!confirmationTokenPattern.test(token)) {
    return Response.json({ error: "Booking not found." }, { status: 404 });
  }

  const body = await readJsonBody(request);
  if (!body || !hasOnlyKeys(body, ["reason"])) {
    return Response.json({ error: "Enter a valid cancellation reason." }, { status: 400 });
  }
  const reason = validateCancellationReason(body.reason);
  if (!reason.ok) return Response.json({ error: reason.error }, { status: 400 });

  try {
    const cancelled = await cancelBookingByConfirmationToken({ confirmationToken: token, reason: reason.value });
    return Response.json(cancelled);
  } catch (error) {
    return bookingActionErrorResponse(error);
  }
}
