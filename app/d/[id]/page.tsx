import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { identify } from "@/lib/auth";
import { asUser } from "@/lib/db";
import { shareBase } from "@/lib/publishing";
import { documentForReader, documentPreview } from "@/lib/sharing";
import { SignIn } from "@clerk/nextjs";
import { Gate } from "../../gate";
import { GateWords } from "../../sign-in/gate-words";
import { gateCard } from "../../sign-in/gate-card";
import type { Metadata } from "next";
import { DocChrome } from "./chrome";
import { Follow } from "./follow";
import "./doc.css";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reading one document.
 *
 * The app's page holds the chrome and the document sits in a frame inside it.
 * It was the other way round until 13 Sep, with the app's bar injected into
 * the agent's own html, and the cost of that was invisible right up until the
 * share control needed a session: the document is served sandboxed with an
 * opaque origin, so nothing drawn into it can carry one, and the control had
 * to open a separate browser window to do its work.
 *
 * What the frame costs, honestly: find-in-page searches the frame you are
 * standing in, so a reader clicks the document once before pressing command
 * F, and the browser restores the outer page's scroll rather than the
 * document's. What it buys is that everything around the document is the app,
 * in one design language, able to act.
 */
/**
 * What the address says about itself to somebody with no session: the
 * unfurler in iMessage or Slack, or a person about to sign in. A shared
 * document's own title and summary, and its company's mark when it is
 * shared with a company (Robert, 28 Sep: "the og stuff per document with
 * the headline, and the favicon by brand"). A private document says what
 * the hub says. Never indexed either way.
 */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const none: Metadata = { robots: { index: false, follow: false } };
  if (!UUID.test(id)) return none;
  const h = await headers();
  const me = await identify(new Request("http://local", { headers: h })).catch(() => null);
  const p = await documentPreview(id, me?.userId ?? null).catch(() => null);
  if (!p) return none;
  const title = p.doc_title ?? undefined;
  const description = p.doc_summary ?? undefined;
  const brand = p.org_logo_url ? { icon: p.org_logo_url, apple: p.org_logo_url } : undefined;
  return {
    ...none,
    title, description,
    openGraph: { title, description, type: "article", siteName: p.org_name ?? "Tranquility Knowledge Base" },
    twitter: { card: "summary", title, description },
    ...(brand ? { icons: brand } : {}),
  };
}

export default async function DocumentPage(
  { params }: { params: Promise<{ id: string }> },
) {
  const h = await headers();
  const me = await identify(new Request("http://local", { headers: h }));
  const { id } = await params;
  if (!me) {
    // The door, on the document's own address. It used to redirect to
    // /sign-in, which left the unfurler describing the front door and the
    // person on a different URL; now the address answers for itself, with
    // its preview in the head, and the sign-in routes by hash.
    if (!UUID.test(id)) redirect(`/sign-in?redirect_url=${encodeURIComponent(h.get("x-hq-path") ?? "/")}`);
    return (
      <Gate>
        <GateWords step={undefined} />
        <SignIn withSignUp routing="hash" fallbackRedirectUrl={`/d/${id}`} appearance={gateCard} />
      </Gate>
    );
  }
  if (!UUID.test(id)) return <Sibling userId={me.userId} name={id} />;

  const doc = await asUser(me.userId, async (c) => {
    const r = await c.query(
      `select d.id, d.title, d.slug, d.agent_id, d.published_at, d.public_slug, d.visibility,
              d.content_hash, length(d.body_text) as chars,
              a.title as agent_title, a.source_session_id
         from documents d join agents a on a.id = d.agent_id
        where d.id = $1`, [id]);
    return r.rows[0] ?? null;
  });
  if (!doc) {
    // Not mine. A teammate by domain, or anyone the link reached, reads it
    // through the one function that knows the rule (db/018 hq_can_read).
    // Somebody else's private document and one that does not exist are the
    // same 404, as before; since 27 Sep the 404 is a door that names the
    // address they hold (./not-found.tsx), not a shrug.
    const shared = await documentForReader(me.userId, id);
    if (!shared) notFound();
    // The way back: the team page when they are on the team, else the list
    // of what was shared with them. Never the empty hub (27 Sep).
    const back = shared.team_domain ? `/t/${shared.team_domain}` : "/documents";
    return (
      <main className="doc">
        <DocChrome id={shared.id} title={shared.title ?? shared.slug}
                   agentId="" agentTitle="" discuss="" shareUrl={null}
                   reader={{ back, backLabel: shared.team_domain ?? "Shared with you",
                             author: shared.owner_address ?? shared.agent_title ?? "the author" }} />
        <iframe className="doc-frame" src={`/d/${shared.id}/raw`} title={shared.title ?? shared.slug} />
      </main>
    );
  }

  // The page's own public address, for the deep link. The forwarded headers
  // are what the edge actually served, so they win over the request's host.
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "hq.tranquilitybase.dev";
  const proto = (h.get("x-forwarded-proto")?.split(",")[0] ?? "https").trim();
  const page = `${proto}://${host}/d/${doc.id}`;
  const discuss = `tranquilitybase://discuss?session=${encodeURIComponent(doc.source_session_id)}`
    + `&ref=${encodeURIComponent(page)}`;

  return (
    <main className="doc">
      <DocChrome id={doc.id} title={doc.title ?? doc.slug}
                 agentId={doc.agent_id} agentTitle={doc.agent_title ?? "Knowledge Base"}
                 discuss={discuss} visibility={doc.visibility}
                 shareUrl={doc.published_at && doc.public_slug
                   ? `${shareBase(me.userId)}/${doc.public_slug}` : null} />
      {/* The document itself, sandboxed by the response it serves. Nothing in
          here can reach the page around it, which is the whole reason the
          page is around it. */}
      <iframe className="doc-frame" src={`/d/${doc.id}/raw`} title={doc.title ?? doc.slug} />
      {/* The bytes behind the frame can change under it (an update in place
          raises no event); this is the one thing on the page that notices. */}
      <Follow id={doc.id} hash={doc.content_hash} chars={Number(doc.chars)} />
    </main>
  );
}

/**
 * /d/<something-that-is-not-an-id>: a sibling link from a page served before
 * links were rewritten, or one a reader typed.
 *
 * The referrer names the document the link was clicked in; its agent owns the
 * sibling. Nothing is guessed across agents: two agents can hold the same
 * slug, and landing on the wrong one is worse than saying so.
 */
async function Sibling({ userId, name }: { userId: string; name: string }) {
  const h = await headers();
  const slug = name.replace(/\.html?$/i, "");
  const ref = h.get("referer");
  const from = ref?.match(/\/d\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1];
  if (from) {
    const hit = await asUser(userId, async (c) => {
      const r = await c.query(
        `select sib.id from documents src
           join documents sib on sib.agent_id = src.agent_id and sib.slug = $2
          where src.id = $1
          order by sib.created_at desc limit 1`,
        [from, slug]);
      return r.rows[0]?.id as string | undefined;
    });
    if (hit) redirect(`/d/${hit}`);
  }
  // Said, not swallowed. A bare 404 here reads as "the report is gone" when
  // what is true is "this address was never one of ours", so the words are
  // specific even though the status is the honest one. `notFound()` cannot
  // carry them, so this renders them and the route's own not-found file
  // carries the status for every other miss.
  return (
    <main className="doc-say">
      <h1>No page called &ldquo;{slug}&rdquo; here.</h1>
      <p>This address is a filename, not one of the hub&rsquo;s. It comes from a link
      inside a report that names the page beside it on disk.</p>
      <p>{from
        ? "The report it was clicked in has no sibling by that name, so there is nothing to open."
        : "Open it from the report that links to it and the hub will resolve it."}</p>
      <p className="m"><a href="/">your hub</a></p>
    </main>
  );
}
