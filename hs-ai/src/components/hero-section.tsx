"use client";

import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export default function HeroSection() {
  return (
    <section className="border-b border-border/60">
      <div className="mx-auto flex w-full max-w-5xl flex-col items-center px-6 py-18 text-center sm:px-8 sm:py-24">
        <h1 className="mt-5 max-w-4xl text-balance text-4xl font-medium tracking-tight text-foreground sm:text-6xl">
          One tiny step at a time.
          <span className="block text-primary">No planning spiral.</span>
        </h1>
        <p className="mt-5 max-w-2xl text-pretty text-base text-muted-foreground sm:text-lg">
          Give one vague goal. Get a calm queue of 2 to 10 minute actions. Press
          done, continue. Press stuck, recover instantly.
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/input"
            className={cn(buttonVariants({ size: "lg" }))}
          >
            Start focus session
          </Link>
          <Link
            href="/summary"
            className={cn(buttonVariants({ size: "lg", variant: "outline" }))}
          >
            Resume previous summary
          </Link>
        </div>
      </div>
    </section>
  );
}
