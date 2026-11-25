import { randomBytes } from "node:crypto";

import { and, asc, desc, eq } from "drizzle-orm";

import {
  BookingLinkAlreadyUsedError,
  BookingLinkNotActiveError,
  BookingLinkNotFoundError,
  BookingLinkUnavailableError,
} from "./bookings";
import { getDb } from "./db";
import { normalizeUserName } from "./profile-validation";
import { booking, bookingLink, eventType, user } from "./schema";
import { getDateInTimezone } from "./timezone";

export const invalidBookingLinkDetailsMessage = "Enter valid booking link details.";
export const bookingLinkTokenPattern = /^[A-Za-z0-9_-]{32}$/;

export type BookingLinkCreateInput =
  | { kind: "event_type" }
  | {
      kind: "one_off";
      meetingName: string;
      durationMinutes: number;
      description: string | null;
      location: string | null;
      proposedStarts: Date[];
    };

type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

type PublicLinkBase = {
  id: string;
  hostId: string;
  token: string;
  hostName: string;
  hostTimezone: string;
  username: string | null;
  name: string;
  durationMinutes: number;
  description: string | null;
  location: string | null;
};

export type PublicBookingLink =
  | (PublicLinkBase & { kind: "event_type"; eventTypeId: string; proposedStarts: null })
  | (PublicLinkBase & { kind: "one_off"; eventTypeId: null; proposedStarts: Date[] });

function normalizeOptionalText(value: unknown, maxLength: number): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (text.length > maxLength) return undefined;
  return text.length > 0 ? text : null;
}

function parseUtcStart(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const start = new Date(timestamp);
  return start.toISOString() === value ? start : null;
}

export function validateBookingLinkInput(body: Record<string, unknown>): ValidationResult<BookingLinkCreateInput> {
  if (body.kind === "event_type") {
    return Object.keys(body).length === 1
      ? { ok: true, value: { kind: "event_type" } }
      : { ok: false, error: invalidBookingLinkDetailsMessage };
  }

  if (
    body.kind !== "one_off" ||
    Object.keys(body).some((key) => !["kind", "name", "durationMinutes", "description", "location", "proposedStarts"].includes(key))
  ) {
    return { ok: false, error: invalidBookingLinkDetailsMessage };
  }

  const meetingName = normalizeUserName(body.name);
  if (meetingName === null) return { ok: false, error: "Enter a meeting name between 1 and 80 characters." };
  if (
    typeof body.durationMinutes !== "number" ||
    !Number.isInteger(body.durationMinutes) ||
    body.durationMinutes < 5 ||
    body.durationMinutes > 480
  ) {
    return { ok: false, error: "Enter a duration from 5 to 480 minutes." };
  }

  const description = normalizeOptionalText(body.description, 2000);
  const location = normalizeOptionalText(body.location, 500);
  if (description === undefined || location === undefined) {
    return { ok: false, error: invalidBookingLinkDetailsMessage };
  }
  if (!Array.isArray(body.proposedStarts) || body.proposedStarts.length < 1 || body.proposedStarts.length > 20) {
    return { ok: false, error: "Offer between 1 and 20 future start times." };
  }

  const proposedStarts: Date[] = [];
  const uniqueStarts = new Set<number>();
  for (const value of body.proposedStarts) {
    const start = parseUtcStart(value);
    if (!start || start.getTime() <= Date.now() || uniqueStarts.has(start.getTime())) {
      return { ok: false, error: "Offer between 1 and 20 unique future UTC start times." };
    }
    uniqueStarts.add(start.getTime());
    proposedStarts.push(start);
  }

  proposedStarts.sort((left, right) => left.getTime() - right.getTime());
  return {
    ok: true,
    value: { kind: "one_off", meetingName, durationMinutes: body.durationMinutes, description, location, proposedStarts },
  };
}

export async function createBookingLink(hostId: string, input: BookingLinkCreateInput) {
  return getDb().transaction(async (transaction) => {
    const [hostEvent] = await transaction
      .select({ id: eventType.id, active: eventType.active })
      .from(eventType)
      .where(and(eq(eventType.userId, hostId), eq(eventType.isDefault, true)))
      .for("update");
    if (!hostEvent || (input.kind === "event_type" && !hostEvent.active)) {
      throw new Error("Event type not found.");
    }

    const [created] = await transaction
      .insert(bookingLink)
      .values({
        id: crypto.randomUUID(),
        hostId,
        token: randomBytes(24).toString("base64url"),
        kind: input.kind,
        status: "active",
        eventTypeId: input.kind === "event_type" ? hostEvent.id : null,
        meetingName: input.kind === "one_off" ? input.meetingName : null,
        durationMinutes: input.kind === "one_off" ? input.durationMinutes : null,
        description: input.kind === "one_off" ? input.description : null,
        location: input.kind === "one_off" ? input.location : null,
        proposedStarts: input.kind === "one_off" ? input.proposedStarts : null,
      })
      .returning({ id: bookingLink.id, token: bookingLink.token, kind: bookingLink.kind, status: bookingLink.status, createdAt: bookingLink.createdAt });
    if (!created) throw new Error(invalidBookingLinkDetailsMessage);
    return { ...created, publicPath: `/link/${created.token}` };
  });
}

export async function listBookingLinks(hostId: string) {
  const links = await getDb()
    .select({
      id: bookingLink.id,
      token: bookingLink.token,
      kind: bookingLink.kind,
      status: bookingLink.status,
      createdAt: bookingLink.createdAt,
      eventTypeId: bookingLink.eventTypeId,
      meetingName: bookingLink.meetingName,
      durationMinutes: bookingLink.durationMinutes,
      description: bookingLink.description,
      location: bookingLink.location,
      proposedStarts: bookingLink.proposedStarts,
      eventTypeName: eventType.name,
      booking: {
        id: booking.id,
        startUtc: booking.startUtc,
        endUtc: booking.endUtc,
        status: booking.status,
        inviteeName: booking.inviteeName,
        inviteeEmail: booking.inviteeEmail,
      },
    })
    .from(bookingLink)
    .leftJoin(eventType, eq(bookingLink.eventTypeId, eventType.id))
    .leftJoin(booking, eq(booking.bookingLinkId, bookingLink.id))
    .where(eq(bookingLink.hostId, hostId))
    .orderBy(desc(bookingLink.createdAt), asc(bookingLink.id));

  return links.map((link) => ({
    ...link,
    publicPath: link.status === "active" ? `/link/${link.token}` : null,
    proposedStarts: link.proposedStarts?.map((start) => start.toISOString()) ?? null,
    booking: link.booking?.id
      ? { ...link.booking, startUtc: link.booking.startUtc?.toISOString(), endUtc: link.booking.endUtc?.toISOString() }
      : null,
  }));
}

export async function deleteBookingLink(hostId: string, id: string): Promise<void> {
  await getDb().transaction(async (transaction) => {
    const [link] = await transaction
      .select({ id: bookingLink.id, status: bookingLink.status })
      .from(bookingLink)
      .where(and(eq(bookingLink.id, id), eq(bookingLink.hostId, hostId)))
      .for("update");
    if (!link) throw new BookingLinkNotFoundError();
    if (link.status === "deleted") return;
    if (link.status !== "active") throw new BookingLinkNotActiveError();

    await transaction
      .update(bookingLink)
      .set({ status: "deleted" })
      .where(and(eq(bookingLink.id, id), eq(bookingLink.hostId, hostId), eq(bookingLink.status, "active")));
  });
}

export async function getPublicBookingLink(token: string): Promise<PublicBookingLink> {
  const [record] = await getDb()
    .select({
      id: bookingLink.id,
      hostId: bookingLink.hostId,
      token: bookingLink.token,
      kind: bookingLink.kind,
      status: bookingLink.status,
      eventTypeId: bookingLink.eventTypeId,
      meetingName: bookingLink.meetingName,
      durationMinutes: bookingLink.durationMinutes,
      description: bookingLink.description,
      location: bookingLink.location,
      proposedStarts: bookingLink.proposedStarts,
      hostName: user.name,
      hostTimezone: user.timezone,
      username: user.username,
      eventTypeOwnerId: eventType.userId,
      eventTypeName: eventType.name,
      eventTypeDescription: eventType.description,
      eventTypeLocation: eventType.location,
      eventTypeDurationMinutes: eventType.durationMinutes,
      eventTypeActive: eventType.active,
    })
    .from(bookingLink)
    .innerJoin(user, eq(bookingLink.hostId, user.id))
    .leftJoin(eventType, eq(bookingLink.eventTypeId, eventType.id))
    .where(eq(bookingLink.token, token))
    .limit(1);

  if (!record) throw new BookingLinkNotFoundError();
  if (record.status === "used") throw new BookingLinkAlreadyUsedError();
  if (record.status !== "active") throw new BookingLinkUnavailableError();
  if (
    record.kind === "event_type" &&
    (!record.eventTypeId || record.eventTypeOwnerId !== record.hostId || !record.eventTypeActive)
  ) {
    throw new BookingLinkUnavailableError();
  }

  if (record.kind === "event_type") {
    if (
      !record.eventTypeId ||
      record.eventTypeOwnerId !== record.hostId ||
      !record.eventTypeActive ||
      !record.eventTypeName ||
      record.eventTypeDurationMinutes === null
    ) {
      throw new BookingLinkUnavailableError();
    }
    return {
      id: record.id,
      hostId: record.hostId,
      token: record.token,
      kind: record.kind,
      hostName: record.hostName,
      hostTimezone: record.hostTimezone,
      username: record.username,
      name: record.eventTypeName,
      durationMinutes: record.eventTypeDurationMinutes,
      description: record.eventTypeDescription,
      location: record.eventTypeLocation,
      eventTypeId: record.eventTypeId,
      proposedStarts: null,
    };
  }

  if (!record.meetingName || !record.durationMinutes || !record.proposedStarts) {
    throw new BookingLinkUnavailableError();
  }
  return {
    id: record.id,
    hostId: record.hostId,
    token: record.token,
    kind: record.kind,
    hostName: record.hostName,
    hostTimezone: record.hostTimezone,
    username: record.username,
    name: record.meetingName,
    durationMinutes: record.durationMinutes,
    description: record.description,
    location: record.location,
    eventTypeId: null,
    proposedStarts: record.proposedStarts,
  };
}

export function proposedStartsForDate(starts: Date[], date: string, timezone: string) {
  return starts.filter((start) => getDateInTimezone(start, timezone) === date);
}
