import type {
  Session,
  SessionHistoryEntry,
  SessionSummary,
  Step,
  WeeklyHistorySummary,
} from "@/lib/types";

export const SESSION_STORAGE_KEY = "copilot-session";
export const SESSION_HISTORY_STORAGE_KEY = "copilot-session-history";
const DAY_MS = 24 * 60 * 60 * 1000;

function scopedSessionStorageKey(userId: string): string {
  return `${SESSION_STORAGE_KEY}:${userId}`;
}

function scopedSessionHistoryStorageKey(userId: string): string {
  return `${SESSION_HISTORY_STORAGE_KEY}:${userId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || isNumber(value);
}

function isHistoryEntry(value: unknown): value is SessionHistoryEntry {
  if (!isRecord(value)) return false;

  return (
    typeof value.id === "string" &&
    typeof value.goal === "string" &&
    isNumber(value.startedAt) &&
    isNumber(value.completedAt) &&
    isNumber(value.stepsStarted) &&
    isNumber(value.stepsCompleted) &&
    isNumber(value.focusMinutes)
  );
}

function isStep(value: unknown): value is Step {
  if (!isRecord(value)) return false;

  return (
    typeof value.id === "string" &&
    typeof value.text === "string" &&
    (value.status === "pending" ||
      value.status === "done" ||
      value.status === "stuck") &&
    isNullableNumber(value.startedAt) &&
    isNullableNumber(value.completedAt)
  );
}

export function normalizeSession(value: unknown): Session | null {
  if (!isRecord(value)) return null;

  if (
    typeof value.goal !== "string" ||
    !Array.isArray(value.steps) ||
    !isNumber(value.currentStepIndex) ||
    !isNumber(value.startedAt) ||
    !isNumber(value.updatedAt)
  ) {
    return null;
  }

  if (
    value.state !== "input" &&
    value.state !== "focus" &&
    value.state !== "summary"
  ) {
    return null;
  }

  const steps = value.steps.filter(isStep);
  if (steps.length === 0 || steps.length > 20) return null;

  const currentStepIndex = Math.max(
    0,
    Math.min(value.currentStepIndex, steps.length - 1),
  );

  const goal = value.goal.trim();
  if (goal.length < 3 || goal.length > 240) return null;

  return {
    goal,
    steps,
    currentStepIndex,
    startedAt: value.startedAt,
    state: value.state,
    updatedAt: value.updatedAt,
  };
}

export function readSessionFromStorage(userId: string | null | undefined): Session | null {
  if (typeof window === "undefined") return null;
  if (!userId) return null;

  const raw = window.localStorage.getItem(scopedSessionStorageKey(userId));
  if (!raw) return null;

  try {
    return normalizeSession(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function writeSessionToStorage(
  session: Session,
  userId: string | null | undefined,
): void {
  if (typeof window === "undefined") return;
  if (!userId) return;

  window.localStorage.setItem(
    scopedSessionStorageKey(userId),
    JSON.stringify(session),
  );
}

export function clearSessionFromStorage(userId: string | null | undefined): void {
  if (typeof window === "undefined") return;
  if (userId) {
    window.localStorage.removeItem(scopedSessionStorageKey(userId));
  }
  window.localStorage.removeItem(SESSION_STORAGE_KEY);
}

export function deriveSummary(session: Session): SessionSummary {
  let focusMs = 0;

  for (const step of session.steps) {
    if (step.startedAt !== null && step.completedAt !== null) {
      focusMs += Math.max(step.completedAt - step.startedAt, 0);
    }
  }

  return {
    stepsStarted: session.steps.filter((step) => step.startedAt !== null).length,
    stepsCompleted: session.steps.filter((step) => step.status === "done").length,
    focusMinutes: Math.round(focusMs / 60000),
  };
}

export function readSessionHistory(
  userId: string | null | undefined,
): SessionHistoryEntry[] {
  if (typeof window === "undefined") return [];
  if (!userId) return [];

  const raw = window.localStorage.getItem(scopedSessionHistoryStorageKey(userId));
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isHistoryEntry)
      .sort((a, b) => b.completedAt - a.completedAt);
  } catch {
    return [];
  }
}

export function recordSessionHistory(
  userId: string | null | undefined,
  session: Session,
): SessionHistoryEntry[] {
  if (typeof window === "undefined" || !userId) return [];

  const summary = deriveSummary(session);
  const nextEntry: SessionHistoryEntry = {
    id: String(session.startedAt),
    goal: session.goal,
    startedAt: session.startedAt,
    completedAt: session.updatedAt,
    stepsStarted: summary.stepsStarted,
    stepsCompleted: summary.stepsCompleted,
    focusMinutes: summary.focusMinutes,
  };

  const current = readSessionHistory(userId).filter(
    (entry) => entry.id !== nextEntry.id,
  );
  const next = [nextEntry, ...current]
    .sort((a, b) => b.completedAt - a.completedAt)
    .slice(0, 180);

  window.localStorage.setItem(
    scopedSessionHistoryStorageKey(userId),
    JSON.stringify(next),
  );

  return next;
}

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function deriveWeeklyHistorySummary(
  entries: SessionHistoryEntry[],
  now = Date.now(),
): WeeklyHistorySummary {
  const todayStart = startOfDay(now);
  const yesterdayStart = todayStart - DAY_MS;
  const weekStart = todayStart - DAY_MS * 6;

  let sessions = 0;
  let stepsCompleted = 0;
  let focusMinutes = 0;
  let yesterdaySessions = 0;
  let yesterdayStepsCompleted = 0;
  let yesterdayFocusMinutes = 0;

  for (const entry of entries) {
    if (entry.completedAt >= weekStart && entry.completedAt < todayStart + DAY_MS) {
      sessions += 1;
      stepsCompleted += entry.stepsCompleted;
      focusMinutes += entry.focusMinutes;
    }

    if (
      entry.completedAt >= yesterdayStart &&
      entry.completedAt < yesterdayStart + DAY_MS
    ) {
      yesterdaySessions += 1;
      yesterdayStepsCompleted += entry.stepsCompleted;
      yesterdayFocusMinutes += entry.focusMinutes;
    }
  }

  return {
    sessions,
    stepsCompleted,
    focusMinutes,
    yesterdaySessions,
    yesterdayStepsCompleted,
    yesterdayFocusMinutes,
  };
}

export function filterHistoryByDay(
  entries: SessionHistoryEntry[],
  dayTimestamp: number,
): SessionHistoryEntry[] {
  const dayStart = startOfDay(dayTimestamp);
  const dayEnd = dayStart + DAY_MS;
  return entries.filter(
    (entry) => entry.completedAt >= dayStart && entry.completedAt < dayEnd,
  );
}
