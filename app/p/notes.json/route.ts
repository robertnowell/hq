import { getDocument } from "@/lib/blobs";
import { publicIndex, siteOwnerUserId } from "@/lib/publishing";
import { noteRecord, type NoteRecord } from "@/lib/note-record";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Every published page, as records.
 *
 * The personal site renders notes rather than linking to them: each one is
 * drawn inside the site's own chrome, with its topic index, its tags and its
 * canonical, from a record carrying the page's stylesheet and body. This is
 * the feed that site reads. It replaces the laptop publisher that used to
 * write the same records onto disk, which meant nothing could be published
 * unless that one Mac was awake.
 *
 * Everything here is already public: these are the bytes of pages a person
 * pressed Publish on. Nothing unpublished is reachable, because the index it
 * reads can only see published rows.
 */
export async function GET() {
  // The connected account's pages and nobody else's. Sharing is for
  // everybody; appearing on somebody's personal website is not.
  const owner = siteOwnerUserId();
  if (!owner) return Response.json([]);
  const rows = await publicIndex({ ownedBy: owner });
  const records: NoteRecord[] = [];
  for (const r of rows) {
    if (!r.storage_key || !r.public_slug) continue;
    const html = await getDocument(r.storage_key);
    // A row whose bytes are missing is skipped rather than published empty:
    // a note with no body on somebody's site reads as a broken site.
    if (html === null) continue;
    records.push(noteRecord(html, {
      slug: r.public_slug, title: r.title,
      published_at: r.published_at, produced_at: r.produced_at,
    }));
  }
  return Response.json(records, {
    headers: {
      // Same rule as the pages themselves: withdrawn means withdrawn, and the
      // site revalidates this on its own schedule anyway.
      "cache-control": "public, max-age=0, must-revalidate",
      "access-control-allow-origin": "*",
    },
  });
}
