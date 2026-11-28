import { createHash } from "node:crypto";
import { CreateScheduleCommand, DeleteScheduleCommand, SchedulerClient, UpdateScheduleCommand } from "@aws-sdk/client-scheduler";
import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { booking, bookingLink, bookingReminder, eventType, poll, type BookingReminderStatus } from "./schema";
import { providerEndpoint } from "./provider-endpoints";

export function reminderName(bookingId: string) {
  return "daymark-" + createHash("sha256").update(bookingId).digest("hex").slice(0, 48);
}

export async function reconcileBookingReminder(bookingId: string) {
  const database = getDb();
  const [record] = await database.select({
    status: booking.status, history: booking.rescheduleHistory, startsAt: booking.startUtc,
    recipient: booking.inviteeEmail, token: booking.confirmationToken,
    eventTitle: eventType.name, pollTitle: poll.title, oneOffTitle: bookingLink.meetingName,
  }).from(booking).leftJoin(eventType, eq(booking.eventTypeId, eventType.id))
    .leftJoin(poll, eq(booking.pollId, poll.id)).leftJoin(bookingLink, eq(booking.bookingLinkId, bookingLink.id))
    .where(eq(booking.id, bookingId));
  if (!record) return;
  const Name = reminderName(bookingId);
  const revision = record.history.length + (record.status === "cancelled" ? 1 : 0);
  const scheduledFor = new Date(record.startsAt.getTime() - 5 * 60_000);
  const persist = async (status: BookingReminderStatus) => {
    const values = { bookingId, scheduleName: Name, revision, status, scheduledFor, updatedAt: new Date() };
    await database.insert(bookingReminder).values(values).onConflictDoUpdate({ target: bookingReminder.bookingId, set: values });
  };
  if (![process.env.AWS_REGION, process.env.AWS_SCHEDULER_GROUP, process.env.AWS_SCHEDULER_EXECUTION_ROLE_ARN, process.env.DAYMARK_REMINDER_FUNCTION_ARN].every(Boolean)) {
    await persist("unconfigured"); return;
  }
  const endpoint = providerEndpoint("", "/scheduler");
  const client = new SchedulerClient({ region: process.env.AWS_REGION, ...(endpoint ? { endpoint } : {}) });
  const GroupName = process.env.AWS_SCHEDULER_GROUP!;
  const ClientToken = createHash("sha256").update(bookingId + ":" + revision).digest("hex");
  try {
    if (record.status === "cancelled" || scheduledFor.getTime() <= Date.now() + 60_000) {
      try { await client.send(new DeleteScheduleCommand({ Name, GroupName, ClientToken })); }
      catch (error) { if ((error as { name?: string }).name !== "ResourceNotFoundException") throw error; }
      await persist(record.status === "cancelled" ? "cancelled" : "too-soon"); return;
    }
    const input = {
      Name, GroupName, ClientToken, State: "ENABLED" as const,
      ScheduleExpression: "at(" + scheduledFor.toISOString().slice(0, 19) + ")", ScheduleExpressionTimezone: "UTC",
      FlexibleTimeWindow: { Mode: "OFF" as const }, ActionAfterCompletion: "DELETE" as const,
      Target: { Arn: process.env.DAYMARK_REMINDER_FUNCTION_ARN!, RoleArn: process.env.AWS_SCHEDULER_EXECUTION_ROLE_ARN!,
        RetryPolicy: { MaximumEventAgeInSeconds: 3600, MaximumRetryAttempts: 0 },
        Input: JSON.stringify({ bookingId, token: record.token, recipient: record.recipient,
          title: record.pollTitle ?? record.oneOffTitle ?? record.eventTitle ?? "Meeting", startsAt: record.startsAt.toISOString() }),
      },
    };
    try { await client.send(new CreateScheduleCommand(input)); }
    catch (error) {
      if ((error as { name?: string }).name !== "ConflictException") throw error;
      await client.send(new UpdateScheduleCommand(input));
    }
    await persist("scheduled");
  } catch { await persist("failed"); }
  finally { client.destroy(); }
}
