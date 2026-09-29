export const runtime = "nodejs";

/**
 * Nothing on this origin is for a crawler.
 *
 * Everything private is already behind authentication, so this is not a
 * security control and is not written as one. It is an instruction to the
 * polite majority not to spend their time, and ours, on a few hundred
 * thousand URLs that will all answer 307 to a sign-in page.
 * A shared page on this hub is a link
 * somebody was handed, and where an account has a site connected, that site
 * renders the page itself and owns the indexed copy. So this file asks
 * crawlers to stay off the whole origin, and every shared page says noindex
 * in its own headers as well, because a robots file is a request and a header
 * is an instruction.
 */
export async function GET() {
  const body = `User-agent: *
Disallow: /
`;
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
