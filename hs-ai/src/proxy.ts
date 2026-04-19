import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

const isProtectedRoute = createRouteMatcher([
  "/pushups(.*)",
  "/crunches(.*)",
  "/input(.*)",
  "/focus(.*)",
  "/summary(.*)",
  "/api/rooms(.*)",
  "/api/crunch-rooms(.*)",
  "/api/pushups(.*)",
  "/api/crunches(.*)",
  "/api/steps(.*)",
]);

export default clerkMiddleware(async (auth, request) => {
  const { userId } = await auth();

  if (userId && request.nextUrl.pathname === "/") {
    return NextResponse.redirect(new URL("/pushups", request.url));
  }

  if (isProtectedRoute(request)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
