import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { randomBytes } from "node:crypto";

import { createBooking } from "./bookings";
import { getDb } from "./db";
import { invalidEmailMessage, normalizeEmail, normalizeUserName } from "./profile-validation";
import { isUniqueViolation } from "./scheduling";
import {
  availabilityRule,
  booking,
  eventType,
  poll,
  pollOption,
  pollVote,
  pollVoteOption,
  user,
} from "./schema";
import { bufferedInterval, intervalsOverlap, normalizeAvailabilityRules } from "./slots";
import { isIanaTimezone } from "./timezone";

export const pollNotFoundMessage = "Poll not found.";
export const invalidPollDetailsMessage = "Enter valid poll details.";
export const invalidOptionIdsMessage = "Choose at least one proposed time.";
export const alreadyVotedMessage = "This email address has already voted in this poll.";

export class PollNotFoundError extends Error {
  constructor() {
    super(pollNotFoundMessage);
  }
}

export class AlreadyVotedError extends Error {
  constructor() {
    super(alreadyVotedMessage);
  }
}

export class PollBookedError extends Error {
  constructor() {
    super("This poll has been booked and cannot be deleted.");
  }
}

type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

export type PollInput = {
  title: string;
  description: string | null;
  durationMinutes: number;
  showVotes: boolean;
  options: string[];
};

export type PollVoteInput = {
  name: string;
  email: string;
  optionIds: string[];
};

const hostPollFields = {
  id: poll.id,
  hostId: poll.hostId,
  title: poll.title,
  description: poll.description,
  durationMinutes: poll.durationMinutes,
  token: poll.token,
  showVotes: poll.showVotes,
  status: poll.status,
  createdAt: poll.createdAt,
  updatedAt: poll.updatedAt,
};

const publicPollFields = {
  id: poll.id,
  title: poll.title,
  description: poll.description,
  durationMinutes: poll.durationMinutes,
  showVotes: poll.showVotes,
  status: poll.status,
};

const bookingFields = {
  id: booking.id,
  startUtc: booking.startUtc,
  endUtc: booking.endUtc,
  status: booking.status,
  confirmationToken: booking.confirmationToken,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validatePollInput(body: unknown): Validated<PollInput> {
  if (!isRecord(body)) return { ok: false, error: invalidPollDetailsMessage };

  const allowedKeys = new Set(["title", "description", "durationMinutes", "showVotes", "options"]);
  if (
    Object.keys(body).some((key) => !allowedKeys.has(key)) ||
    !Object.hasOwn(body, "title") ||
    !Object.hasOwn(body, "durationMinutes") ||
    !Object.hasOwn(body, "showVotes") ||
    !Object.hasOwn(body, "options")
  ) {
    return { ok: false, error: invalidPollDetailsMessage };
  }

  if (typeof body.title !== "string") return { ok: false, error: invalidPollDetailsMessage };
  const title = body.title.trim();
  if (title.length < 1 || title.length > 80) return { ok: false, error: invalidPollDetailsMessage };

  let description: string | null = null;
  if (body.description !== undefined && body.description !== null) {
    if (typeof body.description !== "string") return { ok: false, error: invalidPollDetailsMessage };
    description = body.description.trim();
    if (description.length > 500) return { ok: false, error: invalidPollDetailsMessage };
    if (description.length === 0) description = null;
  }

  if (
    typeof body.durationMinutes !== "number" ||
    !Number.isInteger(body.durationMinutes) ||
    body.durationMinutes < 5 ||
    body.durationMinutes > 480
  ) {
    return { ok: false, error: invalidPollDetailsMessage };
  }
  if (typeof body.showVotes !== "boolean") return { ok: false, error: invalidPollDetailsMessage };
  if (!Array.isArray(body.options) || body.options.length < 2 || body.options.length > 40) {
    return { ok: false, error: invalidPollDetailsMessage };
  }

  const options: { timestamp: number; value: string }[] = [];
  const seen = new Set<string>();
  for (const option of body.options) {
    if (typeof option !== "string") return { ok: false, error: invalidPollDetailsMessage };
    const timestamp = Date.parse(option);
    const canonical = new Date(timestamp).toISOString();
    if (!Number.isFinite(timestamp) || canonical !== option || timestamp <= Date.now()) {
      return { ok: false, error: invalidPollDetailsMessage };
    }
    if (seen.has(option)) return { ok: false, error: invalidPollDetailsMessage };
    seen.add(option);
    options.push({ timestamp, value: option });
  }
  options.sort((left, right) => left.timestamp - right.timestamp);

  return {
    ok: true,
    value: {
      title,
      description,
      durationMinutes: body.durationMinutes,
      showVotes: body.showVotes,
      options: options.map((option) => option.value),
    },
  };
}

export async function getPollBooking(pollId: string) {
  const [record] = await getDb()
    .select(bookingFields)
    .from(booking)
    .where(eq(booking.pollId, pollId))
    .limit(1);
  return record ?? null;
}

async function getHostPollRecord(hostId: string, pollId: string) {
  const [record] = await getDb()
    .select(hostPollFields)
    .from(poll)
    .where(and(eq(poll.id, pollId), eq(poll.hostId, hostId)))
    .limit(1);
  return record ?? null;
}

export async function createPoll(hostId: string, body: unknown) {
  const validated = validatePollInput(body);
  if (!validated.ok) return validated;

  const created = await getDb().transaction(async (transaction) => {
    const id = crypto.randomUUID();
    const [record] = await transaction
      .insert(poll)
      .values({
        id,
        hostId,
        title: validated.value.title,
        description: validated.value.description,
        durationMinutes: validated.value.durationMinutes,
        token: randomBytes(24).toString("base64url"),
        showVotes: validated.value.showVotes,
        status: "open",
      })
      .returning(hostPollFields);
    if (!record) throw new Error(invalidPollDetailsMessage);

    const options = await transaction
      .insert(pollOption)
      .values(
        validated.value.options.map((startUtc) => ({
          id: crypto.randomUUID(),
          pollId: record.id,
          startUtc: new Date(startUtc),
        })),
      )
      .returning({ id: pollOption.id, startUtc: pollOption.startUtc });
    options.sort((left, right) => left.startUtc.getTime() - right.startUtc.getTime());
    return { record, options };
  });

  const bookingRecord = await getPollBooking(created.record.id);
  return {
    ok: true as const,
    value: { ...created.record, options: created.options, booking: bookingRecord },
  };
}

export async function listPolls(hostId: string) {
  return getDb()
    .select({
      ...hostPollFields,
      optionCount: count(pollOption.id),
    })
    .from(poll)
    .leftJoin(pollOption, eq(pollOption.pollId, poll.id))
    .where(eq(poll.hostId, hostId))
    .groupBy(poll.id)
    .orderBy(desc(poll.createdAt));
}

export async function getHostPoll(hostId: string, pollId: string) {
  const record = await getHostPollRecord(hostId, pollId);
  if (!record) return null;

  const options = await getDb()
    .select({ id: pollOption.id, startUtc: pollOption.startUtc })
    .from(pollOption)
    .where(eq(pollOption.pollId, record.id))
    .orderBy(asc(pollOption.startUtc));
  const bookingRecord = await getPollBooking(record.id);
  return { ...record, options, booking: bookingRecord };
}

export async function setShowVotes(hostId: string, pollId: string, value: boolean) {
  const [updated] = await getDb()
    .update(poll)
    .set({ showVotes: value, updatedAt: new Date() })
    .where(and(eq(poll.id, pollId), eq(poll.hostId, hostId)))
    .returning({ id: poll.id });
  return updated ?? null;
}

export async function deletePoll(hostId: string, pollId: string): Promise<boolean> {
  return getDb().transaction(async (transaction) => {
    const [record] = await transaction
      .select({ id: poll.id })
      .from(poll)
      .where(and(eq(poll.id, pollId), eq(poll.hostId, hostId)))
      .for("update");
    if (!record) throw new PollNotFoundError();

    const [existingBooking] = await transaction
      .select({ id: booking.id })
      .from(booking)
      .where(eq(booking.pollId, record.id))
      .limit(1);
    if (existingBooking) throw new PollBookedError();

    const deleted = await transaction.delete(poll).where(eq(poll.id, record.id)).returning({ id: poll.id });
    return deleted.length > 0;
  });
}

export async function getPublicPoll(token: string) {
  const [record] = await getDb()
    .select(publicPollFields)
    .from(poll)
    .where(eq(poll.token, token))
    .limit(1);
  if (!record) return null;

  const options = await getDb()
    .select({ id: pollOption.id, startUtc: pollOption.startUtc })
    .from(pollOption)
    .where(eq(pollOption.pollId, record.id))
    .orderBy(asc(pollOption.startUtc));
  let votes: { name: string; optionIds: string[] }[] = [];
  if (record.showVotes) {
    const voteRows = await getDb()
      .select({ id: pollVote.id, name: pollVote.name })
      .from(pollVote)
      .where(eq(pollVote.pollId, record.id))
      .orderBy(asc(pollVote.createdAt), asc(pollVote.id));
    const optionRows =
      voteRows.length > 0
        ? await getDb()
            .select({ voteId: pollVoteOption.voteId, optionId: pollVoteOption.optionId })
            .from(pollVoteOption)
            .where(
              inArray(
                pollVoteOption.voteId,
                voteRows.map((vote) => vote.id),
              ),
            )
            .orderBy(asc(pollVoteOption.optionId))
        : [];
    const optionIdsByVote = new Map<string, string[]>(voteRows.map((vote) => [vote.id, []]));
    for (const row of optionRows) optionIdsByVote.get(row.voteId)?.push(row.optionId);
    votes = voteRows.map((vote) => ({
      name: vote.name,
      optionIds: optionIdsByVote.get(vote.id) ?? [],
    }));
  }

  const [bookingRecord] = await getDb()
    .select({ startUtc: booking.startUtc, status: booking.status })
    .from(booking)
    .where(eq(booking.pollId, record.id))
    .limit(1);
  return { ...record, options, votes, booking: bookingRecord ?? null };
}

export function validateVoteInput(body: unknown): Validated<PollVoteInput> {
  if (!isRecord(body)) return { ok: false, error: invalidPollDetailsMessage };
  const expectedKeys = ["name", "email", "optionIds"];
  const keys = Object.keys(body);
  if (
    keys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(body, key))
  ) {
    return { ok: false, error: invalidPollDetailsMessage };
  }

  const name = normalizeUserName(body.name);
  if (name === null) return { ok: false, error: "Enter your name." };
  const email = normalizeEmail(body.email);
  if (email === null) return { ok: false, error: invalidEmailMessage };
  if (!Array.isArray(body.optionIds) || body.optionIds.length < 1 || body.optionIds.length > 40) {
    return { ok: false, error: invalidPollDetailsMessage };
  }

  const optionIds: string[] = [];
  const seen = new Set<string>();
  for (const optionId of body.optionIds) {
    if (typeof optionId !== "string" || optionId.length === 0 || seen.has(optionId)) {
      return { ok: false, error: invalidPollDetailsMessage };
    }
    seen.add(optionId);
    optionIds.push(optionId);
  }
  return { ok: true, value: { name, email, optionIds } };
}

export async function submitPollVote(token: string, body: unknown) {
  const [record] = await getDb()
    .select({ id: poll.id, status: poll.status })
    .from(poll)
    .where(eq(poll.token, token))
    .limit(1);
  if (!record) throw new PollNotFoundError();
  if (record.status !== "open") return { ok: false as const, error: "Voting for this poll has closed." };

  const validated = validateVoteInput(body);
  if (!validated.ok) return validated;

  const optionRecords = await getDb()
    .select({ id: pollOption.id })
    .from(pollOption)
    .where(
      and(
        eq(pollOption.pollId, record.id),
        inArray(pollOption.id, validated.value.optionIds),
      ),
    );
  const validOptionIds = new Set(optionRecords.map((option) => option.id));
  if (validated.value.optionIds.some((optionId) => !validOptionIds.has(optionId))) {
    return { ok: false as const, error: invalidPollDetailsMessage };
  }

  try {
    return await getDb().transaction(async (transaction) => {
      const [lockedPoll] = await transaction
        .select({ id: poll.id, status: poll.status })
        .from(poll)
        .where(eq(poll.id, record.id))
        .for("update");
      if (!lockedPoll || lockedPoll.status !== "open") {
        return { ok: false as const, error: "Voting for this poll has closed." };
      }

      const voteId = crypto.randomUUID();
      await transaction.insert(pollVote).values({
        id: voteId,
        pollId: lockedPoll.id,
        name: validated.value.name,
        email: validated.value.email,
      });
      await transaction.insert(pollVoteOption).values(
        validated.value.optionIds.map((optionId) => ({ voteId, optionId })),
      );
      return { ok: true as const, value: { pollId: lockedPoll.id } };
    });
  } catch (error) {
    if (isUniqueViolation(error, "poll_vote_pollId_email_unique")) throw new AlreadyVotedError();
    throw error;
  }
}

export async function getPollResults(hostId: string, pollId: string) {
  const record = await getHostPollRecord(hostId, pollId);
  if (!record) return null;

  const options = await getDb()
    .select({ id: pollOption.id, startUtc: pollOption.startUtc })
    .from(pollOption)
    .where(eq(pollOption.pollId, record.id))
    .orderBy(asc(pollOption.startUtc));
  const [ruleRow] = await getDb()
    .select({
      bufferBeforeMinutes: availabilityRule.bufferBeforeMinutes,
      bufferAfterMinutes: availabilityRule.bufferAfterMinutes,
      minimumNoticeHours: availabilityRule.minimumNoticeHours,
      bookingHorizonDays: availabilityRule.bookingHorizonDays,
      startTimeIncrementMinutes: availabilityRule.startTimeIncrementMinutes,
      dailyMeetingLimit: availabilityRule.dailyMeetingLimit,
      weeklyMeetingLimit: availabilityRule.weeklyMeetingLimit,
      monthlyMeetingLimit: availabilityRule.monthlyMeetingLimit,
    })
    .from(availabilityRule)
    .where(eq(availabilityRule.userId, hostId))
    .limit(1);
  const rules = normalizeAvailabilityRules(ruleRow ?? null);
  const activeBookings = await getDb()
    .select({ startUtc: booking.startUtc, endUtc: booking.endUtc })
    .from(booking)
    .where(and(eq(booking.hostId, hostId), eq(booking.status, "active")));
  const voterRows =
    options.length > 0
      ? await getDb()
          .select({
            optionId: pollVoteOption.optionId,
            name: pollVote.name,
            email: pollVote.email,
          })
          .from(pollVoteOption)
          .innerJoin(pollVote, eq(pollVote.id, pollVoteOption.voteId))
          .where(
            inArray(
              pollVoteOption.optionId,
              options.map((option) => option.id),
            ),
          )
          .orderBy(asc(pollVote.createdAt), asc(pollVote.id))
      : [];
  const votersByOption = new Map<string, { name: string; email: string }[]>(
    options.map((option) => [option.id, []]),
  );
  for (const row of voterRows) {
    votersByOption.get(row.optionId)?.push({ name: row.name, email: row.email });
  }

  return options.map((option) => {
    const optionInterval = bufferedInterval(
      option.startUtc,
      new Date(option.startUtc.getTime() + record.durationMinutes * 60_000),
      rules,
    );
    const voters = votersByOption.get(option.id) ?? [];
    return {
      ...option,
      voteCount: voters.length,
      voters,
      conflictsWithBooking: activeBookings.some((existingBooking) =>
        intervalsOverlap(optionInterval, bufferedInterval(existingBooking.startUtc, existingBooking.endUtc, rules)),
      ),
    };
  });
}

export async function bookPollOption({
  hostId,
  pollId,
  startUtc,
  extraAttendees,
}: {
  hostId: string;
  pollId: string;
  startUtc: Date;
  extraAttendees?: { name: string; email: string }[];
}) {
  const [record] = await getDb()
    .select({
      id: poll.id,
      durationMinutes: poll.durationMinutes,
      status: poll.status,
    })
    .from(poll)
    .where(and(eq(poll.id, pollId), eq(poll.hostId, hostId)))
    .limit(1);
  if (!record || record.status !== "open") throw new PollNotFoundError();

  const [existingBooking] = await getDb()
    .select({ id: booking.id })
    .from(booking)
    .where(eq(booking.pollId, record.id))
    .limit(1);
  if (existingBooking) throw new PollNotFoundError();

  const [option] = await getDb()
    .select({ id: pollOption.id })
    .from(pollOption)
    .where(and(eq(pollOption.pollId, record.id), eq(pollOption.startUtc, startUtc)))
    .limit(1);
  if (!option) throw new PollNotFoundError();

  const [event] = await getDb()
    .select({ id: eventType.id })
    .from(eventType)
    .where(and(eq(eventType.userId, hostId), eq(eventType.isDefault, true)))
    .limit(1);
  const [host] = await getDb()
    .select({ name: user.name, email: user.email, timezone: user.timezone })
    .from(user)
    .where(eq(user.id, hostId))
    .limit(1);
  if (!event || !host || !isIanaTimezone(host.timezone)) {
    throw new Error(invalidPollDetailsMessage);
  }

  const voterRows = await getDb()
    .select({ name: pollVote.name, email: pollVote.email })
    .from(pollVote)
    .where(eq(pollVote.pollId, record.id))
    .orderBy(asc(pollVote.createdAt), asc(pollVote.id));
  const attendees: { name: string; email: string }[] = [];
  const seenEmails = new Set<string>();
  for (const voter of voterRows) {
    const name = normalizeUserName(voter.name);
    const email = normalizeEmail(voter.email);
    if (name === null || email === null) throw new Error(invalidPollDetailsMessage);
    if (!seenEmails.has(email)) {
      seenEmails.add(email);
      attendees.push({ name, email });
    }
  }
  for (const attendee of extraAttendees ?? []) {
    const name = normalizeUserName(attendee.name);
    const email = normalizeEmail(attendee.email);
    if (name === null || email === null) throw new Error(invalidPollDetailsMessage);
    if (!seenEmails.has(email)) {
      seenEmails.add(email);
      attendees.push({ name, email });
    }
  }

  const primary = attendees.shift() ?? {
    name: normalizeUserName(host.name) ?? host.name,
    email: normalizeEmail(host.email) ?? host.email,
  };
  const endUtc = new Date(startUtc.getTime() + record.durationMinutes * 60_000);
  return createBooking({
    hostId,
    eventTypeId: event.id,
    startUtc,
    endUtc,
    inviteeName: primary.name,
    inviteeEmail: primary.email,
    inviteeTimezone: host.timezone,
    answers: [],
    durationMinutes: record.durationMinutes,
    pollId: record.id,
    attendees,
  });
}
