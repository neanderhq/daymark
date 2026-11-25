import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";

import { getDb, type DbTransaction } from "./db";
import { providerEndpoint } from "./provider-endpoints";
import { googleCalendarConnection, googleCalendarRequest, user } from "./schema";

const scope = "https://www.googleapis.com/auth/calendar.freebusy";
const callbackPath = "/api/settings/google-calendar/callback";
const publicError = "The host’s calendar is temporarily unavailable. Try again or contact the host.";

export type BusyInterval = { start: Date; end: Date };
type Connection = typeof googleCalendarConnection.$inferSelect;
type Tokens = { access_token: string; expires_in: number; refresh_token?: string; scope?: string };

export class CalendarUnavailableError extends Error {
  constructor(public reconnect = false, public connection?: Pick<Connection, "hostId" | "id" | "accessCipher">) {
    super(publicError);
  }
}

export function calendarErrorResponse(error: unknown): Response | null {
  return error instanceof CalendarUnavailableError ? Response.json({ error: publicError }, { status: 503 }) : null;
}

function configuration() {
  const { DAYMARK_GOOGLE_CLIENT_ID: clientId, DAYMARK_GOOGLE_CLIENT_SECRET: clientSecret, BETTER_AUTH_URL: origin, BETTER_AUTH_SECRET: secret } = process.env;
  return clientId && clientSecret && origin && secret ? { clientId, clientSecret, redirectUri: new URL(callbackPath, origin).href } : null;
}

function encryptionKey() {
  return createHmac("sha256", process.env.BETTER_AUTH_SECRET!).update("daymark/google-calendar/v1").digest();
}

function seal(hostId: string, value: string) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), nonce);
  cipher.setAAD(Buffer.from(hostId));
  const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [nonce, cipher.getAuthTag(), bytes].map((part) => part.toString("base64url")).join(".");
}

function open(hostId: string, value: string) {
  const [nonce, tag, ciphertext] = value.split(".").map((part) => Buffer.from(part, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), nonce);
  decipher.setAAD(Buffer.from(hostId));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

const hash = (value: string) => createHash("sha256").update(value).digest("base64url");

export async function startGoogleCalendar(hostId: string, sessionId: string) {
  const config = configuration();
  if (!config) return null;
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const request = {
    sessionId, stateHash: hash(state), verifierCipher: seal(hostId, verifier),
    expiresAt: new Date(Date.now() + 10 * 60_000), used: false,
  };
  await getDb().insert(googleCalendarRequest).values({ hostId, ...request })
    .onConflictDoUpdate({ target: googleCalendarRequest.hostId, set: request });

  const url = new URL(providerEndpoint("https://accounts.google.com/o/oauth2/v2/auth", "/google/authorize"));
  url.search = new URLSearchParams({
    client_id: config.clientId, redirect_uri: config.redirectUri, response_type: "code", scope, state,
    access_type: "offline", prompt: "consent", code_challenge: hash(verifier), code_challenge_method: "S256",
  }).toString();
  return url.href;
}

async function exchange(grant: Record<string, string>): Promise<Tokens> {
  const config = configuration();
  if (!config) throw new CalendarUnavailableError();
  let response: Response;
  try {
    response = await fetch(providerEndpoint("https://oauth2.googleapis.com/token", "/google/token"), {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(3_000),
      body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...grant }),
    });
  } catch {
    throw new CalendarUnavailableError();
  }
  const result = await response.json().catch(() => ({})) as Partial<Tokens> & { error?: string };
  if (!response.ok || typeof result.access_token !== "string" || !Number.isFinite(result.expires_in) || result.expires_in! <= 0) {
    throw new CalendarUnavailableError(result.error === "invalid_grant");
  }
  return result as Tokens;
}

async function readBusy(accessToken: string, start: Date, end: Date): Promise<BusyInterval[]> {
  let response: Response;
  try {
    response = await fetch(providerEndpoint("https://www.googleapis.com/calendar/v3/freeBusy", "/google/free-busy"), {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(3_000),
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ timeMin: start.toISOString(), timeMax: end.toISOString(), items: [{ id: "primary" }] }),
    });
  } catch {
    throw new CalendarUnavailableError();
  }
  const result = await response.json().catch(() => ({})) as {
    error?: { errors?: { reason?: string }[] };
    calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: { reason?: string }[] }>;
  };
  if (!response.ok) {
    const reason = result.error?.errors?.[0]?.reason;
    throw new CalendarUnavailableError(response.status === 401 || (response.status === 403 && reason === "insufficientPermissions"));
  }
  const calendars = Object.values(result.calendars ?? {});
  // Google may identify the primary calendar by its account address. The key is never returned to clients.
  const entry = calendars.length === 1 ? calendars[0] : undefined;
  if (!entry || entry.errors?.length || !Array.isArray(entry.busy)) {
    throw new CalendarUnavailableError(entry?.errors?.some(({ reason }) => reason === "notFound" || reason === "forbidden") ?? false);
  }
  return entry.busy.map((interval) => {
    const busy = { start: new Date(interval.start), end: new Date(interval.end) };
    if (!Number.isFinite(busy.start.getTime()) || !Number.isFinite(busy.end.getTime()) || busy.start >= busy.end) {
      throw new CalendarUnavailableError();
    }
    return busy;
  });
}

export async function completeGoogleCalendar(hostId: string, sessionId: string, state: string | null, code: string | null, denied: boolean) {
  const config = configuration();
  if (!config || !state || !/^[A-Za-z0-9_-]{43}$/.test(state)) return "invalid";
  const condition = and(eq(googleCalendarRequest.hostId, hostId), eq(googleCalendarRequest.sessionId, sessionId),
    eq(googleCalendarRequest.stateHash, hash(state)), gt(googleCalendarRequest.expiresAt, new Date()));
  const database = getDb();
  const [request] = await database.update(googleCalendarRequest).set({ used: true })
    .where(and(condition, eq(googleCalendarRequest.used, false))).returning();
  if (!request) return "invalid";
  if (!code || code.length > 4096 || denied) {
    await database.delete(googleCalendarRequest).where(condition);
    return denied ? "denied" : "invalid";
  }

  try {
    const tokens = await exchange({
      code, grant_type: "authorization_code", redirect_uri: config.redirectUri, code_verifier: open(hostId, request.verifierCipher),
    });
    if (!tokens.refresh_token || !tokens.scope?.split(/\s+/).includes(scope)) throw new CalendarUnavailableError();
    const now = new Date();
    await readBusy(tokens.access_token, now, new Date(now.getTime() + 60_000));
    const connection = {
      id: crypto.randomUUID(), refreshCipher: seal(hostId, tokens.refresh_token), accessCipher: seal(hostId, tokens.access_token),
      accessExpiresAt: new Date(now.getTime() + tokens.expires_in * 1_000), needsReconnect: false,
    };
    return await database.transaction(async (transaction) => {
      await transaction.select({ id: user.id }).from(user).where(eq(user.id, hostId)).for("no key update");
      const [claimed] = await transaction.delete(googleCalendarRequest).where(condition).returning({ hostId: googleCalendarRequest.hostId });
      if (!claimed) return "invalid";
      await transaction.insert(googleCalendarConnection).values({ hostId, ...connection })
        .onConflictDoUpdate({ target: googleCalendarConnection.hostId, set: connection });
      return "connected";
    });
  } catch {
    await database.delete(googleCalendarRequest).where(condition);
    return "unavailable";
  }
}

export async function disconnectGoogleCalendar(hostId: string) {
  await getDb().transaction(async (transaction) => {
    await transaction.select({ id: user.id }).from(user).where(eq(user.id, hostId)).for("no key update");
    await transaction.delete(googleCalendarRequest).where(eq(googleCalendarRequest.hostId, hostId));
    await transaction.delete(googleCalendarConnection).where(eq(googleCalendarConnection.hostId, hostId));
  });
}

export async function googleCalendarStatus(hostId: string) {
  const [connection] = await getDb().select({ needsReconnect: googleCalendarConnection.needsReconnect })
    .from(googleCalendarConnection).where(eq(googleCalendarConnection.hostId, hostId));
  return { configured: Boolean(configuration()), connected: Boolean(connection), reconnect: Boolean(connection?.needsReconnect) };
}

export async function recordCalendarFailure(error: unknown) {
  if (!(error instanceof CalendarUnavailableError) || !error.reconnect || !error.connection) return;
  await getDb().update(googleCalendarConnection).set({ needsReconnect: true }).where(and(
    eq(googleCalendarConnection.hostId, error.connection.hostId), eq(googleCalendarConnection.id, error.connection.id),
    eq(googleCalendarConnection.accessCipher, error.connection.accessCipher),
  ));
}

async function refreshAccess(connection: Connection, executor: ReturnType<typeof getDb> | DbTransaction) {
  const tokens = await exchange({ grant_type: "refresh_token", refresh_token: open(connection.hostId, connection.refreshCipher) });
  await executor.update(googleCalendarConnection).set({
    accessCipher: seal(connection.hostId, tokens.access_token),
    accessExpiresAt: new Date(Date.now() + tokens.expires_in * 1_000),
    ...(tokens.refresh_token ? { refreshCipher: seal(connection.hostId, tokens.refresh_token) } : {}),
  }).where(and(eq(googleCalendarConnection.hostId, connection.hostId), eq(googleCalendarConnection.id, connection.id)));
  return tokens.access_token;
}

export async function googleBusyTimes(hostId: string, start: Date, end: Date, transaction?: DbTransaction) {
  const executor = transaction ?? getDb();
  const [connection] = await executor.select().from(googleCalendarConnection).where(eq(googleCalendarConnection.hostId, hostId));
  if (!connection) return [];
  if (!configuration() || connection.needsReconnect) throw new CalendarUnavailableError();
  try {
    if (connection.accessExpiresAt.getTime() <= Date.now() + 45_000) {
      return await readBusy(await refreshAccess(connection, executor), start, end);
    }
    try {
      return await readBusy(open(hostId, connection.accessCipher), start, end);
    } catch (error) {
      if (error instanceof CalendarUnavailableError && error.reconnect) {
        return await readBusy(await refreshAccess(connection, executor), start, end);
      }
      throw error;
    }
  } catch (error) {
    const failure = new CalendarUnavailableError(error instanceof CalendarUnavailableError ? error.reconnect : true, connection);
    if (!transaction) await recordCalendarFailure(failure);
    throw failure;
  }
}

export function googleBusyForDates(hostId: string, dates: string[]) {
  // Calendar-day arguments are in the invitee's zone. The margins include all supported offsets and booking buffers.
  const margin = 2 * 86_400_000;
  return googleBusyTimes(hostId, new Date(Date.parse(dates[0]) - margin), new Date(Date.parse(dates[dates.length - 1]) + margin));
}
