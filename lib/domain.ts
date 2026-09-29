import { PUBLIC_EMAIL_DOMAINS } from "./public-email-domains";

/**
 * The team an address belongs to, or null.
 *
 * A team is an email domain (ruled 27 Sep 2026). The string after the @ is
 * lower-cased and checked against the list of public providers: an address
 * at gmail.com belongs to a person, not a company, so it names no team. This
 * is the same rule Clerk, Notion and Google apply, in a file the hub owns.
 *
 * Nothing is verified here beyond what the sign-in already proved: the front
 * door sends a code to the address, so the address is the person's, and the
 * domain follows from it.
 */
export function domainOf(address: string | null | undefined): string | null {
  if (!address) return null;
  const at = address.lastIndexOf("@");
  if (at < 0) return null;
  const d = address.slice(at + 1).trim().toLowerCase();
  if (!isDomainShaped(d)) return null;
  if (PUBLIC_EMAIL_DOMAINS.has(d)) return null;
  return d;
}

/** A domain somebody typed into the share card: shaped like one, and not a public provider. */
export function shareableDomain(raw: string): { ok: true; domain: string } | { ok: false; why: string } {
  const d = raw.trim().toLowerCase().replace(/^@/, "");
  if (!isDomainShaped(d)) return { ok: false, why: "That is not a domain. Try something like acme.com." };
  if (PUBLIC_EMAIL_DOMAINS.has(d)) {
    return { ok: false, why: `${d} is a public email provider, not a company. Share by link instead; the reader still signs in.` };
  }
  return { ok: true, domain: d };
}

export function isDomainShaped(d: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,}$/.test(d);
}
