import { getAuth } from "../../../../server/auth";
import { bookingEmailConfigured, retryBookingEmails } from "../../../../server/booking-email";

export async function POST(request: Request) {
  const session = await getAuth().api.getSession({ headers: request.headers });
  if (!session) return Response.json({ error: "Sign in to retry booking emails." }, { status: 401 });
  if (!bookingEmailConfigured()) return Response.json({ error: "Booking email is not configured." }, { status: 409 });
  return Response.json({ attempted: await retryBookingEmails(session.user.id) });
}
