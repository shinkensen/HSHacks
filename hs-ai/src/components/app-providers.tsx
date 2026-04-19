"use client";

import { ClerkProvider, useAuth } from "@clerk/nextjs";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { ConvexReactClient } from "convex/react";
import { TooltipProvider } from "@/components/ui/tooltip";

function normalizeConvexUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
if (!convexUrl) {
  throw new Error("NEXT_PUBLIC_CONVEX_URL is required.");
}

const convexClient = new ConvexReactClient(normalizeConvexUrl(convexUrl));

function ConvexClerkBridge({ children }: { children: React.ReactNode }) {
  return (
    <ConvexProviderWithClerk client={convexClient} useAuth={useAuth}>
      {children}
    </ConvexProviderWithClerk>
  );
}

export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider>
      <ConvexClerkBridge>
        <TooltipProvider>{children}</TooltipProvider>
      </ConvexClerkBridge>
    </ClerkProvider>
  );
}
