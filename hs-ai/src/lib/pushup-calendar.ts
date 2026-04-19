/** Presence pings often persist as sessions with 0 logged reps — drop from UI and stats. */

export type PushupCalendarSession = {
  _id: string;
  roomId: string;
  username: string;
  startedAt: number;
  endedAt: number | null;
  maxReps: number;
  caloriesEstimate: number;
};

export type PushupStats = {
  workouts: number;
  totalReps: number;
  calories: number;
  minutes: number;
};

export function normalizedMaxReps(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

export function isMeaningfulPushupSession(
  s: Pick<PushupCalendarSession, "maxReps"> | { maxReps: unknown },
): boolean {
  return normalizedMaxReps(s.maxReps) >= 1;
}

export function withNormalizedReps(
  s: PushupCalendarSession | (Omit<PushupCalendarSession, "maxReps"> & { maxReps: unknown }),
): PushupCalendarSession {
  return {
    ...s,
    maxReps: normalizedMaxReps(s.maxReps),
  };
}

export function reducePushupDayStats(
  sessions: PushupCalendarSession[],
): PushupStats {
  return sessions.reduce(
    (acc, s) => ({
      workouts: acc.workouts + 1,
      totalReps: acc.totalReps + s.maxReps,
      calories: Number((acc.calories + s.caloriesEstimate).toFixed(1)),
      minutes:
        acc.minutes +
        Math.max(
          0,
          Math.round(((s.endedAt ?? s.startedAt) - s.startedAt) / 60000),
        ),
    }),
    { workouts: 0, totalReps: 0, calories: 0, minutes: 0 },
  );
}

const MAX_SESSIONS_LIST = 12;

export function finalizeSelectedDaySessions(
  raw: Array<Omit<PushupCalendarSession, "maxReps"> & { maxReps: unknown }>,
): PushupCalendarSession[] {
  return raw
    .map((s) => withNormalizedReps(s as PushupCalendarSession))
    .filter(isMeaningfulPushupSession)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, MAX_SESSIONS_LIST);
}
