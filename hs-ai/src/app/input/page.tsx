"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { useAuth } from "@clerk/nextjs";

import { api } from "@/lib/convex-api";
import {
  normalizeSession,
  readSessionFromStorage,
  writeSessionToStorage,
} from "@/lib/session";
import { MAX_VISION_DATA_URL_LENGTH } from "@/lib/vision-image";
import type { Session, Step } from "@/lib/types";
import { CopilotAppShell } from "@/components/copilot/app-shell";
import { VisionCapture } from "@/components/copilot/VisionCapture";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress, ProgressLabel, ProgressValue } from "@/components/ui/progress";

export default function InputPage() {
  const router = useRouter();
  const { isLoaded: isAuthLoaded, userId } = useAuth();
  const remoteSession = useQuery(
    api.sessions.getCurrent,
    isAuthLoaded && userId ? {} : "skip",
  );
  const upsertSession = useMutation(api.sessions.upsertCurrent);

  const [goal, setGoal] = useState("");
  const [goalImageDataUrl, setGoalImageDataUrl] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const normalizedRemoteSession = useMemo(
    () => normalizeSession(remoteSession),
    [remoteSession],
  );

  const storageSession = useMemo(
    () => (isAuthLoaded ? readSessionFromStorage(userId) : null),
    [isAuthLoaded, userId],
  );

  useEffect(() => {
    if (!isAuthLoaded || !userId || storageSession || !normalizedRemoteSession) return;

    writeSessionToStorage(normalizedRemoteSession, userId);
  }, [isAuthLoaded, normalizedRemoteSession, storageSession, userId]);

  const goalLength = goal.trim().length;
  const readiness = Math.min(
    100,
    (goalLength >= 3 ? 60 : 0) + (goalImageDataUrl ? 40 : 0),
  );

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const normalizedGoal = goal.trim();
    const hasGoal = normalizedGoal.length >= 3 && normalizedGoal.length <= 240;
    const hasImage = Boolean(goalImageDataUrl);

    if ((!hasGoal && !hasImage) || pending) {
      return;
    }
    if (goalImageDataUrl && goalImageDataUrl.length > MAX_VISION_DATA_URL_LENGTH) {
      setError("Vision image is too large. Use a smaller screenshot.");
      return;
    }
    if (!userId) {
      setError("You need to sign in to continue.");
      return;
    }

    setPending(true);
    setError(null);

    try {
      const response = await fetch("/api/steps/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          goal: hasGoal ? normalizedGoal : null,
          imageDataUrl: goalImageDataUrl,
        }),
      }).catch(() => {
        throw new Error("Network error while uploading vision input.");
      });

      let payload: { steps?: string[]; error?: string } = {};
      try {
        payload = (await response.json()) as { steps?: string[]; error?: string };
      } catch {
        throw new Error(`Request failed (${response.status}).`);
      }

      if (!response.ok || !payload.steps || payload.steps.length === 0) {
        throw new Error(payload.error ?? "Could not generate first steps.");
      }

      const now = Date.now();
      const steps: Step[] = payload.steps.map((text, index) => ({
        id: `${now}-${index}`,
        text,
        status: "pending",
        startedAt: index === 0 ? now : null,
        completedAt: null,
      }));

      const session: Session = {
        goal: hasGoal ? normalizedGoal : "Goal inferred from image context",
        steps,
        currentStepIndex: 0,
        startedAt: now,
        state: "focus",
        updatedAt: now,
      };

      writeSessionToStorage(session, userId);
      await upsertSession({ session });
      router.push("/focus");
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Something went wrong. Try again.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <CopilotAppShell title="Goal Capture">
      <main className="flex min-h-0 flex-1">
        <div className="grid w-full gap-6 p-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <Card className="h-fit">
            <CardHeader className="gap-3">
              <div className="flex items-center justify-between gap-3">
                <CardTitle className="text-2xl">What are you trying to do?</CardTitle>
                <Badge variant="outline">2 to 10 minute steps</Badge>
              </div>
            </CardHeader>
            <CardContent>
              <form onSubmit={onSubmit} className="flex flex-col gap-4">
                <Input
                  value={goal}
                  onChange={(event) => setGoal(event.target.value)}
                  placeholder="finish hackathon project (or attach screenshot below)"
                  maxLength={240}
                  autoFocus
                  disabled={pending || !isAuthLoaded}
                  aria-label="Goal input"
                />
                <VisionCapture
                  id="goal-vision-image"
                  label="Vision input (optional)"
                  description="Drop file, upload, or open embedded camera."
                  disabled={pending || !isAuthLoaded}
                  value={goalImageDataUrl}
                  onChange={setGoalImageDataUrl}
                />
                <Button
                  type="submit"
                  disabled={
                    pending ||
                    !isAuthLoaded ||
                    (goal.trim().length < 3 && !goalImageDataUrl)
                  }
                >
                  {pending ? "breaking it down..." : "Let's go"}
                </Button>
                {error ? <p className="text-sm text-destructive">{error}</p> : null}
              </form>
            </CardContent>
          </Card>

          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Session readiness</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <Progress value={readiness} className="w-full gap-2">
                  <ProgressLabel>Ready</ProgressLabel>
                  <ProgressValue />
                </Progress>
                <p className="text-sm text-muted-foreground">
                  Add either a clear goal or image context. Add both for higher-quality steps.
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">How it works</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm text-muted-foreground">
                <p>1. Give one goal in plain language, or show your screen with vision.</p>
                <p>2. You get a calm queue of executable actions.</p>
                <p>3. If blocked, hit stuck and recover with one next action.</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Defaults</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm text-muted-foreground">
                <p>Single active step at a time.</p>
                <p>Progress synced with Clerk auth and Convex persistence.</p>
                <p>Vision images are resized before upload for reliability.</p>
              </CardContent>
            </Card>
          </div>
        </div>
      </main>
    </CopilotAppShell>
  );
}
