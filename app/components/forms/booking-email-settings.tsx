"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button, ErrorField } from "../ui";

export function BookingEmailSettings({ configured, pending }: { configured: boolean; pending: number }) {
  const router = useRouter();
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  async function retry() {
    setSending(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/settings/booking-emails", { method: "POST" });
      if (!response.ok) throw new Error();
      const { attempted } = await response.json() as { attempted: number };
      setNotice(attempted ? "Retry finished. Check the pending count for unsent messages." : "No messages are ready to retry yet.");
      router.refresh();
    } catch {
      setError("Email retry couldn’t complete. Try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="integration-settings">
      <h2>Booking email</h2>
      <p>{configured ? "Email is configured for new bookings and changes." : "Email is not configured for this workspace. Booking receipts are still available."}</p>
      {configured && pending > 0 && (
        <><p>{pending} pending {pending === 1 ? "message" : "messages"}</p>
        <Button type="button" variant="secondary" onClick={retry} disabled={sending}>{sending ? "Retrying…" : "Retry pending emails"}</Button></>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && <ErrorField>{error}</ErrorField>}
    </section>
  );
}
