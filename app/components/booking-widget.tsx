"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { Button, ErrorField, Input } from "./ui";
import { BookingCalendar } from "./booking-calendar";
import { formatInstant } from "../../server/timezone";

type Question = {
  id: string;
  label: string;
  questionType: "short_text" | "long_text" | "single_choice";
  options: string[] | null;
  required: boolean;
};

type BookingWidgetProps = {
  username?: string;
  eventSlug?: string;
  durationMinutes: number;
  questions: Question[];
  timezones: string[];
  horizonDays: number | null;
  idPrefix?: string;
  bookingLink?: {
    token: string;
    kind: "event_type" | "one_off";
  };
  offeredStarts?: string[];
  onBookingLinkUnavailable?: (message: "This link has already been used" | "This link is no longer available") => void;
  reschedule?: ({
    token: string;
    bookingId?: never;
  } | {
    bookingId: string;
    token?: never;
  }) & {
    timezone: string;
    onRescheduled: () => void;
  };
};

function formatDateParts(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function todayInZone(timezone: string): string {
  return calendarDateInZone(new Date(), timezone);
}

function calendarDateInZone(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return formatDateParts(Number(values.year), Number(values.month), Number(values.day));
}

function offeredDatesInZone(starts: string[], timezone: string): string[] {
  const now = Date.now();
  return [...new Set(starts
    .map((start) => ({ start, timestamp: Date.parse(start) }))
    .filter(({ timestamp }) => Number.isFinite(timestamp) && timestamp > now)
    .sort((left, right) => left.timestamp - right.timestamp)
    .map(({ timestamp }) => calendarDateInZone(new Date(timestamp), timezone)))];
}

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const result = new Date(Date.UTC(year, month - 1, day + days));
  return formatDateParts(result.getUTCFullYear(), result.getUTCMonth() + 1, result.getUTCDate());
}

function formatDateLabel(date: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}

function formatTime(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

function formatDateTime(iso: string, timezone: string): string {
  return formatInstant(new Date(iso), timezone);
}

export function BookingWidget({
  username,
  eventSlug,
  durationMinutes,
  questions,
  timezones,
  horizonDays,
  idPrefix = "booking",
  bookingLink,
  offeredStarts,
  onBookingLinkUnavailable,
  reschedule,
}: BookingWidgetProps) {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [timezone, setTimezone] = useState("UTC");
  const [timezoneText, setTimezoneText] = useState("");
  const [date, setDate] = useState("");
  const [month, setMonth] = useState("");
  const [days, setDays] = useState<Record<string, string[]>>({});
  const [loadedKey, setLoadedKey] = useState("");
  const detailsHeading = useRef<HTMLHeadingElement>(null);
  const pickerHeading = useRef<HTMLHeadingElement>(null);
  const previousSelection = useRef<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [availabilityError, setAvailabilityError] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [submitPending, setSubmitPending] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});

  useEffect(() => {
    const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const selectedTimezone = reschedule?.timezone ?? (timezones.includes(browserTimezone) ? browserTimezone : "UTC");
    setTimezone(selectedTimezone);
    setTimezoneText(selectedTimezone);
    const offeredDates = bookingLink?.kind === "one_off" && offeredStarts
      ? offeredDatesInZone(offeredStarts, selectedTimezone)
      : [];
    const initialDate = offeredDates[0] ?? todayInZone(selectedTimezone);
    setDate(initialDate);
    setMonth(initialDate.slice(0, 7));
    setMounted(true);
  }, [bookingLink?.kind, offeredStarts, reschedule?.timezone, timezones]);

  useEffect(() => {
    if (!mounted || !month || !timezone) return;
    const controller = new AbortController();
    setLoading(true);
    setAvailabilityError("");
    setDays({});

    async function loadSlots() {
      try {
        const params = new URLSearchParams({ month, tz: timezone });
        const availabilityUrl = bookingLink
          ? `/api/public/booking-links/${encodeURIComponent(bookingLink.token)}/availability?${params}`
          : (() => {
              if (!username || !eventSlug) throw new Error();
              params.set("username", username);
              params.set("eventSlug", eventSlug);
              if (reschedule?.bookingId) params.set("rescheduleBookingId", reschedule.bookingId);
              if (reschedule?.token) params.set("rescheduleToken", reschedule.token);
              return `/api/public/availability?${params}`;
            })();
        const response = await fetch(availabilityUrl, { signal: controller.signal });
        const result = (await response.json().catch(() => ({}))) as { days?: Record<string, string[]>; error?: string };
        if (
          bookingLink &&
          (response.status === 404 || response.status === 410) &&
          (result.error === "This link has already been used" || result.error === "This link is no longer available")
        ) {
          onBookingLinkUnavailable?.(result.error);
          return;
        }
        if (!response.ok || !result.days) throw new Error();
        setDays(result.days);
        setLoadedKey(`${month}|${timezone}`);
        const freeDays = Object.keys(result.days).filter(day => result.days![day].length > 0);
        setDate(current => result.days![current]?.length ? current : freeDays[0] ?? `${month}-01`);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setAvailabilityError("Times couldn’t be loaded. Please try again.");
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    void loadSlots();
    return () => controller.abort();
  }, [bookingLink?.token, month, eventSlug, mounted, onBookingLinkUnavailable, refreshKey, reschedule?.bookingId, reschedule?.token, timezone, username]);

  function chooseTimezone(nextTimezone: string) {
    if (reschedule) return;
    setTimezoneText(nextTimezone);
    if ((!timezones.includes(nextTimezone) && nextTimezone !== "UTC") || nextTimezone === timezone) return;
    setTimezone(nextTimezone);
    setMonth((date || todayInZone(nextTimezone)).slice(0, 7));
    const nextToday = todayInZone(nextTimezone);
    const nextMaximumDate = bookingLink?.kind === "one_off" || horizonDays === null ? "" : addDays(nextToday, horizonDays - 1);
    if (bookingLink?.kind === "one_off" && offeredStarts) {
      const offeredDates = offeredDatesInZone(offeredStarts, nextTimezone);
      chooseDate(offeredDates.includes(date) ? date : offeredDates[0] ?? nextToday);
    } else if (!date) {
      chooseDate(nextToday);
    } else if (date < nextToday) {
      chooseDate(nextToday);
    } else if (nextMaximumDate && date > nextMaximumDate) {
      chooseDate(nextMaximumDate);
    }
    setSelected(null);
    setAvailabilityError("");
    setSubmitError("");
  }

  function restoreTimezoneOnBlur() {
    if (!timezones.includes(timezoneText)) setTimezoneText(timezone);
  }

  function chooseDate(nextDate: string) {
    setDate(nextDate);
    setMonth(nextDate.slice(0, 7));
    setSelected(null);
    setSubmitError("");
  }

  async function submitBooking(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    setSubmitPending(true);
    setSubmitError("");
    try {
      const bookingUrl = reschedule
        ? reschedule.bookingId
          ? `/api/bookings/${reschedule.bookingId}/reschedule`
          : `/api/public/bookings/${reschedule.token}/reschedule`
        : bookingLink
          ? `/api/public/booking-links/${encodeURIComponent(bookingLink.token)}`
          : "/api/public/bookings";
      const response = await fetch(bookingUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(reschedule ? { startUtc: selected } : {
          ...(!bookingLink ? { username, eventSlug } : {}),
          startUtc: selected,
          timezone,
          name,
          email,
          answers: questions.map((question) => ({
            questionId: question.id,
            answer: (answers[question.id] ?? "").trim(),
          })),
        }),
      });
      const result = (await response.json().catch(() => ({}))) as { error?: string; confirmationToken?: string };
      if (
        response.status === 409 ||
        (response.status === 400 && result.error === "Choose an available time.")
      ) {
        setSubmitError(result.error || "This time was just booked, please choose another");
        setSelected(null);
        setRefreshKey((current) => current + 1);
        return;
      }
      if (!response.ok) {
        if (
          bookingLink &&
          (response.status === 404 || response.status === 410) &&
          (result.error === "This link has already been used" || result.error === "This link is no longer available")
        ) {
          onBookingLinkUnavailable?.(result.error);
          return;
        }
        setSubmitError(result.error || (reschedule
          ? "Your booking couldn’t be rescheduled. Please try again."
          : "Your booking couldn’t be completed. Please try again."));
        return;
      }
      if (reschedule) {
        reschedule.onRescheduled();
        return;
      }
      if (!result.confirmationToken) throw new Error();
      router.push(`/booking/${result.confirmationToken}`);
    } catch {
      setSubmitError(reschedule
        ? "Your booking couldn’t be rescheduled. Check your connection and try again."
        : "Your booking couldn’t be completed. Check your connection and try again.");
    } finally {
      setSubmitPending(false);
    }
  }

  const today = mounted ? todayInZone(timezone) : "";
  const maximumDate = bookingLink?.kind === "one_off" || horizonDays === null
    ? undefined
    : today ? addDays(today, horizonDays - 1) : "";
  const slotsStale = loadedKey !== `${month}|${timezone}`;
  const slots = days[date] ?? [];
  const friendlyTimezone = mounted ? new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "long" }).formatToParts(new Date()).find(part => part.type === "timeZoneName")?.value : "";
  useEffect(() => {
    if (selected) detailsHeading.current?.focus();
    else if (previousSelection.current) pickerHeading.current?.focus();
    previousSelection.current = selected;
  }, [selected]);
  return (
    <div className={`booking-widget${selected ? "" : " booking-picker"}`}>
      <p className="booking-step">{selected ? "Step 2 of 2 · Your details" : "Step 1 of 2 · Date and time"}</p>
      <h2 ref={pickerHeading} tabIndex={-1} className={selected ? "visually-hidden" : "booking-picker-title"}>Choose a date and time</h2>
      {!selected && <>
      {!mounted ? (
        <p className="field-hint">Detecting your time zone…</p>
      ) : reschedule ? (
        <p className="field-hint">Times are shown in your booking time zone: {timezone}.</p>
      ) : (
        <div className="field">
          <label htmlFor={`${idPrefix}-timezone`}>Time zone</label>
          <input
            id={`${idPrefix}-timezone`}
            className="input"
            list={`${idPrefix}-timezone-list`}
            value={timezoneText}
            onChange={(event) => chooseTimezone(event.target.value)}
            onBlur={restoreTimezoneOnBlur}
            autoComplete="off"
          />
          <datalist id={`${idPrefix}-timezone-list`}>
            {timezones.map((item) => <option key={item} value={item} />)}
          </datalist>
          <span className="field-hint">{friendlyTimezone} · All times below use this zone.</span>
        </div>
      )}

      {mounted && <BookingCalendar month={month} date={date} availableDates={Object.keys(days).filter(day => days[day].length > 0)}
        loading={loading || slotsStale} min={today} max={maximumDate}
        onMonth={value => { setMonth(value); setSelected(null); }} onDate={chooseDate} />}

      {availabilityError && !loading && (
        <>
          <ErrorField>{availabilityError}</ErrorField>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setAvailabilityError("");
              setRefreshKey((current) => current + 1);
            }}
          >
            Try again
          </Button>
        </>
      )}
      {mounted && date && (
        <div className="booking-times">
          <h2>{formatDateLabel(date)}</h2>
          {availabilityError ? null : loading || slotsStale ? (
            <p className="field-hint">Loading times…</p>
          ) : slots.length > 0 ? (
            <div className="times-grid">
              {slots.map((slot) => (
                <button
                  key={slot}
                  type="button"
                  className="button button-secondary time-button"
                  aria-label={`Choose ${formatTime(slot, timezone)}`}
                  onClick={() => {
                    setSelected(slot);
                    setSubmitError("");
                  }}
                >
                  {formatTime(slot, timezone)}
                </button>
              ))}
            </div>
          ) : (
            <p className="field-hint">No free times on this day. Try another date.</p>
          )}
        </div>
      )}

      </>}
      {!selected && submitError && <ErrorField>{submitError}</ErrorField>}
      {selected && (
        <form className="booking-form booking-details-form" onSubmit={submitBooking}>
          <h2 ref={detailsHeading} tabIndex={-1}>{reschedule ? "Confirm your new time" : "Your details"}</h2>
          <p className="booking-summary">
            {formatDateTime(selected, timezone)} · {durationMinutes} minutes
          </p>
          {submitError && <ErrorField>{submitError}</ErrorField>}
          {!reschedule && <>
            <Input
              id={`${idPrefix}-name`}
              label="Your name"
              name="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
            <Input
              id={`${idPrefix}-email`}
              label="Email"
              name="email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </>}
          {!reschedule && questions.map((question) => {
            const inputId = `${idPrefix}-question-${question.id}`;
            const value = answers[question.id] ?? "";
            const updateAnswer = (answer: string) => setAnswers((current) => ({ ...current, [question.id]: answer }));
            if (question.questionType === "short_text") {
              return (
                <Input
                  key={question.id}
                  id={inputId}
                  label={question.label}
                  hint={question.required ? "Required" : undefined}
                  value={value}
                  onChange={(event) => updateAnswer(event.target.value)}
                  required={question.required}
                  maxLength={500}
                />
              );
            }
            return (
              <div className="field" key={question.id}>
                <label htmlFor={inputId}>{question.label}</label>
                {question.questionType === "long_text" ? (
                  <textarea
                    id={inputId}
                    className="textarea"
                    rows={4}
                    value={value}
                    onChange={(event) => updateAnswer(event.target.value)}
                    required={question.required}
                    maxLength={2000}
                  />
                ) : question.questionType === "single_choice" ? (
                  <select
                    id={inputId}
                    className="input"
                    value={value}
                    onChange={(event) => updateAnswer(event.target.value)}
                    required={question.required}
                  >
                    <option value="" disabled>Select an option</option>
                    {question.options?.map((option) => <option key={option} value={option}>{option}</option>)}
                  </select>
                ) : null}
                {question.required && <span className="field-hint">Required</span>}
              </div>
            );
          })}
          <div className="booking-form-actions">
            <Button type="submit" disabled={submitPending}>{submitPending
              ? reschedule ? "Rescheduling…" : "Booking…"
              : reschedule ? "Confirm new time" : "Book meeting"}</Button>
            <Button type="button" variant="secondary" onClick={() => setSelected(null)}>Choose another time</Button>
          </div>
        </form>
      )}
    </div>
  );
}
