import { asc, eq } from "drizzle-orm";

import { BookingConfirmationActions } from "../../components/booking-confirmation-actions";
import { Card, PageHeader } from "../../components/ui";
import { getDb } from "../../../server/db";
import { booking, bookingAnswer, bookingLink, eventType, user } from "../../../server/schema";
import { getAvailabilityRules } from "../../../server/slots";
import { formatInstant } from "../../../server/timezone";

export const dynamic = "force-dynamic";

export default async function BookingConfirmationPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const [confirmedBooking] = await getDb()
    .select({
      id: booking.id,
      hostId: booking.hostId,
      pollId: booking.pollId,
      startUtc: booking.startUtc,
      endUtc: booking.endUtc,
      status: booking.status,
      rescheduleHistory: booking.rescheduleHistory,
      cancellationActor: booking.cancellationActor,
      cancellationReason: booking.cancellationReason,
      inviteeName: booking.inviteeName,
      inviteeEmail: booking.inviteeEmail,
      inviteeTimezone: booking.inviteeTimezone,
      bookingLinkKind: bookingLink.kind,
      meetingName: bookingLink.meetingName,
      meetingDescription: bookingLink.description,
      meetingLocation: bookingLink.location,
      meetingDurationMinutes: bookingLink.durationMinutes,
      eventName: eventType.name,
      eventSlug: eventType.slug,
      durationMinutes: eventType.durationMinutes,
      hostName: user.name,
      username: user.username,
    })
    .from(booking)
    .leftJoin(eventType, eq(booking.eventTypeId, eventType.id))
    .innerJoin(user, eq(booking.hostId, user.id))
    .leftJoin(bookingLink, eq(booking.bookingLinkId, bookingLink.id))
    .where(eq(booking.confirmationToken, token))
    .limit(1);

  if (!confirmedBooking) {
    return (
      <main className="app-shell">
        <div className="dashboard-content scheduling-content">
          <PageHeader
            eyebrow="Booking"
            title="This booking link isn’t valid"
            description="Check that you copied the whole link."
          />
        </div>
      </main>
    );
  }

  const answers = await getDb()
    .select({
      questionLabel: bookingAnswer.questionLabel,
      answer: bookingAnswer.answer,
    })
    .from(bookingAnswer)
    .where(eq(bookingAnswer.bookingId, confirmedBooking.id))
    .orderBy(asc(bookingAnswer.position));
  const rules = await getAvailabilityRules(confirmedBooking.hostId);
  const hasStarted = confirmedBooking.startUtc.getTime() <= Date.now();
  const isOneOffBooking = confirmedBooking.bookingLinkKind === "one_off";
  const statusLabel = confirmedBooking.status === "cancelled" ? "Cancelled" : hasStarted ? "Started" : "Confirmed";

  return (
    <main className="app-shell">
      <div className="dashboard-content scheduling-content">
        <Card className="scheduling-card booking-receipt">
          <header className="receipt-heading">
            <p className={`booking-status${confirmedBooking.status === "cancelled" ? " booking-status-cancelled" : ""}`}>Status: {statusLabel}</p>
            <h1>{isOneOffBooking ? confirmedBooking.meetingName ?? "One-off meeting" : confirmedBooking.eventName ?? "Meeting"}</h1>
            <p>With {confirmedBooking.hostName}</p>
          </header>
          <dl className="receipt-details">
            <div><dt>When</dt><dd>{formatInstant(confirmedBooking.startUtc, confirmedBooking.inviteeTimezone)}</dd></div>
            <div><dt>Time zone</dt><dd>{confirmedBooking.inviteeTimezone}</dd></div>
            <div><dt>Guest</dt><dd>{confirmedBooking.inviteeName}<br />{confirmedBooking.inviteeEmail}</dd></div>
          </dl>
          {confirmedBooking.rescheduleHistory.length > 0 && <details className="receipt-history">
            <summary>Previous times ({confirmedBooking.rescheduleHistory.length})</summary>
            {confirmedBooking.rescheduleHistory.map((previous, index) => <p key={index}>{formatInstant(new Date(previous.startUtc), confirmedBooking.inviteeTimezone)}</p>)}
          </details>}
          {isOneOffBooking && confirmedBooking.meetingDescription && <p>{confirmedBooking.meetingDescription}</p>}
          {isOneOffBooking && confirmedBooking.meetingLocation && <p>Location: {confirmedBooking.meetingLocation}</p>}
          {confirmedBooking.status === "cancelled" && <div className="receipt-cancellation">
            {confirmedBooking.cancellationActor && (
              <p>Cancelled by: {confirmedBooking.cancellationActor === "invitee" ? "You" : "Host"}</p>
            )}
            {confirmedBooking.cancellationReason && <p>Cancellation reason: {confirmedBooking.cancellationReason}</p>}
          </div>}

          {answers.length === 0 ? (
            <p className="field-hint">No additional answers.</p>
          ) : (
            <div>
              {answers.map((answer, index) => (
                <div className="answer-row" key={`${answer.questionLabel}-${index}`}>
                  <span className="field-label">{answer.questionLabel}</span>
                  <span>{answer.answer}</span>
                </div>
              ))}
            </div>
          )}

          <p className="notice-banner">No email is sent. Save this page link to keep your booking details.</p>

          {confirmedBooking.status === "active" && !hasStarted && (isOneOffBooking || confirmedBooking.username) && (
            <BookingConfirmationActions
              token={token}
              username={isOneOffBooking ? null : confirmedBooking.username}
              eventSlug={confirmedBooking.eventSlug ?? ""}
              durationMinutes={confirmedBooking.meetingDurationMinutes ?? confirmedBooking.durationMinutes ?? Math.round((confirmedBooking.endUtc.getTime() - confirmedBooking.startUtc.getTime()) / 60000)}
              timezone={confirmedBooking.inviteeTimezone}
              timezones={Intl.supportedValuesOf("timeZone")}
              horizonDays={confirmedBooking.pollId ? null : rules.bookingHorizonDays}
            />
          )}
        </Card>
      </div>
    </main>
  );
}
