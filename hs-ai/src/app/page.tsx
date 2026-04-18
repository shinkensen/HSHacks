import FeaturesSection from "@/components/features-2";
import HeroSection from "@/components/hero-section";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import Link from "next/link";

export default function Home() {
  return (
    <main className="min-h-screen bg-background">
      <SiteHeader />
      <HeroSection />
      <FeaturesSection />
      <section className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-4 py-10 sm:px-6">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Ready to train?</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Launch the live push-up tracker with posture feedback and room sharing.
          </p>
        </div>
        <Link
          href="/workout"
          className="inline-flex h-10 items-center rounded-md bg-foreground px-4 text-sm font-medium text-background transition-opacity hover:opacity-90"
        >
          Open Workout
        </Link>
      </section>
      <SiteFooter />
    </main>
  );
}
