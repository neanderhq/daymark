import { and, eq } from "drizzle-orm";

import { getAuth } from "../../../server/auth";
import { getDb } from "../../../server/db";
import { invalidSlugMessage, isReservedUsername, normalizeSlug, reservedUsernameMessage } from "../../../server/profile-validation";
import { ensureSchedulingDefaults, hasOnlyKeys, invalidEventDetailsMessage, isUniqueViolation, readJsonBody, validateEventInput } from "../../../server/scheduling";
import { eventType, user } from "../../../server/schema";

const fields = ["name", "description", "durationMinutes", "location", "slug", "active"];

async function save(request: Request, create: boolean) {
  const session = await getAuth().api.getSession({ headers: request.headers });
  if (!session) return Response.json({ error: "Sign in to manage your booking pages." }, { status: 401 });

  const body = await readJsonBody(request);
  if (!body || !hasOnlyKeys(body, create ? fields : [...fields, "username", "id"])) {
    return Response.json({ error: invalidEventDetailsMessage }, { status: 400 });
  }
  const validated = validateEventInput(body);
  if (!validated.ok) {
    return Response.json({ error: validated.error, field: validated.error === invalidSlugMessage ? "slug" : undefined }, { status: 400 });
  }

  const id = body.id;
  if (id !== undefined && (typeof id !== "string" || id.length === 0 || id.length > 128)) {
    return Response.json({ error: "Booking page not found." }, { status: 404 });
  }
  let username: string | undefined;
  if (body.username !== null && body.username !== undefined) {
    const normalized = normalizeSlug(body.username);
    if (normalized === null || isReservedUsername(normalized)) {
      return Response.json({ error: normalized === null ? invalidSlugMessage : reservedUsernameMessage }, { status: 400 });
    }
    username = normalized;
  }

  const hostId = session.user.id;
  await ensureSchedulingDefaults(hostId);
  try {
    return await getDb().transaction(async (transaction) => {
      const [owner] = await transaction.select({ username: user.username }).from(user)
        .where(eq(user.id, hostId)).for("no key update");
      if (!owner) return Response.json({ error: "Sign in to manage your booking pages." }, { status: 401 });
      if (create) {
        if (!owner.username) return Response.json({ error: "Set your public username on the default page first." }, { status: 409 });
        const [page] = await transaction.insert(eventType).values({
          ...validated.value, id: crypto.randomUUID(), userId: hostId,
        }).returning();
        return Response.json(page, { status: 201 });
      }

      const condition = and(eq(eventType.userId, hostId), id ? eq(eventType.id, id) : eq(eventType.isDefault, true));
      const [existing] = await transaction.select().from(eventType).where(condition);
      if (!existing) return Response.json({ error: "Booking page not found." }, { status: 404 });
      if (!existing.isDefault && validated.value.slug !== existing.slug) {
        return Response.json({ error: "The published URL ending stays fixed.", field: "slug" }, { status: 400 });
      }
      if (!existing.isDefault && username !== undefined) {
        return Response.json({ error: "Edit the public username on the default page." }, { status: 400 });
      }
      if (username !== undefined && username !== owner.username) {
        await transaction.update(user).set({ username, updatedAt: new Date() }).where(eq(user.id, hostId));
      }
      const [page] = await transaction.update(eventType).set(validated.value).where(condition).returning();
      return Response.json({ ...page, username: username ?? owner.username });
    });
  } catch (error) {
    if (isUniqueViolation(error, "event_type_userId_slug_unique")) {
      return Response.json({ error: "Choose a unique event URL.", field: "slug" }, { status: 409 });
    }
    if (isUniqueViolation(error, "user_username_unique")) {
      return Response.json({ error: "That username is already taken." }, { status: 409 });
    }
    throw error;
  }
}

export const POST = (request: Request) => save(request, true);
export const PATCH = (request: Request) => save(request, false);
export const PUT = PATCH;
