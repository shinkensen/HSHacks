"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { useAuth } from "@clerk/nextjs";

import { FocusTimer } from "@/components/copilot/FocusTimer";
import { ProgressDots } from "@/components/copilot/ProgressDots";
import { StepCard } from "@/components/copilot/StepCard";
import { StuckInput } from "@/components/copilot/StuckInput";
import { CopilotAppShell } from "@/components/copilot/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress, ProgressLabel, ProgressValue } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/convex-api";
import {
  normalizeSession,
  readSessionFromStorage,
  writeSessionToStorage,
} from "@/lib/session";
import { MAX_VISION_DATA_URL_LENGTH } from "@/lib/vision-image";
import type { Session } from "@/lib/types";

function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}

function syncSession(
  nextSession: Session,
  updateLocal: (value: {
    ownerUserId: string | null;
    value: Session;
  }) => void,
  upsertSession: (args: { session: Session }) => Promise<unknown>,
  userId: string | null | undefined,
) {
  writeSessionToStorage(nextSession, userId);
  updateLocal({
    ownerUserId: userId ?? null,
    value: nextSession,
  });
  if (userId) {
    void upsertSession({ session: nextSession });
  }
}

export default function FocusPage() {
  const router = useRouter();
  const { isLoaded: isAuthLoaded, userId } = useAuth();
  const remoteSession = useQuery(
    api.sessions.getCurrent,
    isAuthLoaded && userId ? {} : "skip",
  );
  const upsertSession = useMutation(api.sessions.upsertCurrent);

  const [localSession, setLocalSession] = useState<{
    ownerUserId: string | null;
    value: Session;
  } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [stuckOpen, setStuckOpen] = useState(false);
  const [stuckPending, setStuckPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
  const session = localSessionForUser ?? storageSession ?? normalizedRemoteSession;

  useEffect(() => {
    if (!isAuthLoaded || !userId || storageSession || !normalizedRemoteSession) return;

    writeSessionToStorage(normalizedRemoteSession, userId);
  }, [isAuthLoaded, normalizedRemoteSession, storageSession, userId]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    if (!isAuthLoaded) return;

    if (!session) {
      router.replace("/input");
    }
  }, [isAuthLoaded, router, session]);

  const currentStep = useMemo(() => {
    if (!session) return null;
    return session.steps[session.currentStepIndex] ?? null;
  }, [session]);

  const completionPercent = useMemo(() => {
    if (!session || !currentStep) return 0;

    const completed = session.steps.filter((step) => step.status === "done").length;
    const currentStepElapsedSeconds =
      currentStep.startedAt !== null
        ? Math.max(0, (now - currentStep.startedAt) / 1000)
        : 0;

    // Soft target is 5 minutes per step; count partial completion live.
    const currentStepFraction =
      currentStep.status === "done"
        ? 0
        : Math.min(1, currentStepElapsedSeconds / 300);

    return Math.round(
      ((completed + currentStepFraction) / session.steps.length) * 100,
    );
  }, [session, currentStep, now]);

  const currentStepElapsedSeconds = useMemo(() => {
    if (!currentStep || currentStep.startedAt === null) return 0;
    return Math.max(0, Math.floor((now - currentStep.startedAt) / 1000));
  }, [currentStep, now]);

  function handleDone() {
    if (!session || !currentStep) return;

    const now = Date.now();
    const updatedSteps = session.steps.map((step, index) => {
      if (index !== session.currentStepIndex) return step;

      return {
        ...step,
        status: "done" as const,
        completedAt: now,
      };
    });

    const nextStepIndex = session.currentStepIndex + 1;

    if (nextStepIndex >= updatedSteps.length) {
      const nextSession: Session = {
        ...session,
        steps: updatedSteps,
        state: "summary",
        updatedAt: now,
      };

      syncSession(nextSession, setLocalSession, upsertSession, userId);
      router.push("/summary");
      return;
    }

    const nextSteps = updatedSteps.map((step, index) => {
      if (index !== nextStepIndex || step.startedAt !== null) return step;

      return {
        ...step,
        startedAt: now,
      };
    });

    const nextSession: Session = {
      ...session,
      steps: nextSteps,
      currentStepIndex: nextStepIndex,
      state: "focus",
      updatedAt: now,
    };

    setStuckOpen(false);
    syncSession(nextSession, setLocalSession, upsertSession, userId);
  }

  async function handleUnstick(input: {
    reason: string;
    imageDataUrl: string | null;
  }) {
    if (!session || !currentStep || stuckPending) return;
    if (
      input.imageDataUrl &&
      input.imageDataUrl.length > MAX_VISION_DATA_URL_LENGTH
    ) {
      setError("Vision image is too large. Use a smaller screenshot.");
      return;
    }

    setStuckPending(true);
    setError(null);

    try {
      const response = await fetch("/api/steps/unstick", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          goal: session.goal,
          blockedStep: currentStep.text,
          blockerReason: input.reason,
          imageDataUrl: input.imageDataUrl,
        }),
      }).catch(() => {
        throw new Error("Network error while uploading vision input.");
      });

      let payload: { step?: string; error?: string } = {};
      try {
        payload = (await response.json()) as { step?: string; error?: string };
      } catch {
        throw new Error(`Request failed (${response.status}).`);
      }
      if (!response.ok || !payload.step) {
        throw new Error(payload.error ?? "Unable to recover step.");
      }

      const now = Date.now();
      const nextSession: Session = {
        ...session,
        steps: session.steps.map((step, index) => {
          if (index !== session.currentStepIndex) return step;

          return {
            ...step,
            text: payload.step ?? step.text,
            status: "pending",
            startedAt: now,
            completedAt: null,
          };
        }),
        updatedAt: now,
      };

      setStuckOpen(false);
      syncSession(nextSession, setLocalSession, upsertSession, userId);
    } catch (unstickError) {
      setError(
        unstickError instanceof Error
          ? unstickError.message
          : "Unable to recover step.",
      );
    } finally {
      setStuckPending(false);
    }
  }

  if (!isAuthLoaded || !session || !currentStep) {
    return (
      <CopilotAppShell title="Focus Mode">
        <main className="flex min-h-0 flex-1">
          <div className="grid w-full gap-6 p-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
            <div className="space-y-4">
              <Skeleton className="h-32 w-full" />
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
    <CopilotAppShell title="Focus Mode">
      <main className="flex min-h-0 flex-1">
        <div className="grid h-full w-full gap-6 p-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <section className="flex min-h-0 flex-col gap-6">
            <div className="transition-opacity duration-150">
              <StepCard text={currentStep.text} />
            </div>

            <Card className="bg-card/70">
              <CardContent className="flex flex-col gap-4 py-4">
                <ProgressDots
                  total={session.steps.length}
                  current={session.currentStepIndex}
                />
                <div className="flex items-center gap-3">
                  <Button onClick={handleDone} className="flex-1">
                    Done
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => setStuckOpen((value) => !value)}
                    className="flex-1"
                  >
                    Stuck
                  </Button>
                </div>
                <FocusTimer startedAt={currentStep.startedAt} />
              </CardContent>
            </Card>

            {stuckOpen ? (
              <Card className="border-dashed">
                <CardContent className="py-4">
                  <StuckInput
                    pending={stuckPending}
                    onCancel={() => setStuckOpen(false)}
                    onSubmit={handleUnstick}
                  />
                </CardContent>
              </Card>
            ) : null}

            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </section>

          <aside className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Session progress</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <Progress value={completionPercent} className="w-full gap-2">
                  <ProgressLabel>Completion</ProgressLabel>
                  <ProgressValue />
                </Progress>
                <p className="text-sm text-muted-foreground">
                  Step {session.currentStepIndex + 1} of {session.steps.length}
                </p>
                <p className="text-sm text-muted-foreground">
                  Current step time: {formatElapsed(currentStepElapsedSeconds)}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Current goal</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <Badge variant="outline">Active</Badge>
                <p className="text-sm text-muted-foreground">{session.goal}</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Recovery rule</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm text-muted-foreground">
                <p>When blocked, provide one reason or one image context.</p>
                <p>System returns one immediate action under 3 minutes.</p>
              </CardContent>
            </Card>
          </aside>

          <Card className="min-h-60 xl:col-span-2">
            <CardHeader>
              <CardTitle className="text-base">Step queue</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {session.steps.map((step, index) => (
                <div
                  key={step.id}
                  className="flex items-start justify-between gap-3 rounded-md border p-3"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {index + 1}. {step.text}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {index === session.currentStepIndex
                        ? "Current step"
                        : step.status === "done"
                          ? "Completed"
                          : "Pending"}
                    </p>
                  </div>
                  <Badge
                    variant={
                      index === session.currentStepIndex
                        ? "default"
                        : step.status === "done"
                          ? "secondary"
                          : "outline"
                    }
                  >
                    {index === session.currentStepIndex
                      ? "Now"
                      : step.status === "done"
                        ? "Done"
                        : "Next"}
                  </Badge>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </main>
    </CopilotAppShell>
  );
}
