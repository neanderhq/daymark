"use client";

import { useState, type FormEvent } from "react";
import { Button, ErrorField, Input } from "../ui";

export function ProfilePhotoForm({ image }: { image: string | null }) {
  const [url, setUrl] = useState(image);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setPending(true);
    const file = new FormData(event.currentTarget).get("photo");
    try {
      if (!(file instanceof File) || !file.size) { setError("Choose a photo."); return; }
      const response = await fetch("/api/profile/photo", { method: "POST", body: file });
      const result = await response.json();
      if (!response.ok) { setError(result.error); return; }
      setUrl(result.url);
    } catch { setError("Your photo could not be saved. Try again."); }
    finally { setPending(false); }
  }
  return <section className="integration-settings">
    <h2>Profile photo</h2>
    {url && <img src={url} alt="Your profile photo" width={96} height={96} />}
    <form className="form-stack" onSubmit={upload}>
      <Input label="Choose a profile photo" name="photo" type="file" accept="image/png,image/jpeg,image/webp" required hint="PNG, JPEG or WebP, up to 2 MB. Your photo is private to your account." />
      {error && <ErrorField>{error}</ErrorField>}
      <Button type="submit" disabled={pending}>{pending ? "Saving photo…" : "Save photo"}</Button>
      {url && <p role="status">Your profile photo is saved.</p>}
    </form>
  </section>;
}
