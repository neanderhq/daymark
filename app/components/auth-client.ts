"use client";

import { getApps, initializeApp } from "firebase/app";
import { createUserWithEmailAndPassword, getAuth, inMemoryPersistence, setPersistence, signInWithEmailAndPassword, signOut } from "firebase/auth";

type Credentials = { email: string; password: string; name?: string; timezone?: string };

async function authenticate(input: Credentials, create: boolean) {
  try {
    const response = await fetch("/api/auth/managed", { cache: "no-store" });
    if (!response.ok) return { error: { message: "Sign-in is still being prepared. Try again shortly." } };
    const config = await response.json();
    const app = getApps().find(app => app.name === "daymark") ?? initializeApp(config, "daymark");
    const auth = getAuth(app); auth.tenantId = config.tenantId;
    await setPersistence(auth, inMemoryPersistence);
    if (config.emulatorUrl) {
      const { connectAuthEmulator } = await import("firebase/auth");
      if (!auth.emulatorConfig) connectAuthEmulator(auth, config.emulatorUrl, { disableWarnings: true });
    }
    const signed = await (create ? createUserWithEmailAndPassword : signInWithEmailAndPassword)(auth, input.email, input.password);
    try {
      const result = await fetch("/api/auth/managed", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken: await signed.user.getIdToken(), name: input.name,
          timezone: input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC" }),
      });
      return result.ok ? { error: null } : { error: { message: (await result.json()).error } };
    } finally { await signOut(auth); }
  } catch (error) {
    const code = (error as { code?: string }).code;
    return { error: { message: code === "auth/email-already-in-use" ? "An account already exists for that email address." : "Sign-in could not complete. Check your details and try again." } };
  }
}

export const authClient = {
  signUp: { email: (input: Credentials) => authenticate(input, true) },
  signIn: { email: (input: Credentials) => authenticate(input, false) },
  signOut: async () => {
    const response = await fetch("/api/auth/managed", { method: "DELETE" });
    if (!response.ok) throw new Error("Sign-out could not complete. Try again.");
  },
};
