"use client";

import { useMemo, useState } from "react";
import { UserButton, useAuth, useUser } from "@clerk/nextjs";
import { useQuery } from "convex/react";
import { usePathname, useRouter } from "next/navigation";

import { api } from "@/lib/convex-api";
import { Calendar } from "@/components/ui/calendar";
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
    { label: "Goal Input", href: "/input" },
    { label: "Focus", href: "/focus" },
    { label: "Summary", href: "/summary" },
  ];

  return (
    <Sidebar className="h-svh border-r">
      <SidebarHeader>
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
            <SidebarMenuButton onClick={() => router.push("/input")}>
              Start new session
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}

function AppSidebarRight({
  selectedDate,
  onSelectedDateChange,
  selectedDayHistory,
  selectedDaySummary,
  weekly,
  yesterday,
  streak,
  calendarDays,
}: {
  selectedDate: Date | undefined;
  onSelectedDateChange: (date: Date | undefined) => void;
  selectedDayHistory: HistoryItem[];
  selectedDaySummary: DaySummary;
  weekly: { sessions: number; stepsCompleted: number; focusMinutes: number };
  yesterday: { sessions: number; stepsCompleted: number; focusMinutes: number };
  streak: { current: number; longest: number; lastActiveDayKey: string | null };
  calendarDays: Array<{ dayKey: string }>;
}) {
  const activeDaySet = useMemo(
    () => new Set(calendarDays.map((day) => day.dayKey)),
    [calendarDays],
  );
  const router = useRouter();

  return (
    <Sidebar
      side="right"
      collapsible="none"
      className="hidden w-96 border-l xl:flex"
    >
      <SidebarHeader className="px-3 pt-4 pb-2">
        <p className="px-2 text-sm font-medium">Weekly view</p>
      </SidebarHeader>
      <SidebarContent className="pb-4">
        <SidebarGroup className="px-1">
          <SidebarGroupLabel>Calendar</SidebarGroupLabel>
          <SidebarGroupContent className="px-2 pb-2">
            <Calendar
              mode="single"
              selected={selectedDate}
              onSelect={onSelectedDateChange}
              className="mx-auto [--cell-size:2.3rem]"
              modifiers={{
                active: (day) => activeDaySet.has(day.toISOString().slice(0, 10)),
              }}
              modifiersClassNames={{
                active: "font-semibold text-primary",
              }}
            />
            <p className="px-2 pt-2 text-xs text-muted-foreground">
              Selected: {formatSelectedDay(selectedDate)}
            </p>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarSeparator />
        <SidebarGroup className="px-1">
          <SidebarGroupLabel>Selected Day</SidebarGroupLabel>
          <SidebarGroupContent className="space-y-1 px-4 text-sm">
            <p>Sessions: {selectedDaySummary.sessions}</p>
            <p>Steps done: {selectedDaySummary.stepsCompleted}</p>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarSeparator />
        <SidebarGroup className="px-1">
          <SidebarGroupLabel>Last 7 Days</SidebarGroupLabel>
          <SidebarGroupContent className="space-y-1 px-4 text-sm">
            <p>Sessions: {weekly.sessions}</p>
            <p>Steps done: {weekly.stepsCompleted}</p>
            <p>Focus minutes: {weekly.focusMinutes}</p>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarSeparator />
        <SidebarGroup className="px-1">
          <SidebarGroupLabel>Streaks</SidebarGroupLabel>
          <SidebarGroupContent className="space-y-1 px-4 text-sm">
            <p>Current: {streak.current} days</p>
            <p>Longest: {streak.longest} days</p>
            <p>Last active: {streak.lastActiveDayKey ?? "none"}</p>
          </SidebarGroupContent>
        </SidebarGroup>
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
        <SidebarGroup className="px-1">
          <SidebarGroupLabel>
            Selected Day History ({selectedDayHistory.length})
          </SidebarGroupLabel>
          <SidebarGroupContent className="px-2">
            <SidebarMenu>
              {selectedDayHistory.length === 0 ? (
                <SidebarMenuItem>
                  <SidebarMenuButton disabled>
                    No entries on selected day
                  </SidebarMenuButton>
                </SidebarMenuItem>
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
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
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
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(new Date());

  const insights = useQuery(
    api.sessions.getDashboardInsights,
    isLoaded && userId
      ? { selectedDayTs: (selectedDate ?? new Date()).getTime() }
      : "skip",
  );

  const history = useMemo(
    () => (insights?.recentHistory ?? []) as HistoryItem[],
    [insights?.recentHistory],
  );
  const selectedDayHistory = useMemo(() => {
    if (!selectedDate) return [];
    const selectedStart = startOfDay(selectedDate.getTime());
    const selectedEnd = selectedStart + 24 * 60 * 60 * 1000;
    return history.filter(
      (entry) =>
        entry.sessionCompletedAt >= selectedStart &&
        entry.sessionCompletedAt < selectedEnd,
    );
  }, [history, selectedDate]);

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

  const weekly = insights?.weekly ?? { sessions: 0, stepsCompleted: 0, focusMinutes: 0 };
  const yesterday = insights?.yesterday ?? {
    sessions: 0,
    stepsCompleted: 0,
    focusMinutes: 0,
  };
  const streak = insights?.streak ?? {
    current: 0,
    longest: 0,
    lastActiveDayKey: null,
  };
  const calendarDays = insights?.calendarDays ?? [];
  const userName = user?.fullName ?? user?.username ?? "Signed in";
  const userEmail =
    user?.primaryEmailAddress?.emailAddress ??
    user?.emailAddresses?.[0]?.emailAddress ??
    "";

  return (
    <SidebarProvider className="min-h-svh bg-muted/25">
      <AppSidebarLeft
        pathname={pathname}
        history={history}
        userName={userName}
        userEmail={userEmail}
        isUserLoaded={isUserLoaded}
      />
      <SidebarInset>
        <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background">
          <div className="flex flex-1 items-center gap-2 px-3">
            <SidebarTrigger />
            <h1 className="line-clamp-1 text-sm font-medium">{title}</h1>
          </div>
        </header>
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </SidebarInset>
      <AppSidebarRight
        selectedDate={selectedDate}
        onSelectedDateChange={setSelectedDate}
        selectedDayHistory={selectedDayHistory}
        selectedDaySummary={selectedDaySummary}
        weekly={weekly}
        yesterday={yesterday}
        streak={streak}
        calendarDays={calendarDays}
      />
    </SidebarProvider>
  );
}
