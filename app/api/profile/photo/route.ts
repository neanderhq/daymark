import { eq } from "drizzle-orm";
import { getAuth } from "../../../../server/auth";
import { getDb } from "../../../../server/db";
import { user } from "../../../../server/schema";
import { maximumPhotoBytes, photoContentType, profilePhoto } from "../../../../server/profile-photo";

export async function GET(request: Request) {
  const session = await getAuth().api.getSession({ headers: request.headers });
  if (!session) return Response.json({ error: "Sign in required." }, { status: 401 });
  try {
    const file = profilePhoto(session.user.id);
    const [bytes] = await file.download();
    const type = photoContentType(bytes);
    if (!type) return new Response(null, { status: 404 });
    return new Response(new Uint8Array(bytes), { headers: { "Content-Type": type, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  } catch (error) {
    return Response.json({ error: "Photo unavailable." }, { status: Number((error as { code?: number }).code) === 404 ? 404 : 503 });
  }
}

export async function POST(request: Request) {
  const session = await getAuth().api.getSession({ headers: request.headers });
  if (!session) return Response.json({ error: "Sign in required." }, { status: 401 });
  const reader = request.body?.getReader();
  if (!reader) return Response.json({ error: "Choose a photo." }, { status: 400 });
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > maximumPhotoBytes) { await reader.cancel(); return Response.json({ error: "Choose a photo smaller than 2 MB." }, { status: 413 }); }
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks);
  const type = photoContentType(bytes);
  if (!type) return Response.json({ error: "Choose a PNG, JPEG or WebP photo." }, { status: 400 });
  try {
    await profilePhoto(session.user.id).save(bytes, { resumable: false, contentType: type, metadata: { cacheControl: "private, no-store" } });
    const url = "/api/profile/photo?v=" + Date.now();
    await getDb().update(user).set({ image: url }).where(eq(user.id, session.user.id));
    return Response.json({ url, size }, { status: 201 });
  } catch { return Response.json({ error: "Photo storage is unavailable. Try again shortly." }, { status: 503 }); }
}
