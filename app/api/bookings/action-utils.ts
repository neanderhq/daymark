import { calendarErrorResponse } from "../../../server/google-calendar";
import {
  BookingNotAvailableError,
  BookingNotFoundError,
  OneOffBookingCannotRescheduleError,
  SlotTakenError,
  StaleBookingDetailsError,
} from "../../../server/bookings";

const bookingIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isBookingId(value: string): boolean {
  return bookingIdPattern.test(value);
}

export function parseUtcStart(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const startUtc = new Date(timestamp);
  return startUtc.toISOString() === value ? startUtc : null;
}

export function bookingActionErrorResponse(error: unknown) {
  const unavailable = calendarErrorResponse(error);
  if (unavailable) return unavailable;
  if (error instanceof BookingNotFoundError) {
    return Response.json({ error: "Booking not found." }, { status: 404 });
  }
  if (error instanceof SlotTakenError) return Response.json({ error: error.message }, { status: 409 });
  if (error instanceof BookingNotAvailableError) {
    return Response.json({ error: "This booking can no longer be changed." }, { status: 409 });
  }
  if (error instanceof OneOffBookingCannotRescheduleError) {
    return Response.json({ error: error.message }, { status: 409 });
  }
  if (error instanceof StaleBookingDetailsError) {
    return Response.json({ error: "Choose an available time in the future." }, { status: 409 });
  }
  return Response.json({ error: "Unable to update this booking." }, { status: 500 });
}
