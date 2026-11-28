"use client";

import { useState, type FormEvent } from "react";
import { Button, ErrorField, Input } from "../ui";

export function ProfileForm({ profile }: { profile: { name: string; email: string; timezone: string } }) {
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    setSaved(false);
    const values = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: values.get("name"),
          email: values.get("email"),
          timezone: values.get("timezone"),
        }),
      });
      const result = await response.json();
      if (!response.ok) {
        setError(result.error || "Your changes couldn’t be saved. Please try again.");
        return;
      }
      setSaved(true);
    } catch {
      setError("Your changes couldn’t be saved. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="form-stack profile-form" onSubmit={submit}>
      <Input name="name" label="Your name" autoComplete="name" maxLength={80} defaultValue={profile.name} required />
      <Input name="email" label="Email address" type="email" autoComplete="email" maxLength={254} defaultValue={profile.email} readOnly hint="This is your managed sign-in address." required />
      <Input name="timezone" label="Time zone" autoComplete="off" defaultValue={profile.timezone} required hint="Use an IANA name, such as America/La_Paz." />
      {error && <ErrorField>{error}</ErrorField>}
      {saved && <p className="success-message" role="status">Your profile is up to date.</p>}
      <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save changes"}</Button>
    </form>
  );
}
