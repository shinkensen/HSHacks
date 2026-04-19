"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { useAuth } from "@clerk/nextjs";

import { CopilotAppShell } from "@/components/copilot/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/convex-api";
import {
  clearSessionFromStorage,
  deriveSummary,
  normalizeSession,
  readSessionFromStorage,
  writeSessionToStorage,
} from "@/lib/session";
import type { Session } from "@/lib/types";

export default function SummaryPage() {
  const router = useRouter();
  const { isLoaded: isAuthLoaded, userId } = useAuth();
  const remoteSession = useQuery(
    api.sessions.getCurrent,
    isAuthLoaded && userId ? {} : "skip",
  );
  const clearSession = useMutation(api.sessions.clearCurrent);
  const recordCompletion = useMutation(api.sessions.recordCompletion);

  const [localSession, setLocalSession] = useState<{
    ownerUserId: string | null;
    value: Session;
  } | null>(null);

  const normalizedRemoteSession = useMemo(
    () => normalizeSession(remoteSession),
    [remoteSession],
  );

  const localSessionForUser =
    localSession?.ownerUserId === (userId ?? null) ? localSession.value : null;
  const storageSession = useMemo(
    () => (isAuthLoaded ? readSessionFromStorage(userId) : null),
    [isAuthLoaded, userId],
  );
  const session =
    localSessionForUser ?? storageSession ?? normalizedRemoteSession;

  useEffect(() => {
    if (!isAuthLoaded || !userId || storageSession || !normalizedRemoteSession)
      return;

    writeSessionToStorage(normalizedRemoteSession, userId);
  }, [isAuthLoaded, normalizedRemoteSession, storageSession, userId]);

  useEffect(() => {
    if (!isAuthLoaded) return;

    if (!session) {
      router.replace("/input");
    }
  }, [isAuthLoaded, router, session]);

  const summary = useMemo(() => {
    if (!session) return null;
    return deriveSummary(session);
  }, [session]);

  useEffect(() => {
    if (!isAuthLoaded || !userId || !session || session.state !== "summary")
      return;
    void recordCompletion({ session });
  }, [isAuthLoaded, recordCompletion, session, userId]);

  async function handleRestart() {
    clearSessionFromStorage(userId);
    setLocalSession(null);
    await clearSession({});
    router.push("/input");
  }

  if (!isAuthLoaded || !session || !summary) {
    return (
      <CopilotAppShell title="Session Summary">
        <main className="flex min-h-0 flex-1">
          <div className="grid w-full gap-6 p-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
            <div className="space-y-4">
              <Skeleton className="h-40 w-full" />
              <Skeleton className="h-36 w-full" />
            </div>
            <div className="space-y-4">
              <Skeleton className="h-32 w-full" />
              <Skeleton className="h-32 w-full" />
            </div>
          </div>
        </main>
      </CopilotAppShell>
    );
  }

  return (
    <CopilotAppShell title="Session Summary">
      <main className="flex min-h-0 flex-1">
        <div className="grid w-full gap-6 p-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <section className="space-y-6">
            <Card>
              <CardHeader className="gap-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-2xl">Session summary</CardTitle>
                  <Badge variant="outline">Completed</Badge>
                </div>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-3">
                <Card className="bg-muted/30">
                  <CardContent className="space-y-1">
                    <p className="text-xs text-muted-foreground">
                      Steps started
                    </p>
                    <p className="text-2xl font-semibold">
                      {summary.stepsStarted}
                    </p>
                  </CardContent>
                </Card>
                <Card className="bg-muted/30">
                  <CardContent className="space-y-1">
                    <p className="text-xs text-muted-foreground">
                      Steps completed
                    </p>
                    <p className="text-2xl font-semibold">
                      {summary.stepsCompleted}
                    </p>
                  </CardContent>
                </Card>
                <Card className="bg-muted/30">
                  <CardContent className="space-y-1">
                    <p className="text-xs text-muted-foreground">
                      Focus minutes
                    </p>
                    <p className="text-2xl font-semibold">
                      {summary.focusMinutes}
                    </p>
                  </CardContent>
                </Card>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Next move</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Start a fresh queue and keep momentum while context is still
                  warm.
                </p>
                <Button onClick={handleRestart} className="w-full sm:w-auto">
                  Start a new session
                </Button>
              </CardContent>
            </Card>
          </section>

          <aside className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Goal recap</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">{session.goal}</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Quality check</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm text-muted-foreground">
                <p>Single-step flow maintained.</p>
                <p>Convex state synced for history and streaks.</p>
                <p>Recovery path available when blocked.</p>
              </CardContent>
            </Card>
          </aside>
        </div>
      </main>
    </CopilotAppShell>
  );
}
