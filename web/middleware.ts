import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest): NextResponse | undefined {
  const { pathname } = request.nextUrl;
  if (pathname === "") {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url, 302);
  }
  return undefined;
}

export const config = {
  matcher: ["/((?!_next|favicon.ico).*)"],
};
