import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";

import {
  finalizeSelectedDaySessions,
  reducePushupDayStats,
} from "@/lib/pushup-calendar";
import { queryConvex } from "@/lib/convex-server";

type CalendarResponse = {
  selectedDaySessions: Array<{
    _id: string;
    roomId: string;
    username: string;
    startedAt: number;
    endedAt: number | null;
    maxReps: number;
    caloriesEstimate: number;
  }>;
  selectedDayStats: {
    workouts: number;
    totalReps: number;
    calories: number;
    minutes: number;
  };
  weeklyStats: {
    workouts: number;
    totalReps: number;
    calories: number;
    minutes: number;
  };
  calendarDays: Array<{
    dayKey: string;
    workouts: number;
    totalReps: number;
    calories: number;
  }>;
  streak: {
    current: number;
    longest: number;
    lastActiveDayKey: string | null;
  };
};

export async function GET(request: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const selectedDayTsRaw = Number(url.searchParams.get("selectedDayTs") ?? `${Date.now()}`);
  const selectedDayTs = Number.isFinite(selectedDayTsRaw)
    ? selectedDayTsRaw
    : Date.now();
  const selectedDayKeyRaw = url.searchParams.get("selectedDayKey");
  const currentDayKeyRaw = url.searchParams.get("currentDayKey");
  const selectedDayKey =
    selectedDayKeyRaw && /^\d{4}-\d{2}-\d{2}$/.test(selectedDayKeyRaw)
      ? selectedDayKeyRaw
      : null;
  const currentDayKey =
    currentDayKeyRaw && /^\d{4}-\d{2}-\d{2}$/.test(currentDayKeyRaw)
      ? currentDayKeyRaw
      : null;

  try {
    const insights = await queryConvex<CalendarResponse>(
      "pushupRooms:getCalendarInsights",
      {
        userId,
        selectedDayTs,
        selectedDayKey,
        currentDayKey,
      },
    );

    const selectedDaySessions = finalizeSelectedDaySessions(
      insights.selectedDaySessions,
    );
    const selectedDayStats = reducePushupDayStats(selectedDaySessions);

    return NextResponse.json({
      ...insights,
      selectedDaySessions,
      selectedDayStats,
    });
  } catch {
    return NextResponse.json(
      {
        selectedDaySessions: [],
        selectedDayStats: { workouts: 0, totalReps: 0, calories: 0, minutes: 0 },
        weeklyStats: { workouts: 0, totalReps: 0, calories: 0, minutes: 0 },
        calendarDays: [],
        streak: { current: 0, longest: 0, lastActiveDayKey: null },
      },
      { status: 200 },
    );
  }
}
