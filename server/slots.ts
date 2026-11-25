import type { BusyInterval } from "./google-calendar";
import { and, eq, gt, inArray, lt, ne } from "drizzle-orm";

import { getDb } from "./db";
import { type AvailabilityRules, defaultAvailabilityRules } from "./scheduling";
import { availabilityOverride, availabilityRange, availabilityRule, blockedTime, booking } from "./schema";
import {
  addDaysToDateString,
  getDateInTimezone,
  getWeekdayOfDateString,
  isIanaTimezone,
  zonedWallTimeToUtc,
} from "./timezone";

function isValidDateString(date: string): boolean {
  try {
    return addDaysToDateString(date, 0) === date;
  } catch {
    return false;
  }
}

function validRuleValue(value: number | undefined, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max ? value : null;
}

export function normalizeAvailabilityRules(
  row: {
    bufferBeforeMinutes: number;
    bufferAfterMinutes: number;
    minimumNoticeHours: number;
    bookingHorizonDays: number;
    startTimeIncrementMinutes: number | null;
    dailyMeetingLimit: number | null;
    weeklyMeetingLimit: number | null;
    monthlyMeetingLimit: number | null;
  } | null,
): AvailabilityRules {
  const validLimit = (value: number | null | undefined) =>
    value !== null && value !== undefined && Number.isInteger(value) && value >= 1 && value <= 100 ? value : null;
  const horizon = validRuleValue(row?.bookingHorizonDays, 365);
  const increment = row?.startTimeIncrementMinutes;
  return {
    bufferBeforeMinutes: validRuleValue(row?.bufferBeforeMinutes, 120) ?? defaultAvailabilityRules.bufferBeforeMinutes,
    bufferAfterMinutes: validRuleValue(row?.bufferAfterMinutes, 120) ?? defaultAvailabilityRules.bufferAfterMinutes,
    minimumNoticeHours: validRuleValue(row?.minimumNoticeHours, 720) ?? defaultAvailabilityRules.minimumNoticeHours,
    bookingHorizonDays: horizon !== null && horizon >= 1
      ? horizon
      : defaultAvailabilityRules.bookingHorizonDays,
    startTimeIncrementMinutes: typeof increment === "number" && [5, 10, 15, 20, 30, 45, 60].includes(increment)
      ? increment
      : defaultAvailabilityRules.startTimeIncrementMinutes,
    dailyMeetingLimit: validLimit(row?.dailyMeetingLimit),
    weeklyMeetingLimit: validLimit(row?.weeklyMeetingLimit),
    monthlyMeetingLimit: validLimit(row?.monthlyMeetingLimit),
  };
}

type SlotExecutor = Pick<ReturnType<typeof getDb>, "select">;

export async function getAvailabilityRules(
  userId: string,
  executor: SlotExecutor = getDb(),
): Promise<AvailabilityRules> {
  const [row] = await executor
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
    .where(eq(availabilityRule.userId, userId))
    .limit(1);
  return normalizeAvailabilityRules(row ?? null);
}

export function bufferedInterval(start: Date, end: Date, rules: AvailabilityRules): { start: Date; end: Date } {
  return {
    start: new Date(start.getTime() - rules.bufferBeforeMinutes * 60_000),
    end: new Date(end.getTime() + rules.bufferAfterMinutes * 60_000),
  };
}

export function intervalsOverlap(left: { start: Date; end: Date }, right: { start: Date; end: Date }): boolean {
  return left.start.getTime() < right.end.getTime() && left.end.getTime() > right.start.getTime();
}

export async function getAvailableSlots(query: {
  hostId: string;
  hostTimezone: string;
  durationMinutes: number;
  date: string;
  timezone: string;
  executor?: SlotExecutor;
  excludeBookingId?: string;
  applySchedulingLimits?: boolean;
  busyTimes?: BusyInterval[];
}): Promise<Date[]> {
  if (
    typeof query.hostId !== "string" ||
    query.hostId.trim().length === 0 ||
    !isIanaTimezone(query.hostTimezone) ||
    !isIanaTimezone(query.timezone) ||
    !Number.isInteger(query.durationMinutes) ||
    query.durationMinutes <= 0 ||
    typeof query.date !== "string" ||
    !isValidDateString(query.date)
  ) {
    return [];
  }

  const now = new Date();
  const today = getDateInTimezone(now, query.timezone);
  if (query.date < today) return [];

  const rules = await getAvailabilityRules(query.hostId, query.executor);
  const applySchedulingLimits = query.applySchedulingLimits !== false;
  if (applySchedulingLimits && query.date > addDaysToDateString(today, rules.bookingHorizonDays - 1)) return [];

  const database = query.executor ?? getDb();
  const weeklyRanges = await database
    .select({
      weekday: availabilityRange.weekday,
      startMinute: availabilityRange.startMinute,
      endMinute: availabilityRange.endMinute,
    })
    .from(availabilityRange)
    .where(eq(availabilityRange.userId, query.hostId));

  // Host and invitee calendar dates can differ by up to two days in extreme IANA zones.
  const hostDates = [-2, -1, 0, 1, 2].map((adjustment) => addDaysToDateString(query.date, adjustment));

  const overrides = await database
    .select({
      date: availabilityOverride.date,
      kind: availabilityOverride.kind,
      startMinute: availabilityOverride.startMinute,
      endMinute: availabilityOverride.endMinute,
    })
    .from(availabilityOverride)
    .where(and(eq(availabilityOverride.userId, query.hostId), inArray(availabilityOverride.date, hostDates)));

  const blockedTimes = await database
    .select({
      date: blockedTime.date,
      startMinute: blockedTime.startMinute,
      endMinute: blockedTime.endMinute,
    })
    .from(blockedTime)
    .where(and(eq(blockedTime.userId, query.hostId), inArray(blockedTime.date, hostDates)));

  const overridesByDate = new Map<string, typeof overrides>();
  for (const override of overrides) {
    const existing = overridesByDate.get(override.date) ?? [];
    existing.push(override);
    overridesByDate.set(override.date, existing);
  }

  const blockedByDate = new Map<string, typeof blockedTimes>();
  for (const blocked of blockedTimes) {
    const existing = blockedByDate.get(blocked.date) ?? [];
    existing.push(blocked);
    blockedByDate.set(blocked.date, existing);
  }

  const candidates = new Map<number, Date>();
  for (const hostDate of hostDates) {
    const dateOverrides = overridesByDate.get(hostDate) ?? [];
    let effectiveRanges: { startMinute: number; endMinute: number }[];
    if (dateOverrides.some((override) => override.kind === "unavailable")) {
      effectiveRanges = [];
    } else {
      const overrideRanges: { startMinute: number; endMinute: number }[] = [];
      for (const override of dateOverrides) {
        if (override.kind !== "available" || override.startMinute === null || override.endMinute === null) continue;
        overrideRanges.push({ startMinute: override.startMinute, endMinute: override.endMinute });
      }
      if (overrideRanges.length > 0) {
        effectiveRanges = overrideRanges;
      } else {
        const weekday = getWeekdayOfDateString(hostDate);
        effectiveRanges = weeklyRanges
          .filter((range) => range.weekday === weekday)
          .map((range) => ({ startMinute: range.startMinute, endMinute: range.endMinute }));
      }
    }

    const blockedForDate = blockedByDate.get(hostDate) ?? [];
    for (const range of effectiveRanges) {
      const increment = applySchedulingLimits
        ? rules.startTimeIncrementMinutes ?? query.durationMinutes
        : query.durationMinutes;
      for (let minute = range.startMinute; minute + query.durationMinutes <= range.endMinute; minute += increment) {
        const isBlocked = blockedForDate.some(
          (blocked) => minute < blocked.endMinute && minute + query.durationMinutes > blocked.startMinute,
        );
        if (isBlocked) continue;
        const start = zonedWallTimeToUtc(hostDate, minute, query.hostTimezone);
        if (!start) continue;
        if (getDateInTimezone(start, query.timezone) !== query.date) continue;
        candidates.set(start.getTime(), start);
      }
    }
  }

  const slots = [...candidates.values()];
  return filterAvailableStarts({
    hostId: query.hostId,
    durationMinutes: query.durationMinutes,
    starts: slots,
    executor: query.executor,
    excludeBookingId: query.excludeBookingId,
    rules,
    hostTimezone: query.hostTimezone,
    applySchedulingLimits,
    busyTimes: query.busyTimes,
  });
}

export async function getAvailableProposedStarts(query: {
  hostId: string;
  hostTimezone: string;
  durationMinutes: number;
  starts: Date[];
  executor?: SlotExecutor;
  busyTimes?: BusyInterval[];
}): Promise<Date[]> {
  if (
    typeof query.hostId !== "string" ||
    query.hostId.trim().length === 0 ||
    !isIanaTimezone(query.hostTimezone) ||
    !Number.isInteger(query.durationMinutes) ||
    query.durationMinutes <= 0 ||
    !Array.isArray(query.starts)
  ) {
    return [];
  }

  const starts = [...new Map(
    query.starts
      .filter((start) => start instanceof Date && Number.isFinite(start.getTime()))
      .map((start) => [start.getTime(), start]),
  ).values()];
  if (starts.length === 0) return [];

  const database = query.executor ?? getDb();
  const hostDates = [...new Set(starts.flatMap((start) => {
    const end = new Date(start.getTime() + query.durationMinutes * 60_000);
    return [getDateInTimezone(start, query.hostTimezone), getDateInTimezone(new Date(end.getTime() - 1), query.hostTimezone)];
  }))];
  const [overrides, blockedTimes] = await Promise.all([
    database
      .select({ date: availabilityOverride.date, kind: availabilityOverride.kind })
      .from(availabilityOverride)
      .where(and(eq(availabilityOverride.userId, query.hostId), inArray(availabilityOverride.date, hostDates))),
    database
      .select({ date: blockedTime.date, startMinute: blockedTime.startMinute, endMinute: blockedTime.endMinute })
      .from(blockedTime)
      .where(and(eq(blockedTime.userId, query.hostId), inArray(blockedTime.date, hostDates))),
  ]);
  const unavailableDates = new Set(overrides.filter((override) => override.kind === "unavailable").map((override) => override.date));
  const rules = await getAvailabilityRules(query.hostId, query.executor);
  const available = await filterAvailableStarts({
    hostId: query.hostId,
    durationMinutes: query.durationMinutes,
    starts,
    executor: query.executor,
    rules,
    hostTimezone: query.hostTimezone,
    applySchedulingLimits: false,
    busyTimes: query.busyTimes,
  });

  return available.filter((start) => {
    const end = new Date(start.getTime() + query.durationMinutes * 60_000);
    const firstDate = getDateInTimezone(start, query.hostTimezone);
    const lastDate = getDateInTimezone(new Date(end.getTime() - 1), query.hostTimezone);
    if (unavailableDates.has(firstDate) || unavailableDates.has(lastDate)) return false;
    return !blockedTimes.some((blocked) => {
      if (blocked.date !== firstDate && blocked.date !== lastDate) return false;
      const blockedStart = zonedWallTimeToUtc(blocked.date, blocked.startMinute, query.hostTimezone);
      const blockedEnd = blocked.endMinute === 1440
        ? zonedWallTimeToUtc(addDaysToDateString(blocked.date, 1), 0, query.hostTimezone)
        : zonedWallTimeToUtc(blocked.date, blocked.endMinute, query.hostTimezone);
      if (!blockedStart || !blockedEnd) return false;
      return intervalsOverlap({ start, end }, { start: blockedStart, end: blockedEnd });
    });
  });
}

async function filterAvailableStarts(query: {
  hostId: string;
  durationMinutes: number;
  starts: Date[];
  executor?: SlotExecutor;
  excludeBookingId?: string;
  rules?: AvailabilityRules;
  hostTimezone: string;
  applySchedulingLimits?: boolean;
  busyTimes?: BusyInterval[];
}): Promise<Date[]> {
  const now = new Date();
  const rules = query.rules ?? await getAvailabilityRules(query.hostId, query.executor);
  const minimumNoticeMs = rules.minimumNoticeHours * 3_600_000;
  const bufferMs = (rules.bufferBeforeMinutes + rules.bufferAfterMinutes) * 60_000;
  const starts = [...new Map(
    query.starts
      .filter((start) => start.getTime() >= now.getTime() + minimumNoticeMs)
      .map((start) => [start.getTime(), start]),
  ).values()];
  if (starts.length === 0) return [];

  const candidateEnds = starts.map((start) => new Date(start.getTime() + query.durationMinutes * 60_000));
  const windowStart = new Date(Math.min(...starts.map((start) => start.getTime())) - bufferMs);
  const windowEnd = new Date(Math.max(...candidateEnds.map((end) => end.getTime())) + bufferMs);
  const database = query.executor ?? getDb();
  const existingBookings = await database
    .select({ startUtc: booking.startUtc, endUtc: booking.endUtc })
    .from(booking)
    .where(
      and(
        eq(booking.hostId, query.hostId),
        eq(booking.status, "active"),
        ...(query.excludeBookingId ? [ne(booking.id, query.excludeBookingId)] : []),
        lt(booking.startUtc, windowEnd),
        gt(booking.endUtc, windowStart),
      ),
    );

  const limits = query.applySchedulingLimits !== false && (
    rules.dailyMeetingLimit !== null || rules.weeklyMeetingLimit !== null || rules.monthlyMeetingLimit !== null
  );
  const activeStarts = limits
    ? await database
        .select({ startUtc: booking.startUtc })
        .from(booking)
        .where(and(
          eq(booking.hostId, query.hostId),
          eq(booking.status, "active"),
          ...(query.excludeBookingId ? [ne(booking.id, query.excludeBookingId)] : []),
        ))
    : [];
  const localDates = activeStarts.map(({ startUtc }) => getDateInTimezone(startUtc, query.hostTimezone));
  const weekStartFor = (date: string) =>
    addDaysToDateString(date, getWeekdayOfDateString(date) === 0 ? -6 : 1 - getWeekdayOfDateString(date));
  const counts = { day: new Map<string, number>(), week: new Map<string, number>(), month: new Map<string, number>() };
  for (const date of localDates) {
    for (const [period, key] of [["day", date], ["week", weekStartFor(date)], ["month", date.slice(0, 7)]] as const) {
      const periodCounts = counts[period];
      periodCounts.set(key, (periodCounts.get(key) ?? 0) + 1);
    }
  }
  const countFor = (date: string, period: "day" | "week" | "month") => {
    const key = period === "day" ? date : period === "week" ? weekStartFor(date) : date.slice(0, 7);
    return counts[period].get(key) ?? 0;
  };

  return starts
    .filter((start, index) => {
      if (limits) {
        const date = getDateInTimezone(start, query.hostTimezone);
        if (
          (rules.dailyMeetingLimit !== null && countFor(date, "day") >= rules.dailyMeetingLimit) ||
          (rules.weeklyMeetingLimit !== null && countFor(date, "week") >= rules.weeklyMeetingLimit) ||
          (rules.monthlyMeetingLimit !== null && countFor(date, "month") >= rules.monthlyMeetingLimit)
        ) return false;
      }
      const interval = bufferedInterval(start, candidateEnds[index], rules);
      if (query.busyTimes?.some((busy) => intervalsOverlap(interval, busy))) return false;
      return !existingBookings.some((existingBooking) =>
        intervalsOverlap(interval, bufferedInterval(existingBooking.startUtc, existingBooking.endUtc, rules)),
      );
    })
    .sort((left, right) => left.getTime() - right.getTime());
}
