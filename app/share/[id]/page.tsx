import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { identify } from "@/lib/auth";
import { asUser } from "@/lib/db";
import { ShareCard } from "../../share-card";
import "../share.css";

export const dynamic = "force-dynamic";

/**
 * The share card, on its own.
 *
 * A document in the hub is served inside a CSP sandbox with an opaque origin,
 * so nothing drawn into that page can carry a session or call a server
 * action. The control in its header therefore opens this, small and centred,
 * in a window of its own: a modal in every sense a person cares about, and
 * the only shape that can actually do the work from that surface.
 *
 * The same card is the dialog in the hub's own lists, where a real modal is
 * possible. One component, two hosts, one design.
 */
export default async function SharePage({ params }: { params: Promise<{ id: string }> }) {
  const h = await headers();
  const me = await identify(new Request("http://local", { headers: h }));
  if (!me) {
    const here = h.get("x-hq-path") ?? "/";
    redirect(`/sign-in?redirect_url=${encodeURIComponent(here)}`);
  }
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const doc = await asUser(me.userId, async (c) => {
    const r = await c.query(
      `select id, title, slug, visibility from documents where id = $1`, [id]);
    return r.rows[0] ?? null;
  });
  // Somebody else's document and a document that does not exist are one answer.
  if (!doc) notFound();


  return (
    <main className="sc-host">
      <ShareCard id={doc.id} title={doc.title ?? doc.slug} initialVisibility={doc.visibility} />
    </main>
  );
}
