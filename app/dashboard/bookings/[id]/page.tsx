import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";

import { BookingActions } from "../../../components/booking-confirmation-actions";
import { SignOutButton } from "../../../components/sign-out-button";
import { Card, PageHeader } from "../../../components/ui";
import { getAuth } from "../../../../server/auth";
import { getDb } from "../../../../server/db";
import { booking, bookingAnswer, bookingAttendee, bookingLink, eventType, user } from "../../../../server/schema";
import { getAvailabilityRules } from "../../../../server/slots";
import { formatInstant } from "../../../../server/timezone";

export default async function BookingDetailsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ view?: string | string[] }>;
}) {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) redirect("/login");

  const [{ id }, { view: requestedView }] = await Promise.all([params, searchParams]);
  const view = Array.isArray(requestedView) ? requestedView[0] : requestedView;
  const backView = view === "past" || view === "cancelled" ? view : "upcoming";
  const [profile] = await getDb()
    .select({ timezone: user.timezone })
    .from(user)
    .where(eq(user.id, session.user.id))
    .limit(1);
  const [bookingDetails] = await getDb()
    .select({
      id: booking.id,
      pollId: booking.pollId,
      startUtc: booking.startUtc,
      endUtc: booking.endUtc,
      status: booking.status,
      cancellationActor: booking.cancellationActor,
      cancellationReason: booking.cancellationReason,
      rescheduleHistory: booking.rescheduleHistory,
      inviteeName: booking.inviteeName,
      inviteeEmail: booking.inviteeEmail,
      bookingLinkKind: bookingLink.kind,
      meetingName: bookingLink.meetingName,
      meetingDescription: bookingLink.description,
      meetingLocation: bookingLink.location,
      meetingDurationMinutes: bookingLink.durationMinutes,
      eventName: eventType.name,
      eventSlug: eventType.slug,
      durationMinutes: eventType.durationMinutes,
      username: user.username,
    })
    .from(booking)
    .leftJoin(eventType, eq(booking.eventTypeId, eventType.id))
    .innerJoin(user, eq(booking.hostId, user.id))
    .leftJoin(bookingLink, eq(booking.bookingLinkId, bookingLink.id))
    .where(and(eq(booking.id, id), eq(booking.hostId, session.user.id)))
    .limit(1);
  const answers = bookingDetails
    ? await getDb()
        .select({
          position: bookingAnswer.position,
          questionLabel: bookingAnswer.questionLabel,
          answer: bookingAnswer.answer,
        })
        .from(bookingAnswer)
        .innerJoin(booking, eq(bookingAnswer.bookingId, booking.id))
        .where(
          and(
            eq(bookingAnswer.bookingId, bookingDetails.id),
            eq(booking.hostId, session.user.id),
          ),
        )
        .orderBy(asc(bookingAnswer.position))
    : [];
  const attendees = bookingDetails
    ? await getDb()
        .select({
          name: bookingAttendee.name,
          email: bookingAttendee.email,
        })
        .from(bookingAttendee)
        .where(eq(bookingAttendee.bookingId, bookingDetails.id))
        .orderBy(asc(bookingAttendee.position))
    : [];
  const hostTimezone = profile?.timezone ?? session.user.timezone;
  const rules = await getAvailabilityRules(session.user.id);
  const hasStarted = bookingDetails ? bookingDetails.startUtc.getTime() <= Date.now() : true;
  const isOneOffBooking = bookingDetails?.bookingLinkKind === "one_off";
  const statusLabel = bookingDetails?.status === "cancelled" ? "Cancelled" : hasStarted ? "Past" : "Confirmed";
  const bookingsHref = backView === "upcoming" ? "/dashboard/bookings" : `/dashboard/bookings?view=${backView}`;

  return (
    <main className="app-shell">
      <header className="app-header">
        <a className="brand" href="/" aria-label="Daymark home"><span className="brand-mark" aria-hidden="true">d</span><span>daymark</span></a>
        <Link className="text-link" href="/dashboard">← Back to your workspace</Link>
        <nav className="account-nav" aria-label="Account navigation">
          <span className="account-greeting">{session.user.name}</span>
          <a className="text-link" href="/settings">Settings</a>
          <SignOutButton />
        </nav>
      </header>
      <div className="dashboard-content scheduling-content">
        {bookingDetails ? (
          <>
            <PageHeader eyebrow="Bookings" title={bookingDetails.inviteeName} description={isOneOffBooking ? bookingDetails.meetingName ?? "One-off meeting" : bookingDetails.eventName ?? undefined} />
            <Card className="scheduling-card">
              <p><span className="field-label">Status</span>{statusLabel}</p>
              <div className="booking-details">
                <p>
                  <span className="field-label">Date and time</span>
                  {formatInstant(bookingDetails.startUtc, hostTimezone)}
                </p>
                <p className="timezone-note">Time zone: {hostTimezone}</p>
                <p>
                  <span className="field-label">Invitee</span>
                  {bookingDetails.inviteeName}
                </p>
                <p>
                  <span className="field-label">Email</span>
                  {bookingDetails.inviteeEmail}
                </p>
                {isOneOffBooking && bookingDetails.meetingDescription && (
                  <p>
                    <span className="field-label">Description</span>
                    {bookingDetails.meetingDescription}
                  </p>
                )}
                {isOneOffBooking && bookingDetails.meetingLocation && (
                  <p>
                    <span className="field-label">Location</span>
                    {bookingDetails.meetingLocation}
                  </p>
                )}
              </div>
              {bookingDetails.status === "cancelled" && <div className="booking-details">
                {bookingDetails.cancellationActor && (
                  <p>
                    <span className="field-label">Cancelled by</span>
                    {bookingDetails.cancellationActor === "host" ? "You" : "Invitee"}
                  </p>
                )}
                {bookingDetails.cancellationReason && (
                  <p>
                    <span className="field-label">Cancellation reason</span>
                    {bookingDetails.cancellationReason}
                  </p>
                )}
              </div>}
              {bookingDetails.rescheduleHistory.length > 0 && (
                <div className="booking-history">
                  <h2>Previous times</h2>
                  {bookingDetails.rescheduleHistory.map((item, index) => (
                    <p key={`${item.startUtc}-${index}`}>
                      {formatInstant(new Date(item.startUtc), hostTimezone)}
                    </p>
                  ))}
                </div>
              )}
              {attendees.length > 0 && (
                <div className="booking-details">
                  <h2>Attendees</h2>
                  {attendees.map((attendee) => (
                    <p key={attendee.email}>
                      <span className="field-label">{attendee.name}</span>
                      {attendee.email}
                    </p>
                  ))}
                </div>
              )}
              <div className="booking-answers">
                {answers.length > 0 ? (
                  answers.map((item) => (
                    <div className="answer-row" key={`${item.position}-${item.questionLabel}`}>
                      <span className="field-label">{item.questionLabel}</span>
                      <span>{item.answer}</span>
                    </div>
                  ))
                ) : (
                  <p className="no-answers">No additional answers.</p>
                )}
              </div>
              {bookingDetails.status === "active" && !hasStarted && (
                <BookingActions
                  authorization={{ kind: "host", bookingId: bookingDetails.id }}
                  username={isOneOffBooking ? null : bookingDetails.username}
                  eventSlug={bookingDetails.eventSlug ?? ""}
                  durationMinutes={Math.round((bookingDetails.endUtc.getTime() - bookingDetails.startUtc.getTime()) / 60000)}
                  timezone={hostTimezone}
                  timezones={[hostTimezone]}
                  horizonDays={bookingDetails.pollId ? null : rules.bookingHorizonDays}
                />
              )}
            </Card>
            <Link className="text-link booking-back-link" href={bookingsHref}>← Back to bookings</Link>
          </>
        ) : (
          <>
            <PageHeader eyebrow="Bookings" title="Booking not found" />
            <Card className="scheduling-card">
              <p>This booking doesn’t exist, or it isn’t yours.</p>
              <Link className="text-link booking-back-link" href={bookingsHref}>← Back to bookings</Link>
            </Card>
          </>
        )}
      </div>
    </main>
  );
}
