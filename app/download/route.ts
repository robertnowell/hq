export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The app, for somebody who does not have it yet.
 *
 * A new person needs exactly one link and there was not one: the connect page
 * said "Tranquility Base is not installed on this Mac yet" and left them to
 * find it. The build is a public release asset whose name carries its version
 * number, so there is no fixed address for the newest one. The update feed
 * does have a fixed address and always names the current build, which is the
 * same feed the installed app reads, so this reads it too and forwards.
 *
 * Two ways to fail, both handled by sending somebody somewhere real: if the
 * feed cannot be read or does not parse, this forwards to the releases page,
 * which lists every build with its notarisation and its checksum. A download
 * link that 500s is worse than one that needs a second click.
 */
const FEED = process.env.HQ_APPCAST ?? "https://updates.tranquilitybase.to/appcast.xml";
const RELEASES = process.env.HQ_RELEASES
  ?? "https://github.com/robertnowell/tranquility-base/releases/latest";

export async function GET() {
  const dmg = await newest().catch(() => null);
  return Response.redirect(dmg ?? RELEASES, 302);
}

async function newest(): Promise<string | null> {
  const r = await fetch(FEED, {
    signal: AbortSignal.timeout(6000),
    // The feed changes on every merge; a few minutes of edge cache is the
    // difference between one fetch and one per visitor, and nobody is hurt by
    // being a build behind for five minutes.
    next: { revalidate: 300 },
  });
  if (!r.ok) return null;
  const xml = await r.text();
  // Each item carries its build number and one enclosure. Take the highest
  // build rather than trusting the order the feed happens to be written in.
  let best: { url: string; build: number } | null = null;
  for (const item of xml.split("<item>").slice(1)) {
    const url = item.match(/<enclosure\b[^>]*\burl="([^"]+\.dmg)"/)?.[1];
    if (!url) continue;
    const build = Number(item.match(/<sparkle:version>(\d+)<\/sparkle:version>/)?.[1] ?? 0);
    if (!best || build > best.build) best = { url, build };
  }
  return best?.url ?? null;
}
