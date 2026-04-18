"use client";

import { useEffect, useMemo, useState } from "react";
import { UserButton, useAuth, useUser } from "@clerk/nextjs";
import { useQuery } from "convex/react";
import dynamic from "next/dynamic";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";

import { api } from "@/lib/convex-api";
import {
  finalizeSelectedDaySessions,
  reducePushupDayStats,
  type PushupCalendarSession,
  type PushupStats,
} from "@/lib/pushup-calendar";
import { Calendar } from "@/components/ui/calendar";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarSeparator,
  SidebarTrigger,
} from "@/components/ui/sidebar";

type HistoryItem = {
  _id: string;
  goal: string;
  sessionCompletedAt: number;
  stepsCompleted: number;
};

type DaySummary = {
  sessions: number;
  stepsCompleted: number;
};

type PushupSessionItem = PushupCalendarSession;
type SidebarCalendarDay = {
  dayKey: string;
  workouts?: number;
  totalReps?: number;
  calories?: number;
  sessionsCompleted?: number;
  stepsCompleted?: number;
  focusMinutes?: number;
};

const ActivityHeatMap = dynamic(() => import("@uiw/react-heat-map"), {
  ssr: false,
});

function formatShortDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function formatShortTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function truncateGoal(goal: string): string {
  if (goal.length <= 48) return goal;
  return `${goal.slice(0, 45)}...`;
}

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function formatSelectedDay(date: Date | undefined): string {
  if (!date) return "No date";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function toLocalDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toHeatmapDayKey(dayKey: string): string {
  return dayKey.replaceAll("-", "/");
}

function AppSidebarLeft({
  pathname,
  history,
  userName,
  userEmail,
  isUserLoaded,
}: {
  pathname: string;
  history: HistoryItem[];
  userName: string;
  userEmail: string;
  isUserLoaded: boolean;
}) {
  const router = useRouter();

  const navItems = [
    { label: "Pushup Coach", href: "/pushups" },
    { label: "Crunch Coach", href: "/crunches" },
    { label: "Goal Input", href: "/input" },
    { label: "Focus", href: "/focus" },
    { label: "Summary", href: "/summary" },
  ];

  return (
    <Sidebar className="h-svh border-r">
      <SidebarHeader>
        <button
          type="button"
          onClick={() => router.push("/pushups")}
          className="mb-1 flex items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-muted/40"
        >
          <Image
            src="/logo.svg"
            alt="momentum.ai logo"
            width={20}
            height={20}
            className="size-5 rounded-sm"
            priority
          />
          <span className="text-sm font-semibold tracking-tight">momentum.ai</span>
        </button>
        <SidebarMenu>
          <SidebarMenuItem>
            <div className="flex items-center gap-2 rounded-md bg-background/80 px-2 py-2">
              {isUserLoaded && userEmail ? (
                <UserButton />
              ) : (
                <div className="size-7 shrink-0 rounded-full bg-muted" />
              )}
              <button
                type="button"
                onClick={() => router.push("/")}
                className="min-w-0 text-left"
              >
                <p className="truncate text-sm font-medium">{userName}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {userEmail || "No email"}
                </p>
              </button>
            </div>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    isActive={pathname === item.href}
                    onClick={() => router.push(item.href)}
                    className="cursor-pointer"
                  >
                    {item.label}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarSeparator />
        <SidebarGroup>
          <SidebarGroupLabel>Recent History</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {history.length === 0 ? (
                <SidebarMenuItem>
                  <SidebarMenuButton disabled>No finished sessions yet</SidebarMenuButton>
                </SidebarMenuItem>
              ) : (
                history.slice(0, 10).map((entry) => (
                  <SidebarMenuItem key={entry._id}>
                    <SidebarMenuButton
                      tooltip={entry.goal}
                      className="h-auto min-h-12 py-2"
                      onClick={() => router.push("/summary")}
                    >
                      <div className="flex w-full flex-col">
                        <span className="truncate">{truncateGoal(entry.goal)}</span>
                        <span className="text-xs text-muted-foreground">
                          {formatShortDate(entry.sessionCompletedAt)} · {entry.stepsCompleted} done
                        </span>
                      </div>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={() => router.push("/pushups")}>
              Open pushup coach
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={() => router.push("/crunches")}>
              Open crunch coach
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={() => router.push("/input")}>
              Start new session
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}

function InsightsSidebarBody({
  mode,
  selectedDate,
  onSelectedDateChange,
  selectedDayHistory,
  selectedPushupSessions,
  selectedDaySummary,
  selectedPushupSummary,
  weekly,
  weeklyPushups,
  yesterday,
  streak,
  calendarDays,
}: {
  mode: "copilot" | "pushups" | "crunches";
  selectedDate: Date | undefined;
  onSelectedDateChange: (date: Date | undefined) => void;
  selectedDayHistory: HistoryItem[];
  selectedPushupSessions: PushupSessionItem[];
  selectedDaySummary: DaySummary;
  selectedPushupSummary: PushupStats;
  weekly: { sessions: number; stepsCompleted: number; focusMinutes: number };
  weeklyPushups: PushupStats;
  yesterday: { sessions: number; stepsCompleted: number; focusMinutes: number };
  streak: { current: number; longest: number; lastActiveDayKey: string | null };
  calendarDays: SidebarCalendarDay[];
}) {
  const activeDaySet = useMemo(
    () => new Set(calendarDays.map((day) => day.dayKey)),
    [calendarDays],
  );
  const router = useRouter();
  const isWorkoutMode = mode !== "copilot";
  const workoutHref = mode === "crunches" ? "/crunches" : "/pushups";
  const trendActivityByDay = useMemo(() => {
    const map = new Map<string, number>();
    for (const day of calendarDays) {
      const value = isWorkoutMode
        ? day.totalReps ?? 0
        : day.stepsCompleted ?? day.sessionsCompleted ?? 0;
      map.set(day.dayKey, Math.max(0, Math.floor(value)));
    }
    return map;
  }, [calendarDays, isWorkoutMode]);
  const heatMapActivityByDay = useMemo(() => {
    const map = new Map<string, number>();
    for (const day of calendarDays) {
      const value = isWorkoutMode
        ? day.totalReps ?? day.workouts ?? 0
        : day.sessionsCompleted ?? day.stepsCompleted ?? 0;
      map.set(day.dayKey, Math.max(0, Math.floor(value)));
    }
    return map;
  }, [calendarDays, isWorkoutMode]);

  const trendSeries = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const points: Array<{ dayKey: string; label: string; value: number }> = [];
    for (let offset = 6; offset >= 0; offset -= 1) {
      const day = new Date(today);
      day.setDate(today.getDate() - offset);
      const dayKey = toLocalDayKey(day);
      points.push({
        dayKey,
        label: day.toLocaleDateString(undefined, { weekday: "short" }).slice(0, 1),
        value: trendActivityByDay.get(dayKey) ?? 0,
      });
    }
    return points;
  }, [trendActivityByDay]);

  const trendMax = useMemo(
    () => Math.max(1, ...trendSeries.map((point) => point.value)),
    [trendSeries],
  );

  const heatMapStartDate = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    // Shorter range so cells are readable in the right rail.
    start.setDate(start.getDate() - 120);
    return start;
  }, []);

  const heatMapEndDate = useMemo(() => {
    const end = new Date();
    end.setHours(23, 59, 59, 999);
    return end;
  }, []);

  const heatMapValues = useMemo(
    () =>
      Array.from(heatMapActivityByDay.entries()).map(([dayKey, count]) => ({
        date: toHeatmapDayKey(dayKey),
        count,
      })),
    [heatMapActivityByDay],
  );

  return (
    <>
      <SidebarHeader className="px-2 pb-2 pt-3 sm:px-3 sm:pt-4">
        <p className="px-1 text-xs font-medium sm:px-2 sm:text-sm">Weekly view</p>
      </SidebarHeader>
      <SidebarContent className="max-h-[min(100dvh,100vh)] overflow-y-auto overscroll-contain pb-4">
        <SidebarGroup className="px-0 sm:px-1">
          <SidebarGroupLabel className="px-2">
            {isWorkoutMode ? "Reps trend (7d)" : "Steps trend (7d)"}
          </SidebarGroupLabel>
          <SidebarGroupContent className="min-w-0 w-full max-w-full px-1 pb-2 sm:px-2">
            <div className="w-full min-w-0 max-w-full overflow-hidden rounded-md border border-border/30 bg-muted/15 px-2 py-2">
              <svg viewBox="0 0 230 92" className="h-24 w-full" role="img" aria-label="Last seven days activity chart">
                <line x1="16" y1="8" x2="16" y2="74" stroke="#d4ddd6" strokeWidth="1" />
                <line x1="16" y1="74" x2="224" y2="74" stroke="#d4ddd6" strokeWidth="1" />
                {trendSeries.map((point, index) => {
                  const barHeight = Math.max(2, (point.value / trendMax) * 60);
                  const x = 24 + index * 28;
                  const y = 74 - barHeight;
                  return (
                    <g key={point.dayKey}>
                      <rect
                        x={x}
                        y={y}
                        width={16}
                        height={barHeight}
                        rx={3}
                        className="fill-primary/75"
                      />
                      <text x={x + 8} y={86} textAnchor="middle" className="fill-muted-foreground text-[8px]">
                        {point.label}
                      </text>
                    </g>
                  );
                })}
                <text x="220" y="10" textAnchor="end" className="fill-muted-foreground text-[8px]">
                  max {trendMax}
                </text>
              </svg>
            </div>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup className="px-0 sm:px-1">
          <SidebarGroupLabel className="px-2">Activity heatmap</SidebarGroupLabel>
          <SidebarGroupContent className="min-w-0 w-full max-w-full px-1 pb-2 sm:px-2">
            <div className="w-full min-w-0 max-w-full overflow-hidden rounded-md border border-border/30 bg-background px-1 py-2">
              <ActivityHeatMap
                value={heatMapValues}
                startDate={heatMapStartDate}
                endDate={heatMapEndDate}
                rectSize={10}
                space={2}
                legendCellSize={0}
                weekLabels={["", "", "", "", "", "", ""]}
                panelColors={["#e5e7eb", "#bbf7d0", "#86efac", "#22c55e", "#16a34a"]}
                style={{
                  width: "100%",
                  display: "block",
                  color: "#16a34a",
                  "--rhm-rect": "#e5e7eb",
                } as React.CSSProperties}
              />
            </div>
            <p className="px-1 pt-1 text-[11px] text-muted-foreground">
              Last 6 months intensity
            </p>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup className="px-0 sm:px-1">
          <SidebarGroupLabel className="px-2">Calendar</SidebarGroupLabel>
          <SidebarGroupContent className="min-w-0 w-full max-w-full px-1 pb-2 sm:px-2">
            <div className="w-full min-w-0 max-w-full overflow-hidden rounded-md border border-border/30 bg-muted/15 px-0.5 py-1">
              <Calendar
                mode="single"
                selected={selectedDate}
                onSelect={onSelectedDateChange}
                className="w-full min-w-0 max-w-full bg-transparent p-1 [--cell-size:1.85rem] lg:[--cell-size:2rem]"
                classNames={{
                  nav: "px-0.5",
                  button_previous: "size-7 [&_svg]:size-3.5",
                  button_next: "size-7 [&_svg]:size-3.5",
                  month_caption: "px-6 text-xs sm:text-sm",
                  caption_label: "text-xs font-medium sm:text-sm",
                }}
                modifiers={{
                  active: (day) => activeDaySet.has(toLocalDayKey(day)),
                }}
                modifiersClassNames={{
                  active: "font-semibold text-primary",
                }}
              />
            </div>
            <p className="truncate px-1 pt-2 text-[11px] text-muted-foreground sm:text-xs">
              Selected: {formatSelectedDay(selectedDate)}
            </p>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarSeparator />
        <SidebarGroup className="px-0 sm:px-1">
          <SidebarGroupLabel className="px-2">Selected Day</SidebarGroupLabel>
          <SidebarGroupContent className="grid grid-cols-2 gap-x-2 gap-y-1 px-2 text-[11px] leading-snug sm:px-3 sm:text-xs sm:leading-normal">
            {isWorkoutMode ? (
              <>
                <p className="col-span-2 text-muted-foreground">Workouts</p>
                <p className="col-span-2 font-medium tabular-nums text-foreground">
                  {selectedPushupSummary.workouts}
                </p>
                <p className="text-muted-foreground">Reps</p>
                <p className="text-right tabular-nums">{selectedPushupSummary.totalReps}</p>
                <p className="text-muted-foreground">Cal</p>
                <p className="text-right tabular-nums">{selectedPushupSummary.calories}</p>
                <p className="text-muted-foreground">Time</p>
                <p className="text-right tabular-nums">{selectedPushupSummary.minutes}m</p>
              </>
            ) : (
              <div className="col-span-2 flex flex-col gap-1 text-xs sm:text-sm">
                <p>Sessions: {selectedDaySummary.sessions}</p>
                <p>Steps done: {selectedDaySummary.stepsCompleted}</p>
              </div>
            )}
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarSeparator />
        <SidebarGroup className="px-0 sm:px-1">
          <SidebarGroupLabel className="px-2">Last 7 Days</SidebarGroupLabel>
          <SidebarGroupContent className="grid grid-cols-2 gap-x-2 gap-y-1 px-2 text-[11px] leading-snug sm:px-3 sm:text-xs sm:leading-normal">
            {isWorkoutMode ? (
              <>
                <p className="col-span-2 text-muted-foreground">Workouts</p>
                <p className="col-span-2 font-medium tabular-nums">
                  {weeklyPushups.workouts}
                </p>
                <p className="text-muted-foreground">Reps</p>
                <p className="text-right tabular-nums">{weeklyPushups.totalReps}</p>
                <p className="text-muted-foreground">Cal</p>
                <p className="text-right tabular-nums">{weeklyPushups.calories}</p>
                <p className="text-muted-foreground">Time</p>
                <p className="text-right tabular-nums">{weeklyPushups.minutes}m</p>
              </>
            ) : (
              <div className="col-span-2 flex flex-col gap-1 text-xs sm:text-sm">
                <p>Sessions: {weekly.sessions}</p>
                <p>Steps done: {weekly.stepsCompleted}</p>
                <p>Focus minutes: {weekly.focusMinutes}</p>
              </div>
            )}
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarSeparator />
        <SidebarGroup className="px-0 sm:px-1">
          <SidebarGroupLabel className="px-2">Streaks</SidebarGroupLabel>
          <SidebarGroupContent className="grid grid-cols-2 gap-x-2 gap-y-0.5 px-2 text-[11px] sm:px-3 sm:text-xs">
            <p className="text-muted-foreground">Current</p>
            <p className="text-right tabular-nums">{streak.current}d</p>
            <p className="text-muted-foreground">Longest</p>
            <p className="text-right tabular-nums">{streak.longest}d</p>
            <p className="col-span-2 truncate text-[10px] text-muted-foreground sm:text-[11px]">
              Last: {streak.lastActiveDayKey ?? "—"}
            </p>
          </SidebarGroupContent>
        </SidebarGroup>
        {mode === "copilot" ? (
          <>
            <SidebarSeparator />
            <SidebarGroup className="px-1">
              <SidebarGroupLabel>Yesterday</SidebarGroupLabel>
              <SidebarGroupContent className="space-y-1 px-4 text-sm">
                <p>Sessions: {yesterday.sessions}</p>
                <p>Steps done: {yesterday.stepsCompleted}</p>
                <p>Focus minutes: {yesterday.focusMinutes}</p>
              </SidebarGroupContent>
            </SidebarGroup>
            <SidebarSeparator />
          </>
        ) : (
          <SidebarSeparator />
        )}
        <SidebarGroup className="px-1">
          <SidebarGroupLabel className="px-2">
            {isWorkoutMode ? (
              <span className="flex flex-col gap-0.5 normal-case">
                <span>Workouts</span>
                <span className="text-[11px] font-normal text-muted-foreground">
                  {formatSelectedDay(selectedDate)}
                  {selectedPushupSessions.length > 0
                    ? ` · ${selectedPushupSessions.length} session${
                        selectedPushupSessions.length === 1 ? "" : "s"
                      }`
                    : ""}
                </span>
              </span>
            ) : (
              `Selected Day History (${selectedDayHistory.length})`
            )}
          </SidebarGroupLabel>
          <SidebarGroupContent className="px-2">
            <SidebarMenu
              className={
                isWorkoutMode
                  ? "max-h-[min(12rem,36vh)] gap-0.5 overflow-y-auto overscroll-contain"
                  : undefined
              }
            >
              {(isWorkoutMode
                ? selectedPushupSessions.length === 0
                : selectedDayHistory.length === 0) ? (
                <SidebarMenuItem>
                  <SidebarMenuButton disabled>
                    {isWorkoutMode
                      ? "No reps logged this day"
                      : "No entries on selected day"}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ) : (
                isWorkoutMode ? (
                  selectedPushupSessions.map((entry) => (
                    <SidebarMenuItem key={entry._id}>
                      <SidebarMenuButton
                        onClick={() => router.push(workoutHref)}
                        className="h-auto min-h-0 px-2.5 py-1.5 text-left"
                      >
                        <div className="flex w-full flex-col gap-0.5">
                          <span className="text-xs leading-snug">
                            <span className="font-medium tabular-nums text-foreground">
                              {entry.maxReps}
                            </span>{" "}
                            reps
                            <span className="text-muted-foreground">
                              {" "}
                              · {entry.roomId}
                            </span>
                          </span>
                          <span className="text-[11px] text-muted-foreground">
                            {formatShortTime(entry.endedAt ?? entry.startedAt)}
                            {entry.caloriesEstimate > 0 ? (
                              <> · {entry.caloriesEstimate} kcal</>
                            ) : null}
                          </span>
                        </div>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))
                ) : (
                  selectedDayHistory.map((entry) => (
                    <SidebarMenuItem key={entry._id}>
                      <SidebarMenuButton
                        onClick={() => router.push("/summary")}
                        className="h-auto min-h-12 px-3 py-2"
                      >
                        <div className="flex w-full flex-col gap-0.5">
                          <span className="truncate">{truncateGoal(entry.goal)}</span>
                          <span className="text-xs text-muted-foreground">
                            {formatShortTime(entry.sessionCompletedAt)} · {entry.stepsCompleted} done
                          </span>
                        </div>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))
                )
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </>
  );
}

function AppSidebarRight(
  props: React.ComponentProps<typeof InsightsSidebarBody> & {
    mobileOpen: boolean;
    onMobileOpenChange: (open: boolean) => void;
  },
) {
  const { mobileOpen, onMobileOpenChange, ...insightsProps } = props;

  return (
    <>
      <Sidebar
        side="right"
        collapsible="none"
        className="hidden h-svh w-[min(17rem,calc(100vw-1rem))] max-w-[min(17rem,92vw)] min-w-0 shrink-0 overflow-x-hidden border-l lg:flex"
      >
        <InsightsSidebarBody {...insightsProps} />
      </Sidebar>

      <Sheet open={mobileOpen} onOpenChange={onMobileOpenChange}>
        <SheetContent
          side="right"
          showCloseButton
          className="flex h-[100dvh] max-h-[100dvh] w-full max-w-[min(100vw,17rem)] flex-col gap-0 overflow-y-auto border-l border-sidebar-border bg-sidebar p-0 text-sidebar-foreground sm:max-h-none sm:max-w-[17rem]"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>Insights and calendar</SheetTitle>
            <SheetDescription>
              Weekly stats, calendar, and day history.
            </SheetDescription>
          </SheetHeader>
          <div className="flex min-h-0 flex-1 flex-col">
            <InsightsSidebarBody {...insightsProps} />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

export function CopilotAppShell({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const { isLoaded, userId } = useAuth();
  const { user, isLoaded: isUserLoaded } = useUser();
  const pathname = usePathname();
  const isPushupsMode = pathname.startsWith("/pushups");
  const isCrunchesMode = pathname.startsWith("/crunches");
  const isWorkoutMode = isPushupsMode || isCrunchesMode;
  const [insightsSheetOpen, setInsightsSheetOpen] = useState(false);
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(new Date());
  const [pushupInsights, setPushupInsights] = useState<{
    selectedDaySessions: PushupSessionItem[];
    selectedDayStats: PushupStats;
    weeklyStats: PushupStats;
    calendarDays: Array<{ dayKey: string }>;
    streak: { current: number; longest: number; lastActiveDayKey: string | null };
  } | null>(null);

  const insights = useQuery(
    api.sessions.getDashboardInsights,
    isLoaded && userId && !isWorkoutMode
      ? { selectedDayTs: (selectedDate ?? new Date()).getTime() }
      : "skip",
  );

  useEffect(() => {
    let cancelled = false;
    async function loadPushupInsights() {
      if (!isLoaded || !userId || !isWorkoutMode) {
        return;
      }
      try {
        const selectedDayTs = (selectedDate ?? new Date()).getTime();
        const selectedDayKey = toLocalDayKey(selectedDate ?? new Date());
        const currentDayKey = toLocalDayKey(new Date());
        const endpoint = isCrunchesMode
          ? `/api/crunches/calendar?selectedDayTs=${selectedDayTs}&selectedDayKey=${encodeURIComponent(selectedDayKey)}&currentDayKey=${encodeURIComponent(currentDayKey)}`
          : `/api/pushups/calendar?selectedDayTs=${selectedDayTs}&selectedDayKey=${encodeURIComponent(selectedDayKey)}&currentDayKey=${encodeURIComponent(currentDayKey)}`;
        const response = await fetch(endpoint, { cache: "no-store" });
        if (!response.ok || cancelled) return;
        const payload = (await response.json()) as {
          selectedDaySessions: PushupSessionItem[];
          selectedDayStats: PushupStats;
          weeklyStats: PushupStats;
          calendarDays: Array<{ dayKey: string }>;
          streak: { current: number; longest: number; lastActiveDayKey: string | null };
        };
        if (!cancelled) {
          setPushupInsights(payload);
        }
      } catch {
        if (!cancelled) {
          setPushupInsights(null);
        }
      }
    }
    void loadPushupInsights();
    return () => {
      cancelled = true;
    };
  }, [isCrunchesMode, isLoaded, isWorkoutMode, selectedDate, userId]);

  const history = useMemo(
    () => (insights?.recentHistory ?? []) as HistoryItem[],
    [insights?.recentHistory],
  );
  const selectedDayHistory = useMemo(() => {
    if (!selectedDate) return [];
    if (isWorkoutMode) return [];
    const selectedStart = startOfDay(selectedDate.getTime());
    const selectedEnd = selectedStart + 24 * 60 * 60 * 1000;
    return history.filter(
      (entry) =>
        entry.sessionCompletedAt >= selectedStart &&
        entry.sessionCompletedAt < selectedEnd,
    );
  }, [history, isWorkoutMode, selectedDate]);

  const selectedDaySummary = useMemo(
    () =>
      selectedDayHistory.reduce(
        (acc, entry) => ({
          sessions: acc.sessions + 1,
          stepsCompleted: acc.stepsCompleted + entry.stepsCompleted,
        }),
        { sessions: 0, stepsCompleted: 0 },
      ),
    [selectedDayHistory],
  );

  const selectedPushupSessions = useMemo(() => {
    return finalizeSelectedDaySessions(
      pushupInsights?.selectedDaySessions ?? [],
    );
  }, [pushupInsights?.selectedDaySessions]);

  const selectedPushupSummary = useMemo((): PushupStats => {
    if (!isWorkoutMode) {
      return {
        workouts: 0,
        totalReps: 0,
        calories: 0,
        minutes: 0,
      };
    }
    return reducePushupDayStats(selectedPushupSessions);
  }, [isWorkoutMode, selectedPushupSessions]);

  const weeklyPushups = pushupInsights?.weeklyStats ?? {
    workouts: 0,
    totalReps: 0,
    calories: 0,
    minutes: 0,
  };

  const weekly = insights?.weekly ?? { sessions: 0, stepsCompleted: 0, focusMinutes: 0 };
  const yesterday = insights?.yesterday ?? {
    sessions: 0,
    stepsCompleted: 0,
    focusMinutes: 0,
  };
  const streak = isWorkoutMode
    ? pushupInsights?.streak ?? {
        current: 0,
        longest: 0,
        lastActiveDayKey: null,
      }
    : insights?.streak ?? {
        current: 0,
        longest: 0,
        lastActiveDayKey: null,
      };
  const calendarDays = isWorkoutMode
    ? pushupInsights?.calendarDays ?? []
    : insights?.calendarDays ?? [];
  const userName = user?.fullName ?? user?.username ?? "Signed in";
  const userEmail =
    user?.primaryEmailAddress?.emailAddress ??
    user?.emailAddresses?.[0]?.emailAddress ??
    "";

  return (
    <SidebarProvider className="min-h-svh max-w-[100vw] overflow-x-hidden bg-muted/25">
      <AppSidebarLeft
        pathname={pathname}
        history={history}
        userName={userName}
        userEmail={userEmail}
        isUserLoaded={isUserLoaded}
      />
      <SidebarInset>
        <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background px-2 sm:px-3">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <SidebarTrigger />
            <h1 className="line-clamp-1 text-sm font-medium">{title}</h1>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0 lg:hidden"
            onClick={() => setInsightsSheetOpen(true)}
          >
            Insights
          </Button>
        </header>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden">
          {children}
        </div>
      </SidebarInset>
      <AppSidebarRight
        mode={isPushupsMode ? "pushups" : isCrunchesMode ? "crunches" : "copilot"}
        mobileOpen={insightsSheetOpen}
        onMobileOpenChange={setInsightsSheetOpen}
        selectedDate={selectedDate}
        onSelectedDateChange={setSelectedDate}
        selectedDayHistory={selectedDayHistory}
        selectedPushupSessions={selectedPushupSessions}
        selectedDaySummary={selectedDaySummary}
        selectedPushupSummary={selectedPushupSummary}
        weekly={weekly}
        weeklyPushups={weeklyPushups}
        yesterday={yesterday}
        streak={streak}
        calendarDays={calendarDays}
      />
    </SidebarProvider>
  );
}
