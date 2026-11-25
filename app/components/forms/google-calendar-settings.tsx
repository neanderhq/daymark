"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button, ErrorField } from "../ui";

export function GoogleCalendarSettings({ configured, connected, reconnect, result }: {
  configured: boolean; connected: boolean; reconnect: boolean; result?: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const status = !configured ? "Google Calendar is not configured for this workspace."
    : reconnect ? "Reconnect Google Calendar before new bookings can be confirmed."
      : connected ? "Primary calendar connected for busy-time checks." : "Using manual availability.";
  const messages: Record<string, string> = {
    denied: "Google access was declined. Your previous settings are still in use.",
    invalid: "This connection request expired or is no longer valid. Start again.",
    unavailable: "Google Calendar couldn’t be connected. Try again.",
  };

  async function disconnect() {
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/settings/google-calendar", { method: "DELETE" });
      if (!response.ok) throw new Error();
      router.replace("/settings#google-calendar");
      router.refresh();
    } catch {
      setError("Disconnection didn’t complete. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="integration-settings" id="google-calendar">
      <h2>Google Calendar</h2>
      <p>{status}</p>
      <p className="field-hint">When connected, Daymark checks busy times on your primary calendar using read-only access.</p>
      {result && Object.hasOwn(messages, result) && <p role="status">{messages[result]}</p>}
      {error && <ErrorField>{error}</ErrorField>}
      {configured && <form action="/api/settings/google-calendar" method="post">
        <Button type="submit" variant="secondary">{connected ? "Reconnect Google Calendar" : "Connect Google Calendar"}</Button>
      </form>}
      {connected && <Button type="button" variant="secondary" disabled={pending} onClick={disconnect}>
        {pending ? "Disconnecting…" : "Disconnect and use manual availability"}
      </Button>}
    </section>
  );
}
