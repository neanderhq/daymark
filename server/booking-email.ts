import { and, count, desc, eq, lte } from "drizzle-orm";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { getDb, type DbTransaction } from "./db";
import { providerEndpoint } from "./provider-endpoints";
import { booking, bookingEmail, bookingLink, eventType, poll } from "./schema";
import { formatInstant } from "./timezone";

const sendLabels = { confirmed: "Booking confirmed", rescheduled: "Booking rescheduled", cancelled: "Booking cancelled" };

export function bookingEmailConfigured(): boolean {
  return Boolean(process.env.AWS_REGION && process.env.NEANDER_EMAIL_FROM && process.env.AWS_SES_CONFIGURATION_SET && process.env.DAYMARK_APP_URL);
}

export async function queueBookingEmail(transaction: DbTransaction, bookingId: string, kind: keyof typeof sendLabels) {
  const [record] = await transaction.select({
    recipient: booking.inviteeEmail, timezone: booking.inviteeTimezone, start: booking.startUtc, end: booking.endUtc,
    token: booking.confirmationToken, history: booking.rescheduleHistory, title: eventType.name,
    pollTitle: poll.title, pollToken: poll.token, oneOffTitle: bookingLink.meetingName,
  }).from(booking).leftJoin(eventType, eq(booking.eventTypeId, eventType.id))
    .leftJoin(bookingLink, eq(booking.bookingLinkId, bookingLink.id))
    .leftJoin(poll, eq(booking.pollId, poll.id)).where(eq(booking.id, bookingId));
  const id = crypto.randomUUID();
  const title = record.pollTitle ?? record.oneOffTitle ?? record.title ?? "Meeting";
  const origin = process.env.DAYMARK_APP_URL;
  const recipientPath = record.pollToken ? "/polls/" + record.pollToken : "/booking/" + record.token;
  const receipt = origin ? new URL(recipientPath, origin).href : null;
  const revision = record.history.length + (kind === "cancelled" ? 1 : 0);
  await transaction.update(bookingEmail).set({ status: "superseded" }).where(and(eq(bookingEmail.bookingId, bookingId), eq(bookingEmail.status, "pending")));
  await transaction.insert(bookingEmail).values({
    id, bookingId, kind, revision, recipient: record.recipient,
    status: bookingEmailConfigured() ? "pending" : "unconfigured", sender: process.env.NEANDER_EMAIL_FROM,
    subject: sendLabels[kind] + ": " + title.replace(/[\r\n]+/g, " "),
    message: [sendLabels[kind] + ". " + title,
      "Starts: " + formatInstant(record.start, record.timezone),
      "Ends: " + formatInstant(record.end, record.timezone),
      receipt ? "Open your current booking receipt: " + receipt : "",
    ].join("\n"),
  });
  return id;
}

export async function deliverBookingEmail(id: string) {
  if (!bookingEmailConfigured()) return;
  const database = getDb();
  const now = new Date();
  // SES SendEmail has no idempotency key. Claim before calling it; an unknown
  // outcome must not be resent automatically after a process exit or lost reply.
  const [record] = await database.update(bookingEmail).set({ status: "unknown", firstAttemptAt: now })
    .where(and(eq(bookingEmail.id, id), eq(bookingEmail.status, "pending"), lte(bookingEmail.nextAttemptAt, now))).returning();
  if (!record?.sender) return;
  const endpoint = providerEndpoint("", "/ses");
  const client = new SESv2Client({ region: process.env.AWS_REGION, maxAttempts: 1, ...(endpoint ? { endpoint } : {}) });
  try {
    const result = await client.send(new SendEmailCommand({
      FromEmailAddress: record.sender, ConfigurationSetName: process.env.AWS_SES_CONFIGURATION_SET,
      Destination: { ToAddresses: [record.recipient] },
      Content: { Simple: { Subject: { Data: record.subject, Charset: "UTF-8" }, Body: { Text: { Data: record.message, Charset: "UTF-8" } } } },
    }));
    if (result.MessageId) await database.update(bookingEmail).set({ status: "accepted" }).where(eq(bookingEmail.id, id));
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status && status >= 400 && status < 500) {
      await database.update(bookingEmail).set({
        status: status === 429 ? "pending" : "failed", nextAttemptAt: new Date(now.getTime() + 30_000),
      }).where(eq(bookingEmail.id, id));
    }
  } finally { client.destroy(); }
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
