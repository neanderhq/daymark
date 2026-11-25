import Link from "next/link";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { asc, desc, eq } from "drizzle-orm";

import { EventTypeForm } from "../../components/forms/event-type-form";
import { EventBookingLinkButton } from "../../components/forms/event-booking-link-button";
import { SignOutButton } from "../../components/sign-out-button";
import { Card, PageHeader } from "../../components/ui";
import { getAuth } from "../../../server/auth";
import { getDb } from "../../../server/db";
import { ensureSchedulingDefaults, getQuestions } from "../../../server/scheduling";
import { eventType, user } from "../../../server/schema";

export const dynamic = "force-dynamic";

export default async function EventTypePage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) redirect("/login");

  await ensureSchedulingDefaults(session.user.id);
  const { page } = await searchParams;
  const events = await getDb().select().from(eventType).where(eq(eventType.userId, session.user.id))
    .orderBy(desc(eventType.isDefault), asc(eventType.createdAt), asc(eventType.id));
  const event = page === "new" ? { id: "", name: "", description: null, durationMinutes: 30, location: null, slug: "", active: true, isDefault: false }
    : events.find((item) => page ? item.id === page : item.isDefault);
  if (!event) notFound();
  const mode = page === "new" ? "new" : event.isDefault ? "default" : "secondary";
  const questions = event.isDefault ? await getQuestions(session.user.id) : [];
  const [profile] = await getDb()
    .select({ username: user.username })
    .from(user)
    .where(eq(user.id, session.user.id))
    .limit(1);

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
        <PageHeader eyebrow="Host settings" title="Event type" description="Manage the reusable links invitees use to book with you." />
        <Card className="scheduling-card">
          <div className="section-heading">
            <h2>Booking pages</h2>
            <p>All pages share your <Link className="text-link" href="/dashboard/availability">availability</Link> and default page’s intake questions.</p>
          </div>
          <nav className="booking-page-list" aria-label="Booking pages">
            {events.map((item) => (
              <Link key={item.id} className="booking-page-option" aria-current={event.id === item.id ? "page" : undefined}
                href={item.isDefault ? "/dashboard/event-type" : `/dashboard/event-type?page=${item.id}`}>
                <strong>{item.name}</strong>
                <span>{item.isDefault ? "Default · " : ""}{item.durationMinutes} min · {item.active ? "Active" : "Paused"}</span>
              </Link>
            ))}
          </nav>
          {profile?.username && mode !== "new"
            ? <Link className="button button-secondary" href="/dashboard/event-type?page=new">New booking page</Link>
            : !profile?.username && <p className="field-hint">Save a public username on your default page to add more links.</p>}
        </Card>
        <Card className="scheduling-card">
          <h2>{mode === "new" ? "New booking page" : "Edit booking page"}</h2>
          <EventTypeForm key={event.id || "new"} event={event} username={profile?.username ?? null} questions={questions} mode={mode} />
        </Card>
        {event.isDefault && <EventBookingLinkButton />}
      </div>
    </main>
  );
}
