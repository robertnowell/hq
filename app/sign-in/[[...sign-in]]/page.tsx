import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { SignIn } from "@clerk/nextjs";
import "../../front-door.css";
import { GateWords } from "../gate-words";
import { gateCard } from "../gate-card";
import { Gate } from "../../gate";

/**
 * The front door, and the door to one document.
 *
 * FRONT DOOR. One screen: the mark, the name, one sentence, and the sign-in
 * itself. For this product signing in IS the product, so the form is the
 * action and it sits on the landing rather than behind a button. Nothing
 * else: no nav, no footer, no feature list, no screenshot (13 Sep), and
 * since 27 Sep no "no password" line and no three-step walkthrough either
 * (Robert: "completely unnecessary"). Settled by the 11 Sep front-door
 * research (2026-09-11-knowledge-base-front-door).
 *
 * DOCUMENT DOOR. A person who was sent a document arrives with its address
 * as the way back. They are not here for the product; they are here for
 * the page, so the page is what they see: its shape, blurred, behind one
 * sentence and an email field. Show, do not tell (Robert, 27 Sep). The
 * shape is a drawing, not the document: nothing of the content is served
 * until the email has been verified.
 *
 * Clerk draws the card in sign-in-or-up mode, so one field serves new and
 * returning people. The destination travels as Clerk's own redirect_url;
 * the app mints no parameter of its own.
 */
export const dynamic = "force-dynamic";

/** Only a path on this site is a place to return to. */
function safeReturn(v: string | undefined): string {
  if (!v) return "/";
  // Parsed, not pattern-matched: "/\\evil.com" passes a startsWith("/")
  // check and browsers read it as another host (safety review, 29 Sep).
  try {
    const u = new URL(v, "https://hub.invalid");
    return u.origin === "https://hub.invalid" ? u.pathname + u.search + u.hash : "/";
  } catch { return "/"; }
}

/** A document's address: the hub's own, or the older link form. */
const DOCUMENT = /^\/(d|p)\/[^/?#]+/;

const card = {
  elements: {
    cardBox: { width: "100%" },
    card: { padding: "1.25rem 1.25rem 1rem" },
    header: { display: "none" },
  },
};



export default async function FrontDoor(
  { params, searchParams }: {
    params: Promise<{ "sign-in"?: string[] }>;
    searchParams: Promise<{ redirect_url?: string }>;
  },
) {
  const { userId } = await auth();
  const { redirect_url } = await searchParams;
  const step = (await params)["sign-in"]?.[0];
  const back = safeReturn(redirect_url);
  if (userId) redirect(back);

  if (DOCUMENT.test(back)) {
    return (
      <Gate>
        <GateWords step={step} />
        <SignIn withSignUp fallbackRedirectUrl={back} appearance={gateCard} />
      </Gate>
    );
  }

  return (
    <main className="door">
      <section className="door-hero">
        <svg className="door-mark" viewBox="0 0 16 16" aria-hidden="true">
          <path fillRule="evenodd" d="M8 1.3a4.9 4.9 0 1 0 0 9.8 4.9 4.9 0 0 0 0-9.8zm0 1.6a3.3 3.3 0 1 1 0 6.6 3.3 3.3 0 0 1 0-6.6zM1.5 12.8h13v1.6h-13z"/>
        </svg>
        <p className="door-name">Tranquility Knowledge Base</p>
        <h1 className="door-line">Everything your agents write, in one place, on every device.</h1>
        <div className="door-card">
          <SignIn withSignUp fallbackRedirectUrl={back} appearance={card} />
        </div>
      </section>
    </main>
  );
}
