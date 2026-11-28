import { createHash } from "node:crypto";
import { Storage } from "@google-cloud/storage";

export const maximumPhotoBytes = 2 * 1024 * 1024;
export function photoContentType(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.length > 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return "image/webp";
  return null;
}

export function profilePhoto(userId: string) {
  if (!process.env.NEANDER_STORAGE_BUCKET) throw new Error("Profile storage is still being provisioned.");
  const key = "profile-photos/" + createHash("sha256").update(userId).digest("hex");
  return new Storage({ projectId: process.env.GOOGLE_CLOUD_PROJECT }).bucket(process.env.NEANDER_STORAGE_BUCKET).file(key);
}
