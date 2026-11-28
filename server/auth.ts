import { createHash } from "node:crypto";
import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { getAuth as firebaseAuth } from "firebase-admin/auth";
import { and, eq, gt } from "drizzle-orm";
import { getDb } from "./db";
import { session, user } from "./schema";

export function authConfiguration() {
  const config = {
    apiKey: process.env.NEANDER_AUTH_API_KEY,
    authDomain: process.env.NEANDER_AUTH_DOMAIN,
    projectId: process.env.NEANDER_AUTH_PROJECT_ID,
    tenantId: process.env.NEANDER_AUTH_TENANT_ID,
  };
  if (Object.values(config).some(value => !value)) throw new Error("Managed sign-in is still being provisioned.");
  let emulatorUrl: string | undefined;
  if (process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    const origin = new URL(process.env.DAYMARK_APP_URL!);
    const emulator = new URL(process.env.DAYMARK_TEST_AUTH_EMULATOR_URL!);
    if (origin.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(origin.hostname)
      || emulator.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(emulator.hostname)) {
      throw new Error("Auth emulators are limited to isolated loopback tests.");
    }
    emulatorUrl = emulator.origin;
  }
  return { ...config as { [K in keyof typeof config]: string }, emulatorUrl };
}

export function tenantAuth() {
  const config = authConfiguration();
  const app = getApps().find(app => app.name === "daymark") ?? initializeApp({
    projectId: config.projectId, credential: applicationDefault(),
  }, "daymark");
  return firebaseAuth(app).tenantManager().authForTenant(config.tenantId);
}

export function sessionCookieName() {
  return "daymark." + authConfiguration().tenantId + ".session";
}

export function sessionCookie(headers: Headers) {
  return (headers.get("cookie") ?? "").split(";").map(value => value.trim())
    .find(value => value.startsWith(sessionCookieName() + "="))?.split("=").slice(1).join("=");
}

export function sessionId(cookie: string) {
  return createHash("sha256").update(cookie).digest("hex");
}

async function getSession({ headers }: { headers: Headers }) {
  if (!headers.get("cookie")) return null;
  const cookie = sessionCookie(headers);
  if (!cookie) return null;
  try {
    const identity = await tenantAuth().verifySessionCookie(cookie, true);
    const [lease] = await getDb().select().from(session).where(and(eq(session.id, sessionId(cookie)), eq(session.userId, identity.uid), gt(session.expiresAt, new Date()))).limit(1);
    if (!lease) return null;
    const [profile] = await getDb().select().from(user).where(eq(user.id, identity.uid)).limit(1);
    return profile ? { user: profile, session: lease } : null;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (["auth/argument-error", "auth/invalid-session-cookie", "auth/session-cookie-expired", "auth/session-cookie-revoked",
      "auth/user-disabled", "auth/user-not-found", "auth/tenant-id-mismatch"].includes(code ?? "")) return null;
    throw error;
  }
}

// Existing pages and domain routes share this authoritative native session reader.
export function getAuth() { return { api: { getSession } }; }
