import { eq } from "drizzle-orm";
import { getAuth } from "../../../server/auth";
import { getDb } from "../../../server/db";
import { invalidEmailMessage, invalidNameMessage, invalidTimezoneMessage, normalizeEmail, normalizeUserName } from "../../../server/profile-validation";
import { user } from "../../../server/schema";
import { isIanaTimezone } from "../../../server/timezone";

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("code" in error && error.code === "23505") return true;
  return "cause" in error && isUniqueViolation(error.cause);
}

export async function PATCH(request: Request) {
  const session = await getAuth().api.getSession({ headers: request.headers });
  if (!session) return Response.json({ error: "Sign in to update your profile." }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Enter valid profile details." }, { status: 400 });
  }

  if (!body || typeof body !== "object") return Response.json({ error: "Enter valid profile details." }, { status: 400 });
  const { name, email, timezone } = body as Record<string, unknown>;
  const normalizedName = normalizeUserName(name);
  if (normalizedName === null) {
    return Response.json({ error: invalidNameMessage }, { status: 400 });
  }
  const normalizedEmail = normalizeEmail(email);
  if (normalizedEmail === null) return Response.json({ error: invalidEmailMessage }, { status: 400 });
  if (normalizedEmail !== session.user.email.toLowerCase()) return Response.json({ error: "Your email address is managed by sign-in." }, { status: 400 });
  if (!isIanaTimezone(timezone)) return Response.json({ error: invalidTimezoneMessage }, { status: 400 });

  try {
    const [updated] = await getDb()
      .update(user)
      .set({
        name: normalizedName,
        email: normalizedEmail,
        timezone,
        emailVerified: normalizedEmail === session.user.email.toLowerCase() ? session.user.emailVerified : false,
        updatedAt: new Date(),
      })
      .where(eq(user.id, session.user.id))
      .returning({ id: user.id, name: user.name, email: user.email, timezone: user.timezone });
    if (!updated) return Response.json({ error: "Profile not found." }, { status: 404 });
    return Response.json(updated);
  } catch (error) {
    if (isUniqueViolation(error)) {
      return Response.json({ error: "An account already uses that email address." }, { status: 409 });
    }
    throw error;
  }
}
