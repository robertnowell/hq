import { Storage } from "@google-cloud/storage";
import { createHash } from "crypto";
import { parseShipping, type ShippingSnapshot } from "./shipping";

/**
 * The document bytes.
 *
 * A separate bucket from the image bucket, with the opposite access rule:
 * images are public by ruling, documents are private and the bucket has
 * public-access-prevention enforced. The browser never receives a bucket
 * URL -- every read goes through the route handler that checks authorization
 * next to the fetch. Signed URLs were rejected earlier for a specific
 * reason: AWS and GCS both document that an issued signed URL cannot be
 * revoked before it expires, so a leaked link stays live regardless of what
 * the database says about who owns the document.
 */
const g = globalThis as unknown as { hqStorage?: Storage };

function client(): Storage {
  if (g.hqStorage) return g.hqStorage;
  const b64 = process.env.HQ_GCS_SA_KEY_B64;
  if (!b64) throw new Error("HQ_GCS_SA_KEY_B64 is not set");
  // Base64 because a multi-line JSON credential does not survive every
  // secret store intact -- one already arrived with a 44-character private
  // key where 1704 belong, which fails later and confusingly.
  const creds = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  g.hqStorage = new Storage({
    projectId: creds.project_id,
    credentials: { client_email: creds.client_email, private_key: creds.private_key },
  });
  return g.hqStorage;
}

const BUCKET = process.env.HQ_GCS_BUCKET ?? "";

/** Content-addressed, and namespaced by user so a key cannot be guessed across tenants. */
export function documentKey(userId: string, contentHash: string) {
  return `u/${userId}/${contentHash}.html`;
}

export async function putDocument(key: string, html: string) {
  await client().bucket(BUCKET).file(key).save(html, {
    contentType: "text/html; charset=utf-8",
    resumable: false,
  });
}

export async function getDocument(key: string): Promise<string | null> {
  try {
    const [buf] = await client().bucket(BUCKET).file(key).download();
    return buf.toString("utf8");
  } catch (e) {
    // A missing blob is a real failure, not an empty document. Returning ""
    // would render a blank page that looks like a document with no content.
    if ((e as { code?: number }).code === 404) return null;
    throw e;
  }
}

/** Mutable, private device observations; no public or signed bucket URLs. */
export async function putShipping(userId: string, deviceId: string, snapshot: ShippingSnapshot) {
  const hash = createHash("sha256").update(snapshot.repo).digest("hex");
  const file = client().bucket(BUCKET).file(`u/${userId}/shipping/${deviceId}/${hash}.json`);
  let generation = 0;
  try {
    const [metadata] = await file.getMetadata();
    generation = Number(metadata.generation);
    const [old] = await file.download();
    if (Date.parse(JSON.parse(old.toString()).checkedAt) > Date.parse(snapshot.checkedAt)) return false;
  } catch (e) { if ((e as { code?: number }).code !== 404) throw e; }
  try {
    await file.save(JSON.stringify(snapshot), { contentType: "application/json", resumable: false,
      metadata: { cacheControl: "private, no-store" }, preconditionOpts: { ifGenerationMatch: generation } });
    return true;
  } catch (e) { if ((e as { code?: number }).code === 412) return false; throw e; }
}

export async function getShipping(userId: string, deviceIds: string[]): Promise<ShippingSnapshot[]> {
  const groups = await Promise.all(deviceIds.map(async id => {
    const [files, next] = await client().bucket(BUCKET).getFiles({
      prefix: `u/${userId}/shipping/${id}/`, maxResults: 100, autoPaginate: false });
    if (next) throw new Error("shipping observation limit exceeded");
    return files;
  }));
  const records = groups.flat();
  return Promise.all(records.map(async f => parseShipping(JSON.parse((await f.download())[0].toString()))));
}

/**
 * The media bucket: public by ruling, content-addressed, the opposite access
 * rule from documents. A page's image lives here so the page can point at it
 * by one absolute address that works on disk, in the app, and on a published
 * copy alike. Until 12 Sep only a script on Robert's Mac could write it; now
 * the app writes it for every user, so no laptop needs a Google account.
 */
const MEDIA_BUCKET = process.env.HQ_MEDIA_BUCKET ?? BUCKET;
const MEDIA_PREFIX = process.env.HQ_MEDIA_PREFIX ?? "media";
export const MEDIA_BASE = process.env.HQ_MEDIA_BASE ?? `https://storage.googleapis.com/${MEDIA_BUCKET}`;

export function mediaKey(sha256: string, ext: string) {
  return `${MEDIA_PREFIX}/${sha256.slice(0, 16)}.${ext}`;
}

/** Write once; the same bytes are the same object, so a repeat is a no-op. */
export async function putMedia(key: string, bytes: Buffer, contentType: string): Promise<string> {
  const file = client().bucket(MEDIA_BUCKET).file(key);
  const [exists] = await file.exists();
  if (!exists) {
    await file.save(bytes, { contentType, resumable: false,
      metadata: { cacheControl: "public, max-age=31536000, immutable" } });
  }
  return `${MEDIA_BASE}/${key}`;
}
