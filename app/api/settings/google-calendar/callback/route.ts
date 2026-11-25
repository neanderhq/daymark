import { getAuth } from "../../../../../server/auth";
import { completeGoogleCalendar } from "../../../../../server/google-calendar";

export async function GET(request: Request) {
  const session = await getAuth().api.getSession({ headers: request.headers });
  const query = new URL(request.url).searchParams;
  const status = session ? await completeGoogleCalendar(
    session.user.id, session.session.id, query.get("state"), query.get("code"), query.has("error"),
  ) : "invalid";
  return new Response(null, {
    status: 303, headers: { Location: `/settings?calendar=${status}#google-calendar`, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}
