"use client";

import { useEffect, useMemo, useState } from "react";

import { Progress } from "@/components/ui/progress";

function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}

export function FocusTimer({ startedAt }: { startedAt: number | null }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, []);

  const elapsedSeconds = startedAt
    ? Math.max(0, Math.floor((now - startedAt) / 1000))
    : 0;

  const progressValue = useMemo(
    () => Math.min(100, Math.round((elapsedSeconds / 300) * 100)),
    [elapsedSeconds],
  );

  return (
    <Progress value={progressValue} className="w-full gap-2">
      <p className="ml-auto text-sm text-muted-foreground tabular-nums">
        {formatElapsed(elapsedSeconds)} / 5:00 soft target
      </p>
    </Progress>
  );
}
