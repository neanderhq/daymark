import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { ContactsManager } from "../../components/forms/contacts-manager";
import { SignOutButton } from "../../components/sign-out-button";
import { PageHeader } from "../../components/ui";
import { getAuth } from "../../../server/auth";
import { getDb } from "../../../server/db";
import { listContacts } from "../../../server/contacts";
import { user } from "../../../server/schema";

export const dynamic = "force-dynamic";

export default async function ContactsPage() {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) redirect("/login");

  const [profile] = await getDb()
    .select({ timezone: user.timezone })
    .from(user)
    .where(eq(user.id, session.user.id))
    .limit(1);
  const hostTimezone = profile?.timezone ?? session.user.timezone;
  const contacts = await listContacts(session.user.id);

  return (
    <main className="app-shell">
      <header className="app-header">
        <Link className="brand" href="/" aria-label="Daymark home"><span className="brand-mark" aria-hidden="true">d</span><span>daymark</span></Link>
        <Link className="text-link" href="/dashboard">← Back to your workspace</Link>
        <nav className="account-nav" aria-label="Account navigation">
          <span className="account-greeting">{session.user.name}</span>
          <Link className="text-link" href="/settings">Settings</Link>
          <SignOutButton />
        </nav>
      </header>
      <div className="dashboard-content scheduling-content contacts-content">
        <PageHeader eyebrow="Your workspace" title="Contacts" description="Keep contact details and booking history together." />
        <ContactsManager
          timezone={hostTimezone}
          initialContacts={contacts.map((contact) => ({
            id: contact.id,
            name: contact.name,
            email: contact.email,
            timezone: contact.timezone,
            bookingCount: contact.bookingCount,
            lastBookingAt: contact.lastBookingAt?.toISOString() ?? null,
          }))}
        />
      </div>
    </main>
  );
}
