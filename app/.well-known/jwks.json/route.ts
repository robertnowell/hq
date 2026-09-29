import { publicJwks } from "@/lib/gateway-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The keys the Gateway checks a token's signature against.
 *
 * Public by design and by necessity: a verifier that had to authenticate to
 * fetch these would need a credential of its own, which is the problem this
 * is solving one layer down. Nothing secret is here, and the private half
 * never leaves the process that signs.
 *
 * An empty set is an honest answer, not an error. It means this deployment
 * holds no signing key and therefore mints nothing, and a verifier that gets
 * it will refuse every token rather than accept an unverifiable one.
 */
export async function GET() {
  return Response.json(await publicJwks(), {
    headers: { "cache-control": "public, max-age=300, stale-while-revalidate=3600" },
  });
}
