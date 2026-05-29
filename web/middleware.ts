import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest): NextResponse | undefined {
  const { pathname } = request.nextUrl;
  // Redirect paths that lack a trailing slash (e.g. example.com or /embed) to
  // the canonical form with a slash. Paths with a file extension (e.g. /og.png)
  // are excluded because static assets must not have a trailing slash appended.
  const hasExtension = /\.[^/]+$/.test(pathname);
  if (!pathname.endsWith("/") && !hasExtension && !pathname.startsWith("/api/")) {
    const url = request.nextUrl.clone();
    url.pathname = (pathname || "/") + "/";
    return NextResponse.redirect(url, 302);
  }
  return undefined;
}

export const config = {
  matcher: ["/((?!_next|favicon.ico).*)"],
};
