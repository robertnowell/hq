import "../start/start.css";

/**
 * Integrations: where "Publish to your website" leads for an account with
 * no site connected (Robert, 29 Sep: "a pointer to connect your blog CMS
 * which goes to an integrations flow").
 *
 * The platforms listed are the ones whose APIs take a page's HTML intact
 * (access-model research, 27 Sep, finding 7): Shopify's blog articles,
 * HubSpot's blog posts, WordPress with an account that may post unfiltered
 * HTML. Connecting is not self-serve yet (hq-app-9q5), so the page says so
 * plainly and names what happens next rather than offering a button that
 * does nothing.
 */
export const dynamic = "force-dynamic";

const PLATFORMS = [
  { name: "WordPress", how: "Posts through the REST API, with an application password from an account allowed to publish unfiltered HTML." },
  { name: "Shopify", how: "Blog articles through the Admin API; the page's HTML is kept as written." },
  { name: "HubSpot", how: "Blog posts through the CMS API." },
  { name: "Your own domain", how: "A page at yourdomain.com/notes/<slug>, served by the hub, no CMS needed." },
];

export default function Integrations() {
  return (
    <main className="st">
      <p className="hq-kicker">Tranquility Knowledge Base</p>
      <h1 className="st-h1">Publish to your website.</h1>
      <p className="st-lede">
        Sharing a page keeps it behind an email code. Publishing puts it on your own site, public and
        indexed. Connect the site once, and "Publish to your website" appears in every share card.
      </p>
      <section className="st-way">
        <h2>What it can publish to.</h2>
        <ul className="int-list">
          {PLATFORMS.map((p) => (
            <li key={p.name}><b>{p.name}</b><span>{p.how}</span></li>
          ))}
        </ul>
      </section>
      <section className="st-way">
        <h2>Connecting is set up by hand for now.</h2>
        <p>Self-serve connection is being built. Until then, tell whoever shared the hub with you your site's
          address and platform, and it will be connected for you.</p>
      </section>
      <p className="st-foot"><a href="/">Back to your Knowledge Base</a></p>
    </main>
  );
}
