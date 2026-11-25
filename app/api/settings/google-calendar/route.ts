import { getAuth } from "../../../../server/auth";
import { disconnectGoogleCalendar, startGoogleCalendar } from "../../../../server/google-calendar";

export async function POST(request: Request) {
  const session = await getAuth().api.getSession({ headers: request.headers });
  if (!session) return Response.json({ error: "Sign in to manage your calendar." }, { status: 401 });
  const url = await startGoogleCalendar(session.user.id, session.session.id);
  if (!url) return Response.json({ error: "Google Calendar is not configured." }, { status: 409 });
  return new Response(null, { status: 303, headers: { Location: url, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}

export async function DELETE(request: Request) {
  const session = await getAuth().api.getSession({ headers: request.headers });
  if (!session) return Response.json({ error: "Sign in to manage your calendar." }, { status: 401 });
  await disconnectGoogleCalendar(session.user.id);
  return new Response(null, { status: 204 });
}
