export type StepStatus = "pending" | "done" | "stuck";

export type SessionState = "input" | "focus" | "summary";

export type Step = {
  id: string;
  text: string;
  status: StepStatus;
  startedAt: number | null;
  completedAt: number | null;
};

export type Session = {
  goal: string;
  steps: Step[];
  currentStepIndex: number;
  startedAt: number;
  state: SessionState;
  updatedAt: number;
};

export type SessionSummary = {
  stepsStarted: number;
  stepsCompleted: number;
  focusMinutes: number;
};

export type SessionHistoryEntry = {
  id: string;
  goal: string;
  startedAt: number;
  completedAt: number;
  stepsStarted: number;
  stepsCompleted: number;
  focusMinutes: number;
};

export type WeeklyHistorySummary = {
  sessions: number;
  stepsCompleted: number;
  focusMinutes: number;
  yesterdaySessions: number;
  yesterdayStepsCompleted: number;
  yesterdayFocusMinutes: number;
};
