import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

// Session context only. This deliberately does NOT gate access to anything.
//
// Both Clerk and Vercel publish the same guidance for the same reason: a
// middleware matcher that does not cover a route, or a bug in the gate,
// exposes data silently. Authorization lives next to the data access, in the
// route handler and the page, where there is no matcher to forget.
// The page a signed-out visitor asked for travels on a request header, so the
// layout can send them to the front door and the front door can send them
// back. Clerk reads redirect_url; the app mints nothing of its own.
export default clerkMiddleware((_auth, req) => {
  // A POST that rides on the browser cookie must come from this site. A
  // machine carrying a token, Stripe's webhook and the cron have no cookie
  // and no Origin, and are not affected (safety review, 29 Sep).
  if (req.method === "POST" && req.nextUrl.pathname.startsWith("/api/")
      && !req.headers.get("authorization")) {
    const origin = req.headers.get("origin");
    if (origin && new URL(origin).host !== req.nextUrl.host) {
      return new NextResponse("cross-site request refused", { status: 403 });
    }
  }
  const headers = new Headers(req.headers);
  headers.set("x-hq-path", req.nextUrl.pathname + req.nextUrl.search);
  const res = NextResponse.next({ request: { headers } });
  // Nobody else may frame the hub (clickjacking); its own document frames
  // are same-origin and unaffected.
  // The one exception: a published page framed by the connected site, which
  // names its own frame-ancestors (app/p/frame).
  if (!req.nextUrl.pathname.startsWith("/p/frame/")) res.headers.set("x-frame-options", "SAMEORIGIN");
  return res;
});

export const config = {
  matcher: [
    // Everything except static files and _next internals.
    //
    // `html?` was in this list and should never have been: nothing in
    // /public is a .html file, but an ARCHIVE page is, and every sibling
    // link an agent writes ends in .html. A request for /d/foo.html fell
    // outside the matcher, clerkMiddleware never ran, and auth() inside
    // identify() threw -- so the address a reader actually clicked returned
    // 500 while /d/foo returned a clean 401. An extension is a fact about a
    // filename, not about whether a route needs a session.
    "/((?!_next|[^?]*\\.(?:css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/:path*",
  ],
};
