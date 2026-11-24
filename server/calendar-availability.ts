// The month view uses the same slot checks as an individual booking date.
export function availabilityDates(query: URLSearchParams): string[] | null {
  const month = query.get("month");
  if (month !== null) {
    if (query.has("date") || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return null;
    const [year, number] = month.split("-").map(Number);
    const end = new Date(Date.UTC(year, number, 0));
    if (end.getUTCFullYear() !== year) return null;
    return Array.from({ length: end.getUTCDate() }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
  }
  const date = query.get("date") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const [year, monthNumber, day] = date.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, monthNumber - 1, day));
  return parsed.toISOString().slice(0, 10) === date ? [date] : null;
}

export async function availabilityPayload(
  dates: string[],
  month: boolean,
  load: (date: string) => Promise<Date[]>,
) {
  const entries = await Promise.all(dates.map(async date => [date, (await load(date)).map(slot => slot.toISOString())] as const));
  return month ? { days: Object.fromEntries(entries) } : { slots: entries[0][1] };
}
