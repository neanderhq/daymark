import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { authConfiguration, sessionCookie, sessionCookieName, sessionId, tenantAuth } from "../../../../server/auth";
import { getDb } from "../../../../server/db";
import { session as sessions, user } from "../../../../server/schema";
import { normalizeUserName } from "../../../../server/profile-validation";
import { isIanaTimezone } from "../../../../server/timezone";

const expiresIn = 5 * 24 * 60 * 60 * 1000;
function validOrigin(request: Request) {
  return request.headers.get("origin") === new URL(process.env.DAYMARK_APP_URL!).origin;
}

export function GET() {
  try { return Response.json(authConfiguration(), { headers: { "Cache-Control": "no-store" } }); }
  catch { return Response.json({ error: "Sign-in is still being prepared. Try again shortly." }, { status: 503 }); }
}

export async function POST(request: Request) {
  if (!validOrigin(request)) return Response.json({ error: "Request origin rejected." }, { status: 403 });
  const input = await request.json().catch(() => null);
  if (!input || typeof input.idToken !== "string" || input.idToken.length > 20000) return Response.json({ error: "Sign in again." }, { status: 400 });
  try {
    const identity = await tenantAuth().verifyIdToken(input.idToken, true);
    if (!identity.email || Date.now() / 1000 - identity.auth_time > 300) return Response.json({ error: "Sign in again." }, { status: 401 });
    const name = normalizeUserName(input.name ?? identity.name ?? identity.email.split("@")[0]);
    if (!name || !isIanaTimezone(input.timezone)) return Response.json({ error: "Enter a valid name and time zone." }, { status: 400 });
    // Never link a native UID to a different existing host based on email alone.
    await getDb().insert(user).values({
      id: identity.uid, name, email: identity.email.toLowerCase(),
      emailVerified: Boolean(identity.email_verified), timezone: input.timezone,
      username: "host-" + createHash("sha256").update(identity.uid).digest("hex").slice(0, 12),
    }).onConflictDoNothing({ target: user.id });
    const session = await tenantAuth().createSessionCookie(input.idToken, { expiresIn });
    const id = sessionId(session);
    // Only a one-way hash is stored; Firebase remains the credential verifier.
    await getDb().insert(sessions).values({ id, token: id, userId: identity.uid, expiresAt: new Date(Date.now() + expiresIn), updatedAt: new Date() }).onConflictDoNothing({ target: sessions.id });
    const response = NextResponse.json({ ok: true });
    response.cookies.set(sessionCookieName(), session, {
      httpOnly: true, sameSite: "lax", secure: new URL(process.env.DAYMARK_APP_URL!).protocol === "https:",
      path: "/", maxAge: expiresIn / 1000,
    });
    return response;
  } catch (error) {
    const code = (error as { code?: string }).code ?? "unavailable";
    const invalid = ["auth/argument-error", "auth/invalid-id-token", "auth/id-token-expired", "auth/id-token-revoked", "auth/user-disabled", "auth/tenant-id-mismatch"].includes(code);
    console.error("Managed sign-in failed", { code });
    return Response.json({ error: invalid ? "Sign in again." : "Managed sign-in is unavailable. Try again shortly." }, { status: invalid ? 401 : 503 });
  }
}

export async function DELETE(request: Request) {
  if (!validOrigin(request)) return Response.json({ error: "Request origin rejected." }, { status: 403 });
  const cookie = sessionCookie(request.headers);
  if (cookie) await getDb().delete(sessions).where(eq(sessions.id, sessionId(cookie)));
  const response = NextResponse.json({ ok: true });
  response.cookies.set(sessionCookieName(), "", {
    httpOnly: true, sameSite: "lax", secure: new URL(process.env.DAYMARK_APP_URL!).protocol === "https:", path: "/", maxAge: 0,
  });
  return response;
}
