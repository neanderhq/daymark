"use client";

import { Button } from "./ui";

export function shiftMonth(month: string, delta: number) {
  const [year, number] = month.split("-").map(Number);
  return new Date(Date.UTC(year, number - 1 + delta, 1)).toISOString().slice(0, 7);
}

export function BookingCalendar({ month, date, availableDates, loading, min, max, onMonth, onDate }: {
  month: string;
  date: string;
  availableDates: string[];
  loading: boolean;
  min: string;
  max?: string;
  onMonth: (month: string) => void;
  onDate: (date: string) => void;
}) {
  const [year, number] = month.split("-").map(Number);
  const first = new Date(Date.UTC(year, number - 1, 1));
  const count = new Date(Date.UTC(year, number, 0)).getUTCDate();
  const offset = (first.getUTCDay() + 6) % 7;
  const label = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(first);
  return <div className="booking-calendar" aria-label="Booking calendar" aria-busy={loading}>
    <div className="calendar-nav">
      <Button variant="secondary" type="button" aria-label="Previous month" disabled={month <= min.slice(0, 7)} onClick={() => onMonth(shiftMonth(month, -1))}>‹</Button>
      <h3 aria-live="polite">{label}</h3>
      <Button variant="secondary" type="button" aria-label="Next month" disabled={Boolean(max && month >= max.slice(0, 7))} onClick={() => onMonth(shiftMonth(month, 1))}>›</Button>
    </div>
    <div className="calendar-grid">
      {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(day => <span className="calendar-weekday" key={day}>{day}</span>)}
      {Array.from({ length: offset }, (_, i) => <span key={`empty-${i}`} />)}
      {Array.from({ length: count }, (_, i) => {
        const value = `${month}-${String(i + 1).padStart(2, "0")}`;
        const available = availableDates.includes(value);
        const fullLabel = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T12:00:00Z`));
        return <button type="button" key={value} className="calendar-day" disabled={loading || !available}
          aria-label={`${fullLabel}${available ? " — available" : " — unavailable"}`}
          tabIndex={date === value || (!availableDates.includes(date) && value === availableDates[0]) ? 0 : -1}
          data-calendar-date={value}
          onKeyDown={event => {
            const direction = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 7, ArrowUp: -7 }[event.key];
            if (direction === undefined) return;
            event.preventDefault();
            let next = i + 1 + direction;
            while (next >= 1 && next <= count) {
              const candidate = `${month}-${String(next).padStart(2, "0")}`;
              if (availableDates.includes(candidate)) {
                onDate(candidate);
                event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-calendar-date="${candidate}"]`)?.focus();
                break;
              }
              next += direction;
            }
          }}
          aria-pressed={date === value} aria-current={value === min ? "date" : undefined}
          onClick={() => onDate(value)}>{i + 1}</button>;
      })}
    </div>
    <p className="field-hint" role="status">{loading ? "Finding available days…" : availableDates.length ? "Highlighted days have available times." : "No available days this month. Try the next month."}</p>
  </div>;
}
