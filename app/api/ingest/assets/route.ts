import { takeQuota } from "@/lib/quota";
import { createHash } from "crypto";
import { identify } from "@/lib/auth";
import { mediaKey, putMedia } from "@/lib/blobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One image, to the media bucket, back as an address.
 *
 * The sender (the panel) finds an image inline in a page or beside it, posts
 * the bytes here, and rewrites the page on disk to the address returned, the
 * same rewrite the archive's extractor always did. Content-addressed: the
 * key is the first sixteen hex of the sha256 plus the extension, exactly the
 * extractor's rule, so an image already uploaded from Robert's Mac is the
 * same object and the same address.
 *
 * One image per call, under 3.5 MB, so a request never meets the platform's
 * body limit halfway through a page.
 */
const TYPES: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif",
  "image/webp": "webp", "image/avif": "avif",
};
const MAX = 3_500_000;

export async function POST(req: Request) {
  const me = await identify(req);
  if (!me) return Response.json({ error: "unauthenticated" }, { status: 401 });
  // The media bucket is public. Only a paired machine holding a bound key
  // writes to it, not any signed-in account (safety review, 29 Sep).
  if (!me.deviceKeyJkt) return Response.json({ error: "images come from a paired machine" }, { status: 403 });
  const body = await req.json().catch(() => null);
  const type = typeof body?.content_type === "string" ? body.content_type.toLowerCase() : "";
  const ext = TYPES[type];
  if (!ext) return Response.json({ error: "not an image type this bucket takes" }, { status: 415 });
  if (typeof body?.data_base64 !== "string" || body.data_base64.length > MAX * 1.37) {
    return Response.json({ error: `one image per call, under ${MAX} bytes` }, { status: 413 });
  }
  const bytes = Buffer.from(body.data_base64, "base64");
  if (bytes.length === 0 || bytes.length > MAX) {
    return Response.json({ error: `one image per call, under ${MAX} bytes` }, { status: 413 });
  }
  if (!looksLike(type, bytes)) {
    return Response.json({ error: "the bytes are not the image type they claim" }, { status: 415 });
  }
  const over = await takeQuota(me.userId, "asset", 1, bytes.length);
  if (over) return over;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  // The sender may say what it hashed; if it disagrees, the bytes are not
  // what it meant to send, and nothing should be written under that name.
  if (typeof body.sha256 === "string" && body.sha256.toLowerCase() !== sha256) {
    return Response.json({ error: "sha256 does not match the bytes" }, { status: 400 });
  }
  const url = await putMedia(mediaKey(sha256, ext), bytes, type);
  return Response.json({ url, sha256, bytes: bytes.length });
}

/** The file's own signature, checked against the type it claims. */
function looksLike(type: string, b: Buffer): boolean {
  const at = (i: number, ...xs: number[]) => xs.every((x, k) => b[i + k] === x);
  switch (type) {
    case "image/png":  return at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case "image/jpeg": return at(0, 0xff, 0xd8, 0xff);
    case "image/gif":  return at(0, 0x47, 0x49, 0x46, 0x38);
    case "image/webp": return at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50);
    case "image/avif": return at(4, 0x66, 0x74, 0x79, 0x70);
    default: return false;
  }
}
