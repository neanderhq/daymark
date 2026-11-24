import { and, eq } from "drizzle-orm";

import { BookingWidget } from "../../components/booking-widget";
import { Card, PageHeader } from "../../components/ui";
import { getDb } from "../../../server/db";
import { normalizeSlug } from "../../../server/profile-validation";
import { getAvailabilityRules } from "../../../server/slots";
import { getQuestions } from "../../../server/scheduling";
import { eventType, user } from "../../../server/schema";

export const dynamic = "force-dynamic";

export default async function PublicEventPage({ params }: { params: Promise<{ username: string; eventSlug: string }> }) {
  const { username, eventSlug } = await params;
  const normalizedUsername = normalizeSlug(username);
  const normalizedEventSlug = normalizeSlug(eventSlug);
  const publicUsername = normalizedUsername ?? username;
  const publicEventSlug = normalizedEventSlug ?? eventSlug;
  const event = normalizedUsername === null || normalizedEventSlug === null
    ? undefined
    : await getDb()
        .select({
          id: eventType.id,
          name: eventType.name,
          description: eventType.description,
          durationMinutes: eventType.durationMinutes,
          location: eventType.location,
          active: eventType.active,
          hostId: user.id,
          hostName: user.name,
        })
        .from(eventType)
        .innerJoin(user, eq(eventType.userId, user.id))
        .where(and(eq(user.username, publicUsername), eq(eventType.slug, publicEventSlug)))
        .limit(1)
        .then(([record]) => record);

  if (!event || !event.active) {
    return (
      <main className="app-shell">
        <div className="dashboard-content scheduling-content public-booking-content">
          <PageHeader
            eyebrow="Booking"
            title="This booking page isn’t available"
            description="The link may be wrong, or this host isn’t taking bookings right now."
          />
          <Card className="scheduling-card">
            <p>Check the link, or contact the host for a new one.</p>
          </Card>
        </div>
      </main>
    );
  }

  const questions = await getQuestions(event.hostId);
  const rules = await getAvailabilityRules(event.hostId);

  return (
    <main className="app-shell">
      <div className="dashboard-content scheduling-content public-booking-content">
        <PageHeader eyebrow="Booking" title={event.name} description={`With ${event.hostName}`} />
        <div className="booking-page-grid">
          <Card className="scheduling-card booking-details">
            <p><span className="field-label">Host</span> {event.hostName}</p>
            <p><span className="field-label">Duration</span> {event.durationMinutes} minutes</p>
            {event.description && <p><span className="field-label">About</span> {event.description}</p>}
            {event.location && <p><span className="field-label">Location</span> {event.location}</p>}
          </Card>
          <Card className="scheduling-card">
            <BookingWidget
              username={publicUsername}
              eventSlug={publicEventSlug}
              durationMinutes={event.durationMinutes}
              questions={questions}
              timezones={Intl.supportedValuesOf("timeZone")}
              horizonDays={rules.bookingHorizonDays}
            />
          </Card>
        </div>
      </div>
    </main>
  );
}
