import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { and, asc, count, eq, gte } from "drizzle-orm";

import { SignOutButton } from "../components/sign-out-button";
import { Card, EmptyState, PageHeader } from "../components/ui";
import { getAuth } from "../../server/auth";
import { getDb } from "../../server/db";
import { ensureSchedulingDefaults } from "../../server/scheduling";
import { availabilityRange, booking, bookingLink, contact, eventType, poll, user } from "../../server/schema";
import { formatInstant } from "../../server/timezone";

export const dynamic = "force-dynamic";

const sections = [
  { title: "Event type", description: "Set your meeting details, public link, and questions.", href: "/dashboard/event-type" },
  { title: "Availability", description: "Set the weekly hours people can book.", href: "/dashboard/availability" },
  { title: "Bookings", description: "Upcoming meetings with your invitees.", href: "/dashboard/bookings" },
  { title: "Contacts", description: "People you meet will have a home here.", href: "/dashboard/contacts" },
  { title: "Polls", description: "A simple way to find a time together, when you need it.", href: "/dashboard/polls" },
  { title: "Links", description: "Create and manage your shareable booking links.", href: "/dashboard/links" },
];

const shortWeekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatMinute(minute: number) {
  const hours = Math.floor(minute / 60);
  const minutes = minute % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export default async function DashboardPage() {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) redirect("/login");

  await ensureSchedulingDefaults(session.user.id);
  const now = new Date();
  const [event] = await getDb()
    .select({ name: eventType.name, durationMinutes: eventType.durationMinutes, active: eventType.active })
    .from(eventType)
    .where(eq(eventType.userId, session.user.id))
    .limit(1);
  const ranges = await getDb()
    .select({ weekday: availabilityRange.weekday, startMinute: availabilityRange.startMinute, endMinute: availabilityRange.endMinute })
    .from(availabilityRange)
    .where(eq(availabilityRange.userId, session.user.id))
    .orderBy(asc(availabilityRange.weekday), asc(availabilityRange.startMinute));
  const [profile] = await getDb()
    .select({ timezone: user.timezone })
    .from(user)
    .where(eq(user.id, session.user.id))
    .limit(1);
  const [bookingCount] = await getDb()
    .select({ upcoming: count(booking.id) })
    .from(booking)
    .where(
      and(
        eq(booking.hostId, session.user.id),
        eq(booking.status, "active"),
        gte(booking.endUtc, now),
      ),
    );
  const [contactCount] = await getDb().select({ count: count(contact.id) }).from(contact).where(eq(contact.hostId, session.user.id));
  const [linkCount] = await getDb().select({ count: count(bookingLink.id) }).from(bookingLink).where(and(eq(bookingLink.hostId, session.user.id), eq(bookingLink.status, "active")));
  const [pollCount] = await getDb()
    .select({ count: count(poll.id) })
    .from(poll)
    .where(eq(poll.hostId, session.user.id));
  const [nextBooking] = await getDb()
    .select({ inviteeName: booking.inviteeName, startUtc: booking.startUtc })
    .from(booking)
    .where(
      and(
        eq(booking.hostId, session.user.id),
        eq(booking.status, "active"),
        gte(booking.endUtc, now),
      ),
    )
    .orderBy(asc(booking.startUtc))
    .limit(1);
  const hostTimezone = profile?.timezone ?? session.user.timezone;

  return (
    <main className="app-shell">
      <header className="app-header">
        <Link className="brand" href="/" aria-label="Daymark home"><span className="brand-mark" aria-hidden="true">d</span><span>daymark</span></Link>
        <nav className="account-nav" aria-label="Account navigation">
          <span className="account-greeting">{session.user.name}</span>
          <Link className="text-link" href="/settings">Settings</Link>
          <SignOutButton />
        </nav>
      </header>
      <div className="dashboard-content">
        <PageHeader eyebrow="Your workspace" title={`Hello, ${session.user.name.split(" ")[0]}.`} description="Everything you need for the conversations ahead, all in one place." />
        <div className="section-grid">
          {sections.map((section, index) => (
            <Card className="dashboard-card" key={section.title}>
              <div className="card-heading"><span className="section-number">0{index + 1}</span><h2>{section.title}</h2></div>
              {section.title === "Event type" ? (
                event ? (
                  <div className="dashboard-summary">
                    <h3>{event.name}</h3>
                    <p>{event.durationMinutes} minutes</p>
                    <p>{event.active ? "Active" : "Inactive"}</p>
                  </div>
                ) : (
                  <EmptyState title="Nothing here yet" description={section.description} />
                )
              ) : section.title === "Availability" ? (
                ranges.length > 0 ? (
                  <div className="dashboard-summary">
                    <h3>{new Set(ranges.map((range) => range.weekday)).size} days with hours</h3>
                    <p>{ranges.map((range) => `${shortWeekdays[range.weekday]} ${formatMinute(range.startMinute)}–${formatMinute(range.endMinute)}`).join(", ")} ({hostTimezone})</p>
                  </div>
                ) : (
                  <EmptyState title="Nothing here yet" description={section.description} />
                )
              ) : section.title === "Bookings" ? (
                nextBooking ? (
                  <div className="dashboard-summary"><h3>{bookingCount.upcoming} upcoming</h3><p>Next: {nextBooking.inviteeName}, {formatInstant(nextBooking.startUtc, hostTimezone)}</p></div>
                ) : (
                  <EmptyState title="No bookings yet" description="When invitees book a time, it will show up here." />
                )
              ) : section.title === "Contacts" ? (
                contactCount.count > 0 ? <div className="dashboard-summary"><h3>{contactCount.count} {contactCount.count === 1 ? "contact" : "contacts"}</h3><p>People and their meeting history, in one place.</p></div> : <EmptyState title="No contacts yet" description={section.description} />
              ) : section.title === "Links" ? (
                linkCount.count > 0 ? <div className="dashboard-summary"><h3>{linkCount.count} active {linkCount.count === 1 ? "link" : "links"}</h3><p>Ready to share with your invitees.</p></div> : <EmptyState title="No links yet" description={section.description} />
              ) : section.title === "Polls" ? (
                pollCount.count > 0 ? (
                  <div className="dashboard-summary"><h3>{pollCount.count} {pollCount.count === 1 ? "poll" : "polls"}</h3><p>Review proposed times and invitee votes.</p></div>
                ) : (
                  <EmptyState title="Nothing here yet" description={section.description} />
                )
              ) : (
                <EmptyState title="Nothing here yet" description={section.description} />
              )}
              {section.href && <Link className="card-link text-link" href={section.href}>Open</Link>}
            </Card>
          ))}
        </div>
      </div>
    </main>
  );
}
