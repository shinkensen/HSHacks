import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function Home() {
  return (
    <main className="min-h-screen bg-background">
      <section className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-8 px-4 py-10 md:px-8">
        <header className="flex flex-col gap-3">
          <Badge variant="outline">hs-ai x pushup-nextjs merged</Badge>
          <h1 className="max-w-3xl text-4xl font-semibold tracking-tight sm:text-5xl">
            Real-time Pushup Coach + AI Next-Step Copilot
          </h1>
          <p className="max-w-2xl text-sm text-muted-foreground sm:text-base">
            Use camera-based form analysis and multiplayer rooms for workouts,
            then switch to single-step execution mode for focused GTM and build tasks.
          </p>
        </header>

        <div className="grid gap-4 md:grid-cols-3">
          <Card className="border-border/70">
            <CardHeader>
              <CardTitle>Pushup Coach</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                Live form scoring, rep tracking, goal progress, calorie estimate,
                form trend graph, and room relay persistence via Convex.
              </p>
              <Link href="/pushups" className={buttonVariants()}>
                Open coach
              </Link>
            </CardContent>
          </Card>

          <Card className="border-border/70">
            <CardHeader>
              <CardTitle>AI Copilot</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                One-step focus queue with vision-aware recovery when blocked.
                Built on Clerk auth + Convex persistence.
              </p>
              <Link href="/input" className={buttonVariants({ variant: "outline" })}>
                Start session
              </Link>
            </CardContent>
          </Card>

          <Card className="border-border/70">
            <CardHeader>
              <CardTitle>Dashboard</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                Review completion history, streak trends, and daily throughput.
              </p>
              <Link
                href="/dashboard"
                className={buttonVariants({ variant: "secondary" })}
              >
                View insights
              </Link>
            </CardContent>
          </Card>
        </div>
      </section>
    </main>
  );
}
