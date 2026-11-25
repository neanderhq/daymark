import { and, count, desc, eq, lte, sql } from "drizzle-orm";

import { getDb, type DbTransaction } from "./db";
import { providerEndpoint } from "./provider-endpoints";
import { booking, bookingEmail, bookingLink, eventType, poll, type BookingEmailKind, type BookingEmailStatus } from "./schema";
import { formatInstant } from "./timezone";

const sendLabels = { confirmed: "Booking confirmed", rescheduled: "Booking rescheduled", cancelled: "Booking cancelled" };
const retryWindow = 23 * 60 * 60 * 1000;

export function bookingEmailConfigured(): boolean {
  return Boolean(process.env.DAYMARK_RESEND_API_KEY && process.env.DAYMARK_EMAIL_FROM && process.env.BETTER_AUTH_URL);
}

export async function queueBookingEmail(transaction: DbTransaction, bookingId: string, kind: BookingEmailKind) {
  const [record] = await transaction.select({
    recipient: booking.inviteeEmail, timezone: booking.inviteeTimezone, start: booking.startUtc, end: booking.endUtc,
    token: booking.confirmationToken, history: booking.rescheduleHistory, title: eventType.name,
    pollTitle: poll.title, oneOffTitle: bookingLink.meetingName,
  }).from(booking).leftJoin(eventType, eq(booking.eventTypeId, eventType.id))
    .leftJoin(bookingLink, eq(booking.bookingLinkId, bookingLink.id))
    .leftJoin(poll, eq(booking.pollId, poll.id)).where(eq(booking.id, bookingId));

  const id = crypto.randomUUID();
  const title = record.pollTitle ?? record.oneOffTitle ?? record.title ?? "Meeting";
  const origin = process.env.BETTER_AUTH_URL;
  const receipt = origin ? new URL(`/booking/${record.token}`, origin).href : null;
  const revision = record.history.length + (kind === "cancelled" ? 1 : 0);
  await transaction.update(bookingEmail).set({ status: "superseded" }).where(and(
    eq(bookingEmail.bookingId, bookingId), eq(bookingEmail.status, "pending"),
  ));
  await transaction.insert(bookingEmail).values({
    id, bookingId, kind, revision, recipient: record.recipient,
    status: bookingEmailConfigured() ? "pending" : "unconfigured",
    sender: process.env.DAYMARK_EMAIL_FROM,
    subject: `${sendLabels[kind]}: ${title.replace(/[\r\n]+/g, " ")}`,
    message: [
      `${sendLabels[kind]}. ${title}`,
      `Starts: ${formatInstant(record.start, record.timezone)}`,
      `Ends: ${formatInstant(record.end, record.timezone)}`,
      receipt ? `Open your current booking receipt: ${receipt}` : "",
    ].join("\n"),
  });
  return id;
}

export async function deliverBookingEmail(id: string) {
  const apiKey = process.env.DAYMARK_RESEND_API_KEY;
  if (!apiKey || !bookingEmailConfigured()) return;
  const database = getDb();
  const now = new Date();
  const firstSafeAttempt = new Date(now.getTime() - retryWindow);
  const isPending = and(eq(bookingEmail.id, id), eq(bookingEmail.status, "pending"));
  try {
    // A persisted short lease protects concurrent retries. Resend's key protects a crash after acceptance.
    await database.update(bookingEmail).set({ status: "failed" }).where(and(isPending, lte(bookingEmail.firstAttemptAt, firstSafeAttempt)));
    const [record] = await database.update(bookingEmail).set({
      firstAttemptAt: sql`coalesce(${bookingEmail.firstAttemptAt}, ${now.toISOString()}::timestamp)`,
      nextAttemptAt: new Date(now.getTime() + 30_000),
    }).where(and(isPending, lte(bookingEmail.nextAttemptAt, now))).returning();
    if (!record?.sender) return;

    const response = await fetch(providerEndpoint("https://api.resend.com/emails", "/resend/emails"), {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(4_000),
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": `daymark/${id}` },
      body: JSON.stringify({ from: record.sender, to: [record.recipient], subject: record.subject, text: record.message }),
    });
    const result = await response.json().catch(() => ({})) as { id?: string; name?: string };
    let status: BookingEmailStatus = "pending";
    if (response.ok && typeof result.id === "string" && result.id) status = "accepted";
    else if (response.status >= 400 && response.status < 500 && response.status !== 429
      && result.name !== "concurrent_idempotent_requests") status = "failed";
    if (status !== "pending") await database.update(bookingEmail).set({ status }).where(isPending);
  } catch {
    // Leave the delivery pending. The booking is already committed and its receipt remains available.
  }
}

export async function bookingEmailStatus(bookingId: string) {
  const [latest] = await getDb().select({ status: bookingEmail.status }).from(bookingEmail)
    .where(eq(bookingEmail.bookingId, bookingId)).orderBy(desc(bookingEmail.revision)).limit(1);
  return latest?.status;
}

export async function pendingBookingEmails(hostId: string) {
  const [row] = await getDb().select({ pending: count() }).from(bookingEmail).innerJoin(booking, eq(bookingEmail.bookingId, booking.id))
    .where(and(eq(booking.hostId, hostId), eq(bookingEmail.status, "pending")));
  return row.pending;
}

export async function retryBookingEmails(hostId: string) {
  const rows = await getDb().select({ id: bookingEmail.id }).from(bookingEmail).innerJoin(booking, eq(bookingEmail.bookingId, booking.id))
    .where(and(eq(booking.hostId, hostId), eq(bookingEmail.status, "pending"), lte(bookingEmail.nextAttemptAt, new Date())))
    .orderBy(bookingEmail.nextAttemptAt).limit(5);
  await Promise.all(rows.map(({ id }) => deliverBookingEmail(id)));
  return rows.length;
}
