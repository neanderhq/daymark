import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { BookingEmailSettings } from "../components/forms/booking-email-settings";
import { ProfileForm } from "../components/forms/profile-form";
import { Card, PageHeader } from "../components/ui";
import { getAuth } from "../../server/auth";
import { bookingEmailConfigured, pendingBookingEmails } from "../../server/booking-email";
import { getDb } from "../../server/db";
import { user } from "../../server/schema";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) redirect("/login");
  const [profile] = await getDb()
    .select({ name: user.name, email: user.email, timezone: user.timezone })
    .from(user)
    .where(eq(user.id, session.user.id))
    .limit(1);
  if (!profile) redirect("/login");
  const emailConfigured = bookingEmailConfigured();
  const pending = emailConfigured ? (await pendingBookingEmails(session.user.id)).length : 0;

  return (
    <main className="app-shell">
      <header className="app-header">
        <Link className="brand" href="/dashboard" aria-label="Daymark dashboard"><span className="brand-mark" aria-hidden="true">d</span><span>daymark</span></Link>
        <Link className="text-link" href="/dashboard">← Back to your workspace</Link>
      </header>
      <div className="settings-content">
        <PageHeader eyebrow="Your account" title="Profile settings" description="Keep your name, email, and time zone up to date." />
        <Card className="settings-card"><ProfileForm profile={profile} /></Card>
        <Card className="settings-card"><BookingEmailSettings configured={emailConfigured} pending={pending} /></Card>
      </div>
    </main>
  );
}
