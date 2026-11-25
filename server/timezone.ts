const ianaTimezones = new Set(Intl.supportedValuesOf("timeZone"));
const zoneFormatters = new Map<string, { formatter: Intl.DateTimeFormat; isIana: boolean }>();
const maxZoneFormatters = 64;

function zoneFormatter(timezone: string) {
  const cached = zoneFormatters.get(timezone);
  if (cached) return cached;

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const canonical = formatter.resolvedOptions().timeZone;
  const entry = { formatter, isIana: canonical === "UTC" || ianaTimezones.has(canonical) };
  // Month availability formats thousands of instants. Bound the cache because
  // requests can supply time zone aliases and spelling variants.
  if (zoneFormatters.size >= maxZoneFormatters) {
    const oldest = zoneFormatters.keys().next();
    if (!oldest.done) zoneFormatters.delete(oldest.value);
  }
  zoneFormatters.set(timezone, entry);
  return entry;
}

export function isIanaTimezone(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 100) return false;
  try {
    return zoneFormatter(value).isIana;
  } catch {
    return false;
  }
}

type ZonedWallTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

function readZonedWallTime(instant: Date, timezone: string): ZonedWallTime {
  const parts = zoneFormatter(timezone).formatter.formatToParts(instant);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

function getTimezoneOffsetMs(instant: Date, timezone: string): number {
  const wallTime = readZonedWallTime(instant, timezone);
  return (
    Date.UTC(wallTime.year, wallTime.month - 1, wallTime.day, wallTime.hour, wallTime.minute) -
    Date.UTC(
      instant.getUTCFullYear(),
      instant.getUTCMonth(),
      instant.getUTCDate(),
      instant.getUTCHours(),
      instant.getUTCMinutes(),
      instant.getUTCSeconds(),
      instant.getUTCMilliseconds(),
    )
  );
}

function parseDateString(date: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new TypeError("Expected a YYYY-MM-DD date.");

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new TypeError("Expected a valid YYYY-MM-DD date.");
  }
  return timestamp;
}

function formatDateParts(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function wallTimeMatches(instant: Date, timezone: string, expected: ZonedWallTime): boolean {
  const actual = readZonedWallTime(instant, timezone);
  return (
    actual.year === expected.year &&
    actual.month === expected.month &&
    actual.day === expected.day &&
    actual.hour === expected.hour &&
    actual.minute === expected.minute
  );
}

export function getDateInTimezone(instant: Date, timezone: string): string {
  const wallTime = readZonedWallTime(instant, timezone);
  return formatDateParts(wallTime.year, wallTime.month, wallTime.day);
}

export function getWeekdayOfDateString(date: string): number {
  return new Date(parseDateString(date)).getUTCDay();
}

export function addDaysToDateString(date: string, days: number): string {
  if (!Number.isInteger(days)) throw new TypeError("Expected an integer number of days.");
  const parsed = new Date(parseDateString(date));
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return formatDateParts(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, parsed.getUTCDate());
}

export function zonedWallTimeToUtc(date: string, minuteOfDay: number, timezone: string): Date | null {
  if (!isIanaTimezone(timezone) || !Number.isInteger(minuteOfDay) || minuteOfDay < 0 || minuteOfDay > 1439) {
    return null;
  }

  let dateTimestamp: number;
  try {
    dateTimestamp = parseDateString(date);
  } catch {
    return null;
  }

  const expected = {
    year: new Date(dateTimestamp).getUTCFullYear(),
    month: new Date(dateTimestamp).getUTCMonth() + 1,
    day: new Date(dateTimestamp).getUTCDate(),
    hour: Math.floor(minuteOfDay / 60),
    minute: minuteOfDay % 60,
  };
  const wallTimeAsUtc = Date.UTC(expected.year, expected.month - 1, expected.day, expected.hour, expected.minute);
  const firstOffset = getTimezoneOffsetMs(new Date(wallTimeAsUtc), timezone);
  const firstCandidate = new Date(wallTimeAsUtc - firstOffset);
  const secondOffset = getTimezoneOffsetMs(firstCandidate, timezone);
  const secondCandidate = new Date(wallTimeAsUtc - secondOffset);
  const adjacentOffsets = [-86_400_000, 0, 86_400_000].map((adjustment) =>
    getTimezoneOffsetMs(new Date(wallTimeAsUtc + adjustment), timezone),
  );
  const candidates = [
    firstCandidate,
    secondCandidate,
    ...adjacentOffsets.map((offset) => new Date(wallTimeAsUtc - offset)),
  ];
  const validCandidates = candidates.filter((candidate) => wallTimeMatches(candidate, timezone, expected));
  if (validCandidates.length === 0) return null;

  return new Date(Math.min(...validCandidates.map((candidate) => candidate.getTime())));
}

export function formatInstant(instant: Date, timezone: string): string {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(instant);
  return `${formatted} (${timezone})`;
}

export function formatTimeInTimezone(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
  }).format(instant);
}
